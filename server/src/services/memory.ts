import {
  STALE_MEMORY_DAYS,
  type Bot,
  type Memory,
  type MemoryChange,
  type MemoryGraph,
  type MemoryScope,
} from '@leafbot/shared';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { matchInServer } from '../db/sealed';
import { lastActive, MEMORY_PROMPT_CHARS, PINNED_MEMORY_CHARS, withinBudget } from '../runtime/prompt';
import { DOTTED_AND_DOTLESS_I, foldText, HttpError, newId, notFound } from '../util';
import { toMemory, toMemoryChange } from './mappers';
import { scrubCanary } from './canary';
import { noteKey } from './secrets';
import { siteMatches } from './vault';
import { MIN_SCORE, similarity, type EmbeddingService } from './embeddings';
import { OWNER_ID } from '../users';
import { settleChangeFlags, settleNoteFlags } from './memory-flags';

/** A note whose words hold the query ranks this much above one only near it in meaning. */
const WORD_MATCH_BONUS = 0.25;
/** Notes a search by meaning returns at most. */
const MEANING_HITS = 20;

/** Room notes one place keeps at most, so a busy channel cannot fill every prompt that reaches it. */
export const ROOM_NOTES_PER_PLACE = 50;
/** Notes for every bot at most: each goes to every bot, so they stay a page, not a library. */
export const COMMON_NOTES = 100;

/**
 * What one person reaches of the memory: their own notes, the bots they may change, and the
 * places (see `placeOf`) whose notes they may see and delete.
 */
export interface MemoryReach {
  userId: string;
  botIds: string[];
  places: string[];
  /**
   * Whether the person looks after the server, and so reaches every chat app channel's history too,
   * the history of channels whose notes are all gone included.
   */
  managesServer?: boolean;
}

/** The most notes the memory map links; and how near two must be in meaning, and to how many each is linked. */
export const GRAPH_NOTES = 500;
const GRAPH_NEAR = 0.6;
const GRAPH_NEIGHBOURS = 3;
/** Rows of the meaning comparison done before the server turns to other work for a moment. */
const GRAPH_ROWS_AT_ONCE = 25;

/** The SQL condition for the notes of `reach`. */
const reachable = (reach: MemoryReach) =>
  or(
    // What every bot knows is no secret from those who use the bots.
    eq(schema.memories.scope, 'common'),
    and(eq(schema.memories.scope, 'user'), eq(schema.memories.userId, reach.userId)),
    reach.botIds.length
      ? and(eq(schema.memories.scope, 'bot'), inArray(schema.memories.botId, reach.botIds))
      : sql`false`,
    reach.places.length
      ? and(eq(schema.memories.scope, 'room'), inArray(schema.memories.place, reach.places))
      : sql`false`,
  )!;

/**
 * Whose a note is, as its history lines keep it: a person's own, a bot's, or a place's. The line
 * keeps it, so a deleted note's history still goes only to those it was for.
 */
const noteOwner = (m: {
  scope: string;
  botId: string | null;
  userId?: string | null;
  place?: string | null;
}) =>
  m.scope === 'user'
    ? `user:${m.userId ?? OWNER_ID}`
    : m.scope === 'room'
      ? `room:${m.place}`
      : m.scope === 'common'
        ? 'common'
        : `bot:${m.botId}`;

/** Whether a waiting change is one `reach` decides on. */
export const decides = (
  reach: MemoryReach,
  c: Pick<MemoryChange, 'scope' | 'botId' | 'userId'> & { place?: string | null },
) =>
  c.scope === 'user'
    ? (c.userId ?? OWNER_ID) === reach.userId
    : c.scope === 'room'
      ? !!c.place && reach.places.includes(c.place)
      : c.scope === 'common'
        ? !!reach.managesServer
        : !!c.botId && reach.botIds.includes(c.botId);

/**
 * Where a conversation is, for the notes about a place: a Slack or Discord channel (every thread
 * of the channel is in the same place), or a room. Null for the rest (a person's own chat, a
 * routine, a bot talking to a bot): they are in no place, so no place's notes reach them.
 */
export async function placeOf(
  ctx: Pick<Ctx, 'db'>,
  thread: { id: string; kind: string },
): Promise<string | null> {
  if (thread.kind === 'room') return `room:${thread.id}`;
  if (thread.kind !== 'team') return null;
  const [slack] = await ctx.db
    .select({ channel: schema.slackThreads.channel })
    .from(schema.slackThreads)
    .where(eq(schema.slackThreads.threadId, thread.id))
    .limit(1);
  if (slack) return `slack:${slack.channel}`;
  const [discord] = await ctx.db
    .select({ channel: schema.discordThreads.channel })
    .from(schema.discordThreads)
    .where(eq(schema.discordThreads.threadId, thread.id))
    .limit(1);
  return discord ? `discord:${discord.channel}` : null;
}

