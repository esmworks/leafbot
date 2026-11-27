import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { locale, t } from './i18n';

/**
 * PATH with the usual places for tools a person installs themselves added at the end. An app
 * opened from the Finder or the Dock gets only the system folders, so Homebrew, `~/.local/bin`
 * and the like are missing and a bot's commands would not find tools that work in a terminal.
 */
export function fullPath(path: string | undefined, home: string, platform: NodeJS.Platform): string {
  if (platform === 'win32') return path ?? '';
  const parts = (path || '/usr/bin:/bin:/usr/sbin:/sbin').split(':').filter(Boolean);
  const extra = [
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/opt/homebrew/sbin'] : []),
    '/usr/local/bin',
    ...(home ? [`${home}/.local/bin`, `${home}/bin`, `${home}/.cargo/bin`] : []),
  ];
  for (const dir of extra) if (!parts.includes(dir)) parts.push(dir);
  return parts.join(':');
}

export interface ServerProcessOptions {
  /** Bundled server entry (index.mjs). */
  entry: string;
  /** Node runtime: Electron's own binary with ELECTRON_RUN_AS_NODE, or node in tests. */
  execPath: string;
  dataDir: string;
  appDir: string | null;
  /** Preferred port; falls back to a free port if taken. */
  port: number;
  env?: Record<string, string>;
  log?: (level: 'info' | 'warn' | 'error', line: string) => void;
  /** Starts the child; replaced in tests so no real process is needed. */
  spawn?: typeof spawn;
}

/** Why a start did not get as far as a ready server. */
export type StartFailure =
  { kind: 'exit'; code: number | null; signal: string | null; stderr: string } | { kind: 'timeout' };

/**
 * What the server process is doing. Each variant holds only what is true in it: the crashes a
 * running or restarting server has had, whether a start is the first one (a caller waits for it)
 * or a restart (nobody does), and what a stop interrupted.
 */
export type ServerState =
  /** Never started, or the first start failed. */
  | { kind: 'idle' }
  /** A child was spawned and has not printed its address. */
  | { kind: 'starting'; port: 'preferred' | 'free'; restart: boolean; crashes: number[] }
  | { kind: 'ready'; url: string; crashes: number[] }
  /** The child died; waiting before it is started again. */
  | { kind: 'backoff'; crashes: number[] }
  /** The child was told to stop; `during` is what that interrupted. */
  | { kind: 'stopping'; during: 'start' | 'restart' | 'ready' }
  /** Stopped on request; `start` may run again. */
  | { kind: 'stopped' }
  /** Too many crashes, or a restart failed; left alone until `start` is called again. */
  | { kind: 'gaveUp' };

export type ServerEvent =
  | { kind: 'start' }
  | { kind: 'ready'; url: string }
  | {
      kind: 'exit';
      code: number | null;
      signal: string | null;
      stderr: string;
      /** The preferred port was taken, so a free one is worth trying. */
      addrInUse: boolean;
      now: number;
    }
  | { kind: 'backoffElapsed' }
  | { kind: 'startTimeout' }
  | { kind: 'stop'; timeoutMs: number }
  | { kind: 'killTimeout' };

export type ServerEffect =
  | { kind: 'spawn'; port: 'preferred' | 'free' }
  /** `abandon` drops the child from the state at once, so its late exit is not heard. */
  | { kind: 'kill'; signal: 'SIGTERM' | 'SIGKILL'; abandon?: boolean }
  | { kind: 'armStartTimeout' }
  | { kind: 'armBackoff'; ms: number }
  | { kind: 'armKill'; ms: number }
  | { kind: 'resolveStart'; url: string }
  | { kind: 'rejectStart'; failure: StartFailure }
  | { kind: 'emit'; event: 'ready' | 'restarted'; url: string }
  | { kind: 'emit'; event: 'exit'; code: number | null; signal: string | null; expected: boolean }
  | { kind: 'giveUp'; reason: StartFailure | 'crashes' }
  | { kind: 'warn'; message: string };

/** The server may stop this many times within CRASH_WINDOW_MS before it is left alone. */
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 60_000;
export const START_TIMEOUT_MS = 60_000;

const begin = (restart: boolean, crashes: number[]) => ({
  state: { kind: 'starting', port: 'preferred', restart, crashes } as ServerState,
  effects: [{ kind: 'spawn', port: 'preferred' }, { kind: 'armStartTimeout' }] as ServerEffect[],
});

