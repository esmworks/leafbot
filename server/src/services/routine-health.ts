import {
  ROUTINE_HEALTH_DAYS,
  routineHealth,
  type HealthRun,
  type HealthStepRun,
  type RoutineHealth,
  type RoutineHealthFindingId,
} from '@leafbot/shared';
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { notFound } from '../util';
import type { Viewer } from './access';
import { toRoutine } from './mappers';
import type { Services } from '.';

const DAY_MS = 86_400_000;

/**
 * Each routine's health, read from its runs with no AI each time it is asked for: nothing is kept
 * but the findings a person set aside. Only routines of bots the person may change are read, as in
 * the list of routines, and only numbers leave here, never what a run wrote.
 */
export class RoutineHealthService {
  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  async list(viewer: Viewer, routineId?: string): Promise<RoutineHealth[]> {
    const editable = await this.services.access.botIds(viewer, 'edit');
    if (!editable.length) return [];
    const routines = await this.ctx.db
      .select()
      .from(schema.routines)
      .where(
        and(
          inArray(schema.routines.botId, editable),
          routineId ? eq(schema.routines.id, routineId) : undefined,
        ),
      );
    if (!routines.length) return [];
    const ids = routines.map((r) => r.id);
    const now = this.clock();
    const since = new Date(now.getTime() - ROUTINE_HEALTH_DAYS * DAY_MS);

    // Read by the routines and the window, never by a list of runs: a routine that runs every few
    // minutes has thousands in 30 days, more than a query can carry as values.
    const window = and(inArray(schema.routineRuns.routineId, ids), gte(schema.routineRuns.startedAt, since));
    const runRows = await this.ctx.db
      .select({
        id: schema.routineRuns.id,
        routineId: schema.routineRuns.routineId,
        startedAt: schema.routineRuns.startedAt,
        finishedAt: schema.routineRuns.finishedAt,
        outcome: schema.routineRuns.outcome,
        gateCostUsd: schema.routineRuns.gateCostUsd,
        status: schema.routineRuns.status,
      })
      .from(schema.routineRuns)
      .where(window);

    // Each run's turns, summed here: what they cost, and how many had no known price.
    const turnRows = await this.ctx.db
      .select({
        runId: schema.turns.routineRunId,
        costUsd: sql<number | string | null>`sum(${schema.turns.costUsd})`,
        unpriced: sql<number | string>`count(*) filter (where ${schema.turns.costUsd} is null)`,
      })
      .from(schema.turns)
      .innerJoin(schema.routineRuns, eq(schema.routineRuns.id, schema.turns.routineRunId))
      .where(and(window, isNotNull(schema.turns.finishedAt)))
      .groupBy(schema.turns.routineRunId);
    const cost = new Map<string, number | null>(
      turnRows.map((t) => [t.runId!, Number(t.unpriced) > 0 ? null : Number(t.costUsd ?? 0)]),
    );

    // Only steps after the instruction that ended in error are read: no rule looks at the others.
    const stepRows = await this.ctx.db
      .select({
        runId: schema.routineStepRuns.runId,
        routineId: schema.routineRuns.routineId,
        position: schema.routineStepRuns.position,
        kind: schema.routineStepRuns.kind,
        status: schema.routineStepRuns.status,
        snapshot: schema.routineRuns.stepsSnapshot,
      })
      .from(schema.routineStepRuns)
      .innerJoin(schema.routineRuns, eq(schema.routineRuns.id, schema.routineStepRuns.runId))
      .where(
        and(window, eq(schema.routineStepRuns.status, 'error'), gte(schema.routineStepRuns.position, 1)),
      );

    const dismissals = await this.ctx.db
      .select()
      .from(schema.routineHealthDismissals)
      .where(
        and(
          eq(schema.routineHealthDismissals.userId, viewer.userId),
          inArray(schema.routineHealthDismissals.routineId, ids),
        ),
      );

    const runsOf = new Map<string, HealthRun[]>();
    for (const r of runRows) {
      // Queued runs have not started; they say nothing yet about how the routine goes.
      if (r.status === 'queued') continue;
      const turns = cost.has(r.id) ? cost.get(r.id)! : 0;
      const list = runsOf.get(r.routineId) ?? [];
      runsOf.set(r.routineId, list);
      list.push({
        id: r.id,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        // A run still going, or held at a step, has only an earlier step's ending so far.
        outcome: r.finishedAt ? r.outcome : null,
        skipped: r.status === 'skipped',
        costUsd: turns === null ? null : turns + (r.gateCostUsd ?? 0),
      });
    }
    const stepsOf = new Map<string, HealthStepRun[]>();
    for (const s of stepRows) {
      const had = Array.isArray(s.snapshot)
        ? (s.snapshot[s.position - 1] as Record<string, unknown>)
        : undefined;
      const list = stepsOf.get(s.routineId) ?? [];
      stepsOf.set(s.routineId, list);
      list.push({
        runId: s.runId,
        position: s.position,
        kind: s.kind,
        status: s.status,
        ...(typeof had?.id === 'string' && { stepId: had.id }),
        ...(typeof had?.timeoutDays === 'number' && { timeoutDays: had.timeoutDays }),
      });
    }

    return routines.map((row) => {
      const routine = toRoutine(row);
      const dismissed = new Map<RoutineHealthFindingId, Date>(
        dismissals
          .filter((d) => d.routineId === row.id)
          .map((d) => [d.finding as RoutineHealthFindingId, d.dismissedAt]),
      );
      return routineHealth(
        row.id,
        {
          routine,
          failureStreak: row.failureStreak,
          runs: runsOf.get(row.id) ?? [],
          steps: stepsOf.get(row.id) ?? [],
          now,
        },
        dismissed,
      );
    });
  }

  /** Sets a finding aside for this person; setting it aside again starts its count afresh. */
  async dismiss(viewer: Viewer, routineId: string, finding: RoutineHealthFindingId): Promise<RoutineHealth> {
    const routine = await this.services.routines.get(routineId);
    await this.services.access.requireBot(viewer, routine.botId, 'edit');
    // Written with the database's time, as the runs' start is: it is compared with theirs.
    await this.ctx.db
      .insert(schema.routineHealthDismissals)
      .values({ routineId, userId: viewer.userId, finding, dismissedAt: sql`now()` })
      .onConflictDoUpdate({
        target: [
          schema.routineHealthDismissals.routineId,
          schema.routineHealthDismissals.userId,
          schema.routineHealthDismissals.finding,
        ],
        set: { dismissedAt: sql`now()` },
      });
    const [health] = await this.list(viewer, routineId);
    if (!health) throw notFound('routine');
    return health;
  }
}