/** The notes of one place; none for null (a conversation that is in no place). */
const placeNotes = (place: string | null) =>
  place ? and(eq(schema.memories.scope, 'room'), eq(schema.memories.place, place)) : sql`false`;

/** Whether the note's "true until" date has passed. */
export const isExpired = (m: Pick<Memory, 'validUntil'>, now: Date) =>
  !!m.validUntil && new Date(m.validUntil).getTime() <= now.getTime();

/**
 * The notes that are still true: those with no end date, or whose date has not come. An expired
 * note stays in the database (the person may extend or delete it) but reaches no bot.
 */
const unexpired = (now: Date) => or(isNull(schema.memories.validUntil), gt(schema.memories.validUntil, now))!;

/** One person's notes; none for null (a team conversation, which reads no one's own notes). */
const userNotes = (userId: string | null) =>
  userId ? and(eq(schema.memories.scope, 'user'), eq(schema.memories.userId, userId)) : sql`false`;

/** The notes for every bot, where they reach: not a turn a stranger or a WhatsApp contact writes in. */
const commonNotes = (reach: boolean) => (reach ? eq(schema.memories.scope, 'common') : sql`false`);

export class MemoryService {
  private embeddings: EmbeddingService | null = null;

  constructor(private ctx: Ctx) {}

  /** Search by meaning, once the embedding service exists; until it is set up, search goes by words. */
  useEmbeddings(e: EmbeddingService) {
    this.embeddings = e;
  }

  /**
   * Notes, oldest first. With `reach`, only those one person may see: their own notes about
   * themselves, and the notes of the bots they may change.
   */
  async list(opts: { scope?: MemoryScope; botId?: string | null; reach?: MemoryReach } = {}) {
    const conds = [];
    if (opts.scope) conds.push(eq(schema.memories.scope, opts.scope));
    if (opts.botId) conds.push(eq(schema.memories.botId, opts.botId));
    if (opts.reach) conds.push(reachable(opts.reach));
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(asc(schema.memories.createdAt));
    return rows.map(toMemory);
  }

  /**
   * How the notes `reach` covers hang together, for the memory map: notes about the same site,
   * notes a bot wrote in the same conversation, and, when search by meaning is on, notes near each
   * other in meaning (each to its few nearest). The notes themselves come from `list`.
   */
  async graph(reach?: MemoryReach): Promise<MemoryGraph> {
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(reach ? reachable(reach) : undefined)
      .orderBy(asc(schema.memories.createdAt))
      // One more than are linked, to tell whether some were left out.
      .limit(GRAPH_NOTES + 1);
    const truncated = rows.length > GRAPH_NOTES;
    if (truncated) rows.length = GRAPH_NOTES;
    const edges: MemoryGraph['edges'] = [];
    const seen = new Set<string>();
    const link = (a: string, b: string, kind: MemoryGraph['edges'][number]['kind'], score?: number) => {
      const key = a < b ? `${a} ${b}` : `${b} ${a}`;
      if (a === b || seen.has(key)) return;
      seen.add(key);
      edges.push({ a, b, kind, ...(score !== undefined && { score: Math.round(score * 100) / 100 }) });
    };
    // Notes that share a site, or a conversation, are linked one to the next, not each to each.
    for (const [kind, of] of [
      ['site', (r: (typeof rows)[number]) => r.site],
      ['conversation', (r: (typeof rows)[number]) => r.threadId],
    ] as const) {
      const groups = new Map<string, string[]>();
      for (const r of rows) {
        const k = of(r);
        if (k) groups.set(k, [...(groups.get(k) ?? []), r.id]);
      }
      for (const ids of groups.values())
        for (let i = 1; i < ids.length; i++) link(ids[i - 1]!, ids[i]!, kind);
    }
    const vectors = this.embeddings ? await this.embeddings.vectors(rows) : null;
    if (vectors) {
      // Each pair is compared once; every note keeps its few nearest. The work is cut into parts
      // so a large memory does not hold up the server's other requests meanwhile.
      const ids = [...vectors.keys()];
      const list = ids.map((id) => vectors.get(id)!);
      const nearest: { b: number; score: number }[][] = ids.map(() => []);
      const keep = (i: number, b: number, score: number) => {
        const n = nearest[i]!;
        if (n.length === GRAPH_NEIGHBOURS && n[n.length - 1]!.score >= score) return;
        n.push({ b, score });
        n.sort((x, y) => y.score - x.score);
        if (n.length > GRAPH_NEIGHBOURS) n.pop();
      };
      for (let i = 0; i < ids.length; i++) {
        for (let j = i + 1; j < ids.length; j++) {
          const score = similarity(list[i]!, list[j]!);
          if (score < GRAPH_NEAR) continue;
          keep(i, j, score);
          keep(j, i, score);
        }
        if (i % GRAPH_ROWS_AT_ONCE === GRAPH_ROWS_AT_ONCE - 1) await new Promise((r) => setImmediate(r));
      }
      nearest.forEach((n, i) => n.forEach(({ b, score }) => link(ids[i]!, ids[b]!, 'similar', score)));
    }
    return { edges, meaning: !!vectors, truncated };
  }

