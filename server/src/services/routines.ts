import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Bot, BotEmail, BotTable, OutsideTrigger, RoutineUpdate, TableRow } from '@leafbot/shared';
import {
  APPROVAL_TIMED_OUT,
  cellText,
  cronTooOften,
  fillFilter,
  filterVars,
  INTL_LOCALE,
  MIN_RUN_GAP_MINUTES,
  ROUTINE_APPROVAL_TOOL,
  ROUTINE_VAR_MAX,
  ROUTINE_VARS_MAX,
  nextRun,
  parseFields,
  valueAt,
  zonedTime,
  wallClock,
  occurrenceKey,
  parseFilter,
  passesFilter,
  stepRoutesProblem,
  type Routine,
  type RoutineCheck,
  type RoutineCondition,
  type RoutineCreate,
  type RoutineRevision,
  type RoutineRun,
  type RoutineStep,
  type RoutineStepWhen,
  type Schedule,
} from '@leafbot/shared';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  notLike,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { z } from 'zod';
import type { Ctx } from '../context';
import { isServerKey, type T } from '../i18n';
import { isSilentReply, SILENT_REPLY } from '../engine/types';
import { schema } from '../db';
import type { Engine, GateRequest, GateVerdict, TurnOutcome } from '../engine/types';
import type { TurnRow } from '../runtime/turns';
import { cutAt, errorText, HttpError, isUniqueViolation, newId, notFound, truncate } from '../util';
import { checkSignature, signatureAllows } from './webhook-signatures';
import { toRoutine, toRun } from './mappers';
import { botStepAt, handedOn, jsonIn, routeFrom, snapshotSteps, stepList, varsWanted } from './routine-steps';
import { fetchPublic, fetchPublicText } from './skill-link';
import { mailText } from './email';
import { describeWhen, RoutineConditions, stepWhenHolds, type ConditionResult } from './routine-conditions';
import type { Services } from '.';

/** The largest watched page read, and how much of its text goes to the bot. */
const WATCH_MAX = 2 * 1024 * 1024;
const WATCH_EXCERPT = 6000;
/** How much of a watched page's text is kept to show the next change as what changed. */
const WATCH_KEEP = 200_000;
/** The most of each side of a page change the pre-check reads. */
const DIFF_MAX = 3000;

/**
 * What changed between two readings of a page, as the sentences removed and added. A page's text
 * is one long line, so it is compared sentence by sentence; null when nothing differs that way.
 */
export function pageDiff(before: string, after: string): string | null {
  const parts = (text: string) =>
    text
      .split(/(?<=[.!?;:|•])\s+/)
      .map((p) => p.trim())
      .filter(Boolean);
  const was = new Set(parts(before));
  const now = new Set(parts(after));
  const removed = [...was].filter((p) => !now.has(p));
  const added = [...now].filter((p) => !was.has(p));
  if (!removed.length && !added.length) return null;
  const side = (label: string, list: string[]) =>
    list.length ? `${label}:\n${cutAt(list.map((p) => `- ${p}`).join('\n'), DIFF_MAX)}` : `${label}: (none)`;
  return `${side('Removed', removed)}\n\n${side('Added', added)}`;
}

/** A page's readable text: no scripts, styles or tags, spaces collapsed, so markup churn is not a change. */
export function pageText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The longest previous report carried into a run. */
const REPORT_MAX = 4000;

/**
 * The longest answer a fetch step keeps: an extract step after it needs all of it, so a longer one
 * is refused rather than cut into JSON that no longer reads.
 */
const FETCH_MAX = 256 * 1024;
/** How long a fetch step waits for the address, and how many redirects it follows. */
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_REDIRECTS = 3;
/**
 * The most of what reached it that a notify step, or a run ending at a step passed over, sends:
 * a fetch step's answer can be far longer than anything a person reads in a message.
 */
const DELIVER_MAX = 20_000;
const VAR_IN_TEXT = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g;

/**
 * How many of a routine's latest instructions in a conversation are looked through for the ones of
 * a run that ended with nothing to report: the run's own are the newest, one per step.
 */
const QUIET_LOOKBACK = 50;

/** The most of what a quiet run wrote of why that its line in the main conversation keeps. */
const QUIET_NOTE_MAX = 2000;

/** A write that is part of a larger one, so they succeed or fail together. */
type Tx = Parameters<Parameters<Ctx['db']['transaction']>[0]>[0];
type RoutineRow = typeof schema.routines.$inferSelect;
type RunRow = typeof schema.routineRuns.$inferSelect;

/** The report inside markers it cannot close itself, so it stays read as data. */
export function fence(report: string): string {
  return `<<<\n${report.replaceAll('>>>', '> > >')}\n>>>`;
}

export class RoutineService {
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private stopped = false;
  /** Runs whose pre-check is under way; their turn starts when it answers. */
  private checking = new Set<Promise<void>>();
  private stopChecks = new AbortController();
  /** Routines reading their page or app before a run, by id; a later pass leaves them be. */
  private watching = new Map<string, Promise<void>>();
  /** Reads that may run at once, and those waiting for one of them to end. */
  private readSlots = MAX_READS;
  private readWaiting: (() => void)[] = [];
  /** The pass over answered approval steps under way, and whether another was asked for meanwhile. */
  private settling: Promise<void> | null = null;
  private settleAgain = false;
  /** Looks at a routine's condition with no AI before a scheduled run. */
  private conditions: RoutineConditions;
  /**
   * Fetch and extract steps under way. They run apart from what started them (a webhook's call, a
   * card's answer), which would otherwise wait as long as the address takes to answer.
   */
  private dataWork = new Set<Promise<void>>();

  constructor(
    private ctx: Ctx,
    private services: Services,
    /** The bot's own engine does the pre-check, as it does the run. */
    private engineFor: (bot: Bot) => Engine,
    private clock: () => Date = () => new Date(),
  ) {
    this.conditions = new RoutineConditions(ctx, services, clock);
    // A card answered anywhere (the app, a phone, a chat channel) lets a run held at it go on.
    ctx.bus.on('refresh', (e) => {
      if (e.scope === 'approvals')
        void this.settleSteps().catch((err: unknown) => console.error('routine approval steps', err));
    });
  }

  start() {
    this.stopped = false;
    if (this.stopChecks.signal.aborted) this.stopChecks = new AbortController();
    if (!this.ctx.config.routinesEnabled || this.timer) return;
    void this.runStartup();
    void this.pass();
    this.timer = setInterval(() => void this.pass(), this.ctx.config.routineTickMs);
    this.timer.unref();
  }

