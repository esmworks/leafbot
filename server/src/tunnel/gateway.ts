import { randomBytes } from 'node:crypto';
import {
  request,
  type ClientRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type Server,
} from 'node:http';
import type { Duplex } from 'node:stream';
import { TICKET_REFRESH_S, type TicketClaims } from '@leafbot/shared/account';
import {
  ACK_STEP,
  BUFFER_HIGH,
  CHANNEL,
  CtlToServer,
  decodeAck,
  decodeFrame,
  droppedRequestHeader,
  DROPPED_RESPONSE_HEADERS,
  encodeAck,
  encodeFrame,
  FRAME,
  MAX_FRAME_PAYLOAD,
  MAX_RT_CHANNELS,
  MAX_STREAMS,
  RequestHead,
  STREAM_WINDOW,
  type CtlToClient,
  type ResponseHead,
  type TunnelDenial,
} from '@leafbot/shared/tunnel';
import { WebSocket } from 'ws';
import { connectInProcess, type TunnelIdentity } from './identity';
import { checkProof, TunnelRefusal, type TicketChecker } from './ticket';

/** One data channel, whatever WebRTC library carries it. */
export interface TunnelChannel {
  readonly label: string;
  /** Bytes queued in the channel and not yet sent. */
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(): void;
  onMessage(cb: (data: string | Uint8Array) => void): void;
  onClose(cb: () => void): void;
  /** Called when the queue has drained below `BUFFER_LOW`. */
  onDrain(cb: () => void): void;
}

