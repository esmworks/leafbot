import type { AddressInfo } from 'node:net';
import type { SignalFromRelay, SignalToRelay } from '@leafbot/shared/tunnel';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { TunnelGateway, TunnelChannel } from '../src/tunnel/gateway';
import { SignalClient, type RtcConnection } from '../src/tunnel/signal';

/** The relay's side, as the server sees it. */
async function relay() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const got: SignalToRelay[] = [];
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (m: Buffer) => got.push(JSON.parse(m.toString()) as SignalToRelay));
  });
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/signal`,
    got,
    sockets,
    say: (m: SignalFromRelay) => sockets.at(-1)!.send(JSON.stringify(m)),
    close: () => new Promise<void>((r) => wss.close(() => r())),
    wss,
  };
}

class FakeRtc implements RtcConnection {
  localFingerprint = 'sha-256 AA';
  remoteFingerprint = 'sha-256 BB';
  closed = false;
  candidates: [string, string | null][] = [];
  private cbs = {
    candidate: [] as ((c: string, m: string | null) => void)[],
    connected: [] as (() => void)[],
    close: [] as (() => void)[],
  };
  async answer(offer: string) {
    return `answer-to:${offer}`;
  }
  addCandidate(c: string, mid: string | null) {
    this.candidates.push([c, mid]);
  }
  onCandidate(cb: (c: string, m: string | null) => void) {
    this.cbs.candidate.push(cb);
  }
  onConnected(cb: () => void) {
    this.cbs.connected.push(cb);
  }
  onChannel(_cb: (ch: TunnelChannel) => void) {}
  onClose(cb: () => void) {
    this.cbs.close.push(cb);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.cbs.close) cb();
  }
  emitCandidate(c: string) {
    for (const cb of this.cbs.candidate) cb(c, '0');
  }
  connect() {
    for (const cb of this.cbs.connected) cb();
  }
}

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanup.reverse()) await c();
  cleanup = [];
});

function setup(r: Awaited<ReturnType<typeof relay>>, tickets = { n: 0 }) {
  const rtcs: FakeRtc[] = [];
  const accepted: unknown[] = [];
  const revoked: unknown[] = [];
  const gateway = {
    accept: (p: unknown) => accepted.push(p),
    revoke: (e: unknown) => revoked.push(e),
  } as unknown as TunnelGateway;
  const client = new SignalClient({
    url: r.url,
    hostTicket: async () => `host-ticket-${++tickets.n}`,
    rtc: () => {
      const rtc = new FakeRtc();
      rtcs.push(rtc);
      return rtc;
    },
    gateway,
    maxConnections: 2,
  });
  cleanup.push(() => client.stop());
  client.start();
  return { client, rtcs, accepted, revoked, tickets };
}

describe('SignalClient', () => {
  it('says hello with a host ticket, answers an offer and hands the connection to the gateway', async () => {
    const r = await relay();
    cleanup.push(r.close);
    const { client, rtcs, accepted } = setup(r);
    await until(() => r.got.length > 0);
    expect(r.got[0]).toEqual({ t: 'hello', ticket: 'host-ticket-1' });
    r.say({ t: 'ready', iceServers: [], resume: 'res_1' });
    r.say({ t: 'connect', cid: 'cid_00000001', iceServers: [{ urls: 'turn:turn.example' }] });
    r.say({ t: 'offer', cid: 'cid_00000001', sdp: 'OFFER' });
    await until(() => r.got.some((m) => m.t === 'answer'));
    expect(r.got).toContainEqual({ t: 'answer', cid: 'cid_00000001', sdp: 'answer-to:OFFER' });
    r.say({ t: 'ice', cid: 'cid_00000001', candidate: 'candidate:1', mid: '0' });
    await until(() => rtcs[0]!.candidates.length === 1);
    rtcs[0]!.emitCandidate('candidate:2');
    await until(() => r.got.some((m) => m.t === 'ice'));
    rtcs[0]!.connect();
    expect(accepted).toEqual([rtcs[0]]);
    expect(client.size).toBe(1);
  });

  it('refuses connections beyond the limit', async () => {
    const r = await relay();
    cleanup.push(r.close);
    setup(r);
    await until(() => r.got.length > 0);
    for (const n of [1, 2, 3]) r.say({ t: 'connect', cid: `cid_0000000${n}`, iceServers: [] });
    await until(() => r.got.some((m) => m.t === 'bye'));
    expect(r.got).toContainEqual({ t: 'bye', cid: 'cid_00000003' });
  });

  it('passes revocations to the gateway', async () => {
    const r = await relay();
    cleanup.push(r.close);
    const { revoked } = setup(r);
    await until(() => r.got.length > 0);
    r.say({ t: 'revoke', epoch: 7, userId: 'acct_alice123' });
    await until(() => revoked.length === 1);
    expect(revoked[0]).toEqual({ t: 'revoke', epoch: 7, userId: 'acct_alice123' });
  });

  it('connects again with a fresh ticket and the resume token after the relay drops', async () => {
    const r = await relay();
    cleanup.push(r.close);
    const { rtcs, client } = setup(r);
    await until(() => r.got.length > 0);
    r.say({ t: 'ready', iceServers: [], resume: 'res_1' });
    r.say({ t: 'connect', cid: 'cid_00000001', iceServers: [] });
    r.say({ t: 'connect', cid: 'cid_00000002', iceServers: [] });
    await until(() => rtcs.length === 2);
    rtcs[0]!.connect();
    r.sockets.at(-1)!.terminate();
    await until(() => r.got.filter((m) => m.t === 'hello').length === 2, 5000);
    expect(r.got.filter((m) => m.t === 'hello').at(-1)).toEqual({
      t: 'hello',
      ticket: 'host-ticket-2',
      resume: 'res_1',
    });
    // The open connection stays; the one still being set up is given up.
    expect(rtcs[0]!.closed).toBe(false);
    expect(rtcs[1]!.closed).toBe(true);
    expect(client.size).toBe(1);
  });
});