  /** The notes a bot has about the site of `host`: its own, those of the person it works for, and the place's. */
  async forSite(
    botId: string,
    host: string,
    userId: string | null,
    place: string | null = null,
  ): Promise<Memory[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(
        and(
          unexpired(new Date()),
          isNotNull(schema.memories.site),
          or(
            userNotes(userId),
            and(eq(schema.memories.scope, 'bot'), eq(schema.memories.botId, botId)),
            placeNotes(place),
          ),
        ),
      )
      .orderBy(asc(schema.memories.createdAt));
    const notes = rows.map(toMemory).filter((m) => siteMatches(host, m.site!));
    await this.markUsed(notes.map((m) => m.id));
    return notes;
  }

  /**
   * Records that a bot looked these notes up, which keeps them in the prompt and off the list of
   * notes no bot uses. It is not a change to the note: no history line, no new `updatedAt`. The
   * memory screen is not told either; a page opened in the browser would make it reload each time,
   * and when a note was last used only matters over weeks.
   */
  async markUsed(ids: string[], now = new Date()) {
    if (!ids.length) return;
    await this.ctx.db
      .update(schema.memories)
      .set({ lastUsedAt: now, useCount: sql`${schema.memories.useCount} + 1` })
      .where(inArray(schema.memories.id, ids));
  }

  /** The notes no bot uses any more (see `staleNotes`), the longest unused first; with `reach`, one person's. */
  async stale(now = new Date(), reach?: MemoryReach): Promise<Memory[]> {
    const [all, bots] = await Promise.all([
      this.list({ reach }),
      this.ctx.db
        .select({ id: schema.bots.id, memory: schema.bots.memory })
        .from(schema.bots)
        .where(isNull(schema.bots.archivedAt)),
    ]);
    // An expired note is in no prompt and is listed on its own (see `expired`), so it takes no
    // part in what fits the prompt, and is not offered twice.
    return staleNotes(
      all.filter((m) => !isExpired(m, now)),
      bots,
      now,
    );
  }

  /**
   * The notes whose "true until" date has passed, the longest expired first; with `reach`, one
   * person's. They are kept for the person to delete or give a new date.
   */
  async expired(now = new Date(), reach?: MemoryReach): Promise<Memory[]> {
    const conds = [isNotNull(schema.memories.validUntil), lte(schema.memories.validUntil, now)];
    if (reach) conds.push(reachable(reach));
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(and(...conds))
      .orderBy(asc(schema.memories.validUntil));
    return rows.map(toMemory);
  }

  /**
   * What a bot sees working for `userId` in `place`: its own memories, that person's notes about
   * themselves, and the place's notes (none outside a place).
   */
  async visibleTo(
    botId: string,
    userId: string | null,
    place: string | null = null,
    /** Whether the notes for every bot reach this turn (see `commonNotes`). */
    common = false,
  ): Promise<{ user: Memory[]; bot: Memory[]; room: Memory[]; common: Memory[] }> {
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(
        and(
          // Notes about a site come with that site, not with every turn.
          isNull(schema.memories.site),
          unexpired(new Date()),
          or(
            userNotes(userId),
            and(eq(schema.memories.scope, 'bot'), eq(schema.memories.botId, botId)),
            placeNotes(place),
            commonNotes(common),
          ),
        ),
      )
      .orderBy(asc(schema.memories.createdAt));
    const all = rows.map(toMemory);
    return {
      user: all.filter((m) => m.scope === 'user'),
      bot: all.filter((m) => m.scope === 'bot'),
      room: all.filter((m) => m.scope === 'room'),
      common: all.filter((m) => m.scope === 'common'),
    };
  }

