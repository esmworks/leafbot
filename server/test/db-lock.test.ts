import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseInUseError, STALE_MS, lockFolder } from '../src/db/lock';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function lockFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'leafbot-lock-'));
  dirs.push(dir);
  return join(dir, 'db.lock');
}

const held = (file: string, holder: { pid: number; host: string }) =>
  writeFileSync(file, JSON.stringify({ ...holder, token: 'other' }));

/** A process that runs until the test ends it. */
function liveProcess() {
  return spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
}

describe('the embedded database folder’s lock', () => {
  it('is refused while another process here holds it, and taken once that process has gone', async () => {
    const file = lockFile();
    const other = liveProcess();
    held(file, { pid: other.pid!, host: hostname() });
    try {
      await expect(lockFolder(file)).rejects.toBeInstanceOf(DatabaseInUseError);
    } finally {
      other.kill();
      await new Promise((r) => other.once('exit', r));
    }
    const lock = await lockFolder(file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ pid: process.pid });
    lock.release();
    expect(existsSync(file)).toBe(false);
  });

  it('takes a lock this process number left: a restarted container numbers its process alike', async () => {
    const file = lockFile();
    held(file, { pid: process.pid, host: hostname() });
    (await lockFolder(file)).release();
  });

  it('holds for another container while it is marked alive, and lets go once it is not', async () => {
    const file = lockFile();
    held(file, { pid: 7, host: 'another-container' });
    await expect(lockFolder(file)).rejects.toBeInstanceOf(DatabaseInUseError);
    const old = new Date(Date.now() - STALE_MS - 1000);
    utimesSync(file, old, old);
    (await lockFolder(file)).release();
  });

  it('waits for a holder that lets go while it waits', async () => {
    const file = lockFile();
    held(file, { pid: 7, host: 'another-container' });
    setTimeout(() => rmSync(file), 300);
    const lock = await lockFolder(file, { waitMs: 5000 });
    lock.release();
  });

  it('leaves a lock another process took after this one alone on release', async () => {
    const file = lockFile();
    const lock = await lockFolder(file);
    held(file, { pid: 7, host: 'another-container' });
    lock.release();
    expect(existsSync(file)).toBe(true);
  });
});
