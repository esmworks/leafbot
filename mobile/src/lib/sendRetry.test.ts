import { ApiError } from '@leafbot/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: vi.fn() } }));

const { isOffline, sendWithRetry } = await import('./sendRetry');

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
