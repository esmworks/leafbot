import {
  CHANNEL,
  CtlToClient,
  hostProofMessage,
  proofMessage,
  TUNNEL_MIN_VERSION,
  type CtlToServer,
  type TunnelDenial,
} from '@leafbot/shared/tunnel';
import type { Channel, Peer } from './channel';
import { randomB64url, verifyHost, type DeviceKey } from './device';
import { HttpStreams, tunnelFetch } from './http';
import { RtSocket } from './rt';

/**
 * Why a tunnel could not open or ended: the server's own refusal (`TunnelDenial`), its proof did not
 * match the key the ticket names (`host-proof`), it is too old for this web app (`outdated`), it did
 * not answer in time, or the connection went away.
 */
export type TunnelEndCode = TunnelDenial | 'host-proof' | 'outdated' | 'timeout' | 'closed';

export class TunnelError extends Error {
  constructor(readonly code: TunnelEndCode) {
    super(code);
  }
}

export interface TunnelOptions {
  peer: Peer;
  device: DeviceKey;
  /** A fresh client ticket for this server, bound to `device`; one per proof. */
  ticket(): Promise<string>;
  /** The server's Ed25519 public key as the account service handed it out with the ticket (`hkey`). */
  hostKey: string;
  /** The page's languages, so the server answers Socket.IO messages in them. */
  language?: string;
  /** How long the server has to answer, in ms. */
  answerMs?: number;
  /** Called once when the tunnel ends after it opened. */
  onEnd?: (code: TunnelEndCode) => void;
}

type Ok = Extract<CtlToClient, { t: 'ok' }>;

/** Reads `ctl` messages in order; a malformed one counts as the connection closing. */
class CtlReader {
  private queue: CtlToClient[] = [];
  private waiters: { ok: (m: CtlToClient) => void; fail: (e: TunnelError) => void }[] = [];
  private failed: TunnelError | null = null;
  /** Called with a `denied`, or a failure, that arrived while nobody waited for a message. */
  onIdleEnd: ((code: TunnelEndCode) => void) | null = null;

  constructor(ch: Channel) {
    ch.onMessage((raw) => {
      let msg: CtlToClient;
      try {
        msg = CtlToClient.parse(JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)));
      } catch {
        return this.fail(new TunnelError('closed'));
      }
      const w = this.waiters.shift();
      if (w) return w.ok(msg);
      if (msg.t === 'denied' && this.onIdleEnd) return this.onIdleEnd(msg.code);
      this.queue.push(msg);
    });
    ch.onClose(() => this.fail(new TunnelError('closed')));
  }

  private fail(e: TunnelError) {
    if (this.failed) return;
    this.failed = e;
    const waiting = this.waiters.splice(0);
    for (const w of waiting) w.fail(e);
    if (!waiting.length) this.onIdleEnd?.(e.code);
  }

  next(timeoutMs: number): Promise<CtlToClient> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (this.failed) return Promise.reject(this.failed);
    return new Promise<CtlToClient>((ok, fail) => {
      const w = {
        ok: (m: CtlToClient) => {
          clearTimeout(timer);
          ok(m);
        },
        fail: (e: TunnelError) => {
          clearTimeout(timer);
          fail(e);
        },
      };
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        fail(new TunnelError('timeout'));
      }, timeoutMs);
      this.waiters.push(w);
    });
  }
}

/** One proof on `ctl`: a ticket signed over both fingerprints, then a check of the server's own proof. */
async function prove(
  opts: TunnelOptions,
  ctl: Channel,
  reader: CtlReader,
  nonce: string,
): Promise<{ ok: Ok; nonce: string }> {
  const answerMs = opts.answerMs ?? 15_000;
  const fps = {
    clientFingerprint: opts.peer.localFingerprint,
    serverFingerprint: opts.peer.remoteFingerprint,
  };
  const ticket = await opts.ticket();
  const cnonce = randomB64url();
  const msg: CtlToServer = {
    t: 'auth',
    ticket,
    key: opts.device.x,
    sig: await opts.device.sign(proofMessage({ ticket, ...fps, nonce })),
    cnonce,
    ...(opts.language ? { lang: opts.language } : {}),
  };
  try {
    ctl.send(JSON.stringify(msg));
  } catch {
    throw new TunnelError('closed');
  }
  const ok = await reader.next(answerMs);
  if (ok.t === 'denied') throw new TunnelError(ok.code);
  if (ok.t !== 'ok') throw new TunnelError('closed');
  // Nothing the server says counts until it proved it holds the key the ticket names.
  if (!(await verifyHost(opts.hostKey, hostProofMessage({ ...fps, cnonce }), ok.sig)))
    throw new TunnelError('host-proof');
  return { ok, nonce: await challenge(reader, answerMs) };
}

