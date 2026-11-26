import {
  SignalClose,
  SignalOutbound,
  type IceCandidate,
  type IceServer,
  type SignalInbound,
} from '@leafbot/shared/signal';
import type { z } from 'zod';
import { WebSocket } from 'ws';
import type { TunnelGateway, TunnelPeer } from './gateway';

/** A browser's ICE candidate as it travels through the relay; null means it has no more. */
export type Candidate = z.infer<typeof IceCandidate>;

/**
 * A WebRTC connection on the server's side, whatever library makes it. The browser offers; the
 * server answers.
 */
export interface RtcConnection extends TunnelPeer {
  /** Takes the browser's offer (the first, or one restarting ICE) and returns the answer. */
  answer(offerSdp: string): Promise<string>;
  addCandidate(candidate: Candidate): void;
  /** Candidates found on this side, to send to the browser; null once there are no more. */
  onCandidate(cb: (candidate: Candidate) => void): void;
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
  /** Unix seconds. */
  now?: () => number;
  /** Opens the WebSocket; tests pass their own. */
  connect?(url: string): WebSocket;
}

const MIN_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;
/** A connection that does not reach DTLS in this long is given up. */
const SETUP_TIMEOUT_MS = 30_000;
const MAX_CONNECTIONS = 32;
/** A fresh ticket goes to the relay once this share of its window has passed. */
const REFRESH_AT = 0.6;

/** Closes after which the resume token is of no use and the next hello needs a fresh ticket. */
const FRESH_TICKET = new Set<number>([
  SignalClose.ticketInvalid,
  SignalClose.ticketReplayed,
  SignalClose.revoked,
  SignalClose.timeout,
]);

/**
 * Keeps the server reachable through the relay: one outgoing WebSocket, opened again with growing
 * pauses when it drops, over which browsers' offers arrive and answers go back. Once a browser's
 * connection is up it belongs to the gateway; the relay sees nothing of it but the setup.
 */
export class SignalClient {
  private ws: WebSocket | null = null;
  private retry = MIN_RETRY_MS;
  private timer: NodeJS.Timeout | null = null;
  private refreshTimer: NodeJS.Timeout | null = null;
  private stopped = true;
  private resume: string | null = null;
  private iceServers: IceServer[] = [];
  private peers = new Map<string, { rtc: RtcConnection; setup: NodeJS.Timeout | null }>();

