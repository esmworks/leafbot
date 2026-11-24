import {
  plainText,
  type BotSummary,
  type Message,
  type MessageRole,
  type OutsideTrigger,
  type SearchHit,
  type Thread,
  type TurnState,
  quoteExcerpt,
} from '@leafbot/shared';
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  lte,
  ne,
  notLike,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { matchInServer } from '../db/sealed';
import type { T } from '../i18n';
import { DOTTED_AND_DOTLESS_I, foldText, isUniqueViolation, newId, notFound, truncate } from '../util';
import { toMessage, toThread } from './mappers';

type ThreadRow = typeof schema.threads.$inferSelect;

export interface NewMessage {
  threadId: string;
  role: MessageRole;
  author: string;
  text: string;
  props?: Record<string, unknown>;
  clientId?: string | null;
  turnId?: string | null;
  /** The person who wrote it, for a person's own message. */
  userId?: string | null;
  /**
   * A note of the server's own upkeep: the conversation keeps its place in the list and stays
   * snoozed, as nobody did anything in it.
   */
  quiet?: boolean;
}

/** How many messages a conversation opens with, and how many each "load older" adds. */
export const MESSAGE_PAGE = 500;

/**
 * Whose view a bot's conversation list is for: theirs, the bot's own work when `botWork`, and the
 * team's conversations with it when `team`.
 */
export interface ThreadScope {
  userId: string;
  botWork: boolean;
  team?: boolean;
}

/** One person's sidebar: the bots they reach, those they may change, the conversations they see. */
export interface SummaryScope {
  botIds: string[];
  editable: string[];
  seen: SQL;
  /** Of the cards in `seen`, those the viewer may answer. */
  answerable?: SQL;
}
/** Where a card asked in an exchange between bots is shown and answered. */
export interface AnswerPlace {
  threadId: string;
  botId: string;
}

/** Messages read back at a time while a search matches sealed text in the server. */
const SEARCH_PAGE = 1000;

/**
 * A message's own time, read in the database. A row's Date keeps only the milliseconds of the
 * stored microsecond time, so comparing against it would put the message after itself.
 */
const createdAtOf = (id: string) =>
  sql`(select ${schema.messages.createdAt} from ${schema.messages} where ${schema.messages.id} = ${id})`;

/**
 * The line the sidebar shows for a message. It shows words, not Markdown marks. A message with only
 * attachments is previewed by its file names, and one that is only a picture by the picture's file
 * name, so it does not read as an empty row.
 */
