import type { AddressInfo } from 'node:net';
import { SignalClose, type SignalInbound, type SignalOutbound } from '@leafbot/shared/signal';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';
import type { TunnelChannel, TunnelGateway } from '../src/tunnel/gateway';
import { SignalClient, type Candidate, type RtcConnection } from '../src/tunnel/signal';

const CID1 = 'conn_000000000001';
const CID2 = 'conn_000000000002';
const CID3 = 'conn_000000000003';
const NOW = 1_800_000_000;

/** The relay's side, as the server sees it. */
async function relay() {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((r) => wss.once('listening', r));
  const got: SignalInbound[] = [];
  const sockets: WebSocket[] = [];
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (m: Buffer) => got.push(JSON.parse(m.toString()) as SignalInbound));
  });
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/v1/signal`,
    got,
    sockets,
    say: (m: SignalOutbound) => sockets.at(-1)!.send(JSON.stringify(m)),
    welcome: (resumeToken = 'res_1', resumeExpiresAt = NOW + 600) =>
      sockets.at(-1)!.send(
        JSON.stringify({
          type: 'welcome',
          role: 'host',
          resumeToken,
          resumeExpiresAt,
          iceServers: [{ urls: ['turn:turn.example'] }],
          iceServersExpireAt: NOW + 3600,
        } satisfies SignalOutbound),
      ),
    close: () => new Promise<void>((r) => wss.close(() => r())),
  };
}

class FakeRtc implements RtcConnection {
  localFingerprint = 'sha-256 AA';
  remoteFingerprint = 'sha-256 BB';
  closed = false;
  candidates: Candidate[] = [];
  offers: string[] = [];
  private cbs = {
    candidate: [] as ((c: Candidate) => void)[],
    connected: [] as (() => void)[],
    close: [] as (() => void)[],
  };
  constructor(readonly iceServers: unknown) {}
  async answer(offer: string) {
    this.offers.push(offer);
    return `answer-to:${offer}`;
  }
  addCandidate(c: Candidate) {
    this.candidates.push(c);
  }
  onCandidate(cb: (c: Candidate) => void) {
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
    for (const cb of this.cbs.candidate) cb({ candidate: c, sdpMid: '0' });
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

function setup(r: Awaited<ReturnType<typeof relay>>, now = () => NOW) {
  const rtcs: FakeRtc[] = [];
  const accepted: unknown[] = [];
  const tickets = { n: 0 };
  const gateway = { accept: (p: unknown) => accepted.push(p) } as unknown as TunnelGateway;
  const client = new SignalClient({
    url: r.url,
    hostTicket: async () => `host-ticket-${++tickets.n}`,
    rtc: ({ iceServers }) => {
      const rtc = new FakeRtc(iceServers);
      rtcs.push(rtc);
      return rtc;
    },
    gateway,
    maxConnections: 2,
    now,
  });
  cleanup.push(() => client.stop());
  client.start();
  return { client, rtcs, accepted, tickets };
}

const hellos = (got: SignalInbound[]) => got.filter((m) => m.type === 'hello');

describe('SignalClient', () => {
  it('says hello as the host, answers an offer and hands the connection to the gateway', async () => {
    const r = await relay();
    cleanup.push(r.close);
    const { client, rtcs, accepted } = setup(r);
    await until(() => r.got.length > 0);
    expect(r.got[0]).toEqual({ type: 'hello', role: 'host', ticket: 'host-ticket-1' });
    r.welcome();
    r.say({ type: 'peer-joined', connectionId: CID1 });
    r.say({ type: 'offer', connectionId: CID1, sdp: 'OFFER' });
    await until(() => r.got.some((m) => m.type === 'answer'));
    expect(r.got).toContainEqual({ type: 'answer', connectionId: CID1, sdp: 'answer-to:OFFER' });
    // The TURN servers from the welcome are the ones the connection uses.
    expect(rtcs[0]!.iceServers).toEqual([{ urls: ['turn:turn.example'] }]);
    r.say({
      type: 'ice-candidate',
      connectionId: CID1,
      candidate: { candidate: 'candidate:1', sdpMid: '0' },
    });
    await until(() => rtcs[0]!.candidates.length === 1);
    rtcs[0]!.emitCandidate('candidate:2');
    await until(() => r.got.some((m) => m.type === 'ice-candidate'));
    expect(r.got).toContainEqual({
      type: 'ice-candidate',
      connectionId: CID1,
      candidate: { candidate: 'candidate:2', sdpMid: '0' },
    });
    rtcs[0]!.connect();
    expect(accepted).toEqual([rtcs[0]]);
    // An ICE restart is a new offer on the same connection.
    r.say({ type: 'offer', connectionId: CID1, sdp: 'RESTART' });
    await until(() => rtcs[0]!.offers.length === 2);
    expect(rtcs.length).toBe(1);
    expect(client.size).toBe(1);
  });

  it('refuses connections beyond the limit', async () => {
    const r = await relay();
    cleanup.push(r.close);
    setup(r);
    await until(() => r.got.length > 0);
    r.welcome();
    for (const cid of [CID1, CID2, CID3]) r.say({ type: 'offer', connectionId: cid, sdp: 'OFFER' });
    await until(() => r.got.some((m) => m.type === 'bye'));
    expect(r.got).toContainEqual({ type: 'bye', connectionId: CID3, reason: 'busy' });
  });

  it('sends a fresh ticket before the relay’s window ends', async () => {
    const r = await relay();
    cleanup.push(r.close);
    setup(r);
    await until(() => r.got.length > 0);
    // A window that ends in two seconds: the refresh goes out after about a second.
    r.welcome('res_1', NOW + 2);
    await until(() => r.got.some((m) => m.type === 'refresh'), 4000);
    expect(r.got.find((m) => m.type === 'refresh')).toEqual({ type: 'refresh', ticket: 'host-ticket-2' });
  });

  it('resumes after a brief drop, keeping open connections', async () => {
    const r = await relay();
    cleanup.push(r.close);
    const { rtcs, client } = setup(r);
    await until(() => r.got.length > 0);
    r.welcome('res_1');
    r.say({ type: 'offer', connectionId: CID1, sdp: 'A' });
    r.say({ type: 'offer', connectionId: CID2, sdp: 'B' });
    await until(() => rtcs.length === 2);
    rtcs[0]!.connect();
    r.sockets.at(-1)!.terminate();
    await until(() => hellos(r.got).length === 2, 5000);
    expect(hellos(r.got).at(-1)).toEqual({ type: 'hello', role: 'host', resume: 'res_1' });
    // The open connection stays; the one still being set up is given up.
    expect(rtcs[0]!.closed).toBe(false);
    expect(rtcs[1]!.closed).toBe(true);
    expect(client.size).toBe(1);
  });

  it('needs a fresh ticket again when the relay refused the resume', async () => {
    const r = await relay();
    cleanup.push(r.close);
    setup(r);
    await until(() => r.got.length > 0);
    r.welcome('res_1');
    await until(() => r.sockets.length === 1);
    r.sockets.at(-1)!.close(SignalClose.ticketInvalid, 'ticket-invalid');
    await until(() => hellos(r.got).length === 2, 5000);
    expect(hellos(r.got).at(-1)).toEqual({ type: 'hello', role: 'host', ticket: 'host-ticket-2' });
  });
});
