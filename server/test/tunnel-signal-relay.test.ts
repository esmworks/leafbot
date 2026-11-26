import { afterEach, describe, expect, it } from 'vitest';
import { hello, startRelay, type Running, type TestSocket } from '../../relay/test/helpers';
import type { TunnelChannel, TunnelGateway } from '../src/tunnel/gateway';
import { SignalClient, type Candidate, type RtcConnection } from '../src/tunnel/signal';

/** The server's signalling client against the relay itself, not a stand-in for it. */
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

describe('the server through the relay', () => {
  it('signs in as the host and answers a browser’s offer', async () => {
    relay = await startRelay();
    const r = relay;
    const rtcs: FakeRtc[] = [];
    const accepted: unknown[] = [];
    client = new SignalClient({
      url: r.url,
      hostTicket: async () => r.ticket({ kind: 'host' }),
      rtc: () => {
        const rtc = new FakeRtc();
        rtcs.push(rtc);
        return rtc;
      },
      gateway: { accept: (p: unknown) => accepted.push(p) } as unknown as TunnelGateway,
    });
    client.start();
    await until(() => r.relay.stats().hosts === 1);

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
