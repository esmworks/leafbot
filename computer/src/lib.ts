import type { ChildProcess } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { readlinkSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { DesktopAction } from '@leafbot/shared';

/**
 * Removes a Chromium profile lock left by another host. Chromium names its lock `<host>-<pid>`
 * and only clears a stale one from its own host; a lock from another host makes it ask the
 * person to unlock the profile. The computer service's host name changes each time its container
 * is made again, while the profile stays in the bot's home, so every desktop started after that
 * would ask. A lock from this host is left to Chromium, which checks whether its process lives.
 * Returns whether a lock was removed.
 */
export function clearForeignProfileLock(profileDir: string, host: string): boolean {
  let target: string;
  try {
    target = readlinkSync(join(profileDir, 'SingletonLock'));
  } catch {
    return false;
  }
  const dash = target.lastIndexOf('-');
  if (dash > 0 && target.slice(0, dash) === host) return false;
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    rmSync(join(profileDir, name), { force: true });
  }
  return true;
}

/** An action after parsing: the schema's defaults (button, count, amount) are filled in. */
export type ParsedAction = ReturnType<(typeof DesktopAction)['parse']>;

/** The last N characters of a stream, so a chatty command cannot fill the memory. */
export class TailBuffer {
  private text = '';
  truncated = false;
  constructor(private readonly max: number) {}

  push(chunk: string): void {
    this.text += chunk;
    // Trim in batches (at 2x) instead of on every chunk.
    if (this.text.length > this.max * 2) {
      this.text = this.text.slice(-this.max);
      this.truncated = true;
    }
  }

  result(): { output: string; truncated: boolean } {
    if (this.text.length > this.max) {
      this.text = this.text.slice(-this.max);
      this.truncated = true;
    }
    return { output: this.text, truncated: this.truncated };
  }
}

