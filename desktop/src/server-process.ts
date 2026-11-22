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
}

/**
 * Runs the LeafBot server as a child process. Bots keep running while the window is closed;
 * the process stops only when the app quits. Unexpected exits restart it a few times.
 */
export class ServerProcess extends EventEmitter {
  private child: ChildProcess | null = null;
  private stopping = false;
  private crashes: number[] = [];
  url: string | null = null;

  constructor(private opts: ServerProcessOptions) {
    super();
  }

  get running() {
    return !!this.child && this.child.exitCode === null;
  }

  async start(): Promise<string> {
    this.stopping = false;
    try {
      return await this.spawnOnce(this.opts.port);
    } catch (err) {
      if ((err as Error).message.includes('EADDRINUSE') && this.opts.port !== 0) {
        this.opts.log?.('warn', `port ${this.opts.port} is in use; trying a free port`);
        return this.spawnOnce(0);
      }
      throw err;
    }
  }

  private spawnOnce(port: number): Promise<string> {
    const log = this.opts.log ?? (() => {});
    return new Promise((resolve, reject) => {
      const child = spawn(this.opts.execPath, [this.opts.entry], {
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
      let ready = false;
      let stderr = '';
      const timer = setTimeout(() => {
        if (!ready) {
          child.kill('SIGKILL');
          reject(new Error(t('error.startTimeout')));
        }
      }, 60_000);

      createInterface({ input: child.stdout! }).on('line', (line) => {
        const m = /^LEAFBOT_READY (\S+)/.exec(line);
        if (m && !ready) {
          ready = true;
          clearTimeout(timer);
          this.url = m[1]!;
          resolve(this.url);
          this.emit('ready', this.url);
        } else {
          log('info', line);
        }
      });
      createInterface({ input: child.stderr! }).on('line', (line) => {
        stderr = (stderr + '\n' + line).slice(-4000);
        log('warn', line);
      });

      child.on('exit', (code, signal) => {
        clearTimeout(timer);
        if (this.child === child) this.child = null;
        if (!ready) {
          reject(
            new Error(
              t('error.startExit', { code: String(code ?? signal), stderr: stderr.trim().slice(-600) }),
            ),
          );
          return;
        }
        this.url = null;
        this.emit('exit', { code, signal, expected: this.stopping });
        if (!this.stopping) void this.restart();
      });
    });
  }

  private async restart() {
    const now = Date.now();
    this.crashes = this.crashes.filter((t) => now - t < 60_000);
    this.crashes.push(now);
    if (this.crashes.length > 4) {
      this.opts.log?.('error', 'the server stopped 5 times within a minute; not restarting it');
      this.emit('gave-up');
      return;
    }
    await new Promise((r) => setTimeout(r, 500 * this.crashes.length));
    try {
      await this.start();
      this.emit('restarted', this.url);
    } catch (err) {
      this.opts.log?.('error', `could not restart the server: ${(err as Error).message}`);
      this.emit('gave-up');
    }
  }

  /** Graceful stop: SIGTERM, then SIGKILL after the timeout. */
  async stop(timeoutMs = 8000): Promise<void> {
    this.stopping = true;
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
      child.once('exit', () => {
        clearTimeout(kill);
        resolve();
      });
      child.kill('SIGTERM');
    });
  }
}
