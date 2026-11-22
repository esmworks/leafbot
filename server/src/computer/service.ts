import type { ComputerState, DesktopStart } from '@leafbot/shared';
import { ComputerClient, ComputerError } from './client';

/** How long a desktop start is waited for: the computer service's own 90 s, and a few more. */
const START_WAIT_MS = 95_000;

interface Desk {
  status: ComputerState['status'];
  /** The socket whose person has the mouse and keyboard. */
  user: string | null;
  busy: number;
  lastUsed: number;
  starting: Promise<void> | null;
  /** A background command runs until about then; the desktop stays awake for it. */
  awakeUntil?: number;
  /** The GitHub key last given to the running desktop; undefined until one was given. */
  git?: string | null;
  /** The key handover in progress: one at a time, so two cannot cross. */
  gitSync?: Promise<void>;
  /** Whether the session's browser leaves through the service's own SOCKS, which refuses private
   * addresses itself; false while the desktop is off. */
  browserProxied: boolean;
}

export interface ComputerOptions {
  url: string;
  token: string;
  idleMs: number;
  /** Folders, language and home for a bot's desktop, worked out when it starts. */
  prepare(botId: string): Promise<DesktopStart>;
  /**
   * The GitHub key git on the bot's desktop may use, read again before each of its steps: the
   * team's; with `owner`, that person's own alone.
   */
  gitToken?(botId: string, owner?: string | null): Promise<string | null>;
}

/**
 * The bots' desktops on the computer service: started on first use or when a person wakes one,
 * put to sleep when nobody watches and the bot has left it alone for a while. While a person has
 * control, the bot's actions on it are refused.
 */
export class ComputerService {
  readonly client: ComputerClient;
  private desks = new Map<string, Desk>();
  private watchers = new Map<string, Set<string>>();
  private listeners = new Set<(s: ComputerState) => void>();
  private sweep: NodeJS.Timeout | null = null;

  constructor(private opts: ComputerOptions) {
    this.client = new ComputerClient(opts.url, opts.token);
  }

