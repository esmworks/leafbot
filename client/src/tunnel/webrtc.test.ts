import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectPeer } from './webrtc';

/** The relay's side of the signalling socket: what the browser sent, and a way to answer. */
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static last: FakeSocket | null = null;
  readyState = 0;
  sent: { type: string; sdp?: string; candidate?: { candidate: string } | null }[] = [];

  constructor(readonly url: string) {
    super();
    FakeSocket.last = this;
    queueMicrotask(() => {
      this.readyState = FakeSocket.OPEN;
      this.dispatchEvent(new Event('open'));
    });
  }

  send(data: string) {
    this.sent.push(JSON.parse(data));
  }

  close() {
    this.readyState = 3;
  }

  relay(msg: object) {
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(msg) }));
  }
}

class FakeChannel extends EventTarget {
  readyState = 'connecting';
  binaryType = 'blob';
  bufferedAmountLowThreshold = 0;
  constructor(readonly label: string) {
    super();
  }
}

/** A peer connection that finds the candidates it is told to, and goes no further. */
class FakePeer extends EventTarget {
  static last: FakePeer | null = null;
  localDescription: { sdp: string } | null = null;
  remoteDescription: unknown = null;
  connectionState = 'new';
  constructor() {
    super();
    FakePeer.last = this;
  }
  createDataChannel(label: string) {
    return new FakeChannel(label);
  }
  async createOffer() {
    return { type: 'offer', sdp: 'v=0 offer' };
  }
  async setLocalDescription(d: { sdp: string }) {
    this.localDescription = d;
  }
  find(candidate: string | null) {
    const e = new Event('icecandidate') as Event & { candidate: unknown };
    e.candidate = candidate && { candidate, sdpMid: '0', sdpMLineIndex: 0, usernameFragment: 'u' };
    this.dispatchEvent(e);
  }
  close() {}
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const welcome = {
  type: 'welcome',
  role: 'client',
  hostOnline: false,
  resumeToken: 'r',
  resumeExpiresAt: 0,
  iceServers: [],
  iceServersExpireAt: 0,
};

describe('connectPeer', () => {
  it('sends the offer and its candidates again when the server comes back', async () => {
    vi.stubGlobal('WebSocket', FakeSocket);
    vi.stubGlobal('RTCPeerConnection', FakePeer);
    const peer = connectPeer({ relayUrl: 'wss://relay/v1/signal', ticket: async () => 't', timeoutMs: 1000 });
    peer.catch(() => {});
    await vi.waitFor(() => expect(FakeSocket.last?.readyState).toBe(FakeSocket.OPEN));
    const ws = FakeSocket.last!;
    ws.relay(welcome);
    await vi.waitFor(() => expect(ws.sent.some((m) => m.type === 'offer')).toBe(true));

    // Found while the server was away, so the relay dropped them.
    FakePeer.last!.find('candidate:1 1 udp 1 192.0.2.1 5000 typ relay');
    FakePeer.last!.find(null);
    ws.sent.length = 0;

    ws.relay({ type: 'host-online' });
    expect(ws.sent.map((m) => m.type)).toEqual(['offer', 'ice-candidate', 'ice-candidate']);
    expect(ws.sent[0]!.sdp).toBe('v=0 offer');
    expect(ws.sent[1]!.candidate?.candidate).toContain('192.0.2.1');
    expect(ws.sent[2]!.candidate).toBeNull();
  });
});
