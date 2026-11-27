import type { Approval, Bot, Message, Room } from '@leafbot/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { OWNER_ID } from '../src/users';
import { testServer, waitFor, type Person, type TestServer } from './helpers';

describe('kişili odalar', () => {
  let t: TestServer;
  let ayse: Person;
  let mert: Person;
  let dilek: Person;
  let bot: Bot;
  beforeAll(async () => {
    t = await testServer();
    ayse = await t.person('ayse');
    mert = await t.person('mert');
    dilek = await t.person('dilek', 'admin');
    // Shared with nobody: only the server's owner talks with it outside a room.
    bot = await t.bot({ name: 'Fatura' });
  });
  afterAll(() => t.dispose());

  const room = async (title = 'Planlama') => {
    const r = await t.api<Room>('POST', '/api/rooms', { title, botIds: [bot.id] });
    expect(r.status).toBe(200);
    return r.body;
  };
  const people = (roomId: string, change: { add?: string[]; remove?: string[] }, by?: Person) =>
    by
      ? by.api<Room>('PUT', `/api/rooms/${roomId}/people`, change)
      : t.api<Room>('PUT', `/api/rooms/${roomId}/people`, change);
  const say = (p: Person | null, roomId: string, text: string) => {
    const body = { clientId: `c-${Math.random().toString(36).slice(2, 12)}`, text };
    return p
      ? p.api<Message>('POST', `/api/rooms/${roomId}/messages`, body)
      : t.api<Message>('POST', `/api/rooms/${roomId}/messages`, body);
  };
  const listed = async (p: Person) => (await p.api<Room[]>('GET', '/api/rooms')).body.map((r) => r.id);

  it('odaya alınan kişi odayı görür ve paylaşılmamış botla orada konuşur; başkası görmez', async () => {
    const r = await room();
    expect((await ayse.api('GET', `/api/rooms/${r.id}`)).status).toBe(404);
    const after = await people(r.id, { add: ['ayse'] });
    expect(after.status).toBe(200);
    expect(after.body.people).toEqual(['ayse']);
    expect(after.body.ownerId).toBe(OWNER_ID);

    expect(await listed(ayse)).toContain(r.id);
    expect(await listed(mert)).not.toContain(r.id);
    expect((await mert.api('GET', `/api/rooms/${r.id}`)).status).toBe(404);
    expect(await t.services.access.threadAudience(r.id)).toEqual([OWNER_ID, 'ayse']);

    const sent = await say(ayse, r.id, 'Faturalar ne durumda?');
    expect(sent.status).toBe(201);
    expect(sent.body.userId).toBe('ayse');
    await t.services.turns.idle();
    const answered = (await t.messages(r.id)).filter((m) => m.role === 'assistant');
    expect(answered.length).toBeGreaterThan(0);
    // The bot is still not shared with her outside the room.
    const bots = (await ayse.api<Bot[]>('GET', '/api/bots')).body.map((b) => b.id);
    expect(bots).not.toContain(bot.id);
  });

  it('her satır yazanın adıyla gider; odada başkası varken kimsenin kişisel bilgisi girmez', async () => {
    await t.api('PATCH', '/api/settings', { userName: 'Erhan', occupation: 'Gizli meslek' });
    const r = await room('Kişisel');
    await say(null, r.id, 'yalnızım');
    await t.services.turns.idle();
    const alone = t.engine.requests.filter((x) => x.threadId === r.id).at(-1)!;
    expect(alone.systemPrompt).toContain('Gizli meslek');

    await people(r.id, { add: ['ayse'] });
    await say(ayse, r.id, 'merhaba');
    await t.services.turns.idle();
    const hers = t.engine.requests.filter((x) => x.threadId === r.id).at(-1)!;
    expect(hers.prompt).toContain('ayse: merhaba');
    expect(hers.systemPrompt).not.toContain('Gizli meslek');
    await say(null, r.id, 'hoş geldin');
    await t.services.turns.idle();
    const together = t.engine.requests.filter((x) => x.threadId === r.id).at(-1)!;
    expect(together.systemPrompt).not.toContain('Gizli meslek');
    expect(together.prompt).toContain('Erhan: hoş geldin');
    expect(together.tools.map((x) => x.name)).not.toContain('routine_create');
  });

  it('odaya alınan kişi odayı yönetemez, kişi ekleyemez; çıkabilir', async () => {
    const r = await room('Yönetim');
    await people(r.id, { add: ['ayse'] });
    expect((await people(r.id, { add: ['mert'] }, ayse)).status).toBe(403);
    expect((await ayse.api('PATCH', `/api/rooms/${r.id}`, { title: 'Başka' })).status).toBe(403);
    expect((await ayse.api('DELETE', `/api/rooms/${r.id}`)).status).toBe(403);
    expect((await ayse.api('POST', `/api/rooms/${r.id}/reset`)).status).toBe(403);

    expect((await ayse.api('POST', `/api/rooms/${r.id}/leave`)).status).toBe(200);
    expect((await ayse.api('GET', `/api/rooms/${r.id}`)).status).toBe(404);
    // Whoever opened it cannot leave it, only delete it.
    expect((await t.api('POST', `/api/rooms/${r.id}/leave`)).status).toBe(400);
  });

  it('yönetici yalnızca içinde olduğu odayı görür ve onu yönetir', async () => {
    const r = await room('Yöneticili');
    expect((await dilek.api('GET', `/api/rooms/${r.id}`)).status).toBe(404);
    expect(await listed(dilek)).not.toContain(r.id);
    await people(r.id, { add: ['dilek'] });
    const added = await people(r.id, { add: ['mert'] }, dilek);
    expect(added.status).toBe(200);
    expect(added.body.people).toEqual(['dilek', 'mert']);
  });

  it('ekleyen, botu paylaşılmamış kişileri görür; odadaki kişi botun yüzünü görür', async () => {
    const r = await room('Yüzler');
    const unshared = await t.api<Record<string, string[]>>('GET', `/api/rooms/${r.id}/unshared`);
    expect(unshared.status).toBe(200);
    expect(unshared.body.ayse).toEqual(['Fatura']);
    expect(unshared.body[OWNER_ID]).toBeUndefined();
    await people(r.id, { add: ['ayse'] });
    expect((await ayse.api('GET', `/api/rooms/${r.id}/unshared`)).status).toBe(403);
    const seen = (await ayse.api<Room>('GET', `/api/rooms/${r.id}`)).body;
    expect(seen.faces?.map((f) => f.name)).toEqual(['Fatura']);
  });

  it('olmayan ya da giremeyen kişi odaya alınmaz', async () => {
    const r = await room('Yoklar');
    expect((await people(r.id, { add: ['kimse'] })).status).toBe(404);
    await t.services.ctx.db
      .insert(schema.users)
      .values({ id: 'eski', username: 'eski', usernameKey: 'eski', role: 'member', disabledAt: new Date() });
    expect((await people(r.id, { add: ['eski'] })).status).toBe(404);
    expect((await t.api<Room>('GET', `/api/rooms/${r.id}`)).body.people).toEqual([]);
  });

  it('kartı odada yalnızca soran ya da botu değiştiren yanıtlar', async () => {
    const r = await room('Kartlı');
    await people(r.id, { add: ['ayse', 'mert'] });
    const call = { questions: [{ question: 'Hangi ay?', options: ['Ocak', 'Şubat'] }] };
    expect((await say(ayse, r.id, `[araç:ask_user ${JSON.stringify(call)}]`)).status).toBe(201);
    const card = await waitFor(async () =>
      (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body.find((a) => a.threadId === r.id),
    );
    const told = await t.services.access.noticeAudience(r.id);
    expect(told).toEqual(expect.arrayContaining([OWNER_ID, 'ayse']));
    expect(told).not.toContain('mert');
    const refused = await mert.api('POST', `/api/approvals/${card.id}`, {
      decision: 'allow',
      answer: 'Şubat',
    });
    expect(refused.status).toBe(403);
    const answered = await ayse.api('POST', `/api/approvals/${card.id}`, {
      decision: 'allow',
      answer: 'Ocak',
    });
    expect(answered.status).toBeLessThan(300);
    await t.services.turns.idle();
  });

  it('odayı açan silinince oda içindeki en eski yöneticiye, yoksa en eski kişiye geçer', async () => {
    const owned = async (title: string, by: string) => {
      const r = await room(title);
      await t.services.ctx.db.update(schema.threads).set({ userId: by }).where(eq(schema.threads.id, r.id));
      return r;
    };
    await t.person('cem');
    const withAdmin = await owned('Yöneticiye', 'cem');
    await t.services.rooms.setPeople(withAdmin.id, { add: ['mert'] }, 'cem');
    await t.services.rooms.setPeople(withAdmin.id, { add: ['dilek'] }, 'cem');
    const plain = await owned('Üyeye', 'cem');
    await t.services.rooms.setPeople(plain.id, { add: ['mert'] }, 'cem');
    await t.services.rooms.setPeople(plain.id, { add: ['ayse'] }, 'cem');
    const alone = await owned('Yalnız', 'cem');
    // Put in one after another, a moment apart, as people are.
    let at = Date.parse('2026-01-01T00:00:00Z');
    for (const [roomId, userId] of [
      [withAdmin.id, 'mert'],
      [withAdmin.id, 'dilek'],
      [plain.id, 'mert'],
      [plain.id, 'ayse'],
    ] as const) {
      await t.services.ctx.db
        .update(schema.roomPeople)
        .set({ createdAt: new Date((at += 1000)) })
        .where(and(eq(schema.roomPeople.roomId, roomId), eq(schema.roomPeople.userId, userId)));
    }

    await t.services.rooms.passOn('cem');
    const now = await t.services.rooms.get(withAdmin.id);
    expect([now.ownerId, now.people]).toEqual(['dilek', ['mert']]);
    const next = await t.services.rooms.get(plain.id);
    expect([next.ownerId, next.people]).toEqual(['mert', ['ayse']]);
    expect((await t.services.rooms.get(alone.id)).ownerId).toBe('cem');
  });
});
