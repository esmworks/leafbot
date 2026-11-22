import type { Memory, MemoryTidyStatus, UsageReport } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Settings } from '../src/services/settings';
import { noteSets, parseTidy, parseVerdict, servedText, TIDY_ACTOR } from '../src/services/memory-tidy';
import { testServer, type TestServer } from './helpers';

describe('haftalık hafıza düzenlemesi: tekrar eden ve çelişen notları toparlama', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
    // The notes are written on the machine's clock; the tidy-up reads the same one.
    t.now.value = new Date();
  });
  afterEach(() => t.dispose());

  const ops = (...list: object[]) => JSON.stringify({ operations: list });
  /** A bot's own note, as the bot writes it while it works. */
  const note = (
    botId: string,
    content: string,
    extra: Partial<Parameters<TestServer['services']['memory']['create']>[0]> = {},
  ) => t.services.memory.create({ scope: 'bot', botId, content, source: `bot:${botId}`, ...extra });
  const contents = async (botId: string) =>
    (await t.services.memory.list({ scope: 'bot', botId })).map((m) => m.content).sort();
  const tidyNow = async () => {
    const r = await t.api<{ started: boolean }>('POST', '/api/memory-tidy');
    expect(r.status).toBe(200);
    await t.services.memoryTidy.idle();
  };
  /** Five notes, the least a set needs to be looked at. */
  const fiveNotes = async (botId: string) => {
    const list: Memory[] = [];
    for (const c of [
      'Teslimat salı',
      'Teslimatlar salı günü',
      'Fiyat 100 TL',
      'Fiyat 120 TL',
      'Ofis Kadıköy',
    ])
      list.push(await note(botId, c));
    return list;
  };

  it('tekrar edenleri birleştirir, çelişeni düzeltir ve siler; geçmişte düzenleme olarak görünür', async () => {
    const bot = await t.bot({ name: 'Satış' });
    const [a, b, c, d] = await fiveNotes(bot.id);
    t.engine.completer = () =>
      ops(
        { op: 'merge', ids: [a!.id, b!.id], content: 'Teslimatlar salı günü yapılır' },
        { op: 'forget', id: c!.id },
        { op: 'update', id: d!.id, content: 'Fiyat 120 TL (güncel)' },
      );
    await tidyNow();
    expect(await contents(bot.id)).toEqual([
      'Fiyat 120 TL (güncel)',
      'Ofis Kadıköy',
      'Teslimatlar salı günü yapılır',
    ]);
    // The merged note is the newer one of the two, with the new words.
    expect((await t.services.memory.get(b!.id)).content).toBe('Teslimatlar salı günü yapılır');

    // One call, with every note of the set, its id, date and words, as data.
    expect(t.engine.completions).toHaveLength(1);
    const asked = t.engine.completions[0]!;
    expect(asked.user).toContain('<notes>');
    for (const m of [a, b, c, d]) expect(asked.user).toContain(`[${m!.id}]`);
    expect(asked.user).toContain(new Date().toISOString().slice(0, 10));
    expect(asked.system).toContain('<notes>');

    const hist = (await t.api<{ actor: string; action: string }[]>('GET', '/api/memory-history')).body;
    expect(
      hist
        .filter((l) => l.actor === TIDY_ACTOR)
        .map((l) => l.action)
        .sort(),
    ).toEqual(['delete', 'delete', 'update', 'update']);
    const status = (await t.api<MemoryTidyStatus>('GET', '/api/memory-tidy')).body;
    expect(status).toMatchObject({ running: false, last: { sets: 1, merged: 1, updated: 1, forgot: 1 } });
    // What the call cost shows on the usage page, apart from the bots' turns.
    const usage = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(usage.tidy).toEqual({ sets: 1, sources: 0, costUsd: 0.001, changed: 3 });
    expect(usage.total.costUsd).toBe(0);
  });

  it('kişinin yazdığı ve sabitlediği notlara dokunmaz; gösterilmeyen ya da iki kez anılan nota da', async () => {
    const bot = await t.bot({ name: 'Yardımcı' });
    const mine = await t.services.memory.create({
      scope: 'bot',
      botId: bot.id,
      content: 'Kahve şekersiz',
      source: 'user',
    });
    const pinned = await note(bot.id, 'Toplantılar pazartesi');
    await t.services.memory.update(pinned.id, { pinned: true }, 'user:owner');
    const [a, b, c] = await fiveNotes(bot.id);
    t.engine.completer = () =>
      ops(
        { op: 'forget', id: mine.id },
        { op: 'update', id: pinned.id, content: 'değişti' },
        { op: 'merge', ids: [mine.id, a!.id], content: 'karışık' },
        { op: 'forget', id: 'yok-boyle-bir-not' },
        { op: 'update', id: b!.id, content: 'Teslimat salı (düzeltildi)' },
        { op: 'forget', id: b!.id },
        { op: 'update', id: c!.id, content: '' },
      );
    await tidyNow();
    const left = await contents(bot.id);
    expect(left).toContain('Kahve şekersiz');
    expect(left).toContain('Toplantılar pazartesi');
    expect(left).toContain('Teslimat salı');
    expect(left).toContain('Teslimat salı (düzeltildi)');
    expect(left).toContain('Fiyat 100 TL');
    expect(left).toHaveLength(7);
    // The person's own are shown, marked, so the model can settle the others by them.
    const asked = t.engine.completions[0]!;
    expect(asked.user).toContain(`[${mine.id}]`);
    expect(asked.user).toMatch(new RegExp(`\\[${mine.id}\\][^\\n]*\\[kişinin yazdığı\\]`));
    expect(asked.user).toMatch(new RegExp(`\\[${pinned.id}\\][^\\n]*\\[sabit\\]`));
  });

  it('bir geçişte notların ancak bir kısmını siler: model hepsini silmek istese de', async () => {
    const bot = await t.bot({ name: 'Çok' });
    const list: Memory[] = [];
    for (let i = 1; i <= 10; i++) list.push(await note(bot.id, `Not ${i}`));
    t.engine.completer = () => ops(...list.map((m) => ({ op: 'forget', id: m.id })));
    await tidyNow();
    expect(await contents(bot.id)).toHaveLength(7);
  });

  it('farklı sitelerin ya da farklı tarihlere kadar geçerli notlarını birleştirmez', async () => {
    const bot = await t.bot({ name: 'Gezgin' });
    const [a, b, c] = await fiveNotes(bot.id);
    const site = await note(bot.id, 'Giriş düğmesi sağ üstte', { site: 'ornek.com' });
    const until = await note(bot.id, 'Bu hafta izinli', {
      validUntil: new Date(Date.now() + 3 * 86_400_000).toISOString(),
    });
    t.engine.completer = () =>
      ops(
        { op: 'merge', ids: [a!.id, site.id], content: 'karışık' },
        { op: 'merge', ids: [b!.id, until.id], content: 'karışık' },
        { op: 'merge', ids: [c!.id, c!.id], content: 'tek not' },
      );
    await tidyNow();
    expect(await contents(bot.id)).not.toContain('karışık');
    expect(await contents(bot.id)).not.toContain('tek not');
    expect(await contents(bot.id)).toHaveLength(7);
  });

  it('haftada bir ve yalnızca notlar değiştiyse bakar; az notlu kümeye hiç bakmaz', async () => {
    const bot = await t.bot({ name: 'Takvim' });
    const small = await t.bot({ name: 'Az' });
    await fiveNotes(bot.id);
    await note(small.id, 'Tek not');
    await t.services.memoryTidy.runDue();
    expect(t.engine.completions).toHaveLength(1);
    // A day later nothing is due.
    t.now.value = new Date(t.now.value.getTime() + 86_400_000);
    await t.services.memoryTidy.runDue();
    expect(t.engine.completions).toHaveLength(1);
    // A week later, with no note changed, still nothing.
    t.now.value = new Date(t.now.value.getTime() + 7 * 86_400_000);
    await t.services.memoryTidy.runDue();
    expect(t.engine.completions).toHaveLength(1);
    // A changed note brings the set back.
    await note(bot.id, 'Yeni bilgi');
    await t.services.memoryTidy.runDue();
    expect(t.engine.completions).toHaveLength(2);
  });

  it('kişinin ortak notlarını, onları yazan botun modeliyle düzenler; yalnızca kişinin yazdıklarından oluşan kümeye bakmaz', async () => {
    const bot = await t.bot({ name: 'Asistan' });
    const own: Memory[] = [];
    for (const c of ['Adı Erhan', 'İsmi Erhan', 'Bursa', 'Çay sever', 'Kahve sevmez'])
      own.push(
        await t.services.memory.create({ scope: 'user', botId: null, content: c, source: `bot:${bot.id}` }),
      );
    t.engine.completer = () => ops({ op: 'merge', ids: [own[0]!.id, own[1]!.id], content: 'Adı Erhan' });
    await tidyNow();
    const user = (await t.services.memory.list({ scope: 'user' })).map((m) => m.content).sort();
    expect(user).toEqual(['Adı Erhan', 'Bursa', 'Kahve sevmez', 'Çay sever']);

    // A set of only the person's own words: no call at all.
    const before = t.engine.completions.length;
    for (const m of await t.services.memory.list({ scope: 'user' }))
      await t.services.memory.remove(m.id, 'user');
    for (const c of ['a', 'b', 'c', 'd', 'e'])
      await t.services.memory.create({ scope: 'user', botId: null, content: c, source: 'user' });
    await tidyNow();
    expect(t.engine.completions).toHaveLength(before);
  });

  it('varsayılan açıktır; kapalıyken bakmaz, şimdi düzenle reddedilir; yalnızca sunucuyu yöneten başlatır', async () => {
    expect(Settings.parse({}).memoryTidy).toBe(true);
    const bot = await t.bot({ name: 'Kapalı' });
    await fiveNotes(bot.id);
    const member = await t.person('uye');
    expect((await member.api('POST', '/api/memory-tidy')).status).toBe(403);
    expect((await member.api('PATCH', '/api/settings', { memoryTidy: false })).status).toBe(403);
    expect((await t.api('PATCH', '/api/settings', { memoryTidy: false })).status).toBe(200);
    await t.services.memoryTidy.runDue();
    expect((await t.api('POST', '/api/memory-tidy')).status).toBe(409);
    expect(t.engine.completions).toHaveLength(0);
  });

  it('modelin cevabını dikkatle okur: bozuk öğeler atılır, en çok 30 işlem alınır', () => {
    expect(parseTidy('olmaz')).toEqual([]);
    expect(parseTidy('{"operations":"x"}')).toEqual([]);
    expect(
      parseTidy(
        'Şöyle: {"operations":[{"op":"forget","id":"a"},{"op":"merge","ids":["b"],"content":"x"},{"op":"zap"},{"op":"update","id":"c","content":"y"}]}',
      ),
    ).toEqual([
      { op: 'forget', id: 'a' },
      { op: 'update', id: 'c', content: 'y' },
    ]);
    const many = JSON.stringify(Array.from({ length: 40 }, (_, i) => ({ op: 'forget', id: `n${i}` })));
    expect(parseTidy(many)).toHaveLength(30);
  });

  it('süresi geçmiş notlar ve az notlu kümeler kümelere girmez', () => {
    const now = new Date('2026-11-20T00:00:00Z');
    const base = {
      status: 'active' as const,
      site: null,
      source: 'bot:b',
      lastUsedAt: null,
      useCount: 0,
      createdAt: '2026-11-01T00:00:00Z',
      updatedAt: '2026-11-01T00:00:00Z',
    };
    const make = (i: number, extra: Partial<Memory> = {}): Memory => ({
      ...base,
      id: `m${i}`,
      scope: 'bot',
      botId: 'b',
      content: `n${i}`,
      ...extra,
    });
    const notes = [1, 2, 3, 4].map((i) => make(i));
    expect(noteSets([...notes, make(5, { validUntil: '2026-11-19T00:00:00Z' })], now)).toEqual([]);
    expect(noteSets([...notes, make(5)], now).map((s) => [s.key, s.notes.length])).toEqual([['bot:b', 5]]);
  });

  describe('notu alındığı sayfayla karşılaştırma', () => {
    /** A page that says `text`, and every address read. */
    const page = (text: string) => {
      const read: string[] = [];
      t.services.memoryTidy.readPage = async (url) => {
        read.push(url.href);
        return {
          body: Buffer.from(`<html><body><p>${text}</p></body></html>`),
          contentType: 'text/html',
          url,
        };
      };
      return read;
    };
    /** The model's word on a note against its page; the other calls get no change. */
    const verdict = (answer: object) => {
      t.engine.completer = (req) => (req.user.includes('<note>') ? JSON.stringify(answer) : ops());
    };
    const later = (days: number) => (t.now.value = new Date(t.now.value.getTime() + days * 86_400_000));

    it('sayfa artık başka bir şey diyorsa notu düzeltir; sayfası kalır, geçmişte düzenleme olarak görünür', async () => {
      const bot = await t.bot({ name: 'Fiyat' });
      const m = await note(bot.id, 'Kalem 10 TL', { sourceUrl: 'https://ornek.com/kalem#fiyat' });
      const read = page('Kalem fiyatı: 12 TL');
      verdict({ verdict: 'changed', content: 'Kalem 12 TL' });
      // A note just written was read from its page moments ago.
      await tidyNow();
      expect(read).toEqual([]);
      later(8);
      await tidyNow();
      expect(read).toEqual(['https://ornek.com/kalem']);
      const asked = t.engine.completions.find((c) => c.user.includes('<note>'))!;
      expect(asked.user).toContain('<note>Kalem 10 TL</note>');
      expect(asked.user).toContain('Kalem fiyatı: 12 TL');
      expect(asked.user).not.toContain('<p>');
      const after = await t.services.memory.get(m.id);
      expect(after).toMatchObject({ content: 'Kalem 12 TL', sourceUrl: 'https://ornek.com/kalem#fiyat' });
      const hist = (await t.api<{ actor: string; action: string }[]>('GET', '/api/memory-history')).body;
      expect(hist.at(-1)).toMatchObject({ actor: TIDY_ACTOR, action: 'update' });
      expect((await t.api<MemoryTidyStatus>('GET', '/api/memory-tidy')).body.last).toMatchObject({
        checked: 1,
        updated: 1,
      });
      const usage = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
      expect(usage.tidy).toMatchObject({ sources: 1, changed: 1 });
      // Read again only a month later.
      later(8);
      await tidyNow();
      expect(read).toHaveLength(1);
      later(31);
      await tidyNow();
      expect(read).toHaveLength(2);
    });

    it('aynıysa, emin değilse, sayfa okunamazsa ya da cevap notu büyütüyorsa dokunmaz', async () => {
      const bot = await t.bot({ name: 'Fiyat' });
      const same = await note(bot.id, 'Kalem 10 TL', { sourceUrl: 'https://ornek.com/a' });
      later(8);
      const read = page('Kalem 10 TL');
      verdict({ verdict: 'same' });
      await tidyNow();
      verdict({ verdict: 'changed', content: 'x'.repeat(500) });
      later(31);
      await tidyNow();
      // Both looks read the page; neither changed the note.
      expect(read).toHaveLength(2);
      t.services.memoryTidy.readPage = async () => {
        throw new Error('site kapalı');
      };
      verdict({ verdict: 'changed', content: 'Kalem 99 TL' });
      later(31);
      await tidyNow();
      expect((await t.services.memory.get(same.id)).content).toBe('Kalem 10 TL');
    });

    it('internete kapalı botun, kişinin yazdığı ya da sabitlediği notun sayfasına bakmaz', async () => {
      const offline = await t.bot({ name: 'Kapalı' });
      await t.api('PATCH', `/api/bots/${offline.id}`, { internet: false });
      await note(offline.id, 'Kalem 10 TL', { sourceUrl: 'https://ornek.com/a' });
      const bot = await t.bot({ name: 'Açık' });
      await t.services.memory.create({
        scope: 'bot',
        botId: bot.id,
        content: 'Silgi 5 TL',
        source: 'user',
        sourceUrl: 'https://ornek.com/b',
      });
      const pinned = await note(bot.id, 'Defter 20 TL', { sourceUrl: 'https://ornek.com/c' });
      await t.services.memory.update(pinned.id, { pinned: true }, 'user:owner');
      const read = page('her şey değişti');
      later(8);
      await tidyNow();
      expect(read).toEqual([]);
    });

    it('cevabı ve sayfa metnini dikkatle okur', () => {
      expect(parseVerdict('olmaz')).toEqual({ verdict: 'unclear' });
      expect(parseVerdict('{"verdict":"changed"}')).toEqual({ verdict: 'unclear' });
      expect(parseVerdict('{"verdict":"changed","content":" yeni "}')).toEqual({
        verdict: 'changed',
        content: 'yeni',
      });
      expect(parseVerdict('{"verdict":"same"}')).toEqual({ verdict: 'same' });
      expect(
        servedText({ body: Buffer.from('<script>x</script><b>Merhaba</b> dünya'), contentType: 'text/html' }),
      ).toBe('Merhaba dünya');
      expect(servedText({ body: Buffer.from('a\n\nb'), contentType: 'text/plain' })).toBe('a b');
      expect(servedText({ body: Buffer.from('%PDF'), contentType: 'application/pdf' })).toBeNull();
    });
  });
});
