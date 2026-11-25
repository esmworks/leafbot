import { spawn, type ChildProcess } from 'node:child_process';
import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import {
  MAC_JOB_MAX_MS,
  MAC_JOB_TAIL,
  MAC_JOBS_MAX,
  type MacJobEvent,
  type MacRequest,
  secretPlace,
  stripAnsi,
} from '@leafbot/shared/mac';

/**
 * Commands a bot runs on this computer, while the person has "Bots may run commands" on. The
 * server's card decides whether a command runs; this keeps the count and the time within limits,
 * asks on the computer itself before one that names a place keys are kept, and tells the server
 * how each one goes. Jobs belong to the app, not to a connection: one that ends while the server
 * is away is told when it comes back.
 */

/** How much of a command's output is kept: the end, where the result usually is. */
const KEEP = 100_000;
/** How often a running job's newest lines go to the server, at most. */
const TELL_EVERY_MS = 3_000;

/** The last `max` characters of a stream, trimmed in steps so long output stays cheap. */
export class TailBuffer {
  private text = '';
  truncated = false;
  constructor(private max: number) {}
  push(chunk: string) {
    this.text += chunk;
    if (this.text.length > this.max * 2) {
      this.text = this.text.slice(-this.max);
      this.truncated = true;
    }
  }
  get value(): string {
    if (this.text.length <= this.max) return this.text;
    this.truncated = true;
    return this.text.slice(-this.max);
  }
}

interface Job {
  id: string;
  child: ChildProcess;
  out: TailBuffer;
  ended: Promise<void>;
  exitCode: number | null;
  running: boolean;
  stopped: boolean;
  told: string;
  timer: ReturnType<typeof setTimeout>;
}

export type RunRequest = Extract<MacRequest, { op: 'run' }>;

export interface CommandJobsOptions {
  /**
   * Asks the person on this computer whether `bot` may run `command`, which names `place` where
   * keys are kept; true for a yes. Ended by `signal`, which counts as a no.
   */
  ask(bot: string, command: string, place: string, signal: AbortSignal): Promise<boolean>;
  /** Told when the jobs running change, for the menu. */
  onChange?(): void;
  /** The shell a command runs in; the system's own by default. */
  shell?: (command: string) => { file: string; args: string[] };
  maxMs?: number;
  askMs?: number;
}

/** The shell that runs a command: the person's login shell, or PowerShell on Windows. */
export function systemShell(command: string): { file: string; args: string[] } {
  if (process.platform === 'win32')
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] };
  return { file: process.env.SHELL || '/bin/zsh', args: ['-lc', command] };
}

/** The app's own settings stay out of a command's environment, which the login shell fills in. */
function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env))
    if (!/^(LEAFBOT_|YUMAKBOT_|ELECTRON_)/.test(k)) env[k] = v;
  return env;
}

export class CommandJobs {
  private jobs = new Map<string, Job>();
  /** Ends the server has not heard yet, sent when it is back. */
  private unsent = new Map<string, MacJobEvent>();

  /** Where events go: the server's connection while there is one. */
  private sink: ((event: MacJobEvent) => boolean) | null = null;

  constructor(private o: CommandJobsOptions) {}

  /** Events go to `sink` from now on, or wait for one when null; the waiting ends are sent now. */
  attach(sink: ((event: MacJobEvent) => boolean) | null) {
    this.sink = sink;
    if (sink) this.flush();
  }

  private send(event: MacJobEvent): boolean {
    return this.sink?.(event) ?? false;
  }

  /** The folder a command would run in: `~` and relative paths from the home folder, links followed. */
  async where(cwd: string): Promise<Record<string, unknown>> {
    const home = homedir();
    const asked = cwd.trim() || '~';
    const path =
      asked === '~'
        ? home
        : asked.startsWith('~/')
          ? join(home, asked.slice(2))
          : isAbsolute(asked)
            ? asked
            : resolve(home, asked);
    try {
      const real = await realpath(path);
      if (!(await stat(real)).isDirectory()) return { ok: false, error: 'noFolder' };
      return { ok: true, cwd: real, secret: secretPlace(real) };
    } catch {
      return { ok: false, error: 'noFolder' };
    }
  }

  running(): { id: string }[] {
    return [...this.jobs.values()].filter((j) => j.running).map((j) => ({ id: j.id }));
  }

