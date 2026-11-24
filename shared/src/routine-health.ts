import { z } from 'zod';
import { ROUTINE_APPROVAL_MAX_DAYS, type Routine, type RoutineStep } from './schedule';

/**
 * A routine's health, worked out from its runs with no AI: how they ended, what they cost, and
 * what in them points to something worth changing. Every finding carries numbers only; the words
 * come from the app's catalogs, so they are in the reader's language.
 */

/** How far back the runs are read. */
export const ROUTINE_HEALTH_DAYS = 30;
/** How many runs with a known ending a share of them is judged on, at least. */
export const ROUTINE_HEALTH_MIN_RUNS = 5;
/** Fewer runs with a known ending than this, and nothing wrong otherwise: too early to say. */
export const ROUTINE_HEALTH_FEW_RUNS = 3;
/** A finding the person set aside, about the routine's state rather than its runs, shows again after this. */
export const ROUTINE_HEALTH_DISMISS_DAYS = 30;

export const ROUTINE_HEALTH_FINDINGS = [
  'failing',
  'pausedByFailures',
  'signInWait',
  'stepFails',
  'waitTimeouts',
  'mostlyQuiet',
  'idle',
] as const;
export const RoutineHealthFindingId = z.enum(ROUTINE_HEALTH_FINDINGS);
export type RoutineHealthFindingId = z.infer<typeof RoutineHealthFindingId>;

/** Findings about how the routine stands now, not about its runs: set aside, they wait out the days. */
const STATE_FINDINGS: ReadonlySet<RoutineHealthFindingId> = new Set([
  'pausedByFailures',
  'signInWait',
  'idle',
]);

export const RoutineHealthStatus = z.enum(['problem', 'improvable', 'unused', 'good', 'unknown']);
export type RoutineHealthStatus = z.infer<typeof RoutineHealthStatus>;

const STATUS_OF: Record<RoutineHealthFindingId, Exclude<RoutineHealthStatus, 'good' | 'unknown'>> = {
  failing: 'problem',
  pausedByFailures: 'problem',
  signInWait: 'problem',
  stepFails: 'improvable',
  waitTimeouts: 'improvable',
  mostlyQuiet: 'improvable',
  idle: 'unused',
};

export const RoutineHealthFinding = z.object({
  id: RoutineHealthFindingId,
  /** How many runs (or, for `failing` from its streak, failures in a row) it is about. */
  count: z.number().int(),
  /** Out of how many runs; absent when it is not a share. */
  of: z.number().int().optional(),
  /** The step it is about, counted from 1 after the routine's own instruction. */
  step: z.number().int().optional(),
  /** What the runs it is about cost, when every one of them had a known price. */
  costUsd: z.number().optional(),
  /** For `idle`: the routine is on (it looks, but nothing starts it), or paused by the person. */
  enabled: z.boolean().optional(),
});
export type RoutineHealthFinding = z.infer<typeof RoutineHealthFinding>;

export const RoutineHealth = z.object({
  routineId: z.string(),
  status: RoutineHealthStatus,
  /** When the oldest run with a known ending in the window started; null when there is none. */
  since: z.string().nullable(),
  runs: z.object({
    /** Every run in the window that started, however it ended; the skipped are counted apart. */
    total: z.number().int(),
    ok: z.number().int(),
    quiet: z.number().int(),
    failed: z.number().int(),
    /** Slots passed over without running (a condition that did not hold, a sign-in, a busy run). */
    skipped: z.number().int(),
  }),
  /** What the runs in the window cost, with those that had a turn of unknown price left out. */
  costUsd: z.number(),
  unpricedRuns: z.number().int(),
  /** How long a run with a known ending took on average, waits for the person included. */
  avgMs: z.number().nullable(),
  findings: z.array(RoutineHealthFinding),
  /** Findings this person set aside that still hold, so the screen can say some are hidden. */
  hidden: z.number().int(),
});
export type RoutineHealth = z.infer<typeof RoutineHealth>;

export const RoutineHealthDismiss = z.object({ finding: RoutineHealthFindingId });
export type RoutineHealthDismiss = z.infer<typeof RoutineHealthDismiss>;

/** A run as the health reads it. */
export interface HealthRun {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  /** How it ended; null for one still going or held at a step, whatever an earlier step said. */
  outcome: 'ok' | 'quiet' | 'failed' | null;
  /** A slot passed over without running. */
  skipped: boolean;
  /** What its turns and its pre-check cost; null when one of its turns had no known price. */
  costUsd: number | null;
}

