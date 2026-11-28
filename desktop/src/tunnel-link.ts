import { deviceKey, newDeviceKeyPair, Tunnel, TunnelError, type DeviceKey } from '@leafbot/client/tunnel';
import { ConnectError, connectPeer } from '@leafbot/client/webrtc';
import { createRequire } from 'node:module';
import type * as Polyfill from 'node-datachannel/polyfill';
import { AccountError, type AccountClient, type ServerEntry } from './account';
import type { Carrier, TunnelListener } from './tunnel-socket';

export { tunnelSocket, type Carrier, type TunnelListener } from './tunnel-socket';

/** The relay browsers and servers find each other through. */
export const RELAY_URL = 'wss://signal.leafbot.app/v1/signal';

/**
 * A fresh device key: Ed25519 in WebCrypto with a private half that cannot be exported. It lives for
 * one run of the app; each ticket names its thumbprint, so a ticket is of no use to anyone else.
 */
export async function newDevice(): Promise<DeviceKey> {
  return deviceKey(await newDeviceKeyPair());
}

/**
 * WebRTC as Node has it: libdatachannel through node-datachannel, loaded when first needed so an
 * install without a native build for this system fails here and not at start. It is loaded with
 * `require` from the app's own file, the way Node loads a native module, and kept out of the bundle.
 */
export async function nodeRtc() {
  const { RTCPeerConnection } = createRequire(__filename)('node-datachannel/polyfill') as typeof Polyfill;
  return {
    RTCPeerConnection: RTCPeerConnection as unknown as typeof globalThis.RTCPeerConnection,
    WebSocket: globalThis.WebSocket,
  };
}

export interface OpenDeps {
  account: AccountClient;
  device: DeviceKey;
  relayUrl: string;
  rtc: Awaited<ReturnType<typeof nodeRtc>>;
  /** The languages the server answers in. */
  language: string;
  onEnd(code: string): void;
}

/**
 * Opens a tunnel to one of the person's servers: tickets from the account service for this device
 * key, the WebRTC setup through the relay, then the proof both ways. The server must hold the key
 * the account service lists for it; a ticket naming another key is refused.
 */
export async function openServer(server: ServerEntry, d: OpenDeps): Promise<Tunnel> {
  const ticket = async () => {
    const t = await d.account.ticket(server.id, d.device.jkt);
    if (t.publicKey !== server.publicKey) throw new TunnelError('host-proof');
    return t.ticket;
  };
  const peer = await connectPeer({ relayUrl: d.relayUrl, ticket, rtc: d.rtc });
  return Tunnel.open({
    peer,
    device: d.device,
    ticket,
    hostKey: server.publicKey,
    language: d.language,
    onEnd: d.onEnd,
  });
}

/**
 * Ends a restart or a passing network fault explains: the connection went away, the server is not at
 * the relay while it restarts, the relay or the setup failed, or the server was busy. A refusal
 * (access taken away, a ticket the server will not take, a server too old, a key that does not
 * match) stays until the sign-in changes, so trying again would only hide it.
 */
const PASSING = new Set<string>(['closed', 'timeout', 'offline', 'relay', 'failed', 'busy']);

export function passing(err: unknown): boolean {
  if (err instanceof TunnelError || err instanceof ConnectError) return PASSING.has(err.code);
  // The account service out of reach, restarting or asking for fewer requests; any other 4xx is an
  // answer about this person.
  if (err instanceof AccountError)
    return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500;
  // Whatever else broke (WebRTC on this computer, say) is tried again later, as slowly as the rest.
  return true;
}

/** A tunnel that stayed open this long counts as working, so the next attempt is quick again. */
const STEADY_MS = 30_000;

/** Waits between attempts: quick at first, as a restart takes seconds, then no more than every 30 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

/** The tunnel a link keeps; `close` ends it. */
export interface Live extends Carrier {
  close(): void;
}