  constructor(private opts: SignalOptions) {}

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    void this.open();
  }

  stop() {
    this.stopped = true;
    for (const t of [this.timer, this.refreshTimer]) if (t) clearTimeout(t);
    this.timer = this.refreshTimer = null;
    this.ws?.terminate();
    this.ws = null;
    for (const cid of [...this.peers.keys()]) this.drop(cid);
  }

  /** Connections being set up or open. */
  get size() {
    return this.peers.size;
  }

  private now() {
    return this.opts.now?.() ?? Math.floor(Date.now() / 1000);
  }

  private async open() {
    if (this.stopped) return;
    // A brief drop continues with the resume token; otherwise a fresh ticket proves who this is.
    let hello: SignalInbound;
    if (this.resume) hello = { type: 'hello', role: 'host', resume: this.resume };
    else {
      try {
        hello = { type: 'hello', role: 'host', ticket: await this.opts.hostTicket() };
      } catch {
        return this.later();
      }
    }
    if (this.stopped) return;
    const ws =
      this.opts.connect?.(this.opts.url) ?? new WebSocket(this.opts.url, { perMessageDeflate: false });
    this.ws = ws;
    ws.on('open', () => this.send(hello));
    ws.on('message', (data: Buffer, isBinary) => {
      if (isBinary) return;
      let msg: SignalOutbound;
      try {
        msg = SignalOutbound.parse(JSON.parse(data.toString('utf8')));
      } catch {
        return;
      }
      void this.handle(msg);
    });
    const lost = (code?: number) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.refreshTimer) clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
      if (code === undefined || FRESH_TICKET.has(code)) this.resume = null;
      // Another socket of this server took over: stay away longer rather than take it back.
      if (code === SignalClose.replaced) this.retry = MAX_RETRY_MS;
      // Open browser connections do not need the relay any more and stay; only setups are lost.
      for (const [cid, p] of this.peers) if (p.setup) this.drop(cid);
      this.later();
    };
    ws.on('close', (code: number) => lost(code));
    ws.on('error', () => lost());
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

  private send(msg: SignalInbound) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /** Sends a fresh ticket before the relay's window for this socket ends. */
  private scheduleRefresh(until: number) {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    const ms = Math.max(1_000, (until - this.now()) * 1000 * REFRESH_AT);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.opts.hostTicket().then(
        (ticket) => this.send({ type: 'refresh', ticket }),
        // Without a fresh ticket the relay closes the socket at the window's end and it opens again.
        () => this.scheduleRefresh(this.now() + 10),
      );
    }, ms);
  }

  private async handle(msg: SignalOutbound) {
    switch (msg.type) {
      case 'welcome':
        this.retry = MIN_RETRY_MS;
        this.resume = msg.resumeToken;
        this.iceServers = msg.iceServers;
        this.scheduleRefresh(msg.resumeExpiresAt);
        return;
      case 'resume-token':
        this.resume = msg.resumeToken;
        this.scheduleRefresh(msg.expiresAt);
        return;
      case 'ice-servers':
        this.iceServers = msg.iceServers;
        return;
      case 'offer': {
        const cid = msg.connectionId;
        if (!cid) return;
        const p = this.peers.get(cid) ?? this.connectPeer(cid);
        if (!p) return this.send({ type: 'bye', connectionId: cid, reason: 'busy' });
        try {
          const sdp = await p.rtc.answer(msg.sdp);
          this.send({ type: 'answer', connectionId: cid, sdp });
        } catch {
          this.drop(cid);
        }
        return;
      }
      case 'ice-candidate':
        if (msg.connectionId) this.peers.get(msg.connectionId)?.rtc.addCandidate(msg.candidate);
        return;
      case 'bye':
        // Before DTLS the browser gave up; after it, the connection is the gateway's to close.
        if (msg.connectionId && this.peers.get(msg.connectionId)?.setup) this.drop(msg.connectionId, false);
        return;
      // The browser's signalling socket coming and going does not touch its WebRTC connection;
      // an ICE restart arrives as a new offer.
      case 'peer-joined':
      case 'peer-left':
      case 'ice-restart':
      case 'host-online':
      case 'host-offline':
      case 'answer':
      case 'error':
        return;
    }
  }

  private connectPeer(cid: string) {
    if (this.peers.size >= (this.opts.maxConnections ?? MAX_CONNECTIONS)) return null;
    const rtc = this.opts.rtc({ iceServers: this.iceServers });
    const setup = setTimeout(() => this.drop(cid), SETUP_TIMEOUT_MS);
    const p = { rtc, setup: setup as NodeJS.Timeout | null };
    this.peers.set(cid, p);
    rtc.onCandidate((candidate) => this.send({ type: 'ice-candidate', connectionId: cid, candidate }));
    rtc.onConnected(() => {
      if (this.peers.get(cid) !== p || !p.setup) return;
      clearTimeout(p.setup);
      p.setup = null;
      this.opts.gateway.accept(rtc);
    });
    rtc.onClose(() => {
      if (this.peers.get(cid) !== p) return;
      if (p.setup) clearTimeout(p.setup);
      this.peers.delete(cid);
    });
    return p;
  }

  private drop(cid: string, tell = true) {
    const p = this.peers.get(cid);
    if (!p) return;
    if (p.setup) clearTimeout(p.setup);
    this.peers.delete(cid);
    p.rtc.close();
    if (tell) this.send({ type: 'bye', connectionId: cid });
  }
}
