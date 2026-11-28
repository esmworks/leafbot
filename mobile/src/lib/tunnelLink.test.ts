import { describe, expect, it } from 'vitest';
import { TunnelError } from '@leafbot/client/tunnel';
import { ConnectError } from '@leafbot/client/webrtc';
import { AccountError } from './account';
import { Link, NoTunnelError, type LinkState, type LiveTunnel } from './tunnelLink';

const tunnel = (): LiveTunnel & { closed: boolean } => ({
  closed: false,
  request: () => Promise.reject(new Error('unused')),
  realtime: () => {
    throw new Error('unused');
  },
  close() {
    this.closed = true;
  },
});

/** Lets pending promise work finish. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/** The waits the link asked for, answered at once. */
function instantSleeps() {
  const waits: number[] = [];
  return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

describe('Link', () => {
  it('goes online once the tunnel is open and gives it to those who ask', async () => {
    const t = tunnel();
    const link = new Link({ open: async () => t });
    link.start();
    expect(link.state.at).toBe('connecting');
    await settle();
    expect(link.state.at).toBe('online');
    expect(await link.tunnel()).toBe(t);
    link.stop();
    expect(t.closed).toBe(true);
    expect(link.state.at).toBe('idle');
  });

  it('waits longer after each failure, up to 30 s, and starts over once it was open a while', async () => {
    const { waits, sleep } = instantSleeps();
    let n = 0;
    let clock = 0;
    const ends: ((c: string) => void)[] = [];
    const link = new Link({
      sleep,
      now: () => clock,
      open: async (onEnd) => {
        n++;
        if (n <= 6) throw new TunnelError('timeout');
        ends.push(onEnd);
        return tunnel();
      },
    });
    link.start();
    await settle();
    expect(waits.slice(0, 6)).toEqual([1000, 2000, 4000, 8000, 16000, 30000]);
    expect(link.state.at).toBe('online');
    clock += 30_000;
    ends[0]!('closed');
    await settle();
    // The connection dropped after it had worked: the next wait is the short one again.
    expect(waits[6]).toBe(1000);
    link.stop();
  });

  it('keeps backing off when every tunnel drops as soon as it opens', async () => {
    const { waits, sleep } = instantSleeps();
    let opens = 0;
    const link = new Link({
      sleep,
      now: () => 0,
      open: async (onEnd) => {
        opens++;
        if (opens <= 4) setTimeout(() => onEnd('closed'), 0);
        return tunnel();
      },
    });
    link.start();
    for (let i = 0; i < 12; i++) await settle();
    expect(waits.slice(0, 4)).toEqual([1000, 2000, 4000, 8000]);
    link.stop();
  });

  it('stays refused when trying again would not help, until poked', async () => {
    let n = 0;
    const link = new Link({
      sleep: async () => undefined,
      open: async () => {
        n++;
        throw new AccountError(401, 'unauthorized');
      },
    });
    link.start();
    await settle();
    expect(link.state).toEqual<LinkState>({ at: 'refused', reason: 'signed-out' });
    expect(n).toBe(1);
    await expect(link.tunnel()).rejects.toBeInstanceOf(NoTunnelError);
    link.poke();
    await settle();
    expect(n).toBe(2);
    link.stop();
  });

  it('keeps retrying when the account service is out of reach', async () => {
    const { sleep } = instantSleeps();
    let n = 0;
    const link = new Link({
      sleep,
      open: async () => {
        if (++n < 3) throw new AccountError(0, 'unreachable');
        return tunnel();
      },
    });
    link.start();
    await settle();
    expect(link.state.at).toBe('online');
    link.stop();
  });

  it('says what the WebRTC stack said while it tries again', async () => {
    const link = new Link({
      sleep: () => new Promise(() => undefined),
      open: async () => {
        throw new ConnectError('failed', 'answer: Failed to set remote answer sdp');
      },
    });
    link.start();
    await settle();
    expect(link.state).toEqual({
      at: 'retrying',
      reason: 'failed',
      detail: 'answer: Failed to set remote answer sdp',
    });
    link.stop();

    const other = new Link({
      sleep: () => new Promise(() => undefined),
      open: async () => {
        throw new TypeError('addIceCandidate is not a function');
      },
    });
    other.start();
    await settle();
    expect(other.state).toEqual({
      at: 'retrying',
      reason: 'failed',
      detail: 'addIceCandidate is not a function',
    });
    other.stop();
  });

  it('hands a waiting request the tunnel that opens, and fails it when the link stops', async () => {
    let release: (t: LiveTunnel) => void = () => undefined;
    const link = new Link({ open: () => new Promise((r) => (release = r)) });
    link.start();
    const first = link.tunnel(1000);
    const t = tunnel();
    release(t);
    expect(await first).toBe(t);
    link.stop();

    const second = new Link({ open: () => new Promise(() => undefined) });
    second.start();
    const waiting = second.tunnel(1000).catch((e: unknown) => e);
    second.stop();
    expect(await waiting).toBeInstanceOf(NoTunnelError);
  });

  it('gives a request that failed on a dead tunnel the one opened after it', async () => {
    const ends: ((c: string) => void)[] = [];
    const opened: LiveTunnel[] = [];
    const link = new Link({
      sleep: async () => undefined,
      open: async (onEnd) => {
        ends.push(onEnd);
        const t = tunnel();
        opened.push(t);
        return t;
      },
    });
    link.start();
    await settle();
    const stale = opened[0]!;
    // The request finds the tunnel dead before the link hears it end.
    const after = link.tunnelAfter(stale, 1000, 500);
    ends[0]!('closed');
    const next = await after;
    expect(next).toBe(opened[1]);
    expect(next).not.toBe(stale);
    // Asked once the newer one is open, it is given at once.
    expect(await link.tunnelAfter(stale)).toBe(next);
    link.stop();
  });

  it('gives the same tunnel again when the link still holds it after the grace', async () => {
    const t = tunnel();
    const link = new Link({ open: async () => t });
    link.start();
    await settle();
    expect(await link.tunnelAfter(t, 1000, 10)).toBe(t);
    link.stop();
    expect(await link.tunnelAfter(t, 1000, 10).catch((e: unknown) => e)).toBeInstanceOf(NoTunnelError);
  });
});
