import { wallClock, zonedTime, type Bot, type FollowUp, type OutsideTrigger } from '@leafbot/shared';
import { and, asc, desc, eq, inArray, lt, lte } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { Engine, TurnOutcome } from '../engine/types';
import { translator, type T } from '../i18n';
import type { TurnRow } from '../runtime/turns';
import { notFound, newId, truncate } from '../util';
import { dice, wordsOf } from './routine-suggestions';
import { redactSecrets } from './secrets';
import type { Services } from './index';

type Row = typeof schema.followUps.$inferSelect;

/** Open follow-ups one person has at most, so a flood of mails cannot fill the schedule. */
export const MAX_OPEN_FOLLOW_UPS = 300;
/** The most follow-ups that start a turn in one look; the rest wait for the next minute. */
const FIRE_PER_TICK = 5;
/** A follow-up with no moment of its own that could not come up for this long is dropped. */
const STALE_MS = 7 * 86_400_000;
/** Follow-ups that came up or were dropped are kept this long, then removed. */
const KEEP_MS = 30 * 86_400_000;
/** Two follow-ups of a person on the same day whose words are this alike are the same thing. */
const SAME_WORDS = 0.6;
const TEXT_MAX = 500;
const CONTEXT_MAX = 500;
/** The hours of the person's day a follow-up may come up in: from this one, before that one. */
export const DAY_FROM = 8;
export const DAY_UNTIL = 21;
/** A reminder comes at least this long before the thing itself, when it can. */
const BEFORE_MS = 2 * 3600_000;
/** What a turn's words are cut to before the small model reads them. */
const READ_CHARS = 6000;
/** Follow-ups the small model is shown as already kept, the soonest first. */
const KNOWN_SHOWN = 40;
/** Looks the small model takes for one person in a day, at most. */
const LOOKS_PER_DAY = 60;
/** Events further off than this are not kept. */
const HORIZON_MS = 400 * 86_400_000;

/**
 * Words that name a moment, in the two languages the app speaks: a day, a month, a date or a time.
 * A turn with none of them names nothing coming up, and the small model is not asked.
 */
const MOMENT =
  /(?<!\p{L})(yarın|bugün|bu akşam|bu gece|haftaya|gelecek hafta|önümüzdeki|pazartesi|salı|çarşamba|perşembe|cuma|cumartesi|pazar|ocak|şubat|mart|nisan|mayıs|haziran|temmuz|ağustos|eylül|ekim|kasım|aralık|saat|son gün|tomorrow|tonight|next week|monday|tuesday|wednesday|thursday|friday|saturday|sunday|january|february|march|april|june|july|august|september|october|november|december|deadline|due)|\d{1,2}[./]\d{1,2}|\d{1,2}:\d{2}|\d{4}-\d{2}-\d{2}/iu;

export const namesAMoment = (text: string) => MOMENT.test(text);

const toFollowUp = (r: Row): FollowUp => ({
  id: r.id,
  botId: r.botId,
  text: r.text,
  context: r.context,
  eventAt: r.eventAt?.toISOString() ?? null,
  dueAt: r.dueAt.toISOString(),
  kind: r.kind,
  createdAt: r.createdAt.toISOString(),
});

const two = (n: number) => String(n).padStart(2, '0');
const dayKey = (at: Date, timezone: string) => {
  const w = wallClock(at, timezone);
  return `${w.year}-${two(w.month)}-${two(w.day)}`;
};
const addDays = (day: string, n: number) =>
  new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10) + n))
    .toISOString()
    .slice(0, 10);

/** The end of the event: its time, or the end of its day when it names only a day. */
function eventEnd(o: { eventAt: Date; eventHasTime: boolean; timezone: string }): Date {
  return o.eventHasTime ? o.eventAt : zonedTime(dayKey(o.eventAt, o.timezone), '23:59', o.timezone);
}

/** Whether a moment falls in the person's day (not at night), in their time zone. */
export function inDaytime(at: Date, timezone: string): boolean {
  const h = wallClock(at, timezone).hour;
  return h >= DAY_FROM && h < DAY_UNTIL;
}