export interface LinkOptions {
  /** The account server to keep a tunnel to. */
  serverId: string;
  account: AccountClient;
  /** This app's session at the account service; null while signed out. */
  session(): Promise<string | null>;
  /** Opens a tunnel to a server; `onEnd` is called when it ends after it opened. */
  open(server: ServerEntry, onEnd: (code: string) => void): Promise<Live>;
  log(level: 'info' | 'warn', message: string): void;
}

/**
 * Keeps one tunnel to an account server open while started, for the offers made through it. It
 * opens again when the tunnel ends, waiting longer after each failed attempt, and does not give up
 * on a network that is down: this computer is offered whenever it can be. A refusal (the person
 * has no access any more, the server is gone from the account) stops it until the sign-in changes;
 * signing out stops it, and a different sign-in starts it again.
 */
export class ServerLink {
  private listeners = new Set<TunnelListener>();
  private live: Live | null = null;
  /** Bumps on every start, stop and change of sign-in, so an attempt that was overtaken opens nothing. */
  private round = 0;
  private running = false;
  /** The session the current run asked with; null while it found the person signed out. */
  private usedSession: string | null = null;
  private wake: (() => void) | null = null;

  constructor(private o: LinkOptions) {}

  /** Calls `fn` now with the tunnel in use, and again each time it changes; returns a way to stop. */
  subscribe(fn: TunnelListener): () => void {
    this.listeners.add(fn);
    fn(this.live);
    return () => this.listeners.delete(fn);
  }

  start() {
    if (this.running) return;
    this.running = true;
    void this.run(++this.round);
  }

  stop() {
    this.running = false;
    this.restart();
  }

  /**
   * The sign-in may have changed: the tunnel belongs to the person who asked for its ticket, so
   * another sign-in (or none) ends it, and a new one starts from the new sign-in.
   */
  async signInChanged() {
    if (!this.running) return;
    const now = await this.o.session().catch(() => null);
    if (!this.running || now === this.usedSession) return;
    this.restart();
    void this.run(++this.round);
  }

  private restart() {
    this.round++;
    this.wake?.();
    this.drop();
  }

  private drop() {
    const live = this.live;
    this.live = null;
    if (!live) return;
    live.close();
    for (const fn of this.listeners) fn(null);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((done) => {
      const timer = setTimeout(done, ms);
      this.wake = () => {
        clearTimeout(timer);
        done();
      };
    });
  }

  /** Opens a tunnel; resolves with how it ended, rejects with why it did not open. */
  private openOnce(server: ServerEntry, current: () => boolean): Promise<string> {
    return new Promise((done, fail) => {
      this.o.open(server, done).then((live) => {
        if (!current()) {
          live.close();
          return done('closed');
        }
        this.live = live;
        this.openedAt = Date.now();
        this.o.log('info', 'account: tunnel open');
        for (const fn of this.listeners) fn(live);
      }, fail);
    });
  }

  private openedAt = 0;

  private async run(round: number) {
    const current = () => this.running && this.round === round;
    let attempt = 0;
    while (current()) {
      try {
        const session = await this.o.session();
        this.usedSession = session;
        if (!session) {
          this.o.log('info', 'account: signed out; no tunnel until the person signs in');
          return;
        }
        const server = (await this.o.account.servers()).find((s) => s.id === this.o.serverId);
        if (!current()) return;
        if (!server) {
          this.o.log('warn', 'account: the chosen server is not in the account any more');
          return;
        }
        const how = await this.openOnce(server, current);
        if (!current()) return;
        this.drop();
        // One that drops as soon as it opens keeps backing off, or a server that takes and drops
        // every tunnel would cost the account a list and a ticket every second.
        if (Date.now() - this.openedAt >= STEADY_MS) attempt = 0;
        this.o.log('info', `account: tunnel ended (${how})`);
        if (!PASSING.has(how)) return;
      } catch (err) {
        if (!current()) return;
        this.o.log('warn', `account: ${err instanceof Error ? err.message : 'failed'}`);
        if (!passing(err)) return;
      }
      await this.sleep(reconnectDelay(attempt++));
    }
  }
}