  /** Stops the schedule and waits for a tick under way, so it does not outlive the database. */
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.ticking;
    this.stopChecks.abort();
    await this.settled();
    await this.settling;
  }

  /** Waits for the page and app reads and the pre-checks under way, and the turns they start to be queued. */
  async settled() {
    while (this.watching.size || this.checking.size || this.dataWork.size)
      await Promise.all([...this.watching.values(), ...this.checking, ...this.dataWork]);
  }

  /**
   * End runs left active with no turn to finish them: the server stopped between recording the
   * run and queueing its turn. Without this the routine would be skipped as "still running"
   * forever. Call after the turns' own recovery, which ends runs whose turn was cut short.
   */
  async recover() {
    const t = await this.services.settings.translator();
    const orphaned = await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'error', reason: t('turn.serverRestarted'), finishedAt: this.clock() })
      .where(
        and(
          inArray(schema.routineRuns.status, ['running', 'waiting']),
          notExists(
            this.ctx.db
              .select({ id: schema.turns.id })
              .from(schema.turns)
              .where(
                and(
                  eq(schema.turns.routineRunId, schema.routineRuns.id),
                  inArray(schema.turns.status, ['queued', 'running']),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.routineRuns.id });
    if (orphaned.length) {
      // The step each was at ends with it.
      await this.ctx.db
        .update(schema.routineStepRuns)
        .set({ status: 'error', reason: t('turn.serverRestarted'), finishedAt: this.clock() })
        .where(
          and(
            inArray(
              schema.routineStepRuns.runId,
              orphaned.map((o) => o.id),
            ),
            eq(schema.routineStepRuns.status, 'running'),
          ),
        );
      this.ctx.bus.refresh({ scope: 'routines' });
    }
    // Runs that waited for one the stop cut short go on now.
    const waiting = await this.ctx.db
      .selectDistinct({ routineId: schema.routineRuns.routineId })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.status, 'queued'));
    for (const { routineId } of waiting) await this.startQueued(routineId);
    // A card answered just before the stop lets its run go on now.
    await this.settleSteps();
  }

  /** Runs each enabled routine set to run when the server starts, once for this start. */
  async runStartup() {
    const due = await this.ctx.db
      .select()
      .from(schema.routines)
      .where(and(eq(schema.routines.enabled, true), eq(schema.routines.onStartup, true)));
    const at = `startup:${this.clock().toISOString()}`;
    for (const row of due) {
      await this.fire(toRoutine(row), at).catch((err) =>
        console.warn(`Startup run of routine ${row.id} failed: ${String(err)}`),
      );
    }
  }

  async list(botId?: string): Promise<Routine[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.routines)
      .where(botId ? eq(schema.routines.botId, botId) : undefined)
      .orderBy(asc(schema.routines.createdAt));
    return rows.map(toRoutine);
  }

  async get(id: string): Promise<Routine> {
    const [row] = await this.ctx.db.select().from(schema.routines).where(eq(schema.routines.id, id)).limit(1);
    if (!row) throw notFound('routine');
    return toRoutine(row);
  }

  /** A new routine; its runs work for `userId`, or for the bot's owner when null. */
  async create(input: RoutineCreate, userId: string | null = null): Promise<Routine> {
    await this.services.bots.get(input.botId);
    this.checkOften(input.schedule);
    const [{ made } = { made: 0 }] = await this.ctx.db
      .select({ made: count() })
      .from(schema.routines)
      .where(eq(schema.routines.botId, input.botId));
    if (made >= MAX_ROUTINES_PER_BOT)
      throw new HttpError(400, 'error.routineLimit', { max: MAX_ROUTINES_PER_BOT });
    checkRoutes(input.steps);
    if (input.check) await this.checkCheck(input.botId, input.check, userId, !!input.slackChannel);
    if (input.condition)
      await this.checkCondition(
        input.botId,
        input.condition,
        userId ?? (await this.services.access.botOwner(input.botId)),
        input.slackChannel,
      );
    if (input.whatsappGroup || input.whatsappPeople) {
      checkWhatsAppPlace(input.slackChannel);
      await this.checkGroup(userId ?? (await this.services.access.botOwner(input.botId)));
    }
    if (input.tableTrigger) await this.checkTable(input.botId, input.tableTrigger, input.tableFilter);
    const now = this.clock();
    this.checkOnce(input.schedule, input.timezone, now);
    // The routine and the first line of its history are written together, or neither is.
    const row = await this.ctx.db.transaction(async (tx) => {
      const [made] = await tx
        .insert(schema.routines)
        .values({
          id: newId(),
          ...input,
          // A routine brought back from an older record has no such field.
          reportOnly: input.reportOnly ?? false,
          createdByUserId: userId,
          nextRunAt: input.enabled ? nextRun(input.schedule, input.timezone, now) : null,
        })
        .returning();
      await tx
        .insert(schema.routineRevisions)
        .values({ id: newId(), routineId: made!.id, prompt: made!.prompt, createdAt: now });
      return made;
    });
    this.ctx.bus.refresh({ scope: 'routines' });
    return toRoutine(row!);
  }

  /** Whom a routine's runs work for: whoever set it up, or the bot's owner for one from before people. */
  async personOf(routine: Pick<Routine, 'botId' | 'createdByUserId'>): Promise<string> {
    return routine.createdByUserId ?? (await this.services.access.botOwner(routine.botId));
  }

  /**
   * Changes a routine. `by` is the person changing it: a routine works for whoever last said what
   * it does, so one changed by someone else works for them from then on. Otherwise anyone who may
   * change the bot could have another person's routine act with that person's apps, sign-ins and
   * notes. Only pausing or resuming it leaves it whose it was.
   */
  async update(id: string, patch: z.infer<typeof RoutineUpdate>, by?: string): Promise<Routine> {
    const current = await this.get(id);
    const schedule = (patch.schedule ?? current.schedule) as Schedule;
    const timezone = patch.timezone ?? current.timezone;
    const enabled = patch.enabled ?? current.enabled;
    const last = current.lastRunAt ? new Date(current.lastRunAt) : null;
    if (patch.schedule) this.checkOnce(schedule, timezone, this.clock());
    if (patch.steps) checkRoutes(patch.steps);
    // Also when one is turned on: an imported routine comes paused, its schedule never checked.
    if (patch.schedule || (enabled && !current.enabled)) this.checkOften(schedule);
    const was = await this.personOf(current);
    const shapes = Object.keys(patch).some((k) => k !== 'enabled');
    const person = by && shapes ? by : was;
    // The check runs for the routine's person: a new one, or the old one for its new person.
    const check = patch.check !== undefined ? patch.check : person !== was ? current.check : null;
    const slackChannel = patch.slackChannel !== undefined ? patch.slackChannel : current.slackChannel;
    if (check) await this.checkCheck(current.botId, check, person, !!slackChannel);
    // The condition reads for the routine's person too: a new one, or the old one for its new person.
    const condition =
      patch.condition !== undefined ? patch.condition : person !== was ? (current.condition ?? null) : null;
    if (condition) await this.checkCondition(current.botId, condition, person, slackChannel);
    // WhatsApp is read for the person whose WhatsApp it is, also once the routine changes hands.
    const group = patch.whatsappGroup !== undefined ? patch.whatsappGroup : current.whatsappGroup;
    const people = patch.whatsappPeople ?? current.whatsappPeople ?? false;
    if (group || people) {
      checkWhatsAppPlace(slackChannel);
      const turnedOn =
        (patch.whatsappGroup !== undefined && !!patch.whatsappGroup) ||
        (patch.whatsappPeople && !current.whatsappPeople);
      if (turnedOn || person !== was) await this.checkGroup(person);
    }
    const tableId = patch.tableTrigger !== undefined ? patch.tableTrigger : current.tableTrigger;
    if (tableId && (patch.tableTrigger !== undefined || patch.tableFilter !== undefined))
      await this.checkTable(current.botId, tableId, patch.tableFilter ?? current.tableFilter ?? '');
    // A changed instruction goes into the history in the same write: a failed save leaves none.
    const row = await this.ctx.db.transaction(async (tx) => {
      const [saved] = await tx
        .update(schema.routines)
        .set({
          ...patch,
          ...(person !== was && { createdByUserId: person }),
          // A new check starts from its own first answer, not from what the old one returned.
          ...(patch.check !== undefined && { checkHash: null }),
          nextRunAt: enabled ? nextRun(schedule, timezone, this.clock(), last) : null,
          // A retry waiting is dropped with the slot it stood in front of.
          resumeAt: null,
          // Turning it on or off by hand ends the self-switch-off, and a routine turned on starts
          // counting failures from none: it would otherwise be switched off again by its next one.
          ...(patch.enabled !== undefined && { pausedReason: null }),
          ...(enabled && !current.enabled && { failureStreak: 0 }),
        })
        .where(eq(schema.routines.id, id))
        .returning();
      if (patch.prompt !== undefined && patch.prompt !== current.prompt)
        await this.keepRevision(tx, current, patch.prompt);
      return saved;
    });
    // Pausing a routine also ends a run of it that waits on the person; one at work goes on.
    if (current.enabled && !enabled) {
      const t = await this.services.settings.translator();
      await this.endStaleWait(id, t, 0, 'routine.pausedWait');
      await this.endHeld(id, t('routine.pausedWait'));
      // What waited for a run of it is not run either.
      await this.startQueued(id);
    }
    this.ctx.bus.refresh({ scope: 'routines' });
    return toRoutine(row!);
  }

  /**
   * Writes a changed instruction into the routine's history. A routine made before the history
   * was kept gets its old instruction written first, dated when the routine was made, so the
   * first change can still be undone.
   */
  private async keepRevision(db: Tx, current: Routine, prompt: string) {
    const [first] = await db
      .select({ id: schema.routineRevisions.id })
      .from(schema.routineRevisions)
      .where(eq(schema.routineRevisions.routineId, current.id))
      .limit(1);
    const now = this.clock();
    const rows = [
      ...(first
        ? []
        : [
            {
              id: newId(),
              routineId: current.id,
              prompt: current.prompt,
              // Never after the change itself, whatever the clocks say.
              createdAt: new Date(Math.min(Date.parse(current.createdAt), now.getTime() - 1)),
            },
          ]),
      { id: newId(), routineId: current.id, prompt, createdAt: now },
    ];
    await db.insert(schema.routineRevisions).values(rows);
  }

  /** The instructions the routine has had, newest first; the first is the one it has now. */
  async revisions(routineId: string, limit = 50): Promise<RoutineRevision[]> {
    const routine = await this.get(routineId);
    const rows = await this.ctx.db
      .select()
      .from(schema.routineRevisions)
      .where(eq(schema.routineRevisions.routineId, routineId))
      .orderBy(desc(schema.routineRevisions.createdAt), desc(schema.routineRevisions.id))
      .limit(limit);
    const list = rows.map((r) => ({ id: r.id, prompt: r.prompt, createdAt: r.createdAt.toISOString() }));
    // A routine never changed since before the history was kept has only the one it has now.
    return list.length ? list : [{ id: routine.id, prompt: routine.prompt, createdAt: routine.createdAt }];
  }

  /**
   * A check must be a tool the bot itself may call without asking: of an app open to it, switched
   * on, and one that only reads. It runs with no one watching, so it may never change anything.
   */
  private async checkCheck(botId: string, check: RoutineCheck, userId: string | null, team = false) {
    // The check runs for the routine's person: only the team's apps and theirs; for a routine
    // reporting to Slack, the team's alone.
    const person = team ? null : (userId ?? (await this.services.access.botOwner(botId)));
    const tool = await this.services.connections.checkTool(botId, check.connectionId, check.tool, person);
    if (!tool) throw new HttpError(400, 'error.routineCheckTool');
  }

  /**
   * A condition may only look at what is kept for it: a check that something is absent from a
   * source nobody collects would always hold. Each check reads for the routine's person.
   */
  private async checkCondition(
    botId: string,
    condition: RoutineCondition,
    person: string,
    slackChannel: string | null | undefined,
  ) {
    for (const c of condition.checks) {
      if (c.kind === 'tool') await this.checkCheck(botId, { ...c }, person, !!slackChannel);
      else if (c.kind === 'table') await this.checkTable(botId, c.tableId, c.filter);
      else if (c.kind === 'files' && c.folder === 'group') {
        const bot = await this.services.bots.get(botId);
        if (!bot.groupId) throw new HttpError(400, 'error.routineConditionGroup');
      } else if (c.kind === 'email') {
        const [address] = await this.ctx.db
          .select({ name: schema.emailAddresses.name })
          .from(schema.emailAddresses)
          .where(eq(schema.emailAddresses.botId, botId))
          .limit(1);
        if (!address) throw new HttpError(400, 'error.routineConditionEmail');
      } else if (c.kind === 'whatsapp') {
        checkWhatsAppPlace(slackChannel);
        await this.checkGroup(person);
        const [follows] = await this.ctx.db
          .select({ id: schema.routines.id })
          .from(schema.routines)
          .where(or(isNotNull(schema.routines.whatsappGroup), eq(schema.routines.whatsappPeople, true)))
          .limit(1);
        if (!follows) throw new HttpError(400, 'error.routineConditionWhatsapp');
      }
    }
  }

  /** What the routine's condition says now, with no AI; null for a routine with none. */
  async conditionNow(id: string): Promise<ConditionResult | null> {
    const routine = await this.get(id);
    if (!routine.condition) return null;
    return this.conditions.evaluate(routine, routine.condition, await this.services.settings.translator());
  }

  /** A one-time run must be ahead; one set in the past would run at once by surprise. */
  private checkOnce(s: Schedule, tz: string, now: Date) {
    if (s.type === 'once' && zonedTime(s.date, s.time, tz).getTime() < now.getTime() - 60_000) {
      throw new HttpError(400, 'validation.datePast');
    }
  }

  /**
   * A cron schedule may not run closer together than an interval may: one set to every minute
   * would start the bot, and spend on it, all day long.
   */
  private checkOften(s: Schedule) {
    if (s.type === 'cron' && cronTooOften(s.expr)) {
      throw new HttpError(400, 'validation.cronTooOften', { minutes: MIN_RUN_GAP_MINUTES });
    }
  }

  async remove(id: string) {
    // Work the routine queued and nobody started goes with it; a run under way finishes.
    const queued = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .innerJoin(schema.routineRuns, eq(schema.routineRuns.id, schema.turns.routineRunId))
      .where(and(eq(schema.routineRuns.routineId, id), eq(schema.turns.status, 'queued')));
    for (const turn of queued) await this.services.turns.cancelQueued(turn.id);
    // A run held at an approval step goes with it, and its card closes.
    await this.endHeld(id, (await this.services.settings.translator())('routine.pausedWait'));
    await this.ctx.db.delete(schema.routines).where(eq(schema.routines.id, id));
    this.ctx.bus.refresh({ scope: 'routines' });
  }

  async runs(routineId: string, limit = 30): Promise<RoutineRun[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.routineId, routineId))
      .orderBy(desc(schema.routineRuns.startedAt))
      .limit(limit);
    // A run whose turn has not started yet waits for its bot to finish something else: it reads as
    // in line, not as running, and says why.
    const active = rows.filter((r) => r.status === 'running').map((r) => r.id);
    const queued = active.length
      ? new Set(
          (
            await this.ctx.db
              .select({ run: schema.turns.routineRunId })
              .from(schema.turns)
              .where(and(inArray(schema.turns.routineRunId, active), eq(schema.turns.status, 'queued')))
          ).map((x) => x.run),
        )
      : new Set<string | null>();
    // A run with steps shows each of them; those a finished run never reached read as skipped.
    const stepped = rows.filter((r) => r.stepsSnapshot).map((r) => r.id);
    const stepRows = stepped.length
      ? await this.ctx.db
          .select()
          .from(schema.routineStepRuns)
          .where(inArray(schema.routineStepRuns.runId, stepped))
      : [];
    const t = queued.size ? await this.services.settings.translator() : null;
    return rows.map((r) => {
      const run = toRun(r);
      const shown =
        t && queued.has(r.id)
          ? { ...run, status: 'waiting' as const, reason: t('routine.waitingForBot') }
          : run;
      const steps = snapshotSteps(r.stepsSnapshot);
      if (!steps) return shown;
      const going =
        r.status === 'running' || r.status === 'waiting' || r.status === 'queued' || r.status === 'paused';
      const list = stepList(
        steps,
        stepRows.filter((x) => x.runId === r.id),
      ).map((x) => (x.status === 'pending' && !going ? { ...x, status: 'skipped' as const } : x));
      return { ...shown, steps: list };
    });
  }

  /**
   * Fire every due routine once, and wait for the pages and apps read for it. Safe to call
   * concurrently and repeatedly.
   */
  async tick() {
    await this.pass();
    while (this.watching.size) await Promise.all([...this.watching.values()]);
  }

  /**
   * One pass over the due routines. A routine that reads a page or an app first does that on the
   * side, a few at a time: a slow one (an app may take minutes to answer) holds up neither the
   * other routines nor the next pass.
   */
  private async pass() {
    if (this.ticking || this.stopped) return;
    this.ticking = this.runDue().finally(() => {
      this.ticking = null;
    });
    await this.ticking;
  }

  private async runDue() {
    const now = this.clock();
    let due: RoutineRow[];
    let t: T;
    try {
      await this.expireOverdue(now);
      // Answers a refresh did not bring (another server's, one given while a pass was failing).
      await this.settleSteps();
      due = await this.ctx.db
        .select()
        .from(schema.routines)
        .where(
          and(
            eq(schema.routines.enabled, true),
            isNotNull(schema.routines.nextRunAt),
            lte(schema.routines.nextRunAt, now),
          ),
        );
      t = await this.services.settings.translator();
    } catch (err) {
      console.error('routine tick', err);
      return;
    }
    for (const r of due) {
      // One still reading from an earlier pass is not started a second time.
      if (this.watching.has(r.id)) continue;
      if (r.watchUrl || r.check || r.condition) {
        const read = this.readSlot()
          .then(async () => {
            try {
              if (!this.stopped) await this.runOne(r, now, t);
            } finally {
              this.freeReadSlot();
            }
            this.ctx.bus.refresh({ scope: 'routines' });
          })
          .catch((err) => console.error(`Routine ${r.id} could not run`, err))
          .finally(() => this.watching.delete(r.id));
        this.watching.set(r.id, read);
      } else {
        await this.runOne(r, now, t);
      }
    }
    if (due.length) this.ctx.bus.refresh({ scope: 'routines' });
  }

  private async readSlot() {
    if (this.readSlots > 0) {
      this.readSlots--;
      return;
    }
    await new Promise<void>((resolve) => this.readWaiting.push(resolve));
  }

  private freeReadSlot() {
    const next = this.readWaiting.shift();
    if (next) next();
    else this.readSlots++;
  }

  /**
   * Runs one due routine and moves it on to its next slot. What goes wrong with it is recorded as
   * its failed run and leaves the other routines alone; the slot passes either way, so a fault that
   * lasts is not tried again on every pass.
   */
  private async runOne(listed: RoutineRow, now: Date, t: T) {
    // The routine as it is now: one paused, edited or deleted meanwhile (a watched page takes a
    // while to read) is not run from the copy read at the start of the pass.
    const current = async (r: RoutineRow) => {
      const [row] = await this.ctx.db.select().from(schema.routines).where(eq(schema.routines.id, r.id));
      return row?.enabled && row.nextRunAt?.getTime() === r.nextRunAt!.getTime() ? row : null;
    };
    let r: RoutineRow | null;
    try {
      r = await current(listed);
    } catch (err) {
      console.error(`Routine ${listed.id} could not be read`, err);
      return;
    }
    if (!r) return;
    const routine = r;
    const occurrence = occurrenceKey(routine.nextRunAt!);
    try {
      const late = now.getTime() - routine.nextRunAt!.getTime() > MISSED_GRACE_MS;
      const waitingOn = await this.signInStillWaiting(routine);
      if (waitingOn) {
        await this.record(
          toRoutine(routine),
          occurrence,
          'skipped',
          t('routine.signInSkipped', { name: waitingOn }),
        );
      } else if (late && routine.missed === 'skip') {
        await this.record(toRoutine(routine), occurrence, 'skipped', t('routine.missedSkipped'));
      } else if (routine.condition && (await this.conditionStops(routine, now, occurrence, t))) {
        // Looked at before the page and the app's check: those keep what they read as they read it,
        // so a change they found would be lost on a run the condition held back.
      } else if (routine.watchUrl || routine.check) {
        // A watched page and an app's check are read with no AI; the bot runs only when one of
        // them changed, and gets what is new.
        const news: string[] = [];
        // What the pre-check reads: what changed on the page (or, without its earlier text, the
        // page as it is now) and the app's new answer.
        const changes: string[] = [];
        if (routine.watchUrl) {
          const changed = await this.pageChanged(
            routine.id,
            routine.watchUrl,
            routine.watchHash,
            routine.watchText,
          );
          if (changed !== null) {
            news.push(t('routine.watchChanged', { url: routine.watchUrl, text: changed.excerpt }));
            changes.push(`Page ${routine.watchUrl}:\n${changed.diff ?? changed.excerpt}`);
          }
        }
        if (routine.check) {
          const check = routine.check as RoutineCheck;
          const changed = await this.checkChanged(
            routine.id,
            routine.botId,
            check,
            routine.checkHash,
            routine.createdByUserId,
            !!routine.slackChannel,
          );
          if (changed) {
            news.push(t('routine.checkChanged', { app: changed.app, tool: check.tool, text: changed.text }));
            changes.push(`App ${changed.app}, tool ${check.tool}, new answer:\n${changed.text}`);
          }
        }
        // Its new answer is already kept: a change found while the server stops still runs.
        const still = news.length ? await current(routine) : null;
        if (still)
          await this.fire(
            toRoutine(still),
            occurrence,
            news.join('\n\n'),
            false,
            { trigger: 'watch', input: changes.join('\n\n') },
            undefined,
            undefined,
            true,
          );
      } else {
        await this.fire(
          toRoutine(routine),
          occurrence,
          undefined,
          false,
          undefined,
          undefined,
          undefined,
          true,
        );
      }
    } catch (err) {
      console.error(`Routine ${routine.id} could not run`, err);
      await this.recordFailure(toRoutine(routine), occurrence, err, t).catch((e) =>
        console.error(`Failed run of routine ${routine.id} could not be recorded`, e),
      );
    }
    await this.advance(routine).catch((err) =>
      console.error(`Routine ${routine.id} could not move to its next run`, err),
    );
  }

  /**
   * Looks at the routine's condition before a scheduled run; true when the run must not start.
   * Not met, it is looked at again later the same day when the routine says so, as long as that
   * comes before its next regular run; at the end its note, if it has one, goes where it reports.
   * A check that could not be read holds the run back too, but never sends the note: the note says
   * something did not come, which nobody knows then.
   */
  private async conditionStops(row: RoutineRow, now: Date, occurrence: string, t: T): Promise<boolean> {
    const routine = toRoutine(row);
    const condition = routine.condition!;
    const result = await this.conditions.evaluate(routine, condition, t);
    if (result.outcome === 'holds') return false;
    const reason = result.lines.join('; ');
    const schedule = row.schedule as Schedule;
    if (condition.recheckMinutes && condition.recheckUntil) {
      const w = wallClock(now, row.timezone);
      const p = (n: number) => String(n).padStart(2, '0');
      const until = zonedTime(`${w.year}-${p(w.month)}-${p(w.day)}`, condition.recheckUntil, row.timezone);
      const again = new Date(now.getTime() + condition.recheckMinutes * 60_000);
      const regular =
        schedule.type === 'once'
          ? null
          : (row.resumeAt ?? nextRun(schedule, row.timezone, now, row.nextRunAt));
      if (again.getTime() <= until.getTime() && (!regular || again.getTime() < regular.getTime())) {
        // `advance` then leaves the slot alone: it moves on only from the slot it was due at.
        await this.ctx.db
          .update(schema.routines)
          .set({ nextRunAt: again, resumeAt: regular })
          .where(and(eq(schema.routines.id, row.id), eq(schema.routines.nextRunAt, row.nextRunAt!)));
        const hm = wallClock(again, row.timezone);
        await this.recordQuiet(
          routine,
          occurrence,
          'skipped',
          t('routine.conditionRecheck', { reason, at: `${p(hm.hour)}:${p(hm.minute)}` }),
        );
        return true;
      }
    }
    if (result.outcome === 'fails' && condition.otherwise)
      await this.post(
        routine,
        condition.otherwise,
        `cond:${occurrence}`,
        t('routine.conditionSkipped', { reason }),
      );
    else
      await this.recordQuiet(
        routine,
        occurrence,
        result.outcome === 'unreadable' ? 'error' : 'skipped',
        t(result.outcome === 'unreadable' ? 'routine.conditionError' : 'routine.conditionSkipped', {
          reason,
        }),
      );
    return true;
  }

  /**
   * Records a slot the routine did not run, as one line with the one before it when that one ended
   * the same way for the same reason: a routine every five minutes whose condition is not met for a
   * day leaves one line, not hundreds.
   */
  private async recordQuiet(
    routine: Routine,
    occurrence: string,
    status: 'skipped' | 'error',
    reason: string,
  ) {
    const [last] = await this.ctx.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.routineId, routine.id))
      .orderBy(desc(schema.routineRuns.startedAt), desc(schema.routineRuns.id))
      .limit(1);
    if (last?.status === status && last.reason === reason) {
      await this.ctx.db
        .update(schema.routineRuns)
        .set({ finishedAt: this.clock() })
        .where(eq(schema.routineRuns.id, last.id));
      return;
    }
    await this.record(routine, occurrence, status, reason);
  }

  /**
   * The name of the connection a run of this routine found signed out, while it still is; null
   * when nothing waits. Once the person has signed in again (or the connection is gone) the wait
   * is cleared, so the slot runs.
   */
  private async signInStillWaiting(r: RoutineRow): Promise<string | null> {
    if (!r.signInWait) return null;
    const [c] = await this.ctx.db
      .select({ name: schema.connections.name, status: schema.connections.status })
      .from(schema.connections)
      .where(eq(schema.connections.id, r.signInWait));
    if (c?.status === 'signed-out') return c.name;
    await this.ctx.db
      .update(schema.routines)
      .set({ signInWait: null })
      .where(and(eq(schema.routines.id, r.id), eq(schema.routines.signInWait, r.signInWait)));
    this.ctx.bus.refresh({ scope: 'routines' });
    return null;
  }

  /**
   * A run of a routine found one of its connections signed out. Its next scheduled runs are skipped
   * until the person signs in again, and the person is told where they are rather than only in the
   * routine's conversation, which they may not open for days: on the phone, in Telegram or
   * WhatsApp (through the notice), and in a direct message from the Slack app when they linked it.
   * Told once per sign-out: a run that finds the same wait says nothing new.
   */
  async signInLost(runId: string, connection: { id: string; name: string }): Promise<void> {
    const [row] = await this.ctx.db
      .select({ routine: schema.routines, threadId: schema.routineRuns.threadId })
      .from(schema.routineRuns)
      .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .where(eq(schema.routineRuns.id, runId));
    if (!row) return;
    const { routine, threadId } = row;
    if (routine.signInWait === connection.id) return;
    await this.ctx.db
      .update(schema.routines)
      .set({ signInWait: connection.id })
      .where(eq(schema.routines.id, routine.id));
    this.ctx.bus.refresh({ scope: 'routines' });
    const t = await this.services.settings.translator();
    const text = t('routine.signInLost', { routine: routine.name, name: connection.name });
    if (threadId) {
      this.ctx.bus.notice({ kind: 'needsYou', need: 'login', botId: routine.botId, threadId, text });
    }
    // A routine posting to a Slack channel works for the team; its person is still the one to sign in.
    const person = routine.createdByUserId ?? (await this.services.access.botOwner(routine.botId));
    if (person) await this.services.slack.tellPerson(person, text);
  }

  /**
   * Moves a routine that came due on to its next slot. A one-time routine stays as a paused record
   * after its run. After a retry the schedule goes on from the slot the retry stood in front of.
   */
  private async advance(r: RoutineRow) {
    const schedule = r.schedule as Schedule;
    await this.ctx.db
      .update(schema.routines)
      .set(
        schedule.type === 'once'
          ? { nextRunAt: null, enabled: false, resumeAt: null }
          : {
              nextRunAt: r.resumeAt ?? nextRun(schedule, r.timezone, this.clock(), r.nextRunAt),
              resumeAt: null,
            },
      )
      // A schedule the person changed meanwhile keeps the next run they set.
      .where(and(eq(schema.routines.id, r.id), eq(schema.routines.nextRunAt, r.nextRunAt!)));
  }

  /**
   * Reads a watched page and keeps its fingerprint and text. Returns the page's text, and what
   * changed when the earlier text was kept, when it changed since the last read; null when it did
   * not, could not be read, or is read for the first time (that read sets what later ones are
   * compared with).
   */
  async pageChanged(
    routineId: string,
    url: string,
    before: string | null,
    beforeText: string | null = null,
  ): Promise<{ excerpt: string; diff: string | null } | null> {
    let text: string;
    try {
      text = pageText(await fetchPublicText(new URL(url), WATCH_MAX));
    } catch (err) {
      console.warn(`Watched page of routine ${routineId} could not be read: ${String(err)}`);
      return null;
    }
    const hash = createHash('sha256').update(text).digest('hex');
    if (hash === before) return null;
    const kept = text.slice(0, WATCH_KEEP);
    await this.ctx.db
      .update(schema.routines)
      .set({ watchHash: hash, watchText: kept })
      .where(eq(schema.routines.id, routineId));
    if (before === null) return null;
    return {
      excerpt: text.slice(0, WATCH_EXCERPT),
      diff: beforeText === null ? null : pageDiff(beforeText, kept),
    };
  }

  /**
   * Calls a routine's check and keeps the fingerprint of its answer. Returns the answer when it
   * changed since the last call, and null when it did not, could not be called, or is called for the
   * first time (that answer sets what later ones are compared with).
   */
  async checkChanged(
    routineId: string,
    botId: string,
    check: RoutineCheck,
    before: string | null,
    userId: string | null = null,
    team = false,
  ): Promise<{ app: string; text: string } | null> {
    let app: string, text: string;
    try {
      const person = team ? null : (userId ?? (await this.services.access.botOwner(botId)));
      ({ app, text } = await this.services.connections.callCheck(botId, check, person));
    } catch (err) {
      console.warn(`Check of routine ${routineId} could not be called: ${String(err)}`);
      return null;
    }
    const hash = createHash('sha256').update(text).digest('hex');
    if (hash === before) return null;
    await this.ctx.db
      .update(schema.routines)
      .set({ checkHash: hash })
      .where(eq(schema.routines.id, routineId));
    return before === null ? null : { app, text: text.slice(0, WATCH_EXCERPT) };
  }

  /** Gives the routine a new webhook secret (the old address stops working), or removes it. */
  async setWebhook(id: string, on: boolean): Promise<Routine> {
    await this.get(id);
    const token = on ? randomBytes(24).toString('base64url') : null;
    // A new address keeps the app's own secret, which the app did not change; no address, no secret.
    await this.ctx.db
      .update(schema.routines)
      .set({ webhookToken: token, ...(!on && { webhookSecret: null }) })
      .where(eq(schema.routines.id, id));
    this.ctx.bus.refresh({ scope: 'routines' });
    return this.get(id);
  }

  /** Keeps the signing secret an app made for its calls, or removes it (`null`). */
  async setWebhookSecret(id: string, secret: string | null): Promise<Routine> {
    const routine = await this.get(id);
    if (secret && !routine.webhookToken) throw new HttpError(400, 'error.routineNoWebhook');
    // Sealed with the vault key and bound to the routine, so a copy of the database does not reveal it.
    const sealed = secret ? this.services.vault.seal(secret, webhookSecretBinding(id)) : null;
    await this.ctx.db
      .update(schema.routines)
      .set({ webhookSecret: sealed })
      .where(eq(schema.routines.id, id));
    this.ctx.bus.refresh({ scope: 'routines' });
    return this.get(id);
  }

  /** The app's secret as saved; null when it cannot be opened (the vault key changed), so calls are refused. */
  private openWebhookSecret(id: string, sealed: string): string | null {
    try {
      return this.services.vault.open(sealed, webhookSecretBinding(id));
    } catch {
      return null;
    }
  }

  /**
   * Whether a webhook call names a routine that takes calls, with its secret: checked before the
   * body is read, so a caller without the secret cannot make the server hold megabytes for it.
   */
  async webhookOpen(id: string, token: string): Promise<boolean> {
    const [row] = await this.ctx.db
      .select({ token: schema.routines.webhookToken, enabled: schema.routines.enabled })
      .from(schema.routines)
      .where(eq(schema.routines.id, id))
      .limit(1);
    return !!row?.token && row.enabled && sameSecret(row.token, token);
  }

  /** Runs the routine for a webhook call when `token` is its secret; null when it is not. */
  async runFromWebhook(
    id: string,
    token: string,
    payload?: string,
    /** The sender's id for this delivery, when it gives one; a delivery sent again runs once. */
    deliveryId?: string,
    /**
     * What the sending app says about the call: the kind of event (`push`, `orders/create`), and
     * the call's headers and raw body, for its signature (see `checkSignature`).
     */
    via: { event?: string; header?: (name: string) => string | undefined; raw?: Buffer } = {},
  ): Promise<RoutineRun | null | false | 'filtered' | 'duplicate' | 'busy' | 'ping' | 'signature'> {
    const [row] = await this.ctx.db
      .select({
        token: schema.routines.webhookToken,
        secret: schema.routines.webhookSecret,
        enabled: schema.routines.enabled,
        filter: schema.routines.webhookFilter,
        post: schema.routines.webhookPost,
        steps: schema.routines.steps,
      })
      .from(schema.routines)
      .where(eq(schema.routines.id, id))
      .limit(1);
    if (!row?.token || !row.enabled || !sameSecret(row.token, token)) return false;
    // A signed call must be signed with the right secret, so a changed body is turned away; once the
    // app's own secret was pasted in, an unsigned call is turned away too.
    const signed = checkSignature(via.header ?? (() => undefined), via.raw ?? Buffer.from(payload ?? ''), {
      token: row.token,
      secret: row.secret ? this.openWebhookSecret(id, row.secret) : null,
    });
    if (!signatureAllows(signed, !!row.secret)) return 'signature';
    // GitHub's first call only checks that the address answers.
    if (via.event === 'ping') return 'ping';
    // A run waiting for this call takes it first, whatever the routine's own filter starts runs on:
    // a routine started on `action=opened` may wait for the `closed` that follows.
    const delivery = deliveryId?.trim() ? `hook:${deliveryId.trim().slice(0, 200)}` : null;
    if (delivery && (await this.eventTaken(id, delivery))) return 'duplicate';
    const fields = withEvent(payload ?? '', via.event);
    const shown =
      via.event && payload
        ? `${(await this.services.settings.translator())('routine.webhookEvent', { event: via.event })}\n\n${payload}`
        : (payload ?? '');
    const taken = await this.offerEvent([id], 'webhook', fields, shown, delivery ?? `hook:${newId()}`);
    const took = taken.get(id);
    if (took) {
      const run = (await this.runs(id)).find((r) => r.id === took);
      if (run) return run;
    }
    // A call the filter turns away starts nothing and costs nothing. The kind of event comes in a
    // header, so the filter reads it as `event`.
    if (row.filter.trim() && !passesFilter(row.filter, fields)) return 'filtered';
    // A routine whose runs wait for its webhook starts a run on a call only when its filter says
    // which calls do: otherwise every call no run waited for (a push, a comment) would start one.
    const waitsOnHook = (snapshotSteps(row.steps) ?? []).some((s) => s.kind === 'wait' && s.on === 'webhook');
    if (waitsOnHook && !row.filter.trim()) return 'filtered';
    payload = via.event && payload ? shown : payload;
    const occurrence = delivery;
    if (occurrence) {
      const [seen] = await this.ctx.db
        .select({ id: schema.routineRuns.id })
        .from(schema.routineRuns)
        .where(and(eq(schema.routineRuns.routineId, id), eq(schema.routineRuns.occurrence, occurrence)))
        .limit(1);
      if (seen) return 'duplicate';
    }
    if (row.post) return this.post(await this.get(id), payload ?? '', occurrence);
    // A call that finds a run still going is told to come back later, so the sender delivers the
    // event again instead of it being dropped. A run stuck on an unanswered card gives way first.
    const [active] = await this.ctx.db
      .select({ id: schema.routineRuns.id })
      .from(schema.routineRuns)
      .where(
        and(eq(schema.routineRuns.routineId, id), inArray(schema.routineRuns.status, ['running', 'waiting'])),
      )
      .limit(1);
    if (active) {
      const t = await this.services.settings.translator();
      if (!(await this.endStaleWait(id, t, STALE_WAIT_MS, 'routine.staleWait'))) return 'busy';
    }
    return this.fire(
      await this.get(id),
      occurrence ?? `manual:${this.clock().toISOString()}`,
      payload,
      false,
      // A call that carries nothing is only a "run now", with nothing to judge.
      payload?.trim() ? { trigger: 'webhook', input: payload } : undefined,
    );
  }

  /**
   * Starts the bot's routines that run on mail, for a mail that just came to its address and
   * meets each one's filter. The mail goes to the bot as data after the instruction, like a
   * webhook call's body; a mail delivered again does not run a routine twice.
   */
  async runFromEmail(botId: string, mail: BotEmail): Promise<(RoutineRun | null)[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.routines)
      .where(and(eq(schema.routines.botId, botId), eq(schema.routines.enabled, true)));
    if (!rows.length) return [];
    const t = await this.services.settings.translator();
    const fields = JSON.stringify({ from: mail.from, to: mail.to, subject: mail.subject, text: mail.text });
    const payload = mailText(mail, {
      from: t('email.from'),
      to: t('email.to'),
      subject: t('email.subject'),
      date: t('email.date'),
      files: t('email.files'),
    });
    // A run waiting for a mail takes it first, whether or not its routine starts on mail; the
    // routine whose run took it does not start another run on it.
    const eventId = `mail:${mail.id}`;
    const fresh: typeof rows = [];
    for (const r of rows) if (!(await this.eventTaken(r.id, eventId))) fresh.push(r);
    const taken = await this.offerEvent(
      fresh.map((r) => r.id),
      'email',
      fields,
      payload,
      eventId,
    );
    const runs: (RoutineRun | null)[] = [];
    for (const r of fresh) {
      if (taken.has(r.id) || !r.emailTrigger) continue;
      if (r.emailFilter.trim() && !passesFilter(r.emailFilter, fields)) continue;
      runs.push(
        await this.fire(toRoutine(r), `mail:${mail.id}`, payload, false, {
          trigger: 'email',
          input: payload,
        }),
      );
    }
    return runs;
  }

  /**
   * Only the person whose WhatsApp is linked has a routine read its chats: anyone else who may
   * change a bot would read their messages.
   */
  private async checkGroup(person: string) {
    if ((await this.services.whatsapp.ownerId()) !== person)
      throw new HttpError(403, 'error.whatsappGroupNotYours');
  }

  /**
   * A routine starts only on a table of its own bot: another bot's rows are not its work. Its
   * filter names the table's columns exactly as they are written, since a filter on a column that
   * is not there (or written in other letters) would never let a row through and say nothing.
   */
  private async checkTable(botId: string, tableId: string, filter: string) {
    const table = await this.services.tables.get(tableId).catch(() => null);
    if (table?.botId !== botId) throw new HttpError(400, 'error.routineTable');
    for (const rule of parseFilter(filter)) {
      const column = rule.path.join('.');
      if (!table.columns.some((c) => c.name === column))
        throw new HttpError(400, 'error.routineTableFilter', {
          column,
          columns: table.columns.map((c) => c.name).join(', '),
        });
    }
  }

  /**
   * Starts the routines that run on rows of `table`, for rows `addedBy` just added or changed in
   * the app. A row starts a routine once, the first time it has something in it and meets the
   * routine's filter: the app adds a row empty and the person fills it in, and moving a row into
   * the filter (a status set to "todo") is how it is handed over. Only a routine working for that
   * person starts: a run works with its person's apps, sign-ins and notes, so someone else's change
   * is not let steer it. A row with cells a bot or someone else wrote may hold text from outside (a
   * mail the bot copied in), so the run reads it as such and changes nothing without a card. A
   * routine that is busy keeps the row for when its run ends, since a row, unlike a webhook call,
   * is not sent again.
   */
  async runFromTableRows(table: BotTable, rows: TableRow[], addedBy: string): Promise<(RoutineRun | null)[]> {
    const filled = rows.filter((row) => Object.values(row.values).some((v) => v !== null && v !== ''));
    if (!filled.length) return [];
    const routines = await this.ctx.db
      .select()
      .from(schema.routines)
      .where(
        and(
          eq(schema.routines.botId, table.botId),
          eq(schema.routines.enabled, true),
          eq(schema.routines.tableTrigger, table.id),
        ),
      );
    if (!routines.length) return [];
    const t = await this.services.settings.translator();
    const yes = t('tool.tableYes');
    const no = t('tool.tableNo');
    const writers = await this.services.tables.writers(filled.map((row) => row.id));
    const runs: (RoutineRun | null)[] = [];
    for (const r of routines) {
      if ((await this.personOf(r)) !== addedBy) continue;
      for (const row of filled) {
        if (!passesFilter(r.tableFilter, JSON.stringify(row.values))) continue;
        const payload = [
          t('routine.tableRowIn', { table: table.name }),
          `[${row.id}] ${table.columns
            .map((c) => `${c.name}: ${cellText(row.values[c.name], yes, no) || '—'}`)
            .join(' · ')}`,
        ].join('\n');
        const own = writers.get(row.id) === addedBy;
        // Keyed on the row: a row changed again after it started the routine does not start it twice.
        runs.push(
          await this.fire(
            toRoutine(r),
            `table:${row.id}`,
            payload,
            false,
            undefined,
            undefined,
            own ? undefined : 'stored',
          ),
        );
      }
    }
    return runs;
  }

  /**
   * The enabled routines that read WhatsApp, and only those working for the person whose WhatsApp
   * is linked now: once someone else links theirs, another person's routine reads none of it.
   */
  private async whatsappRoutines(where?: SQL) {
    const owner = await this.services.whatsapp.ownerId();
    if (!owner) return [];
    const rows = await this.ctx.db
      .select()
      .from(schema.routines)
      .where(
        and(
          eq(schema.routines.enabled, true),
          or(isNotNull(schema.routines.whatsappGroup), eq(schema.routines.whatsappPeople, true)),
          where,
        ),
      );
    const mine = await Promise.all(rows.map(async (r) => (await this.personOf(toRoutine(r))) === owner));
    return rows.filter((_, i) => mine[i]);
  }

  /** The bots with a routine that reads WhatsApp: they get its chats and replies. */
  async whatsappBots(): Promise<Set<string>> {
    return new Set((await this.whatsappRoutines()).map((r) => r.botId));
  }

  /** What WhatsApp is read for: the groups the routines follow, and whether any reads people's chats. */
  async whatsappReads(): Promise<{ groups: Set<string>; people: boolean }> {
    const rows = await this.whatsappRoutines();
    return {
      groups: new Set(rows.flatMap((r) => (r.whatsappGroup ? [r.whatsappGroup] : []))),
      people: rows.some((r) => r.whatsappPeople),
    };
  }

  /** What one bot's routines read: only these chats are its to see and answer. */
  async whatsappReadsOf(botId: string): Promise<{ groups: Set<string>; people: boolean }> {
    const rows = await this.whatsappRoutines(eq(schema.routines.botId, botId));
    return {
      groups: new Set(rows.flatMap((r) => (r.whatsappGroup ? [r.whatsappGroup] : []))),
      people: rows.some((r) => r.whatsappPeople),
    };
  }

  /** The routines that read a WhatsApp chat: a group by its address, a person's by the switch. */
  private readersOf(chat: string, kind: 'person' | 'group') {
    return this.whatsappRoutines(
      kind === 'group' ? eq(schema.routines.whatsappGroup, chat) : eq(schema.routines.whatsappPeople, true),
    );
  }

  /** The bots whose routines read a WhatsApp chat: its files go in their folders. */
  async chatReaders(chat: string, kind: 'person' | 'group'): Promise<string[]> {
    return [...new Set((await this.readersOf(chat, kind)).map((r) => r.botId))];
  }

  /**
   * Starts the routines that read a WhatsApp chat, for a batch of its new messages. The batch goes
   * to the bot as outside text after the instruction, like a mail, worded for each bot by
   * `payloadFor` (its files are in that bot's folder); `batch` names it, so a batch handed over
   * again does not run a routine twice. Each routine works on each chat in a conversation of its
   * own, so one customer's exchange never becomes the context of another's. `done` is false when
   * a routine was too busy to take the batch, which is then offered again later.
   */
  async runFromWhatsApp(
    chat: { jid: string; kind: 'person' | 'group'; name: string; threads: Record<string, string> },
    batch: string,
    payloadFor: (botId: string) => string,
  ): Promise<{ done: boolean; threads: Record<string, string> }> {
    const threads: Record<string, string> = {};
    let done = true;
    for (const r of await this.readersOf(chat.jid, chat.kind)) {
      const routine = toRoutine(r);
      // Never the main conversation, even for a routine that runs there: one customer's chat would
      // become the context of another's.
      const person = await this.personOf(routine);
      const title = `${routine.name} · ${chat.name}`.slice(0, 200);
      const thread = await this.services.threads.routineThread(
        routine.botId,
        title,
        chat.threads[routine.id] ?? null,
        person,
      );
      const threadId = thread.id;
      if (chat.threads[routine.id] !== thread.id) threads[routine.id] = thread.id;
      const payload = payloadFor(r.botId);
      const run = await this.fire(
        routine,
        `wa:${batch}`.slice(0, 250),
        payload,
        false,
        { trigger: 'whatsapp', input: payload },
        threadId,
      );
      if (run?.status === 'skipped') done = false;
    }
    return { done, threads };
  }

  /**
   * A notification-style webhook: what the call carries lands in the routine's conversation as the
   * bot's own message, with no AI turn and no cost. The run is recorded as done.
   */
  /**
   * Posts what a webhook call carries as the bot's message, with no AI. With `skipped`, it is a
   * condition's note instead: the run is kept as skipped for that reason, since no run took place.
   */
  private async post(
    routine: Routine,
    payload: string,
    delivery: string | null,
    skipped?: string,
  ): Promise<RoutineRun | null> {
    const t = await this.services.settings.translator();
    const bot = await this.services.bots.get(routine.botId).catch(() => null);
    const occurrence = delivery ?? `post:${this.clock().toISOString()}:${newId().slice(0, 8)}`;
    if (!bot || bot.archivedAt) return this.record(routine, occurrence, 'skipped', t('routine.botMissing'));
    const thread = await this.threadFor(routine, bot.id);
    const [run] = (await this.ctx.db
      .insert(schema.routineRuns)
      .values({
        id: newId(),
        routineId: routine.id,
        occurrence,
        status: skipped ? 'skipped' : 'done',
        reason: skipped ?? null,
        threadId: thread.id,
        promptSnapshot: routine.prompt,
        finishedAt: this.clock(),
      })
      .returning()) as [typeof schema.routineRuns.$inferSelect];
    if (!skipped)
      await this.ctx.db
        .update(schema.routines)
        .set({ lastRunAt: this.clock() })
        .where(eq(schema.routines.id, routine.id));
    const text = payload.trim()
      ? cutAt(payload.trim(), POST_MAX)
      : t('routine.postEmpty', { name: routine.name });
    const props = {
      routineRunId: run.id,
      routineName: routine.name,
      posted: true,
      // Posted in the person's own conversation: chat apps send it as the routine's report.
      ...(thread.kind === 'user' && { routineInMain: true }),
    };
    await this.services.threads.addMessage({
      threadId: thread.id,
      role: 'assistant',
      author: `bot:${bot.id}`,
      text,
      props,
    });
    if (thread.kind === 'routine') await this.report(bot.id, thread, text, props);
    if (routine.slackChannel) await this.services.slack.report(routine.slackChannel, routine.name, text);
    this.ctx.bus.refresh({ scope: 'routines' });
    return toRun(run);
  }

  /**
   * Run now, outside the schedule. `payload` is what a script or another service hands over with
   * the run (a build log, a webhook body); the bot reads it as data after its instruction.
   */
  async runNow(id: string, payload?: string): Promise<RoutineRun | null> {
    const routine = await this.get(id);
    return this.fire(routine, `manual:${this.clock().toISOString()}`, payload);
  }

  /**
   * Where a routine's runs work: the bot's main conversation, or the routine's own, reused. A run
   * made while the routine ran in the main conversation does not make that one its own.
   */
  private async threadFor(
    routine: Routine,
    botId: string,
    /**
     * Started by text from outside (a webhook's body, a mail, a changed page). It is read in the
     * routine's own conversation even for one that runs in the main one: the main conversation's
     * session would carry that text from then on, and the person's words there could answer the
     * cards it raised. Its report reaches the main conversation as any report does.
     */
    outsideRun = false,
  ) {
    // One reporting to a Slack channel runs as a team conversation, which uses only what the team
    // shares; a routine moved there starts a conversation of its own, not one that read its
    // person's own data.
    if (routine.slackChannel) {
      const [last] = await this.ctx.db
        .select({ threadId: schema.routineRuns.threadId })
        .from(schema.routineRuns)
        .innerJoin(schema.threads, eq(schema.threads.id, schema.routineRuns.threadId))
        .where(and(eq(schema.routineRuns.routineId, routine.id), eq(schema.threads.kind, 'team')))
        .orderBy(desc(schema.routineRuns.startedAt))
        .limit(1);
      if (last?.threadId) return this.services.threads.row(last.threadId);
      const made = await this.services.threads.create(botId, {
        kind: 'team',
        userId: null,
        title: routine.name,
      });
      return this.services.threads.row(made.id);
    }
    // Its runs bring in its person's profile, notes and apps: they happen where only they look.
    const person = await this.personOf(routine);
    // One that stops for the person stays out of it: a run held for days would keep the main
    // conversation busy, and the person's words there would be read as answers to its cards.
    if (routine.inMain && !holdsRuns(routine) && !outsideRun) {
      return this.services.threads.row((await this.services.threads.main(botId, person)).id);
    }
    // A routine that stops for the person keeps each run in a conversation of its own: a run held for
    // days would otherwise share one with the runs after it, and the bot would read them as one.
    if (holdsRuns(routine)) {
      const locale = await this.services.settings.locale();
      const when = this.clock().toLocaleString(INTL_LOCALE[locale], {
        timeZone: routine.timezone,
        dateStyle: 'medium',
        timeStyle: 'short',
      });
      return this.services.threads.routineThread(botId, `${routine.name} · ${when}`, null, person);
    }
    const [last] = await this.ctx.db
      .select({ threadId: schema.routineRuns.threadId })
      .from(schema.routineRuns)
      .innerJoin(schema.threads, eq(schema.threads.id, schema.routineRuns.threadId))
      .where(
        and(
          eq(schema.routineRuns.routineId, routine.id),
          eq(schema.threads.kind, 'routine'),
          // A WhatsApp chat's runs work in that chat's own conversation, not the routine's.
          notLike(schema.routineRuns.occurrence, 'wa:%'),
        ),
      )
      .orderBy(desc(schema.routineRuns.startedAt))
      .limit(1);
    return this.services.threads.routineThread(botId, routine.name, last?.threadId ?? null, person);
  }

  /** Makes the conversation a recorded run works in, and keeps it on the run. */
  private async ownThread(routine: Routine, botId: string, runId: string): Promise<string> {
    const made = await this.threadFor(routine, botId);
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ threadId: made.id })
      .where(eq(schema.routineRuns.id, runId));
    return made.id;
  }

  /**
   * What a run wrote in the routine's own conversation reaches the bot's main one: the person reads
   * every report in one place, and the bot knows of it when they talk there next. The run's steps
   * stay in the routine's conversation, a click away.
   */
  private async report(
    botId: string,
    routineThread: { id: string; userId: string | null },
    text: string,
    props: { routineRunId: string; routineName: string; posted?: boolean; outside?: OutsideTrigger },
  ) {
    const routineThreadId = routineThread.id;
    // Reports go to the main conversation of the person the routine works for.
    const person = routineThread.userId ?? (await this.services.access.botOwner(botId));
    const main = await this.services.threads.main(botId, person);
    await this.services.threads.addMessage({
      threadId: main.id,
      role: 'assistant',
      author: `bot:${botId}`,
      text,
      props: { ...props, routineReport: true, routineThreadId },
    });
    this.ctx.bus.notice({ kind: 'reply', botId, threadId: main.id, text: truncate(text.trim(), 200) });
  }

  /**
   * Ends the routine's active run when it has been waiting on a card for the person for `minAge`
   * or more, recording why: with STALE_WAIT_MS one unanswered question does not stop every later
   * run, with 0 a paused routine leaves nothing waiting. True when it ended one.
   */
  private async endStaleWait(
    routineId: string,
    t: T,
    minAge: number,
    reason: 'routine.staleWait' | 'routine.pausedWait',
  ): Promise<boolean> {
    const [stuck] = await this.ctx.db
      .select({ runId: schema.routineRuns.id, turnId: schema.turns.id })
      .from(schema.routineRuns)
      .innerJoin(schema.turns, eq(schema.turns.routineRunId, schema.routineRuns.id))
      .innerJoin(schema.approvals, eq(schema.approvals.turnId, schema.turns.id))
      .where(
        and(
          eq(schema.routineRuns.routineId, routineId),
          inArray(schema.routineRuns.status, ['running', 'waiting']),
          eq(schema.turns.status, 'running'),
          eq(schema.approvals.status, 'pending'),
          // Card times are the database's own clock.
          lte(schema.approvals.createdAt, sql`now() - make_interval(secs => ${minAge / 1000})`),
        ),
      )
      .limit(1);
    if (!stuck) return false;
    await this.services.turns.stopTurn(stuck.turnId);
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'error', reason: t(reason), finishedAt: this.clock() })
      .where(eq(schema.routineRuns.id, stuck.runId));
    return true;
  }

  /**
   * Records a run and starts the bot on it. With `check` (a watched page changed, a webhook carried
   * something) and the pre-check on, a small model looks at the run first: the run is recorded at
   * once and its turn starts when the check answers, so a webhook caller is not kept waiting.
   */
  private async fire(
    routine: Routine,
    occurrence: string,
    payload?: string,
    retried = false,
    check?: { trigger: GateRequest['trigger']; input: string },
    /** The conversation to work in, when it is not the routine's usual one (a WhatsApp chat's). */
    threadId?: string,
    /** Outside text the run is started on with no pre-check (a message handed over in Slack). */
    outside?: OutsideTrigger,
    /** Started by the routine's own schedule (see `tick`). */
    scheduled = false,
  ): Promise<RoutineRun | null> {
    const t = await this.services.settings.translator();
    const bot = await this.services.bots.get(routine.botId).catch(() => null);
    if (!bot || bot.archivedAt) return this.record(routine, occurrence, 'skipped', t('routine.botMissing'));
    // A paused bot does no work; its slot passes, with why, and the schedule goes on.
    if (await this.services.bots.isPaused(bot)) {
      return this.record(routine, occurrence, 'skipped', t('routine.botPaused'));
    }
    // A routine whose runs each get a conversation of their own makes it once the run is recorded:
    // a slot skipped as busy or a mail delivered twice leaves no empty conversation behind.
    const own = !threadId && holdsRuns(routine);
    const thread = threadId
      ? await this.services.threads.row(threadId)
      : own
        ? null
        : await this.threadFor(routine, bot.id, !!(check?.trigger ?? outside));
    let run: typeof schema.routineRuns.$inferSelect;
    try {
      [run] = (await this.ctx.db
        .insert(schema.routineRuns)
        .values({
          id: newId(),
          routineId: routine.id,
          occurrence,
          status: 'running',
          threadId: thread?.id ?? null,
          promptSnapshot: routine.prompt,
          stepsSnapshot: stepsOf(routine),
          // Text from outside starts it: its turns change nothing without a card.
          trigger: check?.trigger ?? outside ?? null,
          scheduled,
          triggerInput: keptInput(payload),
        })
        .returning()) as [typeof schema.routineRuns.$inferSelect];
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Same occurrence already handled, or a run is still active.
      const [dup] = await this.ctx.db
        .select()
        .from(schema.routineRuns)
        .where(
          and(eq(schema.routineRuns.routineId, routine.id), eq(schema.routineRuns.occurrence, occurrence)),
        )
        .limit(1);
      if (dup) return null;
      // An earlier run stuck on a question nobody answered gives way to this one, once.
      if (!retried && (await this.endStaleWait(routine.id, t, STALE_WAIT_MS, 'routine.staleWait')))
        return this.fire(routine, occurrence, payload, true, check, threadId, outside, scheduled);
      // A mail or a changed page does not come again: it waits for the run going now to end. A
      // webhook caller is told to send it again instead.
      const brought = check?.trigger ?? outside;
      if (brought && !occurrence.startsWith('hook:'))
        return this.queue(routine, thread?.id ?? null, occurrence, payload, brought, t);
      // A row the person wrote alone is not written again either, and it waits as their own words.
      if (occurrence.startsWith('table:'))
        return this.queue(routine, thread?.id ?? null, occurrence, payload, null, t);
      return this.recordBusy(routine, retriable(occurrence), t);
    }
    const threadOf = thread?.id ?? (await this.ownThread(routine, bot.id, run.id));
    run.threadId = threadOf;
    await this.ctx.db
      .update(schema.routines)
      .set({ lastRunAt: this.clock() })
      .where(eq(schema.routines.id, routine.id));
    const mode = check ? ((await this.services.settings.get('routineGate')) ?? 'off') : 'off';
    const engine = mode !== 'off' ? this.engineFor(bot) : undefined;
    if (check && engine?.gate) {
      const checked = this.checkThenStart(engine, mode === 'on', routine, run, bot.model, check, () =>
        this.startRun(routine, bot.id, threadOf, run, payload, t),
      ).catch(async (err) => {
        console.error(`Pre-check of routine ${routine.id} failed`, err);
        await this.startFailed(routine.id, run.id, err, t).catch(() => {});
      });
      this.checking.add(checked);
      void checked.finally(() => this.checking.delete(checked));
      return toRun(run);
    }
    if (await this.startRun(routine, bot.id, threadOf, run, payload, t)) return toRun(run);
    // It ended as failed: the caller is told so, not that it runs.
    const [ended] = await this.ctx.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, run.id));
    return toRun(ended ?? run);
  }

  /**
   * Starts the bot on a recorded run. When that goes wrong the run ends as failed, with why: left
   * active, it would hold off every later run of the routine as "still running" until the server
   * starts again.
   */
  private async startRun(
    routine: Routine,
    botId: string,
    threadId: string,
    run: RunRow,
    payload: string | undefined,
    t: T,
  ): Promise<boolean> {
    try {
      await this.begin(routine, botId, threadId, run, payload, t);
      return true;
    } catch (err) {
      console.error(`Run ${run.id} of routine ${routine.id} could not start`, err);
      await this.startFailed(routine.id, run.id, err, t);
      return false;
    }
  }

  /** Ends a run that could not start as failed, and starts one that waited for it. */
  private async startFailed(routineId: string, runId: string, err: unknown, t: T) {
    if (await this.failRun(runId, t('routine.startFailed', { message: errorText(err, t) }))) {
      await this.countRun(routineId, 'failed', runId);
      await this.startQueued(routineId);
    }
  }

  /**
   * Ends a run still marked active as failed, when no turn of it is queued or going (one that is
   * finishes it itself). True when it ended it.
   */
  private async failRun(runId: string, reason: string): Promise<boolean> {
    const ended = await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'error', reason, finishedAt: this.clock() })
      .where(
        and(
          eq(schema.routineRuns.id, runId),
          inArray(schema.routineRuns.status, ['running', 'waiting']),
          notExists(
            this.ctx.db
              .select({ id: schema.turns.id })
              .from(schema.turns)
              .where(
                and(
                  eq(schema.turns.routineRunId, runId),
                  inArray(schema.turns.status, ['queued', 'running']),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.routineRuns.id });
    if (ended.length) this.ctx.bus.refresh({ scope: 'routines' });
    return ended.length > 0;
  }

  /**
   * A due slot whose run could not be started: recorded as a failed run, or the run already written
   * for it ends as failed.
   */
  private async recordFailure(routine: Routine, occurrence: string, err: unknown, t: T) {
    const reason = t('routine.startFailed', { message: errorText(err, t) });
    const recorded = await this.record(routine, occurrence, 'error', reason);
    if (recorded) {
      await this.countRun(routine.id, 'failed', recorded.id);
      this.ctx.bus.refresh({ scope: 'routines' });
      return;
    }
    const [run] = await this.ctx.db
      .select({ id: schema.routineRuns.id })
      .from(schema.routineRuns)
      .where(and(eq(schema.routineRuns.routineId, routine.id), eq(schema.routineRuns.occurrence, occurrence)))
      .limit(1);
    if (run && (await this.failRun(run.id, reason))) {
      await this.countRun(routine.id, 'failed', run.id);
      await this.startQueued(routine.id);
    }
  }

  /**
   * Keeps count of runs that really failed, and switches the routine off when too many came in a
   * row, so a broken instruction, a removed tool or a changed page does not go on spending money
   * on every slot. `ok` is a run that did its work and resets the count; anything that is not a
   * run's own failure (a wait, a skip, the person's stop, a usage limit, a sign-in problem, a
   * restart) is never passed here, so a crash loop or an expired token cannot switch off every
   * routine.
   */
  private async countRun(routineId: string, ended: 'ok' | 'failed', runId?: string) {
    if (ended === 'ok') {
      await this.ctx.db
        .update(schema.routines)
        .set({ failureStreak: 0 })
        .where(and(eq(schema.routines.id, routineId), gt(schema.routines.failureStreak, 0)));
      return;
    }
    const [row] = await this.ctx.db
      .update(schema.routines)
      .set({ failureStreak: sql`${schema.routines.failureStreak} + 1` })
      .where(eq(schema.routines.id, routineId))
      .returning();
    if (!row?.enabled || row.failureStreak < FAILURE_LIMIT) return;
    // Only the write that finds it still on says so: two runs ending together tell the person once.
    const [off] = await this.ctx.db
      .update(schema.routines)
      .set({ enabled: false, nextRunAt: null, resumeAt: null, pausedReason: 'failures' })
      .where(and(eq(schema.routines.id, routineId), eq(schema.routines.enabled, true)))
      .returning();
    if (!off) return;
    try {
      const t = await this.services.settings.translator();
      const text = t('routine.switchedOff', { name: off.name, count: String(FAILURE_LIMIT) });
      const person = await this.personOf(off);
      const main = await this.services.threads.main(off.botId, person);
      const [run] = runId
        ? await this.ctx.db
            .select({ threadId: schema.routineRuns.threadId })
            .from(schema.routineRuns)
            .where(eq(schema.routineRuns.id, runId))
        : [];
      await this.services.threads.addMessage({
        threadId: main.id,
        role: 'assistant',
        author: `bot:${off.botId}`,
        text,
        props: {
          routineName: off.name,
          routineReport: true,
          posted: true,
          ...(run?.threadId ? { routineThreadId: run.threadId } : {}),
        },
      });
      this.ctx.bus.notice({ kind: 'reply', botId: off.botId, threadId: main.id, text: truncate(text, 200) });
      // What waited for a run of it is not run either.
      await this.startQueued(routineId);
    } catch (err) {
      console.warn(`Routine ${routineId} was switched off, but telling the person failed`, err);
    }
    this.ctx.bus.refresh({ scope: 'routines' });
  }

  /**
   * Keeps outside text that found a run of the routine going, to start once that run ends. It
   * skips the pre-check then: what is new was already found. A long queue drops what comes after.
   */
  private async queue(
    routine: Routine,
    threadId: string | null,
    occurrence: string,
    payload: string | undefined,
    trigger: OutsideTrigger | null,
    t: T,
  ): Promise<RoutineRun | null> {
    const [{ queued } = { queued: 0 }] = await this.ctx.db
      .select({ queued: count() })
      .from(schema.routineRuns)
      .where(and(eq(schema.routineRuns.routineId, routine.id), eq(schema.routineRuns.status, 'queued')));
    if (queued >= MAX_QUEUED) return this.recordBusy(routine, retriable(occurrence), t);
    try {
      const [row] = await this.ctx.db
        .insert(schema.routineRuns)
        .values({
          id: newId(),
          routineId: routine.id,
          occurrence,
          status: 'queued',
          reason: t('routine.queued'),
          threadId,
          promptSnapshot: routine.prompt,
          stepsSnapshot: stepsOf(routine),
          trigger,
          payload: payload ?? null,
          triggerInput: keptInput(payload),
        })
        .returning();
      this.ctx.bus.refresh({ scope: 'routines' });
      // The run it waited for may have ended meanwhile.
      await this.startQueued(routine.id);
      return toRun(row!);
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  /** Starts the routine's oldest queued run, when no other run of it is going. */
  async startQueued(routineId: string): Promise<void> {
    const [next] = await this.ctx.db
      .select()
      .from(schema.routineRuns)
      .where(and(eq(schema.routineRuns.routineId, routineId), eq(schema.routineRuns.status, 'queued')))
      .orderBy(asc(schema.routineRuns.startedAt))
      .limit(1);
    if (!next) return;
    const t = await this.services.settings.translator();
    const routine = await this.get(routineId).catch(() => null);
    const bot = routine ? await this.services.bots.get(routine.botId).catch(() => null) : null;
    if (!routine?.enabled || !bot || bot.archivedAt) {
      // A paused routine, or one whose bot is gone, does not take up what waited for it.
      await this.ctx.db
        .update(schema.routineRuns)
        .set({
          status: 'skipped',
          reason: t(bot && !bot.archivedAt ? 'routine.queuePaused' : 'routine.botMissing'),
          finishedAt: this.clock(),
        })
        .where(and(eq(schema.routineRuns.routineId, routineId), eq(schema.routineRuns.status, 'queued')));
      this.ctx.bus.refresh({ scope: 'routines' });
      return;
    }
    let started: typeof schema.routineRuns.$inferSelect | undefined;
    try {
      [started] = await this.ctx.db
        .update(schema.routineRuns)
        // The mail or change it waited with goes into the prompt; it is not kept beside the run.
        .set({ status: 'running', reason: null, startedAt: this.clock(), payload: null })
        .where(and(eq(schema.routineRuns.id, next.id), eq(schema.routineRuns.status, 'queued')))
        .returning();
    } catch (err) {
      // Another run of the routine is going: this one starts when that one ends.
      if (isUniqueViolation(err)) return;
      throw err;
    }
    if (!started) return;
    await this.ctx.db
      .update(schema.routines)
      .set({ lastRunAt: this.clock() })
      .where(eq(schema.routines.id, routineId));
    const threadId = started.threadId ?? (await this.ownThread(routine, bot.id, started.id));
    await this.startRun(routine, bot.id, threadId, started, next.payload ?? undefined, t);
    this.ctx.bus.refresh({ scope: 'routines' });
  }

  /**
   * Asks the small model whether the run has anything to work on and records its answer. When the
   * check is on, the bot waits for it, and an answer of "nothing new" ends the run as skipped with
   * the reason; a failed check lets the run go ahead. While it only watches, the bot starts at once
   * and the answer is recorded beside the run.
   */
  private async checkThenStart(
    engine: Engine,
    enforce: boolean,
    routine: Routine,
    run: typeof schema.routineRuns.$inferSelect,
    model: string,
    check: { trigger: GateRequest['trigger']; input: string },
    start: () => Promise<unknown>,
  ) {
    if (!enforce) await start();
    let verdict: GateVerdict | null = null;
    try {
      // A WhatsApp chat's batch is judged on its own: no other chat's report is beside it.
      const report = run.occurrence.startsWith('wa:')
        ? null
        : await this.lastReport(routine.id, run.id, Boolean(routine.slackChannel));
      verdict = await engine.gate!({
        routine: { name: routine.name, prompt: routine.prompt },
        trigger: check.trigger,
        input: check.input,
        lastReport: report?.text ?? null,
        model,
        locale: await this.services.settings.locale(),
        signal: this.stopChecks.signal,
      });
    } catch (err) {
      if (!this.stopChecks.signal.aborted)
        console.warn(`Pre-check of routine ${routine.id} failed, running it: ${(err as Error).message}`);
    }
    const said = verdict
      ? { gateDecision: verdict.decision, gateReason: verdict.reason, gateCostUsd: verdict.costUsd }
      : null;
    if (!enforce) {
      if (said)
        await this.ctx.db.update(schema.routineRuns).set(said).where(eq(schema.routineRuns.id, run.id));
      this.ctx.bus.refresh({ scope: 'routines' });
      return;
    }
    // The server is stopping: the run stays active and ends as cut short when it starts again.
    if (this.stopChecks.signal.aborted) return;
    const skip = verdict?.decision === 'skip';
    const t = await this.services.settings.translator();
    // A run deleted with its routine meanwhile is not started.
    const [still] = await this.ctx.db
      .update(schema.routineRuns)
      .set({
        status: 'running' as const,
        ...said,
        ...(skip
          ? {
              status: 'skipped' as const,
              reason: verdict!.reason
                ? t('routine.gateSkipped', { reason: verdict!.reason })
                : t('routine.gateSkippedNoReason'),
              finishedAt: this.clock(),
            }
          : {}),
      })
      .where(and(eq(schema.routineRuns.id, run.id), eq(schema.routineRuns.status, 'running')))
      .returning({ id: schema.routineRuns.id });
    if (!still) return;
    if (skip) {
      this.ctx.bus.refresh({ scope: 'routines' });
      await this.startQueued(routine.id);
    } else await start();
  }

  /** Writes the run's instruction into its conversation and queues the bot's turn for it. */
  private async begin(
    routine: Routine,
    botId: string,
    threadId: string,
    run: typeof schema.routineRuns.$inferSelect,
    payload: string | undefined,
    t: T,
  ) {
    // A run that reports to a Slack channel works with team data only, so it carries on only a
    // report written that way, not one from before it was moved there.
    const report =
      routine.carryReport && !run.occurrence.startsWith('wa:')
        ? await this.lastReport(routine.id, run.id, Boolean(routine.slackChannel))
        : null;
    // A report written from outside text carries it on: this run reads it too.
    const outside = run.trigger ?? report?.outside ?? null;
    if (outside && !run.trigger) {
      await this.ctx.db
        .update(schema.routineRuns)
        .set({ trigger: outside })
        .where(eq(schema.routineRuns.id, run.id));
    }
    await this.services.threads.addMessage({
      threadId,
      role: 'user',
      author: `routine:${routine.id}`,
      text: payload ? `${routine.prompt}\n\n${t('routine.payloadShown', { payload })}` : routine.prompt,
      props: {
        routineRunId: run.id,
        routineName: routine.name,
        ...(payload ? { payload: true } : {}),
        // A new session that reads this conversation again reads outside text here.
        ...(outside ? { outside } : {}),
      },
    });
    const turn = await this.services.turns.enqueue({
      threadId,
      botId,
      source: 'routine',
      prompt: routinePrompt(
        t,
        routine.name,
        routine.prompt,
        payload,
        report,
        saveHint(snapshotSteps(run.stepsSnapshot) ?? [], 0, t),
        !!routine.reportOnly,
      ),
      routineRunId: run.id,
      // Its runs work for whoever set it up; one from before people came in, for the bot's owner.
      ...(routine.createdByUserId && { userId: routine.createdByUserId }),
      ...reportCap(routine.reportOnly),
    });
    // A run of a routine with steps keeps how each went, its own instruction first.
    if (run.stepsSnapshot) await this.stepStarted(run.id, 0, 'prompt', turn.id);
  }

  /**
   * Whether the routine only looks and reports, read as each step starts so a run held for days
   * keeps to what the routine says now; one that cannot be read is held back, not let go.
   */
  private async reportOnly(routineId: string): Promise<boolean> {
    const [row] = await this.ctx.db
      .select({ reportOnly: schema.routines.reportOnly })
      .from(schema.routines)
      .where(eq(schema.routines.id, routineId));
    return row?.reportOnly ?? true;
  }

  /** Records that the run's step at `position` is under way, once more for one tried again. */
  private async stepStarted(runId: string, position: number, kind: string, turnId: string | null) {
    const now = this.clock();
    await this.ctx.db
      .insert(schema.routineStepRuns)
      .values({ id: newId(), runId, position, kind, status: 'running', turnId, startedAt: now })
      .onConflictDoUpdate({
        target: [schema.routineStepRuns.runId, schema.routineStepRuns.position],
        set: { status: 'running', turnId, output: null, reason: null, startedAt: now, finishedAt: null },
      });
  }

  /**
   * Starts the run's step at `position` after the routine's own instruction: its instruction goes
   * into the run's conversation, and the bot works on it with what the step before it ended with.
   * `note` says why it is done again, for a step tried again.
   */
  private async startStep(
    run: StepRun,
    routineName: string,
    steps: readonly RoutineStep[],
    position: number,
    before: string | null,
    t: T,
    note?: string,
  ) {
    const step = steps[position - 1]!;
    if (step.when && !stepWhenHolds(step.when, before))
      return this.passOver(run, routineName, steps, step.when, position, before, t);
    if (step.kind === 'approval') return this.askApproval(run, step, position, before, t);
    if (step.kind === 'wait') return this.holdForWait(run, step, position, t);
    if (step.kind === 'notify') return this.notify(run, routineName, steps, step, position, before, t);
    if (step.kind === 'fetch' || step.kind === 'extract')
      return this.startData(run, routineName, steps, step, position, before, t);
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ stepModel: step.model || null })
      .where(eq(schema.routineRuns.id, run.id));
    await this.services.threads.addMessage({
      threadId: run.threadId,
      role: 'user',
      author: `routine:${run.routineId}`,
      text: step.prompt,
      props: { routineRunId: run.id, routineName, routineStep: position },
    });
    const reportOnly = await this.reportOnly(run.routineId);
    const parts = [
      ...(note ? [note] : []),
      t('routine.stepPrompt', {
        name: routineName,
        step: String(position + 1),
        total: String(steps.length + 1),
        prompt: step.prompt,
        silent: SILENT_REPLY,
      }),
      ...(before?.trim() ? [t('routine.stepBefore', { text: fence(cutAt(before.trim(), REPORT_MAX)) })] : []),
      ...saveHint(steps, position, t),
      ...(reportOnly ? [t('routine.reportOnly')] : []),
    ];
    const turn = await this.services.turns.enqueue({
      threadId: run.threadId,
      botId: run.botId,
      source: 'routine',
      prompt: parts.join('\n\n'),
      routineRunId: run.id,
      ...(run.userId && { userId: run.userId }),
      ...reportCap(reportOnly),
    });
    await this.stepStarted(run.id, position, step.kind, turn.id);
  }

  /**
   * A step whose condition does not hold, read with no AI: it is passed over and the next one gets
   * what reached it, or the run ends there as done. A run that ends so reports what reached the
   * step, as a run whose last step it was would.
   */
  private async passOver(
    run: StepRun,
    routineName: string,
    steps: readonly RoutineStep[],
    when: RoutineStepWhen,
    position: number,
    before: string | null,
    t: T,
  ) {
    const now = this.clock();
    const passed = {
      status: 'skipped' as const,
      reason: t('routine.stepWhenNot', { what: describeWhen(when, t) }),
      output: null,
      turnId: null,
      approvalId: null,
      startedAt: now,
      finishedAt: now,
    };
    await this.ctx.db
      .insert(schema.routineStepRuns)
      .values({ id: newId(), runId: run.id, position, kind: steps[position - 1]!.kind, ...passed })
      .onConflictDoUpdate({
        target: [schema.routineStepRuns.runId, schema.routineStepRuns.position],
        set: passed,
      });
    // Passed over, the step's own way after it is not followed: the step after it runs, as if this
    // one were not there. `goto` goes on where the condition's other way leads.
    if (when.otherwise !== 'end') {
      const route = routeFrom(steps, position, when.otherwise === 'goto' ? when.goto : '');
      if ('to' in route) return this.goTo(run, routineName, steps, position, route.to, before, t);
      if ('lost' in route) return this.lostRoute(run, route.lost, t);
    }
    const [row] = await this.ctx.db
      .select({ trigger: schema.routineRuns.trigger, slackChannel: schema.routines.slackChannel })
      .from(schema.routineRuns)
      .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .where(eq(schema.routineRuns.id, run.id));
    await this.ctx.db
      .update(schema.routineRuns)
      .set({
        status: 'done',
        reason:
          when.otherwise === 'end' && position < steps.length
            ? t('routine.stepWhenEnded', { step: String(position + 1) })
            : null,
        stepModel: null,
        finishedAt: now,
      })
      .where(eq(schema.routineRuns.id, run.id));
    await this.deliver(run.botId, run.threadId, cutAt(before ?? '', DELIVER_MAX), {
      id: run.id,
      routineName,
      outside: row?.trigger ?? null,
      slackChannel: row?.slackChannel ?? null,
    });
    this.ctx.bus.refresh({ scope: 'routines' });
    await this.startQueued(run.routineId);
  }

  /**
   * Goes on from the step at `from` to the one at `to`. The steps in between are marked as not on
   * the way this run took, so what one of them ended with on an earlier pass (before a correction
   * sent the run back) is not handed on. `before` is what reaches the step; when not given, what
   * the steps before it handed on.
   */
  private async goTo(
    run: StepRun,
    routineName: string,
    steps: readonly RoutineStep[],
    from: number,
    to: number,
    before: string | null | undefined,
    t: T,
  ) {
    const now = this.clock();
    const off = {
      status: 'skipped' as const,
      reason: t('routine.stepOffRoute'),
      output: null,
      turnId: null,
      approvalId: null,
      startedAt: now,
      finishedAt: now,
    };
    for (let p = from + 1; p < to; p++) {
      await this.ctx.db
        .insert(schema.routineStepRuns)
        .values({ id: newId(), runId: run.id, position: p, kind: steps[p - 1]!.kind, ...off })
        .onConflictDoUpdate({
          target: [schema.routineStepRuns.runId, schema.routineStepRuns.position],
          set: off,
        });
    }
    let given = before;
    if (given === undefined) {
      const rows = await this.ctx.db
        .select()
        .from(schema.routineStepRuns)
        .where(eq(schema.routineStepRuns.runId, run.id));
      given = handedOn(steps, rows, to);
    }
    await this.startStep(run, routineName, steps, to, given, t);
  }

  /**
   * Ends a run whose route names a step it does not have after the one it is at. Going on with the
   * step after it instead could do what the routine was set to go around (send a mail, say), so the
   * run stops there as failed, with why.
   */
  private async lostRoute(run: StepRun, target: string, t: T) {
    await this.ctx.db
      .update(schema.routineRuns)
      .set({
        status: 'error',
        reason: t('routine.stepRouteLost', { step: target }),
        stepModel: null,
        finishedAt: this.clock(),
      })
      .where(eq(schema.routineRuns.id, run.id));
    await this.countRun(run.routineId, 'failed', run.id);
    this.ctx.bus.refresh({ scope: 'routines' });
    await this.startQueued(run.routineId);
  }

  /**
   * Holds the run at an approval step. A card asks the person, with what the step before it ended
   * with, and the run waits for the answer as long as the step allows: with no turn and outside the
   * routine's one active run, so the routine's next runs go on meanwhile. The card outlives a
   * restart; `settleSteps` reads the answer from it.
   */
  private async askApproval(
    run: StepRun,
    step: Extract<RoutineStep, { kind: 'approval' }>,
    position: number,
    before: string | null,
    t: T,
  ) {
    const options = [t('routine.approve'), t('routine.reject')];
    const [row] = await this.ctx.db
      .select({ trigger: schema.routineRuns.trigger })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, run.id));
    const waitUntil = new Date(this.clock().getTime() + step.timeoutDays * DAY_MS);
    let made!: () => void;
    const created = new Promise<void>((done) => (made = done));
    const asked = this.services.approvals.ask({
      threadId: run.threadId,
      botId: run.botId,
      turnId: null,
      kind: 'question',
      toolName: ROUTINE_APPROVAL_TOOL,
      input: {
        questions: [
          {
            question: step.question,
            ...(before?.trim() && { context: cutAt(before.trim(), REPORT_MAX) }),
            options,
          },
        ],
        routineRunId: run.id,
      },
      summary: step.question,
      options,
      // Asked about what outside text started: the answer counts for this card only.
      outside: !!row?.trigger,
      onCreated: async (card) => {
        const now = this.clock();
        const waiting = {
          status: 'waiting' as const,
          approvalId: card.id,
          waitUntil,
          turnId: null,
          output: null,
          reason: null,
          startedAt: now,
          finishedAt: null,
        };
        await this.ctx.db
          .insert(schema.routineStepRuns)
          .values({ id: newId(), runId: run.id, position, kind: step.kind, ...waiting })
          .onConflictDoUpdate({
            target: [schema.routineStepRuns.runId, schema.routineStepRuns.position],
            set: waiting,
          });
        await this.ctx.db
          .update(schema.routineRuns)
          .set({ status: 'paused', reason: t('routine.waitingForPerson'), stepModel: null })
          .where(eq(schema.routineRuns.id, run.id));
        await this.services.threads.addMessage({
          threadId: run.threadId,
          role: 'approval',
          author: `bot:${run.botId}`,
          text: card.summary,
          props: { approvalId: card.id },
        });
        made();
      },
    });
    // The answer is read from the card when it comes, not from this wait.
    void asked.catch((err: unknown) => console.warn(`Approval card of routine run ${run.id}`, err));
    await Promise.race([created, asked.then(() => undefined)]);
    this.ctx.bus.refresh({ scope: 'routines' });
    // The routine's slot is free while the run waits.
    await this.startQueued(run.routineId);
  }

  /**
   * Holds the run at a wait step: for a time, or until the routine's webhook is called or a mail
   * comes to the bot whose content passes the step's filter, with the values the run saved put in.
   * The run gives up the routine's slot meanwhile. A filter that names a value the run never saved
   * ends the run at once: left empty, it could match every event.
   */
  private async holdForWait(
    run: StepRun,
    step: Extract<RoutineStep, { kind: 'wait' }>,
    position: number,
    t: T,
  ) {
    const now = this.clock();
    const [row] = await this.ctx.db
      .select({ vars: schema.routineRuns.vars, webhookToken: schema.routines.webhookToken })
      .from(schema.routineRuns)
      .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .where(eq(schema.routineRuns.id, run.id));
    const vars = row?.vars ?? {};
    let filter: string | null = null;
    let refusal: string | null = null;
    if (step.on !== 'time') {
      filter = fillFilter(step.filter, vars);
      if (filter === null) {
        const missing = filterVars(step.filter).filter((n) => !vars[n]?.trim());
        refusal = t('routine.waitMissingValue', { names: missing.join(', ') });
      } else if (step.on === 'webhook' && !row?.webhookToken) refusal = t('routine.waitNoWebhook');
    }
    const held = {
      status: refusal ? ('error' as const) : ('waiting' as const),
      reason: refusal,
      waitUntil: new Date(
        now.getTime() + (step.on === 'time' ? step.minutes * 60_000 : step.timeoutDays * DAY_MS),
      ),
      filter,
      eventId: null,
      approvalId: null,
      turnId: null,
      output: null,
      startedAt: now,
      finishedAt: refusal ? now : null,
    };
    await this.ctx.db
      .insert(schema.routineStepRuns)
      .values({ id: newId(), runId: run.id, position, kind: step.kind, ...held })
      .onConflictDoUpdate({
        target: [schema.routineStepRuns.runId, schema.routineStepRuns.position],
        set: held,
      });
    await this.ctx.db
      .update(schema.routineRuns)
      .set(
        refusal
          ? { status: 'error', reason: refusal, stepModel: null, finishedAt: now }
          : {
              status: 'paused',
              reason: t(step.on === 'time' ? 'routine.waitingForTime' : 'routine.waitingForEvent'),
              stepModel: null,
            },
      )
      .where(eq(schema.routineRuns.id, run.id));
    this.ctx.bus.refresh({ scope: 'routines' });
    await this.startQueued(run.routineId);
  }

  /**
   * Starts a fetch or extract step: the step shows as running, and its work goes on apart from
   * what started it. Work that throws ends the step as failed, so the run does not stay running.
   */
  private async startData(
    run: StepRun,
    routineName: string,
    steps: readonly RoutineStep[],
    step: DataStep,
    position: number,
    before: string | null,
    t: T,
  ) {
    const running = {
      status: 'running' as const,
      output: null,
      reason: null,
      turnId: null,
      approvalId: null,
      startedAt: this.clock(),
      finishedAt: null,
    };
    await this.ctx.db
      .insert(schema.routineStepRuns)
      .values({ id: newId(), runId: run.id, position, kind: step.kind, ...running })
      .onConflictDoUpdate({
        target: [schema.routineStepRuns.runId, schema.routineStepRuns.position],
        set: running,
      });
    this.ctx.bus.refresh({ scope: 'routines' });
    const work: Promise<void> = this.dataStep(run, routineName, steps, step, position, before, t)
      .catch(async (err: unknown) => {
        console.error(`Routine step ${position} of run ${run.id}`, err);
        await this.dataFailed(run, routineName, steps, step, position, errorText(err, t), t).catch(
          (again: unknown) => console.error(`Routine run ${run.id}`, again),
        );
      })
      .finally(() => this.dataWork.delete(work));
    this.dataWork.add(work);
  }

  /** Does a fetch or extract step's work, then goes on along its way, or along its failure's. */
  private async dataStep(
    run: StepRun,
    routineName: string,
    steps: readonly RoutineStep[],
    step: DataStep,
    position: number,
    before: string | null,
    t: T,
  ) {
    const got =
      step.kind === 'fetch'
        ? await this.fetchFor(run, step, t)
        : await this.extractFrom(run, step, before, t);
    if ('error' in got) return this.dataFailed(run, routineName, steps, step, position, got.error, t);
    const now = this.clock();
    const [ended] = await this.ctx.db
      .update(schema.routineStepRuns)
      .set({ status: 'done', output: got.output || null, finishedAt: now })
      .where(
        and(
          eq(schema.routineStepRuns.runId, run.id),
          eq(schema.routineStepRuns.position, position),
          eq(schema.routineStepRuns.status, 'running'),
        ),
      )
      .returning({ id: schema.routineStepRuns.id });
    // Stopped while it worked: what it got is left out.
    if (!ended) return;
    const route = routeFrom(steps, position, step.next);
    if ('to' in route) return this.goTo(run, routineName, steps, position, route.to, got.output, t);
    if ('lost' in route) return this.lostRoute(run, route.lost, t);
    // Data is not a report: a run that ends here has said what it had to in the steps before.
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'done', stepModel: null, finishedAt: now })
      .where(and(eq(schema.routineRuns.id, run.id), eq(schema.routineRuns.status, 'running')));
    this.ctx.bus.refresh({ scope: 'routines' });
    await this.startQueued(run.routineId);
  }

  /**
   * A fetch or extract step that failed: it goes on along its failure's way with why, as a bot
   * step does, or the run ends there as failed, to be tried again from this step.
   */
  private async dataFailed(
    run: StepRun,
    routineName: string,
    steps: readonly RoutineStep[],
    step: DataStep,
    position: number,
    reason: string,
    t: T,
  ) {
    const now = this.clock();
    const [ended] = await this.ctx.db
      .update(schema.routineStepRuns)
      .set({ status: 'error', reason, finishedAt: now })
      .where(
        and(
          eq(schema.routineStepRuns.runId, run.id),
          eq(schema.routineStepRuns.position, position),
          eq(schema.routineStepRuns.status, 'running'),
        ),
      )
      .returning({ id: schema.routineStepRuns.id });
    if (!ended) return;
    const route = step.onError ? routeFrom(steps, position, step.onError) : null;
    // Handled where the routine said, it does not count toward switching the routine off.
    if (route && 'to' in route) {
      const what = t('routine.stepFailedBefore', { step: String(position + 1), reason });
      return this.goTo(run, routineName, steps, position, route.to, what, t);
    }
    if (route && 'lost' in route) return this.lostRoute(run, route.lost, t);
    await this.countRun(run.routineId, 'failed', run.id);
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'error', reason, stepModel: null, finishedAt: now })
      .where(and(eq(schema.routineRuns.id, run.id), eq(schema.routineRuns.status, 'running')));
    this.ctx.bus.refresh({ scope: 'routines' });
    await this.startQueued(run.routineId);
  }

  /**
   * What a fetch step's address serves, a page as its text. Only for a bot that may reach the
   * internet; the run's values go into the address encoded, and may not change its server. What
   * comes back is outside text: the run's later turns read it as such.
   */
  private async fetchFor(
    run: StepRun,
    step: Extract<RoutineStep, { kind: 'fetch' }>,
    t: T,
  ): Promise<{ output: string } | { error: string }> {
    const bot = await this.services.bots.get(run.botId).catch(() => null);
    if (!bot?.internet) return { error: t('routine.fetchNoInternet') };
    const [row] = await this.ctx.db
      .select({ vars: schema.routineRuns.vars, trigger: schema.routineRuns.trigger })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, run.id));
    const vars = row?.vars ?? {};
    const missing = filterVars(step.url).filter((n) => !vars[n]?.trim());
    if (missing.length) return { error: t('routine.fetchMissing', { names: missing.join(', ') }) };
    let url: URL;
    try {
      url = new URL(step.url.replace(VAR_IN_TEXT, (_, n: string) => encodeURIComponent(vars[n]!.trim())));
      if (url.host !== new URL(step.url.replace(VAR_IN_TEXT, 'x')).host)
        return { error: t('routine.fetchHost') };
    } catch {
      return { error: t('routine.fetchHost') };
    }
    let body: string;
    try {
      const res = await fetchPublic(url, FETCH_MAX, {
        timeoutMs: FETCH_TIMEOUT_MS,
        redirects: FETCH_REDIRECTS,
        accept: 'application/json, text/*;q=0.9, */*;q=0.5',
        userAgent: 'LeafBot',
      });
      const text = res.body.toString('utf8');
      body = /html/i.test(res.contentType) ? pageText(text) : text.trim();
    } catch (err) {
      return { error: fetchProblem(err, t) };
    }
    if (!row?.trigger) {
      await this.ctx.db
        .update(schema.routineRuns)
        .set({ trigger: 'web' })
        .where(eq(schema.routineRuns.id, run.id));
    }
    return { output: body };
  }

  /**
   * The values an extract step names, taken from the JSON that reached it: saved as the run's
   * values in one write, and handed on as a JSON object of them. A value that is not there fails
   * the step, so a route on failure can go around what needed it.
   */
  private async extractFrom(
    run: StepRun,
    step: Extract<RoutineStep, { kind: 'extract' }>,
    before: string | null,
    t: T,
  ): Promise<{ output: string } | { error: string }> {
    const json = jsonIn(before?.trim() ?? '');
    if (json === undefined) return { error: t('routine.extractNotJson') };
    const values: Record<string, string> = {};
    for (const f of parseFields(step.fields) ?? []) {
      const v = valueAt(json, f.path);
      if (v === undefined || v === null)
        return { error: t('routine.extractMissing', { name: f.name, path: f.path.join('.') }) };
      values[f.name] = cutAt(typeof v === 'object' ? JSON.stringify(v) : String(v), ROUTINE_VAR_MAX);
    }
    const [row] = await this.ctx.db
      .select({ vars: schema.routineRuns.vars })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, run.id));
    const merged = { ...(row?.vars ?? {}), ...values };
    if (Object.keys(merged).length > ROUTINE_VARS_MAX)
      return { error: t('routine.extractFull', { max: String(ROUTINE_VARS_MAX) }) };
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ vars: merged })
      .where(eq(schema.routineRuns.id, run.id));
    return { output: JSON.stringify(values, null, 2) };
  }

  /**
   * A notify step: with no AI, its text and what the step before it ended with go where the routine
   * reports, and the run goes on to its next step, or ends there.
   */
  private async notify(
    run: StepRun,
    routineName: string,
    steps: readonly RoutineStep[],
    step: Extract<RoutineStep, { kind: 'notify' }>,
    position: number,
    before: string | null,
    t: T,
  ) {
    const now = this.clock();
    const [row] = await this.ctx.db
      .select({
        vars: schema.routineRuns.vars,
        trigger: schema.routineRuns.trigger,
        slackChannel: schema.routines.slackChannel,
      })
      .from(schema.routineRuns)
      .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .where(eq(schema.routineRuns.id, run.id));
    // A value never saved is left out rather than stopping the message.
    const own = step.text.replace(/\{\{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g, (_, name: string) =>
      (row?.vars[name] ?? '').trim(),
    );
    const text = [own.trim(), step.withBefore ? cutAt(before?.trim() ?? '', DELIVER_MAX) : '']
      .filter(Boolean)
      .join('\n\n');
    const done = {
      status: 'done' as const,
      output: text || null,
      reason: null,
      turnId: null,
      startedAt: now,
      finishedAt: now,
    };
    await this.ctx.db
      .insert(schema.routineStepRuns)
      .values({ id: newId(), runId: run.id, position, kind: step.kind, ...done })
      .onConflictDoUpdate({
        target: [schema.routineStepRuns.runId, schema.routineStepRuns.position],
        set: done,
      });
    const thread = await this.services.threads.row(run.threadId).catch(() => null);
    if (text) {
      // A routine working in the main conversation shows it there; the others report to it.
      if (thread && thread.kind !== 'routine' && thread.kind !== 'team') {
        await this.services.threads.addMessage({
          threadId: run.threadId,
          role: 'assistant',
          author: `bot:${run.botId}`,
          text,
          props: { routineRunId: run.id, routineName, ...(row?.trigger ? { outside: row.trigger } : {}) },
        });
      } else {
        await this.deliver(run.botId, run.threadId, text, {
          id: run.id,
          routineName,
          outside: row?.trigger ?? null,
          slackChannel: row?.slackChannel ?? null,
        });
      }
    }
    const route = routeFrom(steps, position, step.next);
    if ('to' in route) return this.goTo(run, routineName, steps, position, route.to, undefined, t);
    if ('lost' in route) return this.lostRoute(run, route.lost, t);
    // What it told is the run's report: nothing more is sent when it ends here.
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'done', stepModel: null, finishedAt: now })
      .where(eq(schema.routineRuns.id, run.id));
    this.ctx.bus.refresh({ scope: 'routines' });
    await this.startQueued(run.routineId);
  }

  /**
   * Runs the routines whose person reacted in Slack with their reaction, on the message reacted
   * to. Only the routine's own person: a reaction is how they hand a message over, and nobody else
   * may start their routines. The message is someone's outside text; a message reacted to twice
   * runs a routine once.
   */
  async runFromSlackReaction(e: {
    userId: string;
    reaction: string;
    channel: string;
    ts: string;
    text: string;
  }): Promise<(RoutineRun | null)[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.routines)
      .where(and(eq(schema.routines.enabled, true), eq(schema.routines.slackReaction, e.reaction)));
    const runs: (RoutineRun | null)[] = [];
    for (const row of rows) {
      const routine = toRoutine(row);
      if ((await this.personOf(routine)) !== e.userId) continue;
      runs.push(
        await this.fire(
          routine,
          `slack:${e.channel}:${e.ts}`,
          e.text,
          false,
          undefined,
          undefined,
          'forward',
        ),
      );
    }
    if (runs.length) this.ctx.bus.refresh({ scope: 'routines' });
    return runs;
  }

  /** A bot step saves a value for a later wait step to put in its filter. */
  async setVar(runId: string, name: string, value: string): Promise<'saved' | 'full' | 'gone'> {
    const [run] = await this.ctx.db
      .select({ vars: schema.routineRuns.vars })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, runId));
    if (!run) return 'gone';
    if (!(name in run.vars) && Object.keys(run.vars).length >= ROUTINE_VARS_MAX) return 'full';
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ vars: { ...run.vars, [name]: value } })
      .where(eq(schema.routineRuns.id, runId));
    return 'saved';
  }

  /**
   * Offers an event to the runs of these routines held at a wait step for it: the oldest whose
   * filter it passes takes it, one run per routine, and goes on at the next pass over held steps.
   * Taking it is written first, so an event that comes while another run holds the routine's slot
   * is not lost. The runs that took it, by routine.
   */
  private async offerEvent(
    routineIds: string[],
    on: 'webhook' | 'email',
    fields: string,
    payload: string,
    eventId: string,
  ): Promise<Map<string, string>> {
    const taken = new Map<string, string>();
    if (!routineIds.length) return taken;
    const held = await this.ctx.db
      .select({ step: schema.routineStepRuns, run: schema.routineRuns })
      .from(schema.routineStepRuns)
      .innerJoin(schema.routineRuns, eq(schema.routineRuns.id, schema.routineStepRuns.runId))
      .where(
        and(
          inArray(schema.routineRuns.routineId, routineIds),
          eq(schema.routineRuns.status, 'paused'),
          eq(schema.routineStepRuns.status, 'waiting'),
          eq(schema.routineStepRuns.kind, 'wait'),
          isNull(schema.routineStepRuns.eventId),
        ),
      )
      .orderBy(asc(schema.routineStepRuns.startedAt));
    for (const { step, run } of held) {
      if (taken.has(run.routineId)) continue;
      const def = (snapshotSteps(run.stepsSnapshot) ?? [])[step.position - 1];
      if (def?.kind !== 'wait' || def.on !== on || step.filter === null) continue;
      if (step.filter.trim() && !passesFilter(step.filter, fields)) continue;
      const [took] = await this.ctx.db
        .update(schema.routineStepRuns)
        .set({ eventId, output: cutAt(payload, POST_MAX) })
        .where(
          and(
            eq(schema.routineStepRuns.id, step.id),
            eq(schema.routineStepRuns.status, 'waiting'),
            isNull(schema.routineStepRuns.eventId),
          ),
        )
        .returning({ id: schema.routineStepRuns.id });
      if (took) taken.set(run.routineId, run.id);
    }
    if (taken.size) await this.settleSteps();
    return taken;
  }

  /** Whether a run of the routine already took this event at a wait step. */
  private async eventTaken(routineId: string, eventId: string): Promise<boolean> {
    const [seen] = await this.ctx.db
      .select({ id: schema.routineStepRuns.id })
      .from(schema.routineStepRuns)
      .innerJoin(schema.routineRuns, eq(schema.routineRuns.id, schema.routineStepRuns.runId))
      .where(and(eq(schema.routineRuns.routineId, routineId), eq(schema.routineStepRuns.eventId, eventId)))
      .limit(1);
    return !!seen;
  }

  /** The person ends a run's wait now: the run goes on as if its time had come. */
  async endWait(routineId: string, runId: string): Promise<RoutineRun> {
    const [run] = await this.ctx.db
      .select({ id: schema.routineRuns.id })
      .from(schema.routineRuns)
      .where(
        and(
          eq(schema.routineRuns.id, runId),
          eq(schema.routineRuns.routineId, routineId),
          eq(schema.routineRuns.status, 'paused'),
        ),
      );
    const [held] = run
      ? await this.ctx.db
          .update(schema.routineStepRuns)
          .set({ eventId: `person:${newId()}` })
          .where(
            and(
              eq(schema.routineStepRuns.runId, runId),
              eq(schema.routineStepRuns.status, 'waiting'),
              eq(schema.routineStepRuns.kind, 'wait'),
              isNull(schema.routineStepRuns.eventId),
            ),
          )
          .returning({ id: schema.routineStepRuns.id })
      : [];
    if (!held) throw new HttpError(409, 'error.routineRunNotWaiting');
    await this.settleSteps();
    const shown = (await this.runs(routineId)).find((r) => r.id === runId);
    if (!shown) throw notFound('routine');
    return shown;
  }

  /**
   * Lets the runs held at an approval step go on once the card is answered: approved, the next
   * step starts with what the step before the card ended with; rejected, or not answered in time,
   * the run ends there; answered in words, the bot step before the card does its work again with
   * them, and the card asks again after it. One pass at a time; one asked for meanwhile follows.
   */
  async settleSteps(): Promise<void> {
    if (this.stopped) return;
    if (this.settling) {
      this.settleAgain = true;
      return this.settling;
    }
    this.settling = (async () => {
      do {
        this.settleAgain = false;
        await this.settleOnce();
      } while (this.settleAgain && !this.stopped);
    })().finally(() => {
      this.settling = null;
    });
    return this.settling;
  }

  private async settleOnce() {
    const routine = {
      name: schema.routines.name,
      botId: schema.routines.botId,
      userId: schema.routines.createdByUserId,
      slackChannel: schema.routines.slackChannel,
    };
    const answered = await this.ctx.db
      .select({
        step: schema.routineStepRuns,
        run: schema.routineRuns,
        card: {
          status: schema.approvals.status,
          answer: schema.approvals.answer,
          options: schema.approvals.options,
        },
        routine,
      })
      .from(schema.routineStepRuns)
      .innerJoin(schema.routineRuns, eq(schema.routineRuns.id, schema.routineStepRuns.runId))
      .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .innerJoin(schema.approvals, eq(schema.approvals.id, schema.routineStepRuns.approvalId))
      .where(
        and(
          eq(schema.routineStepRuns.status, 'waiting'),
          eq(schema.routineRuns.status, 'paused'),
          ne(schema.approvals.status, 'pending'),
        ),
      )
      .orderBy(asc(schema.approvals.decidedAt));
    // Waits that came to an end: their event came, their time is up, or the person ended them.
    const ended = await this.ctx.db
      .select({ step: schema.routineStepRuns, run: schema.routineRuns, routine })
      .from(schema.routineStepRuns)
      .innerJoin(schema.routineRuns, eq(schema.routineRuns.id, schema.routineStepRuns.runId))
      .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .where(
        and(
          eq(schema.routineStepRuns.status, 'waiting'),
          eq(schema.routineStepRuns.kind, 'wait'),
          eq(schema.routineRuns.status, 'paused'),
          or(isNotNull(schema.routineStepRuns.eventId), lte(schema.routineStepRuns.waitUntil, this.clock())),
        ),
      )
      .orderBy(asc(schema.routineStepRuns.waitUntil));
    if (!answered.length && !ended.length) return;
    const t = await this.services.settings.translator();
    for (const r of answered) {
      if (this.stopped) return;
      await this.settleApproval(r, t).catch((err: unknown) =>
        console.error(`Approval step of routine run ${r.run.id}`, err),
      );
    }
    for (const r of ended) {
      if (this.stopped) return;
      await this.settleWait(r, t).catch((err: unknown) =>
        console.error(`Wait step of routine run ${r.run.id}`, err),
      );
    }
  }

  private async settleApproval(
    r: HeldStep & { card: { status: string; answer: string | null; options: string[] } },
    t: T,
  ) {
    const { card } = r;
    const answer = card.answer?.trim() ?? '';
    const [approve, reject] = card.options;
    const kept = answer && answer !== APPROVAL_TIMED_OUT ? answer : null;
    if (card.status === 'expired') return this.endHeldRun(r, 'error', t('routine.approvalTimedOut'), kept);
    if (card.status === 'denied' || (reject !== undefined && answer === reject))
      return this.endHeldRun(r, 'stopped', t('routine.approvalRejected'), kept);
    // An answer in words is a correction: the bot step before the card does its work again with it.
    return this.goOn(r, t, { output: kept, ...(answer && answer !== approve && { revise: answer }) });
  }

  private async settleWait(r: HeldStep, t: T) {
    const step = (snapshotSteps(r.run.stepsSnapshot) ?? [])[r.step.position - 1];
    const on = step?.kind === 'wait' ? step.on : 'time';
    if (r.step.eventId) {
      // What came in is outside text: the run's later turns read it as such.
      const trigger = r.step.output && on !== 'time' ? on : undefined;
      return this.goOn(r, t, trigger ? { trigger } : {});
    }
    if (on === 'time') return this.goOn(r, t, {});
    return this.endHeldRun(r, 'error', t('routine.waitTimedOut'));
  }

  /** Ends a run held at a step, and the step with it, with why. */
  private async endHeldRun(r: HeldStep, status: 'stopped' | 'error', reason: string, output?: string | null) {
    const now = this.clock();
    const [ended] = await this.ctx.db
      .update(schema.routineRuns)
      .set({ status, reason, stepModel: null, finishedAt: now })
      .where(and(eq(schema.routineRuns.id, r.run.id), eq(schema.routineRuns.status, 'paused')))
      .returning({ id: schema.routineRuns.id });
    if (!ended) return;
    await this.ctx.db
      .update(schema.routineStepRuns)
      .set({ status, reason, finishedAt: now, ...(output !== undefined && { output }) })
      .where(and(eq(schema.routineStepRuns.id, r.step.id), eq(schema.routineStepRuns.status, 'waiting')));
    this.ctx.bus.refresh({ scope: 'routines' });
  }

  /**
   * A run held at a step goes on: it takes the routine's slot again, and the step after the held
   * one starts with what reached it; the run ends when the held step was its last. With `revise`,
   * the bot step before it is done again with that correction instead. While another run of the
   * routine holds the slot, it stays held, and goes on at a later pass.
   */
  private async goOn(
    r: HeldStep,
    t: T,
    o: { output?: string | null; revise?: string; trigger?: OutsideTrigger },
  ) {
    const { step, run } = r;
    const steps = snapshotSteps(run.stepsSnapshot) ?? [];
    const now = this.clock();
    const bot = await this.services.bots.get(r.routine.botId).catch(() => null);
    if (!bot || bot.archivedAt || !run.threadId) return this.endHeldRun(r, 'error', t('routine.botMissing'));
    // A paused bot does no work, and its next step's turn would end at once: the run stays held,
    // with its answer or event kept, and goes on at a pass after the bot is let go.
    if (await this.services.bots.isPaused(bot)) return;
    let resumed: RunRow | undefined;
    try {
      [resumed] = await this.ctx.db
        .update(schema.routineRuns)
        .set({ status: 'running', reason: null, ...(o.trigger && !run.trigger && { trigger: o.trigger }) })
        .where(and(eq(schema.routineRuns.id, run.id), eq(schema.routineRuns.status, 'paused')))
        .returning();
    } catch (err) {
      if (isUniqueViolation(err)) return;
      throw err;
    }
    if (!resumed) return;
    await this.ctx.db
      .update(schema.routineStepRuns)
      .set({ status: 'done', finishedAt: now, ...(o.output !== undefined && { output: o.output }) })
      .where(eq(schema.routineStepRuns.id, step.id));
    if (o.trigger && step.output) {
      // What came in shows in the run's conversation, marked as outside text.
      await this.services.threads.addMessage({
        threadId: run.threadId,
        role: 'user',
        author: `routine:${run.routineId}`,
        text: t('routine.payloadShown', { payload: step.output }),
        props: { routineRunId: run.id, routineName: r.routine.name, payload: true, outside: o.trigger },
      });
    }
    const rows = await this.ctx.db
      .select()
      .from(schema.routineStepRuns)
      .where(eq(schema.routineStepRuns.runId, run.id));
    const at: StepRun = {
      id: run.id,
      routineId: run.routineId,
      threadId: run.threadId,
      botId: bot.id,
      userId: r.routine.userId,
    };
    const route = routeFrom(steps, step.position, steps[step.position - 1]?.next);
    try {
      if (o.revise) {
        await this.restartStep(
          at,
          r.routine.name,
          run.promptSnapshot,
          steps,
          botStepAt(steps, step.position - 1, rows),
          rows,
          t('routine.reviseNote', { answer: o.revise }),
          t,
        );
      } else if ('to' in route) {
        await this.goTo(at, r.routine.name, steps, step.position, route.to, undefined, t);
      } else if ('lost' in route) {
        await this.lostRoute(at, route.lost, t);
      } else {
        // The held step was the last, or the run ends after it: what reached it is the run's report.
        await this.ctx.db
          .update(schema.routineRuns)
          .set({ status: 'done', finishedAt: now })
          .where(eq(schema.routineRuns.id, run.id));
        await this.deliver(
          bot.id,
          run.threadId,
          cutAt(handedOn(steps, rows, step.position + 1) ?? '', DELIVER_MAX),
          {
            id: run.id,
            routineName: r.routine.name,
            outside: resumed.trigger,
            slackChannel: r.routine.slackChannel,
          },
        );
        await this.startQueued(run.routineId);
      }
    } catch (err) {
      console.error(`Run ${run.id} could not go on after a held step`, err);
      await this.startFailed(run.routineId, run.id, err, t);
    }
    this.ctx.bus.refresh({ scope: 'routines' });
  }

  /** Approval steps past their time close their card; `settleSteps` then ends their run. */
  private async expireOverdue(now: Date) {
    const due = await this.ctx.db
      .select({ approvalId: schema.routineStepRuns.approvalId })
      .from(schema.routineStepRuns)
      .innerJoin(schema.approvals, eq(schema.approvals.id, schema.routineStepRuns.approvalId))
      .where(
        and(
          eq(schema.routineStepRuns.status, 'waiting'),
          lte(schema.routineStepRuns.waitUntil, now),
          eq(schema.approvals.status, 'pending'),
        ),
      );
    for (const d of due) await this.services.approvals.expire(d.approvalId!, true);
  }

  /** Ends the routine's runs held at an approval step, and closes their cards. */
  private async endHeld(routineId: string, reason: string) {
    const now = this.clock();
    const ended = await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'stopped', reason, stepModel: null, finishedAt: now })
      .where(and(eq(schema.routineRuns.routineId, routineId), eq(schema.routineRuns.status, 'paused')))
      .returning({ id: schema.routineRuns.id });
    if (!ended.length) return;
    const held = await this.ctx.db
      .update(schema.routineStepRuns)
      .set({ status: 'stopped', reason, finishedAt: now })
      .where(
        and(
          inArray(
            schema.routineStepRuns.runId,
            ended.map((e) => e.id),
          ),
          eq(schema.routineStepRuns.status, 'waiting'),
        ),
      )
      .returning({ approvalId: schema.routineStepRuns.approvalId });
    for (const h of held) if (h.approvalId) await this.services.approvals.expire(h.approvalId);
    this.ctx.bus.refresh({ scope: 'routines' });
  }

  /**
   * Starts the run's step at `position` again, with `note` saying why: the routine's own
   * instruction for the first, otherwise the step with what the step before it handed on.
   */
  private async restartStep(
    run: StepRun,
    routineName: string,
    promptSnapshot: string,
    steps: readonly RoutineStep[],
    position: number,
    rows: readonly (typeof schema.routineStepRuns.$inferSelect)[],
    note: string,
    t: T,
  ) {
    if (position > 0) {
      await this.startStep(run, routineName, steps, position, handedOn(steps, rows, position), t, note);
      return;
    }
    const reportOnly = await this.reportOnly(run.routineId);
    const prompt = [
      t('routine.prompt', { name: routineName, prompt: promptSnapshot, silent: SILENT_REPLY }),
      ...saveHint(steps, 0, t),
      ...(reportOnly ? [t('routine.reportOnly')] : []),
    ].join('\n\n');
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ stepModel: null })
      .where(eq(schema.routineRuns.id, run.id));
    const turn = await this.services.turns.enqueue({
      threadId: run.threadId,
      botId: run.botId,
      source: 'routine',
      prompt: `${note}\n\n${prompt}`,
      routineRunId: run.id,
      ...(run.userId && { userId: run.userId }),
      ...reportCap(reportOnly),
    });
    await this.stepStarted(run.id, 0, 'prompt', turn.id);
  }

  /**
   * What a run ended with goes where the routine reports: the person's main conversation for a
   * routine of its own conversation, the Slack channel for one reporting there.
   */
  private async deliver(
    botId: string,
    threadId: string,
    text: string,
    run: { id: string; routineName: string; outside: OutsideTrigger | null; slackChannel: string | null },
  ) {
    if (!text.trim() || isSilentReply(text)) return;
    const thread = await this.services.threads.row(threadId).catch(() => null);
    if (thread?.kind === 'routine') {
      await this.report(botId, thread, text, {
        routineRunId: run.id,
        routineName: run.routineName,
        // Written from outside text: a turn that is handed the report reads that text too.
        ...(run.outside ? { outside: run.outside } : {}),
      });
    }
    // A routine reporting to Slack posts what its run wrote in the team conversation there.
    if (run.slackChannel && thread?.kind === 'team') {
      await this.services.slack
        .report(run.slackChannel, run.routineName, text)
        .catch((err: unknown) => console.warn('slack report', err));
    }
  }

  /**
   * A run in the person's main conversation that found nothing to report stays there as its line,
   * marked quiet: drawn closed, with what the bot wrote of why under it, and folded with the quiet
   * runs of the same routine next to it. Taking the line away again after it showed while the run
   * worked looked like the run had vanished. A run that left anything else there, such as a card or
   * an earlier step's answer, is not quiet. A routine's own conversation is the record of its runs
   * and keeps them as they are.
   */
  private async settleQuietRun(runId: string, routineId: string, threadId: string, note?: string) {
    const thread = await this.services.threads.row(threadId).catch(() => null);
    if (thread?.kind !== 'user') return;
    // Props are sealed, so the run's instructions are told apart after they are read.
    const recent = await this.ctx.db
      .select({ id: schema.messages.id, props: schema.messages.props })
      .from(schema.messages)
      .where(and(eq(schema.messages.threadId, threadId), eq(schema.messages.author, `routine:${routineId}`)))
      .orderBy(desc(schema.messages.createdAt))
      .limit(QUIET_LOOKBACK);
    const own = recent.filter((m) => m.props.routineRunId === runId);
    // One that carries what started the run, a mail or a page, is what a later session reads it
    // from: it stays.
    if (!own.length || own.some((m) => m.props.payload || m.props.outside)) return;
    const [left] = await this.ctx.db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .innerJoin(schema.turns, eq(schema.turns.id, schema.messages.turnId))
      .where(and(eq(schema.messages.threadId, threadId), eq(schema.turns.routineRunId, runId)))
      .limit(1);
    if (left) return;
    const shown = note?.trim() ? cutAt(note.trim(), QUIET_NOTE_MAX) : '';
    for (const m of own)
      await this.services.threads.mergeProps(m.id, {
        routineQuiet: true,
        ...(shown && { quietNote: shown }),
      });
  }

  /**
   * A bot's turn of a run with steps ended. One that failed, or that the person stopped, ends the
   * run there, to be tried again from that step; nothing runs again by itself, since the steps
   * before it may already have changed something. A failed step with a way on failure goes on
   * there instead. One that ended well starts the step its way leads to, the next by default. True
   * when it handled the run; false for the last step ending well, which ends the run as a run of
   * one instruction does.
   */
  private async stepEnded(
    turn: TurnRow,
    outcome: TurnOutcome,
    run: {
      routineId: string;
      routineName: string;
      steps: unknown;
      failedByBot: boolean;
      reason: string | null;
      userId: string | null;
    },
  ): Promise<boolean> {
    const runId = turn.routineRunId!;
    const steps = snapshotSteps(run.steps) ?? [];
    const [current] = await this.ctx.db
      .select()
      .from(schema.routineStepRuns)
      .where(and(eq(schema.routineStepRuns.runId, runId), eq(schema.routineStepRuns.status, 'running')))
      .orderBy(desc(schema.routineStepRuns.position))
      .limit(1);
    const position = current?.position ?? 0;
    const now = this.clock();
    const endStep = (set: Partial<typeof schema.routineStepRuns.$inferInsert>) =>
      current
        ? this.ctx.db
            .update(schema.routineStepRuns)
            .set({ ...set, finishedAt: now })
            .where(eq(schema.routineStepRuns.id, current.id))
        : Promise.resolve();
    const endRun = async (set: Partial<typeof schema.routineRuns.$inferInsert>) => {
      await this.ctx.db
        .update(schema.routineRuns)
        .set({ ...set, stepModel: null, finishedAt: now })
        .where(eq(schema.routineRuns.id, runId));
      this.ctx.bus.refresh({ scope: 'routines' });
      await this.startQueued(run.routineId);
    };
    const at: StepRun = {
      id: runId,
      routineId: run.routineId,
      threadId: turn.threadId,
      botId: turn.botId,
      userId: run.userId,
    };
    if (run.failedByBot || !outcome.ok) {
      const stopped = !outcome.ok && outcome.kind === 'interrupted' && outcome.byPerson === true;
      const status = run.failedByBot ? 'error' : stopped ? 'stopped' : 'error';
      const reason = run.failedByBot ? run.reason : outcome.ok ? null : outcome.message;
      // A step with a way to go on failure takes it for work that really failed, or that the bot
      // said it could not do. A stop by the person, an account out of usage or a server stop end
      // the run as before: the step after would meet the same.
      const step = position > 0 ? steps[position - 1] : undefined;
      const onError = step?.kind === 'agent' ? step.onError : undefined;
      const route =
        onError && (run.failedByBot || realFailure(outcome)) ? routeFrom(steps, position, onError) : null;
      if (route && 'to' in route) {
        // The failure is handled where the routine said, and is not counted toward switching it
        // off: that way tells the person on each run, and a routine that watches for something
        // going down must not turn itself off once it does.
        await endStep({ status: 'error', reason, output: outcome.text.trim() || null });
        await this.ctx.db
          .update(schema.routineRuns)
          .set({ status: 'running', reason: null, failedByBot: false })
          .where(eq(schema.routineRuns.id, runId));
        const t = await this.services.settings.translator();
        const what = [
          t('routine.stepFailedBefore', { step: String(position + 1), reason: reason?.trim() || '-' }),
          ...(outcome.text.trim() ? [cutAt(outcome.text.trim(), REPORT_MAX)] : []),
        ].join('\n\n');
        await this.goTo(at, run.routineName, steps, position, route.to, what, t);
        this.ctx.bus.refresh({ scope: 'routines' });
        return true;
      }
      if (run.failedByBot || realFailure(outcome)) await this.countRun(run.routineId, 'failed', runId);
      await endStep({ status, reason, output: outcome.text.trim() || null });
      // A run the bot marked as failed keeps the bot's reason.
      await endRun(run.failedByBot ? {} : { status, reason });
      return true;
    }
    await endStep({ status: 'done', output: outcome.text.trim() || null });
    await this.countRun(run.routineId, 'ok');
    if (isSilentReply(outcome.text) || (outcome.ok && outcome.quiet)) {
      await this.settleQuietRun(
        runId,
        run.routineId,
        turn.threadId,
        outcome.ok ? outcome.quietNote : undefined,
      );
      const t = await this.services.settings.translator();
      const rest = position < steps.length;
      await endRun({
        status: 'done',
        reason: rest ? t('routine.stepsSkippedSilent', { step: String(position + 1) }) : null,
      });
      return true;
    }
    // The routine's own instruction has no way of its own: the first step comes after it.
    const route = routeFrom(steps, position, position > 0 ? steps[position - 1]?.next : '');
    // Ending here, its answer is the run's report, as the last step's is.
    if ('end' in route) return false;
    const t = await this.services.settings.translator();
    if ('lost' in route) await this.lostRoute(at, route.lost, t);
    else await this.goTo(at, run.routineName, steps, position, route.to, outcome.text, t);
    this.ctx.bus.refresh({ scope: 'routines' });
    return true;
  }

  /**
   * Starts a run with steps again at the step where it failed or was stopped, in its own
   * conversation, with what the step before it ended with.
   */
  async retryRun(routineId: string, runId: string): Promise<RoutineRun> {
    const routine = await this.get(routineId);
    const [run] = await this.ctx.db
      .select()
      .from(schema.routineRuns)
      .where(and(eq(schema.routineRuns.id, runId), eq(schema.routineRuns.routineId, routineId)))
      .limit(1);
    const steps = run ? snapshotSteps(run.stepsSnapshot) : null;
    if (!run || !steps || !run.threadId || (run.status !== 'error' && run.status !== 'stopped'))
      throw new HttpError(409, 'error.routineRunNotRetriable');
    const [failed] = await this.ctx.db
      .select()
      .from(schema.routineStepRuns)
      .where(
        and(
          eq(schema.routineStepRuns.runId, runId),
          inArray(schema.routineStepRuns.status, ['error', 'stopped']),
        ),
      )
      .orderBy(desc(schema.routineStepRuns.position))
      .limit(1);
    if (!failed) throw new HttpError(409, 'error.routineRunNotRetriable');
    const bot = await this.services.bots.get(routine.botId).catch(() => null);
    if (!bot || bot.archivedAt) throw new HttpError(409, 'error.routineRunNotRetriable');
    let restarted: RunRow | undefined;
    try {
      [restarted] = await this.ctx.db
        .update(schema.routineRuns)
        .set({ status: 'running', reason: null, finishedAt: null, failedByBot: false })
        .where(
          and(eq(schema.routineRuns.id, runId), inArray(schema.routineRuns.status, ['error', 'stopped'])),
        )
        .returning();
    } catch (err) {
      // Another run of the routine is going: this one is tried again once that one ends.
      if (isUniqueViolation(err)) throw new HttpError(409, 'error.routineBusy');
      throw err;
    }
    if (!restarted) throw new HttpError(409, 'error.routineRunNotRetriable');
    const t = await this.services.settings.translator();
    const rows = await this.ctx.db
      .select()
      .from(schema.routineStepRuns)
      .where(eq(schema.routineStepRuns.runId, runId));
    try {
      await this.restartStep(
        {
          id: runId,
          routineId,
          threadId: run.threadId,
          botId: bot.id,
          userId: routine.createdByUserId ?? null,
        },
        routine.name,
        restarted.promptSnapshot,
        steps,
        failed.position,
        rows,
        t('routine.stepRetry'),
        t,
      );
    } catch (err) {
      await this.startFailed(routineId, runId, err, t);
      throw err;
    }
    this.ctx.bus.refresh({ scope: 'routines' });
    return (await this.runs(routineId)).find((r) => r.id === runId) ?? toRun(restarted);
  }

  /**
   * What the bot wrote at the end of the routine's latest finished run before `except`, cut to a
   * size that keeps every later prompt small; null when no run has finished with a report.
   */
  async lastReport(
    routineId: string,
    except?: string,
    teamOnly = false,
  ): Promise<{ text: string; at: string; outside: OutsideTrigger | null } | null> {
    const [row] = await this.ctx.db
      .select({
        text: schema.messages.text,
        createdAt: schema.messages.createdAt,
        outside: schema.routineRuns.trigger,
      })
      .from(schema.routineRuns)
      .innerJoin(schema.turns, eq(schema.turns.routineRunId, schema.routineRuns.id))
      .innerJoin(schema.messages, eq(schema.messages.turnId, schema.turns.id))
      .innerJoin(schema.threads, eq(schema.threads.id, schema.turns.threadId))
      .where(
        and(
          eq(schema.routineRuns.routineId, routineId),
          eq(schema.routineRuns.status, 'done'),
          eq(schema.messages.role, 'assistant'),
          except ? ne(schema.routineRuns.id, except) : undefined,
          teamOnly ? eq(schema.threads.kind, 'team') : undefined,
          // What a run wrote about one WhatsApp chat is that chat's: never carried into another run.
          notLike(schema.routineRuns.occurrence, 'wa:%'),
        ),
      )
      .orderBy(desc(schema.routineRuns.startedAt), desc(schema.messages.createdAt))
      .limit(1);
    if (!row?.text.trim()) return null;
    const text = row.text.length > REPORT_MAX ? `${row.text.slice(0, REPORT_MAX)}…` : row.text;
    return { text, at: row.createdAt.toISOString().slice(0, 16).replace('T', ' '), outside: row.outside };
  }

  /**
   * Records a slot skipped because a run of the routine is still going. Slots skipped one after
   * another behind the same run share one line, which counts them: a run stuck for an hour on a
   * routine every five minutes leaves one line, not twelve.
   */
  private async recordBusy(routine: Routine, occurrence: string, t: T) {
    const [last] = await this.ctx.db
      .select()
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.routineId, routine.id))
      .orderBy(desc(schema.routineRuns.startedAt), desc(schema.routineRuns.id))
      .limit(1);
    if (last?.status === 'skipped' && last.busySkips > 0) {
      const [row] = await this.ctx.db
        .update(schema.routineRuns)
        .set({
          busySkips: sql`${schema.routineRuns.busySkips} + 1`,
          reason: t('routine.stillRunningMany', { count: last.busySkips + 1 }),
          finishedAt: this.clock(),
        })
        .where(eq(schema.routineRuns.id, last.id))
        .returning();
      if (row) return toRun(row);
    }
    return this.record(routine, occurrence, 'skipped', t('routine.stillRunning'), 1);
  }

  private async record(
    routine: Routine,
    occurrence: string,
    status: 'skipped' | 'error',
    reason: string,
    busySkips = 0,
  ) {
    try {
      const [row] = await this.ctx.db
        .insert(schema.routineRuns)
        .values({
          id: newId(),
          routineId: routine.id,
          occurrence,
          status,
          reason,
          promptSnapshot: routine.prompt,
          finishedAt: this.clock(),
          busySkips,
        })
        .returning();
      return toRun(row!);
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }

  /**
   * The bot says the routine's work is done for good ("remind me until I answer" and the person
   * answered): the routine pauses, and stays as a record the person can turn on again.
   */
  async stopFromRun(runId: string, reason: string): Promise<string | null> {
    const [run] = await this.ctx.db
      .select({ routineId: schema.routineRuns.routineId })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.id, runId));
    if (!run) return null;
    const [row] = await this.ctx.db
      .update(schema.routines)
      .set({ enabled: false, nextRunAt: null, resumeAt: null })
      .where(eq(schema.routines.id, run.routineId))
      .returning();
    await this.ctx.db.update(schema.routineRuns).set({ reason }).where(eq(schema.routineRuns.id, runId));
    this.ctx.bus.refresh({ scope: 'routines' });
    return row?.name ?? null;
  }

  /** The person opened the routine and saw its failed run: the bot's mark for it goes out. */
  async failureSeen(id: string) {
    await this.get(id);
    await this.ctx.db
      .update(schema.routines)
      .set({ failureSeenAt: this.clock() })
      .where(eq(schema.routines.id, id));
    this.ctx.bus.refresh({ scope: 'routines' });
  }

  /** The bot says its run could not do the task; the run ends as failed with that reason. */
  async markFailed(runId: string, reason: string) {
    await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'error', reason, failedByBot: true })
      .where(eq(schema.routineRuns.id, runId));
    this.ctx.bus.refresh({ scope: 'routines' });
  }

  /**
   * Whether a turn that ended well left the run waiting: it asked other bots and their answers have
   * not come back as the run's next turn yet.
   */
  private async awaitsAnswers(turn: TurnRow): Promise<boolean> {
    const [open] = await this.ctx.db
      .select({ id: schema.jobs.id })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.fromTurnId, turn.id),
          sql`${schema.jobs.kind} <> 'notify'`,
          isNull(schema.jobs.deliveredAt),
        ),
      )
      .limit(1);
    if (open) return true;
    const [next] = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.routineRunId, turn.routineRunId!),
          ne(schema.turns.id, turn.id),
          inArray(schema.turns.status, ['queued', 'running']),
        ),
      )
      .limit(1);
    return !!next;
  }

  /**
   * Ends the run of a turn that asked other bots, when the answer cannot reach it any more: its bot
   * was archived while the request was open, so no turn will read the answer and write the report.
   */
  async abandonAsked(fromTurnId: string) {
    const [turn] = await this.ctx.db
      .select({ routineRunId: schema.turns.routineRunId })
      .from(schema.turns)
      .where(eq(schema.turns.id, fromTurnId));
    if (!turn?.routineRunId) return;
    const t = await this.services.settings.translator();
    const [ended] = await this.ctx.db
      .update(schema.routineRuns)
      .set({ status: 'error', reason: t('routine.botMissing'), finishedAt: this.clock() })
      .where(
        and(
          eq(schema.routineRuns.id, turn.routineRunId),
          inArray(schema.routineRuns.status, ['running', 'waiting']),
          notExists(
            this.ctx.db
              .select({ id: schema.turns.id })
              .from(schema.turns)
              .where(
                and(
                  eq(schema.turns.routineRunId, schema.routineRuns.id),
                  inArray(schema.turns.status, ['queued', 'running']),
                ),
              ),
          ),
        ),
      )
      .returning({ id: schema.routineRuns.id });
    if (ended) this.ctx.bus.refresh({ scope: 'routines' });
  }

  async onTurnFinished(turn: TurnRow, outcome: TurnOutcome) {
    if (!turn.routineRunId) return;
    const [run] = await this.ctx.db
      .select({
        failedByBot: schema.routineRuns.failedByBot,
        reason: schema.routineRuns.reason,
        routineName: schema.routines.name,
        routineId: schema.routineRuns.routineId,
        outside: schema.routineRuns.trigger,
        slackChannel: schema.routines.slackChannel,
        steps: schema.routineRuns.stepsSnapshot,
        userId: schema.routines.createdByUserId,
        scheduled: schema.routineRuns.scheduled,
        occurrence: schema.routineRuns.occurrence,
        schedule: schema.routines.schedule,
        timezone: schema.routines.timezone,
      })
      .from(schema.routineRuns)
      .innerJoin(schema.routines, eq(schema.routines.id, schema.routineRuns.routineId))
      .where(eq(schema.routineRuns.id, turn.routineRunId));
    // A run that handed work to other bots goes on in the turn that reads their answers: this turn
    // only said it asked, which is not the run's report.
    if (run && !run.failedByBot && outcome.ok && (await this.awaitsAnswers(turn))) return;
    // A run with steps goes on to its next step; only its last one reports, as a run of one
    // instruction does.
    if (run?.steps && (await this.stepEnded(turn, outcome, run))) return;
    // A run that ended with the silent reply under what it wrote keeps that in its own
    // conversation, and reports nothing.
    if (run && outcome.ok && !outcome.quiet) {
      await this.deliver(turn.botId, turn.threadId, outcome.text, {
        id: turn.routineRunId,
        routineName: run.routineName,
        outside: run.outside,
        slackChannel: run.slackChannel,
      });
    }
    if (run && outcome.ok && !run.failedByBot && (!outcome.text.trim() || isSilentReply(outcome.text))) {
      await this.settleQuietRun(turn.routineRunId, run.routineId, turn.threadId, outcome.quietNote);
    }
    // The person's stop is an ending they chose, not a failure, and is not tried again.
    const stopped = !outcome.ok && outcome.kind === 'interrupted' && outcome.byPerson === true;
    await this.ctx.db
      .update(schema.routineRuns)
      .set(
        // A run the bot marked as failed stays failed, with the bot's reason.
        run?.failedByBot && outcome.ok
          ? { finishedAt: this.clock() }
          : {
              status: outcome.ok ? 'done' : stopped ? 'stopped' : 'error',
              reason: outcome.ok ? null : outcome.message,
              finishedAt: this.clock(),
            },
      )
      .where(eq(schema.routineRuns.id, turn.routineRunId));
    if (run) {
      if (run.failedByBot || realFailure(outcome))
        await this.countRun(run.routineId, 'failed', turn.routineRunId);
      else if (outcome.ok) await this.countRun(run.routineId, 'ok');
    }
    // The account was out of usage: the routine tries again once it resets, unless it is due sooner.
    if (run && !outcome.ok && outcome.kind === 'limit' && outcome.resetsAt) {
      await this.retryLater(run, new Date(outcome.resetsAt.getTime() + LIMIT_RETRY_DELAY_MS));
    }
    // A passing failure (an overloaded or unreachable provider), or a server stop that cut a
    // scheduled run short before it changed anything, is tried once more a little later, unless the
    // run before it failed just now too: a server that stops again and again does not run it again
    // each time.
    const passing = !outcome.ok && outcome.kind === 'engine' && outcome.transient === true;
    const cutByStop =
      !!run &&
      !outcome.ok &&
      outcome.kind === 'interrupted' &&
      outcome.restarted === true &&
      ownSlot(run) &&
      (await this.untouched(turn));
    if (run && (passing || cutByStop)) {
      const [before] = await this.ctx.db
        .select({ status: schema.routineRuns.status, finishedAt: schema.routineRuns.finishedAt })
        .from(schema.routineRuns)
        .where(
          and(eq(schema.routineRuns.routineId, run.routineId), ne(schema.routineRuns.id, turn.routineRunId)),
        )
        .orderBy(desc(schema.routineRuns.startedAt))
        .limit(1);
      const now = this.clock();
      const retried =
        before?.status === 'error' &&
        !!before.finishedAt &&
        now.getTime() - before.finishedAt.getTime() < RETRY_WINDOW_MS;
      if (!retried) {
        await this.retryLater(run, new Date(now.getTime() + TRANSIENT_RETRY_DELAY_MS));
      }
    }
    this.ctx.bus.refresh({ scope: 'routines' });
    if (run) await this.startQueued(run.routineId);
  }

  /**
   * Puts the routine's next run at `retryAt`, unless it is due sooner; once the retry has run, the
   * schedule goes on from the slot it stood in front of.
   *
   * The run's turn may end before `tick` has moved the routine past the run's own slot (see
   * `advance`): the retry then takes that slot's place and says where the schedule goes on, and
   * `advance`, finding the slot gone, leaves it. A one-time routine was put aside when it fired:
   * the retry of its own scheduled run takes it up again; one the person set to a new time since
   * keeps that time.
   */
  private async retryLater(
    run: {
      routineId: string;
      scheduled: boolean;
      outside: string | null;
      occurrence: string;
      schedule: unknown;
      timezone: string;
    },
    retryAt: Date,
  ) {
    const schedule = run.schedule as Schedule;
    const [now] = await this.ctx.db
      .select({ nextRunAt: schema.routines.nextRunAt, enabled: schema.routines.enabled })
      .from(schema.routines)
      .where(eq(schema.routines.id, run.routineId));
    if (!now) return;
    const slot = now.nextRunAt;
    // The routine still stands at this run's own slot: `advance` has not moved it on yet.
    const pending = !!slot && ownSlot(run) && occurrenceKey(slot) === run.occurrence;
    if (schedule.type === 'once') {
      // A run the person started by hand, or one an outside event started, is not the one-time run.
      if (!ownSlot(run) || (slot && !pending)) return;
      await this.ctx.db
        .update(schema.routines)
        .set({ enabled: true, nextRunAt: retryAt, resumeAt: null })
        .where(
          and(
            eq(schema.routines.id, run.routineId),
            slot ? eq(schema.routines.nextRunAt, slot) : isNull(schema.routines.nextRunAt),
          ),
        );
      return;
    }
    if (!now.enabled) return;
    if (pending) {
      await this.ctx.db
        .update(schema.routines)
        .set({ nextRunAt: retryAt, resumeAt: nextRun(schedule, run.timezone, this.clock(), slot) })
        .where(and(eq(schema.routines.id, run.routineId), eq(schema.routines.nextRunAt, slot)));
      return;
    }
    await this.ctx.db
      .update(schema.routines)
      .set({ nextRunAt: retryAt, resumeAt: resumeFrom })
      .where(
        and(
          eq(schema.routines.id, run.routineId),
          eq(schema.routines.enabled, true),
          or(isNull(schema.routines.nextRunAt), gt(schema.routines.nextRunAt, retryAt)),
        ),
      );
  }

  /**
   * Whether running the turn's run again from the start repeats nothing: the turn is the run's
   * only one (no earlier one handed work on or read other bots' answers), and it let through no
   * step but reads.
   */
  private async untouched(turn: TurnRow): Promise<boolean> {
    if (turn.changed || !turn.routineRunId) return false;
    const [other] = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(and(eq(schema.turns.routineRunId, turn.routineRunId), ne(schema.turns.id, turn.id)))
      .limit(1);
    return !other;
  }
}

