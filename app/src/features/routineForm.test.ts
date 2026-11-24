import type { Routine } from '@leafbot/shared';
import { describe, expect, it, vi } from 'vitest';
import { Form, fromRoutine } from './RoutinePage';

vi.mock('@/lib/api', () => ({ api: {} }));

/** A routine as the server sends it, with only what the window's steps read. */
const routine = (steps: Routine['steps']): Routine =>
  ({
    id: 'r',
    botId: 'b',
    name: 'Prices',
    prompt: 'Look at the prices',
    steps,
    schedule: { type: 'daily', time: '09:00' },
    timezone: 'Europe/Istanbul',
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    createdAt: '2026-11-24T09:00:00.000Z',
    missed: 'run',
    carryReport: false,
    inMain: true,
  }) as Routine;

describe('the routine window keeps the ways a bot set', () => {
  it('reads every way into the form and keeps it through the form’s check, so saving sends it back', () => {
    const r = routine([
      {
        id: 'look',
        kind: 'agent',
        prompt: 'Compare the prices',
        model: '',
        onError: 'failed',
        when: { contains: 'changed', filter: '', absent: false, otherwise: 'goto', goto: 'quiet' },
      },
      { id: 'tell', kind: 'approval', question: 'Send it?', timeoutDays: 7, next: 'end' },
      { id: 'quiet', kind: 'notify', text: 'Nothing changed', withBefore: false, next: 'end' },
      { id: 'failed', kind: 'wait', on: 'time', minutes: 60, filter: '', timeoutDays: 7 },
    ]);
    const steps = fromRoutine(r).steps;
    const checked = Form.shape.steps.safeParse(steps);
    expect(checked.success).toBe(true);
    expect(checked.data![0]).toMatchObject({
      onError: 'failed',
      when: { otherwise: 'goto', goto: 'quiet' },
    });
    expect(checked.data![1]).toMatchObject({ next: 'end' });
    expect(checked.data![2]).toMatchObject({ next: 'end' });
  });

  it('shows a way to a step that is no longer after its own on that step', () => {
    const r = routine([
      { id: 'a', kind: 'agent', prompt: 'One', model: '' },
      { id: 'b', kind: 'agent', prompt: 'Two', model: '', next: 'a' },
    ]);
    const checked = Form.shape.steps.safeParse(fromRoutine(r).steps);
    expect(checked.success).toBe(false);
    expect(checked.error!.issues[0]).toMatchObject({ path: [1, 'next'], message: 'routine.stepWayInvalid' });
  });

  it('keeps fetch and extract steps with their failure ways, and points at a field that does not pass', () => {
    const r = routine([
      { id: 'read', kind: 'fetch', url: 'https://api.example.com/items/{{code}}', onError: 'failed' },
      { id: 'take', kind: 'extract', fields: 'price=item.price', onError: 'failed' },
      { id: 'failed', kind: 'notify', text: 'Could not read', withBefore: true },
    ]);
    const checked = Form.shape.steps.safeParse(fromRoutine(r).steps);
    expect(checked.success).toBe(true);
    expect(checked.data![0]).toMatchObject({
      url: 'https://api.example.com/items/{{code}}',
      onError: 'failed',
    });
    expect(checked.data![1]).toMatchObject({ fields: 'price=item.price', onError: 'failed' });

    const bad = Form.shape.steps.safeParse([
      { id: 'a', kind: 'fetch', url: 'https://{{site}}/x' },
      { id: 'b', kind: 'extract', fields: 'price' },
    ]);
    expect(bad.success).toBe(false);
    expect(bad.error!.issues.map((i) => [i.path.join('.'), i.message])).toEqual([
      ['0.url', 'routine.fetchUrlInvalid'],
      ['1.fields', 'routine.extractFieldsInvalid'],
    ]);
  });
});
