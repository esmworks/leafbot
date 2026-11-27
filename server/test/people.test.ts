import type { Bot, Memory, PersonInfo, Thread } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { OWNER_ID } from '../src/users';
import { testServer, type Person, type TestServer } from './helpers';

describe('kişileri yönetmek', () => {
  let t: TestServer;
  let admin: Person;
  let member: Person;
  beforeAll(async () => {
    t = await testServer();
    admin = await t.person('yonetici', 'admin');
    member = await t.person('uye');
  });
  afterAll(() => t.dispose());

  const login = async (username: string, password: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/login',
      headers: { host: 'localhost', origin: 'http://localhost' },
      payload: { username, password },
    });

  it('yönetici üye ekler; eklenen kendi şifresiyle girer; üye kimseyi ekleyemez', async () => {
    const made = await admin.api<PersonInfo>('POST', '/api/people', {
      username: 'Zeynep',
      password: 'zeynep-sifre',
      displayName: 'Zeynep K.',
    });
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ username: 'Zeynep', role: 'member', disabled: false });
    expect((await login('zeynep', 'zeynep-sifre')).statusCode).toBe(200);
    // Everyone sees who is here, to share a bot with them.
    const seen = (await member.api<PersonInfo[]>('GET', '/api/people')).body.map((p) => p.username);
    expect(seen).toContain('Zeynep');
    expect(seen[0]).toBe(null); // the owner, who has only used the access key

    expect(
      (await member.api('POST', '/api/people', { username: 'x', password: 'x-sifre-uzun' })).status,
    ).toBe(403);
    expect((await admin.api('POST', '/api/people', { username: 'kisa', password: 'kisa' })).status).toBe(400);
    expect(
      (await admin.api('POST', '/api/people', { username: 'ZEYNEP', password: 'baska-sifre' })).status,
    ).toBe(409);
  });

  it('yöneticileri yalnızca sahip ekler ve değiştirir; sahibe ve kendine dokunulmaz', async () => {
    expect(
      (await admin.api('POST', '/api/people', { username: 'y2', password: 'y2-sifre-uzun', role: 'admin' }))
        .status,
    ).toBe(403);
    const other = await t.api<PersonInfo>('POST', '/api/people', {
      username: 'y3',
      password: 'y3-sifre-uzun',
      role: 'admin',
    });
    expect(other.body.role).toBe('admin');
    expect((await admin.api('PATCH', `/api/people/${other.body.id}`, { disabled: true })).status).toBe(403);
    expect((await admin.api('PATCH', `/api/people/${OWNER_ID}`, { disabled: true })).status).toBe(404);
    expect((await admin.api('PATCH', `/api/people/${admin.id}`, { role: 'member' })).status).toBe(403);
    expect((await admin.api('PATCH', `/api/people/${member.id}`, { role: 'admin' })).status).toBe(403);
  });

  it('hesapla davet: üye davet edemez, yöneticiyi yalnızca sahip getirir, sahip davet edilmez', async () => {
    const invite = (who: Person | TestServer, body: Record<string, unknown>) =>
      who.api<{ message?: string }>('POST', '/api/people/invites', body);
    expect((await invite(member, { email: 'a@example.com' })).status).toBe(403);
    expect((await admin.api('GET', '/api/people/invites')).status).toBe(200);
    expect((await member.api('GET', '/api/people/invites')).status).toBe(403);
    expect((await invite(admin, { email: 'a@example.com', role: 'admin' })).status).toBe(403);
    // The person's own role counts, not the one asked for.
    expect((await invite(admin, { email: 'a@example.com', personId: admin.id })).status).toBe(403);
    expect((await invite(admin, { email: 'a@example.com', personId: OWNER_ID })).status).toBe(400);
    expect((await invite(admin, { email: 'a@example.com', personId: 'yok-boyle-biri' })).status).toBe(404);
    expect((await invite(admin, { email: 'gecersiz' })).status).toBe(400);
    // Allowed, but this server is linked to no account yet.
    expect((await invite(admin, { email: 'a@example.com', personId: member.id })).status).toBe(409);
    const people = (await admin.api<PersonInfo[]>('GET', '/api/people')).body;
    expect(people.find((p) => p.id === member.id)?.linked).toBe(false);
  });

  it('devre dışı kalan ya da şifresi değişen hemen çıkar; yeni rol hemen geçerli olur', async () => {
    const p = await t.person('gecici');
    expect((await p.api('GET', '/api/push/apns')).status).toBe(403);
    expect((await t.api('PATCH', `/api/people/${p.id}`, { role: 'admin' })).status).toBe(200);
    expect((await p.api('GET', '/api/push/apns')).status).toBe(200);

    expect((await t.api('PATCH', `/api/people/${p.id}`, { disabled: true })).status).toBe(200);
    expect((await p.api('GET', '/api/bots')).status).toBe(401);
    expect((await t.api('PATCH', `/api/people/${p.id}`, { disabled: false })).status).toBe(200);
    // Brought back, they sign in again: the old devices stay signed out.
    expect((await p.api('GET', '/api/bots')).status).toBe(401);

    const q = await t.person('sifreli');
    expect((await admin.api('PATCH', `/api/people/${q.id}`, { password: 'yeni-sifre-1' })).status).toBe(200);
    expect((await q.api('GET', '/api/bots')).status).toBe(401);
    expect((await login('sifreli', 'yeni-sifre-1')).statusCode).toBe(200);
  });

  it('devre dışı kişi adına hiçbir iş çalışmaz: rutini, sohbet uygulaması, bot-bot isteği', async () => {
    const p = await t.person('pasif');
    const bot = await t.bot({ name: 'Pasifin botu' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'none', people: { pasif: 'chat' } });
    const thread = (await p.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.api('PATCH', `/api/people/${p.id}`, { disabled: true });
    const before = t.engine.requests.length;
    // As a chat app or a routine would start it: in their conversation, for them.
    const turn = await t.services.turns.enqueue({
      threadId: thread.id,
      botId: bot.id,
      source: 'routine',
      prompt: 'rapor yaz',
    });
    await t.services.turns.idle();
    expect(t.engine.requests.length).toBe(before);
    const [row] = await t.services.ctx.db.select().from(schema.turns).where(eq(schema.turns.id, turn.id));
    expect(row!.status).toBe('error');
  });

  it('silinen kişinin sohbetleri ve notları gider; yaptığı botlar sahibe geçer', async () => {
    const p = await t.person('ayrilan');
    const sharedBot = await t.bot({ name: 'Ortak' });
    await t.api('PUT', `/api/bots/${sharedBot.id}/access`, { everyone: 'none', people: { ayrilan: 'chat' } });
    const thread = (await p.api<Thread>('GET', `/api/bots/${sharedBot.id}/main-thread`)).body;
    expect(thread.userId).toBe('ayrilan');
    expect(
      (await p.api('POST', '/api/memory', { scope: 'user', content: 'Ayrılan kişinin notu' })).status,
    ).toBe(200);
    const own = (await p.api<Bot>('POST', '/api/bots', { name: 'Kendi botu' })).body;
    expect(own.ownerUserId).toBe('ayrilan');

    expect((await admin.api('DELETE', `/api/people/${p.id}`)).status).toBe(200);
    expect((await p.api('GET', '/api/bots')).status).toBe(401);
    expect(
      await t.services.ctx.db.select().from(schema.threads).where(eq(schema.threads.id, thread.id)),
    ).toEqual([]);
    expect(await t.services.ctx.db.select().from(schema.users).where(eq(schema.users.id, p.id))).toEqual([]);
    expect(
      (await t.api<Memory[]>('GET', '/api/memory')).body.some((m) => m.content === 'Ayrılan kişinin notu'),
    ).toBe(false);
    expect((await t.api<Bot>('GET', `/api/bots/${own.id}`)).body.ownerUserId).toBe(OWNER_ID);
    expect((await t.api<Bot>('GET', `/api/bots/${sharedBot.id}`)).body.access?.people).toEqual({});
  });
});