/**
 * When to bring a thing up, worked out here rather than left to the model: the morning before at
 * the person's reminder time; else that morning, when the thing is later that day; else two hours
 * before; always in the day, never at night, and before the thing itself. When all of those have
 * passed: null if the person is talking about it right now (they know), and otherwise as soon as
 * it is day, if that is still in time.
 */
export function remindTime(o: {
  eventAt: Date;
  eventHasTime: boolean;
  now: Date;
  timezone: string;
  /** The person's reminder time of day, HH:MM. */
  dayTime: string;
  /** The person is in the conversation the thing came up in. */
  present: boolean;
}): Date | null {
  const end = eventEnd(o);
  const day = dayKey(o.eventAt, o.timezone);
  const soonest = o.now.getTime() + 5 * 60_000;
  const fits = (at: Date) =>
    at.getTime() > soonest && at.getTime() < end.getTime() && inDaytime(at, o.timezone);
  const dayBefore = zonedTime(addDays(day, -1), o.dayTime, o.timezone);
  const thatMorning = zonedTime(day, o.dayTime, o.timezone);
  const candidates = [
    dayBefore,
    // That morning only when the thing is at least two hours later.
    ...(!o.eventHasTime || thatMorning.getTime() <= end.getTime() - BEFORE_MS ? [thatMorning] : []),
    ...(o.eventHasTime ? [new Date(end.getTime() - BEFORE_MS)] : []),
  ];
  for (const at of candidates) if (fits(at)) return at;
  if (o.present) return null;
  return nextDaytime(new Date(o.now.getTime() + 2 * 60_000), o.timezone, end);
}

/** `from`, or the next moment from it that is in the person's day; null when that is past `before`. */
export function nextDaytime(from: Date, timezone: string, before: Date | null): Date | null {
  let at = from;
  if (!inDaytime(at, timezone)) {
    const today = dayKey(at, timezone);
    const morning = zonedTime(today, `${two(DAY_FROM)}:00`, timezone);
    at =
      morning.getTime() > at.getTime()
        ? morning
        : zonedTime(addDays(today, 1), `${two(DAY_FROM)}:00`, timezone);
  }
  return before && at.getTime() >= before.getTime() ? null : at;
}

/** One change the small model asks for; a malformed one is dropped, not fatal. */
const Change = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('add'),
    what: z.string().min(1).max(TEXT_MAX),
    event: z.string().min(1).max(40),
    from: z.string().max(CONTEXT_MAX).optional(),
  }),
  z.object({
    op: z.literal('move'),
    id: z.string().min(1).max(100),
    what: z.string().max(TEXT_MAX).optional(),
    event: z.string().min(1).max(40),
    from: z.string().max(CONTEXT_MAX).optional(),
  }),
  z.object({ op: z.literal('drop'), id: z.string().min(1).max(100) }),
]);
export type FollowUpChange = z.infer<typeof Change>;

/** The changes in the model's answer: a list, or an object holding one; anything unclear is none. */
export function parseChanges(text: string): FollowUpChange[] {
  const json = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0];
  if (!json) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : (raw as { changes?: unknown } | null)?.changes;
  if (!Array.isArray(list)) return [];
  return list
    .flatMap((item) => {
      const parsed = Change.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    })
    .slice(0, 10);
}

/**
 * A moment as the model or a bot gives it, in the person's time zone: `YYYY-MM-DD` (the day alone)
 * or `YYYY-MM-DD HH:MM`. Null for anything else.
 */
export function readMoment(text: string, timezone: string): { at: Date; hasTime: boolean } | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/.exec(text.trim());
  if (!m) return null;
  const [, y, mo, d, h, mi] = m;
  const real = new Date(Date.UTC(+y!, +mo! - 1, +d!));
  if (real.getUTCMonth() !== +mo! - 1 || (h !== undefined && (+h > 23 || +mi! > 59))) return null;
  return h === undefined
    ? { at: zonedTime(`${y}-${mo}-${d}`, '00:00', timezone), hasTime: false }
    : { at: zonedTime(`${y}-${mo}-${d}`, `${h}:${mi}`, timezone), hasTime: true };
}

/** Keeps the data from closing or opening a tag of its own inside the request. */
const data = (s: string) => s.replace(/</g, '\\u003c');

