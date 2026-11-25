import { wallClock, type Bot, type RoutineHealthFindingId } from '@leafbot/shared';
import { and, desc, eq, inArray, isNull, lt, or } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { TurnOutcome } from '../engine/types';
import { translator, type T } from '../i18n';
import type { TurnRow } from '../runtime/turns';
import { OWNER_ID } from '../users';
import { atLeast } from './access';
import { DAY_UNTIL } from './follow-ups';
import type { Services } from './index';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Two looks at one person's bots are at least this far apart: one a day, wherever in it. */
export const CHECK_IN_EVERY_MS = 20 * HOUR_MS;
/** A card is worth bringing up once it has waited for the person this long. */
export const CHECK_IN_CARD_WAIT_MS = 12 * HOUR_MS;
/** Something told and still standing is told again after this, not every day. */
export const CHECK_IN_TELL_AGAIN_MS = 7 * DAY_MS;
/** The most findings one check-in names; the rest wait for the next. */
export const CHECK_IN_MAX_FINDINGS = 8;

/** The routine findings worth a word unasked: a routine that breaks or stands still, not one to tune. */
const ROUTINE_KINDS = [
  'failing',
  'pausedByFailures',
  'signInWait',
] as const satisfies readonly RoutineHealthFindingId[];
type RoutineKind = (typeof ROUTINE_KINDS)[number];

export type CheckInFinding =
  | { kind: RoutineKind; key: string; routine: string; bot: string; count: number; of?: number }
  | { kind: 'card'; key: string; bot: string }
  | { kind: 'connection'; key: string; name: string; status: 'signed-out' | 'error' };

/**
 * How long a finding must have stood before it is brought up. A routine that switched itself off
 * said so in its conversation as it did; a check-in only reminds of one still off days later. A
 * sign-in wait or a signed-out connection is often seen to within the day.
 */
const GRACE_MS: Record<CheckInFinding['kind'], number> = {
  failing: 0,
  pausedByFailures: 2 * DAY_MS,
  signInWait: DAY_MS,
  card: 0,
  connection: DAY_MS,
};

/** What a check-in remembers of a person: when each finding was first seen, and when it was told. */
interface CheckInState {
  seen: Record<string, string>;
  told: Record<string, string>;
  /** The turn that last told the person, and what it told: taken back if that turn fails. */
  turn?: { id: string; keys: string[] };
}

export type CheckInResult = 'off' | 'notNow' | 'quiet' | 'noBot' | 'told';

const lookedKey = (userId: string) => `checkIns.lookedAt.${userId}`;
const stateKey = (userId: string) => `checkIns.state.${userId}`;

/** Keeps the data from closing or opening a tag of its own inside the request. */
const data = (s: string) => s.replace(/</g, '\\u003c');

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Whether it is the person's time for a check-in: from their reminder time until the evening. */
export function checkInHour(now: Date, timezone: string, remindAt: string): boolean {
  const w = wallClock(now, timezone);
  return w.hour < DAY_UNTIL && w.hour * 60 + w.minute >= minutesOf(remindAt);
}

/**
 * Which findings are worth telling now: those that stood long enough, and were not told lately.
 * `seen` and `told` are read as they are after this look, so a finding that went away and came back
 * counts as new.
 */
export function dueFindings(findings: CheckInFinding[], state: CheckInState, now: Date): CheckInFinding[] {
  return findings.filter((f) => {
    const seen = Date.parse(state.seen[f.key] ?? '');
    if (!(now.getTime() - seen >= GRACE_MS[f.kind])) return false;
    const told = Date.parse(state.told[f.key] ?? '');
    return !(now.getTime() - told < CHECK_IN_TELL_AGAIN_MS);
  });
}

/**
 * The findings that fit in `max` lines, as `findingLines` writes them: the cards of one bot share a
 * line, so a bot with many waiting cards does not push out everything else.
 */
