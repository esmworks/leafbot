import type { Bot } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { OWNER_ID } from '../src/users';
import { testServer, type Person, type TestServer } from './helpers';

describe('ekip alanları', () => {
  let t: TestServer;
  let ayse: Person;
  let mert: Person;
  beforeAll(async () => {
    t = await testServer({ onUserComputer: false });
    ayse = await t.person('ayse');
    mert = await t.person('mert');
  });
  afterAll(() => t.dispose());

  const seen = async (p: Person) => (await p.api<Bot[]>('GET', '/api/bots')).body.map((b) => b.id);
  const levelOf = async (p: Person, botId: string) =>
    (await p.api<Bot[]>('GET', '/api/bots')).body.find((b) => b.id === botId)?.yourLevel ?? 'none';
  const put = (botId: string, groupId: string | null) =>
    t.services.ctx.db.update(schema.bots).set({ groupId }).where(eq(schema.bots.id, botId));

  it('klasör ve üyesiz alan kimseye bot açmaz', async () => {
    const bot = await t.bot({ name: 'Klasördeki' });
    const before = [await seen(ayse), await seen(mert)];
    const folder = await t.services.bots.createGroup('Klasör', { ownerUserId: OWNER_ID });
    await put(bot.id, folder.id);
    const space = await t.services.bots.createGroup('Boş alan');
    const other = await t.bot({ name: 'Boş alandaki' });
    await put(other.id, space.id);
    expect([await seen(ayse), await seen(mert)]).toEqual(before);
  });

  it('alandaki bot alanın üyeleriyle konuşur, üye olmayana görünmez', async () => {
    const space = await t.services.bots.createGroup('Satış', { kind: 'closed' });
    const bot = await t.bot({ name: 'Satış botu' });
    await put(bot.id, space.id);
    const after = await t.services.bots.setSpaceMembers(space.id, { add: ['ayse'] });
    expect(after.memberIds).toEqual(['ayse']);
    t.services.access.forget();

    expect(await levelOf(ayse, bot.id)).toBe('chat');
    expect(await seen(mert)).not.toContain(bot.id);
    expect(await t.services.access.botPeople(bot.id, 'chat')).toContain('ayse');
    expect(await t.services.access.botPeople(bot.id, 'chat')).not.toContain('mert');
    // Talking is not changing.
    expect((await ayse.api('PATCH', `/api/bots/${bot.id}`, { name: 'Başka' })).status).toBe(403);
  });

  it('"üyeler değiştirebilir" açıkken üye botu değiştirir', async () => {
    const space = await t.services.bots.createGroup('Yazılım');
    const bot = await t.bot({ name: 'Kod botu' });
    await put(bot.id, space.id);
    await t.services.bots.setSpaceMembers(space.id, { add: ['mert'] });
    expect(await levelOf(mert, bot.id)).toBe('chat');
    await t.services.bots.setSpace(space.id, { membersEdit: true });
    expect(await levelOf(mert, bot.id)).toBe('edit');
  });

  it('alandan çıkan kişi botu artık görmez', async () => {
    const space = await t.services.bots.createGroup('Geçici');
    const bot = await t.bot({ name: 'Geçici bot' });
    await put(bot.id, space.id);
    await t.services.bots.setSpaceMembers(space.id, { add: ['ayse', 'mert'] });
    expect(await levelOf(mert, bot.id)).toBe('chat');
    await t.services.bots.setSpaceMembers(space.id, { remove: ['mert'] });
    expect(await levelOf(mert, bot.id)).toBe('none');
    expect(await levelOf(ayse, bot.id)).toBe('chat');
  });

  it('kişisel klasöre üye eklenemez', async () => {
    const folder = await t.services.bots.createGroup('Benim', { ownerUserId: OWNER_ID });
    await expect(t.services.bots.setSpaceMembers(folder.id, { add: ['ayse'] })).rejects.toThrow();
  });

  it('herkes açık alanları, üyesi olduğu gizli alanları ve yalnızca kendi klasörlerini görür', async () => {
    const open = await t.services.bots.createGroup('Açık', { kind: 'open' });
    const secret = await t.services.bots.createGroup('Gizli');
    const mine = await t.services.bots.createGroup('Ayşenin', { ownerUserId: 'ayse' });
    const owners = await t.services.bots.createGroup('Sahibin', { ownerUserId: OWNER_ID });
    await t.services.bots.setSpaceMembers(secret.id, { add: ['ayse'] });
    const names = async (p: Person) =>
      new Set((await p.api<{ id: string }[]>('GET', '/api/groups')).body.map((g) => g.id));

    const forAyse = await names(ayse);
    expect([open.id, secret.id, mine.id].every((id) => forAyse.has(id))).toBe(true);
    expect(forAyse.has(owners.id)).toBe(false);
    const forMert = await names(mert);
    expect(forMert.has(open.id)).toBe(true);
    expect([secret.id, mine.id, owners.id].some((id) => forMert.has(id))).toBe(false);
  });

  it('üyesi olan bir alandaki bot paylaşılmış sayılır', async () => {
    const bot = await t.bot({ name: 'Kanal botu' });
    const space = await t.services.bots.createGroup('Kanal');
    await put(bot.id, space.id);
    const row = { access: { everyone: 'none' as const, people: {} }, groupId: space.id };
    expect(await t.services.access.sharedWithAnyone(row)).toBe(false);
    await t.services.bots.setSpaceMembers(space.id, { add: ['mert'] });
    expect(await t.services.access.sharedWithAnyone(row)).toBe(true);
  });
});