/**
 * How many runs in a row may really fail before the routine switches itself off. Enough that a
 * bad day (a site down for hours, a provider outage that outlasts the retry) does not stop it, few
 * enough that a routine that can never work stops after a day or so of an hourly schedule.
 */
export const FAILURE_LIMIT = 10;

/**
 * Whether a turn's ending is the routine's own failure. A usage limit, a sign-in that expired, a
 * provider that is busy for now, a restart and the person's stop say nothing about the routine, and
 * the first two would end every routine at once.
 */
/**
 * Turns away steps whose routes name no step after their own: the bot's tools and an import write
 * steps without the request's schema, and a route that goes back could run a step again and again.
 */
function checkRoutes(steps: readonly RoutineStep[] | undefined) {
  const problem = steps ? stepRoutesProblem(steps) : null;
  if (problem) throw new HttpError(400, isServerKey(problem) ? problem : 'validation.stepRoute');
}

function realFailure(outcome: TurnOutcome): boolean {
  if (outcome.ok) return false;
  return (outcome.kind === 'engine' && outcome.transient !== true) || outcome.kind === 'stalled';
}

/** The most of what started a run that is kept beside it, so a rehearsal can replay it. */
export const INPUT_MAX = 20_000;

/** What starts a run, as it is kept with the run: cut to size; null when nothing was handed in. */
const keptInput = (payload: string | undefined): string | null =>
  payload?.trim() ? cutAt(payload, INPUT_MAX) : null;