export function previewOf(markdown: string, files: readonly { name: string }[] = []): string {
  const words = plainText(markdown);
  if (words) return words;
  if (files.length) return files.map((f) => f.name).join(', ');
  for (const m of markdown.matchAll(/!\[[^\]]*\]\(\s*<?([^)\s>]+)/g)) {
    const src = m[1]!;
    if (/^data:/i.test(src)) continue;
    const last = src.split(/[?#]/)[0]!.split('/').filter(Boolean).at(-1);
    if (!last) continue;
    try {
      return decodeURIComponent(last);
    } catch {
      return last;
    }
  }
  return '';
}

export class ThreadService {
  private mainLocks = new Map<string, Promise<void>>();
  constructor(private ctx: Ctx) {}

  /** Told of every new message once it is saved; chat apps pass on the ones meant for them. */
  private listeners: ((m: Message) => void | Promise<void>)[] = [];

  onMessage(fn: (m: Message) => void | Promise<void>): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** What each conversation's bot is doing now; a conversation at rest is left out. */
  async states(threadIds: string[]): Promise<Map<string, TurnState>> {
    const map = new Map<string, TurnState>();
    if (!threadIds.length) return map;
    const active = await this.ctx.db
      .select({ threadId: schema.turns.threadId, status: schema.turns.status })
      .from(schema.turns)
      .where(
        and(inArray(schema.turns.threadId, threadIds), inArray(schema.turns.status, ['queued', 'running'])),
      );
    for (const t of active) {
      if (t.status === 'running') map.set(t.threadId, 'running');
      else if (!map.has(t.threadId)) map.set(t.threadId, 'queued');
    }
    const waiting = await this.ctx.db
      .select({ threadId: schema.approvals.threadId })
      .from(schema.approvals)
      .where(and(inArray(schema.approvals.threadId, threadIds), eq(schema.approvals.status, 'pending')));
    for (const w of waiting) map.set(w.threadId, 'waiting');
    return map;
  }

  async state(threadId: string): Promise<TurnState> {
    return (await this.states([threadId])).get(threadId) ?? 'idle';
  }

  private async previews(threadIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!threadIds.length) return map;
    const rows = await this.ctx.db
      .selectDistinctOn([schema.messages.threadId], {
        threadId: schema.messages.threadId,
        text: schema.messages.text,
        props: schema.messages.props,
      })
      .from(schema.messages)
      .where(
        and(
          inArray(schema.messages.threadId, threadIds),
          inArray(schema.messages.role, ['user', 'assistant']),
          // A routine's instruction is its run's line, not something said: the list shows what
          // was said last, or the run's report, not the instruction.
          notLike(schema.messages.author, 'routine:%'),
        ),
      )
      .orderBy(schema.messages.threadId, desc(schema.messages.createdAt));
    for (const r of rows) {
      const files = (r.props as { files?: { name: string }[] }).files ?? [];
      map.set(r.threadId, truncate(previewOf(r.text, files), 140));
    }
    return map;
  }

  /** When each conversation last got a message from its bot. */
  private async lastReplies(threadIds: string[]): Promise<Map<string, Date>> {
    if (!threadIds.length) return new Map();
    const rows = await this.ctx.db
      .selectDistinctOn([schema.messages.threadId], {
        threadId: schema.messages.threadId,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(and(inArray(schema.messages.threadId, threadIds), eq(schema.messages.role, 'assistant')))
      .orderBy(schema.messages.threadId, desc(schema.messages.createdAt));
    return new Map(rows.map((r) => [r.threadId, r.createdAt]));
  }

  /**
   * A bot's conversations, newest first. With `scope`, only those its person sees: their own, and
   * the bot's own work when they may change the bot.
   */
  async list(botId: string, scope?: ThreadScope): Promise<Thread[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.threads)
      // A room is listed apart, not among the conversations of its first member.
      .where(
        and(
          eq(schema.threads.botId, botId),
          ne(schema.threads.kind, 'room'),
          // A rehearsal's conversation is shown from its routine, not in the list.
          ne(schema.threads.kind, 'rehearsal'),
          scope &&
            (scope.botWork
              ? or(eq(schema.threads.userId, scope.userId), isNull(schema.threads.userId))
              : scope.team
                ? or(
                    eq(schema.threads.userId, scope.userId),
                    and(eq(schema.threads.kind, 'team'), isNull(schema.threads.userId)),
                  )
                : eq(schema.threads.userId, scope.userId)),
        ),
      )
      .orderBy(desc(schema.threads.updatedAt));
    const ids = rows.map((r) => r.id);
    const [states, previews] = await Promise.all([this.states(ids), this.previews(ids)]);
    return Promise.all(
      rows.map(async (r) => ({
        ...toThread(r, states.get(r.id) ?? 'idle', previews.get(r.id) ?? null),
        pinned: await this.pinned(r),
      })),
    );
  }

  async row(id: string): Promise<ThreadRow> {
    const [row] = await this.ctx.db.select().from(schema.threads).where(eq(schema.threads.id, id)).limit(1);
    if (!row) throw notFound('thread');
    return row;
  }

  async get(id: string): Promise<Thread> {
    const row = await this.row(id);
    const [states, previews] = await Promise.all([this.states([id]), this.previews([id])]);
    return {
      ...toThread(row, states.get(id) ?? 'idle', previews.get(id) ?? null),
      pinned: await this.pinned(row),
    };
  }

  /** The pinned message of a conversation, with the start of its text; null when it has none. */
  /**
   * Where each card asked in an exchange between bots is shown. The person never opens those
   * exchanges: a card in one is answered in the conversation the work began in, the one where the
   * person (or their routine, ticket, room) asked the first bot. That is the sender of the chain's
   * first request, the same however deep the card was asked. When it is gone, the person's main
   * conversation with the bot that asked. Cards in other conversations are left out: they are
   * answered where they are.
   */
  async answerPlaces(
    cards: { id: string; threadId: string; turnId: string | null }[],
  ): Promise<Map<string, AnswerPlace>> {
    const places = new Map<string, AnswerPlace>();
    if (!cards.length) return places;
    const exchanges = await this.ctx.db
      .select()
      .from(schema.threads)
      .where(
        and(
          inArray(schema.threads.id, [...new Set(cards.map((c) => c.threadId))]),
          eq(schema.threads.kind, 'bot'),
        ),
      );
    if (!exchanges.length) return places;
    const exchangeOf = new Map(exchanges.map((r) => [r.id, r]));
    const inExchange = cards.filter((c) => exchangeOf.has(c.threadId));
    // The card's turn ran for a request (or read the answer of one it made); every request of a
    // chain carries the chain's root.
    const turnIds = [...new Set(inExchange.map((c) => c.turnId).filter((id): id is string => !!id))];
    const turns = turnIds.length
      ? await this.ctx.db
          .select({ id: schema.turns.id, jobId: schema.turns.jobId })
          .from(schema.turns)
          .where(inArray(schema.turns.id, turnIds))
      : [];
    const jobOfTurn = new Map(turns.map((r) => [r.id, r.jobId]));
    const jobIds = [...new Set(turns.map((r) => r.jobId).filter((id): id is string => !!id))];
    const jobs = jobIds.length
      ? await this.ctx.db
          .select({ id: schema.jobs.id, rootId: schema.jobs.rootId })
          .from(schema.jobs)
          .where(inArray(schema.jobs.id, jobIds))
      : [];
    const rootOfJob = new Map(jobs.map((r) => [r.id, r.rootId]));
    const rootIds = [...new Set(jobs.map((r) => r.rootId))];
    const firsts = rootIds.length
      ? await this.ctx.db
          .select({
            rootId: schema.jobs.rootId,
            fromBotId: schema.jobs.fromBotId,
            fromThreadId: schema.jobs.fromThreadId,
          })
          .from(schema.jobs)
          .where(and(inArray(schema.jobs.rootId, rootIds), eq(schema.jobs.depth, 1)))
      : [];
    const firstOf = new Map(firsts.map((r) => [r.rootId, r]));
    // The sender's conversation has no foreign key: it may be gone.
    const fromIds = [...new Set(firsts.map((r) => r.fromThreadId))];
    const froms = fromIds.length
      ? await this.ctx.db
          .select({ id: schema.threads.id, botId: schema.threads.botId, kind: schema.threads.kind })
          .from(schema.threads)
          .where(inArray(schema.threads.id, fromIds))
      : [];
    const fromOf = new Map(froms.map((r) => [r.id, r]));
    for (const card of inExchange) {
      const exchange = exchangeOf.get(card.threadId)!;
      const jobId = card.turnId ? jobOfTurn.get(card.turnId) : null;
      const rootId = jobId ? rootOfJob.get(jobId) : undefined;
      const first = rootId ? firstOf.get(rootId) : undefined;
      const from = first ? fromOf.get(first.fromThreadId) : undefined;
      if (from && from.kind !== 'bot') {
        places.set(card.id, { threadId: from.id, botId: from.botId });
        continue;
      }
      const asker = first?.fromBotId ?? exchange.peerBotId;
      if (!asker || !exchange.userId) continue;
      const main = await this.main(asker, exchange.userId).catch(() => null);
      if (main) places.set(card.id, { threadId: main.id, botId: asker });
    }
    return places;
  }

  /** The props of each card's own line in its conversation, by card. */
  async cardLines(cards: { id: string; threadId: string }[]): Promise<Map<string, Record<string, unknown>>> {
    if (!cards.length) return new Map();
    const rows = await this.ctx.db
      .select({ props: schema.messages.props })
      .from(schema.messages)
      .where(
        and(
          inArray(schema.messages.threadId, [...new Set(cards.map((c) => c.threadId))]),
          eq(schema.messages.role, 'approval'),
          inArray(
            sql`${schema.messages.props}->>'approvalId'`,
            cards.map((c) => c.id),
          ),
        ),
      );
    return new Map(rows.map((r) => [String((r.props as { approvalId?: unknown }).approvalId), r.props]));
  }

  private async pinned(row: ThreadRow): Promise<Thread['pinned']> {
    if (!row.pinnedMessageId) return null;
    const [m] = await this.ctx.db
      .select({ id: schema.messages.id, text: schema.messages.text, threadId: schema.messages.threadId })
      .from(schema.messages)
      .where(eq(schema.messages.id, row.pinnedMessageId))
      .limit(1);
    return m && m.threadId === row.id ? { id: m.id, text: quoteExcerpt(m.text, 160) } : null;
  }

  /** Pins a message of the conversation above it, or with null takes the pin away. */
  async pin(threadId: string, messageId: string | null) {
    const row = await this.row(threadId);
    if (messageId) {
      const m = await this.message(messageId);
      if (m.threadId !== threadId) throw notFound('message');
    }
    await this.ctx.db
      .update(schema.threads)
      .set({ pinnedMessageId: messageId })
      .where(eq(schema.threads.id, threadId));
    this.ctx.bus.refresh({ scope: 'threads', botId: row.botId });
  }

  /** A new conversation; `userId` names the person it is with, null for the bot's own work. */
  async create(
    botId: string,
    opts: { title?: string; kind?: ThreadRow['kind']; userId: string | null },
  ): Promise<Thread> {
    const [row] = await this.ctx.db
      .insert(schema.threads)
      .values({
        id: newId(),
        botId,
        title: opts.title ?? '',
        kind: opts.kind ?? 'user',
        userId: opts.userId,
      })
      .returning();
    this.ctx.bus.refresh({ scope: 'threads', botId });
    return toThread(row!, 'idle');
  }

  /**
   * A person's most recent conversation with the bot, created if missing. Calls for the same bot
   * and person wait for each other, so two arriving at once do not each make one.
   */
  main(botId: string, userId: string): Promise<Thread> {
    const key = `${botId}:${userId}`;
    const before = this.mainLocks.get(key) ?? Promise.resolve();
    const run = before.catch(() => {}).then(() => this.findOrCreateMain(botId, userId));
    const settled = run.then(
      () => {},
      () => {},
    );
    this.mainLocks.set(key, settled);
    void settled.then(() => {
      if (this.mainLocks.get(key) === settled) this.mainLocks.delete(key);
    });
    return run;
  }

  private async findOrCreateMain(botId: string, userId: string): Promise<Thread> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.threads)
      .where(
        and(
          eq(schema.threads.botId, botId),
          eq(schema.threads.kind, 'user'),
          eq(schema.threads.userId, userId),
        ),
      )
      // An archived or snoozed conversation is the main one only when every one is put away.
      .orderBy(
        sql`${schema.threads.archivedAt} is not null`,
        sql`coalesce(${schema.threads.snoozedUntil} > now(), false)`,
        desc(schema.threads.updatedAt),
      )
      .limit(1);
    if (row) return this.get(row.id);
    return this.create(botId, { userId });
  }

  /**
   * The conversation a rehearsal of a routine works in, `userId`'s own and in no list: a new one
   * each time, removed after a week with the rehearsal.
   */
  async rehearsalThread(botId: string, title: string, userId: string): Promise<ThreadRow> {
    const [row] = await this.ctx.db
      .insert(schema.threads)
      .values({ id: newId(), botId, userId, kind: 'rehearsal', title })
      .returning();
    return row!;
  }

  /** The thread in `botId` where messages from `peerBotId` land; one per pair and person. */
  async peerThread(botId: string, peerBotId: string, userId: string): Promise<ThreadRow> {
    const find = async () => {
      const [row] = await this.ctx.db
        .select()
        .from(schema.threads)
        .where(
          and(
            eq(schema.threads.botId, botId),
            eq(schema.threads.peerBotId, peerBotId),
            eq(schema.threads.kind, 'bot'),
            eq(schema.threads.userId, userId),
          ),
        )
        .limit(1);
      return row;
    };
    const existing = await find();
    if (existing) return existing;
    try {
      const [row] = await this.ctx.db
        .insert(schema.threads)
        .values({ id: newId(), botId, peerBotId, userId, kind: 'bot', title: '' })
        .returning();
      this.ctx.bus.refresh({ scope: 'threads', botId });
      return row!;
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      return (await find())!;
    }
  }

  /**
   * The thread a routine's runs post into (one per routine), `userId`'s own. One kept from before
   * becomes theirs; one of someone else's, from before the routine changed hands, is left to them.
   */
  async routineThread(
    botId: string,
    routineName: string,
    existingId: string | null,
    userId: string,
  ): Promise<ThreadRow> {
    if (existingId) {
      const [row] = await this.ctx.db
        .select()
        .from(schema.threads)
        .where(eq(schema.threads.id, existingId))
        .limit(1);
      if (row?.userId === userId) return row;
      if (row && !row.userId) {
        const [adopted] = await this.ctx.db
          .update(schema.threads)
          .set({ userId })
          .where(eq(schema.threads.id, row.id))
          .returning();
        this.ctx.bus.refresh({ scope: 'threads', botId });
        return adopted!;
      }
    }
    const [row] = await this.ctx.db
      .insert(schema.threads)
      .values({ id: newId(), botId, userId, kind: 'routine', title: routineName })
      .returning();
    this.ctx.bus.refresh({ scope: 'threads', botId });
    return row!;
  }

  /**
   * A new conversation that starts as a copy of another up to and including one of its messages:
   * the person's and the bot's messages, in their order and with their times. It has no engine
   * session, so its first turn hands the bot the copied exchange.
   */
  async fork(messageId: string, title: string, userId: string): Promise<Thread> {
    const at = await this.message(messageId);
    const source = await this.row(at.threadId);
    // The copy is the person's own, even of the bot's own work they may read.
    const created = await this.create(source.botId, { title, userId });
    const rows = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, source.id),
          inArray(schema.messages.role, ['user', 'assistant']),
          lte(schema.messages.createdAt, createdAtOf(at.id)),
        ),
      )
      .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));
    if (rows.length) {
      await this.ctx.db.insert(schema.messages).values(
        rows.map((r) => ({
          ...r,
          id: newId(),
          threadId: created.id,
          clientId: null,
          turnId: null,
          props: { ...r.props, forkedFrom: r.id },
        })),
      );
    }
    this.ctx.bus.refresh({ scope: 'threads', botId: source.botId });
    return this.get(created.id);
  }

  async archive(id: string, archived: boolean) {
    const row = await this.row(id);
    await this.ctx.db
      .update(schema.threads)
      .set({ archivedAt: archived ? new Date() : null })
      .where(eq(schema.threads.id, id));
    this.ctx.bus.refresh({ scope: 'threads', botId: row.botId });
  }

  /** Takes a conversation out of the list until `until`, or until a new message; null brings it back. */
  async snooze(id: string, until: Date | null) {
    const row = await this.row(id);
    await this.ctx.db.update(schema.threads).set({ snoozedUntil: until }).where(eq(schema.threads.id, id));
    this.ctx.bus.refresh({ scope: 'threads', botId: row.botId });
  }

  /** Keeps a conversation at the top of the list, or lets it take its place by date again. */
  async pinInList(id: string, pinned: boolean) {
    const row = await this.row(id);
    await this.ctx.db
      .update(schema.threads)
      .set({ pinnedAt: pinned ? new Date() : null })
      .where(eq(schema.threads.id, id));
    this.ctx.bus.refresh({ scope: 'threads', botId: row.botId });
  }

  /** The emoji that marks the conversation in the list; '' takes it off. */
  async setIcon(id: string, icon: string) {
    const row = await this.row(id);
    await this.ctx.db.update(schema.threads).set({ icon }).where(eq(schema.threads.id, id));
    this.ctx.bus.refresh({ scope: 'threads', botId: row.botId });
  }

  async setGoal(id: string, goal: string) {
    const row = await this.row(id);
    await this.ctx.db.update(schema.threads).set({ goal }).where(eq(schema.threads.id, id));
    this.ctx.bus.refresh({ scope: 'threads', botId: row.botId });
  }

  /** `auto`: made from the first message's words, so a model may name the conversation better later. */
  async rename(id: string, title: string, auto = false) {
    const row = await this.row(id);
    await this.ctx.db.update(schema.threads).set({ title, titleAuto: auto }).where(eq(schema.threads.id, id));
    this.ctx.bus.refresh({ scope: 'threads', botId: row.botId });
  }

  async remove(id: string) {
    const row = await this.row(id);
    await this.ctx.db.delete(schema.threads).where(eq(schema.threads.id, id));
    this.ctx.bus.refresh({ scope: 'threads', botId: row.botId });
  }

  /**
   * Starts the conversation afresh for the bot: its next turn opens a new session and is handed
   * nothing from before this point. The messages stay on screen, under a line that says so.
   */
  async resetContext(id: string, t: T) {
    const thread = await this.row(id);
    await this.setSession(id, null);
    await this.addMessage({
      threadId: thread.id,
      role: 'system',
      author: 'system',
      text: t('thread.contextReset'),
      props: { kind: 'contextReset' },
    });
    for (const fn of this.resetListeners) void Promise.resolve(fn(thread.id)).catch(() => {});
  }

  private resetListeners: ((threadId: string) => void | Promise<void>)[] = [];

  /** Told when a conversation was reset, once the line saying so is in; the memory review looks back at it. */
  onContextReset(fn: (threadId: string) => void | Promise<void>) {
    this.resetListeners.push(fn);
  }

  async setSession(id: string, sessionId: string | null) {
    await this.ctx.db
      .update(schema.threads)
      .set({
        engineSessionId: sessionId,
        // A session that ends takes the outside text it had read with it.
        ...(sessionId === null && {
          engineSessionCostUsd: null,
          engineSessionTokens: null,
          outsideSession: null,
        }),
      })
      .where(eq(schema.threads.id, id));
  }

  /** What outside text the thread's engine session has read; see `threads.outsideSession`. */
  async setOutsideSession(id: string, outside: OutsideTrigger | null) {
    await this.ctx.db
      .update(schema.threads)
      .set({ outsideSession: outside })
      .where(eq(schema.threads.id, id));
  }

  /** What the thread's engine session had cost by its last run. */
  /** How full the session's context is now, for folding a long one while it is idle. */
  async setSessionTokens(id: string, tokens: number | null) {
    await this.ctx.db
      .update(schema.threads)
      .set({ engineSessionTokens: tokens })
      .where(eq(schema.threads.id, id));
  }

  async setSessionCost(id: string, costUsd: number) {
    await this.ctx.db
      .update(schema.threads)
      .set({ engineSessionCostUsd: costUsd })
      .where(eq(schema.threads.id, id));
  }

  /** The latest `limit` messages, oldest first; with `before`, the ones just older than that message. */
  async messages(threadId: string, opts: { limit?: number; before?: string } = {}): Promise<Message[]> {
    const limit = opts.limit ?? MESSAGE_PAGE;
    const edge = opts.before ? await this.message(opts.before) : null;
    if (edge && edge.threadId !== threadId) throw notFound('message');
    const at = edge ? createdAtOf(edge.id) : null;
    const rows = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, threadId),
          at && edge
            ? or(
                lt(schema.messages.createdAt, at),
                and(eq(schema.messages.createdAt, at), lt(schema.messages.id, edge.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
      .limit(limit);
    return this.withRunStatus(rows.reverse().map(toMessage));
  }

  /**
   * A routine's instruction is drawn as its run's line, which shows how the run stands: the run's
   * status goes with it as `routineRunStatus`, read when the messages are, so a run that ended in
   * any way is drawn so without each ending having to write it there.
   */
  private async withRunStatus(messages: Message[]): Promise<Message[]> {
    const ids = [
      ...new Set(
        messages
          .filter((m) => m.author.startsWith('routine:') && typeof m.props.routineRunId === 'string')
          .map((m) => m.props.routineRunId as string),
      ),
    ];
    if (!ids.length) return messages;
    const runs = await this.ctx.db
      .select({ id: schema.routineRuns.id, status: schema.routineRuns.status })
      .from(schema.routineRuns)
      .where(inArray(schema.routineRuns.id, ids));
    const status = new Map(runs.map((r) => [r.id, r.status]));
    return messages.map((m) => {
      const s = typeof m.props.routineRunId === 'string' ? status.get(m.props.routineRunId) : undefined;
      return s && m.author.startsWith('routine:') ? { ...m, props: { ...m.props, routineRunStatus: s } } : m;
    });
  }

  /** Up to `limit` messages right after `id` in its conversation, oldest first. */
  async messagesAfter(threadId: string, id: string, limit: number): Promise<Message[]> {
    if (limit <= 0) return [];
    const edge = await this.message(id);
    const at = createdAtOf(edge.id);
    const rows = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, threadId),
          or(
            gt(schema.messages.createdAt, at),
            and(eq(schema.messages.createdAt, at), gt(schema.messages.id, edge.id)),
          ),
        ),
      )
      .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id))
      .limit(limit);
    return this.withRunStatus(rows.map(toMessage));
  }

  async message(id: string): Promise<Message> {
    const [row] = await this.ctx.db.select().from(schema.messages).where(eq(schema.messages.id, id)).limit(1);
    if (!row) throw notFound('message');
    return toMessage(row);
  }

  /**
   * Messages of the person and the bots that hold `query`, newest first, with the text around the
   * match. Archived bots are left out.
   */
  /** Messages that contain `query`, newest first; with `threadId`, only that conversation's. */
  async search(
    query: string,
    opts: {
      threadId?: string;
      botId?: string;
      limit?: number;
      seen?: SQL;
      /** Leaves out exchanges between bots, which the person reads only where the work began. */
      noExchanges?: boolean;
    } = {},
  ): Promise<SearchHit[]> {
    const limit = opts.limit ?? 30;
    // A phrase the text breaks over two lines is still found: spaces and line breaks count as one.
    const q = query.trim().replace(/\s+/g, ' ');
    if (q.length < 2) return [];
    // The database folds case for most letters but reads I as i, never as the dotless ı: both
    // sides take ı and İ as i, so "ığdır" finds "Iğdır".
    const pattern = `%${q.replace(/[ıİ]/g, 'i').replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    // Sealed text cannot be matched in the database: it is read back page by page, newest first,
    // opened and matched here, until enough is found or nothing is left.
    const inServer = matchInServer();
    const page = (offset: number, size: number) =>
      this.ctx.db
        .select({
          id: schema.messages.id,
          threadId: schema.messages.threadId,
          role: schema.messages.role,
          author: schema.messages.author,
          text: schema.messages.text,
          createdAt: schema.messages.createdAt,
          botId: schema.threads.botId,
          title: schema.threads.title,
          kind: schema.threads.kind,
        })
        .from(schema.messages)
        .innerJoin(schema.threads, eq(schema.threads.id, schema.messages.threadId))
        .innerJoin(schema.bots, eq(schema.bots.id, schema.threads.botId))
        .where(
          and(
            inArray(schema.messages.role, ['user', 'assistant']),
            isNull(schema.bots.archivedAt),
            // What a rehearsal wrote is not something the person said or was told.
            ne(schema.threads.kind, 'rehearsal'),
            opts.noExchanges ? ne(schema.threads.kind, 'bot') : undefined,
            opts.threadId ? eq(schema.messages.threadId, opts.threadId) : undefined,
            opts.botId ? eq(schema.threads.botId, opts.botId) : undefined,
            opts.seen,
            inServer
              ? undefined
              : sql`translate(regexp_replace(${schema.messages.text}, '[[:space:]]+', ' ', 'g'), ${DOTTED_AND_DOTLESS_I}, 'ii') ilike ${pattern}`,
          ),
        )
        .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
        .limit(size)
        .offset(offset);
    let rows: Awaited<ReturnType<typeof page>> = [];
    if (!inServer) rows = await page(0, limit);
    else {
      const needle = foldText(q);
      for (let offset = 0; rows.length < limit; offset += SEARCH_PAGE) {
        const found = await page(offset, SEARCH_PAGE);
        rows.push(...found.filter((r) => foldText(r.text).includes(needle)));
        if (found.length < SEARCH_PAGE) break;
      }
      rows = rows.slice(0, limit);
    }
    return rows.map((r) => ({
      messageId: r.id,
      threadId: r.threadId,
      botId: r.botId,
      threadTitle: r.title,
      threadKind: r.kind,
      role: r.role as 'user' | 'assistant',
      author: r.author,
      excerpt: excerptAround(r.text, q),
      createdAt: r.createdAt.toISOString(),
    }));
  }

  /** The message the client already sent under this id, if any. */
  async byClientId(threadId: string, clientId: string): Promise<Message | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.threadId, threadId), eq(schema.messages.clientId, clientId)))
      .limit(1);
    return row ? toMessage(row) : null;
  }

  /** Insert a message. With a clientId, a repeat insert returns the existing message (idempotent send). */
  async addMessage(m: NewMessage): Promise<{ message: Message; created: boolean }> {
    if (m.clientId) {
      const [existing] = await this.ctx.db
        .select()
        .from(schema.messages)
        .where(and(eq(schema.messages.threadId, m.threadId), eq(schema.messages.clientId, m.clientId)))
        .limit(1);
      if (existing) return { message: toMessage(existing), created: false };
    }
    try {
      const [row] = await this.ctx.db
        .insert(schema.messages)
        .values({
          id: newId(),
          threadId: m.threadId,
          role: m.role,
          author: m.author,
          text: m.text,
          props: m.props ?? {},
          clientId: m.clientId ?? null,
          turnId: m.turnId ?? null,
          userId: m.userId ?? null,
          // Distinct, ordered timestamps even within one millisecond.
          createdAt: sql`clock_timestamp()`,
        })
        .returning();
      const thread = await this.row(m.threadId);
      // What the person writes brings an archived conversation back to the list; a bot's reply or
      // a routine's run there leaves it archived until the person unarchives it.
      if (!m.quiet) {
        await this.ctx.db
          .update(schema.threads)
          // Any new message wakes a snoozed conversation.
          .set({ updatedAt: new Date(), snoozedUntil: null, ...(m.role === 'user' && { archivedAt: null }) })
          .where(eq(schema.threads.id, m.threadId));
      }
      this.ctx.bus.refresh({ scope: 'thread', threadId: m.threadId, botId: thread.botId });
      const message = toMessage(row!);
      for (const l of this.listeners) {
        void Promise.resolve()
          .then(() => l(message))
          .catch((err: unknown) => console.warn('message listener', err));
      }
      return { message, created: true };
    } catch (err) {
      if (m.clientId && isUniqueViolation(err)) {
        const [existing] = await this.ctx.db
          .select()
          .from(schema.messages)
          .where(and(eq(schema.messages.threadId, m.threadId), eq(schema.messages.clientId, m.clientId)))
          .limit(1);
        if (existing) return { message: toMessage(existing), created: false };
      }
      throw err;
    }
  }

  /** The person's message a turn answers is no longer waiting once the turn starts. */
  async startedOn(turnId: string, threadId: string) {
    const rows = await this.ctx.db
      .update(schema.messages)
      .set({ props: sql`${schema.messages.props} - 'queued'` })
      .where(
        and(
          eq(schema.messages.threadId, threadId),
          eq(schema.messages.turnId, turnId),
          sql`${schema.messages.props} ? 'queued'`,
        ),
      )
      .returning({ id: schema.messages.id });
    if (!rows.length) return;
    const thread = await this.row(threadId);
    this.ctx.bus.refresh({ scope: 'thread', threadId, botId: thread.botId });
  }

  /** Marks a waiting message as being handed to the running turn, or no longer. */
  async markSteering(id: string, on: boolean) {
    const [row] = await this.ctx.db
      .update(schema.messages)
      .set({
        props: on
          ? sql`${schema.messages.props} || '{"steering":true}'::jsonb`
          : sql`${schema.messages.props} - 'steering'`,
      })
      .where(eq(schema.messages.id, id))
      .returning({ threadId: schema.messages.threadId });
    if (!row) return;
    const thread = await this.row(row.threadId);
    this.ctx.bus.refresh({ scope: 'thread', threadId: row.threadId, botId: thread.botId });
  }

  /** New text for the person's message, marked as edited; its other props stay as they are now. */
  async editText(id: string, text: string) {
    const [row] = await this.ctx.db
      .update(schema.messages)
      .set({ text, props: sql`${schema.messages.props} || '{"edited":true}'::jsonb` })
      .where(eq(schema.messages.id, id))
      .returning();
    if (!row) return;
    const thread = await this.row(row.threadId);
    this.ctx.bus.refresh({ scope: 'thread', threadId: row.threadId, botId: thread.botId });
  }

  async removeMessage(id: string) {
    const [row] = await this.ctx.db.delete(schema.messages).where(eq(schema.messages.id, id)).returning();
    if (!row) return;
    const thread = await this.row(row.threadId);
    this.ctx.bus.refresh({ scope: 'thread', threadId: row.threadId, botId: thread.botId });
  }

  async updateMessage(
    id: string,
    patch: { text?: string; props?: Record<string, unknown>; turnId?: string | null },
  ) {
    const [row] = await this.ctx.db
      .update(schema.messages)
      .set(patch)
      .where(eq(schema.messages.id, id))
      .returning();
    if (!row) return;
    const thread = await this.row(row.threadId);
    this.ctx.bus.refresh({ scope: 'thread', threadId: row.threadId, botId: thread.botId });
  }

  /**
   * Puts an emoji on the user's latest message sent no later than `before`, replacing any earlier one.
   * Returns null when there is no such message.
   */
  async react(threadId: string, before: Date, emoji: string): Promise<Message | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, threadId),
          eq(schema.messages.role, 'user'),
          eq(schema.messages.author, 'user'),
          lte(schema.messages.createdAt, before),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    if (!row) return null;
    const props = { ...row.props, reaction: emoji };
    await this.updateMessage(row.id, { props });
    return toMessage({ ...row, props });
  }

  /**
   * The person's emoji on a bot message, or none when null. Kept apart from `reaction`, which is
   * the bot's emoji on the person's message.
   */
  async setReaction(id: string, emoji: string | null): Promise<Message> {
    const [row] = await this.ctx.db.select().from(schema.messages).where(eq(schema.messages.id, id)).limit(1);
    if (!row) throw notFound('message');
    const { userReaction: _, ...rest } = row.props;
    const props = emoji ? { ...rest, userReaction: emoji } : rest;
    await this.updateMessage(id, { props });
    return toMessage({ ...row, props });
  }

  /** Adds fields to a message's props, read fresh so a change made meanwhile is kept. */
  async mergeProps(id: string, patch: Record<string, unknown>) {
    const [row] = await this.ctx.db.select().from(schema.messages).where(eq(schema.messages.id, id)).limit(1);
    if (!row) throw notFound('message');
    await this.updateMessage(id, { props: { ...row.props, ...patch } });
  }

  /**
   * Sidebar summary for every active bot; with `scope`, for the bots one person reaches, from the
   * conversations they see.
   */
  async summaries(scope?: SummaryScope): Promise<BotSummary[]> {
    const bots = await this.ctx.db
      .select({ id: schema.bots.id })
      .from(schema.bots)
      .where(
        and(
          isNull(schema.bots.archivedAt),
          scope && (scope.botIds.length ? inArray(schema.bots.id, scope.botIds) : sql`false`),
        ),
      )
      .orderBy(asc(schema.bots.createdAt));
    const threads = await this.ctx.db
      .select()
      .from(schema.threads)
      // A ticket's conversation counts only for whether the bot is at work: its text is read on the
      // board, not in the sidebar.
      .where(
        and(inArray(schema.threads.kind, ['user', 'routine', 'bot', 'api', 'team', 'ticket']), scope?.seen),
      )
      .orderBy(desc(schema.threads.updatedAt));
    const ids = threads.map((t) => t.id);
    // An exchange between bots is not opened by the person: it counts for whether a bot is at
    // work, not as what the bot last said.
    const shown = threads.filter((t) => t.kind !== 'ticket' && t.kind !== 'bot').map((t) => t.id);
    const [states, previews, replies] = await Promise.all([
      this.states(ids),
      this.previews(shown),
      this.lastReplies(shown),
    ]);
    const asked = await this.ctx.db
      .select({
        id: schema.approvals.id,
        botId: schema.approvals.botId,
        threadId: schema.approvals.threadId,
        turnId: schema.approvals.turnId,
        kind: schema.approvals.kind,
        summary: schema.approvals.summary,
      })
      .from(schema.approvals)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.approvals.threadId))
      .where(and(eq(schema.approvals.status, 'pending'), scope?.seen, scope?.answerable))
      .orderBy(asc(schema.approvals.createdAt));
    // A card asked between bots waits with the bot the work began with, where it is answered.
    const places = await this.answerPlaces(asked);
    const pending = asked.map((p) => ({ ...p, ...places.get(p.id) }));
    const pendingBy = new Map<string, number>();
    const waitingBy = new Map<string, BotSummary['waiting']>();
    for (const p of pending) {
      pendingBy.set(p.botId, (pendingBy.get(p.botId) ?? 0) + 1);
      if (!waitingBy.has(p.botId)) {
        waitingBy.set(p.botId, {
          kind: p.kind,
          summary: truncate(plainText(p.summary), 200),
          threadId: p.threadId,
        });
      }
    }
    // Each enabled routine's latest finished run; a failed one marks its bot until a run succeeds
    // or the person opens the routine and sees it.
    const latestRuns = await this.ctx.db
      .selectDistinctOn([schema.routineRuns.routineId], {
        routineId: schema.routineRuns.routineId,
        botId: schema.routines.botId,
        name: schema.routines.name,
        status: schema.routineRuns.status,
        startedAt: schema.routineRuns.startedAt,
        finishedAt: schema.routineRuns.finishedAt,
        seenAt: schema.routines.failureSeenAt,
      })
      .from(schema.routineRuns)
      .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .where(
        and(
          eq(schema.routines.enabled, true),
          inArray(schema.routineRuns.status, ['done', 'error', 'stopped']),
          // A routine's failures are for those who may change its bot.
          scope && (scope.editable.length ? inArray(schema.routines.botId, scope.editable) : sql`false`),
        ),
      )
      .orderBy(schema.routineRuns.routineId, desc(schema.routineRuns.startedAt));
    // Newest failure first: that one names the bot's mark.
    const failedBy = new Map<string, { id: string; name: string }[]>();
    const unseen = (r: (typeof latestRuns)[number]) =>
      !r.seenAt || r.seenAt.getTime() < (r.finishedAt ?? r.startedAt).getTime();
    for (const r of latestRuns
      .filter((r) => r.status === 'error' && unseen(r))
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())) {
      failedBy.set(r.botId, [...(failedBy.get(r.botId) ?? []), { id: r.routineId, name: r.name }]);
    }
    return bots.map(({ id }) => {
      const own = threads.filter((t) => t.botId === id);
      const userThread = own.find((t) => t.kind === 'user') ?? null;
      const latest = own.find((t) => previews.has(t.id)) ?? null;
      const busy = own.map((t) => states.get(t.id)).find((s) => s && s !== 'idle');
      // A bot answering another bot is not something the person has to read; a routine's report
      // is read in the main conversation it is copied to.
      const replied = own
        .filter((t) => t.kind !== 'bot' && t.kind !== 'routine')
        .map((t) => ({ threadId: t.id, at: replies.get(t.id) }))
        .reduce<{ threadId: string; at: Date } | null>(
          (a, b) => (b.at && (!a || b.at > a.at) ? { threadId: b.threadId, at: b.at } : a),
          null,
        );
      return {
        botId: id,
        threadId: userThread?.id ?? null,
        preview: latest ? (previews.get(latest.id) ?? null) : null,
        previewAt: latest ? latest.updatedAt.toISOString() : null,
        repliedAt: replied?.at.toISOString() ?? null,
        repliedThreadId: replied?.threadId ?? null,
        state: busy ?? 'idle',
        pendingApprovals: pendingBy.get(id) ?? 0,
        failedRoutine: failedBy.get(id)?.[0]?.name ?? null,
        failedRoutines: failedBy.get(id)?.map((r) => r.id) ?? [],
        waiting: waitingBy.get(id) ?? null,
      };
    });
  }
}

/** Up to `width` characters of `text` around the first match of `query`, on one line. */
export function excerptAround(text: string, query: string, width = 160): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  // Turkish casing first (İ/ı keep their length), then the default rules.
  const find = (locale?: string) => flat.toLocaleLowerCase(locale).indexOf(query.toLocaleLowerCase(locale));
  const tr = find('tr');
  const at = tr >= 0 ? tr : find();
  if (at < 0 || flat.length <= width) return flat.slice(0, width);
  const start = Math.max(0, Math.min(at - Math.floor((width - query.length) / 2), flat.length - width));
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + width)}${start + width < flat.length ? '…' : ''}`;
}