  /**
   * Notes whose text holds `query`, or every one of them when there is no query: the own notes of
   * the bots in `botIds` and, unless `shared` is false, the shared user memory and the notes of
   * `place`, the place the asking conversation is in (a place's notes show nowhere else). A search with a
   * query counts as using the notes it finds; listing them all does not, as it picks none out.
   */
  async search(
    botIds: string[],
    userId: string | null,
    query?: string,
    shared = true,
    place: string | null = null,
    /** Whether the notes for every bot reach the asking turn (see `commonNotes`). */
    common = false,
  ): Promise<Memory[]> {
    const own = botIds.length
      ? and(eq(schema.memories.scope, 'bot'), inArray(schema.memories.botId, botIds))
      : sql`false`;
    const visible = and(
      unexpired(new Date()),
      shared ? or(userNotes(userId), own, placeNotes(place), commonNotes(common)) : own,
    )!;
    if (query?.trim() && this.embeddings && (await this.embeddings.available())) {
      const rows = await this.ctx.db
        .select()
        .from(schema.memories)
        .where(visible)
        .orderBy(asc(schema.memories.createdAt))
        .limit(5000);
      const scores = await this.embeddings.scores(query, rows);
      if (scores) {
        const needle = foldText(query.trim());
        const hits = rows
          .map((r) => ({ r, words: foldText(r.content).includes(needle), score: scores.get(r.id) ?? 0 }))
          .filter((h) => h.words || h.score >= MIN_SCORE)
          .sort(
            (a, b) =>
              b.score + (b.words ? WORD_MATCH_BONUS : 0) - (a.score + (a.words ? WORD_MATCH_BONUS : 0)),
          )
          .slice(0, MEANING_HITS);
        await this.markUsed(hits.map((h) => h.r.id));
        return hits.map((h) => toMemory(h.r));
      }
    }
    // ı and İ read as i on both sides, as the message search does.
    const q = query && `%${query.replace(/[ıİ]/g, 'i').replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    // Sealed notes cannot be matched in the database: every visible note is opened and matched
    // here instead. A person's notes number in the thousands at most.
    const inServer = matchInServer();
    const found = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(
        q && !inServer
          ? and(visible, sql`translate(${schema.memories.content}, ${DOTTED_AND_DOTLESS_I}, 'ii') ilike ${q}`)
          : visible,
      )
      .orderBy(asc(schema.memories.createdAt))
      .limit(inServer ? Number.MAX_SAFE_INTEGER : q ? 50 : 500);
    const rows = !inServer
      ? found
      : query
        ? found.filter((r) => foldText(r.content).includes(foldText(query.trim()))).slice(0, 50)
        : found.slice(0, 500);
    if (q) await this.markUsed(rows.map((r) => r.id));
    return rows.map(toMemory);
  }

  /**
   * Whether the note is `userId`'s own about themselves, the own note of one of `botIds`, or a
   * note of one of `places`.
   */
  canEdit(
    m: Memory,
    botIds: Iterable<string>,
    userId: string,
    places: Iterable<string> = [],
    /** Whether a person who looks after the server asks: only they change the notes for every bot. */
    managesServer = false,
  ) {
    if (m.scope === 'common') return managesServer;
    if (m.scope === 'room') return !!m.place && new Set(places).has(m.place);
    return m.scope === 'user' ? m.userId === userId : !!m.botId && new Set(botIds).has(m.botId);
  }

  /**
   * A note already saved with the same words (see `noteKey`), in the same place: the shared memory,
   * one bot's own notes or one place's, about the same site or none. Writing it again would only
   * repeat it.
   */
  async findSame(input: {
    scope: MemoryScope;
    botId: string | null;
    userId: string | null;
    place?: string | null;
    content: string;
    site?: string | null;
  }) {
    const rows = await this.ctx.db
      .select()
      .from(schema.memories)
      .where(
        and(
          eq(schema.memories.scope, input.scope),
          input.scope === 'bot' && input.botId
            ? eq(schema.memories.botId, input.botId)
            : isNull(schema.memories.botId),
          input.scope === 'user' && input.userId ? eq(schema.memories.userId, input.userId) : undefined,
          input.scope === 'room' ? eq(schema.memories.place, input.place ?? '') : undefined,
          input.site ? eq(schema.memories.site, input.site) : isNull(schema.memories.site),
          // A note past its date reaches no bot: the same fact said again is kept as a new note
          // (with its own date) instead of being taken for one already there.
          unexpired(new Date()),
        ),
      );
    const key = noteKey(input.content);
    const row = rows.find((r) => noteKey(r.content) === key);
    return row ? toMemory(row) : null;
  }

  /**
   * Keeps a memory change for the person to accept, instead of making it. The same change asked
   * for again (a daily routine noting the same fact) is kept once.
   */
  async propose(input: Omit<MemoryChange, 'id' | 'createdAt'>): Promise<MemoryChange> {
    const waiting = await this.pending();
    const same = waiting.find(
      (c) =>
        c.action === input.action &&
        c.memoryId === input.memoryId &&
        c.scope === input.scope &&
        c.botId === input.botId &&
        (c.place ?? null) === (input.place ?? null) &&
        (c.userId ?? null) === (input.userId ?? null) &&
        c.site === input.site &&
        noteKey(c.content) === noteKey(input.content),
    );
    if (same) return same;
    const [row] = await this.ctx.db
      .insert(schema.memoryChanges)
      .values({
        id: newId(),
        ...input,
        // A bot's private token is never kept in a note, whatever asked for it.
        content: scrubCanary(input.content),
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
      })
      .returning();
    this.ctx.bus.refresh({ scope: 'memory' });
    return toMemoryChange(row!);
  }

  /**
   * The memory changes waiting, oldest first; with `reach`, those one person decides on: changes
   * to their own notes, and to the notes of bots they may change.
   */
  async pending(reach?: MemoryReach): Promise<MemoryChange[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.memoryChanges)
      .orderBy(asc(schema.memoryChanges.createdAt));
    return rows.map(toMemoryChange).filter((c) => !reach || decides(reach, c));
  }

  /**
   * Makes a waiting change, as the bot asked for it (or with the person's own words for a note
   * they edited before accepting). The note an update or forget was about may be gone by now;
   * then there is nothing left to do.
   */
  async accept(id: string, content?: string): Promise<void> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.memoryChanges)
      .where(eq(schema.memoryChanges.id, id));
    if (!row) throw notFound('memory');
    const words = content?.trim() || row.content;
    const actor = `bot:${row.proposedBy}`;
    // A flag waiting on this change is settled by it first: the note's change below would
    // otherwise read as someone else's and drop the change as stale (see `settleNoteFlags`).
    await settleChangeFlags(this.ctx.db, id, true);
    if (row.action === 'write') {
      const note = {
        scope: row.scope,
        botId: row.botId,
        userId: row.scope === 'user' ? (row.userId ?? OWNER_ID) : null,
        place: row.place,
        content: words,
        site: row.site,
      };
      if (!(await this.findSame(note)))
        await this.create({
          ...note,
          source: actor,
          threadId: row.threadId,
          sourceUrl: row.sourceUrl,
          validUntil: row.validUntil?.toISOString() ?? null,
        });
    } else if (row.memoryId) {
      const exists = await this.get(row.memoryId).then(
        () => true,
        () => false,
      );
      if (exists && row.action === 'update')
        await this.update(
          row.memoryId,
          {
            content: words,
            // The person said yes to these words.
            unverified: false,
            ...sourceOf(row),
            ...(row.validUntil && { validUntil: row.validUntil.toISOString() }),
          },
          actor,
        );
      if (exists && row.action === 'forget') await this.remove(row.memoryId, actor);
    }
    await this.ctx.db.delete(schema.memoryChanges).where(eq(schema.memoryChanges.id, id));
    this.ctx.bus.refresh({ scope: 'memory' });
  }

  async reject(id: string): Promise<void> {
    await this.ctx.db.delete(schema.memoryChanges).where(eq(schema.memoryChanges.id, id));
    await settleChangeFlags(this.ctx.db, id, false);
    this.ctx.bus.refresh({ scope: 'memory' });
  }

  async get(id: string): Promise<Memory> {
    const [row] = await this.ctx.db.select().from(schema.memories).where(eq(schema.memories.id, id)).limit(1);
    if (!row) throw notFound('memory');
    return toMemory(row);
  }

  async create(input: {
    scope: MemoryScope;
    botId: string | null;
    /** Whose note about themselves it is; the owner's when not said. */
    userId?: string | null;
    /** For a room note, the place it is about. */
    place?: string | null;
    content: string;
    source: string;
    /** Who wrote it, for the history, when that is not `source` (a person's id, for a note by hand). */
    actor?: string;
    site?: string | null;
    /** The conversation the bot wrote it in, and the page the fact came from. */
    threadId?: string | null;
    sourceUrl?: string | null;
    /** Until when the note is true, as an ISO time; none when not said. */
    validUntil?: string | null;
    /** A bot wrote it with outside text in its conversation (see `memories.unverified`). */
    unverified?: boolean;
  }): Promise<Memory> {
    if (input.scope === 'bot' && !input.botId) throw new HttpError(400, 'error.memoryNeedsBot');
    if (input.scope === 'common' && (await this.commonCount()) >= COMMON_NOTES)
      throw new HttpError(400, 'error.memoryCommonFull', { max: COMMON_NOTES });
    if (input.scope === 'room') {
      if (!input.place) throw new HttpError(400, 'error.memoryNeedsPlace');
      if ((await this.roomCount(input.place)) >= ROOM_NOTES_PER_PLACE)
        throw new HttpError(400, 'error.memoryRoomFull', { max: ROOM_NOTES_PER_PLACE });
    }
    const [row] = await this.ctx.db
      .insert(schema.memories)
      .values({
        id: newId(),
        scope: input.scope,
        botId: input.scope === 'bot' ? input.botId : null,
        userId: input.scope === 'user' ? (input.userId ?? OWNER_ID) : null,
        place: input.scope === 'room' ? input.place : null,
        content: scrubCanary(input.content),
        site: input.site ?? null,
        source: input.source,
        threadId: input.threadId ?? null,
        sourceUrl: input.sourceUrl ?? null,
        validUntil: input.validUntil ? new Date(input.validUntil) : null,
        unverified: input.unverified ?? false,
      })
      .returning();
    await this.log(row!.id, 'create', null, row!.content, input.actor ?? input.source, noteOwner(row!));
    this.ctx.bus.refresh({ scope: 'memory' });
    this.embeddings?.soon();
    return toMemory(row!);
  }

  /**
   * The places whose notes a person reaches: the rooms that are theirs and, for those who manage
   * the server, every chat app channel that has notes or changes waiting. (The history of a channel
   * whose notes are all gone is reached through `MemoryReach.managesServer`, not looked up here:
   * this runs on every request, and the history is far longer than the notes.)
   */
  async placesFor(userId: string, managesServer: boolean): Promise<string[]> {
    const rooms = await this.ctx.db
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(and(eq(schema.threads.kind, 'room'), eq(schema.threads.userId, userId)));
    const places = new Set(rooms.map((r) => `room:${r.id}`));
    if (managesServer) {
      const apps = (col: typeof schema.memories.place | typeof schema.memoryChanges.place) =>
        or(like(col, 'slack:%'), like(col, 'discord:%'))!;
      const [notes, waiting] = await Promise.all([
        this.ctx.db
          .selectDistinct({ p: schema.memories.place })
          .from(schema.memories)
          .where(apps(schema.memories.place)),
        this.ctx.db
          .selectDistinct({ p: schema.memoryChanges.place })
          .from(schema.memoryChanges)
          .where(apps(schema.memoryChanges.place)),
      ]);
      for (const r of [...notes, ...waiting]) if (r.p) places.add(r.p);
    }
    return [...places];
  }

  /** How many notes there are for every bot. */
  async commonCount(): Promise<number> {
    const [row] = await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.memories)
      .where(eq(schema.memories.scope, 'common'));
    return row?.n ?? 0;
  }

  /** How many notes a place keeps. */
  async roomCount(place: string): Promise<number> {
    const [row] = await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.memories)
      .where(placeNotes(place));
    return row?.n ?? 0;
  }

  /**
   * Refuses a pin that would put more pinned text in the prompt than `PINNED_MEMORY_CHARS` allows.
   * The count is per owner (one person's, one bot's, one place's pinned notes), as each of them
   * goes into the prompt as a group; `words` is what the note would hold.
   */
  private async checkPinned(note: Memory, words: string) {
    const owner =
      note.scope === 'user'
        ? and(eq(schema.memories.scope, 'user'), eq(schema.memories.userId, note.userId ?? OWNER_ID))
        : note.scope === 'room'
          ? placeNotes(note.place ?? null)
          : note.scope === 'common'
            ? eq(schema.memories.scope, 'common')
            : and(eq(schema.memories.scope, 'bot'), eq(schema.memories.botId, note.botId ?? ''));
    const rows = await this.ctx.db
      .select({ id: schema.memories.id, content: schema.memories.content })
      .from(schema.memories)
      .where(and(owner, eq(schema.memories.pinned, true), isNull(schema.memories.site)));
    // Three characters a note: the bullet and the date the prompt adds.
    const used =
      rows.filter((r) => r.id !== note.id).reduce((n, r) => n + r.content.length + 3, 0) + words.length + 3;
    if (used > PINNED_MEMORY_CHARS)
      throw new HttpError(400, 'error.memoryPinnedFull', { max: PINNED_MEMORY_CHARS });
  }

  /**
   * Changes a note's words, whether it is pinned, or both. A bot's change also says where it
   * learned the new words; the person's own edit leaves that as it was. With `expectedUpdatedAt`,
   * the change is refused when the note was changed since that version, so a screen that was left
   * open cannot write over newer words. A date to be true until is no change of the words either:
   * it leaves `updatedAt` and the history as they were. Pinning is the person's own act and not a change of the
   * words: it adds a line to the history without text and leaves `updatedAt` as it was.
   */
  async update(
    id: string,
    patch: {
      content?: string;
      pinned?: boolean;
      threadId?: string | null;
      sourceUrl?: string | null;
      /** An ISO time the note is true until; null takes the end away. */
      validUntil?: string | null;
      expectedUpdatedAt?: string;
      /**
       * Whether it is marked as written from outside text; left out, the mark stays as it was. Like
       * a pin, no change of the words: `updatedAt` stays, the date the prompt gives the fact.
       */
      unverified?: boolean;
    },
    actor: string,
  ): Promise<Memory> {
    const before = await this.get(id);
    if (
      patch.expectedUpdatedAt &&
      new Date(patch.expectedUpdatedAt).getTime() !== new Date(before.updatedAt).getTime()
    ) {
      throw new HttpError(409, 'error.memoryChanged');
    }
    const { expectedUpdatedAt: _seen, content: written, pinned, validUntil, unverified, ...source } = patch;
    const content = written === undefined ? undefined : scrubCanary(written);
    const nowPinned = pinned ?? !!before.pinned;
    if (
      nowPinned &&
      !before.site &&
      (pinned === true || (content !== undefined && content !== before.content))
    ) {
      await this.checkPinned(before, content ?? before.content);
    }
    const [row] = await this.ctx.db
      .update(schema.memories)
      .set({
        ...(content !== undefined && { content, ...source, updatedAt: new Date() }),
        ...(pinned !== undefined && { pinned }),
        ...(unverified !== undefined && { unverified }),
        // A date is no change of the words, so `updatedAt` stays; the history line says it happened.
        ...(validUntil !== undefined && { validUntil: validUntil ? new Date(validUntil) : null }),
      })
      .where(eq(schema.memories.id, id))
      .returning();
    const owner = noteOwner(before);
    if (content !== undefined) await this.log(id, 'update', before.content, row!.content, actor, owner);
    if (content !== undefined && content !== before.content) await settleNoteFlags(this.ctx.db, [id]);
    if (pinned !== undefined && pinned !== !!before.pinned)
      await this.log(id, pinned ? 'pin' : 'unpin', null, null, actor, owner);
    this.ctx.bus.refresh({ scope: 'memory' });
    if (content !== undefined) this.embeddings?.soon();
    return toMemory(row!);
  }

  async remove(id: string, actor: string) {
    await this.get(id);
    await this.removeWhere(eq(schema.memories.id, id), actor);
  }

  /**
   * Deletes every note a bot keeps for itself, in one go. Notes of an archived bot reach no other
   * bot, so this is how a long list left behind (an import, say) goes away. Each note still gets
   * its own line in the history.
   */
  async removeForBot(botId: string, actor: string): Promise<{ count: number }> {
    return this.removeWhere(and(eq(schema.memories.scope, 'bot'), eq(schema.memories.botId, botId))!, actor);
  }

  /** Deletes the notes of `ids` in one go, each with its own line in the history. */
  async removeMany(ids: string[], actor: string): Promise<{ count: number }> {
    if (!ids.length) return { count: 0 };
    return this.removeWhere(inArray(schema.memories.id, ids), actor);
  }

  /**
   * Everything a place kept, gone with the place (a room deleted): its notes, the changes waiting
   * for them and their history. Nobody could reach them any more, so none of their words stay.
   */
  async removePlace(place: string): Promise<void> {
    await this.ctx.db.transaction(async (tx) => {
      const notes = await tx
        .select({ id: schema.memories.id })
        .from(schema.memories)
        .where(and(eq(schema.memories.scope, 'room'), eq(schema.memories.place, place)));
      if (notes.length)
        await tx.delete(schema.turnChanges).where(
          and(
            eq(schema.turnChanges.kind, 'memory'),
            inArray(
              schema.turnChanges.targetId,
              notes.map((n) => n.id),
            ),
          ),
        );
      await tx
        .delete(schema.memories)
        .where(and(eq(schema.memories.scope, 'room'), eq(schema.memories.place, place)));
      await tx.delete(schema.memoryChanges).where(eq(schema.memoryChanges.place, place));
      await tx
        .delete(schema.auditLog)
        .where(and(eq(schema.auditLog.targetType, 'memory'), eq(schema.auditLog.owner, `room:${place}`)));
    });
    this.ctx.bus.refresh({ scope: 'memory' });
  }

  /**
   * Deletes the notes `where` picks. A deleted note really is forgotten: its line in the history
   * says who deleted it and when, but holds no words, and every earlier line of the note loses
   * its words too (the lines stay, so the history still shows that the note existed).
   */
  private async removeWhere(where: SQL, actor: string): Promise<{ count: number }> {
    // Read first: a flag about a note keeps no link to it once it is gone.
    const going = await this.ctx.db.select({ id: schema.memories.id }).from(schema.memories).where(where);
    await settleNoteFlags(
      this.ctx.db,
      going.map((m) => m.id),
    );
    const rows = await this.ctx.db.transaction(async (tx) => {
      const gone = await tx.delete(schema.memories).where(where).returning();
      if (gone.length) {
        await tx
          .update(schema.auditLog)
          .set({ before: null, after: null })
          .where(
            and(
              eq(schema.auditLog.targetType, 'memory'),
              inArray(
                schema.auditLog.targetId,
                gone.map((m) => m.id),
              ),
            ),
          );
        // The turn journal keeps notes' earlier words too, so a forgotten note goes from it as well.
        await tx
          .update(schema.turnChanges)
          .set({ before: null, label: '' })
          .where(
            and(
              eq(schema.turnChanges.kind, 'memory'),
              inArray(
                schema.turnChanges.targetId,
                gone.map((m) => m.id),
              ),
            ),
          );
        await tx.insert(schema.auditLog).values(
          gone.map((m) => ({
            id: newId(),
            actor,
            action: 'delete',
            targetType: 'memory',
            targetId: m.id,
            before: null,
            after: null,
            owner: noteOwner(m),
          })),
        );
      }
      return gone;
    });
    if (rows.length) this.ctx.bus.refresh({ scope: 'memory' });
    return { count: rows.length };
  }

  /**
   * The latest `limit` things that happened to notes, oldest first; with `reach`, only to the
   * notes that person reaches.
   */
  async history(limit = 100, reach?: MemoryReach) {
    const owners = reach && [
      `user:${reach.userId}`,
      ...reach.botIds.map((id) => `bot:${id}`),
      ...reach.places.map((p) => `room:${p}`),
    ];
    const rows = await this.ctx.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.targetType, 'memory'),
          reach &&
            or(
              inArray(schema.auditLog.owner, owners!),
              // Lines kept before people came in were the owner's.
              reach.userId === OWNER_ID ? isNull(schema.auditLog.owner) : undefined,
              reach.managesServer ? like(schema.auditLog.owner, 'room:slack:%') : undefined,
              reach.managesServer ? like(schema.auditLog.owner, 'room:discord:%') : undefined,
            ),
        ),
      )
      .orderBy(desc(schema.auditLog.createdAt))
      .limit(limit);
    return rows.reverse();
  }

  private async log(
    id: string,
    action: string,
    before: string | null,
    after: string | null,
    actor: string,
    owner: string,
  ) {
    await this.ctx.db.insert(schema.auditLog).values({
      id: newId(),
      actor,
      action,
      targetType: 'memory',
      targetId: id,
      before,
      after,
      owner,
    });
  }
}

/**
 * The notes no bot uses any more: none of them goes into the prompt of a bot that would see it,
 * nobody wrote or changed one in `STALE_MEMORY_DAYS` days, and no bot looked one up in that time. A note in some prompt is
 * never on the list, however old: the bot reads it on every turn, and whether that helps cannot be
 * told from here. A pinned note is never on it either: the person asked for it to stay. Site
 * notes never go into a prompt, so for them only the time counts.
 */
export function staleNotes(
  notes: Memory[],
  bots: Pick<Bot, 'id' | 'memory'>[],
  now: Date,
  budget = MEMORY_PROMPT_CHARS,
): Memory[] {
  const cutoff = new Date(now.getTime() - STALE_MEMORY_DAYS * 86_400_000).toISOString();
  const old = notes.filter((m) => !m.pinned && lastActive(m) < cutoff);
  if (!old.length) return [];
  const inPrompt = new Set<string>();
  // Each person's notes about themselves go into the prompts of bots working for them.
  const about = notes.filter((m) => m.scope === 'user' && !m.site);
  const people = [...new Set(about.map((m) => m.userId ?? null))];
  // A place's notes go into the prompt of every bot that talks there, for whoever it works for
  // (a team conversation, which has no person's notes, included).
  const places = new Map<string, Memory[]>();
  for (const m of notes) {
    if (m.scope !== 'room' || m.site || !m.place) continue;
    places.set(m.place, [...(places.get(m.place) ?? []), m]);
  }
  for (const b of bots) {
    if (!b.memory) continue;
    const own = notes.filter((m) => m.scope === 'bot' && m.botId === b.id && !m.site);
    for (const person of people.length ? people : [null]) {
      const shared = about.filter((m) => (m.userId ?? null) === person);
      const fit = withinBudget(shared, own, budget);
      for (const m of [...fit.user, ...fit.bot]) inPrompt.add(m.id);
      for (const room of places.values()) {
        const withRoom = withinBudget(shared, own, budget, room);
        for (const m of withRoom.room) inPrompt.add(m.id);
      }
    }
    for (const room of places.values())
      for (const m of withinBudget([], own, budget, room).room) inPrompt.add(m.id);
  }
  return old.filter((m) => !inPrompt.has(m.id)).sort((a, b) => lastActive(a).localeCompare(lastActive(b)));
}

/**
 * Where a bot's change to a note says the new words came from. The conversation and the page go
 * together: words changed in another conversation with no page given came from that conversation,
 * so the old page no longer stands behind them. A change that knows neither leaves both as they were.
 */
export function sourceOf(change: { threadId: string | null; sourceUrl: string | null }): {
  threadId?: string | null;
  sourceUrl?: string | null;
} {
  if (change.threadId) return { threadId: change.threadId, sourceUrl: change.sourceUrl };
  return change.sourceUrl ? { sourceUrl: change.sourceUrl } : {};
}
