import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Rehearsal, RehearsalStart, RehearsalStep, ReplayableRun } from '@leafbot/shared';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { isSilentReply, type TurnOutcome } from '../engine/types';
import type { TurnRow } from '../runtime/turns';
import { errorText, HttpError, newId, notFound, truncate } from '../util';
import { reportCap, routinePrompt } from './routines';
import type { Services } from '.';

/** A rehearsal and its conversation are kept this long. */
export const REHEARSAL_KEEP_DAYS = 7;
/** The most steps one rehearsal writes down; a bot stuck in a loop does not fill the table. */
const STEPS_MAX = 200;
/** How many of a routine's latest runs can be replayed. */
const REPLAY_RUNS = 5;
/** How many rehearsals of a routine are listed. */
const LIST_MAX = 10;

/**
 * Trying a routine once without doing anything. The bot works as the routine's run would, for the
 * same person, but every step that changes something is not done and is written down as one it
 * would take (the turn decides that, see `isRehearsalRead`). Nothing of the routine itself is
 * touched: no run is recorded, so its schedule, last run, carried report and failure marks stay.
 */
export class RehearsalService {
  /** Each running rehearsal's steps; written to its row as they come, in order. */
  private steps = new Map<string, RehearsalStep[]>();
  private writes = new Map<string, Promise<void>>();
  /**
   * Routines whose rehearsal is being started: the check for one already running and the row it
   * writes are two queries, so two quick starts would both pass it.
   */
  private starting = new Set<string>();
  /**
   * Rehearsals on a routine's last real inputs still to start, by routine: one runs at a time, so
   * each starts when the one before ends. Kept in memory; after a restart the rest do not start.
   */
  private batches = new Map<string, { batchId: string; userId: string; prompt?: string; runIds: string[] }>();

  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  /** The turn took, or only wrote down, a step. */
  async note(id: string, step: Omit<RehearsalStep, 'at'>): Promise<void> {
    let list = this.steps.get(id);
    if (!list) {
      const [row] = await this.ctx.db
        .select({ steps: schema.routineRehearsals.steps })
        .from(schema.routineRehearsals)
        .where(eq(schema.routineRehearsals.id, id));
      list = row?.steps ?? [];
      this.steps.set(id, list);
    }
    if (list.length >= STEPS_MAX) return;
    list.push({ ...step, summary: truncate(step.summary, 500), at: this.clock().toISOString() });
    const snapshot = [...list];
    const write = (this.writes.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(() =>
        this.ctx.db
          .update(schema.routineRehearsals)
          .set({ steps: snapshot })
          .where(eq(schema.routineRehearsals.id, id))
          .then(() => undefined),
      );
    this.writes.set(id, write);
    await write.catch((err: unknown) => console.warn(`Could not keep a rehearsal's step: ${String(err)}`));
  }

  /**
   * Starts a rehearsal of a routine for `userId`. `draft` instructions are tried instead of the
   * saved ones; `replayRunId` hands the bot what started one of the routine's last runs.
   */
  async start(routineId: string, userId: string, input: RehearsalStart): Promise<Rehearsal> {
    if (this.starting.has(routineId)) throw new HttpError(409, 'error.rehearsalRunning');
    this.starting.add(routineId);
    try {
      if (!input.replayLast) return await this.begin(routineId, userId, input);
      // The newest runs that kept what started them, one rehearsal each.
      const runIds = (await this.replayable(routineId, userId))
        .filter((r) => r.replayable)
        .slice(0, input.replayLast)
        .map((r) => r.runId);
      if (!runIds.length) throw new HttpError(400, 'error.rehearsalNoInput');
      const batchId = newId();
      const first = await this.begin(
        routineId,
        userId,
        { prompt: input.prompt, replayRunId: runIds[0] },
        batchId,
      );
      if (runIds.length > 1) {
        this.batches.set(routineId, { batchId, userId, prompt: input.prompt, runIds: runIds.slice(1) });
      }
      return first;
    } finally {
      this.starting.delete(routineId);
    }
  }

  private async begin(
    routineId: string,
    userId: string,
    input: RehearsalStart,
    batchId: string | null = null,
  ): Promise<Rehearsal> {
    const t = await this.services.settings.translator();
    const routine = await this.services.routines.get(routineId);
    const bot = await this.services.bots.get(routine.botId);
    if (bot.archivedAt) throw new HttpError(400, 'error.rehearsalBotMissing');
    const typed = input.prompt?.trim();
    const draft = !!typed && typed !== routine.prompt;
    const prompt = typed || routine.prompt;
    // It works for whoever set the routine up, as a run would. Someone else who may change the bot
    // can only try their own instructions: those would work for them once saved, and they must not
    // read the other person's world (their notes, apps, mail) through a rehearsal's report. A
    // routine that reports to a team channel uses only what the team shares, so anyone may.
    const owner = await this.services.routines.personOf(routine);
    const team = !!routine.slackChannel;
    if (owner !== userId && !team && (!draft || input.replayRunId)) {
      throw new HttpError(403, 'error.rehearsalNotYours');
    }
    const person = owner === userId || team ? owner : userId;
    const [going] = await this.ctx.db
      .select({ id: schema.routineRehearsals.id })
      .from(schema.routineRehearsals)
      .where(
        and(
          eq(schema.routineRehearsals.routineId, routineId),
          eq(schema.routineRehearsals.status, 'running'),
        ),
      )
      .limit(1);
    if (going) throw new HttpError(409, 'error.rehearsalRunning');

    let replay: { id: string; trigger: string | null; input: string } | null = null;
    if (input.replayRunId) {
      const [run] = await this.ctx.db
        .select({
          id: schema.routineRuns.id,
          trigger: schema.routineRuns.trigger,
          input: schema.routineRuns.triggerInput,
        })
        .from(schema.routineRuns)
        .where(and(eq(schema.routineRuns.id, input.replayRunId), eq(schema.routineRuns.routineId, routineId)))
        .limit(1);
      if (!run) throw notFound('routineRun');
      if (!run.input) throw new HttpError(400, 'error.rehearsalNoInput');
      replay = { id: run.id, trigger: run.trigger, input: run.input };
    }
    // The report the run before would have been handed, when the routine carries it. It was
    // written from its person's world, so it goes only to a rehearsal that works for them.
    const report =
      routine.carryReport && person === owner
        ? await this.services.routines.lastReport(routine.id, replay?.id, team)
        : null;

    const thread = await this.services.threads.rehearsalThread(bot.id, routine.name, person);
    const [row] = await this.ctx.db
      .insert(schema.routineRehearsals)
      .values({
        id: newId(),
        routineId,
        userId,
        threadId: thread.id,
        draft,
        replayRunId: replay?.id ?? null,
        batchId,
        prompt,
      })
      .returning();
    try {
      await this.services.threads.addMessage({
        threadId: thread.id,
        role: 'user',
        author: `routine:${routine.id}`,
        text: replay ? `${prompt}\n\n${t('routine.payloadShown', { payload: replay.input })}` : prompt,
        props: { routineName: routine.name, rehearsal: row!.id },
      });
      const turn = await this.services.turns.enqueue({
        threadId: thread.id,
        botId: bot.id,
        source: 'routine',
        prompt: routinePrompt(t, routine.name, prompt, replay?.input, report, [], !!routine.reportOnly),
        rehearsalId: row!.id,
        userId: person,
        ...reportCap(routine.reportOnly),
        // What the run was started by is read as outside text again, as it was then.
        outside: replay?.trigger ? (replay.trigger as NonNullable<TurnRow['outside']>) : null,
      });
      await this.ctx.db
        .update(schema.routineRehearsals)
        .set({ turnId: turn.id })
        .where(eq(schema.routineRehearsals.id, row!.id));
    } catch (err) {
      // No turn will end it: left running, it would hold off every later rehearsal of the routine.
      await this.ctx.db
        .update(schema.routineRehearsals)
        .set({ status: 'error', error: errorText(err, t), finishedAt: this.clock() })
        .where(eq(schema.routineRehearsals.id, row!.id))
        .catch(() => {});
      throw err;
    }
    this.ctx.bus.refresh({ scope: 'routines' });
    return (await this.view(row!.id))!;
  }

  /** The routine's rehearsals `userId` asked for, newest first. */
  async list(routineId: string, userId: string): Promise<Rehearsal[]> {
    const rows = await this.ctx.db
      .select({ id: schema.routineRehearsals.id })
      .from(schema.routineRehearsals)
      .where(
        and(
          eq(schema.routineRehearsals.routineId, routineId),
          eq(schema.routineRehearsals.userId, userId),
          isNull(schema.routineRehearsals.prunedAt),
        ),
      )
      .orderBy(desc(schema.routineRehearsals.startedAt))
      .limit(LIST_MAX);
    const out: Rehearsal[] = [];
    for (const r of rows) out.push((await this.view(r.id))!);
    return out;
  }

  /** One rehearsal of the routine, when it is `userId`'s. */
  async get(routineId: string, id: string, userId: string): Promise<Rehearsal> {
    const [row] = await this.ctx.db
      .select({ routineId: schema.routineRehearsals.routineId, userId: schema.routineRehearsals.userId })
      .from(schema.routineRehearsals)
      .where(eq(schema.routineRehearsals.id, id))
      .limit(1);
    if (!row || row.routineId !== routineId || row.userId !== userId) throw notFound('rehearsal');
    return (await this.view(id))!;
  }

  /**
   * The routine's last runs, and whether what started each was kept. Only the person the
   * routine works for may replay, so only they are told which can be.
   */
  async replayable(routineId: string, userId: string): Promise<ReplayableRun[]> {
    const routine = await this.services.routines.get(routineId);
    const owner = await this.services.routines.personOf(routine);
    if (owner !== userId && !routine.slackChannel) throw new HttpError(403, 'error.rehearsalNotYours');
    const rows = await this.ctx.db
      .select({
        id: schema.routineRuns.id,
        startedAt: schema.routineRuns.startedAt,
        status: schema.routineRuns.status,
        trigger: schema.routineRuns.trigger,
        kept: sql<boolean>`${schema.routineRuns.triggerInput} is not null`,
      })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.routineId, routineId))
      .orderBy(desc(schema.routineRuns.startedAt))
      .limit(REPLAY_RUNS);
    return rows.map((r) => ({
      runId: r.id,
      startedAt: r.startedAt.toISOString(),
      // A run held at a step shows as waiting, as the routine's own list shows it.
      status: r.status === 'paused' ? 'waiting' : r.status,
      trigger: r.trigger,
      replayable: r.kept,
    }));
  }

  /** A rehearsal as its person reads it, with the report of the run it replayed beside it. */
  private async view(id: string): Promise<Rehearsal | null> {
    const [r] = await this.ctx.db
      .select()
      .from(schema.routineRehearsals)
      .where(and(eq(schema.routineRehearsals.id, id), isNull(schema.routineRehearsals.prunedAt)))
      .limit(1);
    if (!r) return null;
    let replay: Rehearsal['replay'] = null;
    if (r.replayRunId) {
      const [run] = await this.ctx.db
        .select({ startedAt: schema.routineRuns.startedAt, status: schema.routineRuns.status })
        .from(schema.routineRuns)
        .where(eq(schema.routineRuns.id, r.replayRunId))
        .limit(1);
      if (run) {
        const [said] = await this.ctx.db
          .select({ text: schema.messages.text })
          .from(schema.turns)
          .innerJoin(schema.messages, eq(schema.messages.turnId, schema.turns.id))
          .where(and(eq(schema.turns.routineRunId, r.replayRunId), eq(schema.messages.role, 'assistant')))
          .orderBy(desc(schema.messages.createdAt))
          .limit(1);
        replay = {
          runId: r.replayRunId,
          startedAt: run.startedAt.toISOString(),
          status: run.status === 'paused' ? 'waiting' : run.status,
          report: said?.text ?? null,
        };
      }
    }
    return {
      id: r.id,
      routineId: r.routineId,
      draft: r.draft,
      prompt: r.prompt,
      status: r.status,
      report: r.report,
      steps: r.steps,
      error: r.error,
      costUsd: r.costUsd,
      startedAt: r.startedAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
      batchId: r.batchId,
      replay,
    };
  }

  /** A rehearsal's turn ended: its report, steps and cost are kept, and nothing else follows. */
  async onTurnFinished(turn: TurnRow, outcome: TurnOutcome): Promise<void> {
    const id = turn.rehearsalId;
    if (!id) return;
    await this.writes.get(id)?.catch(() => {});
    const [cost] = await this.ctx.db
      .select({ costUsd: schema.turns.costUsd })
      .from(schema.turns)
      .where(eq(schema.turns.id, turn.id));
    await this.ctx.db
      .update(schema.routineRehearsals)
      .set({
        status: outcome.ok ? 'done' : outcome.kind === 'interrupted' ? 'stopped' : 'error',
        report: outcome.ok && !outcome.quiet && !isSilentReply(outcome.text) ? outcome.text : '',
        error: outcome.ok ? null : outcome.message,
        costUsd: cost?.costUsd ?? outcome.costUsd ?? null,
        finishedAt: this.clock(),
      })
      .where(eq(schema.routineRehearsals.id, id));
    this.steps.delete(id);
    this.writes.delete(id);
    this.ctx.bus.refresh({ scope: 'routines' });
    await this.next(id, outcome);
  }

  /** Starts the next rehearsal of a batch on the routine's last inputs; a stopped one ends the batch. */
  private async next(id: string, outcome: TurnOutcome): Promise<void> {
    const [row] = await this.ctx.db
      .select({ routineId: schema.routineRehearsals.routineId, batchId: schema.routineRehearsals.batchId })
      .from(schema.routineRehearsals)
      .where(eq(schema.routineRehearsals.id, id))
      .limit(1);
    const batch = row && this.batches.get(row.routineId);
    if (!row?.batchId || !batch || batch.batchId !== row.batchId) return;
    const runId = batch.runIds.shift();
    if (!runId || (!outcome.ok && outcome.kind === 'interrupted')) {
      this.batches.delete(row.routineId);
      return;
    }
    if (!batch.runIds.length) this.batches.delete(row.routineId);
    await this.begin(
      row.routineId,
      batch.userId,
      { prompt: batch.prompt, replayRunId: runId },
      batch.batchId,
    ).catch((err: unknown) => {
      this.batches.delete(row.routineId);
      console.warn(`Could not start the next rehearsal of routine ${row.routineId}: ${String(err)}`);
    });
  }

  /** Whether a batch of rehearsals is still to go on for the routine (tests). */
  batchGoing(routineId: string): boolean {
    return this.batches.has(routineId);
  }

  /**
   * Lets go of the words of rehearsals older than a week: their conversation's lines and files,
   * the instruction and steps. The turns stay, without their words, and keep their cost: a
   * rehearsal spent real money, and usage and the monthly limit count it from the turns.
   */
  async prune(now = this.clock()): Promise<void> {
    const before = new Date(now.getTime() - REHEARSAL_KEEP_DAYS * 86_400_000);
    const old = await this.ctx.db
      .select({
        id: schema.routineRehearsals.id,
        threadId: schema.routineRehearsals.threadId,
        botId: schema.threads.botId,
      })
      .from(schema.routineRehearsals)
      .leftJoin(schema.threads, eq(schema.threads.id, schema.routineRehearsals.threadId))
      .where(and(lt(schema.routineRehearsals.startedAt, before), isNull(schema.routineRehearsals.prunedAt)));
    for (const r of old) {
      if (r.threadId) {
        await this.services.turns.interrupt(r.threadId);
        await this.ctx.db.delete(schema.messages).where(eq(schema.messages.threadId, r.threadId));
        await this.ctx.db
          .update(schema.turns)
          .set({ prompt: '' })
          .where(eq(schema.turns.threadId, r.threadId));
        await this.ctx.db.update(schema.threads).set({ title: '' }).where(eq(schema.threads.id, r.threadId));
        if (r.botId) {
          await rm(join(this.ctx.config.dataDir, 'workspaces', 'bots', r.botId, 'threads', r.threadId), {
            recursive: true,
            force: true,
          }).catch(() => {});
        }
        await rm(join(this.ctx.config.dataDir, 'uploads', r.threadId), {
          recursive: true,
          force: true,
        }).catch(() => {});
      }
      await this.ctx.db
        .update(schema.routineRehearsals)
        .set({ prompt: '', report: '', steps: [], error: null, prunedAt: now })
        .where(eq(schema.routineRehearsals.id, r.id));
    }
  }
}
