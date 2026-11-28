import { ApiError } from '@leafbot/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: vi.fn() } }));

const { isOffline, sendWithRetry, waitOrBack } = await import('./sendRetry');

const fast = { wait: async () => undefined, active: async () => undefined };

describe('send retry', () => {
  it('tries again after a failure to connect, with the same attempt, and returns its answer', async () => {
    let calls = 0;
    const attempt = async () => {
      if (++calls < 3) throw new TypeError('Network request failed');
      return 'sent';
    };
    await expect(sendWithRetry(attempt, fast)).resolves.toBe('sent');
    expect(calls).toBe(3);
  });

  it('waits for the app to be in the foreground before each new try', async () => {
    const steps: string[] = [];
    let calls = 0;
    await sendWithRetry(
      async () => {
        steps.push('try');
        if (++calls < 2) throw new TypeError('Network request failed');
      },
      { wait: async () => void steps.push('wait'), active: async () => void steps.push('active') },
    );
    expect(steps).toEqual(['try', 'active', 'wait', 'try']);
  });

  it('does not repeat what the server refused', async () => {
    let calls = 0;
    const refused = new ApiError(400, 'no');
    await expect(
      sendWithRetry(async () => {
        calls++;
        throw refused;
      }, fast),
    ).rejects.toBe(refused);
    expect(calls).toBe(1);
  });

  it('gives up with the last error after the last wait, or when the message is too old', async () => {
    let calls = 0;
    const err = new TypeError('Network request failed');
    const fail = async () => {
      calls++;
      throw err;
    };
    await expect(sendWithRetry(fail, { ...fast, backoff: [1, 1] })).rejects.toBe(err);
    expect(calls).toBe(3);

    calls = 0;
    let t = 0;
    await expect(sendWithRetry(fail, { ...fast, now: () => (t += 10 * 60_000) })).rejects.toBe(err);
    expect(calls).toBe(1);
  });

  it('counts no answer and a proxy error page as offline, but not the server’s own errors', () => {
    expect(isOffline(new TypeError('Network request failed'))).toBe(true);
    expect(isOffline(new ApiError(503, 'x', false))).toBe(true);
    expect(isOffline(new ApiError(503, 'x', true))).toBe(false);
    expect(isOffline(new ApiError(500, 'x', true))).toBe(false);
  });
});

describe('waitOrBack', () => {
  /** A link whose state the test moves; only what `waitOrBack` reads of it. */
  function fakeLink(at: string) {
    const listeners = new Set<() => void>();
    const link = {
      state: { at },
      subscribe: (fn: () => void) => {
        listeners.add(fn);
        return () => void listeners.delete(fn);
      },
      move(next: string) {
        link.state = { at: next };
        for (const fn of listeners) fn();
      },
      listeners,
    };
    return link;
  }

  it('ends the wait when the link opens again', async () => {
    vi.useFakeTimers();
    const link = fakeLink('retrying');
    let done = false;
    void waitOrBack(45_000, link as never).then(() => (done = true));
    link.move('connecting');
    await Promise.resolve();
    expect(done).toBe(false);
    link.move('online');
    await Promise.resolve();
    expect(done).toBe(true);
    expect(link.listeners.size).toBe(0);
    vi.useRealTimers();
  });

  it('gives the whole wait when the link was open all along', async () => {
    vi.useFakeTimers();
    const link = fakeLink('online');
    let done = false;
    void waitOrBack(3_000, link as never).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(2_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(done).toBe(true);
    expect(link.listeners.size).toBe(0);
    vi.useRealTimers();
  });
});