/** One browser's WebRTC connection, once DTLS is up. */
export interface TunnelPeer {
  /** This server's DTLS certificate fingerprint. */
  readonly localFingerprint: string;
  /** The browser's DTLS certificate fingerprint. */
  readonly remoteFingerprint: string;
  onChannel(cb: (ch: TunnelChannel) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

export interface GatewayOptions {
  /** The HTTP server the app (Fastify and Socket.IO) runs on; requests are handed to it in-process. */
  server: Server;
  checker: TicketChecker;
  /** The person on this server the ticket's account is linked to, or null when it has no access here. */
  resolve(claims: TicketClaims): Promise<{ userId: string } | null>;
  /** The Host header tunnelled requests carry: the address the browser loaded the app from. */
  host: string;
  /** How long a proof holds before a fresh ticket is due, in seconds. */
  refreshS?: number;
}

/** Messages a Socket.IO channel holds while its connection into the server opens. */
const MAX_EARLY_MESSAGES = 64;

const send = (ch: TunnelChannel, msg: CtlToClient) => ch.send(JSON.stringify(msg));
const nonce = () => randomBytes(24).toString('base64url');

/**
 * Serves browsers that reach this server over WebRTC. Each connection proves on `ctl` who it is;
 * its requests and Socket.IO connections then reach the app through sockets that exist only in
 * this process, tagged with that person, so the app needs no cookie and trusts no header for it.
 */
export class TunnelGateway {
  private sessions = new Set<TunnelSession>();

  constructor(private opts: GatewayOptions) {}

  get size() {
    return this.sessions.size;
  }

  /** Takes over a browser's connection. */
  accept(peer: TunnelPeer): void {
    const s = new TunnelSession(peer, this.opts, () => this.sessions.delete(s));
    this.sessions.add(s);
  }

  /**
   * The account service took access away: tickets signed before `epoch` stop working, and the
   * matching connections (one person's, one sign-in session's, or all) close now.
   */
  revoke(ev: { epoch: number; userId?: string | undefined; sessionId?: string | undefined }): void {
    this.opts.checker.raiseEpoch(ev.epoch);
    for (const s of [...this.sessions]) {
      const id = s.identity;
      if (!id) continue;
      if (ev.userId && id.accountUserId !== ev.userId) continue;
      if (ev.sessionId && id.sessionId !== ev.sessionId) continue;
      s.end('revoked');
    }
  }

  /** A person was removed or disabled on this server: their connections close. */
  dropUser(userId: string): void {
    for (const s of [...this.sessions]) if (s.identity?.userId === userId) s.end('access');
  }

  close(): void {
    for (const s of [...this.sessions]) s.end('expired');
  }
}

class TunnelSession {
  identity: TunnelIdentity | null = null;
  private readonly id = randomBytes(12).toString('base64url');
  private ctl: TunnelChannel | null = null;
  private nonce = nonce();
  private refresh: NodeJS.Timeout | null = null;
  /** Proofs are checked one at a time, in the order they came. */
  private checking: Promise<void> = Promise.resolve();
  private rt = 0;
  private http: HttpStreams | null = null;
  /** Everything opened for this connection, closed with it. */
  private owned = new Set<{ destroy(): void }>();
  private over = false;

  constructor(
    private peer: TunnelPeer,
    private opts: GatewayOptions,
    private onEnd: () => void,
  ) {
    peer.onChannel((ch) => this.channel(ch));
    peer.onClose(() => this.end(null));
    // A browser that does not prove who it is within a ticket's life is let go.
    this.refresh = setTimeout(() => this.end('expired'), 60_000);
  }

  private channel(ch: TunnelChannel) {
    if (this.over) return ch.close();
    if (ch.label === CHANNEL.ctl && !this.ctl) {
      this.ctl = ch;
      ch.onMessage((m) => {
        this.checking = this.checking.then(() => this.auth(m));
      });
      ch.onClose(() => this.end(null));
      send(ch, { t: 'challenge', nonce: this.nonce });
      return;
    }
    // Nothing but `ctl` is served before the browser has proven who it is.
    const id = this.identity;
    if (!id) return ch.close();
    if (ch.label === CHANNEL.rt && this.rt < MAX_RT_CHANNELS) return this.realtime(ch);
    if (ch.label === CHANNEL.http && !this.http) {
      this.http = new HttpStreams(ch, this.opts.host, () => this.connect());
      this.owned.add(this.http);
      return;
    }
    ch.close();
  }

  private async auth(raw: string | Uint8Array) {
    if (this.over || !this.ctl) return;
    try {
      let msg: CtlToServer;
      try {
        msg = CtlToServer.parse(JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)));
      } catch {
        throw new TunnelRefusal('ticket');
      }
      const claims = await this.opts.checker.check(msg.ticket);
      checkProof({
        claims,
        ticket: msg.ticket,
        key: msg.key,
        sig: msg.sig,
        clientFingerprint: this.peer.remoteFingerprint,
        serverFingerprint: this.peer.localFingerprint,
        nonce: this.nonce,
      });
      // A fresh ticket keeps the connection going; it cannot turn it into someone else's.
      const was = this.identity;
      if (was && (was.accountUserId !== claims.sub || was.sessionId !== claims.sid))
        throw new TunnelRefusal('ticket');
      const local = await this.opts.resolve(claims);
      if (!local) throw new TunnelRefusal('access');
      if (was && was.userId !== local.userId) throw new TunnelRefusal('access');
      if (this.over) return;
      this.identity ??= {
        userId: local.userId,
        accountUserId: claims.sub,
        sessionId: claims.sid,
        connection: this.id,
      };
      this.nonce = nonce();
      const refreshIn = this.opts.refreshS ?? TICKET_REFRESH_S;
      if (this.refresh) clearTimeout(this.refresh);
      this.refresh = setTimeout(() => this.end('expired'), refreshIn * 1000);
      send(this.ctl, { t: 'ok', refreshIn });
      send(this.ctl, { t: 'challenge', nonce: this.nonce });
    } catch (err) {
      this.end(err instanceof TunnelRefusal ? err.code : 'ticket');
    }
  }

  /** A new socket into the app, tagged with this connection's person. */
  private connect(): Duplex {
    const d = connectInProcess(this.opts.server, this.identity!);
    this.owned.add(d);
    d.once('close', () => this.owned.delete(d));
    return d;
  }