/**
 * What a routine's turn is asked: the instruction, the report of the run before when the routine
 * carries it, and what started the run (a mail, a changed page), the last two as data. A run and
 * its rehearsal are asked the same.
 */
export function routinePrompt(
  t: T,
  name: string,
  prompt: string,
  payload: string | undefined,
  report: { text: string; at: string } | null,
  /** What a routine with steps tells the bot about saving its step's result; none for a rehearsal. */
  hints: string[] = [],
  /** The routine only looks and reports: the bot is told it may change nothing. */
  reportOnly = false,
): string {
  const base = [
    t('routine.prompt', { name, prompt, silent: SILENT_REPLY }),
    ...hints,
    ...(reportOnly ? [t('routine.reportOnly')] : []),
  ].join('\n\n');
  const full = report
    ? `${base}\n\n${t('routine.lastReport', { at: report.at, report: fence(report.text) })}`
    : base;
  return payload ? `${full}\n\n${t('routine.payload', { payload })}` : full;
}

/**
 * What a turn of a report-only routine is enqueued with: held to reading, so a step that would
 * change something is refused whatever the bot's own level is. Every turn of the run carries it,
 * the person's own turns in the same conversation do not (the cap belongs to the turn).
 */
export const reportCap = (reportOnly: boolean | undefined) =>
  reportOnly ? { modeCap: 'readonly' as const } : {};

