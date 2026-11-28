import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  chooseServer,
  LOCAL_ONLY,
  readDesktopConfig,
  setLocal,
  show,
  writeDesktopConfig,
} from './desktop-config';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'leafbot-desktop-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeRaw = (value: unknown) => writeFileSync(join(dir, 'desktop.json'), JSON.stringify(value));

describe('kayıtlı yapılandırma', () => {
  it('yazılan olduğu gibi geri okunur', () => {
    const cfg = { local: true, shown: 'account' as const, server: 'srv_1' };
    writeDesktopConfig(dir, cfg);
    expect(readDesktopConfig(dir)).toEqual(cfg);
  });

  it('dosya yoksa ya da okunamıyorsa yalnız bu bilgisayarın sunucusudur', () => {
    expect(readDesktopConfig(dir)).toEqual(LOCAL_ONLY);
    writeFileSync(join(dir, 'desktop.json'), '{not json');
    expect(readDesktopConfig(dir)).toEqual(LOCAL_ONLY);
  });

  it('dosyada adres ve anahtar tutulmaz', () => {
    writeDesktopConfig(dir, LOCAL_ONLY);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, 'desktop.json'), 'utf8')))).toEqual([
      'version',
      'local',
      'shown',
      'server',
    ]);
  });
});

describe('adresle ve anahtarla uzak sunucu tutan eski yapılandırmalar', () => {
  it('sürüm 2: uzak sunucular düşer, uzağı gösteren pencere hesabın sayfasını gösterir', () => {
    writeRaw({
      version: 2,
      local: true,
      remotes: [{ url: 'https://bots.example.com', keyEncrypted: 'AAAA' }],
      shown: 'https://bots.example.com',
    });
    expect(readDesktopConfig(dir)).toEqual({ local: true, shown: 'account', server: null });
  });

  it('sürüm 2: yerel sunucuyu gösteren pencere yerelde kalır', () => {
    writeRaw({ version: 2, local: true, remotes: [], shown: 'local' });
    expect(readDesktopConfig(dir)).toEqual(LOCAL_ONLY);
  });

  it('sürüm 2: yerel sunucusu kapalıysa hesabın sayfası gösterilir', () => {
    writeRaw({
      version: 2,
      local: false,
      remotes: [{ url: 'https://bots.example.com', keyEncrypted: 'AAAA' }],
      shown: 'https://bots.example.com',
    });
    expect(readDesktopConfig(dir)).toEqual({ local: false, shown: 'account', server: null });
  });

  it('sürüm 1: uzak kip hesabın sayfasını gösterir, yerel kip yerelde kalır', () => {
    writeRaw({ mode: 'remote', url: 'https://bots.example.com', keyEncrypted: 'AAAA' });
    expect(readDesktopConfig(dir)).toEqual({ local: false, shown: 'account', server: null });
    writeRaw({ mode: 'local' });
    expect(readDesktopConfig(dir)).toEqual(LOCAL_ONLY);
  });
});

describe('seçimler', () => {
  it('yerel sunucu kapanınca pencere hesabın sayfasına geçer', () => {
    expect(setLocal(LOCAL_ONLY, false)).toEqual({ local: false, shown: 'account', server: null });
  });

  it('kapalı yerel sunucuyu göstermek onu açar', () => {
    const off = setLocal(LOCAL_ONLY, false);
    expect(show(off, 'local')).toEqual(LOCAL_ONLY);
    expect(show(LOCAL_ONLY, 'account').shown).toBe('account');
  });

  it('hesap sunucusu seçmek hesabın sayfasını gösterir, yerel sunucuyu kapatmaz', () => {
    expect(chooseServer(LOCAL_ONLY, 'srv_1')).toEqual({ local: true, shown: 'account', server: 'srv_1' });
  });

  it('seçimi kaldırmak gösterileni değiştirmez', () => {
    const chosen = chooseServer(LOCAL_ONLY, 'srv_1');
    expect(chooseServer(chosen, null)).toEqual({ local: true, shown: 'account', server: null });
  });
});
