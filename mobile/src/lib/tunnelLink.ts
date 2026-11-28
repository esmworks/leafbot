import type { RawRequest, RtSocket, TunnelResponse } from '@leafbot/client/tunnel';
import { detailOf, passing, passingEnd, reasonOf, reconnectDelay } from './reconnect';

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
  | { at: 'retrying'; reason: string; detail?: string }
  | { at: 'refused'; reason: string; detail?: string };

export interface LinkDeps {
  /** Opens a tunnel; `onEnd` is called once when it ends after it opened. Rejects with why it could not. */
  open(onEnd: (code: string) => void): Promise<LiveTunnel>;
  sleep?(ms: number): Promise<void>;
  /** The clock, in ms; `Date.now` by default. */
  now?(): number;
}

/** A tunnel that stayed open this long counts as working, so the next attempt is quick again. */
const STEADY_MS = 30_000;

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
  private openedAt = 0;
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
    return this.next(waitMs);
  }

  /**
   * The tunnel to send a request on again after it failed on `stale`. Back from the background a
   * tunnel is often dead before the link has heard so, and the first request finds out: this waits
   * for the one opened after it. When the link still holds `stale` after `graceMs`, the request failed
   * and the tunnel did not, so it is `stale` again.
   */
  tunnelAfter(stale: LiveTunnel, waitMs = 20_000, graceMs = 1_500): Promise<LiveTunnel> {
    if (this.live && this.live !== stale) return Promise.resolve(this.live);
    return this.next(waitMs, () => (this.live === stale ? stale : null), graceMs);
  }

  /** The next tunnel to open within `waitMs`, or what `early` gives after `earlyMs`. */
  private next(waitMs: number, early?: () => LiveTunnel | null, earlyMs = 0): Promise<LiveTunnel> {
    if (this.state.at === 'refused' || this.state.at === 'idle')
      return Promise.reject(new NoTunnelError(this.state));
    return new Promise((done, fail) => {
      const timers: ReturnType<typeof setTimeout>[] = [];
      const leave = () => {
        for (const t of timers) clearTimeout(t);
        const i = this.waiting.indexOf(w);
        if (i >= 0) this.waiting.splice(i, 1);
      };
      const w = {
        done: (t: LiveTunnel) => {
          leave();
          done(t);
        },
        fail: (e: NoTunnelError) => {
          leave();
          fail(e);
        },
      };
      this.waiting.push(w);
      if (early) {
        timers.push(
          setTimeout(() => {
            const t = early();
            if (t) w.done(t);
          }, earlyMs),
        );
      }
      timers.push(setTimeout(() => w.fail(new NoTunnelError(this.state)), waitMs));
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

  private now(): number {
    return this.d.now ? this.d.now() : Date.now();
  }

  private openOnce(current: () => boolean): Promise<string> {
    return new Promise((ended, fail) => {
      this.d.open(ended).then((live) => {
        if (!current()) {
          live.close();
          return ended('closed');
        }
        this.live = live;
        this.openedAt = this.now();
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
        // It stayed open a while, so the next attempt is quick again. One that drops as soon as it
        // opens keeps backing off, or a server that takes and drops every tunnel would be tried
        // every second.
        if (this.now() - this.openedAt >= STEADY_MS) attempt = 0;
        if (!passingEnd(how)) {
          this.set({ at: 'refused', reason: how });
          return this.failWaiting();
        }
        this.set({ at: 'retrying', reason: how });
      } catch (err) {
        if (!current()) return;
        const reason = reasonOf(err);
        const detail = detailOf(err);
        const said = detail ? { detail } : {};
        if (!passing(err)) {
          this.set({ at: 'refused', reason, ...said });
          return this.failWaiting();
        }
        this.set({ at: 'retrying', reason, ...said });
      }
      await this.sleep(reconnectDelay(attempt++));
    }
  }
}
