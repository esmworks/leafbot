import { questionItems, type Approval, type Bot, type Thread } from '@leafbot/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';

/** A manager bot sets up a team of bots, with their skills, routines and notes, on one card. */
describe('a bot factory plan', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const plan = {
    purpose: 'Teklif ekibi',
    bots: [
      {
        name: 'Toplayıcı',
        description: 'Talepleri toplar',
        instructions: 'Gelen talepleri her sabah listele.',
        routines: [
          {
            name: 'Sabah listesi',
            prompt: 'Dünkü talepleri listele',
            schedule: { type: 'daily', time: '09:00' },
            report_only: true,
          },
        ],
        notes: ['Talepler satis@ornek.com adresine gelir.'],
      },
      {
        name: 'Yazıcı',
        description: 'Teklif yazar',
        instructions: 'Listedeki her talep için bir teklif taslağı yaz.',
        skills: [
          { name: 'teklif-yazimi', description: 'Teklif yazarken', body: '1. Fiyatı yaz\n2. Süreyi yaz' },
        ],
      },
    ],
  };
  const call = `[araç:bot_factory ${JSON.stringify(plan)}]`;
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
  const card = () => waitFor(async () => (await pending())[0]);
  const made = async () =>
    (await t.api<Bot[]>('GET', '/api/bots')).body.filter((b) => ['Toplayıcı', 'Yazıcı'].includes(b.name));

  it('lists everything on one card and sets it all up on a yes, as a bot the manager creates', async () => {
    const group = (await t.api<{ id: string }>('POST', '/api/groups', { name: 'Satış' })).body;
    const m = await t.bot({ name: 'Müdür', isManager: true, permissionMode: 'auto', groupId: group.id });
    const home = await main(m.id);
    await t.send(home.id, call);
    const c = await card();
    // Asked even though the manager may do everything else by itself.
    expect(c.kind).toBe('question');
    const { title, items } = questionItems(c);
    expect(title).toBe('Teklif ekibi');
    const shown = items[0]!.context!;
    for (const text of [
      'Toplayıcı',
      'Yazıcı',
      'Sabah listesi',
      'teklif-yazimi',
      '1 not',
      'kapalı',
      'internete kapalı',
    ])
      expect(shown).toContain(text);
    expect(await made()).toHaveLength(0);

    await t.api('POST', `/api/approvals/${c.id}`, { decision: 'allow', answer: 'Onayla' });
    await t.services.turns.idle();
    const bots = await made();
    expect(bots).toHaveLength(2);
    for (const b of bots)
      expect(b).toMatchObject({
        permissionMode: 'auto',
        internet: false,
        isManager: false,
        groupId: group.id,
      });
    const ids = bots.map((b) => b.id);
    const owners = await t.db.db
      .select({ owner: schema.bots.ownerUserId })
      .from(schema.bots)
      .where(inArray(schema.bots.id, ids));
    expect(owners.every((o) => o.owner === 'owner')).toBe(true);
    const routines = await t.db.db.select().from(schema.routines).where(inArray(schema.routines.botId, ids));
    expect(routines).toHaveLength(1);
    expect(routines[0]).toMatchObject({ enabled: false, reportOnly: true, createdByUserId: 'owner' });
    const [skill] = await t.db.db.select().from(schema.skills).where(eq(schema.skills.name, 'teklif-yazimi'));
    const writer = bots.find((b) => b.name === 'Yazıcı')!;
    const links = await t.db.db.select().from(schema.botSkills).where(eq(schema.botSkills.botId, writer.id));
    expect(links.map((l) => l.skillId)).toEqual([skill!.id]);
    const notes = await t.db.db.select().from(schema.memories).where(inArray(schema.memories.botId, ids));
    expect(notes.map((n) => n.content)).toEqual(['Talepler satis@ornek.com adresine gelir.']);
    const audit = await t.db.db.select().from(schema.auditLog).where(inArray(schema.auditLog.targetId, ids));
    expect(audit.filter((a) => a.actor === `bot:${m.id}`)).toHaveLength(2);
    expect((await t.messages(home.id)).at(-1)!.text).toContain('Kuruldu');
  });

  it('sets up nothing on a no', async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true });
    await t.send((await main(m.id)).id, call);
    const c = await card();
    await t.api('POST', `/api/approvals/${c.id}`, { decision: 'allow', answer: 'Reddet' });
    await t.services.turns.idle();
    expect(await made()).toHaveLength(0);
    expect(
      await t.db.db.select().from(schema.skills).where(eq(schema.skills.name, 'teklif-yazimi')),
    ).toHaveLength(0);
  });

  it('refuses a name that is taken before it asks, and saves nothing when one is taken while the card waits', async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true });
    const home = await main(m.id);
    await t.bot({ name: 'yazıcı' });
    await t.send(home.id, call);
    await t.services.turns.idle();
    expect(await pending()).toHaveLength(0);
    expect((await t.messages(home.id)).at(-1)!.text).toContain('zaten var');

    const other = await t.bot({ name: 'Başka' });
    await t.api(
      'PATCH',
      `/api/bots/${(await t.api<Bot[]>('GET', '/api/bots')).body.find((b) => b.name === 'yazıcı')!.id}`,
      {
        name: 'Eski yazıcı',
      },
    );
    await t.send(home.id, call);
    const c = await card();
    // Someone names a bot "Toplayıcı" before the person says yes.
    await t.api('PATCH', `/api/bots/${other.id}`, { name: 'Toplayıcı' });
    await t.api('POST', `/api/approvals/${c.id}`, { decision: 'allow', answer: 'Onayla' });
    await t.services.turns.idle();
    expect((await t.api<Bot[]>('GET', '/api/bots')).body.filter((b) => b.name === 'Yazıcı')).toHaveLength(0);
    expect(
      await t.db.db.select().from(schema.skills).where(eq(schema.skills.name, 'teklif-yazimi')),
    ).toHaveLength(0);
    expect((await t.messages(home.id)).at(-1)!.text).toContain('hiçbir şey kaydedilmedi');
  });

  it('is a manager’s alone', async () => {
    const b = await t.bot({ name: 'Sıradan' });
    await t.send((await main(b.id)).id, call);
    await t.services.turns.idle();
    expect(await pending()).toHaveLength(0);
    expect(await made()).toHaveLength(0);
  });
});
