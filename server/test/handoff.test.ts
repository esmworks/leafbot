import { describe, expect, it } from 'vitest';
import { cutAt, truncate } from '../src/util';
import {
  HANDOFF_CHARS,
  HANDOFF_MESSAGE_CHARS,
  HANDOFF_MESSAGES,
  handoffPrompt,
  withinBudget,
} from '../src/runtime/prompt';

const msg = (role: string, text: string, author = role === 'user' ? 'user' : 'bot:b') => ({
  role,
  author,
  text,
});
const names = new Map([['bot:b', 'Kahya']]);

describe('geçmişi yeni oturuma devretme', () => {
  it('geçmiş yoksa istemi olduğu gibi bırakır', () => {
    expect(
      handoffPrompt({ messages: [msg('user', 'merhaba')], prompt: 'merhaba', names, locale: 'tr' }),
    ).toBe('merhaba');
  });

  it('bota daha eskisini nasıl bulacağını söyler', () => {
    const out = handoffPrompt({
      messages: [msg('user', 'soru'), msg('assistant', 'cevap'), msg('user', 'yeni')],
      prompt: 'yeni',
      names,
      locale: 'tr',
    });
    expect(out).toContain('conversations_search');
    expect(out).toContain('message_read');
  });

  it('bildirecek bir şey bulmayan rutin çalışmasının talimatını devretmez', () => {
    const out = handoffPrompt({
      messages: [
        msg('user', 'soru'),
        msg('assistant', 'cevap'),
        {
          role: 'user',
          author: 'routine:r1',
          text: 'Mailleri kontrol et',
          props: { routineName: 'Mail kontrolü', routineQuiet: true },
        },
        msg('user', 'ikinci soru'),
        msg('assistant', 'ikinci cevap'),
        msg('user', 'yeni'),
      ],
      prompt: 'yeni',
      names,
      locale: 'tr',
    });
    expect(out).toContain('ikinci cevap');
    expect(out).not.toContain('Mailleri kontrol et');
  });

  it('her satıra mesajın kimliğini koyar; kısaltılan mesajın tamamının nasıl okunacağını söyler', () => {
    const out = handoffPrompt({
      messages: [
        { id: 'm-1', ...msg('user', 'soru') },
        { id: 'm-2', ...msg('assistant', 'x'.repeat(HANDOFF_MESSAGE_CHARS + 50)) },
        { id: 'm-3', ...msg('user', 'yeni') },
      ],
      prompt: 'yeni',
      names,
      locale: 'tr',
    });
    expect(out).toContain('Kullanıcı [m-1]: soru');
    expect(out).toContain('Kahya [m-2]: ');
    expect(out).toContain('message_read ile m-2');
    expect(out).not.toContain('[m-3]');
  });

  it('eski oturumun özetini son mesajlardan önce devreder', () => {
    const out = handoffPrompt({
      messages: [msg('user', 'soru'), msg('assistant', '<yanıt-1>'), msg('user', 'yeni')],
      prompt: 'yeni',
      summary: 'ÖZET: fatura no 42',
      names,
      locale: 'tr',
    });
    expect(out).toContain('ÖZET: fatura no 42');
    expect(out.indexOf('ÖZET')).toBeLessThan(out.indexOf('<yanıt-1>'));
    // A bot that cannot look earlier talk up is not pointed to it.
    const plain = handoffPrompt({
      messages: [{ id: 'm-9', ...msg('user', 'soru') }, msg('assistant', '<yanıt-1>'), msg('user', 'yeni')],
      prompt: 'yeni',
      recall: false,
      names,
      locale: 'tr',
    });
    expect(plain).not.toContain('message_read');
    expect(plain).not.toContain('m-9');
    // A summary alone still goes along.
    expect(
      handoffPrompt({
        messages: [msg('user', 'yeni')],
        prompt: 'yeni',
        summary: 'ÖZET',
        names,
        locale: 'tr',
      }),
    ).toContain('ÖZET');
  });

  it('kartları, hataları ve cevapsız son mesajları almaz', () => {
    const out = handoffPrompt({
      messages: [
        msg('user', 'soru'),
        msg('approval', 'kart', 'bot:b'),
        msg('assistant', 'cevap'),
        msg('error', 'hata', 'system'),
        msg('user', 'yeni'),
      ],
      prompt: 'yeni',
      names,
      locale: 'tr',
    });
    expect(out).toContain('Kullanıcı: soru\n\nKahya: cevap');
    expect(out).not.toContain('kart');
    expect(out).not.toContain('hata');
    expect(out.split('yeni')).toHaveLength(2);
  });

  it('uzun mesajı kısaltır, yalnızca son mesajları ve sınır kadarını alır', () => {
    const many = Array.from({ length: HANDOFF_MESSAGES + 10 }, (_, i) =>
      msg(i % 2 ? 'assistant' : 'user', `m${i} ` + 'x'.repeat(HANDOFF_MESSAGE_CHARS)),
    );
    const out = handoffPrompt({ messages: many, prompt: 'son', names, locale: 'en' });
    expect(out).not.toContain('m0 ');
    expect(out).toContain(`m${many.length - 1} `);
    expect(out).toContain('…');
    expect(out.length).toBeLessThan(HANDOFF_CHARS + 1_000);
    expect(out).toContain('<earlier-conversation>');
  });
});

describe('kısaltma', () => {
  it('emojiyi ortadan bölmez', () => {
    expect(cutAt('ab😀', 3)).toBe('ab');
    expect(truncate('selam 👋🏽 dünya', 8)).toBe('selam …');
    expect(cutAt('a❤️', 2)).toBe('a❤');
    expect(cutAt('kısa', 10)).toBe('kısa');
  });
});

describe('hafıza bütçesi', () => {
  it('sığmayanları en eskilerden bırakır ve sayısını verir', () => {
    const m = (content: string, day: number) => ({
      content,
      createdAt: `2026-11-${String(day).padStart(2, '0')}T00:00:00Z`,
    });
    const r = withinBudget([m('a'.repeat(10), 1), m('b'.repeat(10), 3)], [m('c'.repeat(10), 2)], 27);
    expect(r.user.map((x) => x.content[0])).toEqual(['b']);
    expect(r.bot.map((x) => x.content[0])).toEqual(['c']);
    expect(r.left).toBe(1);
  });

  it('eski ama yakında aranıp bulunan ya da düzeltilen not, kimsenin bakmadığı yeni notun önüne geçer', () => {
    const day = (d: number) => `2026-11-${String(d).padStart(2, '0')}T00:00:00.000Z`;
    const looked = { content: 'a'.repeat(10), createdAt: day(1), updatedAt: day(1), lastUsedAt: day(15) };
    const edited = { content: 'b'.repeat(10), createdAt: day(2), updatedAt: day(14), lastUsedAt: null };
    const fresh = { content: 'c'.repeat(10), createdAt: day(10), updatedAt: day(10), lastUsedAt: null };
    const r = withinBudget([looked, fresh], [edited], 27);
    expect(r.user).toEqual([looked]);
    expect(r.bot).toEqual([edited]);
    expect(r.left).toBe(1);
  });
});
