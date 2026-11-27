import type { Bot, Group } from '@leafbot/shared';
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

  it('yeni bot Özel’e düşer: ekip alanında açılamaz, kendi klasöründe açılır', async () => {
    const space = (await t.api<Group>('POST', '/api/groups', { name: 'Destek', space: true })).body;
    expect(space.ownerUserId).toBeNull();
    const refused = await ayse.api('POST', '/api/groups', { name: 'Olmaz', space: true });
    expect(refused.status).toBe(403);
    const folder = (await ayse.api<Group>('POST', '/api/groups', { name: 'İşlerim' })).body;
    expect(folder.ownerUserId).toBe('ayse');

    const body = { name: 'Yeni', description: '', instructions: '' };
    expect((await ayse.api('POST', '/api/bots', { ...body, groupId: space.id })).status).toBe(400);
    const made = await ayse.api<Bot>('POST', '/api/bots', { ...body, groupId: folder.id });
    expect(made.status).toBe(200);
    // Nobody else's folder takes it.
    const others = (await t.api<Group>('POST', '/api/groups', { name: 'Sahibin klasörü' })).body;
    expect(
      (
        await ayse.api('POST', `/api/bots/${made.body.id}/move`, {
          pinned: false,
          groupId: others.id,
          beforeId: null,
        })
      ).status,
    ).toBe(403);
  });

  it('sahibi botunu yalnızca üyesi olduğu alana taşır; yönetici her alana taşır', async () => {
    const admin = await t.person('yonetici2', 'admin');
    const space = (await t.api<Group>('POST', '/api/groups', { name: 'Proje', space: true })).body;
    const made = await mert.api<Bot>('POST', '/api/bots', {
      name: 'Mertin',
      description: '',
      instructions: '',
    });
    const move = (p: Person, groupId: string | null) =>
      p.api('POST', `/api/bots/${made.body.id}/move`, { pinned: false, groupId, beforeId: null });

    expect((await move(mert, space.id)).status).toBe(403);
    await t.api('PUT', `/api/groups/${space.id}/members`, { add: ['mert', 'ayse'] });
    expect((await move(mert, space.id)).status).toBe(200);
    expect(await levelOf(ayse, made.body.id)).toBe('chat');
    // Back to Private: the space's people lose it.
    expect((await move(mert, null)).status).toBe(200);
    expect(await levelOf(ayse, made.body.id)).toBe('none');
    // Someone in the space may not move another's bot there, nor may those who look after the
    // server while it is in its owner's Private: they do not see it.
    expect((await move(ayse, space.id)).status).toBe(404);
    expect((await move(admin, space.id)).status).toBe(404);
    // Once in a space, they may move it to another one.
    expect((await move(mert, space.id)).status).toBe(200);
    const other = (await t.api<Group>('POST', '/api/groups', { name: 'Başka proje', space: true })).body;
    expect((await move(admin, other.id)).status).toBe(200);
  });

  it('alandaki üye, değiştirebilse de başkasının botunu Özel’e çekemez; sabitlemek botu alanda tutar', async () => {
    const space = (await t.api<Group>('POST', '/api/groups', { name: 'Ortak', space: true })).body;
    await t.api('PATCH', `/api/groups/${space.id}`, { membersEdit: true });
    await t.api('PUT', `/api/groups/${space.id}/members`, { add: ['ayse'] });
    const bot = await t.bot({ name: 'Ortak bot' });
    const move = (p: Pick<Person, 'api'>, body: { pinned: boolean; groupId: string | null }) =>
      p.api('POST', `/api/bots/${bot.id}/move`, { ...body, beforeId: null });
    expect((await move(t, { pinned: false, groupId: space.id })).status).toBe(200);
    expect(await levelOf(ayse, bot.id)).toBe('edit');

    expect((await move(ayse, { pinned: false, groupId: null })).status).toBe(403);
    expect((await move(ayse, { pinned: true, groupId: null })).status).toBe(200);
    expect((await t.services.bots.get(bot.id)).groupId).toBe(space.id);
    expect(await levelOf(ayse, bot.id)).toBe('edit');
  });

  it('gizli alandaki bot tek tek paylaşıldığı kişiye görünür, alanın kendisi görünmez', async () => {
    const secret = (await t.api<Group>('POST', '/api/groups', { name: 'Gizli işler', space: true })).body;
    const bot = await t.bot({ name: 'Tek paylaşılan' });
    await t.api('POST', `/api/bots/${bot.id}/move`, { pinned: false, groupId: secret.id, beforeId: null });
    await t.services.ctx.db
      .update(schema.bots)
      .set({ access: { everyone: 'none', people: { mert: 'chat' } } })
      .where(eq(schema.bots.id, bot.id));
    t.services.access.forget();
    const seenBot = (await mert.api<Bot[]>('GET', '/api/bots')).body.find((b) => b.id === bot.id);
    expect(seenBot?.yourLevel).toBe('chat');
    const groups = (await mert.api<Group[]>('GET', '/api/groups')).body.map((g) => g.id);
    expect(groups).not.toContain(secret.id);
  });

  it('alan silinince botlar sahiplerinin Özel’ine döner, alandakiler erişimi kaybeder', async () => {
    const space = (await t.api<Group>('POST', '/api/groups', { name: 'Silinecek', space: true })).body;
    const bot = await t.bot({ name: 'Silinen alandaki' });
    await t.api('POST', `/api/bots/${bot.id}/move`, { pinned: false, groupId: space.id, beforeId: null });
    await t.api('PUT', `/api/groups/${space.id}/members`, { add: ['ayse'] });
    expect(await levelOf(ayse, bot.id)).toBe('chat');
    expect((await ayse.api('DELETE', `/api/groups/${space.id}`)).status).toBe(403);
    expect((await t.api('DELETE', `/api/groups/${space.id}`)).status).toBe(200);
    expect(await levelOf(ayse, bot.id)).toBe('none');
  });

  it('yönetici başkasının Özel botunu görmez; yalnızca sayısını görür, duraklatır ve arşivler', async () => {
    const admin = await t.person('yonetici3', 'admin');
    const made = await mert.api<Bot>('POST', '/api/bots', {
      name: 'Mertin özeli',
      description: '',
      instructions: '',
    });
    expect((await admin.api('GET', `/api/bots/${made.body.id}`)).status).toBe(404);

    const count = await admin.api<{ count: number; paused: number }>('GET', '/api/people/mert/private-bots');
    expect(count.body.count).toBeGreaterThan(0);
    expect(count.body.paused).toBe(0);
    const paused = await admin.api<{ count: number; paused: number }>(
      'POST',
      '/api/people/mert/private-bots/pause',
      {
        paused: true,
      },
    );
    expect(paused.body.paused).toBe(paused.body.count);
    expect((await mert.api<Bot>('GET', `/api/bots/${made.body.id}`)).body.pausedAt).toBeTruthy();
    // Still not opened by doing so.
    expect((await admin.api('GET', `/api/bots/${made.body.id}`)).status).toBe(404);

    await admin.api('POST', '/api/people/mert/private-bots/archive', {});
    expect((await admin.api<{ count: number }>('GET', '/api/people/mert/private-bots')).body.count).toBe(0);
    expect((await mert.api<Bot>('GET', `/api/bots/${made.body.id}`)).body.archivedAt).toBeTruthy();
    // Someone who is not looking after the server may not.
    expect((await ayse.api('GET', '/api/people/mert/private-bots')).status).toBe(403);
  });
  it('yeni gelen kişi yöneticiye listelenir; alanları seçilince alana girer ve listeden çıkar', async () => {
    const yeni = await t.person('yeni');
    const space = (await t.api<Group>('POST', '/api/groups', { name: 'Karşılama', space: true })).body;
    const bot = await t.bot({ name: 'Karşılama botu' });
    await t.api('POST', `/api/bots/${bot.id}/move`, { pinned: false, groupId: space.id, beforeId: null });
    const waiting = async () =>
      (await t.api<{ id: string }[]>('GET', '/api/newcomers')).body.map((p) => p.id);
    expect(await waiting()).toContain('yeni');
    expect(await waiting()).not.toContain('yonetici2');
    expect((await yeni.api('GET', '/api/newcomers')).status).toBe(403);
    expect(await levelOf(yeni, bot.id)).toBe('none');

    expect((await t.api('POST', '/api/newcomers/yeni', { spaceIds: [space.id] })).status).toBe(200);
    expect(await waiting()).not.toContain('yeni');
    expect(await levelOf(yeni, bot.id)).toBe('chat');
    // A folder is nobody's space to be put in.
    const folder = (await t.api<Group>('POST', '/api/groups', { name: 'Sahibin klasörü 2' })).body;
    await t.person('yeni2');
    expect((await t.api('POST', '/api/newcomers/yeni2', { spaceIds: [folder.id] })).status).toBe(400);
    expect(await waiting()).toContain('yeni2');
  });

  it('açık alana kişi kendisi katılır ve ayrılır; gizli alanı dışarıdan bilemez', async () => {
    const kisi = await t.person('katilan');
    const open = (await t.api<Group>('POST', '/api/groups', { name: 'Açık alan', space: true, kind: 'open' }))
      .body;
    const secret = (await t.api<Group>('POST', '/api/groups', { name: 'Gizli alan', space: true })).body;
    const bot = await t.bot({ name: 'Açık alanın botu' });
    await t.api('POST', `/api/bots/${bot.id}/move`, { pinned: false, groupId: open.id, beforeId: null });
    expect(await levelOf(kisi, bot.id)).toBe('none');

    const joined = await kisi.api<{ state: string }>('POST', `/api/groups/${open.id}/join`, {});
    expect(joined.body.state).toBe('joined');
    expect(await levelOf(kisi, bot.id)).toBe('chat');
    expect((await kisi.api('POST', `/api/groups/${open.id}/leave`, {})).status).toBe(200);
    expect(await levelOf(kisi, bot.id)).toBe('none');
    // A secret space answers as if it were not there; a folder is not a space to join.
    expect((await kisi.api('POST', `/api/groups/${secret.id}/join`, {})).status).toBe(404);
    const folder = (await kisi.api<Group>('POST', '/api/groups', { name: 'Kendi klasörüm' })).body;
    expect((await kisi.api('POST', `/api/groups/${folder.id}/join`, {})).status).toBe(404);
  });

  it('kapalı alana katılma isteği yöneticiye gider; kabul edilince girer, reddedilince gider', async () => {
    const kisi = await t.person('isteyen');
    const closed = (
      await t.api<Group>('POST', '/api/groups', { name: 'Kapalı alan', space: true, kind: 'closed' })
    ).body;
    const bot = await t.bot({ name: 'Kapalı alanın botu' });
    await t.api('POST', `/api/bots/${bot.id}/move`, { pinned: false, groupId: closed.id, beforeId: null });
    type Req = { id: string; groupId: string; userId: string };
    const requests = async () => (await t.api<Req[]>('GET', '/api/space-requests')).body;
    const mine = async () =>
      (await kisi.api<Group[]>('GET', '/api/groups')).body.find((g) => g.id === closed.id);

    const asked = await kisi.api<{ state: string }>('POST', `/api/groups/${closed.id}/join`, {});
    expect(asked.body.state).toBe('requested');
    expect(await levelOf(kisi, bot.id)).toBe('none');
    expect((await mine())?.requested).toBe(true);
    // Asking twice keeps one request; only those who look after the server see them.
    await kisi.api('POST', `/api/groups/${closed.id}/join`, {});
    expect((await requests()).filter((r) => r.userId === 'isteyen')).toHaveLength(1);
    expect((await kisi.api('GET', '/api/space-requests')).status).toBe(403);

    // Denied: the request goes and nothing opens.
    const first = (await requests()).find((r) => r.userId === 'isteyen')!;
    expect((await t.api('POST', `/api/space-requests/${first.id}`, { decision: 'deny' })).status).toBe(200);
    expect((await requests()).some((r) => r.userId === 'isteyen')).toBe(false);
    expect((await mine())?.requested).toBeFalsy();
    expect(await levelOf(kisi, bot.id)).toBe('none');

    // Taken back by leaving, then asked again and let in.
    await kisi.api('POST', `/api/groups/${closed.id}/join`, {});
    await kisi.api('POST', `/api/groups/${closed.id}/leave`, {});
    expect((await requests()).some((r) => r.userId === 'isteyen')).toBe(false);
    await kisi.api('POST', `/api/groups/${closed.id}/join`, {});
    const again = (await requests()).find((r) => r.userId === 'isteyen')!;
    expect((await t.api('POST', `/api/space-requests/${again.id}`, { decision: 'allow' })).status).toBe(200);
    expect(await levelOf(kisi, bot.id)).toBe('chat');
    expect((await mine())?.memberIds).toContain('isteyen');
    expect((await t.api('POST', `/api/space-requests/${again.id}`, { decision: 'allow' })).status).toBe(404);

    // Someone who looks after the server joins a closed space at once.
    const admin = await t.person('yonetici4', 'admin');
    const direct = await admin.api<{ state: string }>('POST', `/api/groups/${closed.id}/join`, {});
    expect(direct.body.state).toBe('joined');
  });

  it('yönetici kişiyi alana doğrudan eklerse bekleyen isteği kalkar', async () => {
    const kisi = await t.person('bekleyen');
    const closed = (
      await t.api<Group>('POST', '/api/groups', { name: 'Kapalı alan 2', space: true, kind: 'closed' })
    ).body;
    await kisi.api('POST', `/api/groups/${closed.id}/join`, {});
    await t.api('PUT', `/api/groups/${closed.id}/members`, { add: ['bekleyen'] });
    const left = (await t.api<{ userId: string }[]>('GET', '/api/space-requests')).body;
    expect(left.some((r) => r.userId === 'bekleyen')).toBe(false);
  });
});
