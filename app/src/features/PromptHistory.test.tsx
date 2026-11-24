import type { RoutineRevision, RoutineVersionReport } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { PromptHistory } from './PromptHistory';

vi.mock('@/lib/api', () => ({ api: { routineRevisions: vi.fn(), routineVersions: vi.fn() } }));

const step = { id: 'a', kind: 'approval' as const, question: 'Send?', timeoutDays: 7 };
const revisions: RoutineRevision[] = [
  {
    id: 'v3',
    prompt: 'Write it',
    full: true,
    steps: [step],
    model: '',
    condition: null,
    createdAt: '2026-11-20T10:00:00Z',
  },
  {
    id: 'v2',
    prompt: 'Write it',
    full: true,
    steps: [],
    model: '',
    condition: null,
    createdAt: '2026-11-10T10:00:00Z',
  },
  { id: 'v1', prompt: 'Write it', full: false, createdAt: '2026-11-01T10:00:00Z' },
];
const report: RoutineVersionReport = {
  versions: {
    v3: { total: 2, ok: 1, quiet: 0, failed: 1, skipped: 0, costUsd: 0.02, unpricedRuns: 0, avgMs: 1000 },
    v2: { total: 6, ok: 6, quiet: 0, failed: 0, skipped: 0, costUsd: 0.06, unpricedRuns: 0, avgMs: 2000 },
  },
  untracked: { total: 4, ok: 4, quiet: 0, failed: 0, skipped: 0, costUsd: 0, unpricedRuns: 0, avgMs: null },
};

afterEach(cleanup);

async function open(onRestore = vi.fn()) {
  vi.mocked(api.routineRevisions).mockResolvedValue(revisions);
  vi.mocked(api.routineVersions).mockResolvedValue(report);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <PromptHistory routineId="r1" current="Write it" onRestore={onRestore} />
    </QueryClientProvider>,
  );
  fireEvent.click(screen.getByRole('button', { name: /Versions/ }));
  await screen.findByText(/Changed: steps/);
  return onRestore;
}

describe('routine versions', () => {
  it('says what changed in each version and how its runs went, with few runs marked', async () => {
    await open();
    expect(screen.getByText(/Changed: steps.*Runs: 2.*few runs to go by/)).toBeTruthy();
    expect(screen.getByText(/Steps, model and condition kept from here on.*Runs: 6/)).toBeTruthy();
    expect(screen.getByText(/Runs from before versions were kept/)).toBeTruthy();
  });

  it('brings back the whole version, even with the same instruction', async () => {
    const onRestore = await open();
    fireEvent.click(screen.getByText(/Steps, model and condition kept from here on/));
    fireEvent.click(screen.getByRole('button', { name: /Put this version in the form/ }));
    expect(onRestore).toHaveBeenCalledWith(revisions[1]);
  });

  it('offers nothing to bring back from a version that kept only the same instruction', async () => {
    await open();
    fireEvent.click(screen.getByText('No runs'));
    expect(screen.getByText(/Only the instruction was kept for this version/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Put this version in the form/ })).toBeNull();
  });
});
