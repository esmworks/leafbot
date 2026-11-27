import type { RawRequest, RtSocket, TunnelResponse } from '@leafbot/client/tunnel';
import { passing, passingEnd, reasonOf, reconnectDelay } from './reconnect';

/** What the app needs of an open tunnel. */
export interface LiveTunnel {
  request(path: string, init?: RawRequest): Promise<TunnelResponse>;
  realtime(): RtSocket;
  close(): void;
}

/**
 * Where the link to the chosen server stands: opening it, open, waiting to try again after a
 * passing fault (`reason` says which: `offline` is the server not being at the relay), or refused
 * for a reason trying again would not change.
 */
export type LinkState =
  | { at: 'idle' }
  | { at: 'connecting' }
  | { at: 'online' }
  | { at: 'retrying'; reason: string }
  | { at: 'refused'; reason: string };

export interface LinkDeps {
  /** Opens a tunnel; `onEnd` is called once when it ends after it opened. Rejects with why it could not. */
  open(onEnd: (code: string) => void): Promise<LiveTunnel>;
  sleep?(ms: number): Promise<void>;
}

/** No tunnel was there, and none came, while a request waited for it. */
export class NoTunnelError extends Error {
  constructor(readonly state: LinkState) {
    super('no tunnel');
  }
}

/**
 * Keeps one tunnel to the chosen server open while started, and opens it again when it ends,
 * waiting longer after each failed attempt up to 30 seconds. A refusal stops it until something
 * changes (another sign-in, another server). `poke` skips the wait, as when the app comes back to
 * the front and the connection is likely gone.
 */
export class Link {
  state: LinkState = { at: 'idle' };
  private live: LiveTunnel | null = null;
  private listeners = new Set<() => void>();
  private round = 0;
  private wake: (() => void) | null = null;
  private waiting: { done: (t: LiveTunnel) => void; fail: (e: NoTunnelError) => void }[] = [];

  constructor(private d: LinkDeps) {}

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };

  private set(state: LinkState) {
    this.state = state;
    for (const fn of this.listeners) fn();
  }

  start() {
    if (this.state.at !== 'idle') return;
    this.set({ at: 'connecting' });
    void this.run(++this.round);
  }

  stop() {
    this.round++;
    this.wake?.();
    this.drop();
    this.set({ at: 'idle' });
    this.failWaiting();
  }

  /** Tries now instead of after the wait, and starts again after a refusal that may have passed. */
  poke() {
    if (this.state.at === 'refused') {
      this.set({ at: 'connecting' });
      void this.run(++this.round);
    } else this.wake?.();
  }

  /** The tunnel that is open right now, if any. */
  get open(): LiveTunnel | null {
    return this.live;
  }

  /** The open tunnel, or the next one if it comes within `waitMs`. */
  tunnel(waitMs = 20_000): Promise<LiveTunnel> {
    if (this.live) return Promise.resolve(this.live);
    if (this.state.at === 'refused' || this.state.at === 'idle')
      return Promise.reject(new NoTunnelError(this.state));
    return new Promise((done, fail) => {
      const w = { done, fail };
      this.waiting.push(w);
      setTimeout(() => {
        const i = this.waiting.indexOf(w);
        if (i >= 0) {
          this.waiting.splice(i, 1);
          fail(new NoTunnelError(this.state));
        }
      }, waitMs);
    });
  }

  private failWaiting() {
    for (const w of this.waiting.splice(0)) w.fail(new NoTunnelError(this.state));
  }

  private drop() {
    const live = this.live;
    this.live = null;
    live?.close();
  }

  private sleep(ms: number): Promise<void> {
    if (this.d.sleep) return this.d.sleep(ms);
    return new Promise((done) => {
      const timer = setTimeout(done, ms);
      this.wake = () => {
        clearTimeout(timer);
        done();
      };
    });
  }

  private openOnce(current: () => boolean): Promise<string> {
    return new Promise((ended, fail) => {
      this.d.open(ended).then((live) => {
        if (!current()) {
          live.close();
          return ended('closed');
        }
        this.live = live;
        this.set({ at: 'online' });
        for (const w of this.waiting.splice(0)) w.done(live);
      }, fail);
    });
  }

  private async run(round: number) {
    const current = () => this.round === round;
    let attempt = 0;
    while (current()) {
      try {
        const how = await this.openOnce(current);
        if (!current()) return;
        this.drop();
        // It was open, so the next attempt is quick again.
        attempt = 0;
        if (!passingEnd(how)) {
          this.set({ at: 'refused', reason: how });
          return this.failWaiting();
        }
        this.set({ at: 'retrying', reason: how });
      } catch (err) {
        if (!current()) return;
        const reason = reasonOf(err);
        if (!passing(err)) {
          this.set({ at: 'refused', reason });
          return this.failWaiting();
        }
        this.set({ at: 'retrying', reason });
      }
      await this.sleep(reconnectDelay(attempt++));
    }
  }
}