/** Whether a run is the routine's own scheduled one, with no outside text that started it. */
const ownSlot = (run: { scheduled: boolean; outside: string | null }) => run.scheduled && !run.outside;

/** A run waiting this long on a card nobody answered gives way to the routine's next run. */
const STALE_WAIT_MS = 30 * 60_000;

/**
 * The occurrence a busy skip is recorded under. A webhook delivery and a WhatsApp batch are
 * offered again by whoever sent them, so their skip must not take the occurrence their next try
 * runs under.
 */
const retriable = (occurrence: string) =>
  occurrence.startsWith('hook:') || occurrence.startsWith('wa:')
    ? `${occurrence}:busy:${newId().slice(0, 8)}`
    : occurrence;
/** The most runs of one routine kept waiting for the one going to end. */
const MAX_QUEUED = 20;
/** A run that failed for a passing reason starts again this long after. */
const TRANSIENT_RETRY_DELAY_MS = 5 * 60_000;
/** A failed run that ended this recently before the failing one means it was already the second try. */
const RETRY_WINDOW_MS = 30 * 60_000;
/** The most of a posted webhook body that goes into the conversation. */
const POST_MAX = 20_000;
/** A slot this late counts as missed while the server was off. */
const MISSED_GRACE_MS = 10 * 60_000;
/** A routine stopped by the usage limit runs again this long after the limit resets. */
const LIMIT_RETRY_DELAY_MS = 2 * 60_000;
/** Routines one bot may have; each run costs, and a list this long is already hard to keep up. */
export const MAX_ROUTINES_PER_BOT = 50;
/** Watched pages and app checks read at once before their routines run. */
const MAX_READS = 4;

