import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  MAC_ASK_MS,
  MAC_EVENT,
  MAC_NAMESPACE,
  MAC_TOUCHES,
  type MacDriver,
  MacRequest,
  type MacShot,
} from '@leafbot/shared/mac';
import { io, type Socket } from 'socket.io-client';

/**
 * This Mac offered to the bots of a server elsewhere. The server sends requests over a socket;
 * everything that decides what reaches the Mac lives here, in the app's own process, because the
 * page in the window and the cards in it come from that server.
 */

/** A use the person allowed ends after this long without a step, as a bot's hold on the Mac does. */
export const MAC_IDLE_MS = 2 * 60_000;
/** And after this long in all, however busy: the Mac asks again. */
export const MAC_MAX_MS = 15 * 60_000;
/**
 * After a no, or Stop, the Mac answers no by itself for this long: a bot that tries again at once,
 * or a server that keeps asking, cannot fill the screen with the question.
 */
export const MAC_COOL_MS = 30_000;

export interface MacGateOptions {
  /** The helper that moves the mouse and types. */
  driver: MacDriver;
  /** Takes the screen's picture. */
  shot: MacShot;
  /**
   * Asks the person on this Mac whether `bot` may use it; true for a yes. Ended by `signal`, which
   * counts as a no.
   */
  ask(bot: string, signal: AbortSignal): Promise<boolean>;
  /** Told when a use starts or ends, for the menu bar to show it. */
  onChange?(active: boolean): void;
}

/**
 * What a request from the server may do on this Mac. Only the requests in `MacRequest` pass, within
 * its limits. A step that sees or touches the screen needs a use the person allowed here, asked
 * with `begin`; the server's own card cannot stand in for it.
 */
export class MacGate {
  private use: { startedAt: number; lastAt: number } | null = null;
  private asking: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastStepAt: number | null = null;
  private coolUntil = 0;

  constructor(private o: MacGateOptions) {}

  /** Whether a use the person allowed goes on now. */
  active(now = Date.now()): boolean {
    const u = this.use;
    if (!u) return false;
    if (now - u.lastAt < MAC_IDLE_MS && now - u.startedAt < MAC_MAX_MS) return true;
    this.end();
    return false;
  }

  /** The menu bar's Stop: ends the use now, and for a short while the Mac says no without asking. */
  stop() {
    this.coolUntil = Date.now() + MAC_COOL_MS;
    this.end();
  }

  /** Ends the use now: the next step asks again. */
  end() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.use) return;
    this.use = null;
    this.o.onChange?.(false);
  }

  /** Milliseconds since a bot last saw or touched the screen, or null if none has; for keeping it on. */
  idleMs(now = Date.now()): number | null {
    return this.lastStepAt === null ? null : Math.max(0, now - this.lastStepAt);
  }

  private touched(now: number) {
    if (!this.use) return;
    this.use.lastAt = now;
    this.lastStepAt = now;
    // Ends by itself when its time is up, so the menu bar stops showing it.
    if (this.timer) clearTimeout(this.timer);
    const left = Math.min(MAC_IDLE_MS - (now - this.use.lastAt), MAC_MAX_MS - (now - this.use.startedAt));
    this.timer = setTimeout(() => this.active(), Math.max(0, left) + 50);
    this.timer.unref?.();
  }

  private async begin(bot: string): Promise<Record<string, unknown>> {
    if (this.active()) {
      this.touched(Date.now());
      return { ok: true };
    }
    if (Date.now() < this.coolUntil) return { ok: false, error: 'refused' };
    // Two steps asking at once get the one question.
    this.asking ??= (async () => {
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), MAC_ASK_MS);
      try {
        const yes = await this.o.ask(bot, stop.signal);
        // An answer that comes once the time is up is no answer: the server has stopped waiting.
        return yes && !stop.signal.aborted;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
        stop.abort();
      }
    })();
    const yes = await this.asking.finally(() => {
      this.asking = null;
    });
    if (!yes) {
      this.coolUntil = Date.now() + MAC_COOL_MS;
      return { ok: false, error: 'refused' };
    }
    const now = Date.now();
    if (!this.use) {
      this.use = { startedAt: now, lastAt: now };
      this.o.onChange?.(true);
    }
    this.touched(now);
    return { ok: true };
  }

  /** Answers one request from the server. */
  async handle(raw: unknown): Promise<Record<string, unknown>> {
    const parsed = MacRequest.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'badRequest' };
    const req = parsed.data;
    if (req.op === 'begin') return this.begin(req.bot);
    if (MAC_TOUCHES.has(req.op)) {
      if (!this.active()) return { ok: false, error: 'refused' };
      this.touched(Date.now());
    }
    try {
      if (req.op === 'screenshot') return { ok: true, ...(await this.o.shot(req)) };
      return await this.o.driver.send(req);
    } catch {
      return { ok: false, error: 'failed' };
    } finally {
      if (MAC_TOUCHES.has(req.op)) this.touched(Date.now());
    }
  }

  close() {
    this.end();
    this.o.driver.close();
  }
}

export interface MacBridgeOptions extends MacGateOptions {
  /** The server's address. */
  url: string;
  /** The sign-in for the connection: the window's session cookie, else the access key. */
  headers(): Promise<Record<string, string>>;
  /** How this Mac is named on the server. */
  device: string;
  log(level: 'info' | 'warn', message: string): void;
}

/** Connects this Mac to the server and answers its requests through a `MacGate`, until stopped. */
export function startMacBridge(o: MacBridgeOptions): { gate: MacGate; stop(): void } {
  const gate = new MacGate(o);
  let stopped = false;
  const socket: Socket = io(`${o.url}${MAC_NAMESPACE}`, {
    path: '/socket.io',
    transports: ['websocket'],
    auth: { device: o.device },
    autoConnect: false,
    reconnectionDelay: 2_000,
    reconnectionDelayMax: 60_000,
  });
  const signIn = async () => {
    socket.io.opts.extraHeaders = await o.headers().catch(() => ({}));
  };
  socket.on('connect', () => o.log('info', 'mac: connected'));
  socket.on(MAC_EVENT, (req: unknown, ack: unknown) => {
    if (typeof ack !== 'function') return;
    void gate.handle(req).then((r) => (ack as (r: unknown) => void)(r));
  });
  socket.on('disconnect', (reason) => {
    // A use the person allowed belongs to this connection; a new one asks again.
    gate.end();
    o.log('info', `mac: disconnected (${reason})`);
  });
  socket.on('connect_error', (err) => {
    o.log('warn', `mac: ${err.message}`);
    void signIn();
  });
  void (async () => {
    await signIn();
    if (!stopped) socket.connect();
  })();
  return {
    gate,
    stop() {
      stopped = true;
      gate.close();
      socket.disconnect();
    },
  };
}

const SETTING_FILE = 'mac.json';

/** Whether the person lets the bots of the server this app connects to use this Mac; off until they say. */
export function readMacOn(dir: string): boolean {
  try {
    return (JSON.parse(readFileSync(join(dir, SETTING_FILE), 'utf8')) as { on?: unknown }).on === true;
  } catch {
    return false;
  }
}

export function writeMacOn(dir: string, on: boolean) {
  writeFileSync(join(dir, SETTING_FILE), JSON.stringify({ on }), { mode: 0o600 });
}
