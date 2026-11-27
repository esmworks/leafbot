import type { BotSummary, Message, SearchHit, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { excerptAround } from '../src/services/threads';
import { testServer, type TestServer } from './helpers';

describe('arama', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('mesajları bot ve sohbetiyle bulur; büyük/küçük harf ve joker karakter gözetmez', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'Fatura numarası 100%_özel');
    await t.services.turns.idle();
    const hits = (await t.api<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent('FATURA')}`)).body;
    expect(hits.map((h) => [h.role, h.botId, h.threadId])).toEqual([
      ['assistant', bot.id, thread.id],
      ['user', bot.id, thread.id],
    ]);
    expect((await t.api<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent('%_')}`)).body).toHaveLength(
      2,
    );
    expect((await t.api<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent('_x')}`)).body).toHaveLength(
      0,
    );
    expect((await t.api<SearchHit[]>('GET', '/api/search?q=a')).body).toEqual([]);
  });

  it('Türkçe harflerde büyük/küçük harfi gözetmez; noktasız ı ile I eşleşir', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.services.threads.addMessage({
      threadId: thread.id,
      role: 'assistant',
      author: `bot:${bot.id}`,
      text: 'ŞEHİR İSTANBUL, ürün Iğdır',
    });
    const found = async (q: string) =>
      (await t.api<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent(q)}`)).body.length;
    for (const q of ['şehir', 'istanbul', 'İSTANBUL', 'ÜRÜN', 'ığdır', 'IĞDIR'])
      expect(await found(q), q).toBe(1);
    expect(await found('izmir')).toBe(0);
  });

  it('satır sonuyla bölünmüş ifadeyi de bulur', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'Toplantı notu: kira\n  sözleşmesi yenilenecek');
    await t.services.turns.idle();
    const hits = (await t.api<SearchHit[]>('GET', `/api/search?q=${encodeURIComponent('kira  sözleşmesi')}`))
      .body;
    expect(hits.find((h) => h.role === 'user')!.excerpt).toContain('kira sözleşmesi');
  });

  it('eşleşmenin çevresini kısaltır', () => {
    const long = `${'a '.repeat(200)}İĞNE${' b'.repeat(200)}`;
    const out = excerptAround(long, 'iğne', 40);
    expect(out).toContain('İĞNE');
    expect(out.startsWith('…') && out.endsWith('…')).toBe(true);
  });

  it('kenar çubuğu önizlemesi Markdown işaretlerini göstermez', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, '[sessiz]');
    await t.services.turns.idle();
    await t.send(thread.id, '## Özet\n- **Kira** [sözleşmesi](https://ornek.com) `yarın`');
    await t.services.turns.idle();
    const preview = (await t.api<Thread>('GET', `/api/threads/${thread.id}`)).body.preview;
    expect(preview).toContain('Özet Kira sözleşmesi yarın');
  });

  it('mesajlar sayfa sayfa: before ile daha eskileri gelir', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    for (let i = 0; i < 6; i++) {
      await t.services.threads.addMessage({
        threadId: thread.id,
        role: 'user',
        author: 'user',
        text: `m${i}`,
      });
    }
    const all = await t.services.threads.messages(thread.id);
    const page = await t.services.threads.messages(thread.id, { limit: 2, before: all[4]!.id });
    expect(page.map((m) => m.text)).toEqual(['m2', 'm3']);
    const r = await t.api<Message[]>('GET', `/api/threads/${thread.id}/messages?before=${all[2]!.id}`);
    expect(r.body.map((m) => m.text)).toEqual(['m0', 'm1']);
    const latest = await t.api<Message[]>('GET', `/api/threads/${thread.id}/messages?limit=2`);
    expect(latest.body.map((m) => m.text)).toEqual(['m4', 'm5']);
    const older = await t.api<Message[]>(
      'GET',
      `/api/threads/${thread.id}/messages?limit=2&before=${all[4]!.id}`,
    );
    expect(older.body.map((m) => m.text)).toEqual(['m2', 'm3']);
    expect((await t.api('GET', `/api/threads/${thread.id}/messages?limit=0`)).status).toBe(400);
    const other = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    expect((await t.api('GET', `/api/threads/${other.id}/messages?before=${all[2]!.id}`)).status).toBe(404);
  });

  it('threadId verilince yalnız o sohbette arar, limit sonuç sayısını sınırlar', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const main = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const other = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    for (const [thread, text] of [
      [main.id, 'kira bir'],
      [main.id, 'kira iki'],
      [other.id, 'kira üç'],
    ] as const) {
      await t.services.threads.addMessage({ threadId: thread, role: 'user', author: 'user', text });
    }
    const scoped = (await t.api<SearchHit[]>('GET', `/api/search?q=kira&threadId=${main.id}`)).body;
    expect(scoped.map((h) => h.excerpt)).toEqual(['kira iki', 'kira bir']);
    expect((await t.api<SearchHit[]>('GET', '/api/search?q=kira&limit=1')).body).toHaveLength(1);
  });

  it('özet botun son yazdığı zamanı verir; kişinin mesajı bunu değiştirmez', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const summary = async () =>
      (await t.api<BotSummary[]>('GET', '/api/summaries')).body.find((x) => x.botId === bot.id)!;
    expect((await summary()).repliedAt).toBeNull();
    const reply = await t.services.threads.addMessage({
      threadId: thread.id,
      role: 'assistant',
      author: `bot:${bot.id}`,
      text: 'merhaba',
    });
    expect((await summary()).repliedAt).toBe(reply.message.createdAt);
    await t.services.threads.addMessage({ threadId: thread.id, role: 'user', author: 'user', text: 'selam' });
    expect((await summary()).repliedAt).toBe(reply.message.createdAt);
  });
});
