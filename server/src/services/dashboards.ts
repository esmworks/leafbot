import {
  MAX_DASHBOARDS,
  MAX_TILES,
  storedCard,
  tableTileCard,
  tileCard,
  tileProblem,
  TileSpec,
  type BotTable,
  type Card,
  type DashboardSummary,
  type DashboardTileView,
  type DashboardView,
  type TableRow,
  type TileProblem,
} from '@leafbot/shared';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import { HttpError, isUniqueViolation, newId, notFound } from '../util';
import type { Services } from './index';

type TileRow = typeof schema.dashboardTiles.$inferSelect;
type DashboardRow = typeof schema.dashboards.$inferSelect;

const key = (v: string) => v.trim().toLocaleLowerCase('tr');

/** A tile as a bot writes it: what it shows, and for a `card` tile the card. */
export type TileInput = TileSpec & { card?: unknown };

/** Whose tiles a reader sees: the bots a person reaches, or one bot's own. */
export type Reader = { userId: string } | { userId: string; onlyBot: string };

/**
 * Dashboards bots fill and people and bots follow. A page is found by its name; each tile belongs
 * to the bot that wrote it and reads only that bot's tables. A reader sees the tiles of the bots
 * they may talk with, as a bot working for them reaches no further, so a page shared by several
 * bots shows each person the part that is theirs to see.
 */
export class DashboardService {
  constructor(
    private ctx: Ctx,
    private s: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  private changed() {
    this.ctx.bus.refresh({ scope: 'dashboards' });
  }

  private async reached(reader: Reader): Promise<(botId: string | null) => boolean> {
    if ('onlyBot' in reader) return (id) => id === reader.onlyBot;
    const ids = new Set(await this.s.access.botIds(await this.s.access.viewerOf(reader.userId), 'chat'));
    return (id) => !!id && ids.has(id);
  }

  /** The dashboards the reader sees some of, most recently changed first. */
  async list(reader: Reader): Promise<DashboardSummary[]> {
    const sees = await this.reached(reader);
    const pages = await this.ctx.db.select().from(schema.dashboards);
    if (!pages.length) return [];
    const tiles = await this.ctx.db
      .select({
        dashboardId: schema.dashboardTiles.dashboardId,
        botId: schema.dashboardTiles.botId,
        updatedAt: schema.dashboardTiles.updatedAt,
      })
      .from(schema.dashboardTiles)
      .orderBy(asc(schema.dashboardTiles.position), asc(schema.dashboardTiles.createdAt));
    const out: DashboardSummary[] = [];
    for (const p of pages) {
      const mine = tiles.filter((x) => x.dashboardId === p.id && sees(x.botId));
      const all = tiles.some((x) => x.dashboardId === p.id);
      // An empty page is seen by those who reach the bot that started it.
      if (!mine.length && (all || !sees(p.createdByBotId))) continue;
      out.push({
        id: p.id,
        name: p.name,
        botIds: [...new Set(mine.map((x) => x.botId))],
        tileCount: mine.length,
        updatedAt: p.updatedAt.toISOString(),
      });
    }
    return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async page(id: string): Promise<DashboardRow> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.dashboards)
      .where(eq(schema.dashboards.id, id))
      .limit(1);
    if (!row) throw notFound('dashboard');
    return row;
  }

  /** The dashboard of this name, in any letters, with the names of those the reader sees for when there is none. */
  async find(
    name: string,
    reader: Reader,
  ): Promise<{ found: DashboardSummary | undefined; names: string[] }> {
    const seen = await this.list(reader);
    return { found: seen.find((d) => key(d.name) === key(name)), names: seen.map((d) => d.name) };
  }