/** A step of a run, counted from 0 for the routine's own instruction. */
export interface HealthStepRun {
  runId: string;
  position: number;
  kind: string;
  status: string;
  /**
   * The step as the run had it: its id, and how long it waited. A step that was changed, moved or
   * replaced since is not the routine's step at that position any more, so its endings do not count.
   */
  stepId?: string;
  timeoutDays?: number;
}

export interface HealthInput {
  routine: Pick<
    Routine,
    'enabled' | 'createdAt' | 'lastRunAt' | 'condition' | 'watchUrl' | 'check' | 'signInWait' | 'pausedReason'
  > & { steps?: readonly RoutineStep[] };
  failureStreak: number;
  /** The runs of the window, any order. */
  runs: readonly HealthRun[];
  steps: readonly HealthStepRun[];
  now: Date;
}

const DAY_MS = 86_400_000;

function sumCost(runs: readonly HealthRun[]): number | undefined {
  if (runs.some((r) => r.costUsd === null)) return undefined;
  return runs.reduce((a, r) => a + (r.costUsd ?? 0), 0);
}

/** What the runs and the routine's state say, before anything is set aside. */
export function healthFindings(input: HealthInput): RoutineHealthFinding[] {
  const { routine, runs, now } = input;
  const out: RoutineHealthFinding[] = [];
  const measured = runs.filter((r) => r.outcome);
  // Newest first: "the last runs" are read from the front.
  const recent = [...measured].sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());

  if (routine.pausedReason === 'failures') out.push({ id: 'pausedByFailures', count: input.failureStreak });
  if (routine.signInWait) out.push({ id: 'signInWait', count: 0 });

  if (routine.pausedReason !== 'failures') {
    if (input.failureStreak >= 3) out.push({ id: 'failing', count: input.failureStreak });
    else if (recent.length >= ROUTINE_HEALTH_MIN_RUNS) {
      const last = recent.slice(0, 10);
      const bad = last.filter((r) => r.outcome === 'failed').length;
      if (bad >= 3 && bad * 2 >= last.length) out.push({ id: 'failing', count: bad, of: last.length });
    }
  }

  // A step after the instruction that ended in error in several runs, as the routine has it now.
  const steps = routine.steps ?? [];
  const errorsAt = new Map<number, Set<string>>();
  const timeoutsAt = new Map<number, Set<string>>();
  for (const s of input.steps) {
    const step = steps[s.position - 1];
    if (s.position < 1 || s.status !== 'error' || !step) continue;
    if (s.stepId !== undefined && s.stepId !== step.id) continue;
    const waits = step.kind === 'approval' || step.kind === 'wait';
    // Waits that ran out under a shorter limit say nothing about the limit it has now.
    if (waits && s.timeoutDays !== undefined && s.timeoutDays !== step.timeoutDays) continue;
    const into = waits ? timeoutsAt : errorsAt;
    const set = into.get(s.position) ?? new Set<string>();
    set.add(s.runId);
    into.set(s.position, set);
  }
  for (const [position, ids] of [...errorsAt].sort((a, b) => a[0] - b[0])) {
    const step = steps[position - 1];
    // A step with a way to go on failure has its failures handled already, often on purpose (a
    // backup source, a routine that watches for something going down).
    if (ids.size >= 3 && step?.kind === 'agent' && !step.onError)
      out.push({ id: 'stepFails', step: position, count: ids.size });
  }
  for (const [position, ids] of [...timeoutsAt].sort((a, b) => a[0] - b[0])) {
    const step = steps[position - 1];
    if (ids.size < 2 || !step || (step.kind !== 'approval' && step.kind !== 'wait')) continue;
    // A wait for a time does not time out; one already at the longest has nowhere to go.
    if (step.kind === 'wait' && step.on === 'time') continue;
    if (step.timeoutDays >= ROUTINE_APPROVAL_MAX_DAYS) continue;
    out.push({ id: 'waitTimeouts', step: position, count: ids.size });
  }

  // Runs that mostly find nothing to report, started with nothing to look at first.
  const looks = !!(routine.condition || routine.watchUrl || routine.check);
  const quiet = measured.filter((r) => r.outcome === 'quiet');
  if (!looks && measured.length >= 10 && quiet.length * 5 >= measured.length * 4) {
    const cost = sumCost(quiet);
    out.push({
      id: 'mostlyQuiet',
      count: quiet.length,
      of: measured.length,
      ...(cost !== undefined && { costUsd: cost }),
    });
  }

  // Nothing ran for the whole window, for a routine older than it; slots passed over do not count.
  const since = now.getTime() - ROUTINE_HEALTH_DAYS * DAY_MS;
  const last = routine.lastRunAt ? Date.parse(routine.lastRunAt) : null;
  if (
    Date.parse(routine.createdAt) <= since &&
    !runs.some((r) => !r.skipped) &&
    (last === null || last < since) &&
    routine.pausedReason !== 'failures'
  )
    out.push({ id: 'idle', count: 0, enabled: routine.enabled });

  return out;
}

