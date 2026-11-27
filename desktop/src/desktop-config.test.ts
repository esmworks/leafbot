import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addRemote,
  LOCAL_ONLY,
  lockedRemote,
  mainServer,
  readDesktopConfig,
  removeRemote,
  setLocal,
  show,
  writeDesktopConfig,
  type Crypto,
} from './desktop-config';

const crypto = (open: boolean, decrypts = true): Crypto => ({
  isEncryptionAvailable: () => open,
  encryptString: (s) => Buffer.from(`enc:${s}`),
  decryptString: (b) => {
    if (!decrypts) throw new Error('keyring refused');
    return b.toString().replace(/^enc:/, '');
  },
});

const A = { url: 'https://bots.example.com', key: 'k-1' };
const B = { url: 'https://office.example.com', key: '' };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'leafbot-desktop-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('anahtar zinciri kapalıyken kayıtlı uzak sunucu', () => {
  it('yapılandırmayı yerel saymak yerine uzak sunucunun adını verir', () => {
    writeDesktopConfig(dir, { local: false, remotes: [A], shown: A.url }, crypto(true));
    expect(lockedRemote(dir, crypto(false))).toBe('bots.example.com');
    expect(lockedRemote(dir, crypto(true, false))).toBe('bots.example.com');
    expect(lockedRemote(dir, crypto(true))).toBeNull();
    expect(readDesktopConfig(dir, crypto(true))).toEqual({ local: false, remotes: [A], shown: A.url });
  });

  it('yapılandırma yoksa, yerelse ya da okunamıyorsa beklenecek bir şey yoktur', () => {
    expect(lockedRemote(dir, crypto(false))).toBeNull();
    writeDesktopConfig(dir, LOCAL_ONLY, crypto(false));
    expect(lockedRemote(dir, crypto(false))).toBeNull();
    writeFileSync(join(dir, 'desktop.json'), '{not json');
    expect(lockedRemote(dir, crypto(false))).toBeNull();
    expect(readDesktopConfig(dir, crypto(true))).toEqual(LOCAL_ONLY);
  });
});

describe('eski tek kipli yapılandırma', () => {
  it('uzak kip, yerel sunucu kapalı olarak okunur', () => {
    writeFileSync(
      join(dir, 'desktop.json'),
      JSON.stringify({ mode: 'remote', url: A.url, keyEncrypted: Buffer.from('enc:k-1').toString('base64') }),
    );
    expect(lockedRemote(dir, crypto(false))).toBe('bots.example.com');
    expect(readDesktopConfig(dir, crypto(true))).toEqual({ local: false, remotes: [A], shown: A.url });
  });

  it('yerel kip yalnız bu bilgisayarın sunucusudur', () => {
    writeFileSync(join(dir, 'desktop.json'), JSON.stringify({ mode: 'local' }));
    expect(readDesktopConfig(dir, crypto(true))).toEqual(LOCAL_ONLY);
  });
});

describe('birden çok sunucu', () => {
  it('yazılan liste olduğu gibi geri okunur, anahtarlar şifreli saklanır', () => {
    const cfg = { local: true, remotes: [A, B], shown: B.url };
    writeDesktopConfig(dir, cfg, crypto(true));
    expect(readFileSync(join(dir, 'desktop.json'), 'utf8')).not.toContain('k-1');
    expect(readDesktopConfig(dir, crypto(true))).toEqual(cfg);
  });

  it('uzak sunucu varsa ana sunucu ilk eklenen uzaktır, yoksa bu bilgisayar', () => {
    expect(mainServer(LOCAL_ONLY)).toBe('local');
    const both = addRemote(addRemote(LOCAL_ONLY, A), B);
    expect(mainServer(both)).toBe(A.url);
    expect(mainServer(removeRemote(both, A.url))).toBe(B.url);
  });

  it('uzak eklemek yerel sunucuyu kapatmaz ve eklenen gösterilir', () => {
    expect(addRemote(LOCAL_ONLY, A)).toEqual({ local: true, remotes: [A], shown: A.url });
  });

  it('aynı adres ikinci kez eklenince yeni anahtar alınır, liste uzamaz', () => {
    const again = addRemote(addRemote(LOCAL_ONLY, A), { url: A.url, key: 'k-2' });
    expect(again.remotes).toEqual([{ url: A.url, key: 'k-2' }]);
  });

  it('son sunucu bırakılamaz: uzak yokken yerel kapanmaz, son uzak çıkınca yerel açılır', () => {
    expect(setLocal(LOCAL_ONLY, false)).toEqual(LOCAL_ONLY);
    const remoteOnly = setLocal(addRemote(LOCAL_ONLY, A), false);
    expect(remoteOnly).toEqual({ local: false, remotes: [A], shown: A.url });
    expect(removeRemote(remoteOnly, A.url)).toEqual(LOCAL_ONLY);
  });

  it('gösterilen sunucu çıkarılınca ya da kapanınca pencere ana sunucuyu gösterir', () => {
    const both = addRemote(addRemote(LOCAL_ONLY, A), B);
    expect(removeRemote(both, B.url).shown).toBe(A.url);
    expect(setLocal(show(both, 'local'), false).shown).toBe(A.url);
  });

  it('kapalı yerel sunucuyu göstermek onu açar', () => {
    const remoteOnly = setLocal(addRemote(LOCAL_ONLY, A), false);
    expect(show(remoteOnly, 'local')).toEqual({ local: true, remotes: [A], shown: 'local' });
  });

  it('bilinmeyen bir sunucuyu göstermek ana sunucuya düşer', () => {
    expect(show(addRemote(LOCAL_ONLY, A), 'https://gone.example.com').shown).toBe(A.url);
  });

  it('anahtarı okunamayan uzak dışarıda kalır; başka sunucu kalmazsa yerel açılır', () => {
    writeDesktopConfig(dir, { local: false, remotes: [A], shown: A.url }, crypto(true));
    expect(readDesktopConfig(dir, crypto(true, false))).toEqual(LOCAL_ONLY);
  });
});