  /**
   * The dashboard with each tile the reader sees worked out: a table tile from its table's rows as
   * they are now, a card tile as its bot last wrote it. A tile that cannot be worked out (its table
   * deleted, a column renamed) says why, and the rest still show.
   */
  async view(id: string, reader: Reader): Promise<DashboardView> {
    const p = await this.page(id);
    const sees = await this.reached(reader);
    const rows = await this.ctx.db
      .select()
      .from(schema.dashboardTiles)
      .where(eq(schema.dashboardTiles.dashboardId, id))
      .orderBy(asc(schema.dashboardTiles.position), asc(schema.dashboardTiles.createdAt));
    const tiles = rows.filter((r) => sees(r.botId));
    if (!tiles.length && (rows.length || !sees(p.createdByBotId))) throw notFound('dashboard');
    const t = await this.s.settings.translator();
    const locale = await this.s.settings.locale();
    const { timezone } = await this.s.settings.all(reader.userId);
    // Each bot's tables and each table's rows are read once, however many tiles use them.
    const tables = new Map<string, Promise<BotTable[]>>();
    const tableRows = new Map<string, Promise<TableRow[]>>();
    const tablesOf = (botId: string) => {
      let x = tables.get(botId);
      if (!x) tables.set(botId, (x = this.s.tables.list(botId)));
      return x;
    };
    const rowsOf = (tableId: string) => {
      let x = tableRows.get(tableId);
      if (!x) tableRows.set(tableId, (x = this.s.tables.rows(tableId)));
      return x;
    };
    const say = (problem: TileProblem) => t(problem.key, problem.vars);
    const cx = {
      now: this.clock(),
      timeZone: timezone,
      locale,
      say: (k: Parameters<typeof t>[0], vars?: Record<string, string | number>) => t(k, vars),
      yes: t('tool.tableYes'),
      no: t('tool.tableNo'),
    };
    const out: DashboardTileView[] = [];
    for (const r of tiles) {
      const parsed = TileSpec.safeParse(r.spec);
      const base = {
        id: r.id,
        botId: r.botId,
        title: r.title,
        show: parsed.success ? parsed.data.show : ('card' as const),
        wide: parsed.success ? !!parsed.data.wide : false,
        updatedAt: r.updatedAt.toISOString(),
      };
      if (!parsed.success) {
        out.push({ ...base, card: null, error: t('dashboard.problem.badSpec') });
        continue;
      }
      const spec = parsed.data;
      if (spec.show === 'card') {
        const card = storedCard(r.card);
        out.push({ ...base, card, error: card ? null : say({ key: 'dashboard.problem.needsCard' }) });
        continue;
      }
      const table = (await tablesOf(r.botId)).find((x) => key(x.name) === key(spec.table ?? ''));
      if (!table) {
        out.push({ ...base, card: null, error: say(tileProblem(spec, undefined)!) });
        continue;
      }
      const made = tableTileCard(spec, table, await rowsOf(table.id), cx);
      out.push(
        made.ok
          ? { ...base, card: made.card, error: null }
          : { ...base, card: null, error: say(made.problem) },
      );
    }
    return { id: p.id, name: p.name, updatedAt: p.updatedAt.toISOString(), tiles: out };
  }