  /** One Socket.IO connection: each channel message is one WebSocket message, both ways. */
  private realtime(ch: TunnelChannel) {
    this.rt++;
    const ws = new WebSocket(`ws://${this.opts.host}/socket.io/?EIO=4&transport=websocket`, {
      createConnection: (() => this.connect()) as never,
      perMessageDeflate: false,
    });
    const handle = { destroy: () => ws.terminate() };
    this.owned.add(handle);
    const early: (string | Uint8Array)[] = [];
    ws.on('open', () => {
      for (const m of early.splice(0)) ws.send(m);
    });
    ws.on('message', (data: Buffer, isBinary) => {
      ch.send(
        isBinary ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : data.toString('utf8'),
      );
      if (ch.bufferedAmount >= BUFFER_HIGH) ws.pause();
    });
    ch.onDrain(() => ws.resume());
    ch.onMessage((m) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(m);
      else if (ws.readyState === WebSocket.CONNECTING && early.length < MAX_EARLY_MESSAGES) early.push(m);
      else ch.close();
    });
    let closed = false;
    const done = () => {
      if (closed) return;
      closed = true;
      this.owned.delete(handle);
      this.rt = Math.max(0, this.rt - 1);
      ws.terminate();
      ch.close();
    };
    ws.on('close', done);
    ws.on('error', done);
    ch.onClose(done);
  }

  /** Closes the connection and everything opened for it; `code` tells the browser why. */
  end(code: TunnelDenial | null) {
    if (this.over) return;
    this.over = true;
    if (this.refresh) clearTimeout(this.refresh);
    if (code && this.ctl) {
      try {
        send(this.ctl, { t: 'denied', code });
      } catch {
        // The channel is already gone.
      }
    }
    for (const o of [...this.owned]) o.destroy();
    this.owned.clear();
    this.peer.close();
    this.onEnd();
  }
}

interface Stream {
  req: ClientRequest;
  res: IncomingMessage | null;
  /** Response bytes sent and not yet reported used by the browser. */
  inflight: number;
  /** Request body bytes that arrived, and how many were reported written. */
  received: number;
  acked: number;
  written: number;
  /** Response bytes read from the app and not yet sent, held while the window is full. */
  queue: Buffer[];
  ended: boolean;
  done: boolean;
}

/** Requests over the `http` channel, each a numbered stream, each handed to the app as a real request. */
class HttpStreams {
  private streams = new Map<number, Stream>();
  private over = false;

  constructor(
    private ch: TunnelChannel,
    private host: string,
    private connect: () => Duplex,
  ) {
    ch.onMessage((m) => {
      if (typeof m !== 'string') this.frame(m);
    });
    ch.onDrain(() => {
      for (const [id, s] of this.streams) this.resume(id, s);
    });
    ch.onClose(() => this.destroy());
  }

  private out(type: (typeof FRAME)[keyof typeof FRAME], id: number, payload?: Uint8Array) {
    if (!this.over) this.ch.send(encodeFrame(type, id, payload));
  }

  private reset(id: number) {
    const s = this.streams.get(id);
    this.streams.delete(id);
    if (s) {
      s.done = true;
      s.req.destroy();
      s.res?.destroy();
    }
    this.out(FRAME.RESET, id);
  }

  private frame(data: Uint8Array) {
    const f = decodeFrame(data);
    if (!f) return;
    const s = this.streams.get(f.stream);
    switch (f.type) {
      case FRAME.REQUEST:
        if (s || this.streams.size >= MAX_STREAMS) return this.reset(f.stream);
        return this.open(f.stream, f.payload);
      case FRAME.DATA:
        if (!s) return;
        s.received += f.payload.byteLength;
        // The browser may not send more than the window ahead of what was written.
        if (s.received - s.written > STREAM_WINDOW + MAX_FRAME_PAYLOAD) return this.reset(f.stream);
        s.req.write(Buffer.from(f.payload), () => {
          s.written += f.payload.byteLength;
          const used = s.written - s.acked;
          if (used >= ACK_STEP || s.req.writableLength === 0) {
            s.acked = s.written;
            if (!s.done) this.out(FRAME.ACK, f.stream, encodeAck(used));
          }
        });
        return;
      case FRAME.END:
        s?.req.end();
        return;
      case FRAME.RESET:
        if (!s) return;
        this.streams.delete(f.stream);
        s.done = true;
        s.req.destroy();
        s.res?.destroy();
        return;
      case FRAME.ACK: {
        const n = decodeAck(f.payload);
        if (!s || n === null) return;
        s.inflight = Math.max(0, s.inflight - n);
        this.resume(f.stream, s);
        return;
      }
    }
  }

