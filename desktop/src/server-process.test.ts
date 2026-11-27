import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fullPath, ServerProcess } from './server-process';

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