/**
 * What a retry keeps as the slot it stands in front of: the next run the routine had, or the one an
 * earlier retry still waiting kept.
 */
const resumeFrom = sql`coalesce(${schema.routines.resumeAt}, ${schema.routines.nextRunAt})`;

/** What an app's webhook secret is bound to when sealed: its routine. */
const webhookSecretBinding = (id: string) => ['routine_webhook_secret', id] as const;

/** A JSON body with the event's kind added as `event`, for the filter; other bodies as they are. */
function withEvent(body: string, event?: string): string {
  if (!event) return body;
  try {
    const json = JSON.parse(body) as unknown;
    if (json && typeof json === 'object' && !Array.isArray(json)) return JSON.stringify({ event, ...json });
  } catch {
    // Not JSON: only an empty filter passes it.
  }
  return JSON.stringify({ event });
}

/** Compares two secrets in a time that does not tell how much of a guess was right. */
function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** The steps a run of the routine starts with; null for a routine with none. */
/** A run held at a step, with the step and what of the routine it goes on with. */
interface HeldStep {
  step: typeof schema.routineStepRuns.$inferSelect;
  run: RunRow;
  routine: { name: string; botId: string; userId: string | null; slackChannel: string | null };
}

/** Where a run's step works, and for whom. */
interface StepRun {
  id: string;
  routineId: string;
  threadId: string;
  botId: string;
  userId: string | null;
}