  private open(id: number, payload: Uint8Array) {
    let head: RequestHead;
    try {
      head = RequestHead.parse(JSON.parse(new TextDecoder().decode(payload)));
    } catch {
      return this.reset(id);
    }
    const headers: OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(head.headers))
      if (!droppedRequestHeader(k)) headers[k.toLowerCase()] = v;
    headers.host = this.host;
    if (head.length !== undefined) headers['content-length'] = String(head.length);
    else if (head.method !== 'GET' && head.method !== 'HEAD') headers['transfer-encoding'] = 'chunked';
    let req: ClientRequest;
    try {
      // Node writes the request line and headers itself and refuses CR/LF in any of them, so
      // nothing the page sends can add a header the checks above removed.
      req = request({
        method: head.method,
        path: head.path,
        headers,
        createConnection: () => this.connect(),
      });
    } catch {
      return this.reset(id);
    }
    const s: Stream = {
      req,
      res: null,
      inflight: 0,
      received: 0,
      acked: 0,
      written: 0,
      queue: [],
      ended: false,
      done: false,
    };
    this.streams.set(id, s);
    req.on('error', () => {
      if (!s.done) this.reset(id);
    });
    req.on('response', (res) => {
      s.res = res;
      const headers: ResponseHead['headers'] = {};
      for (const [k, v] of Object.entries(res.headers)) {
        if (v === undefined || (DROPPED_RESPONSE_HEADERS as readonly string[]).includes(k)) continue;
        headers[k] = v;
      }
      let json = JSON.stringify({ status: res.statusCode ?? 502, headers } satisfies ResponseHead);
      if (new TextEncoder().encode(json).byteLength > MAX_FRAME_PAYLOAD) {
        json = JSON.stringify({ status: 502, headers: {} } satisfies ResponseHead);
      }
      this.out(FRAME.RESPONSE, id, new TextEncoder().encode(json));
      res.on('data', (chunk: Buffer) => {
        if (s.done) return;
        s.queue.push(chunk);
        this.pump(id, s);
      });
      res.on('end', () => {
        s.ended = true;
        this.pump(id, s);
      });
      res.on('error', () => {
        if (!s.done) this.reset(id);
      });
    });
  }

  /**
   * Sends what the window allows, a frame at a time; the app's response is paused while anything
   * waits. The app may hand over megabytes in one chunk, so the window is kept here, not per chunk.
   */
  private pump(id: number, s: Stream) {
    while (!s.done && s.queue.length && s.inflight < STREAM_WINDOW && this.ch.bufferedAmount < BUFFER_HIGH) {
      const head = s.queue[0]!;
      const n = Math.min(head.length, MAX_FRAME_PAYLOAD, STREAM_WINDOW - s.inflight);
      this.out(FRAME.DATA, id, head.subarray(0, n));
      s.inflight += n;
      if (n === head.length) s.queue.shift();
      else s.queue[0] = head.subarray(n);
    }
    if (s.done) return;
    if (s.queue.length) return void s.res?.pause();
    if (s.ended) {
      s.done = true;
      this.streams.delete(id);
      this.out(FRAME.END, id);
      return;
    }
    s.res?.resume();
  }

  private resume(id: number, s: Stream) {
    this.pump(id, s);
  }

  destroy() {
    if (this.over) return;
    this.over = true;
    for (const s of this.streams.values()) {
      s.done = true;
      s.req.destroy();
      s.res?.destroy();
    }
    this.streams.clear();
    this.ch.close();
  }
}