  /**
   * A bot puts tiles on a dashboard, starting it if there is none of that name, and takes its own
   * tiles off by title. A tile of a title the bot already has there is replaced in its place.
   * Everything is checked first: one tile that cannot be kept stops the whole write, so the bot
   * never leaves a page half changed. Returns the page's id and what changed, for the bot.
   */
  async define(
    botId: string,
    name: string,
    input: { tiles: TileInput[]; remove: string[] },
    t: T,
  ): Promise<{ id: string; name: string; written: string[]; removed: number }> {
    const problems: string[] = [];
    const ready: { title: string; spec: TileSpec; card: Card | null }[] = [];
    const seenTitles = new Set<string>();
    for (const tile of input.tiles) {
      const { card: rawCard, ...rest } = tile;
      const spec = TileSpec.parse(rest);
      if (seenTitles.has(key(spec.title))) {
        problems.push(t('dashboard.problem.sameTitle', { title: spec.title }));
        continue;
      }
      seenTitles.add(key(spec.title));
      const fail = (p: TileProblem) => problems.push(`${spec.title}: ${t(p.key, p.vars)}`);
      if (spec.show === 'card') {
        const made = tileCard(rawCard);
        if (!made.ok) fail(made.problem);
        else ready.push({ title: spec.title, spec, card: made.card });
        continue;
      }
      if (rawCard !== undefined) {
        fail({ key: 'dashboard.problem.cardOnly' });
        continue;
      }
      if (!spec.table) {
        fail({ key: 'dashboard.problem.noTable', vars: { table: '' } });
        continue;
      }
      const { found, names } = await this.s.tables.find(botId, spec.table);
      if (!found) {
        problems.push(
          `${spec.title}: ${t('dashboard.problem.noTableOf', { table: spec.table, tables: names.join(', ') || '—' })}`,
        );
        continue;
      }
      const p = tileProblem(spec, found);
      if (p) fail(p);
      else ready.push({ title: spec.title, spec: { ...spec, table: found.name }, card: null });
    }
    if (problems.length) throw new HttpError(400, 'dashboard.problems', { problems: problems.join('\n') });

    const page = await this.pageNamed(name, botId);
    const existing = await this.ctx.db
      .select({
        titleKey: schema.dashboardTiles.titleKey,
        botId: schema.dashboardTiles.botId,
        position: schema.dashboardTiles.position,
      })
      .from(schema.dashboardTiles)
      .where(eq(schema.dashboardTiles.dashboardId, page.id));
    const removeKeys = new Set(input.remove.map(key));
    const mineNow = new Set(existing.filter((x) => x.botId === botId).map((x) => x.titleKey));
    const staying = existing.filter((x) => !(x.botId === botId && removeKeys.has(x.titleKey)));
    const added = ready.filter((x) => !mineNow.has(key(x.title)) || removeKeys.has(key(x.title)));
    if (staying.length + added.length > MAX_TILES)
      throw new HttpError(400, 'dashboard.tooManyTiles', { max: MAX_TILES });

    const now = this.clock();
    let removed = 0;
    await this.ctx.db.transaction(async (tx) => {
      if (removeKeys.size) {
        const gone = await tx
          .delete(schema.dashboardTiles)
          .where(
            and(
              eq(schema.dashboardTiles.dashboardId, page.id),
              eq(schema.dashboardTiles.botId, botId),
              inArray(schema.dashboardTiles.titleKey, [...removeKeys]),
            ),
          )
          .returning({ id: schema.dashboardTiles.id });
        removed = gone.length;
      }
      let next = Math.max(-1, ...existing.map((x) => x.position)) + 1;
      for (const x of ready) {
        await tx
          .insert(schema.dashboardTiles)
          .values({
            id: newId(),
            dashboardId: page.id,
            botId,
            title: x.title,
            titleKey: key(x.title),
            spec: x.spec as Record<string, unknown>,
            card: x.card,
            position: next++,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [
              schema.dashboardTiles.dashboardId,
              schema.dashboardTiles.botId,
              schema.dashboardTiles.titleKey,
            ],
            set: { title: x.title, spec: x.spec as Record<string, unknown>, card: x.card, updatedAt: now },
          });
      }
      await tx.update(schema.dashboards).set({ updatedAt: now }).where(eq(schema.dashboards.id, page.id));
    });
    this.changed();
    return { id: page.id, name: page.name, written: ready.map((x) => x.title), removed };
  }