export function capFindings(findings: CheckInFinding[], max: number): CheckInFinding[] {
  const kept: CheckInFinding[] = [];
  const cardBots = new Set<string>();
  let lines = 0;
  for (const f of findings) {
    const newLine = f.kind !== 'card' || !cardBots.has(f.bot);
    if (newLine && lines >= max) continue;
    if (newLine) lines++;
    if (f.kind === 'card') cardBots.add(f.bot);
    kept.push(f);
  }
  return kept;
}

/** The findings as lines for the bot to read: names and counts only, cards counted per bot. */
export function findingLines(findings: CheckInFinding[], t: T): string[] {
  const lines: string[] = [];
  const cards = new Map<string, number>();
  for (const f of findings) {
    if (f.kind === 'card') {
      cards.set(f.bot, (cards.get(f.bot) ?? 0) + 1);
      continue;
    }
    if (f.kind === 'connection') {
      lines.push(
        t(f.status === 'error' ? 'checkIn.connectionError' : 'checkIn.connectionSignedOut', {
          name: data(f.name),
        }),
      );
      continue;
    }
    const vars = {
      routine: data(f.routine),
      bot: data(f.bot),
      count: String(f.count),
      of: String(f.of ?? 0),
    };
    if (f.kind === 'failing') lines.push(t(f.of ? 'checkIn.failingOf' : 'checkIn.failing', vars));
    else lines.push(t(f.kind === 'signInWait' ? 'checkIn.signInWait' : 'checkIn.pausedByFailures', vars));
  }
  for (const [bot, count] of cards)
    lines.push(
      t('checkIn.cards', {
        bot: data(bot),
        count: String(count),
        hours: String(CHECK_IN_CARD_WAIT_MS / HOUR_MS),
      }),
    );
  return lines;
}

/**
 * Looks over a person's bots once a day, at their reminder time, for what has gone wrong and waits
 * on them: a routine that keeps failing, switched itself off or waits for a sign-in; a card left
 * unanswered for half a day; a connection of theirs that signed out. The looking takes no AI: only
 * what is recorded is read, as the routine health and Today read it.
 *
 * When something is new, one bot tells the person in their own conversation (a manager they may
 * talk with, else the bot they last wrote to), in a turn that only looks: it may check where things
 * stand, but changes nothing, and a fix waits for the person's answer. When nothing is new nobody
 * hears of it, and what was told is not told again for a week while it stands. The turn goes as a
 * follow-up does, so it reaches the chat app the person talks from too. Each person turns it off
 * for themselves.
 */
export class CheckInService {
  private passes = new Set<Promise<unknown>>();
  private stopped = false;

  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  /** Wait until no pass is running (tests). */
  async idle(): Promise<void> {
    while (this.passes.size) await Promise.all([...this.passes]);
  }

  async shutdown(): Promise<void> {
    this.stopped = true;
    await this.idle();
  }

  /** Looks for everyone whose time it is. Called from the hourly sweep; not waited for. */
  async runDue(): Promise<void> {
    if (this.stopped || this.passes.size) return;
    const pass = (async () => {
      const people = await this.ctx.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(isNull(schema.users.disabledAt));
      for (const { id } of people) {
        if (this.stopped) return;
        await this.run(id).catch((err) => console.warn(`Check-in for ${id} failed: ${String(err)}`));
      }
    })().finally(() => this.passes.delete(pass));
    this.passes.add(pass);
    await pass;
  }

