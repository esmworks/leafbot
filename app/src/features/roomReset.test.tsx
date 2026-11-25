import type { Bot, Message, Room } from '@leafbot/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { RoomView } from './Rooms';

// Parts of the room read the screen's width when they load.
vi.hoisted(() => {
  window.matchMedia ??= ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  })) as unknown as typeof window.matchMedia;
});

// Every call the room makes on its own (meetings, files, cards) answers with nothing.
vi.mock('@/lib/api', () => ({
  api: new Proxy({}, { get: () => vi.fn(() => Promise.resolve([])) }),
}));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('@/components/BotAvatar', () => ({ BotAvatar: () => null }));
// The room keeps its end in view as it grows; the test's page has no layout to watch.
vi.stubGlobal(
  'ResizeObserver',
  class {
    observe() {}
    disconnect() {}
  },
);

const room: Room = {
  id: 'r1',
  title: 'Yönetim',
  goal: '',
  members: ['b1'],
  responders: 'everyone',
  rounds: 0,
  minutes: 'never',
  meeting: null,
  state: 'idle',
  speakerId: null,
  preview: null,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
};

const line = (id: string, role: Message['role'], text: string, props: Message['props'] = {}): Message => ({
  id,
  threadId: 'r1',
  role,
  author: role === 'system' ? 'system' : 'user',
  text,
  props,
  clientId: null,
  turnId: null,
  createdAt: `2026-11-20T10:00:0${id.slice(1)}.000Z`,
});

function show(messages: Message[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
  qc.setQueryData(['bots'], [{ id: 'b1', name: 'Paşa', description: '', color: '', avatar: '' } as Bot]);
  qc.setQueryData(['rooms'], [room]);
  qc.setQueryData(['messages', 'r1'], messages);
  render(
    <QueryClientProvider client={qc}>
      <TooltipProvider>
        <RoomView room={room} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

afterEach(cleanup);

describe('a room started fresh', () => {
  it('opens with only what came after its last reset, and shows the rest when asked', () => {
    show([
      line('m1', 'user', 'Eski konu: bütçe'),
      line('m2', 'system', 'Oda baştan başladı', { kind: 'contextReset' }),
      line('m3', 'user', 'Yeni konu: tatil'),
    ]);
    expect(screen.queryByText('Eski konu: bütçe')).toBeNull();
    expect(screen.queryByText('Oda baştan başladı')).toBeNull();
    expect(screen.getByText('Yeni konu: tatil')).toBeTruthy();

    fireEvent.click(
      screen.getByRole('button', { name: /Show the earlier conversation|Önceki konuşmayı göster/ }),
    );
    expect(screen.getByText('Eski konu: bütçe')).toBeTruthy();
    expect(screen.getByText('Oda baştan başladı')).toBeTruthy();
  });

  it('opens empty right after the reset, with the way back to the earlier talk', () => {
    show([
      line('m1', 'user', 'Eski konu: bütçe'),
      line('m2', 'system', 'Oda baştan başladı', { kind: 'contextReset' }),
    ]);
    expect(screen.queryByText('Eski konu: bütçe')).toBeNull();
    expect(screen.getByText('Yönetim', { selector: 'div' })).toBeTruthy();
    expect(
      screen.getByRole('button', { name: /Show the earlier conversation|Önceki konuşmayı göster/ }),
    ).toBeTruthy();
  });

  it('shows a room never reset as it is, with no button', () => {
    show([line('m1', 'user', 'Eski konu: bütçe')]);
    expect(screen.getByText('Eski konu: bütçe')).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Show the earlier conversation|Önceki konuşmayı göster/ }),
    ).toBeNull();
  });
});
