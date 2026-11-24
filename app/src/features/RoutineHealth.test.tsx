import type { Routine, RoutineHealth } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { toast } from 'sonner';
import { duration, needsAttention, RoutineHealthBlock } from './RoutineHealth';

vi.mock('@/lib/api', () => ({
  api: { routineHealth: vi.fn(), updateRoutine: vi.fn(), dismissRoutineHealth: vi.fn(), mainThread: vi.fn() },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
const routineHealth = vi.mocked(api.routineHealth);
const updateRoutine = vi.mocked(api.updateRoutine);
const success = vi.mocked(toast.success);

const t = ((key: string, p?: Record<string, unknown>) => `${key} ${JSON.stringify(p)}`) as Parameters<
  typeof duration
>[1];

const steps: NonNullable<Routine['steps']> = [
  { id: 'a', kind: 'agent', prompt: 'Teklifi yaz', model: '' },
  { id: 'b', kind: 'approval', question: 'Göndereyim mi?', timeoutDays: 7 },
];
const routine = { id: 'r1', botId: 'b1', name: 'Teklif', steps } as Routine;
const health: RoutineHealth = {
  routineId: 'r1',
  status: 'improvable',
  since: new Date().toISOString(),
  runs: { total: 6, ok: 4, quiet: 0, failed: 0, skipped: 0 },
  costUsd: 0.2,
  unpricedRuns: 0,
  avgMs: 1000,
  findings: [{ id: 'waitTimeouts', step: 2, count: 2 }],
  hidden: 0,
};

function show(locked = false) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <RoutineHealthBlock routine={routine} locked={locked} />
    </QueryClientProvider>,
  );
}

describe('routine health on screen', () => {
  beforeEach(() => {
    routineHealth.mockResolvedValue([health]);
    updateRoutine.mockResolvedValue(routine);
    vi.stubGlobal('confirm', () => true);
  });
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('says how long in the largest units that read well', () => {
    expect(duration(42_000, t)).toBe('health.seconds {"seconds":42}');
    expect(duration(130_000, t)).toBe('health.minutes {"minutes":2,"seconds":10}');
    expect(duration(2 * 3_600_000 + 5 * 60_000, t)).toBe('health.hours {"hours":2,"minutes":5}');
    expect(duration(3 * 86_400_000, t)).toBe('health.days {"days":3}');
  });

  it('wants a look for a problem, something to gain or a routine not used, not for the rest', () => {
    expect(['problem', 'improvable', 'unused'].every((status) => needsAttention({ status } as never))).toBe(
      true,
    );
    expect(needsAttention({ status: 'good' })).toBe(false);
    expect(needsAttention({ status: 'unknown' })).toBe(false);
    expect(needsAttention(undefined)).toBe(false);
  });

  it('applies a wait that runs out as twice as long, and undoes it', async () => {
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledTimes(1));
    const [id, patch] = updateRoutine.mock.calls[0]!;
    expect(id).toBe('r1');
    expect((patch as { steps: typeof steps }).steps[1]).toMatchObject({ id: 'b', timeoutDays: 14 });
    await waitFor(() => expect(success).toHaveBeenCalled());
    const undo = (success.mock.calls[0]![1] as unknown as { action: { onClick(): void } }).action;
    undo.onClick();
    await waitFor(() => expect(updateRoutine).toHaveBeenCalledTimes(2));
    expect(updateRoutine.mock.calls[1]).toEqual(['r1', { steps }]);
  });

  it('changes nothing when the person says no', async () => {
    vi.stubGlobal('confirm', () => false);
    show();
    fireEvent.click(await screen.findByRole('button', { name: 'Apply' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(updateRoutine).not.toHaveBeenCalled();
  });

  it('does not apply while the page has changes not saved', async () => {
    show(true);
    expect(await screen.findByRole('button', { name: 'Apply' })).toHaveProperty('disabled', true);
  });
});
