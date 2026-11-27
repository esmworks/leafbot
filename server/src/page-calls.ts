import { readFile } from 'node:fs/promises';
import { RowValues, type BotLevel, type BotTable, type TableRow } from '@leafbot/shared';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { schema } from './db';
import { declaredConnectors } from './page-kit';
import type { Services } from './services';
import { atLeast } from './services/access';
import { resultText } from './services/connections';
import { HttpError } from './util';

/*
 * What a bot's page asks of the server through `window.leafbot`, as the person viewing it: its
 * own saved data, the bot's tables, and the person's connected apps. The route has already checked
 * that the person may open the page; each call here checks what it touches. A page can never do
 * more than its bot could in the person's conversation, and what changes the world outside needs
 * the person's yes in the app first.
 */

/** A page keeps at most this many keys, and this much data in all. */
const MAX_KEYS = 500;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const MAX_VALUE_BYTES = 256 * 1024;
/** Arguments a page sends a connected app, at most. */
const MAX_ARGS_BYTES = 64 * 1024;
/** Calls to connected apps per person per minute, across their pages. */
const CONNECTOR_CALLS_PER_MINUTE = 30;

export const PageCall = z.object({
  path: z.string().min(1).max(2000),
  method: z.string().max(40),
  params: z.record(z.string(), z.unknown()).default({}),
  /** The person said yes in the app to this call, which changes something. */
  confirmed: z.boolean().optional(),
});
export type PageCall = z.infer<typeof PageCall>;

const Key = z.string().min(1).max(200);

export interface PageRef {
  botId: string;
  path: string;
  /** The page file on disk, for what it declares. */
  full: string;
}

/** What the page gets back from a connected app: its text, its structured answer, whether it failed. */
function answer(result: CallToolResult) {
  return {
    isError: !!result.isError,
    text: resultText(result),
    ...(result.structuredContent ? { data: result.structuredContent } : {}),
  };
}

const recent = new Map<string, number[]>();
function rateLimit(userId: string) {
  const now = Date.now();
  const kept = (recent.get(userId) ?? []).filter((at) => now - at < 60_000);
  if (kept.length >= CONNECTOR_CALLS_PER_MINUTE) throw new HttpError(429, 'error.pageCallRate');
  kept.push(now);
  recent.set(userId, kept);
}

