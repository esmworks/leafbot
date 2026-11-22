import type { Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { cleanTitle } from '../src/services/titles';
import { testServer, type TestServer } from './helpers';

describe('sohbet başlığını model yazar', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
    await t.api('PATCH', '/api/settings', { modelTitles: true });
  });
  afterEach(() => t.dispose());

  const thread = async (botId: string) =>
    (await t.api<Thread>('POST', `/api/bots/${botId}/threads`, {})).body;
  const titleOf = async (botId: string, id: string) =>
    (await t.api<Thread[]>('GET', `/api/bots/${botId}/threads`)).body.find((x) => x.id === id)!.title;

  it('ilk cevaptan sonra başlık modelin yazdığıyla değişir; bir kez', async () => {
    t.engine.completer = (req) => (req.system.includes('başlık') ? '"Fatura itirazı."' : '{"operations":[]}');
    const bot = await t.bot();
    const th = await thread(bot.id);
    await t.send(th.id, 'merhaba, geçen ayın faturasında bir yanlışlık var sanırım');
    await t.services.turns.idle();
    await t.services.titles.idle();
    expect(await titleOf(bot.id, th.id)).toBe('Fatura itirazı');
    const asked = t.engine.completions.filter((r) => r.system.includes('başlık'));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.user).toContain('faturasında');
    // What the naming cost is kept, for the usage page and the spending limits.
    const calls = await t.db.db.select().from(schema.backgroundCalls);
    expect(calls.filter((c) => c.kind === 'title')).toMatchObject([{ botId: bot.id, costUsd: 0.001 }]);

    t.engine.completer = () => 'Başka başlık';
    await t.send(th.id, 'devam');
    await t.services.turns.idle();
    await t.services.titles.idle();
    expect(await titleOf(bot.id, th.id)).toBe('Fatura itirazı');
  });

  it('kişinin verdiği başlığa dokunmaz; ayar kapalıyken modele sorulmaz', async () => {
    t.engine.completer = () => 'Model başlığı';
    const bot = await t.bot();
    const named = await thread(bot.id);
    await t.api('PATCH', `/api/threads/${named.id}`, { title: 'Benim adım' });
    await t.send(named.id, 'merhaba');
    await t.services.turns.idle();
    await t.services.titles.idle();
    expect(await titleOf(bot.id, named.id)).toBe('Benim adım');

    await t.api('PATCH', '/api/settings', { modelTitles: false });
    const off = await thread(bot.id);
    await t.send(off.id, 'kapalıyken yazılan ilk mesaj');
    await t.services.turns.idle();
    await t.services.titles.idle();
    expect(await titleOf(bot.id, off.id)).toBe('kapalıyken yazılan ilk mesaj');
    expect(t.engine.completions).toHaveLength(0);
  });

  it('modelin cevabından başlığı temiz alır', () => {
    expect(cleanTitle('Başlık: "Kargo gecikmesi"\nAçıklama...')).toBe('Kargo gecikmesi');
    expect(cleanTitle('## Weekly report plan.')).toBe('Weekly report plan');
    expect(cleanTitle('   ')).toBe('');
  });
});