  /** The page of this name, started by the bot when there is none yet. */
  private async pageNamed(name: string, botId: string): Promise<DashboardRow> {
    const nameKey = key(name);
    const find = async () =>
      (
        await this.ctx.db
          .select()
          .from(schema.dashboards)
          .where(eq(schema.dashboards.nameKey, nameKey))
          .limit(1)
      )[0];
    const found = await find();
    if (found) return found;
    const [{ n } = { n: 0 }] = await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.dashboards);
    if (n >= MAX_DASHBOARDS) throw new HttpError(400, 'dashboard.tooMany', { max: MAX_DASHBOARDS });
    try {
      const [row] = await this.ctx.db
        .insert(schema.dashboards)
        .values({ id: newId(), name: name.trim(), nameKey, createdByBotId: botId })
        .returning();
      return row!;
    } catch (err) {
      // Two bots starting the same page at once: the second takes the first's.
      if (isUniqueViolation(err)) return (await find())!;
      throw err;
    }
  }

  /** A person takes one tile off, as one who may change the bot it belongs to. */
  async removeTile(tileId: string, userId: string) {
    const [tile] = await this.ctx.db
      .select()
      .from(schema.dashboardTiles)
      .where(eq(schema.dashboardTiles.id, tileId))
      .limit(1);
    if (!tile) throw notFound('dashboardTile');
    const viewer = await this.s.access.viewerOf(userId);
    // One who cannot even see the tile is told there is none.
    if (!(await this.s.access.botIds(viewer, 'chat')).includes(tile.botId)) throw notFound('dashboardTile');
    await this.s.access.requireBot(viewer, tile.botId, 'edit');
    await this.ctx.db.delete(schema.dashboardTiles).where(eq(schema.dashboardTiles.id, tileId));
    await this.touch(tile);
  }

  /**
   * A person moves a tile one place earlier or later among the tiles they see; tiles of bots they
   * do not reach keep their places around it.
   */
  async moveTile(tileId: string, direction: 'earlier' | 'later', userId: string) {
    const [tile] = await this.ctx.db
      .select()
      .from(schema.dashboardTiles)
      .where(eq(schema.dashboardTiles.id, tileId))
      .limit(1);
    if (!tile) throw notFound('dashboardTile');
    const sees = await this.reached({ userId });
    if (!sees(tile.botId)) throw notFound('dashboardTile');
    await this.s.access.requireBot(await this.s.access.viewerOf(userId), tile.botId, 'edit');
    const all = await this.ctx.db
      .select({ id: schema.dashboardTiles.id, botId: schema.dashboardTiles.botId })
      .from(schema.dashboardTiles)
      .where(eq(schema.dashboardTiles.dashboardId, tile.dashboardId))
      .orderBy(asc(schema.dashboardTiles.position), asc(schema.dashboardTiles.createdAt));
    const order = all.map((x) => x.id);
    const visible = all.filter((x) => sees(x.botId)).map((x) => x.id);
    const at = visible.indexOf(tileId);
    const other = visible[direction === 'earlier' ? at - 1 : at + 1];
    if (!other) return;
    const a = order.indexOf(tileId);
    const b = order.indexOf(other);
    [order[a], order[b]] = [order[b]!, order[a]!];
    await this.ctx.db.transaction(async (tx) => {
      for (const [i, id] of order.entries())
        await tx.update(schema.dashboardTiles).set({ position: i }).where(eq(schema.dashboardTiles.id, id));
    });
    await this.touch(tile);
  }

  /**
   * A person deletes a whole page. It is shared by its bots, so only one who may change every bot
   * with a tile on it may; otherwise they take their own bots' tiles off instead.
   */
  async remove(id: string, userId: string) {
    const p = await this.page(id);
    const viewer = await this.s.access.viewerOf(userId);
    const tiles = await this.ctx.db
      .select({ botId: schema.dashboardTiles.botId })
      .from(schema.dashboardTiles)
      .where(eq(schema.dashboardTiles.dashboardId, id));
    const bots = new Set(tiles.map((x) => x.botId));
    if (p.createdByBotId && !bots.size) bots.add(p.createdByBotId);
    const chat = new Set(await this.s.access.botIds(viewer, 'chat'));
    if (![...bots].some((b) => chat.has(b))) throw notFound('dashboard');
    const edit = new Set(await this.s.access.botIds(viewer, 'edit'));
    if (![...bots].every((b) => edit.has(b))) throw new HttpError(403, 'dashboard.notAllYours');
    await this.ctx.db.delete(schema.dashboards).where(eq(schema.dashboards.id, id));
    this.changed();
  }

  private async touch(tile: TileRow) {
    await this.ctx.db
      .update(schema.dashboards)
      .set({ updatedAt: this.clock() })
      .where(eq(schema.dashboards.id, tile.dashboardId));
    this.changed();
  }
}