/**
 * The bot's own calendar: reminders it keeps for the person, apart from the routines. A routine is
 * the person's standing job: shown, set up by them or on their yes, acting with the bot's
 * permissions. A follow-up is the bot keeping track: "on Sunday morning, bring up Monday's visit".
 *
 * It learns them wherever it meets them. After each turn, when the person's words or the bot's
 * answer name a moment, one call to the small model reads them beside what is already kept and
 * adds what is coming up, moves what was moved and drops what was called off; the bot can also set
 * one itself. Nobody is asked and nothing shows among the routines. A follow-up is the person's:
 * the same thing learned twice, by two bots or from two mails, is kept once. When it is set, the
 * server works out when to bring it up (in the day, before the thing), and when that comes the bot
 * that learned it gets a turn in its conversation with the person and tells them, checking first
 * where things stand.
 *
 * That turn works for nobody who asked just now, and one learned from a mail keeps the mail's
 * mark, so anything that would send, add or change something still waits for a card: the worst a
 * planted mail can do is have the bot bring something up. Nothing that is still ahead is dropped
 * because it could not come up in time (a spent limit, a paused bot, the server off): it comes up
 * late, by another bot of the person's if its own is gone.
 */
export class FollowUpService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;
  private reading = new Set<Promise<void>>();
  private current = new Set<AbortController>();
  private looks = new Map<string, number>();
  private stopped = false;
  /** Whether finished turns are read for what is coming up; a test server leaves it off unless its test reads them. */
  readTurns = true;

  constructor(
    private ctx: Ctx,
    private services: Services,
    private engineFor: (bot: Bot) => Engine,
    private clock: () => Date = () => new Date(),
  ) {}

  /** The time now, as the follow-ups read it. */
  now(): Date {
    return this.clock();
  }

  start() {
    this.stopped = false;
    if (!this.ctx.config.routinesEnabled || this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.ctx.config.routineTickMs);
    this.timer.unref();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const c of this.current) c.abort();
    await this.ticking;
    await this.idle();
  }

  /** Wait until no turn is being read (tests). */
  async idle(): Promise<void> {
    while (this.reading.size) await Promise.all([...this.reading]);
  }

  /**
   * Keeps a follow-up, or, when the person already has the same thing kept (named by `replaces`,
   * or on the same day in nearly the same words, by any of their bots), moves that one instead. The
   * time it comes up is `dueAt` when given, else worked out from the event; null when there is no
   * time left to bring it up.
   */
  async add(o: {
    bot: Pick<Bot, 'id'>;
    userId: string;
    threadId: string | null;
    text: string;
    context?: string;
    eventAt?: Date | null;
    eventHasTime?: boolean;
    dueAt?: Date | null;
    kind?: Row['kind'];
    outside?: OutsideTrigger | null;
    /** The person is in the conversation it came up in. */
    present?: boolean;
    replaces?: string;
    t: T;
  }): Promise<FollowUp | null> {
    const clean = (s: string, max: number) =>
      redactSecrets(truncate(s.trim(), max), o.t('memory.redacted')).text;
    const text = clean(o.text, TEXT_MAX);
    const context = clean(o.context ?? '', CONTEXT_MAX);
    const settings = await this.services.settings.all(o.userId);
    const now = this.clock();
    const eventAt = o.eventAt ?? null;
    const eventHasTime = !!eventAt && !!o.eventHasTime;
    let dueAt: Date | null;
    if (o.dueAt) {
      const end = eventAt ? eventEnd({ eventAt, eventHasTime, timezone: settings.timezone }) : null;
      dueAt = nextDaytime(o.dueAt, settings.timezone, end);
    } else if (eventAt) {
      dueAt = remindTime({
        eventAt,
        eventHasTime,
        now,
        timezone: settings.timezone,
        dayTime: settings.promiseRemindAt,
        present: !!o.present,
      });
    } else dueAt = null;

    const open = await this.ctx.db
      .select()
      .from(schema.followUps)
      .where(and(eq(schema.followUps.userId, o.userId), eq(schema.followUps.status, 'open')));
    const day = (d: Date | null) => (d ? dayKey(d, settings.timezone) : '');
    const words = wordsOf(text);
    const same =
      (o.replaces ? open.find((r) => r.id === o.replaces) : undefined) ??
      open.find(
        (r) =>
          (day(r.eventAt) || day(r.dueAt)) === (day(eventAt) || day(dueAt)) &&
          dice(wordsOf(r.text), words) >= SAME_WORDS,
      );
    if (same) {
      if (!dueAt) {
        await this.close(same.id, 'dropped');
        return null;
      }
      const [row] = await this.ctx.db
        .update(schema.followUps)
        .set({
          text,
          context: context || same.context,
          eventAt: eventAt ?? same.eventAt,
          eventHasTime: eventAt ? eventHasTime : same.eventHasTime,
          dueAt,
          // Once outside text is behind it, it stays: the newer words may be the planted ones.
          outside: same.outside ?? o.outside ?? null,
        })
        .where(eq(schema.followUps.id, same.id))
        .returning();
      return toFollowUp(row!);
    }
    if (!dueAt) return null;
    if (open.length >= MAX_OPEN_FOLLOW_UPS) throw new FollowUpsFull();
    const [row] = await this.ctx.db
      .insert(schema.followUps)
      .values({
        id: newId(),
        botId: o.bot.id,
        userId: o.userId,
        threadId: o.threadId,
        text,
        context,
        eventAt,
        eventHasTime,
        dueAt,
        kind: o.kind ?? 'bot',
        outside: o.outside ?? null,
        createdAt: now,
      })
      .returning();
    return toFollowUp(row!);
  }

  /** The person's open follow-ups, soonest first, whichever bot keeps them. */
  async list(userId: string): Promise<FollowUp[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.followUps)
      .where(and(eq(schema.followUps.userId, userId), eq(schema.followUps.status, 'open')))
      .orderBy(asc(schema.followUps.dueAt));
    return rows.map(toFollowUp);
  }

  /** Drops one of the person's open follow-ups; anyone else's is not found. */
  async drop(id: string, userId: string): Promise<void> {
    const [row] = await this.ctx.db.select().from(schema.followUps).where(eq(schema.followUps.id, id));
    if (!row || row.userId !== userId) throw notFound('followUp');
    if (row.status === 'open') await this.close(id, 'dropped');
  }

  // Learning them from what was said

  /**
   * After a turn: when what the person wrote or the bot answered names a moment, the small model
   * reads it beside what is kept and adds, moves or drops follow-ups. Not waited for.
   */
  onTurnFinished(turn: TurnRow, outcome: TurnOutcome): Promise<void> {
    if (!this.readTurns || this.stopped || !outcome.ok || turn.guest || turn.rehearsalId)
      return Promise.resolve();
    if (turn.source === 'followup') return Promise.resolve();
    if (!turn.userId) return Promise.resolve();
    const work = this.read(turn, outcome.text)
      .catch((err) => console.warn(`Follow-ups of turn ${turn.id} not read: ${String(err)}`))
      .finally(() => this.reading.delete(work));
    this.reading.add(work);
    return work;
  }

  private async read(turn: TurnRow, reply: string): Promise<void> {
    const thread = await this.services.threads.row(turn.threadId).catch(() => null);
    // A team conversation is no one person's: nothing in it is kept for one.
    if (!thread || thread.kind === 'team') return;
    const asked = await this.ctx.db
      .select({ text: schema.messages.text })
      .from(schema.messages)
      .where(and(eq(schema.messages.turnId, turn.id), eq(schema.messages.role, 'user')))
      .orderBy(asc(schema.messages.createdAt));
    const said = [...asked.map((m) => m.text), reply].join('\n').trim();
    if (!said || !namesAMoment(said)) return;
    const person = turn.userId!;
    const now = this.clock();
    const settings = await this.services.settings.all(person);
    const today = `${person}:${dayKey(now, settings.timezone)}`;
    if ((this.looks.get(today) ?? 0) >= LOOKS_PER_DAY) return;
    const bot = await this.services.bots.get(turn.botId).catch(() => null);
    if (!bot || bot.archivedAt || (await this.services.bots.isPaused(bot))) return;
    // A spent limit stops the bot's background calls too: they are spent from its account.
    if (await this.services.usage.reached(bot)) return;
    const engine = this.engineFor(bot);
    if (!engine.complete) return;
    this.looks.set(today, (this.looks.get(today) ?? 0) + 1);
    const locale = settings.language ?? (await this.services.settings.locale());
    const t = translator(locale);
    const known = (await this.list(person)).slice(0, KNOWN_SHOWN);
    const when = (iso: string) => {
      const w = wallClock(new Date(iso), settings.timezone);
      return `${w.year}-${two(w.month)}-${two(w.day)} ${two(w.hour)}:${two(w.minute)}`;
    };
    const user = [
      `<now>${when(now.toISOString())}, ${settings.timezone}</now>`,
      `<kept>\n${known.map((k) => `[${k.id}] ${k.eventAt ? when(k.eventAt) : '-'} ${data(k.text)}`).join('\n') || '-'}\n</kept>`,
      `<said${turn.outside ? ' outside="true"' : ''}>\n${data(truncate(said, READ_CHARS))}\n</said>`,
    ].join('\n');
    const controller = new AbortController();
    this.current.add(controller);
    let text: string;
    let costUsd: number | null;
    try {
      ({ text, costUsd } = await engine.complete({
        model:
          bot.model ||
          (bot.engine === 'claude' ? (await this.services.settings.all()).defaultModel : '') ||
          this.ctx.config.claudeModel,
        system: t('followUp.readSystem'),
        user,
        signal: controller.signal,
        locale,
      }));
    } finally {
      this.current.delete(controller);
    }
    await this.services.usage.background(bot.id, 'followUps', costUsd);
    if (controller.signal.aborted) return;
    const knownIds = new Set(known.map((k) => k.id));
    for (const c of parseChanges(text)) {
      try {
        if (c.op === 'drop') {
          if (knownIds.has(c.id)) await this.drop(c.id, person);
          continue;
        }
        const event = readMoment(c.event, settings.timezone);
        if (!event) continue;
        if (eventEnd({ eventAt: event.at, eventHasTime: event.hasTime, timezone: settings.timezone }) < now)
          continue;
        if (event.at.getTime() > now.getTime() + HORIZON_MS) continue;
        const was = c.op === 'move' ? known.find((k) => k.id === c.id) : undefined;
        if (c.op === 'move' && !was) continue;
        await this.add({
          bot,
          userId: person,
          threadId: turn.threadId,
          text: c.what || was?.text || '',
          context: c.from,
          eventAt: event.at,
          eventHasTime: event.hasTime,
          outside: turn.outside,
          present: turn.source === 'user' || turn.source === 'reaction',
          replaces: was?.id,
          t,
        });
      } catch (err) {
        if (err instanceof FollowUpsFull) return;
        console.warn(`Follow-up change skipped: ${(err as Error).message}`);
      }
    }
  }

  // Bringing them up

  /** One look: brings up what is due, drops what can no longer help, clears out old ones. */
  tick(): Promise<void> {
    if (this.ticking) return this.ticking;
    this.ticking = this.pass()
      .catch((err) => console.warn(`Follow-ups failed: ${String(err)}`))
      .finally(() => (this.ticking = null));
    return this.ticking;
  }

  private async pass(): Promise<void> {
    const now = this.clock();
    await this.ctx.db
      .delete(schema.followUps)
      .where(
        and(
          inArray(schema.followUps.status, ['fired', 'dropped']),
          lt(schema.followUps.createdAt, new Date(now.getTime() - KEEP_MS)),
        ),
      );
    const due = await this.ctx.db
      .select()
      .from(schema.followUps)
      .where(and(eq(schema.followUps.status, 'open'), lte(schema.followUps.dueAt, now)))
      .orderBy(asc(schema.followUps.dueAt))
      .limit(FIRE_PER_TICK * 4);
    let fired = 0;
    for (const row of due) {
      if (fired >= FIRE_PER_TICK || this.stopped) break;
      const { timezone } = await this.services.settings.all(row.userId);
      // Too late to help: the thing itself is over, or a reminder with no moment waited a week.
      const over = row.eventAt
        ? eventEnd({ eventAt: row.eventAt, eventHasTime: row.eventHasTime, timezone }) <= now
        : now.getTime() - row.dueAt.getTime() > STALE_MS;
      if (over) {
        await this.close(row.id, 'dropped');
        continue;
      }
      // Late (the server was off, the bot could not work): not at night, unless it cannot wait.
      if (!inDaytime(now, timezone)) {
        const end = row.eventAt
          ? eventEnd({ eventAt: row.eventAt, eventHasTime: row.eventHasTime, timezone })
          : null;
        if (nextDaytime(now, timezone, end)) continue;
      }
      const bot = await this.teller(row);
      if (!bot) continue;
      if (await this.fire(row, bot)) fired++;
    }
  }

  /**
   * The bot that brings a follow-up up: the one that learned it, or, when that one is gone or no
   * longer open to the person, the bot they last wrote to. Null when none may work now (paused,
   * or past a spending limit): it waits, and comes up late.
   */
  private async teller(row: Row): Promise<Bot | null> {
    const viewer = await this.services.access.viewerOf(row.userId);
    const usable = async (id: string) => {
      const bot = await this.services.bots.get(id).catch(() => null);
      if (!bot || bot.archivedAt) return null;
      return (await this.services.access.level(viewer, bot.id)) === 'none' ? null : bot;
    };
    let bot = await usable(row.botId);
    if (!bot) {
      const recent = await this.ctx.db
        .select({ botId: schema.threads.botId })
        .from(schema.messages)
        .innerJoin(schema.threads, eq(schema.threads.id, schema.messages.threadId))
        .where(
          and(
            eq(schema.threads.userId, row.userId),
            eq(schema.threads.kind, 'user'),
            eq(schema.messages.role, 'user'),
          ),
        )
        .orderBy(desc(schema.messages.createdAt))
        .limit(20);
      for (const r of recent) if ((bot = await usable(r.botId))) break;
      if (!bot) return null;
      await this.ctx.db
        .update(schema.followUps)
        .set({ botId: bot.id })
        .where(eq(schema.followUps.id, row.id));
    }
    if ((await this.services.bots.isPaused(bot)) || (await this.services.usage.reached(bot))) return null;
    return bot;
  }

  /** Starts the turn that brings a follow-up up; whether it was this look's to start. */
  private async fire(row: Row, bot: Bot): Promise<boolean> {
    // Claimed in one write: two looks at once start one turn.
    const [claimed] = await this.ctx.db
      .update(schema.followUps)
      .set({ status: 'fired', firedAt: this.clock() })
      .where(and(eq(schema.followUps.id, row.id), eq(schema.followUps.status, 'open')))
      .returning({ id: schema.followUps.id });
    if (!claimed) return false;
    const settings = await this.services.settings.all(row.userId);
    const locale = settings.language ?? (await this.services.settings.locale());
    const t = translator(locale);
    const thread = await this.services.threads.main(bot.id, row.userId);
    const when = (d: Date, time: boolean) =>
      new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-GB', {
        dateStyle: 'full',
        ...(time && { timeStyle: 'short' }),
        timeZone: settings.timezone,
      }).format(d);
    const turn = await this.services.turns.enqueue({
      threadId: thread.id,
      botId: bot.id,
      source: 'followup',
      prompt: t('followUp.prompt', {
        text: row.text,
        context: row.context || '-',
        event: row.eventAt ? when(row.eventAt, row.eventHasTime) : '-',
        set: when(row.createdAt, true),
      }),
      outside: row.outside,
      userId: row.userId,
    });
    await this.ctx.db
      .update(schema.followUps)
      .set({ turnId: turn.id })
      .where(eq(schema.followUps.id, row.id));
    return true;
  }

  private async close(id: string, status: 'fired' | 'dropped') {
    await this.ctx.db
      .update(schema.followUps)
      .set({ status, firedAt: this.clock() })
      .where(eq(schema.followUps.id, id));
  }
}

/** The person has as many follow-ups as may be kept; one has to come up or go first. */
export class FollowUpsFull extends Error {
  constructor() {
    super('follow-ups full');
  }
}
