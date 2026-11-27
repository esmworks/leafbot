import { QueryClient } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (e: never) => void;
const handlers = new Map<string, Handler>();
const fake = {
  on: (name: string, h: Handler) => void handlers.set(name, h),
  removeAllListeners: () => handlers.clear(),
  close: vi.fn(),
  connect: vi.fn(),
};
vi.mock('socket.io-client', () => ({ io: () => fake, WebSocket: class {} }));
const catchUp = vi.fn();
vi.mock('./liveCatchUp', () => ({ catchUp, catchUpWatched: vi.fn() }));

const { connectRealtime } = await import('./realtime');
const { useUi } = await import('./store');
const emit = (name: string, e: unknown = {}) => handlers.get(name)?.(e as never);

describe('realtime deltas', () => {
  let stop: () => void;
  let frame: (() => void) | null;
  beforeEach(() => {
    vi.useFakeTimers();
    frame = null;
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frame = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      frame = null;
    });
    useUi.getState().resetLive();
    catchUp.mockReset();
    stop = connectRealtime(new QueryClient(), { notices: false });
  });
  afterEach(() => {
    stop();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const delta = (text: string, extra: object = {}) =>
    emit('delta', { threadId: 't1', turnId: 'a', text, ...extra });

  it('applies the deltas of one frame with one store update and the same final text', () => {
    let updates = 0;
    const unsub = useUi.subscribe((s, p) => {
      if (s.streams !== p.streams) updates++;
    });
    for (const w of ['Mer', 'ha', 'ba']) delta(w);
    expect(useUi.getState().streams.t1).toBeUndefined();
    frame?.();
    unsub();
    expect(updates).toBe(1);
    expect(useUi.getState().streams.t1).toEqual({ turnId: 'a', text: 'Merhaba' });
    expect(useUi.getState().writing.t1).toBe(true);
  });

  it('shows a turn its own words before its end is handled', () => {
    delta('son söz');
    const seen: (string | undefined)[] = [];
    const unsub = useUi.subscribe((s, p) => {
      if (s.states !== p.states) seen.push(s.streams.t1?.text);
    });
    emit('turn', { threadId: 't1', botId: 'b', state: 'idle', turnId: 'a' });
    unsub();
    expect(seen).toEqual(['son söz']);
  });

  it('fetches the text so far when a piece comes after a gap', () => {
    delta('geç geldi', { at: 40 });
    frame?.();
    expect(catchUp).toHaveBeenCalledWith('t1');
  });

  it('serves a hidden tab, which gets no frames, by a short timer', () => {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    delta('arka plan');
    vi.advanceTimersByTime(60);
    expect(useUi.getState().streams.t1?.text).toBe('arka plan');
  });

  it('applies the words even when the window is hidden after the frame was asked for', () => {
    delta('gizlendi');
    // The frame never comes (the window went to the background): the fallback timer applies them.
    vi.advanceTimersByTime(120);
    expect(frame).toBeNull();
    expect(useUi.getState().streams.t1?.text).toBe('gizlendi');
  });

  it('tells a connection that dropped from one still trying for the first time', () => {
    emit('disconnect', 'transport close');
    expect(useUi.getState().connection.kind).toBe('connecting');
    emit('connect');
    expect(useUi.getState().connection.kind).toBe('live');
    emit('disconnect', 'io server disconnect');
    expect(useUi.getState().connection.kind).toBe('reconnecting');
    expect(fake.connect).toHaveBeenCalled();
  });
});