export function pageCalls(s: Services, log: (line: string) => void = () => {}) {
  const db = s.ctx.db;
  const own = (userId: string, page: PageRef) =>
    and(
      eq(schema.pageState.userId, userId),
      eq(schema.pageState.botId, page.botId),
      eq(schema.pageState.path, page.path),
    );

  /** The tables the page's bot reaches: its own, then those it was let into. */
  async function tables(botId: string): Promise<(BotTable & { owner: string | null; write: boolean })[]> {
    const mine = (await s.tables.list(botId)).map((x) => ({ ...x, owner: null, write: true }));
    return [...mine, ...(await s.tables.sharedWith(botId))];
  }
  async function table(botId: string, name: unknown) {
    const want = Key.parse(name).trim().toLocaleLowerCase('tr');
    const all = await tables(botId);
    const hits = all.filter(
      (x) =>
        x.name.toLocaleLowerCase('tr') === want ||
        (x.owner && `${x.owner} / ${x.name}`.toLocaleLowerCase('tr') === want),
    );
    if (hits.length !== 1) throw new HttpError(404, 'error.notFound');
    return hits[0]!;
  }
  const rowOut = (r: TableRow) => ({ id: r.id, ...r.values });

  return async function call(
    who: { userId: string; level: BotLevel },
    page: PageRef,
    body: Omit<PageCall, 'path'>,
  ): Promise<unknown> {
    const p = body.params;
    switch (body.method) {
      case 'state.get': {
        const key = Key.parse(p.key);
        const [row] = await db
          .select({ value: schema.pageState.value })
          .from(schema.pageState)
          .where(and(own(who.userId, page), eq(schema.pageState.key, key)))
          .limit(1);
        return row ? row.value : null;
      }
      case 'state.keys': {
        const rows = await db
          .select({ key: schema.pageState.key })
          .from(schema.pageState)
          .where(own(who.userId, page));
        return rows.map((r) => r.key).sort();
      }
      case 'state.set': {
        const key = Key.parse(p.key);
        if (p.value === undefined || p.value === null) {
          await db.delete(schema.pageState).where(and(own(who.userId, page), eq(schema.pageState.key, key)));
          return null;
        }
        const text = JSON.stringify(p.value);
        const size = Buffer.byteLength(text);
        if (size > MAX_VALUE_BYTES) throw new HttpError(413, 'error.pageStateFull');
        const [used] = await db
          .select({
            keys: sql<number>`count(*)::int`,
            bytes: sql<number>`coalesce(sum(${schema.pageState.size}), 0)::int`,
            mine: sql<number>`coalesce(sum(case when ${schema.pageState.key} = ${key} then ${schema.pageState.size} else 0 end), 0)::int`,
            has: sql<number>`count(*) filter (where ${schema.pageState.key} = ${key})::int`,
          })
          .from(schema.pageState)
          .where(own(who.userId, page));
        const keys = (used?.keys ?? 0) + (used?.has ? 0 : 1);
        const bytes = (used?.bytes ?? 0) - (used?.mine ?? 0) + size;
        if (keys > MAX_KEYS || bytes > MAX_STATE_BYTES) throw new HttpError(413, 'error.pageStateFull');
        const values = { userId: who.userId, botId: page.botId, path: page.path, key, value: p.value, size };
        await db
          .insert(schema.pageState)
          .values(values)
          .onConflictDoUpdate({
            target: [
              schema.pageState.userId,
              schema.pageState.botId,
              schema.pageState.path,
              schema.pageState.key,
            ],
            set: { value: p.value, size, updatedAt: new Date() },
          });
        return null;
      }

      case 'data.tables':
        return (await tables(page.botId)).map((x) => ({
          name: x.owner ? `${x.owner} / ${x.name}` : x.name,
          columns: x.columns.map((c) => ({ name: c.name, type: c.type })),
          rows: x.rowCount,
          write: x.write && atLeast(who.level, 'edit'),
        }));
      case 'data.rows': {
        const x = await table(page.botId, p.table);
        return (await s.tables.rows(x.id)).map(rowOut);
      }
      case 'data.add':
      case 'data.update':
      case 'data.remove': {
        const x = await table(page.botId, p.table);
        // As in the bot's panel: changing a table's rows takes the right to change the bot.
        if (!x.write || !atLeast(who.level, 'edit')) throw new HttpError(403, 'error.pageTableWrite');
        if (body.method === 'data.add') {
          const rows = z.array(RowValues).min(1).max(100).parse(p.rows);
          return (await s.tables.addRows(x.id, rows, who.userId)).map(rowOut);
        }
        if (body.method === 'data.update') {
          const id = Key.parse(p.id);
          return rowOut(await s.tables.updateRow(x.id, id, RowValues.parse(p.values), who.userId));
        }
        const ids = z.array(Key).min(1).max(200).parse(p.ids);
        return { removed: await s.tables.deleteRows(x.id, ids) };
      }

      case 'connectors.list': {
        const names = declaredConnectors(await readFile(page.full, 'utf8'));
        return Promise.all(names.map((n) => s.connections.describePageTool(page.botId, n, who.userId)));
      }
      case 'connectors.call': {
        const tool = Key.parse(p.tool);
        // Only what the page said it uses, which the person can see before saying yes.
        if (!declaredConnectors(await readFile(page.full, 'utf8')).includes(tool)) {
          throw new HttpError(403, 'error.pageToolUndeclared', { tool });
        }
        const args = z.record(z.string(), z.unknown()).parse(p.args ?? {});
        if (Buffer.byteLength(JSON.stringify(args)) > MAX_ARGS_BYTES)
          throw new HttpError(413, 'error.pageStateFull');
        rateLimit(who.userId);
        const started = Date.now();
        try {
          const result = await s.connections.callForPage({
            botId: page.botId,
            exposed: tool,
            userId: who.userId,
            args,
            confirmed: body.confirmed === true,
          });
          log(
            `page connector call: bot ${page.botId} tool ${tool} ${result.isError ? 'failed' : 'ok'} in ${Date.now() - started} ms`,
          );
          return answer(result);
        } catch (err) {
          log(`page connector call: bot ${page.botId} tool ${tool} refused (${(err as Error).message})`);
          throw err;
        }
      }
      default:
        throw new HttpError(400, 'error.pageMethod');
    }
  };
}
