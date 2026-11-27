import type { Message } from '@leafbot/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const send = vi.fn();
vi.mock('./api', async (orig) => ({ ...(await orig<object>()), api: { send } }));
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: toastError } }));

const { ApiError, NoAnswerError } = await import('./api');
const { flushOutbox, holdsFor, isOffline, useOutbox } = await import('./outbox');

const held = (clientId: string) => ({
  threadId: 't1',
  clientId,
  text: `metin ${clientId}`,
  files: [],
  message: { id: clientId, clientId, props: { heldOffline: true } } as unknown as Message,
});

describe('outbox', () => {
  beforeEach(() => {
    send.mockReset();
    toastError.mockReset();
    useOutbox.setState({ items: [] });
  });

  it('tells a refused send from one that never reached the server', () => {
    expect(isOffline(new NoAnswerError('Failed to fetch'))).toBe(true);
    // A mistake made before anything was sent would only repeat: it is not held.
    expect(isOffline(new TypeError('Converting circular structure to JSON'))).toBe(false);
    expect(isOffline(new SyntaxError('Unexpected token'))).toBe(false);
    expect(isOffline(new ApiError(400, 'no'))).toBe(false);
    // A proxy's error page while the server restarts is no answer; the server's own 502 is one.
    expect(isOffline(new ApiError(502, 'Request failed (502)', false))).toBe(true);
    expect(isOffline(new ApiError(503, 'Request failed (503)', false))).toBe(true);
    expect(isOffline(new ApiError(502, 'Telegram unreachable'))).toBe(false);
  });

  it('tells whether a conversation has messages waiting, so a new one goes behind them', () => {
    expect(holdsFor('t1')).toBe(false);
    useOutbox.getState().hold(held('a'));
    expect(holdsFor('t1')).toBe(true);
    expect(holdsFor('t2')).toBe(false);
  });

  it('sends what was held in order, marked as written offline, with the same client id', async () => {
    useOutbox.getState().hold(held('a'));
    useOutbox.getState().hold(held('b'));
    send.mockResolvedValue({});
    const sent: string[] = [];
    await flushOutbox((id) => sent.push(id));
    expect(send.mock.calls.map((c) => [c[1], c[5]])).toEqual([
      ['a', true],
      ['b', true],
    ]);
    expect(useOutbox.getState().items).toEqual([]);
    expect(sent).toEqual(['t1', 't1']);
  });

  it('keeps the rest while the server still cannot be reached, and drops one it refuses', async () => {
    useOutbox.getState().hold(held('a'));
    useOutbox.getState().hold(held('b'));
    send.mockRejectedValueOnce(new NoAnswerError('Failed to fetch'));
    await flushOutbox();
    expect(send).toHaveBeenCalledTimes(1);
    expect(useOutbox.getState().items.map((i) => i.clientId)).toEqual(['a', 'b']);

    send.mockRejectedValueOnce(new ApiError(403, 'yasak')).mockResolvedValueOnce({});
    await flushOutbox();
    expect(toastError).toHaveBeenCalledWith('yasak');
    expect(useOutbox.getState().items).toEqual([]);
  });

  it('holding the same message again keeps one copy', () => {
    useOutbox.getState().hold(held('a'));
    useOutbox.getState().hold(held('a'));
    expect(useOutbox.getState().items).toHaveLength(1);
  });

  it('a flush asked for while one runs makes one more pass instead of being lost', async () => {
    useOutbox.getState().hold(held('a'));
    let release: () => void = () => {};
    send.mockImplementationOnce(() => new Promise<void>((r) => (release = r)));
    send.mockResolvedValue({});
    const first = flushOutbox();
    // Written while the first pass is on its way; the connection is up, so it must not wait for a timer.
    useOutbox.getState().hold(held('b'));
    const second = flushOutbox();
    release();
    await Promise.all([first, second]);
    expect(send.mock.calls.map((c) => c[1])).toEqual(['a', 'b']);
    expect(useOutbox.getState().items).toEqual([]);
  });

  it('many requests during one pass cost a single extra pass, never parallel sends', async () => {
    useOutbox.getState().hold(held('a'));
    let release: () => void = () => {};
    let active = 0;
    let most = 0;
    send.mockImplementation(async (_t: string, id: string) => {
      active++;
      most = Math.max(most, active);
      if (id === 'a') await new Promise<void>((r) => (release = r));
      active--;
    });
    const runs = [flushOutbox(), flushOutbox(), flushOutbox()];
    release();
    await Promise.all(runs);
    expect(send).toHaveBeenCalledTimes(1);
    expect(most).toBe(1);
  });

  it('marks the message being sent, and back to held when the server still cannot be reached', async () => {
    useOutbox.getState().hold(held('a'));
    let fail: (e: unknown) => void = () => {};
    send.mockImplementationOnce(() => new Promise((_, rej) => (fail = rej)));
    const run = flushOutbox();
    expect(useOutbox.getState().items[0]?.phase).toBe('sending');
    fail(new NoAnswerError('Failed to fetch'));
    await run;
    expect(useOutbox.getState().items[0]?.phase ?? 'held').toBe('held');
  });
});
