import { routesPastApproval, stepRoutesProblem, type RoutineStep } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { routeFrom } from '../src/services/routine-steps';

const agent = (id: string, more: Partial<Extract<RoutineStep, { kind: 'agent' }>> = {}): RoutineStep => ({
  id,
  kind: 'agent',
  prompt: id,
  model: '',
  ...more,
});
const approval = (
  id: string,
  more: Partial<Extract<RoutineStep, { kind: 'approval' }>> = {},
): RoutineStep => ({
  id,
  kind: 'approval',
  question: id,
  timeoutDays: 7,
  ...more,
});

describe('where a run goes after a step', () => {
  const steps = [agent('a'), agent('b'), agent('c')];

  it('takes the step after it by default, and ends after the last', () => {
    expect(routeFrom(steps, 0)).toEqual({ to: 1 });
    expect(routeFrom(steps, 2, '')).toEqual({ to: 3 });
    expect(routeFrom(steps, 3)).toEqual({ end: true });
  });

  it('ends where its way says, or goes on at the later step it names', () => {
    expect(routeFrom(steps, 1, 'end')).toEqual({ end: true });
    expect(routeFrom(steps, 1, 'c')).toEqual({ to: 3 });
  });

  it('goes back to an earlier step, and finds no way to itself or to one it does not have', () => {
    expect(routeFrom(steps, 2, 'a')).toEqual({ to: 1 });
    expect(routeFrom(steps, 2, 'b')).toEqual({ lost: 'b' });
    expect(routeFrom(steps, 1, 'yok')).toEqual({ lost: 'yok' });
  });
});

describe('the ways a routine is saved with', () => {
  it('takes ways that go forward or back, and ending after a step', () => {
    expect(stepRoutesProblem([agent('a'), agent('b', { next: 'a' })])).toBeNull();
    expect(stepRoutesProblem([approval('a', { onReject: 'b' }), agent('b')])).toBeNull();
    expect(
      stepRoutesProblem([
        agent('a', { when: { contains: 'x', filter: '', absent: false, otherwise: 'goto', goto: 'c' } }),
        agent('b', { next: 'end', onError: 'c' }),
        agent('c'),
      ]),
    ).toBeNull();
  });

  it('turns away a way to its own step, one to nowhere, and a step named end', () => {
    expect(stepRoutesProblem([agent('a', { next: 'a' }), agent('b')])).toBe('validation.stepRoute');
    expect(stepRoutesProblem([approval('a', { onReject: 'a' })])).toBe('validation.stepRoute');
    expect(stepRoutesProblem([agent('a', { onError: 'end' })])).toBe('validation.stepRoute');
    expect(stepRoutesProblem([approval('a', { onReject: 'end' }), agent('b')])).toBe('validation.stepRoute');
    expect(
      stepRoutesProblem([
        agent('a', { when: { contains: '', filter: '', absent: false, otherwise: 'goto', goto: '' } }),
      ]),
    ).toBe('validation.stepRoute');
    expect(stepRoutesProblem([agent('end')])).toBe('validation.stepIdEnd');
  });

  it('names the ways that pass an approval step over', () => {
    expect(routesPastApproval([agent('a', { next: 'c' }), approval('b'), agent('c')])).toEqual(['a>next>c']);
    expect(routesPastApproval([agent('a', { onError: 'c' }), approval('b'), agent('c')])).toEqual([
      'a>onError>c',
    ]);
    // Ending the run lets nothing past the approval; a way that stops before it does not pass it.
    expect(routesPastApproval([agent('a', { next: 'end' }), approval('b'), agent('c')])).toEqual([]);
    expect(routesPastApproval([agent('a', { next: 'b' }), agent('x'), approval('b')])).toEqual([]);
    // A way back does not pass one over: the run meets it again on its way forward.
    expect(routesPastApproval([agent('a'), approval('b'), agent('c', { next: 'a' })])).toEqual([]);
    // A "no" may lead where the "yes" does, so each way for it is the person's to allow.
    expect(routesPastApproval([agent('a'), approval('b', { onReject: 'c' }), agent('c')])).toEqual([
      'b>onReject>c',
    ]);
  });
});
