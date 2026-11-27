import { createHash } from 'node:crypto';
import { CHROME_EXTENSION_ID, CHROME_MAX_TEXT } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { EXTENSION_KEY, manifest } from '../manifest';
import { answerAsk, type Browser, type OpenTab } from './share';

const TABS: OpenTab[] = [
  { id: 1, url: 'https://ornek.com/a', title: 'A' },
  { id: 2, url: 'chrome://settings', title: 'Ayarlar' },
  { id: 3, url: 'https://haber.com/', title: 'Haber' },
  { id: 4, url: 'file:///Users/ali/not.txt', title: 'not' },
];

function browser(opts: { allowed?: string[]; answer?: boolean; text?: string } = {}) {
  const asked: { origin: string; bot: string | null }[] = [];
  const read: number[] = [];
  const b: Browser = {
    tabs: async () => TABS,
    front: async () => TABS[2]!,
    tab: async (id) => TABS.find((x) => x.id === id) ?? null,
    mayRead: async (origin) => (opts.allowed ?? []).includes(origin),
    askToRead: async (origin, bot) => {
      asked.push({ origin, bot });
      return opts.answer ?? false;
    },
    text: async (id) => {
      read.push(id);
      return opts.text ?? 'Sayfanın yazısı';
    },
  };
  return { b, asked, read };
}

describe('Chrome’un cevabı', () => {
  it('paylaşma kapalıyken hiçbir şeye bakmaz', async () => {
    const { b, asked, read } = browser({ allowed: ['https://haber.com'] });
    expect(await answerAsk({ kind: 'read' }, false, b)).toEqual({ ok: false, reason: 'off' });
    expect(asked).toEqual([]);
    expect(read).toEqual([]);
  });

  it('yalnız web sekmelerini, öndekini başta listeler', async () => {
    const { b } = browser();
    expect(await answerAsk({ kind: 'tabs' }, true, b)).toEqual({
      ok: true,
      kind: 'tabs',
      tabs: [
        { id: 3, url: 'https://haber.com/', title: 'Haber', active: true },
        { id: 1, url: 'https://ornek.com/a', title: 'A', active: false },
      ],
    });
  });

  it('izinli sitenin sayfasını sormadan okur', async () => {
    const { b, asked } = browser({ allowed: ['https://haber.com'] });
    expect(await answerAsk({ kind: 'read' }, true, b)).toEqual({
      ok: true,
      kind: 'read',
      tab: { id: 3, url: 'https://haber.com/', title: 'Haber', active: true },
      text: 'Sayfanın yazısı',
      cut: false,
    });
    expect(asked).toEqual([]);
  });

  it('yeni bir siteyi kişiye sorar; izin vermezse okumaz', async () => {
    const no = browser();
    expect(await answerAsk({ kind: 'read', tabId: 1, bot: 'Araştırmacı' }, true, no.b)).toEqual({
      ok: false,
      reason: 'denied',
    });
    expect(no.asked).toEqual([{ origin: 'https://ornek.com', bot: 'Araştırmacı' }]);
    expect(no.read).toEqual([]);

    const yes = browser({ answer: true });
    const r = await answerAsk({ kind: 'read', tabId: 1 }, true, yes.b);
    expect(r.ok && r.kind === 'read' && r.tab.id).toBe(1);
    expect(yes.read).toEqual([1]);
  });

  it('web sayfası olmayan ya da olmayan sekmeyi okumaz', async () => {
    const { b, asked } = browser({ answer: true });
    expect(await answerAsk({ kind: 'read', tabId: 2 }, true, b)).toEqual({ ok: false, reason: 'notWeb' });
    expect(await answerAsk({ kind: 'read', tabId: 4 }, true, b)).toEqual({ ok: false, reason: 'notWeb' });
    expect(await answerAsk({ kind: 'read', tabId: 99 }, true, b)).toEqual({ ok: false, reason: 'notFound' });
    expect(await answerAsk({ kind: 'yaz' }, true, b)).toEqual({ ok: false, reason: 'failed' });
    expect(asked).toEqual([]);
  });

  it('uzun sayfayı keser ve bunu söyler', async () => {
    const { b } = browser({ allowed: ['https://haber.com'], text: 'a'.repeat(CHROME_MAX_TEXT + 5) });
    const r = await answerAsk({ kind: 'read' }, true, b);
    expect(r.ok && r.kind === 'read' && [r.text.length, r.cut]).toEqual([CHROME_MAX_TEXT, true]);
  });

  it('okurken bir hata olursa “okunamadı” der', async () => {
    const { b } = browser({ allowed: ['https://haber.com'] });
    b.text = async () => {
      throw new Error('Cannot access contents of the page');
    };
    expect(await answerAsk({ kind: 'read' }, true, b)).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('uzantının kimliği', () => {
  it('manifestteki anahtar sunucunun tanıdığı kimliği verir', () => {
    // Chrome's id: the first 32 hex digits of the key's SHA-256, each written as a letter a–p.
    const hex = createHash('sha256').update(Buffer.from(EXTENSION_KEY, 'base64')).digest('hex').slice(0, 32);
    const id = [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
    expect(id).toBe(CHROME_EXTENSION_ID);
    expect(manifest('1.0.0').key).toBe(EXTENSION_KEY);
  });

  it('kurulurken hiçbir siteye erişim istemez', () => {
    const m = manifest('1.0.0') as Record<string, unknown>;
    expect(m.host_permissions).toBeUndefined();
    expect(m.content_scripts).toBeUndefined();
    expect(m.permissions).toEqual(['sidePanel', 'storage', 'tabs', 'scripting']);
  });
});
