import { describe, expect, it } from 'vitest';
import { healthFindings, healthFix, routineHealth, type HealthInput, type HealthRun } from './routine-health';
import type { RoutineStep } from './schedule';

const NOW = new Date('2026-11-24T12:00:00Z');
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function run(i: number, outcome: HealthRun['outcome'], costUsd: number | null = 0.01): HealthRun {
  const startedAt = new Date(day(1).getTime() - i * 3_600_000);
  return {
    id: `r${i}`,
    startedAt,
    finishedAt: new Date(startedAt.getTime() + 60_000),
    outcome,
    skipped: false,
    costUsd,
  };
}

function input(
  over: Omit<Partial<HealthInput>, 'routine'> & { routine?: Partial<HealthInput['routine']> } = {},
): HealthInput {
  return {
    failureStreak: 0,
    runs: [],
    steps: [],
    now: NOW,
    ...over,
    routine: {
      enabled: true,
      createdAt: day(60).toISOString(),
      lastRunAt: day(1).toISOString(),
      condition: null,
      watchUrl: null,
      check: null,
      signInWait: null,
      pausedReason: null,
      steps: [],
      ...over.routine,
    },
  };
}

const ids = (i: HealthInput) => healthFindings(i).map((f) => f.id);
const many = (n: number, outcome: HealthRun['outcome']) =>
  Array.from({ length: n }, (_, i) => run(i, outcome));