/** Pure: what a state does with an event, and what the caller must then do. Does no I/O. */
export function serverStep(
  state: ServerState,
  event: ServerEvent,
): { state: ServerState; effects: ServerEffect[] } {
  const same = { state, effects: [] as ServerEffect[] };
  switch (event.kind) {
    case 'start':
      return state.kind === 'idle' || state.kind === 'stopped' || state.kind === 'gaveUp'
        ? begin(false, [])
        : same;

    case 'ready': {
      if (state.kind !== 'starting') return same;
      const effects: ServerEffect[] = [
        { kind: 'resolveStart', url: event.url },
        { kind: 'emit', event: 'ready', url: event.url },
      ];
      if (state.restart) effects.push({ kind: 'emit', event: 'restarted', url: event.url });
      return { state: { kind: 'ready', url: event.url, crashes: state.crashes }, effects };
    }

    case 'exit': {
      if (state.kind === 'starting') {
        if (state.port === 'preferred' && event.addrInUse) {
          return {
            state: { ...state, port: 'free' },
            effects: [
              { kind: 'warn', message: 'the preferred port is in use; trying a free port' },
              { kind: 'spawn', port: 'free' },
              { kind: 'armStartTimeout' },
            ],
          };
        }
        const failure: StartFailure = {
          kind: 'exit',
          code: event.code,
          signal: event.signal,
          stderr: event.stderr,
        };
        return state.restart
          ? { state: { kind: 'gaveUp' }, effects: [{ kind: 'giveUp', reason: failure }] }
          : { state: { kind: 'idle' }, effects: [{ kind: 'rejectStart', failure }] };
      }
      if (state.kind === 'ready') {
        const crashes = [...state.crashes.filter((at) => event.now - at < CRASH_WINDOW_MS), event.now];
        const exited: ServerEffect = {
          kind: 'emit',
          event: 'exit',
          code: event.code,
          signal: event.signal,
          expected: false,
        };
        return crashes.length >= MAX_CRASHES
          ? { state: { kind: 'gaveUp' }, effects: [exited, { kind: 'giveUp', reason: 'crashes' }] }
          : {
              state: { kind: 'backoff', crashes },
              effects: [exited, { kind: 'armBackoff', ms: 500 * crashes.length }],
            };
      }
      if (state.kind === 'stopping') {
        const effects: ServerEffect[] =
          state.during === 'start'
            ? [
                {
                  kind: 'rejectStart',
                  failure: { kind: 'exit', code: event.code, signal: event.signal, stderr: event.stderr },
                },
              ]
            : state.during === 'ready'
              ? [{ kind: 'emit', event: 'exit', code: event.code, signal: event.signal, expected: true }]
              : [];
        return { state: { kind: 'stopped' }, effects };
      }
      return same;
    }

    case 'backoffElapsed':
      return state.kind === 'backoff' ? begin(true, state.crashes) : same;

    case 'startTimeout': {
      if (state.kind !== 'starting') return same;
      const kill: ServerEffect = { kind: 'kill', signal: 'SIGKILL', abandon: true };
      const failure: StartFailure = { kind: 'timeout' };
      return state.restart
        ? { state: { kind: 'gaveUp' }, effects: [kill, { kind: 'giveUp', reason: failure }] }
        : { state: { kind: 'idle' }, effects: [kill, { kind: 'rejectStart', failure }] };
    }

    case 'stop': {
      if (state.kind === 'stopping') return same;
      if (state.kind === 'starting' || state.kind === 'ready') {
        const during = state.kind === 'ready' ? 'ready' : state.restart ? 'restart' : 'start';
        return {
          state: { kind: 'stopping', during },
          effects: [
            { kind: 'kill', signal: 'SIGTERM' },
            { kind: 'armKill', ms: event.timeoutMs },
          ],
        };
      }
      // No child is running while waiting to restart or after giving up: nothing to wait for.
      return { state: { kind: 'stopped' }, effects: [] };
    }

    case 'killTimeout':
      return state.kind === 'stopping' ? { state, effects: [{ kind: 'kill', signal: 'SIGKILL' }] } : same;
  }
}

type Deferred = { promise: Promise<string>; resolve: (url: string) => void; reject: (error: Error) => void };

/**
 * Runs the LeafBot server as a child process. Bots keep running while the window is closed;
 * the process stops only when the app quits. Unexpected exits restart it a few times.
 *
 * The behaviour is `serverStep`; this class only runs the effects it returns and turns what
 * happens (output, exits, timers) into events.
 */
export class ServerProcess extends EventEmitter {
  private state: ServerState = { kind: 'idle' };
  private child: ChildProcess | null = null;
  private stderr = '';
  private pending: Deferred | null = null;
  private startTimer: ReturnType<typeof setTimeout> | undefined;
  private backoffTimer: ReturnType<typeof setTimeout> | undefined;
  private killTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: ServerEvent[] = [];
  private draining = false;
  private stopWaiters: (() => void)[] = [];

  constructor(private opts: ServerProcessOptions) {
    super();
  }

  get running() {
    return !!this.child && this.child.exitCode === null;
  }

  get url(): string | null {
    return this.state.kind === 'ready' ? this.state.url : null;
  }

  start(): Promise<string> {
    const state = this.state;
    if (state.kind === 'ready') return Promise.resolve(state.url);
    if (state.kind === 'starting' && this.pending) return this.pending.promise;
    if (state.kind === 'idle' || state.kind === 'stopped' || state.kind === 'gaveUp') {
      let resolve!: Deferred['resolve'];
      let reject!: Deferred['reject'];
      const promise = new Promise<string>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.pending = { promise, resolve, reject };
      this.dispatch({ kind: 'start' });
      return promise;
    }
    return Promise.reject(new Error('the server is restarting or stopping'));
  }

