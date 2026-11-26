import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockedRemote, readDesktopConfig, writeDesktopConfig, type Crypto } from './desktop-config';

const crypto = (open: boolean, decrypts = true): Crypto => ({
  isEncryptionAvailable: () => open,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => {
    if (!decrypts) throw new Error('keyring refused');
    return b.toString().replace(/^enc:/, '');
  },
});

describe('anahtar zinciri kapalıyken kayıtlı uzak sunucu', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'leafbot-desktop-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('yapılandırmayı yerel saymak yerine uzak sunucunun adını verir', () => {
    writeDesktopConfig(dir, { mode: 'remote', url: 'https://bots.example.com', key: 'k-1' }, crypto(true));
    expect(lockedRemote(dir, crypto(false))).toBe('bots.example.com');
    expect(lockedRemote(dir, crypto(true, false))).toBe('bots.example.com');
    expect(lockedRemote(dir, crypto(true))).toBeNull();
    expect(readDesktopConfig(dir, crypto(true))).toEqual({
      mode: 'remote',
      url: 'https://bots.example.com',
      key: 'k-1',
    });
  });

  it('yapılandırma yoksa, yerelse ya da okunamıyorsa beklenecek bir şey yoktur', () => {
    expect(lockedRemote(dir, crypto(false))).toBeNull();
    writeDesktopConfig(dir, { mode: 'local' }, crypto(false));
    expect(lockedRemote(dir, crypto(false))).toBeNull();
    writeFileSync(join(dir, 'desktop.json'), '{not json');
    expect(lockedRemote(dir, crypto(false))).toBeNull();
  });
});
