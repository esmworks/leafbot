import type { UnusedReport } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from '@/lib/api';
import { UnusedCard } from './UnusedCard';

// The settings page this card borrows its rows from reads the screen's width when it loads.
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});

vi.mock('@/lib/api', () => ({
  api: {
    unused: vi.fn(),
    removeSkill: vi.fn(),
    removeConnection: vi.fn(),
    archiveBot: vi.fn(),
    restoreBot: vi.fn(),
  },
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const report: UnusedReport = {
  skills: [{ id: 's1', name: 'old-skill', uses: 0, lastUsedAt: null }],
  connections: [{ id: 'c1', name: 'Drive', reason: 'signedOut' }],
  bots: [{ id: 'b1', name: 'Helper', lastTurnAt: null }],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

async function show(data = report) {
  vi.mocked(api.unused).mockResolvedValue(data);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <UnusedCard />
    </QueryClientProvider>,
  );
  await screen.findByText(/Skill · old-skill/);
}

describe('unused card', () => {
  it('lists each kind with why, and says when nothing sits unused', async () => {
    await show();
    expect(screen.getByText('No bot has read it')).toBeTruthy();
    expect(screen.getByText(/Signed out; no bot can use it/)).toBeTruthy();
    expect(screen.getByText('Never had a turn')).toBeTruthy();
    cleanup();
    vi.mocked(api.unused).mockResolvedValue({ skills: [], connections: [], bots: [] });
    const qc = new QueryClient();
    render(
      <QueryClientProvider client={qc}>
        <UnusedCard />
      </QueryClientProvider>,
    );
    expect(await screen.findByText('Nothing sits unused.')).toBeTruthy();
  });

  it('removes a skill only when the person says yes, as it cannot be undone', async () => {
    await show();
    const ask = vi.spyOn(window, 'confirm').mockReturnValue(false);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(ask).toHaveBeenCalled());
    expect(api.removeSkill).not.toHaveBeenCalled();
    ask.mockReturnValue(true);
    fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await waitFor(() => expect(api.removeSkill).toHaveBeenCalledWith('s1'));
  });

  it('archives a bot with a way to take it back', async () => {
    await show();
    vi.mocked(api.archiveBot).mockResolvedValue({} as never);
    vi.mocked(api.restoreBot).mockResolvedValue({} as never);
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    const [, opts] = vi.mocked(toast.success).mock.calls[0]!;
    (opts as unknown as { action: { onClick(): void } }).action.onClick();
    expect(api.restoreBot).toHaveBeenCalledWith('b1');
  });
});
