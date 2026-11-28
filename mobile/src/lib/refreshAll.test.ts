import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { refreshAll } from './refreshAll';

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** A query watched by a screen whose reads take 20 ms and answer `r1`, `r2`, ... */
function watched(qc: QueryClient, key: string[]) {
  let calls = 0;
  const shown: unknown[] = [];
  const obs = new QueryObserver(qc, {
    queryKey: key,
    queryFn: async () => {
      const n = ++calls;
      await tick(20);
      return `r${n}`;
    },
  });
  const off = obs.subscribe((r) => shown.push(r.data));
  return { calls: () => calls, shown, off };
}

describe('refreshAll', () => {
  it('shows the answer already on its way, then reads once more', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['k'], 'kept', { updatedAt: 1 });
    const q = watched(qc, ['k']);
    await tick(5);
    await refreshAll(qc);
    q.off();
    expect(q.calls()).toBe(2);
    // The first answer was not thrown away.
    expect(q.shown).toContain('r1');
    expect(qc.getQueryData(['k'])).toBe('r2');
  });

  it('reads again what had settled', async () => {
    const qc = new QueryClient();
    const q = watched(qc, ['k']);
    await tick(30);
    await refreshAll(qc);
    q.off();
    expect(q.calls()).toBe(2);
    expect(qc.getQueryData(['k'])).toBe('r2');
  });

  it('leaves a first read on its way as it is', async () => {
    const qc = new QueryClient();
    const q = watched(qc, ['k']);
    await tick(5);
    await refreshAll(qc);
    await tick(30);
    q.off();
    expect(q.calls()).toBe(1);
  });

  it('only marks what no screen shows', async () => {
    const qc = new QueryClient();
    qc.setQueryData(['hidden'], 'x');
    await refreshAll(qc);
    expect(qc.getQueryState(['hidden'])!.isInvalidated).toBe(true);
  });
});
