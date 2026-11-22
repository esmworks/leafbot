import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, basename } from 'node:path';
import type { TurnChangeItem, TurnChanges, TurnChangeOutcome, TurnChangeKind } from '@leafbot/shared';
import { and, asc, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import { HttpError, newId, notFound, truncate } from '../util';
import { realPath } from '../workspace';
import { atLeast } from './access';
import type { Services } from '.';

/** How long what a turn changed is kept for taking it back. */
export const CHANGE_KEEP_DAYS = 30;
/** The largest file whose earlier content is kept, and the most one turn keeps in all. */
export const FILE_KEEP_MAX = 2 * 1024 * 1024;
export const TURN_KEEP_MAX = 20 * 1024 * 1024;
/** A file larger than this is not read to tell whether it changed later. */
const HASH_MAX = 64 * 1024 * 1024;

/** The built-in tools that write a file, as the permission steps name them. */
export const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/**
 * Steps that are not listed as outside the bot's own world: the ones taken back by this journal,
 * and reads that only look. Every other step in the step log of a turn reached outside (or ran a
 * program), so it cannot be taken back.
 */
const NOT_OUTSIDE = new Set([
  ...FILE_TOOLS,
  'routine_create',
  'routine_update',
  'routine_delete',
  'skill_save',
  'WebFetch',
  'WebSearch',
  'browser_snapshot',
  'browser_screenshot',
  'browser_scroll',
  'browser_wait',
  'browser_network',
  'browser_console',
  'browser_tabs',
  'browser_history',
  'browser_hover',
]);

/** The step as people name it, without the prefix of the bot's own tools. */
const stepName = (tool: string) => tool.replace(/^mcp__leafbot__/, '');

type Row = typeof schema.turnChanges.$inferSelect;
type Json = Record<string, unknown>;

/** Whose turn it was and where, for every line the turn writes. */
export interface TurnScope {
  turnId: string;
  threadId: string;
  botId: string;
  userId: string;
}

/** One change, as a tool or the file watch reports it once it went through. */
export interface ChangeNote {
  kind: TurnChangeKind;
  op: 'create' | 'update' | 'delete';
  targetId: string;
  label: string;
  /** The bot the target belongs to, when it is another than the turn's. */
  scopeBotId?: string | null;
  before?: Json | null;
  after?: Json | null;
  /** The earlier state could not be kept. */
  reason?: 'tooBig' | 'deleted';
}

const sha = (v: string | Buffer) => createHash('sha1').update(v).digest('hex');
/** A stable fingerprint of the fields of something that people may change. */
export const sig = (v: unknown) => sha(JSON.stringify(v));
const size = (v: unknown) => (v == null ? 0 : Buffer.byteLength(JSON.stringify(v)));

function inside(p: string, root: string) {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/** A file's content as kept: text when it reads back the same, else base64. */
function keep(buf: Buffer): Json {
  const text = buf.toString('utf8');
  return Buffer.from(text, 'utf8').equals(buf)
    ? { exists: true, text }
    : { exists: true, base64: buf.toString('base64') };
}
const unkeep = (b: Json) =>
  typeof b.text === 'string' ? Buffer.from(b.text, 'utf8') : Buffer.from(String(b.base64), 'base64');

/** What a file looked like when a step was about to change it. */
interface Snap {
  exists: boolean;
  size: number;
  mtimeMs: number;
  /** The content, unless it was too large to keep. */
  content: Buffer | null;
  big: boolean;
}

/**
 * The files a turn changes through its file tools. A file is looked at just before the first step
 * that may change it (every step of both engines passes `before`), and again when the turn ends:
 * only a file that really differs then is written to the journal, so a step that was refused or
 * failed leaves nothing behind.
 */
export class FileWatch {
  private snaps = new Map<string, Promise<Snap | null>>();
  private kept: number;

  constructor(
    private journal: TurnChangeService,
    private scope: TurnScope,
    private cwd: string,
    private roots: string[],
    kept: number,
  ) {
    this.kept = kept;
    this.roots = roots.map((r) => realPath(r));
  }

  /** Called before any step; looks at the file when the step is a file tool. */
  async before(toolName: string, input: Record<string, unknown>) {
    if (!FILE_TOOLS.has(toolName)) return;
    const raw = input.file_path ?? input.notebook_path ?? input.path;
    if (typeof raw !== 'string' || !raw.trim()) return;
    const abs = realPath(resolve(this.cwd, raw));
    if (!this.roots.some((r) => inside(abs, r))) return;
    if (!this.snaps.has(abs)) this.snaps.set(abs, this.look(abs));
    await this.snaps.get(abs);
  }

  private async look(abs: string): Promise<Snap | null> {
    try {
      const info = await lstat(abs).catch(() => null);
      if (!info) return { exists: false, size: 0, mtimeMs: 0, content: null, big: false };
      // A link or a folder is not a file this journal puts back.
      if (!info.isFile()) return null;
      const big = info.size > FILE_KEEP_MAX || this.kept + info.size > TURN_KEEP_MAX;
      if (!big) this.kept += info.size;
      return {
        exists: true,
        size: info.size,
        mtimeMs: info.mtimeMs,
        content: big ? null : await readFile(abs),
        big,
      };
    } catch {
      return null;
    }
  }

  /** Writes a line for every file that differs from how it was. */
  async finish() {
    for (const [abs, pending] of this.snaps) {
      const snap = await pending;
      if (!snap) continue;
      const now = await lstat(abs).catch(() => null);
      if (now && !now.isFile()) continue;
      let after: string | null = null;
      if (now) {
        if (snap.exists && !snap.big && snap.content && now.size === snap.size) {
          const current = await readFile(abs);
          if (current.equals(snap.content)) continue;
          after = sha(current);
        } else if (snap.exists && snap.big && now.size === snap.size && now.mtimeMs === snap.mtimeMs) {
          continue;
        } else if (now.size <= HASH_MAX) {
          after = sha(await readFile(abs));
        }
      } else if (!snap.exists) {
        continue;
      }
      await this.journal.record(this.scope, {
        kind: 'file',
        op: !snap.exists ? 'create' : now ? 'update' : 'delete',
        targetId: abs,
        label: basename(abs),
        before: snap.exists && snap.content ? keep(snap.content) : snap.exists ? null : { exists: false },
        // Null when the file is gone or too large to fingerprint: nothing then confirms it is as left.
        after: { sha: after },
        reason: snap.big ? 'tooBig' : undefined,
      });
    }
  }
}

/**
 * What each turn changed in the bot's own world, kept for 30 days with the state before, so the
 * person whose turn it was can take it back. A change is written once it went through; undoing
 * puts things back newest first and leaves, and says so, whatever changed again since.
 */
export class TurnChangeService {
  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  /** Bytes the turn has kept so far. */
  async keptBytes(turnId: string): Promise<number> {
    const [row] = await this.ctx.db
      .select({ n: sql<number>`coalesce(sum(${schema.turnChanges.bytes}), 0)`.mapWith(Number) })
      .from(schema.turnChanges)
      .where(eq(schema.turnChanges.turnId, turnId));
    return row?.n ?? 0;
  }

  /** Looks at the files a turn changes; see {@link FileWatch}. */
  async watch(scope: TurnScope, cwd: string, roots: string[]): Promise<FileWatch> {
    return new FileWatch(this, scope, cwd, roots, await this.keptBytes(scope.turnId));
  }

  /** Writes one change. What is too large to keep is listed as one that cannot be put back. */
  async record(scope: TurnScope, c: ChangeNote): Promise<void> {
    let before = c.before ?? null;
    let reason = c.reason ?? null;
    let bytes = size(before);
    if (
      !reason &&
      bytes > 0 &&
      (bytes > FILE_KEEP_MAX || (await this.keptBytes(scope.turnId)) + bytes > TURN_KEEP_MAX)
    ) {
      reason = 'tooBig';
    }
    if (reason) {
      before = null;
      bytes = 0;
    }
    await this.ctx.db.insert(schema.turnChanges).values({
      id: newId(),
      ...scope,
      kind: c.kind,
      op: c.op,
      targetId: c.targetId,
      label: truncate(c.label, 200),
      scopeBotId: c.scopeBotId ?? null,
      before,
      after: c.after ?? null,
      bytes,
      reason,
    });
    this.ctx.bus.refresh({ scope: 'thread', threadId: scope.threadId, botId: scope.botId });
  }

  /** The turns of a conversation with something still to put back, with how many changes each has. */
  async pending(threadId: string, userId: string): Promise<Record<string, number>> {
    const rows = await this.ctx.db
      .select({ turnId: schema.turnChanges.turnId, n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.turnChanges)
      .where(
        and(
          eq(schema.turnChanges.threadId, threadId),
          eq(schema.turnChanges.userId, userId),
          isNull(schema.turnChanges.undoneAt),
        ),
      )
      .groupBy(schema.turnChanges.turnId);
    return Object.fromEntries(rows.map((r) => [r.turnId, r.n]));
  }

  private async turn(turnId: string) {
    const [turn] = await this.ctx.db.select().from(schema.turns).where(eq(schema.turns.id, turnId)).limit(1);
    if (!turn) throw notFound('turn');
    return turn;
  }

  /** The lines of a turn, newest first; refuses anyone but the person whose turn it was. */
  private async lines(turnId: string, userId: string) {
    const turn = await this.turn(turnId);
    const rows = await this.ctx.db
      .select()
      .from(schema.turnChanges)
      .where(eq(schema.turnChanges.turnId, turnId))
      .orderBy(desc(schema.turnChanges.createdAt), desc(schema.turnChanges.id));
    // Taken back only by the person it was done for, admins included.
    if ((rows[0]?.userId ?? turn.userId) !== userId) throw notFound('turn');
    return { turn, rows };
  }

  /** Whether the person may not change what the line belongs to: its owner has to put it back. */
  private async needsOwner(row: Row, userId: string): Promise<boolean> {
    if (!['routine', 'skill', 'bot', 'memory'].includes(row.kind)) return false;
    if (row.kind === 'memory' && !row.scopeBotId) return false;
    const botId = row.scopeBotId ?? row.botId;
    const level = await this.services.access.level(await this.services.access.viewerOf(userId), botId);
    return !atLeast(level, 'edit');
  }

  private async item(row: Row, userId: string): Promise<TurnChangeItem> {
    return {
      id: row.id,
      kind: row.kind,
      op: row.op,
      label: row.label,
      reason: row.reason,
      needsOwner: await this.needsOwner(row, userId),
      outcome: row.outcome,
    };
  }

  /** What the turn did outside, from the step log: nothing there can be taken back. */
  private async outside(turnId: string): Promise<{ summary: string; at: string }[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.botActions)
      .where(eq(schema.botActions.turnId, turnId))
      .orderBy(asc(schema.botActions.createdAt));
    return rows
      .filter((r) => !NOT_OUTSIDE.has(stepName(r.toolName)))
      .map((r) => ({ summary: r.summary || stepName(r.toolName), at: r.createdAt.toISOString() }));
  }

  /** What taking the turn back would put back, and what no one can. */
  async preview(turnId: string, userId: string): Promise<TurnChanges> {
    const { turn, rows } = await this.lines(turnId, userId);
    return {
      turnId,
      running: turn.status === 'queued' || turn.status === 'running',
      undone: rows.length > 0 && rows.every((r) => r.undoneAt),
      items: await Promise.all(rows.map((r) => this.item(r, userId))),
      outside: await this.outside(turnId),
    };
  }

  /**
   * Puts back what the turn changed, newest first. A target that changed again since is left as it
   * is. A turn can be taken back once; one still working cannot. The result is said in the
   * conversation.
   */
  async undo(turnId: string, userId: string, t: T): Promise<TurnChanges> {
    const { turn, rows } = await this.lines(turnId, userId);
    if (turn.status === 'queued' || turn.status === 'running') throw new HttpError(409, 'error.turnRunning');
    if (!rows.length) throw notFound('turn');
    // Claimed in one write, so two taps do not put things back twice.
    const claimed = await this.ctx.db
      .update(schema.turnChanges)
      .set({ undoneAt: new Date() })
      .where(and(eq(schema.turnChanges.turnId, turnId), isNull(schema.turnChanges.undoneAt)))
      .returning({ id: schema.turnChanges.id });
    if (!claimed.length) throw new HttpError(409, 'error.turnUndone');
    const mine = new Set(claimed.map((c) => c.id));
    // A gap the turn flagged goes with it: what the taken-back turn saw is not trusted either.
    await this.services.memoryFlags.dropForTurn(turnId);
    const items: TurnChangeItem[] = [];
    for (const row of rows.filter((r) => mine.has(r.id))) {
      let outcome: TurnChangeOutcome;
      if (row.reason) outcome = 'notUndoable';
      else if (await this.needsOwner(row, userId)) outcome = 'needsOwner';
      else {
        outcome = await this.restore(row, userId).catch((err: unknown) => {
          console.warn(`Could not put back a change of a turn: ${String(err)}`);
          return 'failed' as const;
        });
      }
      // What it held is no longer needed: a turn is taken back once, so the old words and file
      // contents go now rather than after 30 days.
      await this.ctx.db
        .update(schema.turnChanges)
        .set({ outcome, before: null })
        .where(eq(schema.turnChanges.id, row.id));
      items.push({ ...(await this.item(row, userId)), outcome });
    }
    const outside = await this.outside(turnId);
    await this.say(turn, items, outside, t);
    return { turnId, running: false, undone: true, items, outside };
  }

  /** The short system message listing what was put back and what was not. */
  private async say(
    turn: typeof schema.turns.$inferSelect,
    items: TurnChangeItem[],
    outside: { summary: string }[],
    t: T,
  ) {
    const line = (i: TurnChangeItem) => `- ${t(`undo.kind.${i.kind}`)}: ${i.label}`;
    const part = (title: string, list: string[]) => (list.length ? `${title}\n${list.join('\n')}` : '');
    const by = (o: TurnChangeOutcome) => items.filter((i) => i.outcome === o).map(line);
    const text = [
      t('undo.said'),
      part(t('undo.restored'), by('restored')),
      part(t('undo.later'), by('later')),
      part(t('undo.needsOwner'), by('needsOwner')),
      part(
        t('undo.notUndoable'),
        items.filter((i) => i.outcome === 'notUndoable' && i.reason !== 'deleted').map(line),
      ),
      part(
        t('undo.deleted'),
        items.filter((i) => i.reason === 'deleted').map((i) => `- ${t(`undo.kind.${i.kind}`)}`),
      ),
      part(t('undo.failed'), by('failed')),
      part(
        t('undo.outside'),
        outside.map((o) => `- ${o.summary}`),
      ),
    ]
      .filter(Boolean)
      .join('\n\n');
    await this.services.threads.addMessage({
      threadId: turn.threadId,
      role: 'system',
      author: 'system',
      text,
      props: { kind: 'turnUndo', turnId: turn.id },
    });
  }

  /** Puts one line back; what changed again since is left and reported. */
  private async restore(row: Row, userId: string): Promise<TurnChangeOutcome> {
    const s = this.services;
    const before = row.before as Json | null;
    const after = row.after as Json | null;
    switch (row.kind) {
      case 'file':
        return this.restoreFile(row, before, after);
      case 'table_row': {
        const tableId = String(before?.tableId ?? after?.tableId);
        const current = await s.tables.rowById(tableId, row.targetId).catch(() => null);
        if (row.op === 'delete') {
          if (current || !before) return 'later';
          await s.tables.reinsertRow(tableId, {
            id: row.targetId,
            values: before.values as never,
            createdAt: String(before.createdAt),
            updatedAt: String(before.updatedAt),
          });
          return 'restored';
        }
        if (!current || current.updatedAt !== after?.updatedAt) return 'later';
        if (row.op === 'create') await s.tables.deleteRows(tableId, [row.targetId]);
        else
          await s.tables.putRowBack(
            tableId,
            row.targetId,
            before!.values as never,
            String(before!.updatedAt),
          );
        return 'restored';
      }
      case 'ticket': {
        const current = await s.tickets.find(row.targetId);
        if (!current || sig(ticketShape(current)) !== after?.sig) return 'later';
        if (row.op === 'create') await s.tickets.remove(row.targetId);
        else await s.tickets.update(row.targetId, before!.patch as never, false);
        return 'restored';
      }
      case 'routine': {
        const current = await s.routines.get(row.targetId).catch(() => null);
        if (row.op === 'delete') {
          const shape = before!.shape as Json;
          const same = (await s.routines.list(String(before!.botId))).find(
            (r) => r.name.toLowerCase() === String(shape.name).toLowerCase(),
          );
          if (current || same) return 'later';
          await s.routines.create(
            { ...(shape as object), botId: String(before!.botId) } as never,
            (before!.createdBy as string | null) ?? null,
          );
          return 'restored';
        }
        if (!current || sig(routineShape(current)) !== after?.sig) return 'later';
        if (row.op === 'create') await s.routines.remove(row.targetId);
        else await s.routines.update(row.targetId, before!.patch as never);
        return 'restored';
      }
      case 'skill': {
        const current = await s.skills.get(row.targetId).catch(() => null);
        if (!current || sig(skillShape(current)) !== after?.sig) return 'later';
        if (row.op === 'create') await s.skills.remove(row.targetId);
        else {
          if (!(await s.skills.mayChange(row.targetId, await s.skills.reachOf(userId)))) return 'needsOwner';
          await s.skills.update(row.targetId, before as never);
        }
        return 'restored';
      }
      case 'bot':
        return this.restoreBot(row, before, after);
      case 'memory':
        return this.restoreMemory(row, before, after, userId);
    }
  }

  private async restoreFile(row: Row, before: Json | null, after: Json | null): Promise<TurnChangeOutcome> {
    const bot = await this.services.bots.get(row.botId);
    const roots = [
      resolve(this.ctx.config.dataDir, 'workspaces', 'bots', bot.id),
      ...(bot.groupId
        ? [resolve(this.ctx.config.dataDir, 'workspaces', 'groups', bot.groupId, 'files')]
        : []),
      ...(bot.projectDir ? [bot.projectDir] : []),
    ].map(realPath);
    const path = realPath(row.targetId);
    if (!roots.some((r) => inside(path, r)) || !before) return 'failed';
    const info = await lstat(path).catch(() => null);
    if (info && !info.isFile()) return 'later';
    // As the turn left it: anything else was changed since, by a later turn or by the person.
    const now = info ? (info.size <= HASH_MAX ? sha(await readFile(path)) : '') : null;
    if (now !== (after?.sha ?? null) || (info && now === '')) return 'later';
    if (before.exists === false) await rm(path, { force: true });
    else {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, unkeep(before));
    }
    return 'restored';
  }

  private async restoreBot(row: Row, before: Json | null, after: Json | null): Promise<TurnChangeOutcome> {
    const s = this.services;
    const current = await s.bots.get(row.targetId).catch(() => null);
    if (!current || !before) return 'later';
    if (before.what === 'archive') {
      if (!current.archivedAt) return 'later';
      await s.bots.restore(row.targetId);
      return 'restored';
    }
    if (before.what === 'skill') {
      const on = (await s.skills.forBot(row.targetId)).some((k) => k.id === before.skillId);
      if (on !== (after?.on as boolean)) return 'later';
      await s.skills.setBot(String(before.skillId), row.targetId, before.was as boolean);
      return 'restored';
    }
    const patch = before.patch as Json;
    if (sig(pick(current as unknown as Json, Object.keys(patch))) !== after?.sig) return 'later';
    await s.bots.update(row.targetId, patch as never);
    return 'restored';
  }

  private async restoreMemory(
    row: Row,
    before: Json | null,
    after: Json | null,
    userId: string,
  ): Promise<TurnChangeOutcome> {
    const s = this.services;
    const current = await s.memory.get(row.targetId).catch(() => null);
    if (!current || sig(noteShape(current)) !== after?.sig) return 'later';
    if (current.scope === 'user' && current.userId !== userId) return 'needsOwner';
    if (row.op === 'create') await s.memory.remove(row.targetId, 'user');
    else
      await s.memory.update(
        row.targetId,
        { content: String(before!.content), validUntil: (before!.validUntil as string | null) ?? null },
        'user',
      );
    return 'restored';
  }

  /** Lets go of what is older than `CHANGE_KEEP_DAYS`. */
  async prune(now = new Date()): Promise<void> {
    const before = new Date(now.getTime() - CHANGE_KEEP_DAYS * 86_400_000);
    await this.ctx.db.delete(schema.turnChanges).where(lt(schema.turnChanges.createdAt, before));
  }

  /** Whether any line of the given turns is still waiting; used by tests and the sweep. */
  async count(turnIds: string[]): Promise<number> {
    if (!turnIds.length) return 0;
    const [row] = await this.ctx.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.turnChanges)
      .where(inArray(schema.turnChanges.turnId, turnIds));
    return row?.n ?? 0;
  }
}

