import { ROUTINE_STEP_MAX } from '@leafbot/shared';

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

/**
 * Where a step dragged from `from` lands when let go over the gap before position `gap` (0 is the
 * gap above the first step, `steps.length` the one below the last): the place it then has.
 */
export function dropPlace(from: number, gap: number): number {
  return gap > from ? gap - 1 : gap;
}
