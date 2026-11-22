import type { Memory, MemoryChange, MemoryFlag, TodayReport } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { FLAG_EXPIRE_MS, FLAGS_PER_TURN } from '../src/services/memory-flags';
import { parseFlagAnswer } from '../src/services/memory-tidy';
import { testServer, waitFor, type TestServer } from './helpers';

describe('hafıza işaretleri: botun bilmediğini söylemesi', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const db = () => t.services.ctx.db;
  const main = async (botId: string) =>
    (await t.api<{ id: string }>('GET', `/api/bots/${botId}/main-thread`)).body.id;
  const say = async (threadId: string, text: string) => {
    await t.send(threadId, text);
    await t.services.turns.idle();
    return (await t.messages(threadId)).at(-1)!.text;
  };
  const flag = (input: object) => `[araç:memory_flag ${JSON.stringify(input)}]`;
  const flags = async () => (await t.api<MemoryFlag[]>('GET', '/api/memory/flags')).body;
  const notes = async () => (await t.api<Memory[]>('GET', '/api/memory')).body;
  const rows = () => db().select().from(schema.memoryFlags);

  it('eksik bilgi işaretlenir, aynısı yeniden sayılır, Today sayısında görünür', async () => {
    const bot = await t.bot({ name: 'Satış' });
    const th = await main(bot.id);
    expect(await say(th, flag({ kind: 'missing', about: 'Bu ayın yeni fiyat listesi' }))).toContain(
      'İşaret bırakıldı',
    );
    const [f] = await flags();
    expect(f).toMatchObject({
      kind: 'missing',
      scope: 'bot',
      botId: bot.id,
      about: 'Bu ayın yeni fiyat listesi',
      count: 1,
      status: 'open',
      threadId: th,
      outside: false,
    });
    // The same gap in other words is the same flag, counted again.
    expect(await say(th, flag({ kind: 'missing', about: 'Yeni fiyat listesi bu ay' }))).toContain(
      'zaten işaretliydi',
    );
    expect(await flags()).toMatchObject([{ id: f!.id, count: 2 }]);
    const today = (await t.api<TodayReport>('GET', '/api/today')).body;
    expect(today.openFlags).toBe(1);
  });

  it('bir turda en fazla üç işaret; "wrong" bir not ya da beceri ister', async () => {
    const bot = await t.bot({ name: 'Satış' });
    const th = await main(bot.id);
    const many = ['Kargo firması', 'İade süresi', 'Depo adresi', 'Fatura unvanı']
      .map((about) => flag({ kind: 'missing', about }))
      .join(' ');
    expect(await say(th, many)).toContain(`en fazla ${FLAGS_PER_TURN} işaret`);
    expect(await flags()).toHaveLength(FLAGS_PER_TURN);
    expect(await say(th, flag({ kind: 'wrong', about: 'Fiyat' }))).toContain('kind "wrong"');
    expect(await say(th, flag({ kind: 'wrong', about: 'Fiyat', skill: 'yok-boyle' }))).toContain(
      'adında bir becerin yok',
    );
  });

  it('yanlış not işaretlenir; kişinin cevabı notu günceller ve işareti kapatır', async () => {
    const bot = await t.bot({ name: 'Rapor' });
    const th = await main(bot.id);
    const note = await t.services.memory.create({
      scope: 'bot',
      botId: bot.id,
      content: 'Tıklamalar clicks sütununda',
      source: `bot:${bot.id}`,
    });
    await say(
      th,
      flag({
        kind: 'wrong',
        about: 'Tıklama sütunu',
        seen: 'Tabloda clicks yok, link_clicks var',
        note: note.id,
      }),
    );
    const [f] = await flags();
    expect(f).toMatchObject({ kind: 'wrong', memoryId: note.id, note: 'Tıklamalar clicks sütununda' });

    const res = await t.api('POST', `/api/memory/flags/${f!.id}/answer`, {
      text: 'Tıklamalar link_clicks sütununda',
    });
    expect(res.status).toBe(200);
    expect((await t.services.memory.get(note.id)).content).toBe('Tıklamalar link_clicks sütununda');
    expect(await flags()).toEqual([]);
    const [row] = await rows();
    expect(row).toMatchObject({ status: 'resolved', resolvedBy: 'user:owner' });
  });

  it('eksik bilginin cevabı kişinin kendi notu olur; "gerek yok" işareti kaldırır', async () => {
    const bot = await t.bot({ name: 'Satış' });
    const th = await main(bot.id);
    await say(th, flag({ kind: 'missing', about: 'Kargo firması' }));
    await say(th, flag({ kind: 'missing', about: 'Depo adresi bilgisi' }));
    const [a, b] = await flags();
    await t.api('POST', `/api/memory/flags/${a!.id}/answer`, { text: 'Kargo Aras ile gider' });
    const written = (await notes()).find((m) => m.content === 'Kargo Aras ile gider')!;
    expect(written).toMatchObject({ scope: 'bot', botId: bot.id, source: 'user' });
    await t.api('POST', `/api/memory/flags/${b!.id}/dismiss`);
    expect(await flags()).toEqual([]);
    expect((await rows()).map((r) => r.status).sort()).toEqual(['dismissed', 'resolved']);
    // A flag already settled is not there to answer.
    expect((await t.api('POST', `/api/memory/flags/${b!.id}/answer`, { text: 'x' })).status).toBe(404);
  });

  it('not başka biri tarafından değişince ya da silinince işaret kapanır', async () => {
    const bot = await t.bot({ name: 'Rapor' });
    const th = await main(bot.id);
    const one = await t.services.memory.create({ scope: 'bot', botId: bot.id, content: 'A', source: 'user' });
    const two = await t.services.memory.create({ scope: 'bot', botId: bot.id, content: 'B', source: 'user' });
    await say(th, flag({ kind: 'wrong', about: 'A notu', note: one.id }));
    await say(th, flag({ kind: 'wrong', about: 'B notu', note: two.id }));
    await t.services.memory.update(one.id, { content: 'A yeni' }, `bot:${bot.id}`);
    await t.services.memory.remove(two.id, 'user:owner');
    expect(await flags()).toEqual([]);
    expect((await rows()).every((r) => r.status === 'resolved' && r.resolvedBy === 'note-changed')).toBe(
      true,
    );
  });

  it('botu değiştiremeyen biri işareti görmez ve cevaplayamaz', async () => {
    const bot = await t.bot({ name: 'Satış' });
    const th = await main(bot.id);
    await say(th, flag({ kind: 'missing', about: 'Kargo firması' }));
    const [f] = await flags();
    const ayse = await t.person('ayse', 'member');
    expect((await ayse.api<MemoryFlag[]>('GET', '/api/memory/flags')).body).toEqual([]);
    expect((await ayse.api('POST', `/api/memory/flags/${f!.id}/answer`, { text: 'x' })).status).toBe(404);
    expect((await ayse.api('POST', `/api/memory/flags/${f!.id}/dismiss`)).status).toBe(404);
  });

  it('hafızası kapalı botta araç yoktur', async () => {
    const bot = await t.bot({ name: 'Unutkan', memory: false });
    const th = await main(bot.id);
    await say(th, flag({ kind: 'missing', about: 'Kargo firması' }));
    expect(await rows()).toEqual([]);
  });

  it('konuşma incelemesi kişinin sözüyle işareti kapatır', async () => {
    await t.services.settings.update({ memoryReviewEvery: 10 });
    const bot = await t.bot({ name: 'Satış' });
    const th = await main(bot.id);
    await say(th, flag({ kind: 'missing', about: 'Kargo firması' }));
    const [f] = await flags();
    t.engine.completer = () =>
      JSON.stringify({ operations: [{ op: 'resolve', flag: f!.id, content: 'Kargo Aras ile gider' }] });
    for (let i = 1; i <= 8; i++) await say(th, `mesaj ${i}`);
    await say(th, 'Bu arada kargoyu Aras ile gönderiyoruz');
    await t.services.memoryReview.idle();
    const asked = t.engine.completions.at(-1)!;
    expect(asked.user).toContain('<flags>');
    expect(asked.user).toContain(f!.id);
    expect((await notes()).map((m) => m.content)).toContain('Kargo Aras ile gider');
    expect(await flags()).toEqual([]);
    expect((await rows())[0]).toMatchObject({ status: 'resolved', resolvedBy: 'review' });
  });

  it('dış metinden sonra bırakılan işaret incelemeye girmez, sayfası okunmaz, öyle işaretli görünür', async () => {
    const bot = await t.bot({ name: 'Satış', internet: true });
    const th = await main(bot.id);
    await t.services.memoryFlags.raise({
      kind: 'missing',
      about: 'Kargo firması',
      seen: null,
      memoryId: null,
      skillId: null,
      sourceUrl: 'https://kotu.example/cevap',
      botId: bot.id,
      userId: 'owner',
      place: null,
      outside: 'email',
      threadId: th,
      turnId: 'tur-1',
    });
    expect(await t.services.memoryFlags.forReview(bot.id, 'owner', null)).toEqual([]);
    expect(await t.services.memoryFlags.withUnreadPage(10)).toEqual([]);
    expect(await flags()).toMatchObject([{ outside: true }]);
  });

  describe('botun gösterdiği sayfa', () => {
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

    it('cevap öneri olarak bekler; kabul işareti kapatır, sayfa bir kez okunur', async () => {
      const bot = await t.bot({ name: 'Satış', internet: true });
      const th = await main(bot.id);
      await say(th, flag({ kind: 'missing', about: 'Kargo firması', where: 'https://ornek.com/kargo' }));
      const read = page('Kargolarımız Aras ile gönderilir.');
      t.engine.completer = () => JSON.stringify({ answer: 'Kargo Aras ile gider' });
      await t.services.memoryTidy.runAll();
      expect(read).toEqual(['https://ornek.com/kargo']);
      // Nothing is written until the person says yes.
      expect((await notes()).map((m) => m.content)).not.toContain('Kargo Aras ile gider');
      const [change] = (await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body;
      expect(change).toMatchObject({
        action: 'write',
        content: 'Kargo Aras ile gider',
        origin: { kind: 'flag', name: 'Satış' },
        sourceUrl: 'https://ornek.com/kargo',
      });
      expect(await flags()).toMatchObject([{ status: 'proposed' }]);
      // It still waits for the person, so it is counted as the list shows it.
      expect((await t.api<TodayReport>('GET', '/api/today')).body.openFlags).toBe(1);
      await t.services.memoryTidy.runAll();
      expect(read).toHaveLength(1);
      await t.api('POST', `/api/memory-changes/${change!.id}/accept`, {});
      expect((await notes()).map((m) => m.content)).toContain('Kargo Aras ile gider');
      expect((await rows())[0]).toMatchObject({ status: 'resolved', resolvedBy: 'source' });
    });

    it('reddedilen öneri işareti kaldırır; cevapsız sayfa yeniden okunmaz', async () => {
      const bot = await t.bot({ name: 'Satış', internet: true });
      const th = await main(bot.id);
      await say(th, flag({ kind: 'missing', about: 'Kargo firması', where: 'https://ornek.com/kargo' }));
      await say(th, flag({ kind: 'missing', about: 'İade süresi kaç gün', where: 'https://ornek.com/iade' }));
      const read = page('Hakkımızda');
      t.engine.completer = (req) =>
        JSON.stringify({ answer: req.user.includes('Kargo') ? 'Kargo Aras ile gider' : null });
      await t.services.memoryTidy.runAll();
      await t.services.memoryTidy.runAll();
      expect(read.sort()).toEqual(['https://ornek.com/iade', 'https://ornek.com/kargo']);
      const [change] = (await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body;
      await t.api('DELETE', `/api/memory-changes/${change!.id}`);
      const left = await flags();
      expect(left).toMatchObject([{ about: 'İade süresi kaç gün', status: 'open' }]);
      expect((await rows()).find((r) => r.about === 'Kargo firması')).toMatchObject({ status: 'dismissed' });
    });

    it('kişi bekleyen öneriyi beklemeden kendi cevaplarsa öneri kalkar', async () => {
      const bot = await t.bot({ name: 'Satış', internet: true });
      const th = await main(bot.id);
      await say(th, flag({ kind: 'missing', about: 'Kargo firması', where: 'https://ornek.com/kargo' }));
      page('Kargolarımız Aras ile gönderilir.');
      t.engine.completer = () => JSON.stringify({ answer: 'Kargo Aras ile gider' });
      await t.services.memoryTidy.runAll();
      const [f] = await flags();
      expect(f).toMatchObject({ status: 'proposed' });
      await t.api('POST', `/api/memory/flags/${f!.id}/answer`, { text: 'Kargo Yurtiçi ile gider' });
      expect((await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body).toEqual([]);
      expect((await rows())[0]).toMatchObject({ status: 'resolved', resolution: 'Kargo Yurtiçi ile gider' });
    });

    it('sayfasını okuyamayan botların işaretleri öbürlerinin sırasını tutmaz', async () => {
      const off = await t.bot({ name: 'Kapalı', internet: false });
      const on = await t.bot({ name: 'Açık', internet: true });
      const offThread = await main(off.id);
      for (let i = 0; i < 12; i++) {
        await t.services.memoryFlags.raise({
          kind: 'missing',
          about: `Konu ${i} ${'x'.repeat(i)}`,
          seen: null,
          memoryId: null,
          skillId: null,
          sourceUrl: `https://ornek.com/${i}`,
          botId: off.id,
          userId: 'owner',
          place: null,
          outside: null,
          threadId: offThread,
          turnId: `tur-${i}`,
        });
      }
      await say(
        await main(on.id),
        flag({ kind: 'missing', about: 'Kargo firması', where: 'https://ornek.com/kargo' }),
      );
      const read = page('Aras');
      t.engine.completer = () => JSON.stringify({ answer: null });
      await t.services.memoryTidy.runAll();
      expect(read).toEqual(['https://ornek.com/kargo']);
    });

    it('internete kapalı botun sayfası okunmaz', async () => {
      const bot = await t.bot({ name: 'Satış', internet: false });
      const th = await main(bot.id);
      await say(th, flag({ kind: 'missing', about: 'Kargo firması', where: 'https://ornek.com/kargo' }));
      const read = page('Aras');
      await t.services.memoryTidy.runAll();
      expect(read).toEqual([]);
    });

    it('yalnızca açık bir JSON cevabı alınır', () => {
      expect(parseFlagAnswer('{"answer":"Aras"}')).toBe('Aras');
      expect(parseFlagAnswer('{"answer":null}')).toBeNull();
      expect(parseFlagAnswer('{"answer":"  "}')).toBeNull();
      expect(parseFlagAnswer('bilmiyorum')).toBeNull();
    });
  });

  it('tek kez işaretlenip 60 gün bekleyen düşer, tekrarlanan kalır', async () => {
    const bot = await t.bot({ name: 'Satış' });
    const th = await main(bot.id);
    await say(th, flag({ kind: 'missing', about: 'Kargo firması' }));
    await say(th, flag({ kind: 'missing', about: 'Depo adresi bilgisi' }));
    await say(th, flag({ kind: 'missing', about: 'Depo adresi bilgisi' }));
    const old = new Date(Date.now() - FLAG_EXPIRE_MS - 86_400_000);
    await db().update(schema.memoryFlags).set({ lastSeenAt: old });
    t.now.value = new Date();
    expect(await t.services.memoryFlags.expire()).toBe(1);
    expect((await flags()).map((f) => f.about)).toEqual(['Depo adresi bilgisi']);
  });

  it('durdurulan tur bıraktığı işareti de geri alır', async () => {
    const bot = await t.bot({ name: 'Satış' });
    const th = await main(bot.id);
    await t.send(th, `${flag({ kind: 'missing', about: 'Kargo firması' })} [bekle:5000] uzun iş`);
    await waitFor(async () => (await rows()).length === 1);
    await t.api('POST', `/api/threads/${th}/stop`);
    await t.services.turns.idle(3000);
    expect(await rows()).toEqual([]);
  });

  it('başka turda yeniden sayılan işaret, ilk turu geri alınınca bir eksilir ama kalır', async () => {
    const bot = await t.bot({ name: 'Satış' });
    const th = await main(bot.id);
    const raise = (turnId: string) =>
      t.services.memoryFlags.raise({
        kind: 'missing',
        about: 'Kargo firması',
        seen: null,
        memoryId: null,
        skillId: null,
        sourceUrl: null,
        botId: bot.id,
        userId: 'owner',
        place: null,
        outside: null,
        threadId: th,
        turnId,
      });
    await raise('tur-1');
    await raise('tur-2');
    await t.services.memoryFlags.dropForTurn('tur-1');
    expect(await rows()).toMatchObject([{ count: 1, status: 'open' }]);
  });

  it('geri alınan tur bıraktığı işareti de geri alır', async () => {
    const bot = await t.bot({ name: 'Satış' });
    const th = await main(bot.id);
    await say(
      th,
      `[araç:memory_write {"content":"Kargo"}] ${flag({ kind: 'missing', about: 'Kargo firması' })}`,
    );
    const [row] = await rows();
    const res = await t.api('POST', `/api/turns/${row!.turnId}/undo`);
    expect(res.status).toBe(200);
    expect(
      await db().select().from(schema.memoryFlags).where(eq(schema.memoryFlags.turnId, row!.turnId!)),
    ).toEqual([]);
  });
});