/**
 * The health as one person sees it: findings they set aside stay hidden while they hold, unless
 * the runs since then meet them again (or, for one about the routine's state, the days ran out).
 */
export function routineHealth(
  routineId: string,
  input: HealthInput,
  dismissed: ReadonlyMap<RoutineHealthFindingId, Date> = new Map(),
): RoutineHealth {
  const all = healthFindings(input);
  const shown: RoutineHealthFinding[] = [];
  let hidden = 0;
  for (const f of all) {
    const at = dismissed.get(f.id);
    if (!at) {
      shown.push(f);
      continue;
    }
    const again = STATE_FINDINGS.has(f.id)
      ? input.now.getTime() - at.getTime() >= ROUTINE_HEALTH_DISMISS_DAYS * DAY_MS
      : healthFindings({
          ...input,
          failureStreak: 0,
          runs: input.runs.filter((r) => r.startedAt > at),
          steps: input.steps.filter((s) => input.runs.some((r) => r.id === s.runId && r.startedAt > at)),
        }).some((g) => g.id === f.id && g.step === f.step);
    if (again) shown.push(f);
    else hidden++;
  }
  const measured = input.runs.filter((r) => r.outcome);
  const timed = measured.filter((r) => r.finishedAt);
  const skipped = input.runs.filter((r) => r.skipped).length;
  const priced = input.runs.filter((r) => r.costUsd !== null);
  const rank: Record<RoutineHealthStatus, number> = {
    problem: 0,
    improvable: 1,
    unused: 2,
    good: 3,
    unknown: 4,
  };
  let status: RoutineHealthStatus = measured.length < ROUTINE_HEALTH_FEW_RUNS ? 'unknown' : 'good';
  for (const f of shown) if (rank[STATUS_OF[f.id]] < rank[status]) status = STATUS_OF[f.id];
  const oldest = measured.reduce<Date | null>((a, r) => (!a || r.startedAt < a ? r.startedAt : a), null);
  return {
    routineId,
    status,
    since: oldest?.toISOString() ?? null,
    runs: {
      total: input.runs.length - skipped,
      ok: measured.filter((r) => r.outcome === 'ok').length,
      quiet: measured.filter((r) => r.outcome === 'quiet').length,
      failed: measured.filter((r) => r.outcome === 'failed').length,
      skipped,
    },
    costUsd: priced.reduce((a, r) => a + (r.costUsd ?? 0), 0),
    unpricedRuns: input.runs.length - priced.length,
    avgMs: timed.length
      ? Math.round(
          timed.reduce((a, r) => a + (r.finishedAt!.getTime() - r.startedAt.getTime()), 0) / timed.length,
        )
      : null,
    findings: shown,
    hidden,
  };
}

/**
 * The change a finding's "Apply" makes to the routine, for one that has a change worked out with
 * no AI: a step that waits for the person or an event and keeps running out of time waits twice as
 * long, up to the longest allowed. Null for every other finding (those are asked of the bot).
 */
export function healthFix(
  routine: Pick<Routine, 'steps'>,
  finding: Pick<RoutineHealthFinding, 'id' | 'step'>,
): { steps: RoutineStep[]; step: number; from: number; to: number } | null {
  if (finding.id !== 'waitTimeouts' || !finding.step) return null;
  const steps = routine.steps ?? [];
  const step = steps[finding.step - 1];
  if (!step || (step.kind !== 'approval' && step.kind !== 'wait')) return null;
  if (step.kind === 'wait' && step.on === 'time') return null;
  const to = Math.min(ROUTINE_APPROVAL_MAX_DAYS, step.timeoutDays * 2);
  if (to <= step.timeoutDays) return null;
  return {
    steps: steps.map((s, i) => (i === finding.step! - 1 ? { ...s, timeoutDays: to } : s)) as RoutineStep[],
    step: finding.step,
    from: step.timeoutDays,
    to,
  };
}
