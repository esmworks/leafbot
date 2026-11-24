import type { RoutineStep, RoutineStepRun } from '@leafbot/shared';
import { filterVars, parseFields, ROUTINE_STEP_END, RoutineStep as StepSchema } from '@leafbot/shared';
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

/**
 * Where a run goes from the step at `position` along a route: `to` the position of the step it
 * starts next, `end` when it ends there, `lost` when the route names a step the run does not have
 * after this one (a step the server could not read when the run started). Empty is the usual way:
 * the step after it, or the end after the last.
 */
export type Route = { to: number } | { end: true } | { lost: string };

export function routeFrom(steps: readonly RoutineStep[], position: number, target?: string): Route {
  if (!target) return position < steps.length ? { to: position + 1 } : { end: true };
  if (target === ROUTINE_STEP_END) return { end: true };
  const at = steps.findIndex((s) => s.id === target) + 1;
  return at > position ? { to: at } : { lost: target };
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

/** Whether the run's step at `position` makes what the steps after it read: a fetch or extract step. */
export function isDataStep(steps: readonly RoutineStep[], position: number): boolean {
  const kind = kindAt(steps, position);
  return kind === 'fetch' || kind === 'extract';
}

/**
 * What reaches the step at `position`: the output of the nearest bot, fetch or extract step before
 * it, and after it, what each wait step in between brought in (a webhook's body, a mail). An
 * approval step lets through what came before it and adds nothing.
 */
export function handedOn(
  steps: readonly RoutineStep[],
  rows: readonly StepRow[],
  position: number,
): string | null {
  const parts: string[] = [];
  for (let p = position - 1; p >= 0; p--) {
    const row = rows.find((r) => r.position === p);
    // A step its condition passed over hands on what reached it, as if it were not there.
    if (row?.status === 'skipped') continue;
    const output = row?.output?.trim() || null;
    if (isBotStep(steps, p) || isDataStep(steps, p)) {
      if (output) parts.unshift(output);
      break;
    }
    if (kindAt(steps, p) === 'wait' && output) parts.unshift(output);
  }
  return parts.length ? parts.join('\n\n') : null;
}

/** How many of the last paragraphs of a text `jsonIn` tries, so a long page is not read over and over. */
const JSON_TAIL_PARTS = 20;

/**
 * The JSON an extract step reads in what reached it: all of it, or else its shortest tail that is JSON. What
 * reaches a step after a wait step is the bot step's answer and then what came in (a webhook's
 * body), a paragraph apart. Undefined when there is none.
 */
export function jsonIn(text: string): unknown {
  const parts = text.split('\n\n');
  for (let i = 0; i < parts.length && i <= JSON_TAIL_PARTS; i++) {
    try {
      return JSON.parse(parts.slice(i === 0 ? 0 : parts.length - i).join('\n\n'));
    } catch {
      // Not JSON: try the last paragraphs, one more each time.
    }
  }
  return undefined;
}

/**
 * The nearest bot step at or before `position` that ran: the one a written correction sends back
 * to. One its condition passed over did no work to correct.
 */
export function botStepAt(
  steps: readonly RoutineStep[],
  position: number,
  rows: readonly StepRow[] = [],
): number {
  let p = position;
  while (p > 0 && (!isBotStep(steps, p) || rows.find((r) => r.position === p)?.status === 'skipped')) p--;
  return p;
}

/**
 * The names of the values the steps after `position` put in a wait step's filter or a fetch step's
 * address, less those an extract step before that one takes.
 */
export function varsWanted(steps: readonly RoutineStep[], position: number): string[] {
  const given = new Set<string>();
  const wanted = new Set<string>();
  for (const s of steps.slice(position)) {
    const used =
      s.kind === 'wait' && s.on !== 'time'
        ? filterVars(s.filter)
        : s.kind === 'fetch'
          ? filterVars(s.url)
          : [];
    for (const name of used) if (!given.has(name)) wanted.add(name);
    if (s.kind === 'extract') for (const f of parseFields(s.fields) ?? []) given.add(f.name);
  }
  return [...wanted];
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
