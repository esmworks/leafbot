import type { Approval, Bot, BotSummary, PermissionRule, SearchHit, Thread, Ticket } from '@leafbot/shared';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeltaEvent } from '@leafbot/shared';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { OWNER_ID } from '../src/users';
import { newId } from '../src/util';
import { KEY, testServer, type Person, type TestServer } from './helpers';

describe('kim neyi görür', () => {
  let t: TestServer;
  let ayse: Person;
  let mert: Person;
  let admin: Person;
  beforeAll(async () => {
    t = await testServer({ onUserComputer: false });
    ayse = await t.person('ayse');
    mert = await t.person('mert');
    admin = await t.person('yonetici', 'admin');
  });
  afterAll(() => t.dispose());

  /** The server's address; it listens once for every socket test. */
  let address: Promise<string> | undefined;
  const listening = () => (address ??= t.listen());

  const send = (p: Person, threadId: string, text: string) =>
    p.api('POST', `/api/threads/${threadId}/messages`, {
      clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
      text,
    });

  it('paylaşılmamış bot başkasına yokmuş gibi görünür', async () => {
    const bot = await t.bot({ name: 'Gizli' });
    expect(bot.ownerUserId).toBe(OWNER_ID);
    const list = (await ayse.api<Bot[]>('GET', '/api/bots')).body;
    expect(list.some((b) => b.id === bot.id)).toBe(false);
    expect((await ayse.api('GET', `/api/bots/${bot.id}`)).status).toBe(404);
    expect((await ayse.api('GET', `/api/bots/${bot.id}/main-thread`)).status).toBe(404);
    // Those who look after the server may change every bot.
    expect((await admin.api<Bot>('GET', `/api/bots/${bot.id}`)).body.yourLevel).toBe('edit');
  });

  it('paylaşılan botla herkes kendi sohbetini yapar; kimse başkasınınkini okuyamaz', async () => {
    const bot = await t.bot({ name: 'Ortak' });
    const shared = await t.api<Bot>('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    expect(shared.status).toBe(200);

    const seen = (await ayse.api<Bot[]>('GET', '/api/bots')).body.find((b) => b.id === bot.id);
    expect(seen?.yourLevel).toBe('chat');
    const ownerThread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const ayseThread = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    expect(ayseThread.id).not.toBe(ownerThread.id);
    expect(ayseThread.userId).toBe('ayse');

    await t.send(ownerThread.id, 'sahibin gizli notu');
    expect((await send(ayse, ayseThread.id, 'ayşenin sorusu')).status).toBeLessThan(300);
    await t.services.turns.idle();

    // Not the other's conversation, not even for those who look after the server.
    expect((await ayse.api('GET', `/api/threads/${ownerThread.id}/messages`)).status).toBe(404);
    expect((await admin.api('GET', `/api/threads/${ayseThread.id}/messages`)).status).toBe(404);
    expect((await mert.api('POST', `/api/threads/${ayseThread.id}/messages`, {})).status).toBe(404);
    const listed = (await ayse.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body;
    expect(listed.map((th) => th.id)).toEqual([ayseThread.id]);

    // Search and the sidebar hold only what is theirs.
    const hits = (await ayse.api<SearchHit[]>('GET', '/api/search?q=gizli')).body;
    expect(hits).toEqual([]);
    const own = (await ayse.api<SearchHit[]>('GET', '/api/search?q=ayşenin')).body;
    expect(own.length).toBeGreaterThan(0);
    expect(own.every((h) => h.threadId === ayseThread.id)).toBe(true);
    const summary = (await ayse.api<BotSummary[]>('GET', '/api/summaries')).body.find(
      (x) => x.botId === bot.id,
    );
    expect(summary?.threadId).toBe(ayseThread.id);

    // Talking is not changing.
    expect((await ayse.api('PATCH', `/api/bots/${bot.id}`, { name: 'Benim' })).status).toBe(403);
    expect(
      (await ayse.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'edit', people: {} })).status,
    ).toBe(403);
  });

  it('paylaşım geri alınınca sohbet okunur ama yazılmaz', async () => {
    const bot = await t.bot({ name: 'Geçici' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'none', people: { mert: 'chat' } });
    const thread = (await mert.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    expect((await send(mert, thread.id, 'merhaba')).status).toBeLessThan(300);
    await t.services.turns.idle();
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'none', people: {} });
    expect((await mert.api('GET', `/api/threads/${thread.id}/messages`)).status).toBe(200);
    const refused = await send(mert, thread.id, 'tekrar');
    expect(refused.status).toBe(403);
  });

  it('kişinin yaptığı bot onundur; başkası onu silemez', async () => {
    const made = await ayse.api<Bot>('POST', '/api/bots', { name: 'Ayşenin botu' });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ ownerUserId: 'ayse', yourLevel: 'edit' });
    expect((await mert.api('DELETE', `/api/bots/${made.body.id}`)).status).toBe(404);
    // A project folder opens the server's files: members do not pick one.
    expect((await ayse.api('PATCH', `/api/bots/${made.body.id}`, { projectDir: '/' })).status).toBe(403);
    // Sharing it to change makes Mert able to change it, not to remove it.
    await ayse.api('PUT', `/api/bots/${made.body.id}/access`, { everyone: 'none', people: { mert: 'edit' } });
    expect((await mert.api('PATCH', `/api/bots/${made.body.id}`, { description: 'x' })).status).toBe(200);
    expect((await mert.api('DELETE', `/api/bots/${made.body.id}`)).status).toBe(403);
  });

  it('sunucunun ayarları ve yedekleri yöneticilerin', async () => {
    expect((await ayse.api('PATCH', '/api/settings', { timezone: 'UTC' })).status).toBe(403);
    // A backup holds every person's conversations: only the owner takes one.
    expect((await admin.api('POST', '/api/backup')).status).toBe(403);
    expect((await admin.api('POST', '/api/backup/restore', {})).status).toBe(403);
    expect((await ayse.api('GET', '/api/usage')).status).toBe(403);
  });

  it('kurallar, onaylar, biletler kişinin erişimiyle süzülür', async () => {
    const hidden = await t.bot({ name: 'Kurallı' });
    await t.api('POST', '/api/rules', { list: 'block', pattern: 'Bash(rm *)', note: '', botId: hidden.id });
    const rules = (await ayse.api<PermissionRule[]>('GET', '/api/rules')).body;
    expect(rules.some((r) => r.botId === hidden.id)).toBe(false);
    // Rules for every bot are the server's.
    expect(
      (await ayse.api('POST', '/api/rules', { list: 'allow', pattern: 'Bash(*)', note: '', botId: null }))
        .status,
    ).toBe(403);

    const ownerThread = (await t.api<Thread>('GET', `/api/bots/${hidden.id}/main-thread`)).body;
    // The card waits for its answer; it is enough that it is there.
    await new Promise<void>((resolve) => {
      void t.services.approvals.ask({
        threadId: ownerThread.id,
        botId: hidden.id,
        turnId: null,
        kind: 'question',
        toolName: 'AskUserQuestion',
        input: {},
        summary: 'sahibe soru',
        timeoutMs: 2000,
        onCreated: async () => resolve(),
      });
    });
    const cards = (await ayse.api<Approval[]>('GET', '/api/approvals')).body;
    expect(cards.some((c) => c.threadId === ownerThread.id)).toBe(false);

    const ticket = (
      await t.api<Ticket>('POST', '/api/tickets', { title: 'Sahibin işi', assigneeBotId: hidden.id })
    ).body;
    const board = (await ayse.api<Ticket[]>('GET', '/api/tickets')).body;
    expect(board.some((k) => k.id === ticket.id)).toBe(false);
    expect((await ayse.api('DELETE', `/api/tickets/${ticket.id}`)).status).toBe(404);
    expect((await ayse.api('POST', '/api/tickets', { title: 'x', assigneeBotId: hidden.id })).status).toBe(
      404,
    );
  });

  it('canlı olaylar konuşmanın kişilerine gider', async () => {
    const bot = await t.bot({ name: 'Canlı' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    const ayseThread = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    t.services.access.forget();
    expect(await t.services.access.threadAudience(ayseThread.id)).toEqual(['ayse']);
    // A routine's runs are its person's alone.
    const routine = await t.services.threads.routineThread(bot.id, 'Rutin', null, 'ayse');
    expect(await t.services.access.threadAudience(routine.id)).toEqual(['ayse']);
    // The bot's own work, which is no one person's, goes to those who may change it.
    const [work] = await t.services.ctx.db
      .insert(schema.threads)
      .values({ id: newId(), botId: bot.id, kind: 'routine', title: 'Eski iş' })
      .returning();
    expect((await t.services.access.threadAudience(work!.id)).sort()).toEqual([OWNER_ID, 'yonetici'].sort());
  });

  it('yalnızca konuşabilen kişi kendi sohbetinin dosyalarını açar, başkasınınkini açamaz', async () => {
    const bot = await t.bot({ name: 'Dosyalı' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    const mine = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const theirs = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const put = (threadId: string) => {
      const dir = join(t.dataDir, 'workspaces', 'bots', bot.id, 'threads', threadId);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'not.txt'), 'merhaba');
      return encodeURIComponent(`bots/${bot.id}/threads/${threadId}/not.txt`);
    };
    const own = put(mine.id);
    const other = put(theirs.id);
    expect((await ayse.api('GET', `/api/bots/${bot.id}/library/file?path=${own}`)).status).toBe(200);
    expect((await ayse.api('GET', `/api/bots/${bot.id}/library/file?path=${other}`)).status).toBe(403);
    // Listing every file is for those who may change the bot.
    expect((await ayse.api('GET', `/api/bots/${bot.id}/library`)).status).toBe(403);
    const owner = await t.app.inject({
      method: 'GET',
      url: `/api/bots/${bot.id}/library/file?path=${other}`,
      headers: { host: 'localhost', authorization: `Bearer ${KEY}` },
    });
    expect(owner.statusCode).toBe(200);
  });

  it('kişinin soketi başkasının sohbetinin yazısını almaz', async () => {
    const bot = await t.bot({ name: 'Soketli' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    const mine = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const theirs = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const url = await listening();
    const socket = connect(url, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { cookie: ayse.cookie, origin: url },
    });
    try {
      await new Promise((resolve, reject) => {
        socket.on('hello', resolve);
        socket.on('connect_error', reject);
      });
      const got: DeltaEvent[] = [];
      socket.on('delta', (e: DeltaEvent) => got.push(e));
      t.services.ctx.bus.delta({ threadId: theirs.id, turnId: 'x', text: 'sahibin yazısı' });
      t.services.ctx.bus.delta({ threadId: mine.id, turnId: 'y', text: 'ayşenin yazısı' });
      const until = Date.now() + 3000;
      while (!got.length && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 100));
      expect(got.map((e) => e.text)).toEqual(['ayşenin yazısı']);
    } finally {
      socket.close();
    }
  });

  it('sohbet ve bot yenilemeleri yalnızca onları görenlere gider', async () => {
    const shared = await t.bot({ name: 'Yenilenen' });
    await t.api('PUT', `/api/bots/${shared.id}/access`, { everyone: 'chat', people: {} });
    const hidden = await t.bot({ name: 'Görünmeyen' });
    const mine = (await ayse.api<Thread>('GET', `/api/bots/${shared.id}/main-thread`)).body;
    const theirs = (await t.api<Thread>('GET', `/api/bots/${shared.id}/main-thread`)).body;
    const url = await listening();
    const socket = connect(url, {
      transports: ['websocket'],
      reconnection: false,
      extraHeaders: { cookie: ayse.cookie, origin: url },
    });
    try {
      await new Promise((resolve, reject) => {
        socket.on('hello', resolve);
        socket.on('connect_error', reject);
      });
      const got: string[] = [];
      socket.on('refresh', (e: { scope: string; threadId?: string; botId?: string }) =>
        got.push(`${e.scope}:${e.threadId ?? e.botId ?? ''}`),
      );
      const bus = t.services.ctx.bus;
      bus.refresh({ scope: 'thread', threadId: theirs.id, botId: shared.id });
      bus.refresh({ scope: 'threads', botId: hidden.id });
      bus.refresh({ scope: 'actions', botId: hidden.id });
      bus.refresh({ scope: 'thread', threadId: mine.id, botId: shared.id });
      bus.refresh({ scope: 'threads', botId: shared.id });
      const until = Date.now() + 3000;
      while (got.length < 2 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 150));
      expect(got.sort()).toEqual([`thread:${mine.id}`, `threads:${shared.id}`].sort());
    } finally {
      socket.close();
    }
  });

  it('botların web çıkışını yalnızca sunucuyu yöneten verir', async () => {
    const url = await listening();
    const offer = (p: Person) =>
      connect(`${url}/egress`, {
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { cookie: p.cookie, origin: url },
        auth: { device: p.id },
      });
    const device = async () =>
      (await t.api<{ egress?: { connected: boolean; device: string } }>('GET', '/api/info')).body.egress;
    const theirs = offer(ayse);
    try {
      await new Promise<void>((resolve) => {
        theirs.on('disconnect', () => resolve());
        theirs.on('connect_error', () => resolve());
      });
      expect((await device())?.device ?? '').not.toBe(ayse.id);
    } finally {
      theirs.close();
    }
    const managed = offer(admin);
    try {
      const until = Date.now() + 3000;
      while ((await device())?.device !== admin.id && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect((await device())?.device).toBe(admin.id);
    } finally {
      managed.close();
    }
  });

  it('bot, çalıştığı kişinin ulaşamadığına ulaşamaz; bot-bot işi kişi başına ayrıdır', async () => {
    const shared = await t.bot({ name: 'Aracı' });
    await t.api('PUT', `/api/bots/${shared.id}/access`, { everyone: 'chat', people: {} });
    const hidden = await t.bot({ name: 'Kapalı' });
    await expect(t.services.access.reach('ayse', shared, hidden, 'chat')).rejects.toThrow();
    // Talking with itself is fine; changing itself needs what changing any bot needs.
    expect((await t.services.access.reach('ayse', shared, shared, 'chat')).id).toBe(shared.id);
    await expect(t.services.access.reach('ayse', shared, shared, 'edit')).rejects.toThrow();
    expect((await t.services.access.reach(OWNER_ID, shared, hidden, 'edit')).id).toBe(hidden.id);

    const forAyse = await t.services.threads.peerThread(hidden.id, shared.id, 'ayse');
    const forOwner = await t.services.threads.peerThread(hidden.id, shared.id, OWNER_ID);
    expect(forAyse.id).not.toBe(forOwner.id);
    expect((await t.services.threads.peerThread(hidden.id, shared.id, 'ayse')).id).toBe(forAyse.id);
  });

  it('botu değiştirebilen, onun bot-bot konuşmalarından yalnızca kendisi için yapılanları görür', async () => {
    const asker = await t.bot({ name: 'Soran' });
    const helper = await t.bot({ name: 'Yardımcı' });
    await t.api('PUT', `/api/bots/${asker.id}/access`, { everyone: 'none', people: { ayse: 'edit' } });
    const forAyse = await t.services.threads.peerThread(helper.id, asker.id, 'ayse');
    const forMert = await t.services.threads.peerThread(helper.id, asker.id, 'mert');
    const forOwner = await t.services.threads.peerThread(helper.id, asker.id, OWNER_ID);
    const ids = async (p: Person | TestServer) =>
      (await p.api<{ threadId: string }[]>('GET', `/api/bots/${asker.id}/conversations`)).body.map(
        (r) => r.threadId,
      );
    expect(await ids(ayse)).toEqual([forAyse.id]);
    // Those who look after the server change every bot, and still open nobody else's exchanges.
    expect(await ids(t)).toEqual([forOwner.id]);
    expect(await ids(admin)).toEqual([]);
    expect(forMert.userId).toBe('mert');
  });
});
