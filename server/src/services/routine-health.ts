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
      .where(and(inArray(schema.routineRuns.routineId, ids), gte(schema.routineRuns.startedAt, since)));
    // Queued runs have not started; they say nothing yet about how the routine goes.
    const live = runRows.filter((r) => r.status !== 'queued');
    const runIds = live.map((r) => r.id);

    const turnRows = runIds.length
      ? await this.ctx.db
          .select({ runId: schema.turns.routineRunId, costUsd: schema.turns.costUsd })
          .from(schema.turns)
          .where(and(inArray(schema.turns.routineRunId, runIds), isNotNull(schema.turns.finishedAt)))
      : [];
    const cost = new Map<string, number | null>();
    for (const t of turnRows) {
      const id = t.runId!;
      const was = cost.has(id) ? cost.get(id)! : 0;
      cost.set(id, was === null || t.costUsd === null ? null : was + t.costUsd);
    }

    const stepRows = runIds.length
      ? await this.ctx.db
          .select({
            runId: schema.routineStepRuns.runId,
            position: schema.routineStepRuns.position,
            kind: schema.routineStepRuns.kind,
            status: schema.routineStepRuns.status,
          })
          .from(schema.routineStepRuns)
          .where(inArray(schema.routineStepRuns.runId, runIds))
      : [];

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
    const runRoutine = new Map<string, string>();
    for (const r of live) {
      const turns = cost.has(r.id) ? cost.get(r.id)! : 0;
      const run: HealthRun = {
        id: r.id,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        outcome: r.outcome,
        costUsd: turns === null ? null : turns + (r.gateCostUsd ?? 0),
      };
      runsOf.set(r.routineId, [...(runsOf.get(r.routineId) ?? []), run]);
      runRoutine.set(r.id, r.routineId);
    }
    const stepsOf = new Map<string, HealthStepRun[]>();
    for (const s of stepRows) {
      const routine = runRoutine.get(s.runId)!;
      stepsOf.set(routine, [...(stepsOf.get(routine) ?? []), s]);
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
