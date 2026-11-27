import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeRemoteUrl, readDesktopConfig, writeDesktopConfig } from './desktop-config';
import { fullPath, ServerProcess, serverStep, type ServerState } from './server-process';

const entry = join(import.meta.dirname, '../../server/dist/index.mjs');

describe.skipIf(!existsSync(entry))('sunucu süreci', () => {
  let dir: string;
  let sp: ServerProcess | null = null;
  afterEach(async () => {
    await sp?.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it('açılır, anahtar dosyasını yazar, beklenmedik çıkışta yeniden başlar, düzgün kapanır', async () => {
    dir = mkdtempSync(join(tmpdir(), 'leafbot-desk-'));
    sp = new ServerProcess({
      entry,
      execPath: process.execPath,
      dataDir: dir,
      appDir: null,
      port: 0,
      env: { LEAFBOT_ENGINE: 'fake' },
    });
    const url = await sp.start();
    expect((await fetch(`${url}/api/health`)).ok).toBe(true);
    expect(existsSync(join(dir, 'access-key'))).toBe(true);

    const restarted = new Promise<string>((r) => sp!.once('restarted', r));
    (sp as unknown as { child: { kill(s: string): void } }).child.kill('SIGKILL');
    const url2 = await restarted;
    expect((await fetch(`${url2}/api/health`)).ok).toBe(true);

    await sp.stop();
    expect(sp.running).toBe(false);
    await expect(fetch(`${url2}/api/health`)).rejects.toThrow();
  });
});

describe('masaüstü ayarı', () => {
  const crypto = {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from([...s].reverse().join('')),
    decryptString: (b: Buffer) => [...b.toString()].reverse().join(''),
  };
  it('uzak sunucu anahtarı şifreli saklanır ve geri okunur', () => {
    const d = mkdtempSync(join(tmpdir(), 'leafbot-cfg-'));
    const cfg = {
      local: false,
      remotes: [{ url: 'https://a.example.com', key: 'gizli' }],
      shown: 'https://a.example.com',
    };
    writeDesktopConfig(d, cfg, crypto);
    expect(readDesktopConfig(d, crypto)).toEqual(cfg);
    rmSync(d, { recursive: true, force: true });
  });
  it('uzak adres https olmalı; yerel ağ istisnadır', () => {
    expect(normalizeRemoteUrl('https://a.example.com/x')).toBe('https://a.example.com');
    expect(normalizeRemoteUrl('http://localhost:4319')).toBe('http://localhost:4319');
    expect(() => normalizeRemoteUrl('http://a.example.com')).toThrow();
  });
});

describe('PATH', () => {
  it('Finder’dan açılınca eksik kalan araç klasörlerini sona ekler', () => {
    expect(fullPath('/usr/bin:/bin', '/Users/a', 'darwin')).toBe(
      '/usr/bin:/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/Users/a/.local/bin:/Users/a/bin:/Users/a/.cargo/bin',
    );
    expect(fullPath('/usr/local/bin:/usr/bin', '/home/a', 'linux')).toBe(
      '/usr/local/bin:/usr/bin:/home/a/.local/bin:/home/a/bin:/home/a/.cargo/bin',
    );
    expect(fullPath('C:\\x', 'C:\\Users\\a', 'win32')).toBe('C:\\x');
  });
});

/** A child that prints and exits on command, so the lifecycle runs without a real process. */
class FakeChild extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killed: string[] = [];
  kill(signal?: string) {
    this.killed.push(signal ?? 'SIGTERM');
    this.exit(null, signal ?? 'SIGTERM');
    return true;
  }
  say(line: string) {
    this.stdout.write(line + '\n');
  }
  exit(code: number | null, signal: string | null = null) {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 1;
    this.emit('exit', code, signal);
  }
}

describe('sunucu süreci yaşam döngüsü (sahte süreçle)', () => {
  let children: FakeChild[];
  let proc: ServerProcess;

  beforeEach(() => {
    vi.useFakeTimers();
    children = [];
    proc = new ServerProcess({
      entry: 'x',
      execPath: 'node',
      dataDir: '/tmp/x',
      appDir: null,
      port: 0,
      spawn: (() => {
        const c = new FakeChild();
        children.push(c);
        return c;
      }) as never,
    });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const settle = () => vi.advanceTimersByTimeAsync(0);
  async function ready(child: FakeChild, url = 'http://127.0.0.1:1') {
    child.say(`LEAFBOT_READY ${url}`);
    await settle();
  }

  it('does not start a child nobody owns when stopped while waiting to restart', async () => {
    const started = proc.start();
    await ready(children[0]!);
    await started;
    children[0]!.exit(1);
    await settle();
    expect(children).toHaveLength(1);

    await proc.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(children).toHaveLength(1);
    expect(proc.running).toBe(false);
  });

  it('rejects start and does not restart when stopped before the server is ready', async () => {
    const started = proc.start();
    const outcome = started.then(
      () => 'resolved',
      () => 'rejected',
    );
    await settle();
    await proc.stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBe('rejected');
    expect(children).toHaveLength(1);
    expect(proc.running).toBe(false);
  });

  it('restarts after a crash and reports the new address', async () => {
    const started = proc.start();
    await ready(children[0]!);
    await started;
    const events: string[] = [];
    proc.on('exit', (e: { expected: boolean }) => events.push(`exit ${e.expected}`));
    proc.on('restarted', (url: string) => events.push(`restarted ${url}`));

    children[0]!.exit(1);
    await vi.advanceTimersByTimeAsync(500);
    expect(children).toHaveLength(2);
    await ready(children[1]!, 'http://127.0.0.1:2');
    expect(events).toEqual(['exit false', 'restarted http://127.0.0.1:2']);
    expect(proc.url).toBe('http://127.0.0.1:2');
    expect(proc.running).toBe(true);
    await proc.stop();
    expect(proc.running).toBe(false);
  });

  it('gives up after five crashes within a minute', async () => {
    const gaveUp = vi.fn();
    proc.on('gave-up', gaveUp);
    const started = proc.start();
    await ready(children[0]!);
    await started;
    for (let i = 0; i < 4; i++) {
      children[i]!.exit(1);
      await vi.advanceTimersByTimeAsync(500 * (i + 1));
      expect(children).toHaveLength(i + 2);
      await ready(children[i + 1]!);
    }
    children[4]!.exit(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(gaveUp).toHaveBeenCalledTimes(1);
    expect(children).toHaveLength(5);
    expect(proc.running).toBe(false);
  });
});

describe('serverStep', () => {
  const exit = { kind: 'exit', code: 1, signal: null, stderr: '', addrInUse: false, now: 1000 } as const;
  const ready: ServerState = { kind: 'ready', url: 'http://127.0.0.1:1', crashes: [] };

  it('starts only from a state with nothing running', () => {
    for (const kind of ['idle', 'stopped', 'gaveUp'] as const) {
      expect(serverStep({ kind }, { kind: 'start' }).state.kind).toBe('starting');
    }
    expect(serverStep(ready, { kind: 'start' })).toEqual({ state: ready, effects: [] });
  });

  it('tries a free port once when the preferred one is taken', () => {
    const starting: ServerState = { kind: 'starting', port: 'preferred', restart: false, crashes: [] };
    const first = serverStep(starting, { ...exit, addrInUse: true });
    expect(first.state).toMatchObject({ kind: 'starting', port: 'free' });
    expect(first.effects).toContainEqual({ kind: 'spawn', port: 'free' });
    expect(serverStep(first.state, { ...exit, addrInUse: true }).state.kind).toBe('idle');
  });

  it('backs off longer after each crash and gives up on the fifth within a minute', () => {
    const one = serverStep(ready, exit);
    expect(one.state).toEqual({ kind: 'backoff', crashes: [1000] });
    expect(one.effects).toContainEqual({ kind: 'armBackoff', ms: 500 });

    const fifth = serverStep(
      { kind: 'ready', url: 'u', crashes: [100, 200, 300, 400] },
      { ...exit, now: 500 },
    );
    expect(fifth.state.kind).toBe('gaveUp');
    expect(fifth.effects).toContainEqual({ kind: 'giveUp', reason: 'crashes' });

    // Crashes older than a minute no longer count.
    const old = serverStep({ kind: 'ready', url: 'u', crashes: [1, 2, 3, 4] }, { ...exit, now: 70_000 });
    expect(old.state).toEqual({ kind: 'backoff', crashes: [70_000] });
  });

  it('ends in stopped when stopped while waiting to restart, and ignores the timer after', () => {
    const waiting: ServerState = { kind: 'backoff', crashes: [1] };
    const stopped = serverStep(waiting, { kind: 'stop', timeoutMs: 8000 });
    expect(stopped).toEqual({ state: { kind: 'stopped' }, effects: [] });
    expect(serverStep(stopped.state, { kind: 'backoffElapsed' }).state).toEqual({ kind: 'stopped' });
  });

  it('kills a child that was told to stop and did not, and treats its exit as expected', () => {
    const stopping = serverStep(ready, { kind: 'stop', timeoutMs: 50 });
    expect(stopping.state).toEqual({ kind: 'stopping', during: 'ready' });
    expect(stopping.effects).toEqual([
      { kind: 'kill', signal: 'SIGTERM' },
      { kind: 'armKill', ms: 50 },
    ]);
    expect(serverStep(stopping.state, { kind: 'killTimeout' }).effects).toEqual([
      { kind: 'kill', signal: 'SIGKILL' },
    ]);
    const done = serverStep(stopping.state, exit);
    expect(done.state.kind).toBe('stopped');
    expect(done.effects).toEqual([{ kind: 'emit', event: 'exit', code: 1, signal: null, expected: true }]);
  });

  it('gives up on a start that times out: a restart tells nobody waiting, a first start rejects', () => {
    const first = serverStep(
      { kind: 'starting', port: 'preferred', restart: false, crashes: [] },
      { kind: 'startTimeout' },
    );
    expect(first.state.kind).toBe('idle');
    expect(first.effects).toContainEqual({ kind: 'rejectStart', failure: { kind: 'timeout' } });
    const again = serverStep(
      { kind: 'starting', port: 'preferred', restart: true, crashes: [1] },
      { kind: 'startTimeout' },
    );
    expect(again.state.kind).toBe('gaveUp');
  });
});