/** Compares in constant time; hashing first makes the lengths equal. */
export function checkToken(provided: string | null | undefined, expected: string): boolean {
  if (!provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The token from `Authorization: Bearer <token>`. */
export function bearerToken(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer (.+)$/.exec(header);
  return m?.[1] ?? null;
}

/** The lowest free X display number in 1..max, or null when all are taken. */
export function allocateDisplay(used: Iterable<number>, max = 99): number | null {
  const taken = new Set(used);
  for (let n = 1; n <= max; n++) if (!taken.has(n)) return n;
  return null;
}

/**
 * Chromium's `--remote-debugging-pipe` framing: one JSON message, then a NUL byte.
 * Over the WebSocket every message is one text frame instead.
 */
export function encodeCdp(text: string): Buffer {
  return Buffer.concat([Buffer.from(text, 'utf8'), Buffer.from([0])]);
}

/** Splits a NUL-terminated byte stream back into messages, whatever way the chunks fall. */
export class CdpDecoder {
  private pending: Buffer = Buffer.alloc(0);
  constructor(private readonly maxMessage = 256 * 1024 * 1024) {}

  push(chunk: Buffer): string[] {
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const out: string[] = [];
    let start = 0;
    for (;;) {
      const end = this.pending.indexOf(0, start);
      if (end < 0) break;
      if (end > start) out.push(this.pending.toString('utf8', start, end));
      start = end + 1;
    }
    this.pending = this.pending.subarray(start);
    if (this.pending.length > this.maxMessage) {
      this.pending = Buffer.alloc(0);
      throw new Error('CDP message too large');
    }
    return out;
  }
}

const SCROLL_BUTTON = { up: '4', down: '5', left: '6', right: '7' } as const;
const MOUSE_BUTTON = { left: '1', middle: '2', right: '3' } as const;

/**
 * The xdotool argument list (chained commands) for one action. Always passed to execFile as an
 * array, never through a shell. Takes the parsed action, so defaults are already filled in.
 */
export function xdotoolArgs(a: ParsedAction): string[] {
  const s = String;
  switch (a.type) {
    case 'click':
      return ['mousemove', s(a.x), s(a.y), 'click', '--repeat', s(a.count), MOUSE_BUTTON[a.button]];
    case 'move':
      return ['mousemove', s(a.x), s(a.y)];
    case 'drag':
      return [
        'mousemove',
        s(a.from.x),
        s(a.from.y),
        'mousedown',
        '1',
        'mousemove',
        s(a.to.x),
        s(a.to.y),
        'mouseup',
        '1',
      ];
    case 'type':
      return ['type', '--delay', '12', '--', a.text];
    case 'key':
      // The schema allows only [A-Za-z0-9_+ -], so each word is a plain key name.
      return ['key', '--', ...a.keys.split(/\s+/).filter(Boolean)];
    case 'scroll':
      return ['mousemove', s(a.x), s(a.y), 'click', '--repeat', s(a.amount), SCROLL_BUTTON[a.direction]];
  }
}

/** Width and height from a PNG's IHDR chunk, or null when it is not a PNG. */
export function pngSize(png: Buffer): { width: number; height: number } | null {
  if (png.length < 24 || png.toString('latin1', 1, 4) !== 'PNG') return null;
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/** A browser URL the launcher may open: no flags, only plain schemes. */
export function isOpenableUrl(url: string): boolean {
  if (url === '') return true;
  return /^(https?:\/\/|file:\/\/\/|about:blank$)/i.test(url) && !/[\0\r\n]/.test(url);
}

/** Background commands of one desktop: started, left running, asked about later. */
export class Jobs {
  private jobs = new Map<
    string,
    {
      tail: TailBuffer;
      exitCode: number | null;
      done: boolean;
      started: number;
      ended: Promise<void>;
      kill(): void;
    }
  >();
  private next = 1;

  constructor(
    private readonly start: (command: string, cwd: string, env?: NodeJS.ProcessEnv) => ChildProcess,
    private readonly maxOutput = 100_000,
    private readonly maxRunning = 5,
  ) {}

  run(command: string, cwd: string, env?: NodeJS.ProcessEnv): string {
    const running = [...this.jobs.values()].filter((j) => !j.done).length;
    if (running >= this.maxRunning) throw new Error(`${running} background commands are running already`);
    // Finished jobs beyond the last few are forgotten.
    for (const [id, j] of this.jobs) if (j.done && this.jobs.size > 20) this.jobs.delete(id);
    const id = `j${this.next++}`;
    const tail = new TailBuffer(this.maxOutput);
    const child = this.start(command, cwd, env);
    let resolveEnded!: () => void;
    const job = {
      tail,
      exitCode: null as number | null,
      done: false,
      started: Date.now(),
      ended: new Promise<void>((r) => (resolveEnded = r)),
      kill: () => {
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      },
    };
    child.stdout?.on('data', (c: Buffer) => tail.push(c.toString('utf8')));
    child.stderr?.on('data', (c: Buffer) => tail.push(c.toString('utf8')));
    const finish = (code: number | null) => {
      if (job.done) return;
      job.done = true;
      job.exitCode = code;
      resolveEnded();
    };
    child.on('error', (e) => {
      tail.push(`${e.message}\n`);
      finish(null);
    });
    child.on('close', (code) => finish(code));
    this.jobs.set(id, job);
    return id;
  }

  /** The job's state, after waiting up to `waitMs` for it to end; null for an unknown id. */
  async status(id: string, waitMs = 0) {
    const j = this.jobs.get(id);
    if (!j) return null;
    if (!j.done && waitMs > 0) {
      await Promise.race([j.ended, new Promise((r) => setTimeout(r, waitMs).unref())]);
    }
    return {
      id,
      running: !j.done,
      exitCode: j.exitCode,
      ...j.tail.result(),
      seconds: Math.round((Date.now() - j.started) / 1000),
    };
  }

  /** Stops every job still running, as the desktop closes. */
  stopAll() {
    for (const j of this.jobs.values()) if (!j.done) j.kill();
  }
}
