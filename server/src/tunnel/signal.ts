import { SignalFromRelay, type IceServer, type SignalToRelay } from '@leafbot/shared/tunnel';
import { WebSocket } from 'ws';
import type { TunnelGateway, TunnelPeer } from './gateway';

/**
 * A WebRTC connection on the server's side, whatever library makes it. The browser offers; the
 * server answers.
 */
export interface RtcConnection extends TunnelPeer {
  /** Takes the browser's offer and returns the answer. */
  answer(offerSdp: string): Promise<string>;
  addCandidate(candidate: string, mid: string | null): void;
  /** Candidates found on this side, to send to the browser. */
  onCandidate(cb: (candidate: string, mid: string | null) => void): void;
  /** DTLS is up: the fingerprints can be read and channels arrive. */
  onConnected(cb: () => void): void;
}

export type RtcFactory = (opts: { iceServers: IceServer[] }) => RtcConnection;

export interface SignalOptions {
  /** The relay's signalling address, `wss://…/v1/signal`. */
  url: string;
  /** A fresh `host` ticket from the account service, proving to the relay which server this is. */
  hostTicket(): Promise<string>;
  rtc: RtcFactory;
  gateway: TunnelGateway;
  /** Connections being set up or open at once; more are refused until some close. */
  maxConnections?: number;
  /** Opens the WebSocket; tests pass their own. */
  connect?(url: string): WebSocket;
}

const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** A connection that does not reach DTLS in this long is given up. */
const SETUP_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 32;

/**
 * Keeps the server reachable through the relay: one outgoing WebSocket, opened again with growing
 * pauses when it drops, over which browsers' offers arrive and answers go back. Once a browser's
 * connection is up it belongs to the gateway; the relay sees nothing of it but the setup.
 */
export class SignalClient {
  private ws: WebSocket | null = null;
  private retry = MIN_RETRY_MS;
  private timer: NodeJS.Timeout | null = null;
  private stopped = true;
  private resume: string | undefined;
  private peers = new Map<string, { rtc: RtcConnection; setup: NodeJS.Timeout | null }>();

  constructor(private opts: SignalOptions) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.open();
  }

  stop() {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.terminate();
    this.ws = null;
    for (const cid of [...this.peers.keys()]) this.drop(cid);
  }

  /** Connections being set up or open. */
  get size() {
    return this.peers.size;
  }

  private async open() {
    if (this.stopped) return;
    let ticket: string;
    try {
      ticket = await this.opts.hostTicket();
    } catch {
      return this.later();
    }
    if (this.stopped) return;
    const ws =
      this.opts.connect?.(this.opts.url) ?? new WebSocket(this.opts.url, { perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => this.send({ t: 'hello', ticket, ...(this.resume && { resume: this.resume }) }));
    ws.on('message', (data: Buffer, isBinary) => {
      if (isBinary) return;
      let msg: SignalFromRelay;
      try {
        msg = SignalFromRelay.parse(JSON.parse(data.toString('utf8')));
      } catch {
        return;
      }
      void this.handle(msg);
    });
    const lost = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      // Open browser connections do not need the relay any more and stay; only setups are lost.
      for (const [cid, p] of this.peers) if (p.setup) this.drop(cid);
      this.later();
    };
    ws.on('close', lost);
    ws.on('error', lost);
  }

  private later() {
    if (this.stopped || this.timer) return;
    const wait = this.retry * (0.5 + Math.random());
    this.retry = Math.min(this.retry * 2, MAX_RETRY_MS);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.open();
    }, wait);
  }

  private send(msg: SignalToRelay) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private async handle(msg: SignalFromRelay) {
    switch (msg.t) {
      case 'ready':
        this.retry = MIN_RETRY_MS;
        this.resume = msg.resume;
        return;
      case 'connect':
        return this.connectPeer(msg.cid, msg.iceServers);
      case 'offer': {
        const p = this.peers.get(msg.cid);
        if (!p) return this.send({ t: 'bye', cid: msg.cid });
        try {
          const sdp = await p.rtc.answer(msg.sdp);
          this.send({ t: 'answer', cid: msg.cid, sdp });
        } catch {
          this.drop(msg.cid);
        }
        return;
      }
      case 'ice':
        this.peers.get(msg.cid)?.rtc.addCandidate(msg.candidate, msg.mid);
        return;
      case 'bye':
        // Before DTLS the browser gave up; after it, the connection is the gateway's to close.
        if (this.peers.get(msg.cid)?.setup) this.drop(msg.cid);
        return;
      case 'revoke':
        this.opts.gateway.revoke(msg);
        return;
      case 'error':
        // A refused hello (`ticket`) is tried again later with a fresh ticket.
        if (msg.code === 'ticket') this.ws?.close();
        return;
      case 'answer':
        return;
    }
  }

  private connectPeer(cid: string, iceServers: IceServer[]) {
    if (this.peers.has(cid)) return;
    if (this.peers.size >= (this.opts.maxConnections ?? MAX_CONNECTIONS)) return this.send({ t: 'bye', cid });
    const rtc = this.opts.rtc({ iceServers });
    const setup = setTimeout(() => this.drop(cid), SETUP_TIMEOUT_MS);
    this.peers.set(cid, { rtc, setup });
    rtc.onCandidate((candidate, mid) => this.send({ t: 'ice', cid, candidate, mid }));
    rtc.onConnected(() => {
      const p = this.peers.get(cid);
      if (!p?.setup) return;
      clearTimeout(p.setup);
      p.setup = null;
      this.opts.gateway.accept(rtc);
    });
    rtc.onClose(() => {
      const p = this.peers.get(cid);
      if (p?.rtc !== rtc) return;
      if (p.setup) clearTimeout(p.setup);
      this.peers.delete(cid);
    });
  }

  private drop(cid: string) {
    const p = this.peers.get(cid);
    if (!p) return;
    if (p.setup) clearTimeout(p.setup);
    this.peers.delete(cid);
    p.rtc.close();
    this.send({ t: 'bye', cid });
  }
}
