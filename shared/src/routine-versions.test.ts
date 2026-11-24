import { describe, expect, it } from 'vitest';
import { versionChanges } from './routine-versions';
import type { RoutineStep } from './schedule';

const step: RoutineStep = { id: 'a', kind: 'approval', question: 'ok?', timeoutDays: 7 };
const base = { prompt: 'x', steps: [step], model: '', condition: null, full: true };

describe('routine versions', () => {
  it('names each part that changed', () => {
    expect(versionChanges(base, base)).toEqual([]);
    expect(versionChanges({ ...base, prompt: 'y', model: 'm' }, base)).toEqual(['prompt', 'model']);
    expect(versionChanges({ ...base, steps: [] }, base)).toEqual(['steps']);
  });

  it('reads the same value written in another key order, or with a part left out, as unchanged', () => {
    const reordered = { timeoutDays: 7, question: 'ok?', kind: 'approval', id: 'a', next: undefined };
    expect(versionChanges({ ...base, steps: [reordered as RoutineStep] }, base)).toEqual([]);
    expect(versionChanges({ prompt: 'x' }, { prompt: 'x', steps: [], model: '', condition: null })).toEqual(
      [],
    );
  });

  it('compares only the instruction with a version kept before the other parts were', () => {
    expect(versionChanges({ ...base, steps: [] }, { prompt: 'x', full: false })).toEqual([]);
    expect(versionChanges(base, { prompt: 'z', full: false })).toEqual(['prompt']);
  });
});
