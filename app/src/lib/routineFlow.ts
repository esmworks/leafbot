import { ROUTINE_STEP_MAX, type RoutineRun, type RoutineStepRun } from '@leafbot/shared';

/**
 * Changes to a routine's steps as the flow view makes them: insert at a place, move one to another
 * place, remove one. Each returns a new list and leaves the one given as it was; a change that
 * cannot be made (past the step limit, a place outside the list) returns the list unchanged.
 */

/** Puts `step` at `at` (0 is first); at most `ROUTINE_STEP_MAX` steps. */
export function insertStep<S>(steps: readonly S[], at: number, step: S): readonly S[] {
  if (steps.length >= ROUTINE_STEP_MAX || at < 0 || at > steps.length) return steps;
  return [...steps.slice(0, at), step, ...steps.slice(at)];
}

/** Moves the step at `from` so it ends up at `to` in the new list. */
export function moveStep<S>(steps: readonly S[], from: number, to: number): readonly S[] {
  if (from === to || from < 0 || from >= steps.length || to < 0 || to >= steps.length) return steps;
  const next = [...steps];
  const [s] = next.splice(from, 1);
  next.splice(to, 0, s!);
  return next;
}

/** Takes out the step at `at`. */
export function removeStep<S>(steps: readonly S[], at: number): readonly S[] {
  if (at < 0 || at >= steps.length) return steps;
  return steps.filter((_, i) => i !== at);
}

/** Where a box sits on the canvas, in pixels from its top left. */
export type Spot = { x: number; y: number };

/** How wide each box is. */
export const BOX_W = 288;
/** How far down a box's lines meet it: beside its title. */
export const PORT_Y = 22;
/** Room between two boxes side by side, and around the canvas's edge. */
const GAP = 56;
const EDGE = 24;
/** How far apart rows of boxes start; boxes are seldom taller than this less the gap. */
const ROW = 340;

/** A place on the canvas's grid, never off its top or left. */
export function snap(v: number): number {
  return Math.max(0, Math.round(v / 8) * 8);
}

const overlaps = (a: Spot, b: Spot) =>
  Math.abs(a.x - b.x) < BOX_W + GAP / 2 && Math.abs(a.y - b.y) < ROW - GAP;

/**
 * Where each box goes, in the order they run: a box with a place of its own keeps it; one without
 * (new, or never moved) goes right of the box before it, on to a new row when the canvas `width`
 * runs out, and further down while another box is in the way.
 */
export function placeBoxes(
  ids: readonly string[],
  saved: Readonly<Record<string, Spot>> | null | undefined,
  width: number,
): Record<string, Spot> {
  const out: Record<string, Spot> = {};
  // Boxes with a place of their own are in the way of new ones, also those further on.
  const placed: Spot[] = ids.flatMap((id) => (saved?.[id] ? [saved[id]] : []));
  let prev: Spot | null = null;
  for (const id of ids) {
    let spot: Spot | undefined = saved?.[id];
    if (!spot) {
      spot = prev ? { x: prev.x + BOX_W + GAP, y: prev.y } : { x: EDGE, y: EDGE };
      if (spot.x + BOX_W + EDGE > width && spot.x > EDGE) spot = { x: EDGE, y: prev!.y + ROW };
      while (placed.some((p) => overlaps(p, spot!))) spot = { x: spot.x, y: spot.y + ROW / 2 };
    }
    if (!saved?.[id]) placed.push(spot);
    out[id] = spot;
    prev = spot;
  }
  return out;
}

/** How big the canvas must be to hold every box, with room to drag one further. */
export function canvasSize(spots: readonly Spot[]): { width: number; height: number } {
  return {
    width: Math.max(0, ...spots.map((s) => s.x)) + BOX_W + EDGE + GAP,
    height: Math.max(0, ...spots.map((s) => s.y)) + ROW,
  };
}

/**
 * The line from one box to the next: out of the right side of the first, into the left of the
 * second. When the next box starts left of where the first ends (the next row), the line turns
 * down beside the first, runs back along the gap above the second and comes into it from the left,
 * so it stays on the canvas and does not cross the boxes.
 */
export function link(from: Spot, to: Spot): { path: string; mid: Spot } {
  const a = { x: from.x + BOX_W, y: from.y + PORT_Y };
  const b = { x: to.x, y: to.y + PORT_Y };
  if (b.x >= a.x + 16) {
    const bend = Math.max(48, (b.x - a.x) / 2);
    return {
      path: `M ${a.x} ${a.y} C ${a.x + bend} ${a.y} ${b.x - bend} ${b.y} ${b.x} ${b.y}`,
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
    };
  }
  const lane = to.y - GAP / 2;
  const out = 32;
  const into = Math.min(32, Math.max(8, b.x - 4));
  return {
    path:
      `M ${a.x} ${a.y} C ${a.x + out} ${a.y} ${a.x + out} ${lane} ${a.x} ${lane} ` +
      `L ${b.x} ${lane} C ${b.x - into} ${lane} ${b.x - into} ${b.y} ${b.x} ${b.y}`,
    mid: { x: (a.x + b.x) / 2, y: lane },
  };
}

/** The places worth keeping: only the boxes there are, on the grid. */
export function keepLayout(
  spots: Readonly<Record<string, Spot>>,
  ids: readonly string[],
): Record<string, Spot> {
  return Object.fromEntries(
    ids.filter((id) => spots[id]).map((id) => [id, { x: snap(spots[id]!.x), y: snap(spots[id]!.y) }]),
  );
}

/** How a box's part of a run went. */
export type RunPart = Pick<RoutineStepRun, 'status' | 'output' | 'reason'> &
  Partial<Pick<RoutineStepRun, 'waitUntil' | 'approvalId' | 'kind'>>;

/** A run of a routine without steps, as its instruction's box shows it. */
const RUN_AS_STEP: Record<RoutineRun['status'], RoutineStepRun['status']> = {
  running: 'running',
  waiting: 'waiting',
  done: 'done',
  error: 'error',
  stopped: 'stopped',
  skipped: 'skipped',
  queued: 'pending',
};

/** How the run as a whole is going, in a step's words. */
export function runAsStep(run: RoutineRun): RoutineStepRun['status'] {
  return RUN_AS_STEP[run.status];
}

/**
 * How a run went at a box: `null` for the routine's own instruction, otherwise a step's id. A step
 * is found by its id, never by its place: one moved since the run still shows its part, and one put
 * in where another was taken out shows nothing, since it has not run yet.
 */
export function runPart(run: RoutineRun | null | undefined, stepId: string | null): RunPart | undefined {
  if (!run) return undefined;
  if (stepId === null) {
    const own = run.steps?.find((s) => s.position === 0);
    return own ?? (run.steps ? undefined : { status: runAsStep(run), output: null, reason: run.reason });
  }
  return run.steps?.find((s) => s.stepId === stepId);
}
