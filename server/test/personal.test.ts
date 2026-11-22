import {
  MAX_CONNECTIONS,
  type Bot,
  type Connection,
  type Memory,
  type MemoryChange,
  type Message,
  type Routine,
  type RoutineRun,
  type Thread,
  type VaultLogin,
} from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { translator } from '../src/i18n';
import { OWNER_ID } from '../src/users';
import { newId } from '../src/util';
import { testServer, type Person, type TestServer } from './helpers';

describe('her kişinin kendisine ait olanlar', () => {
  let t: TestServer;
  let ayse: Person;
  let mert: Person;
  let admin: Person;
  beforeAll(async () => {
    t = await testServer();
    ayse = await t.person('ayse');
    mert = await t.person('mert');
    admin = await t.person('yonetici', 'admin');
  });
  afterAll(() => t.dispose());

  const shared = async (name: string) => {
    const bot = await t.bot({ name });
    await t.api<Bot>('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    return bot;
  };
  const say = async (p: Person, threadId: string, text: string) => {
    const r = await p.api('POST', `/api/threads/${threadId}/messages`, {
      clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
      text,
    });
    expect(r.status).toBeLessThan(300);
  };

  it('profil kişinindir; sunucu ayarını yalnızca yöneten değiştirir', async () => {
    await t.api('PATCH', '/api/settings', { userName: 'Erhan' });
    expect((await ayse.api('PATCH', '/api/settings', { userName: 'Ayşe', occupation: 'Satış' })).status).toBe(
      200,
    );
    expect((await ayse.api<Record<string, unknown>>('GET', '/api/settings')).body.userName).toBe('Ayşe');
    expect((await t.api<Record<string, unknown>>('GET', '/api/settings')).body.userName).toBe('Erhan');
    // Until they say their name, they are called by their username.
    expect((await mert.api<Record<string, unknown>>('GET', '/api/settings')).body.userName).toBe('mert');
    // The owner's own words about themselves are not anyone else's.
    await t.api('PATCH', '/api/settings', { focus: 'work', occupation: 'Mühendis', aboutMe: 'Kedim var' });
    const theirs = (await mert.api<Record<string, unknown>>('GET', '/api/settings')).body;
    expect(theirs.focus).toBeUndefined();
    expect(theirs.occupation ?? '').toBe('');
    expect(theirs.aboutMe ?? '').toBe('');
    // What every bot uses is the server's, not one member's.
    expect((await ayse.api('PATCH', '/api/settings', { effort: 'low' })).status).toBe(403);

    // The bot calls each person by their own name.
    const bot = await shared('Profil');
    const thread = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await say(ayse, thread.id, 'merhaba');
    await t.services.turns.idle();
    const prompt = t.engine.requests.filter((r) => r.botId === bot.id).at(-1)!.systemPrompt;
    expect(prompt).toContain('Ayşe');
    expect(prompt).not.toContain('Erhan');
    expect(prompt).not.toContain('Mühendis');
    expect(prompt).not.toContain('Kedim var');
  });

  it('kişinin hakkındaki notları yalnızca kendisi ve onun için çalışan bot görür', async () => {
    const bot = await shared('Not');
    expect(
      (await ayse.api('POST', '/api/memory', { scope: 'user', content: 'Ayşe çayı demli içer' })).status,
    ).toBe(200);
    expect((await ayse.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.content)).toContain(
      'Ayşe çayı demli içer',
    );
    expect((await mert.api<Memory[]>('GET', '/api/memory')).body).toEqual([]);
    expect((await t.api<Memory[]>('GET', '/api/memory')).body.some((m) => m.content.includes('Ayşe'))).toBe(
      false,
    );
    // A member may not write a bot's notes straight away.
    expect(
      (await ayse.api('POST', '/api/memory', { scope: 'bot', botId: bot.id, content: 'x' })).status,
    ).toBe(403);
    expect((await ayse.api('POST', '/api/memory', { scope: 'bot', content: 'x' })).status).toBe(404);

    const mine = (await t.services.memory.visibleTo(bot.id, 'ayse')).user.map((m) => m.content);
    const his = (await t.services.memory.visibleTo(bot.id, 'mert')).user.map((m) => m.content);
    expect(mine).toContain('Ayşe çayı demli içer');
    expect(his).not.toContain('Ayşe çayı demli içer');
  });

  it('yalnızca konuşabilen kişinin konuşmasında bot notu hemen yazılır; kimse onaya çağrılmaz', async () => {
    const bot = await shared('Ekip');
    const thread = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await say(ayse, thread.id, '[araç:memory_write {"content":"Raporlar cuma gider","scope":"bot"}]');
    await t.services.turns.idle();
    const [note] = await t.services.memory.list({ scope: 'bot', botId: bot.id });
    expect(note).toMatchObject({
      content: 'Raporlar cuma gider',
      source: `bot:${bot.id}`,
      threadId: thread.id,
    });
    // Nothing waits for anyone, and no card asked.
    expect((await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body).toEqual([]);
    expect((await ayse.api<MemoryChange[]>('GET', '/api/memory-changes')).body).toEqual([]);
    // The bot corrects and forgets its own note in her conversation too.
    await say(
      ayse,
      thread.id,
      `[araç:memory_update {"id":"${note!.id}","content":"Raporlar perşembe gider"}]`,
    );
    await t.services.turns.idle();
    expect((await t.services.memory.get(note!.id)).content).toBe('Raporlar perşembe gider');
    await say(ayse, thread.id, `[araç:memory_forget {"id":"${note!.id}"}]`);
    await t.services.turns.idle();
    expect(await t.services.memory.list({ scope: 'bot', botId: bot.id })).toEqual([]);
    expect((await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body).toEqual([]);
  });

  it('yalnızca konuşabilen kişinin konuşmasını gözden geçirirken özel bilgiyi kişinin kendi notuna yazması söylenir', async () => {
    const bot = await shared('Gözcü');
    const thread = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    for (const text of ['bir', 'iki', 'üç']) await say(ayse, thread.id, text);
    await t.services.turns.idle();
    const before = t.engine.completions.length;
    await t.services.memoryReview.onContextReset(thread.id);
    await t.services.memoryReview.idle();
    const asked = t.engine.completions.slice(before).find((c) => c.user.includes('<conversation>'));
    expect(asked!.system).toContain('yalnızca "user" kapsamına');
    // The owner's own conversation gets no such line.
    const own = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    for (const text of ['bir', 'iki', 'üç']) await t.send(own.id, text);
    await t.services.turns.idle();
    const mark = t.engine.completions.length;
    await t.services.memoryReview.onContextReset(own.id);
    await t.services.memoryReview.idle();
    const mine = t.engine.completions.slice(mark).find((c) => c.user.includes('<conversation>'));
    expect(mine!.system).not.toContain('yalnızca "user" kapsamına');
  });

  it('kişisel bağlantı yalnızca sahibinin işinde kullanılır; takımınkini yalnızca yöneten kurar', async () => {
    const bot = await shared('Bağlı');
    const own = await ayse.api<Connection>('POST', '/api/connections', {
      name: 'Ayşenin CRM',
      url: 'https://crm.example.invalid/mcp',
      auth: 'none',
      allBots: true,
    });
    expect(own.status).toBe(200);
    expect(own.body.userId).toBe('ayse');
    expect((await ayse.api<Connection[]>('GET', '/api/connections')).body.map((c) => c.id)).toContain(
      own.body.id,
    );
    expect((await mert.api<Connection[]>('GET', '/api/connections')).body.map((c) => c.id)).not.toContain(
      own.body.id,
    );
    expect((await mert.api('GET', `/api/connections/${own.body.id}`)).status).toBe(404);
    expect((await mert.api('DELETE', `/api/connections/${own.body.id}`)).status).toBe(404);
    // Even those who look after the server do not see a person's own.
    expect((await admin.api('GET', `/api/connections/${own.body.id}`)).status).toBe(404);

    expect(
      (
        await ayse.api('POST', '/api/connections', {
          name: 'Takım',
          url: 'https://team.example.invalid/mcp',
          auth: 'none',
          team: true,
        })
      ).status,
    ).toBe(403);
    // The server calls the address itself: a member may not point it at itself or its network.
    for (const url of ['http://127.0.0.1:9/mcp', 'http://localhost:9/mcp', 'http://10.0.0.5/mcp']) {
      expect((await ayse.api('POST', '/api/connections', { name: 'İç', url, auth: 'none' })).status).toBe(
        400,
      );
    }
    const team = await admin.api<Connection>('POST', '/api/connections', {
      name: 'Takım',
      url: 'https://team.example.invalid/mcp',
      auth: 'none',
      allBots: true,
      team: true,
    });
    expect(team.status).toBe(200);
    expect(team.body.userId).toBeNull();
    expect((await mert.api<Connection[]>('GET', '/api/connections')).body.map((c) => c.id)).toContain(
      team.body.id,
    );
    expect((await mert.api('PATCH', `/api/connections/${team.body.id}`, { name: 'Benim' })).status).toBe(403);
    // A person's own opened to a bot they may not talk with is refused.
    const hidden = await t.bot({ name: 'Gizli' });
    expect(
      (await ayse.api('PUT', `/api/connections/${own.body.id}/bots`, { allBots: false, botIds: [hidden.id] }))
        .status,
    ).toBe(404);

    const down = async (person: string) =>
      (await t.services.connections.unavailableFor(bot.id, person)).map((c) => c.name);
    expect(await down('ayse')).toContain('Ayşenin CRM');
    expect(await down('mert')).not.toContain('Ayşenin CRM');
    const tools = await t.services.connections.toolsFor(
      bot.id,
      'mert',
      translator('tr'),
      new AbortController().signal,
    );
    expect(tools.some((x) => x.name.includes('crm'))).toBe(false);
  });

  it('rutini değiştiren onun kişisi olur; koşuları ve raporu yalnızca o kişinin görebildiği yerde durur', async () => {
    const bot = await t.bot({ name: 'Rutinli' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'none', people: { ayse: 'edit' } });
    const made = await t.api<Routine>('POST', '/api/routines', {
      botId: bot.id,
      name: 'Sabah',
      prompt: 'Günü özetle',
      schedule: { type: 'interval', minutes: 5 },
    });
    expect(made.body.createdByUserId).toBe(OWNER_ID);
    // Changing what it does makes it Ayşe's: it no longer acts with the owner's own apps and notes.
    const changed = await ayse.api<Routine>('PATCH', `/api/routines/${made.body.id}`, {
      prompt: 'Kasadaki girişle bakiyeyi yaz',
    });
    expect(changed.body.createdByUserId).toBe('ayse');
    // Pausing it leaves it whose it is.
    const paused = await t.api<Routine>('PATCH', `/api/routines/${made.body.id}`, { enabled: false });
    expect(paused.body.createdByUserId).toBe('ayse');

    const run = (await ayse.api<RoutineRun>('POST', `/api/routines/${made.body.id}/run`)).body;
    await t.services.turns.idle();
    const thread = (await ayse.api<Thread>('GET', `/api/threads/${run.threadId}`)).body;
    expect(thread.userId).toBe('ayse');
    expect((await t.api('GET', `/api/threads/${run.threadId}`)).status).toBe(404);
    const [turn] = await t.services.ctx.db
      .select({ userId: schema.turns.userId })
      .from(schema.turns)
      .where(eq(schema.turns.routineRunId, run.id));
    expect(turn!.userId).toBe('ayse');
    // Its report reaches Ayşe's main conversation, not the bot owner's.
    const hers = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const owners = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const inHers = (await ayse.api<Message[]>('GET', `/api/threads/${hers.id}/messages`)).body;
    expect(inHers.some((m) => m.props.routineReport)).toBe(true);
    expect((await t.messages(owners.id)).some((m) => m.props.routineReport)).toBe(false);
  });

  it('not geçmişi en yeni satırları verir', async () => {
    for (let i = 0; i < 4; i++) {
      await mert.api('POST', '/api/memory', { scope: 'user', content: `Mert notu ${i}` });
      // Lines of the same millisecond have no order between them.
      await new Promise((r) => setTimeout(r, 3));
    }
    const all = (await t.services.memory.history(1000, { userId: 'mert', botIds: [], places: [] })).map(
      (h) => h.after,
    );
    const latest = (await t.services.memory.history(2, { userId: 'mert', botIds: [], places: [] })).map(
      (h) => h.after,
    );
    expect(all.slice(-2)).toEqual(['Mert notu 2', 'Mert notu 3']);
    expect(latest).toEqual(['Mert notu 2', 'Mert notu 3']);
  });

  it('bağlantı sınırı her sahibe ayrı sayılır', async () => {
    await t.services.ctx.db.insert(schema.connections).values(
      Array.from({ length: MAX_CONNECTIONS }, (_, i) => ({
        id: newId(),
        slug: `mert_${i}`,
        name: `Mert ${i}`,
        url: `https://m${i}.example.invalid/mcp`,
        auth: 'none' as const,
        status: 'error' as const,
        userId: 'mert',
      })),
    );
    const one = { name: 'Bir tane daha', url: 'https://bir.example.invalid/mcp', auth: 'none' };
    expect((await mert.api('POST', '/api/connections', one)).status).toBe(400);
    // Mert's full list does not keep anyone else from adding theirs.
    const hers = await ayse.api<Connection>('POST', '/api/connections', one);
    expect(hers.status).toBe(200);
    await ayse.api('DELETE', `/api/connections/${hers.body.id}`);
  });

  it('kasadaki giriş, sahibinin işi dışında yazılmaz; aynı hesap iki kişide ayrı durur', async () => {
    const saved = await ayse.api<VaultLogin>('POST', '/api/vault', {
      site: 'banka.example',
      username: 'ortak',
      password: 'Ayse-123456',
    });
    expect(saved.status).toBe(200);
    expect(saved.body.userId).toBe('ayse');
    expect(
      (
        await mert.api('POST', '/api/vault', {
          site: 'banka.example',
          username: 'ortak',
          password: 'Mert-654321',
        })
      ).status,
    ).toBe(200);
    expect((await mert.api<VaultLogin[]>('GET', '/api/vault')).body.map((v) => v.id)).not.toContain(
      saved.body.id,
    );
    expect((await mert.api('PATCH', `/api/vault/${saved.body.id}`, { password: 'x-123456' })).status).toBe(
      404,
    );

    const typed = async (person: string) =>
      (await t.services.vault.forHost('banka.example', undefined, person)).map((c) => c.password);
    expect(await typed('ayse')).toEqual(['Ayse-123456']);
    expect(await typed('mert')).toEqual(['Mert-654321']);
    expect(await typed(OWNER_ID)).toEqual([]);

    // Moving one to the team is for those who look after the server.
    expect((await ayse.api('PATCH', `/api/vault/${saved.body.id}`, { team: true })).status).toBe(403);
    expect(
      (
        await admin.api('POST', '/api/vault', {
          site: 'ortak.example',
          username: 'ekip',
          password: 'Ekip-123456',
          team: true,
        })
      ).status,
    ).toBe(200);
    expect(await t.services.vault.forHost('ortak.example', undefined, 'mert')).toHaveLength(1);
  });
});
