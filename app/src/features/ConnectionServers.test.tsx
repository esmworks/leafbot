import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useServerHost, type ServerChoice } from '@/lib/serverSwitch';
import { useUi } from '@/lib/store';
import { AccountConnection, useConnectionTitle } from './ConnectionServers';

// The server's own cards come from that server; here only where they sit matters.
vi.mock('@/lib/queries', () => ({
  useInfo: () => ({ data: { version: '0.10.2' } }),
  useManagesServer: () => true,
}));
vi.mock('./SettingsPage', () => ({
  Card: ({ title, children }: { title: string; children: ReactNode }) => (
    <section aria-label={title}>{children}</section>
  ),
  Row: ({ label, hint, children }: { label: string; hint?: string; children?: ReactNode }) => (
    <div>
      {label} {hint} {children}
    </div>
  ),
  ServerEnvironment: () => <p>environment card</p>,
}));
vi.mock('./ConnectPhone', () => ({ ConnectPhone: () => <p>another device card</p> }));
vi.mock('./TailscaleSettings', () => ({ TailscaleCard: () => <p>tailscale card</p> }));
vi.mock('./PhoneSettings', () => ({ ApnsCard: () => <p>notifications card</p> }));

const HOUR = 3600_000;

function host(servers: ServerChoice[]) {
  const choose = vi.fn();
  const add = vi.fn();
  useServerHost.setState({ host: { servers, choose, add } });
  return { choose, add };
}

const three: ServerChoice[] = [
  { id: 's1', name: 'Office Mac mini', role: 'owner', current: true, seenAt: Date.now() },
  { id: 's2', name: 'Home server', role: 'admin', current: false, seenAt: Date.now() - HOUR },
  { id: 's3', name: 'VPS', role: 'member', current: false, seenAt: 0 },
];

afterEach(() => {
  cleanup();
  useServerHost.setState({ host: null });
  useUi.setState({ settingsView: null });
});

describe('connection settings through the account', () => {
  it('lists every server of the account, the open one marked, with the account-wide cards under them', () => {
    host(three);
    render(<AccountConnection />);
    expect(screen.getByText('Office Mac mini')).toBeTruthy();
    expect(screen.getByText('Home server')).toBeTruthy();
    expect(screen.getByText('VPS')).toBeTruthy();
    expect(screen.getByText('Shown in this window')).toBeTruthy();
    expect(screen.getByText('Version 0.10.2')).toBeTruthy();
    expect(screen.getByText(/^Last seen /)).toBeTruthy();
    // A server the account never saw says nothing about when.
    expect(screen.getAllByText(/^Last seen /)).toHaveLength(1);
    expect(screen.getByText('another device card')).toBeTruthy();
    // A server's own settings wait for its page.
    expect(screen.queryByText('environment card')).toBeNull();
  });

  it('opens the open server to its page, and moves the window to another one', () => {
    const { choose } = host(three);
    render(<AccountConnection />);
    fireEvent.click(screen.getByText('Home server'));
    expect(choose).toHaveBeenCalledWith('s2');
    expect(useUi.getState().settingsView).toBe('s2');
    useUi.setState({ settingsView: null });
    fireEvent.click(screen.getByText('Office Mac mini'));
    expect(choose).not.toHaveBeenCalledWith('s1');
    expect(useUi.getState().settingsView).toBe('s1');
    expect(screen.getByText('environment card')).toBeTruthy();
    expect(screen.getByText('tailscale card')).toBeTruthy();
    expect(screen.queryByText('Home server')).toBeNull();
  });

  it('shows a page asked for a server no longer open as the list', () => {
    host(three);
    useUi.setState({ settingsView: 's2' });
    render(<AccountConnection />);
    expect(screen.getByText('Home server')).toBeTruthy();
    expect(screen.queryByText('environment card')).toBeNull();
  });

  it('shows the only server’s page at once, with a way to add another', () => {
    const { add } = host([three[0]!]);
    render(<AccountConnection />);
    expect(screen.getByText('environment card')).toBeTruthy();
    expect(screen.getByText('another device card')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Add a server/ }));
    expect(add).toHaveBeenCalled();
  });

  it('names the open server in the title only while its page shows among several', () => {
    host(three);
    expect(renderHook(() => useConnectionTitle('s1')).result.current).toBe('Office Mac mini');
    expect(renderHook(() => useConnectionTitle('s2')).result.current).toBeNull();
    expect(renderHook(() => useConnectionTitle(null)).result.current).toBeNull();
    host([three[0]!]);
    expect(renderHook(() => useConnectionTitle('s1')).result.current).toBeNull();
  });
});
