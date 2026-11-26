import { outsideIn, type Bot, type Memory } from '@leafbot/shared';
import { and, count, desc, eq, gt, gte, inArray, isNotNull, lte, ne, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { Engine, TurnOutcome } from '../engine/types';
import { translator, type T } from '../i18n';
import { OWNER_ID } from '../users';
import { HttpError, truncate } from '../util';
import { atLeast } from './access';
import type { FlagRow } from './memory-flags';
import { placeOf, ROOM_NOTES_PER_PLACE } from './memory';
import { redactSecrets } from './secrets';
import type { Services } from './index';
import { siteOf } from './vault';

type TurnRow = typeof schema.turns.$inferSelect;
type ThreadRow = typeof schema.threads.$inferSelect;

/** The most messages one review reads; a longer stretch is read from its newest end. */
const MAX_MESSAGES = 200;
/** What of the conversation goes into one request: each message, and all of them together. */
const MESSAGE_CHARS = 1500;
const SPAN_CHARS = 48_000;
/** What of the notes goes into one request; a note left out is one the review cannot touch. */
const NOTE_CHARS = 400;
const NOTES_CHARS = 30_000;
/** The most changes one review makes. */
const MAX_OPERATIONS = 20;
/** A conversation that was reset is looked at early when this many turns had not been reviewed. */
const RESET_MIN_TURNS = 3;
/** Conversations a review reads: a person's own, a room, and a team's. */
const REVIEWED_KINDS: ThreadRow['kind'][] = ['user', 'room', 'team'];

/** One change as the model asks for it; a malformed one is dropped, not fatal. */
const NoteOperation = z.object({
  op: z.enum(['write', 'update', 'forget']),
  scope: z.enum(['bot', 'user', 'room']),
  id: z.string().min(1).max(100).optional(),
  content: z.string().max(5000).optional(),
  site: z.string().max(253).optional(),
});
/** The answer to a gap a bot flagged, as the person gave it in the conversation. */
const ResolveOperation = z.object({
  op: z.literal('resolve'),
  flag: z.string().min(1).max(100),
  content: z.string().max(5000),
});
const Operation = z.union([NoteOperation, ResolveOperation]);
type Operation = z.infer<typeof Operation>;

/** The changes in the model's answer: a list, or an object holding one; anything unclear is none. */
export function parseOperations(text: string): Operation[] {
  const json = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0];
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw as { operations?: unknown } | null)?.operations;
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((item) => {
      const parsed = Operation.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, MAX_OPERATIONS);
}

/** Keeps the data from closing or opening a tag of its own inside the request. */
const data = (s: string) => s.replace(/</g, '\\u003c');

/**
 * Reads the new part of a conversation every so many turns and keeps what is worth remembering.
 * It is no turn: it has no turn row, shows no state, adds no message and reaches no chat app. It
 * asks the engine for one answer without tools (`Engine.complete`) and works through a queue, one
 * review at a time across the server.
 */
export class MemoryReviewService {
  private queue: Promise<void> = Promise.resolve();
  /** Conversations waiting for a review, so one is not queued twice. */
  private waiting = new Set<string>();
  /** Looks at whether a reset conversation is due, still under way. */
  private checks = new Set<Promise<void>>();
  private current: AbortController | null = null;
  private stopped = false;

  constructor(
    private ctx: Ctx,
    private services: Services,
    private engineFor: (bot: Bot) => Engine,
  ) {}

  /** Called when a turn ends: every `memoryReviewEvery` finished turns the person started. */
  async onTurnFinished(turn: TurnRow, outcome: TurnOutcome): Promise<void> {
    if (!outcome.ok || turn.source !== 'user' || this.stopped) return;
    const every = (await this.services.settings.all()).memoryReviewEvery;
    if (!every) return;
    const bot = await this.services.bots.get(turn.botId).catch(() => null);
    if (!bot?.memory || bot.archivedAt) return;
    const thread = await this.services.threads.row(turn.threadId).catch(() => null);
    if (!thread || !REVIEWED_KINDS.includes(thread.kind)) return;
    // A WhatsApp chat a bot answers is someone else's words: nothing of it goes into notes.
    if (await this.services.whatsapp.contactOf(thread.id)) return;
    if ((await this.unreviewed(thread.id)) >= every) this.enqueue(thread.id, bot.id);
  }

  /** Called when a conversation is reset: its turns so far are looked at now, if there were enough. */
  onContextReset(threadId: string): Promise<void> {
    const check = this.afterReset(threadId).catch((err) => console.warn('memory review', err));
    this.checks.add(check);
    return check.finally(() => this.checks.delete(check));
  }

