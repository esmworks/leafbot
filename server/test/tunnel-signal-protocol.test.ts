import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { SIGNAL_PATH, SignalInbound, SignalOutbound } from '@leafbot/shared/signal';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { TunnelChannel, TunnelGateway } from '../src/tunnel/gateway';
import { SignalClient, type Candidate, type RtcConnection } from '../src/tunnel/signal';

/**
 * A stand-in for the signalling relay, which runs with the website: it speaks the relay's side of
 * `shared/src/signal.ts` and checks every message both ways against those schemas, so the server's
 * client is held to the contract the real relay is built from. Checking tickets is the relay's own
 * concern and is tested with it.
 */
async function startRelay() {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0, path: SIGNAL_PATH });
  await new Promise<void>((resolve) => wss.once('listening', () => resolve()));
  const clients = new Map<string, WebSocket>();
  let host: WebSocket | undefined;
  const out = (ws: WebSocket | undefined, msg: unknown) =>
    ws?.send(JSON.stringify(SignalOutbound.parse(msg)));
  const welcome = (role: 'host' | 'client', extra: object) => ({
    type: 'welcome',
    role,
    ...extra,
    resumeToken: 'resume',
    resumeExpiresAt: Math.floor(Date.now() / 1000) + 600,
    iceServers: [],
    iceServersExpireAt: Math.floor(Date.now() / 1000) + 3600,
  });
  wss.on('connection', (ws) => {
    let cid: string | undefined;
    ws.on('message', (data) => {
      const msg = SignalInbound.parse(JSON.parse(data.toString()));
      if (msg.type === 'hello') {
        if (msg.role === 'host') {
          host = ws;
          out(ws, welcome('host', {}));
        } else {
          cid = randomBytes(12).toString('base64url');
          clients.set(cid, ws);
          out(ws, welcome('client', { connectionId: cid, hostOnline: host !== undefined }));
          out(host, { type: 'peer-joined', connectionId: cid });
        }
        return;
      }
      if (msg.type === 'refresh') return;
      // A client's message goes to the server with the relay's id for it; the server's to the client it names.
      if (ws === host) out(msg.connectionId ? clients.get(msg.connectionId) : undefined, msg);
      else out(host, { ...msg, connectionId: cid });
    });
  });
  const { port } = wss.address() as AddressInfo;
  return {
    url: `ws://127.0.0.1:${port}${SIGNAL_PATH}`,
    hosts: () => (host && host.readyState === WebSocket.OPEN ? 1 : 0),
    ticket: () => 'ticket',
    stop: () => new Promise<void>((resolve) => wss.close(() => resolve())),
  };
}
type Running = Awaited<ReturnType<typeof startRelay>>;

/** A socket as a browser holds it: every message it got, and a wait for the next of a type. */
class TestSocket {
  readonly messages: Record<string, unknown>[] = [];
  private taken = new Set<Record<string, unknown>>();
  private waiters: { type: string; resolve: (m: Record<string, unknown>) => void }[] = [];
  constructor(readonly ws: WebSocket) {
    ws.on('message', (data) => {
      this.messages.push(JSON.parse(data.toString()) as Record<string, unknown>);
      this.flush();
    });
  }
  send(msg: unknown) {
    this.ws.send(JSON.stringify(msg));
  }
  next(type: string, timeoutMs = 3000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no ${type} within ${timeoutMs} ms`)), timeoutMs);
      this.waiters.push({
        type,
        resolve: (m) => {
          clearTimeout(timer);
          resolve(m);
        },
      });
      this.flush();
    });
  }
  private flush() {
    for (const waiter of [...this.waiters]) {
      const msg = this.messages.find((m) => m.type === waiter.type && !this.taken.has(m));
      if (!msg) continue;
      this.taken.add(msg);
      this.waiters.splice(this.waiters.indexOf(waiter), 1);
      waiter.resolve(msg);
    }
  }
}

async function hello(url: string, role: 'host' | 'client', auth: { ticket: string }) {
  const ws = new WebSocket(url);
  const sock = new TestSocket(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  sock.send({ type: 'hello', role, ...auth });
  return { sock, welcome: await sock.next('welcome') };
}

class FakeRtc implements RtcConnection {
  localFingerprint = 'sha-256 AA';
  remoteFingerprint = 'sha-256 BB';
  private candidate: ((c: Candidate) => void)[] = [];
  private connected: (() => void)[] = [];
  candidates: Candidate[] = [];
  async answer(offer: string) {
    return `answer-to:${offer}`;
  }
  addCandidate(c: Candidate) {
    this.candidates.push(c);
  }
  onCandidate(cb: (c: Candidate) => void) {
    this.candidate.push(cb);
  }
  onConnected(cb: () => void) {
    this.connected.push(cb);
  }
  onChannel(_cb: (ch: TunnelChannel) => void) {}
  onClose() {}
  close() {}
  emit(c: string) {
    for (const cb of this.candidate) cb({ candidate: c, sdpMid: '0' });
  }
  connect() {
    for (const cb of this.connected) cb();
  }
}

let relay: Running | undefined;
let client: SignalClient | undefined;
const socks: TestSocket[] = [];
afterEach(async () => {
  client?.stop();
  for (const s of socks.splice(0)) s.ws.terminate();
  await relay?.stop();
});

const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe('the server through a relay speaking the signalling contract', () => {
  it('signs in as the host and answers a browser’s offer', async () => {
    relay = await startRelay();
    const r = relay;
    const rtcs: FakeRtc[] = [];
    const accepted: unknown[] = [];
    client = new SignalClient({
      url: r.url,
      hostTicket: async () => r.ticket(),
      rtc: () => {
        const rtc = new FakeRtc();
        rtcs.push(rtc);
        return rtc;
      },
      gateway: { accept: (p: unknown) => accepted.push(p) } as unknown as TunnelGateway,
    });
    client.start();
    await until(() => r.hosts() === 1);

    const { sock: browser, welcome } = await hello(r.url, 'client', { ticket: r.ticket() });
    socks.push(browser);
    expect(welcome.hostOnline).toBe(true);
    browser.send({ type: 'offer', sdp: 'v=0 OFFER' });
    expect(await browser.next('answer')).toMatchObject({ sdp: 'answer-to:v=0 OFFER' });
    browser.send({ type: 'ice-candidate', candidate: { candidate: 'candidate:1', sdpMid: '0' } });
    await until(() => rtcs[0]?.candidates.length === 1);
    rtcs[0]!.emit('candidate:2');
    expect(await browser.next('ice-candidate')).toMatchObject({ candidate: { candidate: 'candidate:2' } });
    rtcs[0]!.connect();
    expect(accepted).toEqual([rtcs[0]]);
  });
});