  /** Graceful stop: SIGTERM, then SIGKILL after the timeout. */
  stop(timeoutMs = 8000): Promise<void> {
    return new Promise<void>((resolve) => {
      this.stopWaiters.push(resolve);
      this.dispatch({ kind: 'stop', timeoutMs });
    });
  }

  /** Events from children and timers queue up, so a step finishes before the next one begins. */
  private dispatch(event: ServerEvent) {
    this.queue.push(event);
    if (this.draining) return;
    this.draining = true;
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        const result = serverStep(this.state, next);
        this.state = result.state;
        // A timer belongs to the state that armed it.
        if (this.state.kind !== 'starting') clearTimeout(this.startTimer);
        if (this.state.kind !== 'backoff') clearTimeout(this.backoffTimer);
        if (this.state.kind !== 'stopping') clearTimeout(this.killTimer);
        for (const effect of result.effects) this.run(effect);
      }
    } finally {
      this.draining = false;
    }
    if (this.state.kind !== 'stopping') for (const resolve of this.stopWaiters.splice(0)) resolve();
  }

  private run(effect: ServerEffect) {
    switch (effect.kind) {
      case 'spawn':
        this.spawnChild(effect.port === 'free' ? 0 : this.opts.port);
        break;
      case 'kill': {
        const child = this.child;
        if (effect.abandon) this.child = null;
        child?.kill(effect.signal);
        break;
      }
      case 'armStartTimeout':
        clearTimeout(this.startTimer);
        this.startTimer = setTimeout(() => this.dispatch({ kind: 'startTimeout' }), START_TIMEOUT_MS);
        break;
      case 'armBackoff':
        this.backoffTimer = setTimeout(() => this.dispatch({ kind: 'backoffElapsed' }), effect.ms);
        break;
      case 'armKill':
        this.killTimer = setTimeout(() => this.dispatch({ kind: 'killTimeout' }), effect.ms);
        break;
      case 'resolveStart':
        this.pending?.resolve(effect.url);
        this.pending = null;
        break;
      case 'rejectStart':
        this.pending?.reject(startError(effect.failure));
        this.pending = null;
        break;
      case 'emit':
        if (effect.event === 'exit') {
          this.emit('exit', { code: effect.code, signal: effect.signal, expected: effect.expected });
        } else {
          this.emit(effect.event, effect.url);
        }
        break;
      case 'giveUp':
        this.opts.log?.(
          'error',
          effect.reason === 'crashes'
            ? 'the server stopped 5 times within a minute; not restarting it'
            : `could not restart the server: ${startError(effect.reason).message}`,
        );
        this.emit('gave-up');
        break;
      case 'warn':
        this.opts.log?.('warn', effect.message);
        break;
    }
  }

  private spawnChild(port: number) {
    const log = this.opts.log ?? (() => {});
    const child = (this.opts.spawn ?? spawn)(this.opts.execPath, [this.opts.entry], {
      env: {
        PATH: fullPath(process.env.PATH, process.env.HOME ?? '', process.platform),
        HOME: process.env.HOME ?? '',
        USER: process.env.USER ?? '',
        LOGNAME: process.env.LOGNAME ?? process.env.USER ?? '',
        TMPDIR: process.env.TMPDIR ?? '/tmp',
        LANG: process.env.LANG ?? (locale() === 'tr' ? 'tr_TR.UTF-8' : 'en_US.UTF-8'),
        SHELL: process.env.SHELL ?? '/bin/zsh',
        ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
        ELECTRON_RUN_AS_NODE: '1',
        LEAFBOT_HOST: '127.0.0.1',
        LEAFBOT_PORT: String(port),
        LEAFBOT_DATA_DIR: this.opts.dataDir,
        LEAFBOT_ON_USER_COMPUTER: '1',
        ...(this.opts.appDir ? { LEAFBOT_APP_DIR: this.opts.appDir } : {}),
        ...this.opts.env,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    this.stderr = '';

    createInterface({ input: child.stdout! }).on('line', (line) => {
      const m = /^LEAFBOT_READY (\S+)/.exec(line);
      if (m && this.child === child && this.state.kind === 'starting') {
        this.dispatch({ kind: 'ready', url: m[1]! });
      } else {
        log('info', line);
      }
    });
    createInterface({ input: child.stderr! }).on('line', (line) => {
      this.stderr = (this.stderr + '\n' + line).slice(-4000);
      log('warn', line);
    });
    child.on('exit', (code, signal) => {
      // A child given up on (start timeout) or replaced is not the server any more.
      if (this.child !== child) return;
      this.child = null;
      const stderr = this.stderr.trim().slice(-600);
      this.dispatch({
        kind: 'exit',
        code,
        signal,
        stderr,
        addrInUse: port !== 0 && stderr.includes('EADDRINUSE'),
        now: Date.now(),
      });
    });
  }
}

function startError(failure: StartFailure): Error {
  return new Error(
    failure.kind === 'timeout'
      ? t('error.startTimeout')
      : t('error.startExit', { code: String(failure.code ?? failure.signal), stderr: failure.stderr }),
  );
}