/** The fields people may change, as each kind's fingerprint takes them. */
const pick = (o: Json, keys: string[]) => Object.fromEntries(keys.map((k) => [k, o[k] ?? null]));

/**
 * Every field a routine is made from (`RoutineCreate` but the bot), so a deleted one comes back
 * whole and a later change to any of them is seen.
 */
export const ROUTINE_KEYS = [
  'name',
  'prompt',
  'steps',
  'schedule',
  'timezone',
  'enabled',
  'missed',
  'carryReport',
  'inMain',
  'slackChannel',
  'slackReaction',
  'onStartup',
  'watchUrl',
  'check',
  'webhookFilter',
  'webhookPost',
  'model',
  'emailTrigger',
  'emailFilter',
  'whatsappGroup',
  'whatsappPeople',
  'tableTrigger',
  'tableFilter',
  'flowLayout',
];
export const routineShape = (r: object) => pick(r as Json, ROUTINE_KEYS);
export const skillShape = (k: { description: string; body: string }) => ({
  description: k.description,
  body: k.body,
});
const TICKET_KEYS = ['title', 'description', 'priority', 'status', 'assigneeBotId'];
export const ticketShape = (k: object) => pick(k as Json, TICKET_KEYS);
export const TICKET_FIELDS = TICKET_KEYS;
export const noteShape = (m: { content: string; validUntil?: string | null; pinned?: boolean | null }) => ({
  content: m.content,
  validUntil: m.validUntil ?? null,
  pinned: !!m.pinned,
});
export { pick as pickFields };
