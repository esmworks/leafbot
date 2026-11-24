import type { Approval, Bot, Memory, Thread } from '@leafbot/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testServer, waitFor, type Person, type TestServer } from './helpers';

describe('ekip konuşması', () => {
  let t: TestServer;
  let ayse: Person;
  let mert: Person;
  beforeAll(async () => {
    t = await testServer();
    ayse = await t.person('ayse');
    mert = await t.person('mert');
  });
  afterAll(() => t.dispose());

  const shared = async (name: string) => {
    const bot = await t.bot({ name });
    await t.api<Bot>('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    return bot;
  };
  const teamThread = (botId: string, title = 'Kanal') =>
    t.services.threads.create(botId, { kind: 'team', userId: null, title });
  const say = async (p: Person, threadId: string, text: string) => {
    const r = await p.api('POST', `/api/threads/${threadId}/messages`, {
      clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
      text,
    });
    expect(r.status).toBeLessThan(300);
  };

  it('botla konuşabilen herkes görür; botun kendi işi yine yalnızca yönetenlerin', async () => {
    const bot = await shared('Ortak');
    const team = await teamThread(bot.id);
    const work = await t.services.threads.create(bot.id, { kind: 'bot', userId: null, title: 'İş' });
    for (const p of [ayse, mert]) {
      const listed = (await p.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body.map((x) => x.id);
      expect(listed).toContain(team.id);
      expect(listed).not.toContain(work.id);
      expect((await p.api('GET', `/api/threads/${team.id}/messages`)).status).toBe(200);
      expect((await p.api('GET', `/api/threads/${work.id}/messages`)).status).toBe(404);
    }
    expect(await t.services.access.threadAudience(team.id)).toEqual(
      expect.arrayContaining(['owner', 'ayse', 'mert']),
    );

    // A bot shared with nobody keeps its team conversations to those who may change it.
    const closed = await t.bot({ name: 'Kapalı' });
    const hidden = await teamThread(closed.id);
    expect((await ayse.api('GET', `/api/threads/${hidden.id}/messages`)).status).toBe(404);
  });

  it('turu soran kişi adına çalışır ama yalnızca ekibin verisini kullanır', async () => {
    const bot = await shared('Kanalcı');
    await ayse.api('PATCH', '/api/settings', { userName: 'Ayşe', occupation: 'Gizli meslek' });
    expect(
      (await ayse.api('POST', '/api/memory', { scope: 'user', content: 'Ayşe kedisini çok sever' })).status,
    ).toBe(200);
    const team = await teamThread(bot.id);
    await say(ayse, team.id, 'Bu haftanın özeti ne?');
    await t.services.turns.idle();
    const req = t.engine.requests.filter((r) => r.threadId === team.id).at(-1)!;
    expect(req.systemPrompt).not.toContain('Gizli meslek');
    expect(req.systemPrompt).not.toContain('kedisini');
    expect(req.prompt).toContain('ayse: Bu haftanın özeti ne?');
    const names = req.tools.map((x) => x.name);
    expect(names).not.toContain('routine_create');
    expect(names).not.toContain('routine_read');
    expect(names).not.toContain('bot_send');
    expect(names).not.toContain('app_add');

    // Her own conversation still has all of it.
    const own = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await say(ayse, own.id, 'merhaba');
    await t.services.turns.idle();
    const mine = t.engine.requests.filter((r) => r.threadId === own.id).at(-1)!;
    expect(mine.systemPrompt).toContain('Gizli meslek');
    expect(mine.tools.map((x) => x.name)).toContain('routine_create');
  });

  it('ekip konuşmasında kişiye ait not yazılmaz', async () => {
    const bot = await shared('Notçu');
    const team = await teamThread(bot.id);
    await say(ayse, team.id, '[araç:memory_write {"content":"Ayşe izinde","scope":"user"}]');
    await t.services.turns.idle();
    const notes = (await ayse.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.content);
    expect(notes).not.toContain('Ayşe izinde');
    expect((await t.messages(team.id)).at(-1)!.text).toContain('ekip konuşması');
  });

  it('kartı yalnızca soran kişi ya da botu yöneten yanıtlar; başkasının yazdığı onu yanıtlamaz', async () => {
    const bot = await shared('Soran');
    const team = await teamThread(bot.id);
    const call = { questions: [{ question: 'Hangi şehir?', options: ['İstanbul', 'Ankara'] }] };
    await say(ayse, team.id, `[araç:ask_user ${JSON.stringify(call)}]`);
    const card = await waitFor(async () =>
      (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body.find(
        (a) => a.threadId === team.id,
      ),
    );
    // Only who may answer it is told of it or has it among their waiting cards.
    const told = await t.services.access.noticeAudience(team.id);
    expect(told).toEqual(expect.arrayContaining(['owner', 'ayse']));
    expect(told).not.toContain('mert');
    const waiting = async (p: Person) =>
      (await p.api<Approval[]>('GET', '/api/approvals?status=pending')).body.map((a) => a.id);
    expect(await waiting(ayse)).toContain(card.id);
    expect(await waiting(mert)).not.toContain(card.id);
    // Mert sees the card but cannot answer it, by button or by typing.
    expect((await mert.api('GET', `/api/approvals/${card.id}`)).status).toBe(200);
    const refused = await mert.api('POST', `/api/approvals/${card.id}`, {
      decision: 'allow',
      answer: 'Ankara',
    });
    expect(refused.status).toBe(403);
    await say(mert, team.id, 'Ankara');
    expect((await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body.status).toBe('pending');
    // His line waits behind Ayşe's turn; notices still go to her, not to him.
    const still = await t.services.access.noticeAudience(team.id);
    expect(still).toContain('ayse');
    expect(still).not.toContain('mert');
    // Ayşe's own word answers it.
    await say(ayse, team.id, 'İstanbul');
    await waitFor(
      async () => (await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body.status === 'allowed',
    );
    expect((await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body.answer).toBe('İstanbul');
    await t.services.turns.idle();
  });

  it('ekip konuşmasını yalnızca botu yönetenler yeniden adlandırır, siler ya da boşaltır', async () => {
    const bot = await shared('Yönetilen');
    const team = await teamThread(bot.id);
    expect((await mert.api('PATCH', `/api/threads/${team.id}`, { title: 'Benim' })).status).toBe(403);
    expect((await mert.api('DELETE', `/api/threads/${team.id}`)).status).toBe(403);
    // Writing in it stays open to him.
    await say(mert, team.id, 'selam');
    await t.services.turns.idle();
    expect((await t.api('PATCH', `/api/threads/${team.id}`, { title: 'Satış kanalı' })).status).toBe(200);
    expect((await t.api('DELETE', `/api/threads/${team.id}`)).status).toBeLessThan(300);
  });
});
