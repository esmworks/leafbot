import type { Thread, UsageReport } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { translator } from '../src/i18n';
import {
  MAX_OPEN_FOLLOW_UPS,
  namesAMoment,
  nextDaytime,
  readMoment,
  remindTime,
} from '../src/services/follow-ups';
import { followUpTime } from '../src/tools';
import { testServer, type TestServer } from './helpers';

const TZ = 'Europe/Istanbul';

describe('takipler: botun kendi takvimi', () => {
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
    await t.services.followUps.idle();
  };
  const add = (o: object) => `[araç:followup_add ${JSON.stringify(o)}]`;
  const open = () =>
    t.db.db
      .select()
      .from(schema.followUps)
      .where(eq(schema.followUps.status, 'open'))
      .orderBy(schema.followUps.dueAt);
  const followTurns = () => t.db.db.select().from(schema.turns).where(eq(schema.turns.source, 'followup'));
  const at = async (iso: string) => {
    t.now.value = new Date(iso);
    await t.services.followUps.tick();
  };

  describe('ne zaman haber verilir', () => {
    const now = new Date('2026-11-21T17:00:00.000Z'); // Saturday 20:00 in Istanbul
    const base = { now, timezone: TZ, dayTime: '09:00', present: false };
    it('bir gün önce sabah; geçtiyse o sabah; o da geçtiyse iki saat önce; hep gündüz', () => {
      // Monday 10:00: Sunday 09:00.
      expect(
        remindTime({
          ...base,
          eventAt: new Date('2026-11-23T07:00:00.000Z'),
          eventHasTime: true,
        })!.toISOString(),
      ).toBe('2026-11-22T06:00:00.000Z');
      // Sunday 14:00, learned Saturday 20:00: the morning before has gone; Sunday 09:00.
      expect(
        remindTime({
          ...base,
          eventAt: new Date('2026-11-22T11:00:00.000Z'),
          eventHasTime: true,
        })!.toISOString(),
      ).toBe('2026-11-22T06:00:00.000Z');
      // Sunday 10:30: that morning is less than two hours before; two hours before is 08:30.
      expect(
        remindTime({
          ...base,
          eventAt: new Date('2026-11-22T07:30:00.000Z'),
          eventHasTime: true,
        })!.toISOString(),
      ).toBe('2026-11-22T05:30:00.000Z');
      // A day alone (Monday): Sunday 09:00.
      expect(
        remindTime({
          ...base,
          eventAt: new Date('2026-11-22T21:00:00.000Z'),
          eventHasTime: false,
        })!.toISOString(),
      ).toBe('2026-11-22T06:00:00.000Z');
    });
    it('vakit kalmadıysa: kişi şu an konuşuyorsa hiç, değilse hemen ama gece değil', () => {
      // Saturday 23:30, three and a half hours from 20:00.
      const soon = { ...base, eventAt: new Date('2026-11-21T20:30:00.000Z'), eventHasTime: true };
      // The person is talking about it right now: none.
      expect(remindTime({ ...soon, present: true })).toBeNull();
      // Learned from a mail: now, within the day.
      expect(remindTime(soon)!.toISOString()).toBe('2026-11-21T17:02:00.000Z');
      // At 23:00 for a thing at 07:30 tomorrow: the next morning, 08:00, is too late; none.
      const late = { ...base, now: new Date('2026-11-21T20:00:00.000Z') };
      expect(
        remindTime({ ...late, eventAt: new Date('2026-11-22T04:30:00.000Z'), eventHasTime: true }),
      ).toBeNull();
      expect(nextDaytime(new Date('2026-11-21T20:00:00.000Z'), TZ, null)!.toISOString()).toBe(
        '2026-11-22T05:00:00.000Z',
      );
    });
    it('bir zamanı ve bir günü okur; gerçek olmayanı okumaz; zaman adı geçen metni tanır', () => {
      expect(readMoment('2026-11-23 10:00', TZ)).toEqual({
        at: new Date('2026-11-23T07:00:00.000Z'),
        hasTime: true,
      });
      expect(readMoment('2026-11-23', TZ)).toEqual({
        at: new Date('2026-11-22T21:00:00.000Z'),
        hasTime: false,
      });
      expect(readMoment('2026-02-30', TZ)).toBeNull();
      expect(readMoment('pazartesi', TZ)).toBeNull();
      expect(namesAMoment('Öztürk Bey pazartesi geliyor')).toBe(true);
      expect(namesAMoment('Toplantı 23.11 saat 10:00')).toBe(true);
      expect(namesAMoment('merhaba, nasılsın')).toBe(false);
      expect(followUpTime('2026-11-20', TZ, '09:00')).toBe('2026-11-20T06:00:00.000Z');
    });
  });

  it('bot onaysız takip kurar; saati sistem seçer; rutin listesinde görünmez', async () => {
    const bot = await t.bot({ name: 'Kahya', permissionMode: 'ask' });
    const th = await main(bot.id);
    await say(
      th.id,
      add({
        what: 'Öztürk Bey fabrikaya geliyor; kartvizitler ve teklif sorulacak',
        event: '2026-11-23 10:00',
        from: 'Mail: Öztürk Baştaş, Ziyaret',
      }),
    );
    expect((await t.api<unknown[]>('GET', '/api/approvals?status=pending')).body).toEqual([]);
    expect(await t.services.routines.list(bot.id)).toEqual([]);
    const [f] = await open();
    expect(f).toMatchObject({ botId: bot.id, userId: 'owner', kind: 'bot', eventHasTime: true });
    // The morning before, at the person's reminder time.
    expect(f!.dueAt.toISOString()).toBe('2026-11-22T06:00:00.000Z');
    expect((await t.messages(th.id)).at(-1)!.text).toContain('Takip kuruldu');
  });

  it('aynı şey iki bottan gelirse tek kayıt kalır; ertelenince yeri değişir', async () => {
    const a = await t.bot({ name: 'Kahya' });
    const b = await t.bot({ name: 'Asistan' });
    await say((await main(a.id)).id, add({ what: 'Öztürk Bey fabrika ziyareti', event: '2026-11-23 10:00' }));
    await say((await main(b.id)).id, add({ what: 'Öztürk Bey fabrika ziyareti var', event: '2026-11-23' }));
    let all = await open();
    expect(all).toHaveLength(1);
    // Kept by the bot that learned it first.
    expect(all[0]!.botId).toBe(a.id);
    await say(
      (await main(a.id)).id,
      add({ what: 'Öztürk Bey ziyareti perşembeye kaldı', event: '2026-11-26 10:00', replaces: all[0]!.id }),
    );
    all = await open();
    expect(all).toHaveLength(1);
    expect(all[0]!.dueAt.toISOString()).toBe('2026-11-25T06:00:00.000Z');
  });

  it('turdan sonra konuşmada geçen yaklaşan şeyi kendiliğinden takvime alır; ertelenince taşır, iptal olunca kaldırır', async () => {
    t.services.followUps.readTurns = true;
    const bot = await t.bot({ name: 'Kahya' });
    const th = await main(bot.id);
    const reader = (changes: object[]) => {
      t.engine.completer = (req) => (req.system.includes('takvimine') ? JSON.stringify({ changes }) : '{}');
    };
    reader([
      {
        op: 'add',
        what: 'Öztürk Baştaş Günay fabrikaya geliyor',
        event: '2026-11-23 10:00',
        from: 'Mail: Kıvanç Bey, Re: Fabrika ziyareti',
      },
    ]);
    // Nothing that names a moment: the model is not asked.
    await say(th.id, 'merhaba');
    expect(t.engine.completions).toHaveLength(0);
    await say(th.id, 'Öztürk Bey pazartesi saat 10da fabrikaya geliyor');
    expect(t.engine.completions).toHaveLength(1);
    const asked = t.engine.completions[0]!;
    expect(asked.user).toContain('<now>2026-11-16 08:00, Europe/Istanbul</now>');
    expect(asked.user).toContain('pazartesi saat 10da');
    let [f] = await open();
    expect(f).toMatchObject({
      botId: bot.id,
      text: 'Öztürk Baştaş Günay fabrikaya geliyor',
      eventHasTime: true,
    });
    expect(f!.context).toBe('Mail: Kıvanç Bey, Re: Fabrika ziyareti');
    expect(f!.dueAt.toISOString()).toBe('2026-11-22T06:00:00.000Z');
    const usage = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(usage.background).toEqual([{ kind: 'followUps', calls: 1, costUsd: 0.001 }]);

    // Put off.
    reader([{ op: 'move', id: f!.id, event: '2026-11-26 10:00' }]);
    await say(th.id, 'Öztürk Bey ziyareti perşembeye kaydı');
    expect(t.engine.completions.at(-1)!.user).toContain(`[${f!.id}]`);
    [f] = await open();
    expect(f!.eventAt!.toISOString()).toBe('2026-11-26T07:00:00.000Z');
    expect(f!.text).toBe('Öztürk Baştaş Günay fabrikaya geliyor');

    // Called off.
    reader([{ op: 'drop', id: f!.id }]);
    await say(th.id, 'Perşembe ziyareti iptal oldu');
    expect(await open()).toEqual([]);
  });

  it('dış metin okumuş turdan çıkan takip o işareti taşır; geldiğinde tur da öyle sayılır, cevap işaretlenir', async () => {
    const bot = await t.bot({ name: 'Kahya' });
    const th = await main(bot.id);
    await t.services.followUps.add({
      bot,
      userId: 'owner',
      threadId: th.id,
      text: 'Bir maildeki ziyaret',
      eventAt: new Date('2026-11-18T07:00:00.000Z'),
      eventHasTime: true,
      outside: 'email',
      t: tr,
    });
    await at('2026-11-17T06:01:00.000Z');
    const [turn] = await followTurns();
    expect(turn).toMatchObject({ threadId: th.id, botId: bot.id, userId: 'owner', outside: 'email' });
    expect(turn!.prompt).toContain('Bir maildeki ziyaret');
    expect(turn!.prompt).toContain('takvim');
    await t.services.turns.idle();
    const reply = (await t.messages(th.id)).filter((m) => m.role === 'assistant').at(-1)!;
    expect(reply.props.followUp).toBe(true);
  });

  it('kaçmaz: durmuş bot bekler, arşivlenen botun yerine kişinin başka botu söyler, gece beklenir; olay geçtiyse düşer', async () => {
    const paused = await t.bot({ name: 'Bekleyen' });
    const gone = await t.bot({ name: 'Giden' });
    const other = await t.bot({ name: 'Diğeri' });
    await say((await main(other.id)).id, 'selam');
    const make = (bot: { id: string }, text: string, event: string) =>
      t.services.followUps.add({
        bot,
        userId: 'owner',
        threadId: null,
        text,
        eventAt: new Date(event),
        eventHasTime: true,
        t: tr,
      });
    await make(paused, 'durmuş iş', '2026-11-18T12:00:00.000Z');
    await make(gone, 'arşivlenmiş iş', '2026-11-18T13:00:00.000Z');
    await make(other, 'geçmiş iş', '2026-11-17T12:00:00.000Z');
    await t.api('POST', `/api/bots/${paused.id}/pause`, { paused: true });
    await t.api('POST', `/api/bots/${gone.id}/archive`);
    // The night after their time: nothing comes up at night.
    await at('2026-11-17T20:30:00.000Z');
    expect(await followTurns()).toEqual([]);
    // The next morning: the one whose bot is gone comes up through the other bot; the one whose
    // thing is over is dropped; the paused bot's waits.
    await at('2026-11-18T05:10:00.000Z');
    const turns = await followTurns();
    expect(turns).toHaveLength(1);
    expect(turns[0]!.botId).toBe(other.id);
    expect(turns[0]!.prompt).toContain('arşivlenmiş iş');
    const rows = await t.db.db.select().from(schema.followUps);
    const status = (text: string) => rows.find((r) => r.text === text)!.status;
    expect(status('durmuş iş')).toBe('open');
    expect(status('geçmiş iş')).toBe('dropped');
    await t.services.turns.idle();
  });

  it('bot takvimdekileri listeler ve kaldırır; başkasınınkini kaldıramaz; kişi başına sınırlı', async () => {
    const bot = await t.bot({ name: 'Kahya' });
    const th = await main(bot.id);
    await say(th.id, add({ what: 'Birinci', event: '2026-11-20' }));
    await say(th.id, add({ what: 'İkinci iş', event: '2026-11-21' }));
    const [first, second] = await open();
    await say(th.id, '[araç:followup_list {}]');
    const listed = (await t.messages(th.id)).at(-1)!.text;
    expect(listed).toContain(first!.id);
    expect(listed).toContain('İkinci iş');
    await say(th.id, `[araç:followup_drop {"id":"${first!.id}"}]`);
    expect((await open()).map((f) => f.id)).toEqual([second!.id]);
    await expect(t.services.followUps.drop(second!.id, 'ayse')).rejects.toThrow();

    await t.db.db.insert(schema.followUps).values(
      Array.from({ length: MAX_OPEN_FOLLOW_UPS }, (_, i) => ({
        id: `f-${i}`,
        botId: bot.id,
        userId: 'owner',
        text: `takip ${i} ${'x'.repeat(i % 7)} ${i * 17}`,
        dueAt: new Date(Date.UTC(2027, 0, 1) + i * 86_400_000),
      })),
    );
    await say(th.id, add({ what: 'Bir tane daha', event: '2026-11-19' }));
    expect((await t.messages(th.id)).at(-1)!.text).toContain(`en fazla ${MAX_OPEN_FOLLOW_UPS}`);
  });

  it('ekip konuşmasında takip araçları yoktur ve okuma yapılmaz', async () => {
    t.services.followUps.readTurns = true;
    const bot = await t.bot({ name: 'Ekip' });
    const team = await t.services.threads.create(bot.id, { kind: 'team', userId: null, title: 'Kanal' });
    await say(team.id, `yarın toplantı var ${add({ what: 'x', event: '2026-11-20' })}`);
    expect((await t.messages(team.id)).at(-1)!.text).toContain('followup_add: araç yok');
    expect(t.engine.completions).toHaveLength(0);
  });
});