  private async afterReset(threadId: string): Promise<void> {
    if (this.stopped) return;
    const every = (await this.services.settings.all()).memoryReviewEvery;
    if (!every) return;
    const thread = await this.services.threads.row(threadId).catch(() => null);
    if (!thread || !REVIEWED_KINDS.includes(thread.kind)) return;
    if (await this.services.whatsapp.contactOf(thread.id)) return;
    const bot = await this.services.bots.get(thread.botId).catch(() => null);
    if (!bot?.memory || bot.archivedAt) return;
    if ((await this.unreviewed(thread.id)) >= RESET_MIN_TURNS) this.enqueue(thread.id, bot.id);
  }

  /** Wait until no review is waiting or running (tests). */
  async idle(): Promise<void> {
    await Promise.all([...this.checks]);
    for (;;) {
      const tail = this.queue;
      await tail;
      if (tail === this.queue) return;
    }
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    this.current?.abort();
    await this.queue.catch(() => {});
  }

  private enqueue(threadId: string, botId: string) {
    if (this.waiting.has(threadId)) return;
    this.waiting.add(threadId);
    this.queue = this.queue
      .then(async () => {
        this.waiting.delete(threadId);
        if (!this.stopped) await this.review(threadId, botId);
      })
      .catch((err) => console.warn('memory review', err));
  }

  /**
   * SQL for the time of the last reviewed message: the message's own time in the database, which
   * keeps the microseconds a Date loses, or the stored time when the message is gone.
   */
  private since(cursor: { messageId: string; messageAt: Date }): SQL {
    return sql`coalesce((select ${schema.messages.createdAt} from ${schema.messages} where ${schema.messages.id} = ${cursor.messageId}), ${cursor.messageAt.toISOString()}::timestamptz)`;
  }

  private async cursor(threadId: string) {
    const [row] = await this.ctx.db
      .select()
      .from(schema.memoryReviews)
      .where(eq(schema.memoryReviews.threadId, threadId))
      .limit(1);
    return row ?? null;
  }

