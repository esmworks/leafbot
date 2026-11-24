import { FLOW_LAYOUT_MAX, FlowLayout, ROUTINE_STEP_MAX, type RoutineRun } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import {
  BOX_W,
  canvasSize,
  insertStep,
  jumpLink,
  keepLayout,
  link,
  moveStep,
  placeBoxes,
  removeStep,
  runPart,
  snap,
  takenWays,
  type RunPart,
} from './routineFlow';

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

  it('places boxes without a place of their own beside the one before, in rows', () => {
    const at = placeBoxes(['start', 'prompt', 'a', 'b'], null, 1100);
    expect(at.start).toEqual({ x: 24, y: 24 });
    expect(at.prompt!.y).toBe(24);
    expect(at.a!.y).toBe(24);
    // The fourth does not fit on the first row.
    expect(at.b!.x).toBe(24);
    expect(at.b!.y).toBeGreaterThan(at.a!.y);
    // One moved keeps its place; the next goes beside it.
    const moved = placeBoxes(['start', 'prompt'], { start: { x: 400, y: 400 } }, 2000);
    expect(moved.start).toEqual({ x: 400, y: 400 });
    expect(moved.prompt!.y).toBe(400);
    expect(moved.prompt!.x).toBeGreaterThan(400 + BOX_W);
  });

  it('puts a new box below one in its way', () => {
    const at = placeBoxes(['start', 'new'], { start: { x: 24, y: 24 } }, 380);
    expect(at.new!.x).toBe(24);
    expect(at.new!.y).toBeGreaterThan(24);
    const blocked = placeBoxes(['a', 'b', 'c'], { a: { x: 24, y: 24 }, c: { x: 368, y: 24 } }, 2000);
    expect(blocked.b!.y).toBeGreaterThan(24);
  });

  it('draws a line between two boxes and keeps only boxes there are, on the grid', () => {
    const { path, mid } = link({ x: 0, y: 0 }, { x: 400, y: 100 });
    expect(path.startsWith(`M ${BOX_W} 22 C`)).toBe(true);
    expect(path.endsWith('400 122')).toBe(true);
    expect(mid).toEqual({ x: (BOX_W + 400) / 2, y: 72 });
    // To the next row: down beside the first box, back along the gap, into the second.
    const back = link({ x: 600, y: 24 }, { x: 24, y: 364 });
    expect(back.path).toContain(`L 24 ${364 - 28}`);
    expect(back.mid).toEqual({ x: (600 + BOX_W + 24) / 2, y: 364 - 28 });
    expect(back.path).not.toMatch(/-\d/);
    expect(keepLayout({ a: { x: 13, y: -7 }, gone: { x: 0, y: 0 } }, ['a', 'b'])).toEqual({
      a: { x: 16, y: 0 },
    });
    expect(canvasSize([{ x: 100, y: 50 }]).width).toBeGreaterThan(100 + BOX_W);
  });

  it('finds a box’s part of a run by the step’s id, not its place', () => {
    const part = { output: null, reason: null, startedAt: null, finishedAt: null };
    const run: RoutineRun = {
      id: 'r',
      routineId: 'x',
      occurrence: 'o',
      status: 'error',
      reason: 'Stopped at the wait',
      threadId: null,
      startedAt: '2026-11-22T09:00:00.000Z',
      finishedAt: null,
      gate: null,
      steps: [
        { ...part, position: 0, kind: 'prompt', status: 'done', output: 'Found it' },
        { ...part, position: 1, kind: 'agent', stepId: 'a', status: 'done' },
        { ...part, position: 2, kind: 'wait', stepId: 'w', status: 'error', reason: 'No value' },
      ],
    };
    expect(runPart(run, null)?.output).toBe('Found it');
    expect(runPart(run, 'w')?.reason).toBe('No value');
    // The wait step taken out and another of its kind put in its place: the new one has not run.
    expect(runPart(run, 'w2')).toBeUndefined();
    // A routine without steps: the instruction's box shows the run.
    const plain = { ...run, steps: undefined };
    expect(runPart(plain, null)).toMatchObject({ status: 'error', reason: 'Stopped at the wait' });
    expect(runPart(plain, 'a')).toBeUndefined();
    expect(runPart(null, null)).toBeUndefined();
  });
});

describe('routine flow places', () => {
  it('keeps a box where the server takes its place, however far it is dragged', () => {
    expect(snap(-30)).toBe(0);
    expect(snap(FLOW_LAYOUT_MAX + 5000)).toBe(FLOW_LAYOUT_MAX);
    const kept = keepLayout({ a: { x: 99_999, y: 25_000 } }, ['a']);
    expect(FlowLayout.safeParse(kept).success).toBe(true);
  });
});

describe('routine flow ways', () => {
  const parts = (statuses: Record<string, RunPart['status']>) => (id: string) =>
    statuses[id] ? { status: statuses[id], output: null, reason: null } : undefined;

  it('follows the run along the ways it took, not along every line after a finished box', () => {
    const steps = [
      {
        id: 'a',
        kind: 'agent',
        when: { otherwise: 'goto', goto: 'c' },
        next: 'end',
      },
      { id: 'b', kind: 'agent' },
      { id: 'c', kind: 'notify' },
    ];
    // The condition did not hold: the run went from the instruction past a and b to c.
    const no = takenWays(steps, parts({ prompt: 'done', a: 'skipped', b: 'skipped', c: 'done' }));
    expect([...no]).toEqual(['prompt>a', 'a>c']);
    // It held: a ran and the run ended there, so no line leaves a.
    const yes = takenWays(steps, parts({ prompt: 'done', a: 'done' }));
    expect([...yes]).toEqual(['prompt>a']);
  });

  it('follows a failed step to its way on failure only when the run went on there', () => {
    const steps = [
      { id: 'a', kind: 'agent', onError: 'c' },
      { id: 'b', kind: 'agent' },
      { id: 'c', kind: 'notify' },
    ];
    expect([...takenWays(steps, parts({ prompt: 'done', a: 'error', b: 'skipped', c: 'running' }))]).toEqual([
      'prompt>a',
      'a>c',
    ]);
    expect([...takenWays(steps, parts({ prompt: 'done', a: 'error' }))]).toEqual(['prompt>a']);
    expect([...takenWays([{ id: 'a', kind: 'agent' }], parts({}))]).toEqual([]);
  });

  it('draws a jump on one row above the boxes it passes, and between rows as a line', () => {
    const a = { x: 24, y: 24 };
    const c = { x: 24 + 2 * (BOX_W + 56), y: 24 };
    const over = jumpLink(a, c, 0);
    expect(over.path.startsWith(`M ${a.x + BOX_W - 40} ${a.y} L ${a.x + BOX_W - 40} 14`)).toBe(true);
    expect(over.mid.y).toBe(14);
    // A second jump runs on a lane of its own, never off the canvas's top.
    expect(jumpLink(a, c, 1).mid.y).toBe(6);
    expect(jumpLink(a, c, 5).mid.y).toBe(4);
    const below = { x: 24, y: 24 + 340 };
    expect(jumpLink(a, below, 0)).toEqual(link(a, below));
  });
});