  on(l: (s: ComputerState) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  state(botId: string): ComputerState {
    const d = this.desks.get(botId);
    return { botId, status: d?.status ?? 'off', user: !!d?.user, busy: (d?.busy ?? 0) > 0 };
  }

  /** Whether a person has control of this bot's desktop right now. */
  userHasControl(botId: string): boolean {
    return !!this.desks.get(botId)?.user;
  }

  /**
   * Whether the session's browser leaves through the service's own SOCKS, which refuses private
   * addresses itself. The browser needs no second, per-request guard of its own then.
   */
  browserProxied(botId: string): boolean {
    return !!this.desks.get(botId)?.browserProxied;
  }

  /** Whether this socket's person is the one in control. */
  controlledBy(botId: string, socketId: string): boolean {
    return this.desks.get(botId)?.user === socketId;
  }

  watch(botId: string, socketId: string) {
    let set = this.watchers.get(botId);
    if (!set) this.watchers.set(botId, (set = new Set()));
    set.add(socketId);
  }

  unwatch(botId: string, socketId: string) {
    const set = this.watchers.get(botId);
    set?.delete(socketId);
    if (set?.size === 0) this.watchers.delete(botId);
    if (this.controlledBy(botId, socketId)) this.setControl(botId, socketId, false);
  }

  /** A socket went away: it stops watching and gives back control everywhere. */
  forget(socketId: string) {
    for (const botId of [...this.watchers.keys()]) this.unwatch(botId, socketId);
    for (const [botId, d] of this.desks) if (d.user === socketId) this.setControl(botId, socketId, false);
  }

  setControl(botId: string, socketId: string, on: boolean) {
    const d = this.desk(botId);
    if (on) d.user = socketId;
    else if (d.user === socketId) d.user = null;
    d.lastUsed = Date.now();
    this.emit(botId);
  }

  /** Starts the desktop if it is not running; several callers share one start. */
  async ensure(botId: string): Promise<void> {
    const d = this.desk(botId);
    if (d.status === 'running') return;
    if (!d.starting) {
      d.starting = (async () => {
        d.status = 'starting';
        d.git = undefined;
        this.emit(botId);
        try {
          let s = await this.start(botId, await this.opts.prepare(botId));
          // As long as the service itself gives a start, and a little more for its answer.
          const deadline = Date.now() + START_WAIT_MS;
          while (s.status === 'starting' && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 500));
            s = await this.client.status(botId);
          }
          if (s.status !== 'running') {
            const why = s.lastError ? `: ${s.lastError}` : '';
            throw new ComputerError('failed', `desktop did not start${why}`);
          }
          d.status = 'running';
          d.browserProxied = s.browserProxied;
          // Also for a desktop a person woke or the bot's browser started: git may run there first.
          await this.syncGit(botId, d).catch(() => undefined);
        } catch (err) {
          d.status = 'off';
          throw err;
        } finally {
          d.starting = null;
          d.lastUsed = Date.now();
          this.emit(botId);
          this.startSweep();
        }
      })();
    }
    return d.starting;
  }

  /**
   * Runs a bot action on its desktop, starting it if needed. Refused while a person has control;
   * a desktop that stopped on its own is started once more.
   */
  async use<T>(botId: string, fn: (client: ComputerClient) => Promise<T>): Promise<T> {
    if (this.userHasControl(botId)) throw new ComputerError('userControl');
    await this.ensure(botId);
    const d = this.desk(botId);
    d.busy++;
    this.emit(botId);
    try {
      try {
        await this.syncGit(botId, d);
        return await fn(this.client);
      } catch (err) {
        if (!(err instanceof ComputerError) || err.code !== 'notRunning') throw err;
        d.status = 'off';
        await this.ensure(botId);
        await this.syncGit(botId, d);
        return await fn(this.client);
      }
    } finally {
      d.busy--;
      d.lastUsed = Date.now();
      this.emit(botId);
    }
  }

  /**
   * Keeps the desktop awake for a command left running in the background, for at most `ms`; with
   * 0 (the command ended) it may sleep again once idle.
   */
  keepAwake(botId: string, ms: number) {
    const d = this.desk(botId);
    d.awakeUntil = ms > 0 ? Math.max(d.awakeUntil ?? 0, Date.now() + ms) : 0;
    d.lastUsed = Date.now();
  }

  /**
   * Marks the desktop as in use by something other than a bot tool (the bot's browser steps): it
   * is not put to sleep until the returned function is called.
   */
  hold(botId: string): () => void {
    const d = this.desk(botId);
    d.busy++;
    d.lastUsed = Date.now();
    this.emit(botId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      d.busy--;
      d.lastUsed = Date.now();
      this.emit(botId);
    };
  }

  /**
   * Takes over desktops that are already running on the service, e.g. after this server
   * restarted; otherwise they would hold their slots until the service itself restarts. They then
   * sleep like any other once idle.
   */
  async adopt() {
    const list = await this.client.list().catch(() => null);
    if (!list) return;
    for (const s of list) {
      if (s.status !== 'running') continue;
      const d = this.desk(s.id);
      if (d.status === 'running' || d.starting) continue;
      d.status = 'running';
      d.browserProxied = s.browserProxied;
      d.lastUsed = Date.now();
      this.emit(s.id);
    }
    if (list.length) this.startSweep();
  }

  async stop(botId: string) {
    const d = this.desks.get(botId);
    if (!d || d.status === 'off') return;
    await this.client.stop(botId).catch(() => {});
    d.status = 'off';
    d.user = null;
    this.emit(botId);
  }

  async shutdown() {
    if (this.sweep) clearInterval(this.sweep);
    this.sweep = null;
  }

  /**
   * Asks the service for a desktop. When it is full, the least recently used desktop that no bot
   * step, background command or person in control holds is put to sleep and the start is tried
   * again: a desktop left idle would otherwise keep another bot off its computer until it sleeps.
   * Unwatched desktops go before watched ones; a view left open does not keep a desktop for good.
   */
  private async start(botId: string, start: DesktopStart) {
    for (;;) {
      try {
        return await this.client.start(botId, start);
      } catch (err) {
        if (!(err instanceof ComputerError) || err.code !== 'full') throw err;
        const now = Date.now();
        const spare = [...this.desks]
          .filter(([id, d]) => id !== botId && d.status === 'running' && !d.busy && !d.user)
          .filter(([, d]) => now >= (d.awakeUntil ?? 0))
          .sort(
            ([a, x], [b, y]) =>
              Number(this.watchers.has(a)) - Number(this.watchers.has(b)) || x.lastUsed - y.lastUsed,
          )[0];
        if (!spare) throw err;
        await this.stop(spare[0]);
      }
    }
  }

  /**
   * The GitHub key a command brings for the person its step works for: their own key or GitHub
   * app. Undefined when they have none, and the command's git uses the desktop's (the team's).
   */
  async personGit(botId: string, userId: string): Promise<{ token: string } | undefined> {
    if (!this.opts.gitToken) return undefined;
    try {
      const token = await this.opts.gitToken(botId, userId);
      return token ? { token } : undefined;
    } catch (err) {
      console.warn('computer git key', err instanceof Error ? err.message : err);
      return undefined;
    }
  }

  /** A GitHub key was added, changed or removed: every running desktop gets its bot's key now. */
  async refreshGit() {
    for (const [botId, d] of this.desks) {
      if (d.status === 'running') await this.syncGit(botId, d).catch(() => undefined);
    }
  }

  /**
   * Gives the desktop the bot's GitHub key when it changed (a key added, replaced, removed or no
   * longer open to the bot), so a step sees the key as it is now. A failure leaves git without a
   * key; the step itself goes on.
   */
  private syncGit(botId: string, d: Desk): Promise<void> {
    const run = (d.gitSync ?? Promise.resolve()).then(() => this.giveGit(botId, d));
    d.gitSync = run.catch(() => undefined);
    return run;
  }

  private async giveGit(botId: string, d: Desk) {
    if (!this.opts.gitToken) return;
    try {
      const token = await this.opts.gitToken(botId);
      if (d.git === token) return;
      await this.client.git(botId, { token });
      d.git = token;
    } catch (err) {
      if (err instanceof ComputerError && err.code === 'notRunning') throw err;
      console.warn('computer git key', err instanceof Error ? err.message : err);
    }
  }

  private desk(botId: string): Desk {
    let d = this.desks.get(botId);
    if (!d) {
      d = { status: 'off', user: null, busy: 0, lastUsed: Date.now(), starting: null, browserProxied: false };
      this.desks.set(botId, d);
    }
    return d;
  }

  private emit(botId: string) {
    const s = this.state(botId);
    for (const l of this.listeners) l(s);
  }

  /** Every minute: idle desktops sleep; ones that stopped on the service side are marked off. */
  private startSweep() {
    if (this.sweep) return;
    this.sweep = setInterval(() => void this.tick(), 60_000);
    this.sweep.unref();
  }

  async tick(now = Date.now()) {
    for (const [botId, d] of this.desks) {
      if (d.status !== 'running') continue;
      const idle =
        !d.busy &&
        !d.user &&
        !this.watchers.has(botId) &&
        now >= (d.awakeUntil ?? 0) &&
        now - d.lastUsed >= this.opts.idleMs;
      if (idle) {
        await this.stop(botId);
        continue;
      }
      const s = await this.client.status(botId).catch(() => null);
      if (s && s.status === 'off') {
        d.status = 'off';
        d.user = null;
        this.emit(botId);
      }
    }
  }
}