  /** Finished turns the person started since the last review of the conversation. */
  private async unreviewed(threadId: string): Promise<number> {
    const cursor = await this.cursor(threadId);
    const [row] = await this.ctx.db
      .select({ n: count() })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.threadId, threadId),
          eq(schema.turns.source, 'user'),
          eq(schema.turns.status, 'done'),
          cursor ? gt(schema.turns.createdAt, this.since(cursor)) : undefined,
        ),
      );
    return row?.n ?? 0;
  }

  /** Moves the cursor to `message`: what comes before it is not read again. */
  private async advance(threadId: string, message: { id: string; createdAt: Date }) {
    await this.ctx.db
      .insert(schema.memoryReviews)
      .values({ threadId, messageId: message.id, messageAt: message.createdAt })
      .onConflictDoUpdate({
        target: schema.memoryReviews.threadId,
        set: { messageId: message.id, messageAt: message.createdAt, reviewedAt: new Date() },
      });
  }

  private async review(threadId: string, botId: string): Promise<void> {
    const settings = await this.services.settings.all();
    if (!settings.memoryReviewEvery) return;
    const bot = await this.services.bots.get(botId).catch(() => null);
    const thread = await this.services.threads.row(threadId).catch(() => null);
    if (!bot?.memory || bot.archivedAt || !thread) return;
    const engine = this.engineFor(bot);
    // An engine that cannot answer without a session is skipped: a turn is never run for this.
    if (!engine.complete) return;
    // A spent limit stops the bot's background calls too; the review looks again after a later turn.
    if (await this.services.usage.reached(bot)) return;
    // A turn still going would be read without its answer, and the cursor would then pass its
    // question by: the review waits, and the next turn that ends brings it back.
    const [busy] = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(and(eq(schema.turns.threadId, threadId), inArray(schema.turns.status, ['queued', 'running'])))
      .limit(1);
    if (busy) return;

    const cursor = await this.cursor(threadId);
    const [latest] = await this.ctx.db
      .select({ id: schema.messages.id, createdAt: schema.messages.createdAt })
      .from(schema.messages)
      .where(eq(schema.messages.threadId, threadId))
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
      .limit(1);
    if (!latest || latest.id === cursor?.messageId) return;
    // Whatever happens next, these messages are not read again: a failure is not retried on every turn.
    try {
      await this.read(thread, bot, engine, cursor, latest, settings.defaultModel);
    } catch (err) {
      console.warn(`Memory review of ${threadId} failed: ${(err as Error).message}`);
    } finally {
      await this.advance(threadId, latest).catch((err) => console.warn('memory review cursor', err));
    }
  }

  private async read(
    thread: ThreadRow,
    bot: Bot,
    engine: Engine,
    cursor: { messageId: string; messageAt: Date } | null,
    latest: { id: string; createdAt: Date },
    defaultModel: string,
  ): Promise<void> {
    const rows = await this.ctx.db
      .select({
        id: schema.messages.id,
        role: schema.messages.role,
        text: schema.messages.text,
        props: schema.messages.props,
        turnId: schema.messages.turnId,
        createdAt: schema.messages.createdAt,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, thread.id),
          inArray(schema.messages.role, ['user', 'assistant']),
          cursor ? gt(schema.messages.createdAt, this.since(cursor)) : undefined,
          // Up to the message the cursor is moved to: one written meanwhile is read next time, once.
          lte(schema.messages.createdAt, this.since({ messageId: latest.id, messageAt: latest.createdAt })),
        ),
      )
      .orderBy(desc(schema.messages.createdAt), desc(schema.messages.id))
      .limit(MAX_MESSAGES);
    const span = rows.reverse().filter((m) => m.text.trim());
    if (!span.some((m) => m.role === 'user')) return;

    const locale =
      (await this.services.settings.all(thread.userId ?? undefined)).language ??
      (await this.services.settings.locale());
    const t = translator(locale);
    const team = thread.kind === 'team';
    const person = thread.userId ?? bot.ownerUserId ?? OWNER_ID;
    const place = await placeOf(this.ctx, thread);
    const visible = await this.services.memory.visibleTo(bot.id, team ? null : person, place);
    const notes = [...visible.bot, ...(team ? [] : visible.user), ...visible.room];

    const outside = await this.readOutside(thread, span);
    // A bot's notes reach everyone who uses the bot: they change from a conversation with anyone who
    // has an account here, as the bot's memory tools allow, but not from one a stranger spoke in.
    const botNotes = !(await this.guestIn(thread, span));
    // Someone who may only talk with the bot: its own notes reach everyone else who uses it, so what
    // is about them goes to their own notes only.
    const member =
      !team &&
      !atLeast(await this.services.access.level(await this.services.access.viewerOf(person), bot.id), 'edit');
    // A stretch with outside text in it settles no gap: what answers it there may not be the person's.
    const flags = outside
      ? []
      : await this.services.memoryFlags.forReview(bot.id, team ? null : person, place);
    const request = this.request(t, { team, member, place, notes, span, outside, flags });
    const controller = new AbortController();
    this.current = controller;
    let text: string;
    let costUsd: number | null;
    try {
      ({ text, costUsd } = await engine.complete!({
        model: bot.model || (bot.engine === 'claude' ? defaultModel : '') || this.ctx.config.claudeModel,
        ...request,
        signal: controller.signal,
        locale,
      }));
    } finally {
      this.current = null;
    }
    await this.services.usage.background(bot.id, 'memoryReview', costUsd);
    if (controller.signal.aborted) return;
    const shown = new Map(notes.filter((n) => request.shown.has(n.id)).map((n) => [n.id, n]));
    const changed = await this.apply(parseOperations(text), {
      t,
      bot,
      thread,
      person: team ? null : person,
      place,
      shown,
      botNotes,
      flags: new Map(flags.filter((f) => request.flagsShown.has(f.id)).map((f) => [f.id, f])),
      outside,
    });
    if (changed) this.ctx.bus.refresh({ scope: 'memory' });
  }

  /** Whether someone with no account here spoke in the stretch. */
  private async guestIn(
    thread: ThreadRow,
    span: { turnId: string | null; createdAt: Date }[],
  ): Promise<boolean> {
    const ids = [...new Set(span.flatMap((m) => (m.turnId ? [m.turnId] : [])))];
    const from = new Date((span[0]?.createdAt.getTime() ?? Date.now()) - 60_000);
    const [guest] = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.threadId, thread.id),
          or(ids.length ? inArray(schema.turns.id, ids) : undefined, gte(schema.turns.createdAt, from)),
          eq(schema.turns.guest, true),
        ),
      )
      .limit(1);
    return !!guest;
  }

  /**
   * Whether the stretch may hold text the person did not write: a message that carries someone
   * else's words, or a turn in it that read outside text (a page, a mail, an app's answer), was
   * started by something other than the person, or came from a guest. The turn's own mark is the
   * one the turn machinery keeps (`turns.outside`), whether or not the person was watching.
   */
  private async readOutside(
    thread: ThreadRow,
    span: { props: unknown; turnId: string | null; createdAt: Date }[],
  ): Promise<boolean> {
    if (span.some((m) => outsideIn((m.props ?? {}) as Record<string, unknown>))) return true;
    const ids = [...new Set(span.flatMap((m) => (m.turnId ? [m.turnId] : [])))];
    // A minute before the first message: a turn is written a moment before its messages.
    const from = new Date((span[0]?.createdAt.getTime() ?? Date.now()) - 60_000);
    const [odd] = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.threadId, thread.id),
          or(ids.length ? inArray(schema.turns.id, ids) : undefined, gte(schema.turns.createdAt, from)),
          or(isNotNull(schema.turns.outside), ne(schema.turns.source, 'user'), eq(schema.turns.guest, true)),
        ),
      )
      .limit(1);
    return !!odd;
  }

  /** The two texts of the request, and the ids of the notes it shows (the only ones it may change). */
  private request(
    t: T,
    o: {
      team: boolean;
      member: boolean;
      place: string | null;
      notes: Memory[];
      span: { role: string; text: string; props: unknown }[];
      outside: boolean;
      flags: FlagRow[];
    },
  ) {
    const scopes = [
      t('memoryReview.scopesHead'),
      t('memoryReview.scopeBot'),
      ...(o.team ? [] : [t('memoryReview.scopeUser')]),
      ...(o.place ? [t('memoryReview.scopeRoom')] : []),
      ...(o.team ? [t('memoryReview.scopesTeam')] : []),
      ...(o.member ? [t('memoryReview.scopesMember')] : []),
    ].join('\n');
    const system = [
      t('memoryReview.system', {
        pinned: t('memoryReview.markPinned'),
        byPerson: t('memoryReview.markPerson'),
        scopes,
        today: new Date().toISOString().slice(0, 10),
      }),
      ...(o.flags.length ? [t('memoryReview.flagsRule')] : []),
    ].join('\n\n');
    const shown = new Set<string>();
    let used = 0;
    const lines: string[] = [];
    for (const n of o.notes) {
      const line = `[${n.id}] (${n.scope}${n.site ? ` ${n.site}` : ''})${n.pinned ? ` [${t('memoryReview.markPinned')}]` : ''}${n.source === 'user' ? ` [${t('memoryReview.markPerson')}]` : ''} ${data(truncate(n.content, NOTE_CHARS))}`;
      if (used + line.length > NOTES_CHARS) break;
      used += line.length;
      shown.add(n.id);
      lines.push(line);
    }
    // A gap about a note is offered only with the note: the answer goes into it, and only a note
    // the review was shown may change.
    const flagsShown = new Set<string>();
    const flagLines = o.flags
      .filter((f) => !f.memoryId || shown.has(f.memoryId))
      .map((f) => {
        flagsShown.add(f.id);
        const target = f.memoryId ? ` note=${f.memoryId}` : '';
        return `[${f.id}] (${f.kind}${target}) ${data(truncate(f.about, NOTE_CHARS))}${f.seen ? ` | ${data(truncate(f.seen, NOTE_CHARS))}` : ''}`;
      });
    // The newest messages that fit; an older one is dropped whole.
    const kept: string[] = [];
    let size = 0;
    for (const m of [...o.span].reverse()) {
      const outsideMark = outsideIn((m.props ?? {}) as Record<string, unknown>) ? ' outside="true"' : '';
      const line = `<m role="${m.role}"${outsideMark}>${data(truncate(m.text, MESSAGE_CHARS))}</m>`;
      if (size + line.length > SPAN_CHARS) break;
      size += line.length;
      kept.unshift(line);
    }
    const user = [
      `<notes>\n${lines.length ? lines.join('\n') : t('memoryReview.noNotes')}\n</notes>`,
      ...(flagLines.length ? [`<flags>\n${flagLines.join('\n')}\n</flags>`] : []),
      `<conversation>\n${kept.join('\n')}\n</conversation>`,
    ].join('\n');
    return { system, user, shown, flagsShown };
  }

  /**
   * Makes what the model asked for, with the checks a bot's own memory tools make, straight away:
   * the bot keeps its memory itself, and every change shows in the memory screen, where the person
   * can change or delete it. Returns whether anything was saved.
   */
  private async apply(
    ops: Operation[],
    c: {
      t: T;
      bot: Bot;
      thread: ThreadRow;
      /** Whose notes about themselves it may write; null in a team conversation. */
      person: string | null;
      place: string | null;
      shown: Map<string, Memory>;
      /** Whether the bot's own notes may change. */
      botNotes: boolean;
      /** The gaps the review was shown, the only ones it may settle. */
      flags: Map<string, FlagRow>;
      /** Whether outside text was in the stretch: what it writes is marked (see `memories.unverified`). */
      outside: boolean;
    },
  ): Promise<boolean> {
    let changed = false;
    for (const op of ops) {
      try {
        changed = (await this.applyOne(op, c)) || changed;
      } catch (err) {
        console.warn(`Memory review change skipped: ${(err as Error).message}`);
      }
    }
    return changed;
  }

  private async applyOne(op: Operation, c: Parameters<MemoryReviewService['apply']>[1]): Promise<boolean> {
    const { memory } = this.services;
    const { bot, thread } = c;
    const actor = `bot:${bot.id}`;
    if (op.op === 'resolve') return this.resolve(op, c);
    const content = op.content?.trim();
    if (op.op !== 'forget' && (!content || content.length > 2000)) return false;
    const clean = content ? redactSecrets(content, c.t('memory.redacted')) : null;

    if (op.op === 'write') {
      if (op.scope === 'bot' && !c.botNotes) return false;
      if (op.scope === 'user' && !c.person) return false;
      if (op.scope === 'room' && !c.place) return false;
      let host: string | null = null;
      if (op.site) {
        try {
          host = siteOf(new URL(op.site.includes('://') ? op.site : `https://${op.site}`).hostname);
        } catch {
          return false;
        }
      }
      const note = {
        scope: op.scope,
        botId: op.scope === 'bot' ? bot.id : null,
        userId: op.scope === 'user' ? c.person : null,
        place: op.scope === 'room' ? c.place : null,
        content: clean!.text,
        site: host,
      };
      if (await memory.findSame(note)) return false;
      if (note.place && (await memory.roomCount(note.place)) >= ROOM_NOTES_PER_PLACE) return false;
      await memory.create({ ...note, source: actor, threadId: thread.id, unverified: c.outside });
      return true;
    }

    // An update or a forget is only for a note the review was shown.
    const m = op.id ? c.shown.get(op.id) : undefined;
    if (!m) return false;
    if (!memory.canEdit(m, [bot.id], c.person ?? '', c.place ? [c.place] : [])) return false;
    if (m.scope === 'bot' && !c.botNotes) return false;
    // A note the person wrote or pinned is theirs: the review leaves it alone, as it is told to.
    if (m.pinned || m.source === 'user') return false;
    if (op.op === 'update') {
      if (clean!.text === m.content) return false;
      try {
        await memory.update(
          m.id,
          {
            content: clean!.text,
            expectedUpdatedAt: m.updatedAt,
            threadId: thread.id,
            sourceUrl: null,
            ...(c.outside && { unverified: true }),
          },
          actor,
        );
      } catch (err) {
        // Changed since it was shown: the newer words stand.
        if (err instanceof HttpError && err.status === 409) return false;
        throw err;
      }
      return true;
    }
    await memory.remove(m.id, actor);
    return true;
  }

  /**
   * Fills a gap a bot flagged with what the person said in the conversation: the flagged note
   * takes the words, or a note of the flag's scope is written. A note the person wrote or pinned
   * is theirs, so a flag about one stays for them to answer.
   */
  private async resolve(
    op: Extract<Operation, { op: 'resolve' }>,
    c: Parameters<MemoryReviewService['apply']>[1],
  ): Promise<boolean> {
    const flag = c.flags.get(op.flag);
    const content = op.content.trim();
    if (!flag || !content || content.length > 2000) return false;
    const clean = redactSecrets(content, c.t('memory.redacted')).text;
    // The person said the note is right as it is: nothing to change, and the gap is closed.
    if (flag.memoryId && c.shown.get(flag.memoryId)?.content === clean) {
      await this.services.memoryFlags.settle(flag.id, 'review', clean);
      return false;
    }
    const done = flag.memoryId
      ? await this.applyOne({ op: 'update', scope: flag.scope, id: flag.memoryId, content: clean }, c)
      : await this.applyOne({ op: 'write', scope: flag.scope, content: clean }, c);
    if (!done) return false;
    await this.services.memoryFlags.settle(flag.id, 'review', clean);
    return true;
  }
}
