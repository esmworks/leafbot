import type { Routine, Skill, Thread, UnusedReport } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, type TestServer } from './helpers';

describe('kullanılmayanlar', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const old = () => new Date(t.now.value.getTime() - 90 * 86_400_000);
  const unused = async () => (await t.api<UnusedReport>('GET', '/api/unused')).body;

  it('uzun süredir okunmayan beceriyi listeler; yeni ya da yakında okunanı listelemez', async () => {
    const add = async (name: string) =>
      (await t.api<Skill>('POST', '/api/skills', { name, description: 'x', body: 'x' })).body;
    const idle = await add('eski-beceri');
    const used = await add('okunan-beceri');
    await add('yeni-beceri');
    await t.db.db.update(schema.skills).set({ createdAt: old() }).where(eq(schema.skills.id, idle.id));
    await t.db.db
      .update(schema.skills)
      .set({ createdAt: old(), uses: 4, lastUsedAt: t.now.value })
      .where(eq(schema.skills.id, used.id));
    expect((await unused()).skills.map((s) => s.name)).toEqual(['eski-beceri']);
  });

  it('uzun süredir hiçbir bota açık olmayan ya da oturumu kapalı bağlantıyı listeler; yeni olanı ya da bir rutinin kullandığını listelemez', async () => {
    const add = async (
      id: string,
      o: { allBots?: boolean; status?: 'connected' | 'signed-out'; recent?: boolean },
    ) =>
      t.db.db.insert(schema.connections).values({
        id,
        userId: null,
        slug: id,
        name: id,
        url: 'https://example.com/mcp',
        auth: 'none',
        status: o.status ?? 'connected',
        allBots: o.allBots ?? true,
        ...(!o.recent && { createdAt: old(), updatedAt: old() }),
      });
    await add('botsuz', { allBots: false });
    await add('kapali', { status: 'signed-out' });
    // Still being set up, and signed out only lately: the person may yet finish them.
    await add('kuruluyor', { allBots: false, recent: true });
    await add('yeni-kapanan', { status: 'signed-out', recent: true });
    await add('acik', {});
    await add('rutinin', { status: 'signed-out' });
    const bot = await t.bot();
    await add('tek-bota', { allBots: false });
    await t.db.db.insert(schema.botConnections).values({ botId: bot.id, connectionId: 'tek-bota' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Kontrol',
        prompt: 'x',
        schedule: { type: 'interval', minutes: 60 },
      })
    ).body;
    await t.db.db.update(schema.routines).set({ signInWait: 'rutinin' }).where(eq(schema.routines.id, r.id));
    expect((await unused()).connections).toEqual([
      { id: 'botsuz', name: 'botsuz', reason: 'noBot' },
      { id: 'kapali', name: 'kapali', reason: 'signedOut' },
    ]);
  });

  it('uzun süredir turu olmayan botu listeler; işi süren ya da yeni olanı listelemez', async () => {
    const idle = await t.bot({ name: 'A Boşta' });
    const talked = await t.bot({ name: 'B Konuşan' });
    const scheduled = await t.bot({ name: 'C Rutinli' });
    await t.bot({ name: 'D Yeni' });
    const reminding = await t.bot({ name: 'E Hatırlatacak' });
    for (const b of [idle, talked, scheduled, reminding])
      await t.db.db.update(schema.bots).set({ createdAt: old() }).where(eq(schema.bots.id, b.id));
    const thread = (await t.api<Thread>('GET', `/api/bots/${talked.id}/main-thread`)).body;
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    await t.api('POST', '/api/routines', {
      botId: scheduled.id,
      name: 'Kontrol',
      prompt: 'x',
      schedule: { type: 'interval', minutes: 60 },
    });
    // Something it is to bring up months from now still waits on it.
    await t.db.db.insert(schema.followUps).values({
      id: 'hatirlat',
      botId: reminding.id,
      userId: 'owner',
      text: 'Sözleşmeyi yenile',
      dueAt: new Date(t.now.value.getTime() + 120 * 86_400_000),
    });
    expect((await unused()).bots).toEqual([{ id: idle.id, name: 'A Boşta', lastTurnAt: null }]);
  });

  it('kişiye yalnız kendi kaldırabileceklerini gösterir', async () => {
    const bot = await t.bot();
    await t.db.db.update(schema.bots).set({ createdAt: old() }).where(eq(schema.bots.id, bot.id));
    await t.db.db.insert(schema.connections).values({
      id: 'ortak',
      userId: null,
      slug: 'ortak',
      name: 'ortak',
      url: 'https://example.com/mcp',
      auth: 'none',
      status: 'signed-out',
      updatedAt: old(),
    });
    const skill = (await t.api<Skill>('POST', '/api/skills', { name: 'ortak-beceri', description: 'x' }))
      .body;
    await t.db.db.update(schema.skills).set({ createdAt: old() }).where(eq(schema.skills.id, skill.id));
    expect((await unused()).bots).toHaveLength(1);
    const ayse = await t.person('ayse');
    expect((await ayse.api<UnusedReport>('GET', '/api/unused')).body).toEqual({
      skills: [],
      connections: [],
      bots: [],
    });
  });
});