  async run(req: RunRequest): Promise<Record<string, unknown>> {
    if (this.jobs.has(req.id)) return { ok: false, error: 'badRequest' };
    if (this.running().length >= MAC_JOBS_MAX) return { ok: false, error: 'tooMany' };
    const at = await this.where(req.cwd);
    if (at.ok !== true) return at;
    const cwd = at.cwd as string;
    const place = secretPlace(req.command, cwd);
    if (place) {
      const signal = AbortSignal.timeout(this.o.askMs ?? 55_000);
      const yes = await this.o.ask(req.bot, req.command, place, signal).catch(() => false);
      if (!yes) return { ok: false, error: 'refused' };
      // Asked while others started: the limit still holds.
      if (this.running().length >= MAC_JOBS_MAX) return { ok: false, error: 'tooMany' };
    }
    const { file, args } = (this.o.shell ?? systemShell)(req.command);
    const child = spawn(file, args, {
      cwd,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      windowsHide: true,
    });
    const out = new TailBuffer(KEEP);
    let lastTold = 0;
    let pending: ReturnType<typeof setTimeout> | null = null;
    const job: Job = {
      id: req.id,
      child,
      out,
      exitCode: null,
      running: true,
      stopped: false,
      told: '',
      ended: Promise.resolve(),
      timer: setTimeout(() => this.kill(job, true), this.o.maxMs ?? MAC_JOB_MAX_MS),
    };
    const tell = () => {
      pending = null;
      if (!job.running) return;
      const tail = this.tail(job);
      if (tail === job.told) return;
      job.told = tail;
      lastTold = Date.now();
      this.send({ id: job.id, running: true, tail, exitCode: null });
    };
    const onData = (b: Buffer) => {
      out.push(b.toString('utf8'));
      if (pending) return;
      pending = setTimeout(tell, Math.max(0, TELL_EVERY_MS - (Date.now() - lastTold)));
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    job.ended = new Promise<void>((done) => {
      const end = (code: number | null) => {
        if (!job.running) return;
        job.running = false;
        job.exitCode = code;
        clearTimeout(job.timer);
        if (pending) clearTimeout(pending);
        const event: MacJobEvent = {
          id: job.id,
          running: false,
          tail: this.tail(job),
          exitCode: code,
          ...(job.stopped && { stopped: true }),
        };
        if (!this.send(event)) this.unsent.set(job.id, event);
        // Kept a while for a late status question, then forgotten.
        setTimeout(() => this.jobs.delete(job.id), 10 * 60_000).unref?.();
        this.o.onChange?.();
        done();
      };
      child.on('error', (err) => {
        out.push(`\n${err.message}\n`);
        end(127);
      });
      child.on('close', (code) => end(code));
    });
    this.jobs.set(job.id, job);
    this.o.onChange?.();
    await Promise.race([job.ended, new Promise((r) => setTimeout(r, req.waitMs))]);
    return {
      ok: true,
      cwd,
      running: job.running,
      exitCode: job.exitCode,
      stopped: job.stopped,
      output: stripAnsi(out.value),
      truncated: out.truncated,
    };
  }

  private tail(job: Job): string {
    return stripAnsi(job.out.value).slice(-MAC_JOB_TAIL);
  }

  private kill(job: Job, byTime = false) {
    if (!job.running) return;
    job.stopped = true;
    if (byTime) job.out.push('\n[stopped: time limit]\n');
    try {
      if (process.platform !== 'win32' && job.child.pid) process.kill(-job.child.pid, 'SIGTERM');
      else job.child.kill();
    } catch {
      job.child.kill();
    }
    // One that ignores the polite stop is ended.
    setTimeout(() => {
      if (!job.running) return;
      try {
        if (process.platform !== 'win32' && job.child.pid) process.kill(-job.child.pid, 'SIGKILL');
        else job.child.kill('SIGKILL');
      } catch {
        // Already gone.
      }
    }, 5_000).unref?.();
  }

  /** Stops one job; false when this computer does not know it or it already ended. */
  stop(id: string): boolean {
    const job = this.jobs.get(id);
    if (!job?.running) return false;
    this.kill(job);
    return true;
  }

  stopAll() {
    for (const job of this.jobs.values()) this.kill(job);
  }

  /** Sends the ends the server missed while away. */
  flush() {
    for (const [id, event] of this.unsent) if (this.send(event)) this.unsent.delete(id);
  }

  /** Answers a command request from the server. */
  async handle(req: MacRequest): Promise<Record<string, unknown>> {
    if (req.op === 'where') return this.where(req.cwd);
    if (req.op === 'run') return this.run(req);
    if (req.op === 'stop') return { ok: true, stopped: this.stop(req.id) };
    if (req.op === 'jobs') return { ok: true, running: this.running().map((j) => j.id) };
    return { ok: false, error: 'badRequest' };
  }
}
