import type { Memory, MemoryChange, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type Person, type TestServer } from './helpers';

/** A page on the public internet, by address, so no name has to be looked up. */
const PAGE = '[izin:WebFetch {"url":"https://93.184.216.34/haber"}]';

describe('bütün botların ortak bilgisi', () => {
  let t: TestServer;
  let ayse: Person;
  beforeEach(async () => {
    t = await testServer();
    ayse = await t.person('ayse');
  });
  afterEach(() => t.dispose());

  const main = async (who: { api: TestServer['api'] }, botId: string) =>
    (await who.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const notes = async () => (await t.api<Memory[]>('GET', '/api/memory')).body;
  const changes = async (who: { api: TestServer['api'] } = t) =>
    (await who.api<MemoryChange[]>('GET', '/api/memory-changes')).body;
  const tool = (name: string, input: Record<string, unknown>) => `[araç:${name} ${JSON.stringify(input)}]`;

  it('sunucuya bakan yazar, her botun istemine gider; üye görür ama yazamaz, değiştiremez', async () => {
    const made = await t.api<Memory>('POST', '/api/memory', {
      scope: 'common',
      content: 'Şirketin adresi Kadıköy',
    });
    expect(made.status).toBeLessThan(300);
    expect(made.body).toMatchObject({ scope: 'common', botId: null, userId: null });

    const bot = await t.bot({ name: 'Ali' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    const sent = await ayse.api('POST', `/api/threads/${(await main(ayse, bot.id)).id}/messages`, {
      clientId: 'ortak-bilgi-1',
      text: 'merhaba',
    });
    expect(sent.status).toBeLessThan(300);
    await t.services.turns.idle();
    const prompt = t.engine.requests.at(-1)!.systemPrompt;
    expect(prompt).toContain('Ortak bilgi');
    expect(prompt).toContain('Şirketin adresi Kadıköy');

    expect((await ayse.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.content)).toContain(
      'Şirketin adresi Kadıköy',
    );
    expect((await ayse.api('POST', '/api/memory', { scope: 'common', content: 'x' })).status).toBe(403);
    expect((await ayse.api('PATCH', `/api/memory/${made.body.id}`, { content: 'y' })).status).toBe(403);
    expect((await ayse.api('DELETE', `/api/memory/${made.body.id}`)).status).toBe(403);
  });

  it('misafirin ya da WhatsApp kişisinin turuna gitmez', async () => {
    await t.api('POST', '/api/memory', { scope: 'common', content: 'İç kural: indirim yok' });
    const bot = await t.bot();
    const seen = (common: boolean) => t.services.memory.visibleTo(bot.id, null, null, common);
    expect((await seen(true)).common.map((m) => m.content)).toEqual(['İç kural: indirim yok']);
    expect((await seen(false)).common).toEqual([]);
  });

  it('botun yazması, değiştirmesi ve silmesi öneri olur; yalnızca sunucuya bakan karar verir', async () => {
    const bot = await t.bot({ name: 'Ali', permissionMode: 'auto' });
    const th = await main(t, bot.id);
    await t.send(th.id, tool('memory_write', { content: 'Toplantılar pazartesi', scope: 'common' }));
    await t.services.turns.idle();
    expect((await notes()).filter((m) => m.scope === 'common')).toEqual([]);
    const [write] = await changes();
    expect(write).toMatchObject({
      action: 'write',
      scope: 'common',
      content: 'Toplantılar pazartesi',
      origin: { kind: 'bot', name: 'Ali' },
    });
    // A member decides nothing on it.
    expect(await changes(ayse)).toEqual([]);
    expect((await ayse.api('POST', `/api/memory-changes/${write!.id}/accept`)).status).toBeGreaterThanOrEqual(
      400,
    );

    expect((await t.api('POST', `/api/memory-changes/${write!.id}/accept`)).status).toBeLessThan(300);
    const [note] = (await notes()).filter((m) => m.scope === 'common');
    expect(note).toMatchObject({ content: 'Toplantılar pazartesi' });

    await t.send(th.id, tool('memory_update', { id: note!.id, content: 'Toplantılar salı' }));
    await t.send(th.id, tool('memory_forget', { id: note!.id }));
    await t.services.turns.idle();
    expect((await notes()).find((m) => m.id === note!.id)?.content).toBe('Toplantılar pazartesi');
    expect((await changes()).map((c) => [c.action, c.memoryId])).toEqual([
      ['update', note!.id],
      ['forget', note!.id],
    ]);
  });

  it('dış metin okuyan turun önerisi bunu söyler', async () => {
    const bot = await t.bot({ name: 'Ali', permissionMode: 'auto', internet: true });
    await t.send(
      (await main(t, bot.id)).id,
      `${PAGE} ${tool('memory_write', { content: 'Fiyatlar arttı', scope: 'common' })}`,
    );
    await t.services.turns.idle();
    expect((await changes())[0]).toMatchObject({ origin: { kind: 'outside', name: 'Ali' } });
  });
});
