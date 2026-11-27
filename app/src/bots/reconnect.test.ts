import { TunnelError } from '@leafbot/client/tunnel';
import { ConnectError } from '@leafbot/client/webrtc';
import { describe, expect, it } from 'vitest';
import { AccountError } from './account';
import { passing, RECONNECT_FOR_MS, reconnect, reconnectDelay } from './reconnect';

describe('passing', () => {
  it('waits out a restart and network faults', () => {
    for (const code of ['closed', 'timeout', 'busy'] as const)
      expect(passing(new TunnelError(code))).toBe(true);
    for (const code of ['offline', 'relay', 'failed', 'timeout'] as const)
      expect(passing(new ConnectError(code))).toBe(true);
    expect(passing(new AccountError(0, 'unreachable'))).toBe(true);
    expect(passing(new AccountError(502, 'http_502'))).toBe(true);
  });

  it('stops at a refusal, which trying again would only hide', () => {
    for (const code of ['access', 'revoked', 'ticket', 'proof', 'expired', 'host-proof', 'outdated'] as const)
      expect(passing(new TunnelError(code))).toBe(false);
    expect(passing(new ConnectError('revoked'))).toBe(false);
    expect(passing(new AccountError(401, 'unauthorized'))).toBe(false);
    expect(passing(new AccountError(404, 'not_found'))).toBe(false);
    expect(passing(new Error('anything else'))).toBe(false);
  });
});

describe('reconnectDelay', () => {
  it('starts at a second and doubles up to 30 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 10].map(reconnectDelay)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000,
    ]);
  });
});

/** A clock that moves only when the loop sleeps. */
function clock() {
  let t = 0;
  const waits: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      waits.push(ms);
      t += ms;
    },
    waits,
  };
}

describe('reconnect', () => {
  it('tries until the tunnel opens', async () => {
    const c = clock();
    let tries = 0;
    const failed: unknown[] = [];
    await reconnect({
      open: async () => {
        if (++tries < 3) throw new ConnectError('offline');
      },
      current: () => true,
      fail: (e) => failed.push(e),
      ...c,
    });
    expect(tries).toBe(3);
    expect(c.waits).toEqual([1000, 2000, 4000]);
    expect(failed).toEqual([]);
  });

  it('gives up at once on a refusal', async () => {
    const c = clock();
    const refusal = new TunnelError('revoked');
    const failed: unknown[] = [];
    await reconnect({
      open: () => Promise.reject(refusal),
      current: () => true,
      fail: (e) => failed.push(e),
      ...c,
    });
    expect(failed).toEqual([refusal]);
    expect(c.waits).toHaveLength(1);
  });

  it('gives up with the last reason once its time is over', async () => {
    const c = clock();
    const failed: unknown[] = [];
    await reconnect({
      open: () => Promise.reject(new ConnectError('offline')),
      current: () => true,
      fail: (e) => failed.push(e),
      ...c,
    });
    expect(failed).toHaveLength(1);
    expect((failed[0] as ConnectError).code).toBe('offline');
    expect(c.now()).toBeGreaterThanOrEqual(RECONNECT_FOR_MS);
  });

  it('opens nothing and reports nothing once the person moved on', async () => {
    const c = clock();
    let here = true;
    let tries = 0;
    const failed: unknown[] = [];
    await reconnect({
      open: async () => {
        tries++;
        here = false;
        throw new ConnectError('offline');
      },
      current: () => here,
      fail: (e) => failed.push(e),
      ...c,
    });
    expect(tries).toBe(1);
    expect(failed).toEqual([]);

    let opened = false;
    await reconnect({
      open: async () => {
        opened = true;
      },
      current: () => false,
      fail: (e) => failed.push(e),
      ...c,
    });
    expect(opened).toBe(false);
    expect(failed).toEqual([]);
  });
});
