import type { FollowUp, Thread } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { translator } from '../src/i18n';
import { MAX_OPEN_FOLLOW_UPS } from '../src/services/follow-ups';
import { followUpTime } from '../src/tools';
import { testServer, type TestServer } from './helpers';

describe('takipler: botun kendine kurduğu hatırlatmalar', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
    // 08:00 on Monday 16 November in Istanbul.
    t.now.value = new Date('2026-11-16T05:00:00.000Z');
  });
  afterEach(() => t.dispose());

  const tr = translator('tr');
  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const say = async (threadId: string, text: string) => {
    await t.send(threadId, text);
    await t.services.turns.idle();
  };
  const add = (o: object) => `[araç:followup_add ${JSON.stringify(o)}]`;
  const list = async () => (await t.api<FollowUp[]>('GET', '/api/follow-ups')).body;
  const turnsOf = (source: 'followup') =>
    t.db.db.select().from(schema.turns).where(eq(schema.turns.source, source));

  it('bot onaysız takip kurar; rutin listesinde görünmez, kişinin takip listesinde görünür', async () => {
    const bot = await t.bot({ name: 'Kahya', permissionMode: 'ask' });
    const th = await main(bot.id);
    await say(
      th.id,
      add({
        what: 'Öztürk Bey fabrikaya geliyor; kartvizitler ve teklif durumu sorulacak',
        when: '2026-11-22',
        event: '2026-11-23T10:00',
        from: 'Mail: Öztürk Baştaş, 20 Kas, Ziyaret',
      }),
    );
    // No card was asked, though the bot asks before every change.
    expect((await t.api<unknown[]>('GET', '/api/approvals?status=pending')).body).toEqual([]);
    expect(await t.services.routines.list(bot.id)).toEqual([]);
    const [f] = await list();
    expect(f).toMatchObject({
      botId: bot.id,
      text: 'Öztürk Bey fabrikaya geliyor; kartvizitler ve teklif durumu sorulacak',
      context: 'Mail: Öztürk Baştaş, 20 Kas, Ziyaret',
      kind: 'bot',
      // A day alone is the person's reminder time (09:00 in Istanbul).
      dueAt: '2026-11-22T06:00:00.000Z',
      eventAt: '2026-11-23T07:00:00.000Z',
    });
    const reply = (await t.messages(th.id)).at(-1)!;
    expect(reply.text).toContain('Takip kuruldu');
  });

  it('zamanı gelince botun kişiyle konuştuğu sohbette tur başlatır; bir kez, takvime bakmasını söyler', async () => {
    const bot = await t.bot({ name: 'Kahya' });
    const th = await main(bot.id);
    await say(th.id, add({ what: 'Ziyaret var', when: '2026-11-17T08:30', from: 'Mail: Ali' }));
    await t.services.followUps.tick();
    expect(await turnsOf('followup')).toEqual([]);
    t.now.value = new Date('2026-11-17T05:31:00.000Z');
    await Promise.all([t.services.followUps.tick(), t.services.followUps.tick()]);
    await t.services.followUps.tick();
    const turns = await turnsOf('followup');
    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({ threadId: th.id, botId: bot.id, userId: 'owner' });
    expect(turns[0]!.prompt).toContain('Ziyaret var');
    expect(turns[0]!.prompt).toContain('Mail: Ali');
    expect(turns[0]!.prompt).toContain('takvim');
    expect(await list()).toEqual([]);
    await t.services.turns.idle();
  });

  it('dış metin okumuş turdan kurulan takip o işareti taşır; geldiğinde tur da dış metin okumuş sayılır', async () => {
    const bot = await t.bot({ name: 'Kahya' });
    const th = await main(bot.id);
    await t.services.followUps.add({
      bot,
      userId: 'owner',
      threadId: th.id,
      text: 'Bir maildeki ziyaret',
      dueAt: new Date('2026-11-17T06:00:00.000Z'),
      outside: 'email',
      t: tr,
    });
    t.now.value = new Date('2026-11-17T06:01:00.000Z');
    await t.services.followUps.tick();
    const [turn] = await turnsOf('followup');
    expect(turn!.outside).toBe('email');
    await t.services.turns.idle();
  });

  it('aynı gün için aynı takip yeniden kurulunca yenisi eskisinin yerine geçer; geçmiş ya da bozuk zaman reddedilir', async () => {
    const bot = await t.bot({ name: 'Kahya' });
    const th = await main(bot.id);
    await say(th.id, add({ what: 'Öztürk Bey ziyareti', when: '2026-11-22', event: '2026-11-23T10:00' }));
    await say(
      th.id,
      add({ what: 'Öztürk Bey ziyareti', when: '2026-11-22T18:00', event: '2026-11-23T10:00' }),
    );
    const all = await list();
    expect(all).toHaveLength(1);
    expect(all[0]!.dueAt).toBe('2026-11-22T15:00:00.000Z');
    await say(th.id, add({ what: 'Geçmiş', when: '2026-11-10' }));
    expect((await t.messages(th.id)).at(-1)!.text).toContain('geçmişte');
    await say(th.id, add({ what: 'Bozuk', when: 'yarın' }));
    expect((await t.messages(th.id)).at(-1)!.text).toContain('okunamadı');
    expect(await list()).toHaveLength(1);
  });

  it('bot takiplerini listeler ve kaldırır; kişi de Bugün sayfasından kaldırır; başkası kaldıramaz', async () => {
    const bot = await t.bot({ name: 'Kahya' });
    const th = await main(bot.id);
    await say(th.id, add({ what: 'Birinci', when: '2026-11-20' }));
    await say(th.id, add({ what: 'İkinci iş', when: '2026-11-21' }));
    const [first, second] = await list();
    await say(th.id, '[araç:followup_list {}]');
    const listed = (await t.messages(th.id)).at(-1)!.text;
    expect(listed).toContain(first!.id);
    expect(listed).toContain('İkinci iş');
    await say(th.id, `[araç:followup_drop {"id":"${first!.id}"}]`);
    expect((await list()).map((f) => f.id)).toEqual([second!.id]);

    const ayse = await t.person('ayse');
    expect((await ayse.api<FollowUp[]>('GET', '/api/follow-ups')).body).toEqual([]);
    expect((await ayse.api('DELETE', `/api/follow-ups/${second!.id}`)).status).toBe(404);
    expect((await t.api('DELETE', `/api/follow-ups/${second!.id}`)).status).toBe(200);
    expect(await list()).toEqual([]);
  });

  it('durdurulmuş bot sonra söyler; arşivlenmiş botun ve bir günden fazla kaçırılmış takip düşer', async () => {
    const paused = await t.bot({ name: 'Bekleyen' });
    const gone = await t.bot({ name: 'Giden' });
    const late = await t.bot({ name: 'Geç' });
    const at = new Date('2026-11-17T06:00:00.000Z');
    for (const b of [paused, gone, late])
      await t.services.followUps.add({
        bot: b,
        userId: 'owner',
        threadId: null,
        text: b.name,
        dueAt: at,
        t: tr,
      });
    await t.api('POST', `/api/bots/${paused.id}/pause`, { paused: true });
    await t.api('POST', `/api/bots/${gone.id}/archive`);
    await t.db.db
      .update(schema.followUps)
      .set({ dueAt: new Date('2026-11-15T06:00:00.000Z') })
      .where(eq(schema.followUps.botId, late.id));
    t.now.value = new Date('2026-11-17T06:05:00.000Z');
    await t.services.followUps.tick();
    const rows = await t.db.db.select().from(schema.followUps);
    const status = (botId: string) => rows.find((r) => r.botId === botId)!.status;
    expect(status(paused.id)).toBe('open');
    expect(status(gone.id)).toBe('dropped');
    expect(status(late.id)).toBe('dropped');
    expect(await turnsOf('followup')).toEqual([]);
  });

  it('bir bot bir kişi için sınırlı sayıda takip tutar', async () => {
    const bot = await t.bot({ name: 'Kahya' });
    const due = new Date('2026-11-20T06:00:00.000Z');
    await t.db.db.insert(schema.followUps).values(
      Array.from({ length: MAX_OPEN_FOLLOW_UPS }, (_, i) => ({
        id: `f-${i}`,
        botId: bot.id,
        userId: 'owner',
        text: `takip ${i} ${'x'.repeat(i % 7)} ${i * 17}`,
        dueAt: new Date(due.getTime() + i * 86_400_000),
      })),
    );
    const th = await main(bot.id);
    await say(th.id, add({ what: 'Bir tane daha', when: '2026-11-19' }));
    expect((await t.messages(th.id)).at(-1)!.text).toContain(`en fazla ${MAX_OPEN_FOLLOW_UPS}`);
  });

  it('ekip konuşmasında takip araçları yoktur', async () => {
    const bot = await t.bot({ name: 'Ekip' });
    const team = await t.services.threads.create(bot.id, { kind: 'team', userId: null, title: 'Kanal' });
    await say(team.id, add({ what: 'x', when: '2026-11-20' }));
    expect((await t.messages(team.id)).at(-1)!.text).toContain('followup_add: araç yok');
  });

  it('gün tek başına verilince kişinin hatırlatma saati kullanılır', () => {
    expect(followUpTime('2026-11-20', 'Europe/Istanbul', '09:00')).toBe('2026-11-20T06:00:00.000Z');
    expect(followUpTime('2026-11-20T18:15', 'Europe/Istanbul', '09:00')).toBe('2026-11-20T15:15:00.000Z');
    expect(followUpTime('2026-02-30', 'Europe/Istanbul', '09:00')).toBeUndefined();
    expect(followUpTime('cuma', 'Europe/Istanbul', '09:00')).toBeUndefined();
  });

  describe('kendiliğinden kontrol', () => {
    /** The bot's conversation with the owner, its messages moved to `at`. */
    const talked = async (botId: string, at: string) => {
      const th = await main(botId);
      await say(th.id, 'merhaba');
      await t.db.db
        .update(schema.messages)
        .set({ createdAt: new Date(at) })
        .where(eq(schema.messages.threadId, th.id));
      return th;
    };
    const checkIns = async () =>
      (await turnsOf('followup')).filter((x) => x.prompt.includes('Kendiliğinden kontrol'));
    const at = async (iso: string) => {
      t.now.value = new Date(iso);
      await t.services.followUps.tick();
    };

    it('saatler kadar sessizlikten sonra gündüz bir kez bakar; ayarı kapalı botta bakmaz', async () => {
      const bot = await t.bot({ name: 'Kahya' });
      const off = await t.bot({ name: 'Sessiz' });
      expect(bot.checkInHours).toBe(0);
      const patched = await t.api<{ checkInHours: number }>('PATCH', `/api/bots/${bot.id}`, {
        checkInHours: 3,
      });
      expect(patched.body.checkInHours).toBe(3);
      expect((await t.api('PATCH', `/api/bots/${bot.id}`, { checkInHours: 5 })).status).toBe(400);
      // 09:00 in Istanbul on Monday.
      const th = await talked(bot.id, '2026-11-16T06:00:00.000Z');
      await talked(off.id, '2026-11-16T06:00:00.000Z');
      // Two hours later it is not yet due.
      await at('2026-11-16T08:00:00.000Z');
      expect(await checkIns()).toEqual([]);
      // Three and a half hours later it looks, once, in the person's conversation.
      await at('2026-11-16T09:30:00.000Z');
      const [first] = await checkIns();
      expect(first).toMatchObject({ threadId: th.id, botId: bot.id, userId: 'owner' });
      expect(first!.prompt).toContain('NO_REPLY');
      expect(first!.prompt).toContain('3 saattir');
      await t.services.turns.idle();
      // The turn's own answer is new talk; and in any case not again before three more hours.
      await at('2026-11-16T10:00:00.000Z');
      expect(await checkIns()).toHaveLength(1);
    });

    it('gece bakmaz; yakın zamanda konuşulduysa bakmaz', async () => {
      const bot = await t.bot({ name: 'Kahya' });
      await t.api('PATCH', `/api/bots/${bot.id}`, { checkInHours: 3 });
      await talked(bot.id, '2026-11-16T12:00:00.000Z');
      // 23:30 in Istanbul.
      await at('2026-11-16T20:30:00.000Z');
      expect(await checkIns()).toEqual([]);
      // The next morning, but the person wrote an hour ago.
      await talked(bot.id, '2026-11-17T05:00:00.000Z');
      await at('2026-11-17T06:00:00.000Z');
      expect(await checkIns()).toEqual([]);
    });
  });
});