  /** One person's look: what it found, and whether a bot was set to tell them. */
  async run(userId: string): Promise<CheckInResult> {
    const settings = await this.services.settings.all(userId);
    if (!settings.checkIns) return 'off';
    const now = this.clock();
    if (!checkInHour(now, settings.timezone, settings.promiseRemindAt)) return 'notNow';
    const looked = Date.parse((await this.read<string>(lookedKey(userId))) ?? '');
    if (now.getTime() - looked < CHECK_IN_EVERY_MS) return 'notNow';

    const findings = await this.findings(userId, now);
    const was = (await this.read<CheckInState>(stateKey(userId))) ?? { seen: {}, told: {} };
    // Only what still stands is kept: a finding that went away and comes back is new again.
    const state: CheckInState = { seen: {}, told: {} };
    for (const f of findings) {
      state.seen[f.key] = was.seen?.[f.key] ?? now.toISOString();
      if (was.told?.[f.key]) state.told[f.key] = was.told[f.key]!;
    }
    const due = capFindings(dueFindings(findings, state, now), CHECK_IN_MAX_FINDINGS);
    if (!due.length) {
      await this.write(stateKey(userId), state);
      await this.write(lookedKey(userId), now.toISOString());
      return 'quiet';
    }

    const bot = await this.teller(userId);
    if (!bot) {
      // Nobody may tell them now (a pause, a spending limit): the next hour looks again.
      await this.write(stateKey(userId), state);
      return 'noBot';
    }
    const t = translator(settings.language ?? (await this.services.settings.locale()));
    const thread = await this.services.threads.main(bot.id, userId);
    const turn = await this.services.turns.enqueue({
      threadId: thread.id,
      botId: bot.id,
      // Said as a follow-up is: once, in the person's conversation and the chat app they talk from.
      source: 'followup',
      // Only looking: nobody asked for this turn, and a manager bot could otherwise change others.
      modeCap: 'readonly',
      prompt: t('checkIn.prompt', { items: findingLines(due, t).join('\n') }),
      userId,
    });
    for (const f of due) state.told[f.key] = now.toISOString();
    state.turn = { id: turn.id, keys: due.map((f) => f.key) };
    await this.write(stateKey(userId), state);
    await this.write(lookedKey(userId), now.toISOString());
    return 'told';
  }

  /**
   * After a check-in's turn: one that failed told the person nothing, so what it was to tell counts
   * as untold and comes up at the next day's look rather than a week later.
   */
  async onTurnFinished(turn: TurnRow, outcome: TurnOutcome): Promise<void> {
    if (outcome.ok || turn.source !== 'followup' || turn.modeCap !== 'readonly' || !turn.userId) return;
    const state = await this.read<CheckInState>(stateKey(turn.userId));
    if (state?.turn?.id !== turn.id) return;
    for (const key of state.turn.keys) delete state.told[key];
    delete state.turn;
    await this.write(stateKey(turn.userId), state);
  }

