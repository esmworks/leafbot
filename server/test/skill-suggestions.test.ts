import type { Skill, SkillSuggestion, UsageReport } from '@leafbot/shared';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { parseSkill, workSteps } from '../src/services/skill-suggestions';
import { OWNER_ID } from '../src/users';
import { testServer, type TestServer } from './helpers';

describe('beceri önerileri: tekrar tekrar yaptırılan çok adımlı işten beceri', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
    t.now.value = new Date();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) =>
    (await t.api<{ id: string }>('GET', `/api/bots/${botId}/main-thread`)).body.id;
  /** Three working steps, as a bot takes for a report. */
  const work = '[araç:bots_list {}] [araç:conversations_search {"query":"satış"}] [araç:my_activity {}]';
  const say = async (threadId: string, text: string) => {
    await t.send(threadId, text);
    await t.services.turns.idle();
  };
  /** Moves a conversation's messages this many days back, so its requests fall on other days. */
  const back = async (threadId: string, days: number) => {
    await t.db.db
      .update(schema.messages)
      .set({ createdAt: sql`${schema.messages.createdAt} - ${sql.raw(`interval '${days} days'`)}` })
      .where(eq(schema.messages.threadId, threadId));
  };
  const skill = (o: { name?: string; description?: string; body?: string } = {}) =>
    JSON.stringify({
      name: o.name ?? 'Haftalık Satış Raporu',
      description: o.description ?? 'Haftalık satış raporu istendiğinde kullan.',
      body: o.body ?? '1. Botları listele.\n2. Modelleri listele.\n3. Tabloyu bölgeye göre ayır.',
    });
  const suggestions = async () => (await t.api<SkillSuggestion[]>('GET', '/api/skill-suggestions')).body;
  /** Three report requests on two days, each done in three steps, one corrected afterwards. */
  const reports = async (botId: string) => {
    const th = await main(botId);
    await say(th, `haftalık satış raporunu hazırla ${work}`);
    await say(th, 'tabloyu bölgeye göre ayır');
    await back(th, 1);
    await say(th, `haftalık satış raporunu hazırla lütfen ${work}`);
    await say(th, `bu haftanın satış raporunu hazırla ${work}`);
    return th;
  };

  it('turun adımları sırasıyla kaydedilir; kitap tutma adımları iş sayılmaz', async () => {
    const bot = await t.bot({ name: 'Rapor' });
    const th = await main(bot.id);
    await say(th, `rapor [araç:memory_search {"query":"rapor"}] ${work}`);
    const [turn] = await t.db.db.select().from(schema.turns).where(eq(schema.turns.threadId, th));
    const steps = turn!.steps!;
    expect(steps.map((s) => s.tool)).toEqual([
      'memory_search',
      'bots_list',
      'conversations_search',
      'my_activity',
    ]);
    expect(steps.every((s) => s.step.length > 0)).toBe(true);
    expect(workSteps(steps).map((s) => s.tool)).toEqual(['bots_list', 'conversations_search', 'my_activity']);
    // A turn with no step keeps none.
    await say(th, 'teşekkürler');
    const turns = await t.db.db.select().from(schema.turns).where(eq(schema.turns.threadId, th));
    expect(turns.filter((x) => x.steps === null)).toHaveLength(1);
  });

  it('aynı çok adımlı iş üç kez, iki günde istenince adımlar ve düzeltmeyle beceri önerir; eklenince bota açılır', async () => {
    const bot = await t.bot({ name: 'Rapor' });
    await reports(bot.id);
    t.engine.completer = () => skill();
    expect(await t.services.skillSuggestions.run(OWNER_ID)).toBe(1);
    const asked = t.engine.completions.at(-1)!;
    expect(asked.system).toContain('skill');
    expect(asked.user).toContain('<tasks>');
    expect(asked.user).toContain('haftalık satış raporunu hazırla');
    expect(asked.user).toMatch(/<steps>\n1\. /);
    // What the person wrote after the answer goes with it, as their word on the result.
    expect(asked.user).toContain('<then>tabloyu bölgeye göre ayır</then>');

    const [s] = await suggestions();
    expect(s).toMatchObject({
      botId: bot.id,
      name: 'haftalik-satis-raporu',
      requests: 3,
      canCreate: true,
    });
    expect(s!.days).toHaveLength(2);
    // The call shows on the usage page, by the bot whose model wrote it.
    const usage = (await t.api<UsageReport>('GET', `/api/usage?days=7&bot=${bot.id}`)).body;
    expect(usage.skillSuggestions).toEqual({ checks: 1, costUsd: 0.001, found: 1 });

    const added = await t.api<Skill>('POST', `/api/skill-suggestions/${s!.id}/accept`, {
      body: 'Raporu bölgeye göre ayır.',
    });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ name: 'haftalik-satis-raporu', body: 'Raporu bölgeye göre ayır.' });
    expect(added.body.botIds).toEqual([bot.id]);
    expect(await suggestions()).toEqual([]);
    // Taken once: a second tap finds nothing.
    expect((await t.api('POST', `/api/skill-suggestions/${s!.id}/accept`, {})).status).toBe(404);

    // The same kind of task is not offered again, now that a skill covers it.
    t.now.value = new Date(t.now.value.getTime() + 8 * 86_400_000);
    expect(await t.services.skillSuggestions.run(OWNER_ID)).toBe(0);
  });

  it('az adımlı işlerden, tek günden ya da iki istekten öneri çıkmaz', async () => {
    const bot = await t.bot({ name: 'Sohbet' });
    const th = await main(bot.id);
    // Three times, on two days, but one step each.
    await say(th, 'haftalık satış raporunu hazırla [araç:bots_list {}]');
    await back(th, 1);
    await say(th, 'haftalık satış raporunu hazırla [araç:bots_list {}]');
    await say(th, 'haftalık satış raporunu hazırla [araç:bots_list {}]');
    // Many steps, but on one day.
    const other = await t.bot({ name: 'Tek gün' });
    const th2 = await main(other.id);
    for (let i = 0; i < 3; i++) await say(th2, `aylık gider tablosunu çıkar ${work}`);
    expect(await t.services.skillSuggestions.run(OWNER_ID)).toBe(0);
    expect(t.engine.completions).toHaveLength(0);
  });

  it('botun bu işi kapsayan bir becerisi varsa önermez; ad alınmışsa sonuna sayı ekler', async () => {
    const bot = await t.bot({ name: 'Rapor' });
    await t.api('POST', '/api/skills', {
      name: 'haftalik-satis-raporu',
      description: 'Haftalık satış raporunu hazırlar',
      body: 'x',
      botIds: [bot.id],
    });
    await reports(bot.id);
    expect(await t.services.skillSuggestions.run(OWNER_ID)).toBe(0);
    expect(t.engine.completions).toHaveLength(0);

    // Another bot with no such skill gets one, under a free name.
    const other = await t.bot({ name: 'Satış' });
    await reports(other.id);
    t.engine.completer = () => skill();
    t.now.value = new Date(t.now.value.getTime() + 8 * 86_400_000);
    expect(await t.services.skillSuggestions.run(OWNER_ID)).toBe(1);
    expect((await suggestions())[0]!.name).toBe('haftalik-satis-raporu-2');
  });

  it('"bu değil" denen bir daha önerilmez; adı alınmış beceri eklenemezse öneri açık kalır', async () => {
    const bot = await t.bot({ name: 'Rapor' });
    await reports(bot.id);
    t.engine.completer = () => skill();
    await t.services.skillSuggestions.run(OWNER_ID);
    const [s] = await suggestions();
    await t.api('POST', '/api/skills', { name: 'baska-bir-ad', description: 'x', body: 'x' });
    const clash = await t.api('POST', `/api/skill-suggestions/${s!.id}/accept`, { name: 'baska-bir-ad' });
    expect(clash.status).toBe(409);
    expect(await suggestions()).toHaveLength(1);

    expect((await t.api('POST', `/api/skill-suggestions/${s!.id}/dismiss`)).status).toBe(200);
    expect(await suggestions()).toEqual([]);
    t.now.value = new Date(t.now.value.getTime() + 8 * 86_400_000);
    expect(await t.services.skillSuggestions.run(OWNER_ID)).toBe(0);
  });

  it('kişiye özeldir; yalnızca konuşabilen ekleyemez', async () => {
    const bot = await t.bot({ name: 'Rapor' });
    await reports(bot.id);
    t.engine.completer = () => skill();
    await t.services.skillSuggestions.run(OWNER_ID);
    const [s] = await suggestions();

    // Another person neither sees nor answers it.
    const ayse = await t.person('ayse');
    expect((await ayse.api<SkillSuggestion[]>('GET', '/api/skill-suggestions')).body).toEqual([]);
    expect((await ayse.api('POST', `/api/skill-suggestions/${s!.id}/accept`, {})).status).toBe(404);
    // A suggestion of a person who may only talk with the bot cannot be added by them.
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    await t.db.db
      .update(schema.skillSuggestions)
      .set({ userId: 'ayse' })
      .where(eq(schema.skillSuggestions.id, s!.id));
    const theirs = (await ayse.api<SkillSuggestion[]>('GET', '/api/skill-suggestions')).body;
    expect(theirs).toMatchObject([{ id: s!.id, canCreate: false }]);
    expect((await ayse.api('POST', `/api/skill-suggestions/${s!.id}/accept`, {})).status).toBe(403);
  });

  it('modelin cevabını dikkatle okur: adı beceri adına çevirir, eksik olanı atar', () => {
    expect(parseSkill('olmaz')).toBeNull();
    expect(parseSkill('{"name":"x","description":"y"}')).toBeNull();
    expect(parseSkill('Şöyle: {"name":"Aylık Gider Özeti","description":"d","body":"b"}')).toEqual({
      name: 'aylik-gider-ozeti',
      description: 'd',
      body: 'b',
    });
  });
});
