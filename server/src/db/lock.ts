import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync, statSync, unlinkSync, utimesSync, writeSync } from 'node:fs';
import { hostname } from 'node:os';

/** How often a holder marks its lock as alive. */
const BEAT_MS = 10_000;
/** A lock from another computer or container not marked for this long was left by a process that died. */
export const STALE_MS = 30_000;

/** The embedded database's folder is open in another process (a running server, or `leafbot login`). */
export class DatabaseInUseError extends Error {
  constructor(public holder: { pid: number; host: string }) {
    super(`The database is in use by process ${holder.pid} on ${holder.host}`);
  }
}

interface Holder {
  pid: number;
  host: string;
  token: string;
}

export interface FolderLock {
  release(): void;
}

/**
 * Takes the lock on an embedded database folder, which only one process may open at a time: a
 * second one writing the same files corrupts them. The lock is a file naming its holder, marked
 * alive every few seconds, so a holder in another container (where its process cannot be seen)
 * that died is told apart from one that runs. `waitMs`: how long to wait for a holder to let go
 * (a server restarting after one that is still shutting down).
 */
export async function lockFolder(
  file: string,
  opts: { waitMs?: number; now?: () => number } = {},
): Promise<FolderLock> {
  const now = opts.now ?? Date.now;
  const until = now() + (opts.waitMs ?? 0);
  const me: Holder = { pid: process.pid, host: hostname(), token: randomUUID() };
  for (;;) {
    const holder = take(file, me, now);
    if (!holder) break;
    if (now() >= until) throw new DatabaseInUseError(holder);
    await new Promise((r) => setTimeout(r, 1000));
  }
  const beat = setInterval(() => {
    try {
      const at = new Date();
      utimesSync(file, at, at);
    } catch {
      // Removed by hand: the next start takes it anew.
    }
  }, BEAT_MS);
  beat.unref();
  // An exit without close (a crash handler, a forced exit) still lets the next process in at once.
  const onExit = () => release();
  process.once('exit', onExit);
  let released = false;
  function release() {
    if (released) return;
    released = true;
    clearInterval(beat);
    process.removeListener('exit', onExit);
    if (read(file)?.token === me.token) {
      try {
        unlinkSync(file);
      } catch {
        // Already gone.
      }
    }
  }
  return { release };
}

/** Takes the lock when it is free or left by a dead process; otherwise names its holder. */
function take(file: string, me: Holder, now: () => number): Holder | null {
  for (let tries = 0; tries < 3; tries++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      try {
        writeSync(fd, JSON.stringify(me));
      } finally {
        closeSync(fd);
      }
      // Two processes taking over the same dead holder's lock at once: only the last writer holds it.
      const current = read(file);
      return current?.token === me.token ? null : (current ?? UNKNOWN);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const holder = read(file);
    // Unreadable: being written by its holder this moment, or left half written by a crash.
    if (holder ? alive(file, holder, me, now) : fresh(file, now)) return holder ?? UNKNOWN;
    try {
      unlinkSync(file);
    } catch {
      // Another process removed it first; try again.
    }
  }
  return read(file) ?? UNKNOWN;
}

/** A holder whose lock file cannot be read. */
const UNKNOWN: Holder = { pid: 0, host: 'unknown', token: '' };

function fresh(file: string, now: () => number): boolean {
  try {
    return now() - statSync(file).mtimeMs < STALE_MS;
  } catch {
    return false;
  }
}

function alive(file: string, holder: Holder, me: Holder, now: () => number): boolean {
  if (holder.host === me.host) {
    // The same process id here is this process: a restarted container numbers its process alike.
    if (holder.pid === me.pid) return false;
    try {
      process.kill(holder.pid, 0);
      return true;
    } catch (e) {
      // EPERM: the process runs, as another user.
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }
  return fresh(file, now);
}

function read(file: string): Holder | null {
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Partial<Holder>;
    return typeof v.pid === 'number' && typeof v.host === 'string' && typeof v.token === 'string'
      ? (v as Holder)
      : null;
  } catch {
    return null;
  }
}