async function challenge(reader: CtlReader, answerMs: number): Promise<string> {
  const m = await reader.next(answerMs);
  if (m.t === 'denied') throw new TunnelError(m.code);
  if (m.t !== 'challenge') throw new TunnelError('closed');
  return m.nonce;
}

/**
 * A proven connection to one server. Opening it proves this browser holds the device key the
 * ticket names, and checks that the other end holds the server key the ticket names, over both
 * DTLS fingerprints, before anything else is sent. It proves itself again with a fresh ticket
 * before the server's deadline, for as long as it is open.
 */
export class Tunnel {
  private http: Promise<HttpStreams> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private over = false;
  private reproving = false;

  private constructor(
    private opts: TunnelOptions,
    private ctl: Channel,
    private reader: CtlReader,
    /** The server's latest challenge: what the next proof signs. */
    private nonce: string,
    /** The server's tunnel version. */
    readonly version: number,
    /** The parts of the app the server offers. */
    readonly features: ReadonlySet<string>,
  ) {
    reader.onIdleEnd = (code) => this.end(code);
    opts.peer.onClose(() => this.end('closed'));
  }

  static async open(opts: TunnelOptions): Promise<Tunnel> {
    try {
      const ctl = await opts.peer.open(CHANNEL.ctl);
      const reader = new CtlReader(ctl);
      const first = await challenge(reader, opts.answerMs ?? 15_000);
      const { ok, nonce } = await prove(opts, ctl, reader, first);
      const version = ok.v ?? 0;
      if (version < TUNNEL_MIN_VERSION) throw new TunnelError('outdated');
      const t = new Tunnel(opts, ctl, reader, nonce, version, new Set(ok.features ?? []));
      t.schedule(ok.refreshIn);
      return t;
    } catch (err) {
      opts.peer.close();
      throw err instanceof TunnelError ? err : new TunnelError('closed');
    }
  }

  get closed() {
    return this.over;
  }

  has(feature: string): boolean {
    return this.features.has(feature);
  }

  /** Proves itself again well before the server's deadline, leaving time for a slow ticket. */
  private schedule(refreshIn: number) {
    if (this.over) return;
    const ms = Math.max(1, refreshIn * 1000 * 0.75);
    this.timer = setTimeout(() => void this.reprove(), ms);
  }

  private async reprove() {
    if (this.over || this.reproving) return;
    this.reproving = true;
    this.reader.onIdleEnd = null;
    try {
      const { ok, nonce } = await prove(this.opts, this.ctl, this.reader, this.nonce);
      this.nonce = nonce;
      this.reader.onIdleEnd = (code) => this.end(code);
      this.schedule(ok.refreshIn);
    } catch (err) {
      this.end(err instanceof TunnelError ? err.code : 'closed');
    } finally {
      this.reproving = false;
    }
  }

  private streams(): Promise<HttpStreams> {
    if (this.over) return Promise.reject(new TunnelError('closed'));
    const current = this.http;
    if (current) {
      return current.then((h) => {
        if (!h.closed) return h;
        this.http = null;
        return this.streams();
      });
    }
    const opening = this.opts.peer.open(CHANNEL.http).then((ch) => new HttpStreams(ch));
    this.http = opening;
    opening.catch(() => {
      if (this.http === opening) this.http = null;
    });
    return opening;
  }

  /** A request to a path on the server, answered over the tunnel. */
  fetch(path: string, init?: RequestInit): Promise<Response> {
    return tunnelFetch(() => this.streams(), path, init);
  }

  /** A new Socket.IO connection, shaped like a WebSocket, on a channel of its own. */
  realtime(): RtSocket {
    return new RtSocket(() =>
      this.over ? Promise.reject(new TunnelError('closed')) : this.opts.peer.open(CHANNEL.rt),
    );
  }

  close() {
    this.end('closed');
  }

  private end(code: TunnelEndCode) {
    if (this.over) return;
    this.over = true;
    if (this.timer) clearTimeout(this.timer);
    void this.http?.then((h) => h.destroy()).catch(() => {});
    this.opts.peer.close();
    this.opts.onEnd?.(code);
  }
}