describe('routine health', () => {
  it('calls a routine with few known endings too early to say', () => {
    const h = routineHealth('x', input({ runs: [run(0, 'ok'), run(1, null)] }));
    expect(h.status).toBe('unknown');
    expect(h.runs).toEqual({ total: 2, ok: 1, quiet: 0, failed: 0, skipped: 0 });
  });

  it('is healthy with enough runs and nothing found', () => {
    expect(routineHealth('x', input({ runs: many(5, 'ok') })).status).toBe('good');
  });

  it('reads failures from a streak, or from at least half of the last runs', () => {
    expect(ids(input({ failureStreak: 3 }))).toContain('failing');
    expect(ids(input({ failureStreak: 2, runs: many(4, 'failed') }))).not.toContain('failing');
    const mixed = [...many(3, 'failed'), ...many(3, 'ok').map((r, i) => ({ ...r, id: `o${i}` }))];
    expect(healthFindings(input({ runs: mixed }))).toContainEqual({ id: 'failing', count: 3, of: 6 });
    const fewer = [...many(3, 'failed'), ...many(4, 'ok').map((r, i) => ({ ...r, id: `o${i}` }))];
    expect(ids(input({ runs: fewer }))).not.toContain('failing');
  });

  it('says a routine switched off by its failures, without also calling it failing', () => {
    const found = ids(input({ failureStreak: 10, routine: { pausedReason: 'failures', enabled: false } }));
    expect(found).toEqual(['pausedByFailures']);
  });

  it('finds a step that fails, and a wait that runs out, by position', () => {
    const steps: RoutineStep[] = [
      { id: 'a', kind: 'agent', prompt: 'x', model: '' },
      { id: 'b', kind: 'approval', question: 'ok?', timeoutDays: 7 },
    ];
    const stepRuns = ['r0', 'r1', 'r2'].flatMap((runId) => [
      { runId, position: 1, kind: 'agent', status: 'error' },
      { runId, position: 2, kind: 'approval', status: 'error' },
    ]);
    const found = healthFindings(input({ routine: { steps }, runs: many(3, 'failed'), steps: stepRuns }));
    expect(found).toContainEqual({ id: 'stepFails', step: 1, count: 3 });
    expect(found).toContainEqual({ id: 'waitTimeouts', step: 2, count: 3 });
  });

  it('leaves out a wait already at its longest, and a wait for a time', () => {
    const steps: RoutineStep[] = [
      { id: 'a', kind: 'wait', on: 'email', minutes: 60, filter: '', timeoutDays: 30 },
      { id: 'b', kind: 'wait', on: 'time', minutes: 60, filter: '', timeoutDays: 7 },
    ];
    const stepRuns = ['r0', 'r1'].flatMap((runId) => [
      { runId, position: 1, kind: 'wait', status: 'error' },
      { runId, position: 2, kind: 'wait', status: 'error' },
    ]);
    expect(ids(input({ routine: { steps }, steps: stepRuns }))).not.toContain('waitTimeouts');
  });

  it('counts a step’s endings only while the step is the one the runs had', () => {
    const steps: RoutineStep[] = [
      { id: 'a', kind: 'agent', prompt: 'x', model: '' },
      { id: 'b', kind: 'approval', question: 'ok?', timeoutDays: 14 },
    ];
    const ran = (stepId: string, timeoutDays?: number) =>
      ['r0', 'r1', 'r2'].flatMap((runId) => [
        { runId, position: 1, kind: 'agent', status: 'error', stepId: 'gone' },
        { runId, position: 2, kind: 'approval', status: 'error', stepId, timeoutDays },
      ]);
    // Waited 7 days then; 14 now: the limit was raised since, so those say nothing about it.
    expect(ids(input({ routine: { steps }, steps: ran('b', 7) }))).not.toContain('waitTimeouts');
    expect(ids(input({ routine: { steps }, steps: ran('b', 14) }))).toContain('waitTimeouts');
    // Another step stood at those places then.
    const moved = ids(input({ routine: { steps }, steps: ran('other', 14) }));
    expect(moved).not.toContain('waitTimeouts');
    // The first place held a step since removed: its errors are not the current step's.
    expect(ids(input({ routine: { steps }, steps: ran('b', 14) }))).not.toContain('stepFails');
  });

  it('counts slots passed over apart, and calls a routine with only those not in use', () => {
    const skipped = (i: number): HealthRun => ({ ...run(i, null), skipped: true });
    const h = routineHealth(
      'x',
      input({ runs: [skipped(0), skipped(1), run(2, 'ok')], routine: { lastRunAt: day(1).toISOString() } }),
    );
    expect(h.runs).toMatchObject({ total: 1, ok: 1, skipped: 2 });
    const onlySkips = input({ runs: [skipped(0)], routine: { lastRunAt: day(40).toISOString() } });
    expect(ids(onlySkips)).toContain('idle');
  });

  it('finds runs that mostly report nothing, with what they cost, only when nothing is looked at first', () => {
    const runs = [...many(8, 'quiet'), ...many(2, 'ok').map((r, i) => ({ ...r, id: `o${i}` }))];
    const found = healthFindings(input({ runs })).find((f) => f.id === 'mostlyQuiet');
    expect(found).toMatchObject({ count: 8, of: 10 });
    expect(found?.costUsd).toBeCloseTo(0.08);
    expect(ids(input({ runs, routine: { watchUrl: 'https://example.com' } }))).not.toContain('mostlyQuiet');
    expect(ids(input({ runs: many(9, 'quiet') }))).not.toContain('mostlyQuiet');
  });

  it('leaves the cost out when a run had a turn of unknown price', () => {
    const runs = [...many(9, 'quiet'), run(20, 'quiet', null)];
    expect(healthFindings(input({ runs })).find((f) => f.id === 'mostlyQuiet')?.costUsd).toBeUndefined();
    const h = routineHealth('x', input({ runs }));
    expect(h.unpricedRuns).toBe(1);
    expect(h.costUsd).toBeCloseTo(0.09);
  });

  it('calls a routine older than the window with no run in it not in use', () => {
    const idle = input({ routine: { lastRunAt: day(40).toISOString(), enabled: false } });
    expect(healthFindings(idle)).toContainEqual({ id: 'idle', count: 0, enabled: false });
    expect(routineHealth('x', idle).status).toBe('unused');
    expect(ids(input({ routine: { createdAt: day(10).toISOString(), lastRunAt: null } }))).not.toContain(
      'idle',
    );
  });

  it('ranks a problem over anything else', () => {
    const h = routineHealth('x', input({ runs: many(10, 'quiet'), routine: { signInWait: 'c1' } }));
    expect(h.status).toBe('problem');
    expect(h.findings.map((f) => f.id)).toEqual(['signInWait', 'mostlyQuiet']);
  });

  it('keeps a finding set aside hidden until the runs after it meet it again', () => {
    const runs = many(10, 'quiet');
    const at = new Date(day(1).getTime() + 3_600_000);
    const hidden = routineHealth('x', input({ runs }), new Map([['mostlyQuiet', at]]));
    expect(hidden.findings).toEqual([]);
    expect(hidden.hidden).toBe(1);
    const later = runs.map((r, i) => ({
      ...r,
      id: `n${i}`,
      startedAt: new Date(at.getTime() + (i + 1) * 60_000),
    }));
    const back = routineHealth('x', input({ runs: [...runs, ...later] }), new Map([['mostlyQuiet', at]]));
    expect(back.findings.map((f) => f.id)).toEqual(['mostlyQuiet']);
  });

  it('keeps a finding about the state hidden for its days, then shows it again', () => {
    const state = input({ routine: { signInWait: 'c1' }, runs: many(5, 'ok') });
    expect(routineHealth('x', state, new Map([['signInWait', day(5)]])).findings).toEqual([]);
    expect(routineHealth('x', state, new Map([['signInWait', day(31)]])).findings.map((f) => f.id)).toEqual([
      'signInWait',
    ]);
  });

  it('averages how long the runs with a known ending took', () => {
    expect(routineHealth('x', input({ runs: many(3, 'ok') })).avgMs).toBe(60_000);
    expect(routineHealth('x', input()).avgMs).toBeNull();
  });
});

describe('health fix', () => {
  const steps: RoutineStep[] = [
    { id: 'a', kind: 'agent', prompt: 'x', model: '' },
    { id: 'b', kind: 'approval', question: 'ok?', timeoutDays: 20 },
  ];

  it('doubles the wait of the step that runs out, up to the longest', () => {
    const fix = healthFix({ steps }, { id: 'waitTimeouts', step: 2 });
    expect(fix).toMatchObject({ step: 2, from: 20, to: 30 });
    expect(fix?.steps[1]).toMatchObject({ id: 'b', timeoutDays: 30 });
    expect(fix?.steps[0]).toBe(steps[0]);
  });

  it('has no change for other findings, or a step that is not there any more', () => {
    expect(healthFix({ steps }, { id: 'stepFails', step: 1 })).toBeNull();
    expect(healthFix({ steps }, { id: 'waitTimeouts', step: 1 })).toBeNull();
    expect(healthFix({ steps: [] }, { id: 'waitTimeouts', step: 2 })).toBeNull();
  });
});