const DAY_MS = 24 * 60 * 60_000;

/**
 * Tells a bot step which values the wait steps after it need saved, so a wait on "the issue it
 * opened" does not hang on the person knowing the tool's name.
 */
function saveHint(steps: readonly RoutineStep[], position: number, t: T): string[] {
  const names = varsWanted(steps, position);
  return names.length ? [t('routine.saveValues', { names: names.join(', ') })] : [];
}

/** A step that works with no AI and can fail: it reads an address or takes values from JSON. */
type DataStep = Extract<RoutineStep, { kind: 'fetch' | 'extract' }>;

/** Why a fetch step's address could not be read, in the step's own words rather than a skill link's. */
function fetchProblem(err: unknown, t: T): string {
  if (err instanceof HttpError) {
    if (err.key === 'error.skillLinkStatus')
      return t('routine.fetchStatus', { status: err.params?.status ?? '?' });
    if (err.key === 'error.skillLinkTooLarge')
      return t('routine.fetchTooLarge', { kb: String(FETCH_MAX / 1024) });
    if (err.key === 'error.skillLinkPrivate') return t('routine.fetchPrivate');
  }
  return t('routine.fetchUnreachable');
}

/** Whether a routine's runs may stop part way for the person or for something to happen. */
function holdsRuns(routine: Routine): boolean {
  return !!routine.steps?.some((s) => s.kind === 'approval' || s.kind === 'wait');
}

function stepsOf(routine: Routine): RoutineStep[] | null {
  return routine.steps?.length ? routine.steps : null;
}

/** A routine that reports to a Slack channel shares what it reads there: never WhatsApp chats. */
function checkWhatsAppPlace(slackChannel: string | null | undefined) {
  if (slackChannel) throw new HttpError(400, 'error.whatsappSlack');
}
