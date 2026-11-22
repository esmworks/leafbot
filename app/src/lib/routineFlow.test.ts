import { ROUTINE_STEP_MAX } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { dropPlace, insertStep, moveStep, removeStep } from './routineFlow';

describe('routine flow changes', () => {
  const abc = ['a', 'b', 'c'] as const;

  it('inserts at a place, up to the step limit', () => {
    expect(insertStep(abc, 0, 'x')).toEqual(['x', 'a', 'b', 'c']);
    expect(insertStep(abc, 3, 'x')).toEqual(['a', 'b', 'c', 'x']);
    expect(insertStep(abc, 4, 'x')).toBe(abc);
    const full = Array.from({ length: ROUTINE_STEP_MAX }, (_, i) => String(i));
    expect(insertStep(full, 0, 'x')).toBe(full);
  });

  it('moves and removes without touching the list given', () => {
    expect(moveStep(abc, 0, 2)).toEqual(['b', 'c', 'a']);
    expect(moveStep(abc, 2, 0)).toEqual(['c', 'a', 'b']);
    expect(moveStep(abc, 1, 5)).toBe(abc);
    expect(removeStep(abc, 1)).toEqual(['a', 'c']);
    expect(removeStep(abc, 3)).toBe(abc);
    expect(abc).toEqual(['a', 'b', 'c']);
  });

  it('a step let go over a gap lands where the gap was', () => {
    // Dragging "a" (0) to the gap below "b" (gap 2) puts it second.
    expect(moveStep(abc, 0, dropPlace(0, 2))).toEqual(['b', 'a', 'c']);
    // Dragging "c" (2) to the gap above "a" (gap 0) puts it first.
    expect(moveStep(abc, 2, dropPlace(2, 0))).toEqual(['c', 'a', 'b']);
    // The gaps right around a step leave it where it is.
    expect(moveStep(abc, 1, dropPlace(1, 1))).toBe(abc);
    expect(moveStep(abc, 1, dropPlace(1, 2))).toBe(abc);
  });
});
