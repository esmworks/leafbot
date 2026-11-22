import type { Approval, Group, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isServerKey } from '../src/i18n';
import { AUTH, testServer, waitFor, type TestServer } from './helpers';

describe('dil', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const english = () => t.api('PATCH', '/api/settings', { language: 'en' });

  it('dil seçilene kadar boştur; yalnızca desteklenen diller kaydedilir', async () => {
    expect((await t.api<{ language?: string }>('GET', '/api/settings')).body.language).toBeUndefined();
    expect((await t.api('PATCH', '/api/settings', { language: 'fr' })).status).toBe(400);
    expect((await english()).status).toBe(200);
    expect((await t.api<{ language?: string }>('GET', '/api/settings')).body.language).toBe('en');
  });

  it('hata mesajı sayfanın istediği dilde, o yoksa sunucunun dilinde', async () => {
    const get = async (headers: Record<string, string>) => {
      const res = await t.app.inject({
        method: 'GET',
        url: '/api/bots/yok',
        headers: { ...AUTH, host: 'localhost', ...headers },
      });
      return { status: res.statusCode, error: (res.json() as { error: string }).error };
    };
    expect(await get({ 'accept-language': 'en-GB,en;q=0.9' })).toEqual({
      status: 404,
      error: 'Bot not found',
    });
    expect((await get({ 'accept-language': 'tr-TR' })).error).toBe('Bot bulunamadı');
    expect((await get({})).error).toBe('Bot bulunamadı');
    // The server's own text is not in German; a German page reads it in English, not Turkish.
    expect((await get({ 'accept-language': 'de-DE' })).error).toBe('Bot not found');
    await english();
    expect((await get({})).error).toBe('Bot not found');
    expect((await get({ 'accept-language': 'de-DE' })).error).toBe('Bot not found');
  });

  it('erişim reddi de çevrilir', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/api/bots',
      headers: { host: 'localhost', 'accept-language': 'en' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'Access key required' });
  });

  it('İngilizce sunucu: bot istemi, izin kartı ve durdurma satırı İngilizce', async () => {
    await english();
    const bot = await t.bot({ name: 'Katip' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:Bash {"command":"npm test"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(card.summary).toBe('Katip wants to run a command on the computer.');
    const prompt = t.engine.requests.at(-1)!.systemPrompt;
    expect(prompt).toContain('You are an assistant bot named "Katip".');
    expect(prompt).toContain('Reply in English unless the user writes in another language.');
    expect(t.engine.requests.at(-1)!.locale).toBe('en');

    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toBe('Stopped.');
  });

  it('Almanca: sunucu metni İngilizce kalır, bot Almanca yanıt vermesi söylenir', async () => {
    expect((await t.api('PATCH', '/api/settings', { language: 'de' })).status).toBe(200);
    const bot = await t.bot({ name: 'Katip' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:Bash {"command":"npm test"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(card.summary).toBe('Katip wants to run a command on the computer.');
    const prompt = t.engine.requests.at(-1)!.systemPrompt;
    expect(prompt).toContain('You are an assistant bot named "Katip".');
    expect(prompt).toContain('Reply in German unless the user writes in another language.');
  });

  it('İngilizce sunucu: botlar arası iş satırları ve araç sonuçları İngilizce', async () => {
    await english();
    const g = (await t.api<Group>('POST', '/api/groups', { name: 'Team' })).body;
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    await t.bot({ name: 'Ayşe', groupId: g.id });
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:bot_send {"bot":"Ayşe","message":"is the report ready"}]');
    await t.services.turns.idle();
    let msgs = await t.messages(ta.id);
    expect(msgs.find((m) => m.role === 'marker')!.text).toBe('Message sent to Ayşe');
    expect(msgs.at(-1)!.text).toContain('Ayşe replied (done)');

    // A bot cannot give work to itself.
    await t.send(ta.id, '[araç:bot_send {"bot":"Ali","message":"hello"}]');
    await t.services.turns.idle();
    msgs = await t.messages(ta.id);
    expect(msgs.at(-1)!.text).toContain('Error: Ali cannot write to Ali');
  });

  it('yalnızca kataloğun kendi anahtarlarını anahtar sayar', () => {
    expect(isServerKey('turn.stopped')).toBe(true);
    expect(isServerKey('constructor')).toBe(false);
    expect(isServerKey('toString')).toBe(false);
  });
});
