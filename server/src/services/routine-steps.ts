import type { RoutineStep, RoutineStepRun } from '@leafbot/shared';
import { filterVars, RoutineStep as StepSchema } from '@leafbot/shared';
import type { schema } from '../db';
import { iso } from '../util';

type StepRow = typeof schema.routineStepRuns.$inferSelect;

/** How much of a step's output a run's list shows; the conversation has all of it. */
const SHOWN_OUTPUT = 400;

/**
 * The steps a run was started with. Read leniently: a step this server no longer knows (written by a
 * newer one, then the server went back) is dropped rather than failing the whole run's view.
 */
export function snapshotSteps(raw: unknown): RoutineStep[] | null {
  if (!Array.isArray(raw)) return null;
  const steps: RoutineStep[] = [];
  for (const item of raw) {
    const parsed = StepSchema.safeParse(item);
    if (parsed.success) steps.push(parsed.data);
  }
  return steps;
}

/** The kind a run's step at `position` has: its own instruction first, then the steps after it. */
export function kindAt(steps: readonly RoutineStep[], position: number): string {
  return position === 0 ? 'prompt' : (steps[position - 1]?.kind ?? 'agent');
}

/** Whether the run's step at `position` is the bot's work: its own instruction or a bot step. */
export function isBotStep(steps: readonly RoutineStep[], position: number): boolean {
  const kind = kindAt(steps, position);
  return kind === 'prompt' || kind === 'agent';
}

/**
 * What reaches the step at `position`: the output of the nearest bot step before it, and after it,
 * what each wait step in between brought in (a webhook's body, a mail). An approval step lets
 * through what came before it and adds nothing.
 */
export function handedOn(
  steps: readonly RoutineStep[],
  rows: readonly StepRow[],
  position: number,
): string | null {
  const parts: string[] = [];
  for (let p = position - 1; p >= 0; p--) {
    const output = rows.find((r) => r.position === p)?.output?.trim() || null;
    if (isBotStep(steps, p)) {
      if (output) parts.unshift(output);
      break;
    }
    if (kindAt(steps, p) === 'wait' && output) parts.unshift(output);
  }
  return parts.length ? parts.join('\n\n') : null;
}

/** The nearest bot step at or before `position`: the one a written correction sends back to. */
export function botStepAt(steps: readonly RoutineStep[], position: number): number {
  let p = position;
  while (p > 0 && !isBotStep(steps, p)) p--;
  return p;
}

/** The names of the values the wait steps after `position` put in their filter. */
export function varsWanted(steps: readonly RoutineStep[], position: number): string[] {
  return [
    ...new Set(
      steps
        .slice(position)
        .flatMap((s) => (s.kind === 'wait' && s.on !== 'time' ? filterVars(s.filter) : [])),
    ),
  ];
}

/** Every step of a run, with the ones that have not started as `pending`. */
export function stepList(steps: readonly RoutineStep[], rows: readonly StepRow[]): RoutineStepRun[] {
  const at = new Map(rows.map((r) => [r.position, r]));
  return Array.from({ length: steps.length + 1 }, (_, position) => {
    const row = at.get(position);
    const id = position > 0 ? steps[position - 1]?.id : undefined;
    if (!row) {
      return {
        position,
        kind: kindAt(steps, position),
        ...(id && { stepId: id }),
        status: 'pending' as const,
        output: null,
        reason: null,
        startedAt: null,
        finishedAt: null,
      };
    }
    const output = row.output?.trim() ? row.output.trim() : null;
    return {
      position,
      kind: row.kind,
      ...(id && { stepId: id }),
      status: row.status,
      output: output && output.length > SHOWN_OUTPUT ? `${output.slice(0, SHOWN_OUTPUT)}…` : output,
      reason: row.reason,
      startedAt: row.startedAt.toISOString(),
      finishedAt: iso(row.finishedAt),
      ...(row.approvalId && { approvalId: row.approvalId }),
      ...(row.waitUntil && { waitUntil: row.waitUntil.toISOString() }),
    };
  });
}