  /** What may need the person now, among the bots and the connections that are theirs to see to. */
  async findings(userId: string, now: Date): Promise<CheckInFinding[]> {
    const viewer = await this.services.access.viewerOf(userId);
    const bots = new Map((await this.services.bots.list()).map((b) => [b.id, b]));
    const out: CheckInFinding[] = [];

    // Routines of the bots the person may change, read as the routine health reads them, so what
    // they set aside there stays aside here.
    const health = await this.services.routineHealth.list(viewer);
    const flagged = health.filter((h) =>
      h.findings.some((f) => (ROUTINE_KINDS as readonly string[]).includes(f.id)),
    );
    if (flagged.length) {
      const routines = await this.ctx.db
        .select({ id: schema.routines.id, name: schema.routines.name, botId: schema.routines.botId })
        .from(schema.routines)
        .where(
          inArray(
            schema.routines.id,
            flagged.map((h) => h.routineId),
          ),
        );
      const byId = new Map(routines.map((r) => [r.id, r]));
      for (const h of flagged) {
        const routine = byId.get(h.routineId);
        const bot = routine && bots.get(routine.botId);
        if (!routine || !bot) continue;
        for (const f of h.findings) {
          if (!(ROUTINE_KINDS as readonly string[]).includes(f.id)) continue;
          out.push({
            kind: f.id as RoutineKind,
            key: `routine:${routine.id}:${f.id}`,
            routine: routine.name,
            bot: bot.name,
            count: f.count,
            ...(f.of !== undefined && { of: f.of }),
          });
        }
      }
    }

    // Cards waiting on the person, as their notices go: in their own conversations, in a routine's
    // run (an approval step, which waits for days and outlives a restart) or a team conversation
    // where they asked, or for their second yes once someone gave the first.
    const cards = await this.ctx.db
      .select({
        id: schema.approvals.id,
        botId: schema.approvals.botId,
        threadId: schema.approvals.threadId,
        needsSecond: schema.approvals.needsSecond,
        secondUserId: schema.approvals.secondUserId,
      })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.status, 'pending'),
          lt(schema.approvals.createdAt, new Date(now.getTime() - CHECK_IN_CARD_WAIT_MS)),
        ),
      )
      .orderBy(desc(schema.approvals.createdAt));
    for (const c of cards) {
      const bot = bots.get(c.botId);
      if (!bot) continue;
      const theirs = c.needsSecond
        ? c.secondUserId === userId
        : (await this.services.access.noticeAudience(c.threadId)).includes(userId);
      if (theirs) out.push({ kind: 'card', key: `card:${c.id}`, bot: bot.name });
    }

    // The person's own connections; the server's shared ones are the owner's to see to.
    const connections = await this.ctx.db
      .select({ id: schema.connections.id, name: schema.connections.name, status: schema.connections.status })
      .from(schema.connections)
      .where(
        and(
          inArray(schema.connections.status, ['signed-out', 'error']),
          userId === OWNER_ID
            ? or(eq(schema.connections.userId, userId), isNull(schema.connections.userId))
            : eq(schema.connections.userId, userId),
        ),
      );
    for (const c of connections)
      out.push({
        kind: 'connection',
        key: `connection:${c.id}:${c.status}`,
        name: c.name,
        status: c.status as 'signed-out' | 'error',
      });
    return out;
  }

  /**
   * The bot that tells the person: a manager they may talk with, else the bot they last wrote to;
   * among managers, the one they last wrote to. Null when none may work now (paused, or past a
   * spending limit).
   */
  private async teller(userId: string): Promise<Bot | null> {
    const viewer = await this.services.access.viewerOf(userId);
    const levels = await this.services.access.levels(viewer);
    // A coding agent on the computer starts only on the owner's own words, never on a turn like this.
    const open = (await this.services.bots.list()).filter(
      (b) => b.engine !== 'acp' && atLeast(levels.get(b.id) ?? 'none', 'chat'),
    );
    if (!open.length) return null;
    const recent = await this.ctx.db
      .select({ botId: schema.threads.botId })
      .from(schema.messages)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.messages.threadId))
      .where(
        and(
          eq(schema.threads.userId, userId),
          eq(schema.threads.kind, 'user'),
          eq(schema.messages.role, 'user'),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(50);
    const rank = new Map<string, number>();
    recent.forEach((r, i) => {
      if (!rank.has(r.botId)) rank.set(r.botId, i);
    });
    const order = (b: Bot) => (b.isManager ? 0 : 1) * 1000 + (rank.get(b.id) ?? 999);
    // A bot the person never wrote to is no one they expect to hear from, unless it is a manager.
    const candidates = open.filter((b) => b.isManager || rank.has(b.id)).sort((a, b) => order(a) - order(b));
    for (const bot of candidates) {
      if (await this.services.bots.isPaused(bot)) continue;
      if (await this.services.usage.reached(bot)) continue;
      return bot;
    }
    return null;
  }

  private async read<V>(key: string): Promise<V | null> {
    const [row] = await this.ctx.db
      .select({ value: schema.kv.value })
      .from(schema.kv)
      .where(eq(schema.kv.key, key));
    return (row?.value as V | undefined) ?? null;
  }

  private async write(key: string, value: unknown): Promise<void> {
    await this.ctx.db
      .insert(schema.kv)
      .values({ key, value })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value } });
  }
}
