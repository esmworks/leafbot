import type { Bot, FollowUp, OutsideTrigger } from '@leafbot/shared';
import { and, asc, eq, inArray, lt, lte } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { translator, type T } from '../i18n';
import { newId, notFound, truncate } from '../util';
import { dice, wordsOf } from './routine-suggestions';
import { redactSecrets } from './secrets';
import type { Services } from './index';

type Row = typeof schema.followUps.$inferSelect;

/** Open follow-ups one bot keeps at most for one person, so a flood of mails cannot fill its schedule. */
export const MAX_OPEN_FOLLOW_UPS = 300;
/** The most follow-ups that start a turn in one look; the rest wait for the next minute. */
const FIRE_PER_TICK = 5;
/** A follow-up missed by longer than this while the server was off is dropped, not brought up late. */
const LATE_MS = 24 * 3600_000;
/** Follow-ups that came up or were dropped are kept this long, then removed. */
const KEEP_MS = 30 * 86_400_000;
/** Two follow-ups for the same person and day whose words are this alike are the same one. */
const SAME_WORDS = 0.8;
const TEXT_MAX = 500;
const CONTEXT_MAX = 500;

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

/**
 * Reminders a bot keeps for itself. A routine is the person's standing job: it is shown, the person
 * sets it or says yes to it on a card, and it acts with the bot's own permissions. A follow-up is
 * the bot keeping track: "on Sunday morning, bring up Monday's visit". Nobody is asked before one is
 * set and none shows among the routines; when it falls due the bot gets a turn in its main
 * conversation with the person and tells them, with what it finds then. That turn works for nobody
 * who asked just now, and one set from a mail carries the mail's mark, so anything that would
 * change something still waits for the person's card: the worst a planted mail can do is have the
 * bot bring something up.
 */
export class FollowUpService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking: Promise<void> | null = null;

  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  /** The time now, as the follow-ups read it. */
  now(): Date {
    return this.clock();
  }

  start() {
    if (!this.ctx.config.routinesEnabled || this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.ctx.config.routineTickMs);
    this.timer.unref();
  }

  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
  }

  /**
   * Keeps a follow-up. The same one set again (same bot and person, same day, nearly the same
   * words) is moved to the new time instead of kept twice.
   */
  async add(o: {
    bot: Pick<Bot, 'id'>;
    userId: string;
    threadId: string | null;
    text: string;
    context?: string;
    eventAt?: Date | null;
    dueAt: Date;
    kind?: Row['kind'];
    outside?: OutsideTrigger | null;
    t: T;
  }): Promise<FollowUp> {
    const clean = (s: string, max: number) =>
      redactSecrets(truncate(s.trim(), max), o.t('memory.redacted')).text;
    const text = clean(o.text, TEXT_MAX);
    const context = clean(o.context ?? '', CONTEXT_MAX);
    const open = await this.ctx.db
      .select()
      .from(schema.followUps)
      .where(
        and(
          eq(schema.followUps.botId, o.bot.id),
          eq(schema.followUps.userId, o.userId),
          eq(schema.followUps.status, 'open'),
        ),
      );
    const day = (d: Date | null | undefined) => d?.toISOString().slice(0, 10) ?? '';
    const words = wordsOf(text);
    const same = open.find(
      (r) =>
        (day(r.eventAt) || day(r.dueAt)) === (day(o.eventAt) || day(o.dueAt)) &&
        dice(wordsOf(r.text), words) >= SAME_WORDS,
    );
    if (same) {
      const [row] = await this.ctx.db
        .update(schema.followUps)
        .set({
          text,
          context: context || same.context,
          eventAt: o.eventAt ?? same.eventAt,
          dueAt: o.dueAt,
          // Once outside text is behind it, it stays: the newer words may be the planted ones.
          outside: same.outside ?? o.outside ?? null,
        })
        .where(eq(schema.followUps.id, same.id))
        .returning();
      this.changed();
      return toFollowUp(row!);
    }
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
        eventAt: o.eventAt ?? null,
        dueAt: o.dueAt,
        kind: o.kind ?? 'bot',
        outside: o.outside ?? null,
        createdAt: this.clock(),
      })
      .returning();
    this.changed();
    return toFollowUp(row!);
  }

  /** The person's open follow-ups, soonest first; with `botId`, one bot's. */
  async list(userId: string, botId?: string): Promise<FollowUp[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.followUps)
      .where(
        and(
          eq(schema.followUps.userId, userId),
          eq(schema.followUps.status, 'open'),
          botId ? eq(schema.followUps.botId, botId) : undefined,
        ),
      )
      .orderBy(asc(schema.followUps.dueAt));
    return rows.map(toFollowUp);
  }

  /** Drops an open follow-up of the person's (or, with `botId`, of that bot's for them). */
  async drop(id: string, userId: string, botId?: string): Promise<void> {
    const [row] = await this.ctx.db.select().from(schema.followUps).where(eq(schema.followUps.id, id));
    if (!row || row.userId !== userId || (botId && row.botId !== botId)) throw notFound('followUp');
    if (row.status !== 'open') return;
    await this.ctx.db
      .update(schema.followUps)
      .set({ status: 'dropped', firedAt: this.clock() })
      .where(eq(schema.followUps.id, id));
    this.changed();
  }

  /** Whether a follow-up has come up already: a promise kept by one is then done. */
  async fired(id: string): Promise<boolean> {
    const [row] = await this.ctx.db
      .select({ status: schema.followUps.status })
      .from(schema.followUps)
      .where(eq(schema.followUps.id, id));
    return row?.status === 'fired';
  }

  /** One look: brings up what is due, drops what was missed too long ago, clears out old ones. */
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
      if (fired >= FIRE_PER_TICK) break;
      if (now.getTime() - row.dueAt.getTime() > LATE_MS) {
        await this.close(row.id, 'dropped');
        continue;
      }
      const bot = await this.services.bots.get(row.botId).catch(() => null);
      if (!bot || bot.archivedAt) {
        await this.close(row.id, 'dropped');
        continue;
      }
      // A paused bot, or one past a spending limit, brings it up once it may work again (within a day).
      if ((await this.services.bots.isPaused(bot)) || (await this.services.usage.reached(bot))) continue;
      // Someone who can no longer use the bot is told nothing by it.
      if (
        (await this.services.access.level(await this.services.access.viewerOf(row.userId), bot.id)) === 'none'
      ) {
        await this.close(row.id, 'dropped');
        continue;
      }
      if (await this.fire(row, bot)) fired++;
    }
    if (fired) this.changed();
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
    const when = (d: Date) =>
      new Intl.DateTimeFormat(locale === 'tr' ? 'tr-TR' : 'en-GB', {
        dateStyle: 'full',
        timeStyle: 'short',
        timeZone: settings.timezone,
      }).format(d);
    const turn = await this.services.turns.enqueue({
      threadId: thread.id,
      botId: bot.id,
      source: 'followup',
      prompt: t('followUp.prompt', {
        text: row.text,
        context: row.context || '-',
        event: row.eventAt ? when(row.eventAt) : '-',
        set: when(row.createdAt),
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

  private changed() {
    this.ctx.bus.refresh({ scope: 'followUps' });
  }
}

/** The bot keeps as many follow-ups for the person as it may; one has to come up or go first. */
export class FollowUpsFull extends Error {
  constructor() {
    super('follow-ups full');
  }
}
