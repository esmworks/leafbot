import { readFileSync } from 'node:fs';
import type { Message, Room, Thread, TodayReport, UsageReport } from '@leafbot/shared';
import { asc, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { runCost } from '../src/engine/types';
import { lastDays } from '../src/services/usage';
import { AUTH, testServer, type TestServer } from './helpers';

describe('kullanım raporu', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
    // 08:00 in Istanbul (UTC+3).
    t.now.value = new Date('2026-11-16T05:00:00.000Z');
  });
  afterEach(() => t.dispose());

  const turn = async (
    botId: string,
    finishedAt: string,
    costUsd: number | null,
    model: { engine: 'claude' | 'pi'; model: string } | null = null,
  ) => {
    const thread = (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
    await t.db.db.insert(schema.turns).values({
      id: `tur-${Math.random().toString(36).slice(2)}`,
      threadId: thread.id,
      botId,
      source: 'user',
      status: costUsd === null ? 'error' : 'done',
      prompt: 'x',
      costUsd,
      finishedAt: new Date(finishedAt),
      ...model,
    });
  };

  it('botları ve günleri toplar; günü saat dilimine göre sayar; arşivlenen bot kalır', async () => {
    const a = await t.bot({ name: 'Katip' });
    const b = await t.bot({ name: 'Gezgin' });
    // 22:30 UTC on the 15th is already the 16th in Istanbul.
    await turn(a.id, '2026-11-15T22:30:00.000Z', 0.5);
    await turn(a.id, '2026-11-14T10:00:00.000Z', 0.25);
    await turn(a.id, '2026-11-14T11:00:00.000Z', null);
    await turn(b.id, '2026-11-15T09:00:00.000Z', 1);
    // Outside a 7-day report.
    await turn(b.id, '2026-11-01T09:00:00.000Z', 9);
    await t.db.db.update(schema.bots).set({ archivedAt: new Date() }).where(eq(schema.bots.id, b.id));

    const r = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(r.timezone).toBe('Europe/Istanbul');
    expect(r.total).toEqual({ costUsd: 1.75, turns: 4, unpriced: 1 });
    expect(r.bots.map((x) => [x.name, x.costUsd, x.turns, x.unpriced, x.archived])).toEqual([
      ['Gezgin', 1, 1, 0, true],
      ['Katip', 0.75, 3, 1, false],
    ]);
    expect(r.daily).toHaveLength(7);
    expect(r.daily.at(-1)).toEqual({ date: '2026-11-16', costUsd: 0.5, turns: 1 });
    expect(r.daily.at(-2)).toEqual({ date: '2026-11-15', costUsd: 1, turns: 1 });
    expect(r.daily.at(-3)).toEqual({ date: '2026-11-14', costUsd: 0.25, turns: 2 });
    expect(r.daily[0]).toEqual({ date: '2026-11-10', costUsd: 0, turns: 0 });

    expect((await t.api<UsageReport>('GET', '/api/usage?days=30')).body.total.costUsd).toBe(10.75);
    expect((await t.api('GET', '/api/usage?days=12')).status).toBe(400);
  });

  it('modellere göre döker ve tek bir botun raporunu verir', async () => {
    const a = await t.bot({ name: 'Katip' });
    const b = await t.bot({ name: 'Gezgin' });
    const sonnet = { engine: 'claude', model: 'sonnet' } as const;
    await turn(a.id, '2026-11-15T09:00:00.000Z', 0.5, sonnet);
    await turn(a.id, '2026-11-15T10:00:00.000Z', 0.1, { engine: 'pi', model: 'openai/gpt-5' });
    await turn(b.id, '2026-11-15T11:00:00.000Z', 1, sonnet);
    await turn(b.id, '2026-11-15T12:00:00.000Z', 0.2);

    const all = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(all.models.map((m) => [m.engine, m.model, m.costUsd, m.turns])).toEqual([
      ['claude', 'sonnet', 1.5, 2],
      [null, null, 0.2, 1],
      ['pi', 'openai/gpt-5', 0.1, 1],
    ]);

    const one = (await t.api<UsageReport>('GET', `/api/usage?days=7&bot=${a.id}`)).body;
    expect(one.total).toEqual({ costUsd: 0.6, turns: 2, unpriced: 0 });
    expect(one.bots.map((x) => x.name)).toEqual(['Katip']);
    expect(one.models.map((m) => m.model)).toEqual(['sonnet', 'openai/gpt-5']);
  });

  it('bu ayın harcamasını sınırla birlikte verir; sınıra ulaşınca yeni tur başlamaz', async () => {
    const a = await t.bot({ name: 'Katip' });
    // Istanbul's November starts at 2026-10-31T21:00Z; the turn before it is October's.
    await turn(a.id, '2026-10-31T20:00:00.000Z', 5);
    await turn(a.id, '2026-11-01T09:00:00.000Z', 1.5);
    let report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(report.month).toEqual({ costUsd: 1.5, limitUsd: 0 });
    await t.api('PATCH', '/api/settings', { monthlyLimitUsd: 1 });
    report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(report.month).toEqual({ costUsd: 1.5, limitUsd: 1 });
    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    const last = (await t.messages(thread.id)).at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('$1.50');
    await t.api('PATCH', '/api/settings', { monthlyLimitUsd: 0 });
    await t.send(thread.id, 'tekrar');
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.role).toBe('assistant');
  });

  it('günlük sınır yalnız bugünün harcamasını sayar; dolunca yeni tur yarını bekler', async () => {
    const a = await t.bot({ name: 'Katip' });
    // Istanbul's 16 November starts at 2026-11-15T21:00Z; the turn before it is yesterday's.
    await turn(a.id, '2026-11-15T20:00:00.000Z', 5);
    await turn(a.id, '2026-11-16T04:00:00.000Z', 0.75);
    await t.api('PATCH', '/api/settings', { dailyLimitUsd: 0.5 });
    const report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(report.day).toEqual({ costUsd: 0.75, limitUsd: 0.5 });
    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    const last = (await t.messages(thread.id)).at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('Bugünün harcama sınırına');
    expect(last.text).toContain('$0.75');
  });

  it('botun kendi sınırı yalnız onun harcamasını sayar; öbür botlar çalışmayı sürdürür', async () => {
    const a = await t.bot({ name: 'Katip' });
    const b = await t.bot({ name: 'Yazman' });
    await turn(a.id, '2026-11-02T09:00:00.000Z', 2);
    await turn(b.id, '2026-11-16T04:00:00.000Z', 3);
    const patched = await t.api<{ monthlyLimitUsd: number }>('PATCH', `/api/bots/${a.id}`, {
      monthlyLimitUsd: 2,
    });
    expect(patched.body.monthlyLimitUsd).toBe(2);
    expect((await t.api('GET', `/api/bots/${a.id}/spend`)).body).toEqual({ dayUsd: 0, monthUsd: 2 });

    const ta = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(ta.id, 'merhaba');
    await t.services.turns.idle();
    const last = (await t.messages(ta.id)).at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('Katip bu ay kendi harcama sınırına');

    const tb = (await t.api<Thread>('GET', `/api/bots/${b.id}/main-thread`)).body;
    await t.send(tb.id, 'merhaba');
    await t.services.turns.idle();
    expect((await t.messages(tb.id)).at(-1)!.role).toBe('assistant');

    // A bot's daily limit counts only today.
    await t.api('PATCH', `/api/bots/${a.id}`, { monthlyLimitUsd: 0, dailyLimitUsd: 1 });
    await t.send(ta.id, 'tekrar');
    await t.services.turns.idle();
    expect((await t.messages(ta.id)).at(-1)!.role).toBe('assistant');
  });

  it('arka planda botun hesabından yapılan çağrılar da toplama ve sınırlara sayılır; sınır dolunca onlar da durur', async () => {
    const a = await t.bot({ name: 'Katip' });
    const b = await t.bot({ name: 'Yazman' });
    const at = new Date('2026-11-10T09:00:00.000Z');
    const row = (botId: string, costUsd: number) => ({
      id: `c-${Math.random()}`,
      botId,
      costUsd,
      createdAt: at,
    });
    await t.db.db.insert(schema.memoryTidyChecks).values({ ...row(a.id, 0.4), kind: 'set', changed: 2 });
    await t.db.db.insert(schema.skillSuggestionChecks).values(row(a.id, 0.3));
    await t.db.db.insert(schema.promiseChecks).values(row(a.id, 0.2));
    await t.db.db.insert(schema.routineSuggestionChecks).values(row(b.id, 0.1));
    await t.db.db.insert(schema.workOfferChecks).values(row(b.id, 0.05));
    // Last month's call counts for none of this month's limits.
    await t.db.db
      .insert(schema.memoryTidyChecks)
      .values({ ...row(a.id, 9), kind: 'source', createdAt: new Date('2026-10-20T09:00:00.000Z') });
    await turn(b.id, '2026-11-12T09:00:00.000Z', 1);

    const report = (await t.api<UsageReport>('GET', '/api/usage?days=30')).body;
    expect(report.month!.costUsd).toBeCloseTo(2.05, 6);
    // The turns' own totals stay the turns'.
    expect(report.total.costUsd).toBe(1);
    const spend = (await t.api<{ dayUsd: number; monthUsd: number }>('GET', `/api/bots/${a.id}/spend`)).body;
    expect(spend.monthUsd).toBeCloseTo(0.9, 6);

    // The bot's limit is spent by its background calls alone: its turns wait.
    await t.api('PATCH', `/api/bots/${a.id}`, { monthlyLimitUsd: 0.8 });
    const ta = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(ta.id, 'merhaba');
    await t.services.turns.idle();
    expect((await t.messages(ta.id)).at(-1)!.role).toBe('error');

    // And so do its background calls: its notes are not tidied while the limit is spent.
    for (let i = 1; i <= 5; i++)
      await t.services.memory.create({
        scope: 'bot',
        botId: a.id,
        content: `Not ${i}`,
        source: `bot:${a.id}`,
      });
    const before = t.engine.completions.length;
    await t.api('POST', '/api/memory-tidy');
    await t.services.memoryTidy.idle();
    expect(t.engine.completions).toHaveLength(before);
    await t.api('PATCH', `/api/bots/${a.id}`, { monthlyLimitUsd: 0 });
    await t.api('POST', '/api/memory-tidy');
    await t.services.memoryTidy.idle();
    expect(t.engine.completions).toHaveLength(before + 1);
  });

  it('başarısız biten turun harcaması da aylık toplama ve sınıra sayılır', async () => {
    const a = await t.bot({ name: 'Katip' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(thread.id, '[maliyet:0.25] [hata]');
    await t.services.turns.idle();
    const [row] = await t.db.db.select().from(schema.turns).where(eq(schema.turns.threadId, thread.id));
    expect(row).toMatchObject({ status: 'error', costUsd: 0.25 });
    const report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(report.month?.costUsd).toBe(0.25);
  });

  const costs = async (threadId: string) =>
    (
      await t.db.db
        .select({ botId: schema.turns.botId, costUsd: schema.turns.costUsd })
        .from(schema.turns)
        .where(eq(schema.turns.threadId, threadId))
        .orderBy(asc(schema.turns.finishedAt), asc(schema.turns.createdAt))
    ).map((r) => r.costUsd);

  it('sürdürülen oturumda turun maliyeti, oturumun toplamına eklediğidir', async () => {
    const a = await t.bot({ name: 'Katip' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(thread.id, '[maliyet:0.25]');
    await t.services.turns.idle();
    await t.send(thread.id, '[maliyet:0.5]');
    await t.services.turns.idle();
    // The engine reported 0.75, the session's total; the turn spent 0.5 of it.
    expect(t.engine.requests.at(-1)).toMatchObject({ sessionId: `fake-${thread.id}`, sessionCostUsd: 0.25 });
    await t.send(thread.id, '[maliyet:0.125] [hata]');
    await t.services.turns.idle();
    expect(await costs(thread.id)).toEqual([0.25, 0.5, 0.125]);
    // A lost session hands over to a new one, whose count starts again.
    t.engine.forget(`fake-${thread.id}`);
    await t.send(thread.id, '[maliyet:0.25]');
    await t.services.turns.idle();
    expect(await costs(thread.id)).toEqual([0.25, 0.5, 0.125, 0.25]);
    // The turns and runs above were stamped by the real clock, so the report must count from it too.
    t.now.value = new Date();
    const report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(report.total.costUsd).toBe(1.125);
    expect(report.month?.costUsd).toBe(1.125);
  });

  it('harcamasız biten sürdürülmüş tur, saklanan toplam yuvarlanmış olsa da sıfıra mal olur', async () => {
    const a = await t.bot({ name: 'Katip' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(thread.id, '[maliyet:0.1]');
    await t.services.turns.idle();
    await t.send(thread.id, '[hata]');
    await t.services.turns.idle();
    expect(await costs(thread.id)).toEqual([expect.closeTo(0.1, 6), 0]);
  });

  it('bağlamı dolan oturumun yerine geçen yeni oturumda tur yalnız harcadığına mal olur', async () => {
    const a = await t.bot({ name: 'Katip' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(thread.id, '[maliyet:0.25]');
    await t.services.turns.idle();
    // The resumed run fails at no cost. The new session's prompt carries the earlier exchange, whose
    // 0.25 directive the fake spends; counted from the old session's total, it would be 0.5.
    await t.send(thread.id, '[bağlam-dolu]');
    await t.services.turns.idle();
    expect(await costs(thread.id)).toEqual([0.25, 0.25]);
  });

  it('odada her üyenin turu kendi oturumunun toplamına eklediğidir', async () => {
    const a = await t.bot({ name: 'Ada' });
    const b = await t.bot({ name: 'Bora' });
    const room = (await t.api<Room>('POST', '/api/rooms', { title: 'Plan', botIds: [a.id, b.id] })).body;
    for (const text of ['[maliyet:0.25]', '[maliyet:0.5]']) {
      const r = await t.api<Message>('POST', `/api/rooms/${room.id}/messages`, { clientId: text, text });
      expect(r.status).toBe(201);
      await t.services.turns.idle();
    }
    // Each member resumes its own session, from what that session had cost.
    const [ada, bora] = t.engine.requests.slice(-2);
    expect(ada!.sessionId).not.toBe(bora!.sessionId);
    expect([ada!.sessionCostUsd, bora!.sessionCostUsd]).toEqual([0.25, 0.25]);
    // Ada's second prompt opens with Bora's earlier line, so the fake spends 0.25 again there.
    expect(await costs(room.id)).toEqual([0.25, 0.25, 0.25, 0.5]);
  });

  it('runCost: toplam geriye düştüyse sayım yeniden başlamıştır', () => {
    expect(runCost(0.75, 0.25)).toBe(0.5);
    expect(runCost(0.5, null)).toBe(0.5);
    expect(runCost(0.1, 0.75)).toBe(0.1);
    // A stored copy of the total may read back a hair above it.
    expect(runCost(0.1, Math.fround(0.1))).toBe(0);
    expect(runCost(null, 0.75)).toBeNull();
  });

  it('migrasyon, oturum toplamı olarak saklanmış eski maliyetleri tur başına çevirir', async () => {
    const a = await t.bot({ name: 'Katip' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.db.db
      .update(schema.threads)
      .set({ engineSessionId: 's1' })
      .where(eq(schema.threads.id, thread.id));
    const old = async (at: string, costUsd: number | null, engine: 'claude' | 'pi' = 'claude') =>
      t.db.db.insert(schema.turns).values({
        id: `tur-${at}`,
        threadId: thread.id,
        botId: a.id,
        source: 'user',
        status: 'done',
        prompt: 'x',
        costUsd,
        engine,
        finishedAt: new Date(at),
      });
    await old('2026-11-15T09:00:00.000Z', 0.25);
    await old('2026-11-15T10:00:00.000Z', 0.75);
    await old('2026-11-15T10:30:00.000Z', null);
    await old('2026-11-15T10:45:00.000Z', 0.5, 'pi');
    await old('2026-11-15T11:00:00.000Z', 1);
    // A new session: its total starts below the one before.
    await old('2026-11-15T12:00:00.000Z', 0.125);
    await old('2026-11-15T13:00:00.000Z', 0.375);
    const statements = readFileSync(new URL('../drizzle/0034_session_cost.sql', import.meta.url), 'utf8')
      .split('--> statement-breakpoint')
      .filter((q) => !/ALTER TABLE/.test(q));
    for (const q of statements) await t.db.db.execute(sql.raw(q));
    expect(await costs(thread.id)).toEqual([0.25, 0.5, null, 0.5, 0.25, 0.125, 0.25]);
    const [row] = await t.db.db.select().from(schema.threads).where(eq(schema.threads.id, thread.id));
    expect(row!.engineSessionCostUsd).toBe(0.375);
  });

  it('rutinlere göre döker', async () => {
    const a = await t.bot({ name: 'Katip' });
    const r = (
      await t.api<{ id: string }>('POST', '/api/routines', {
        botId: a.id,
        name: 'Sabah özeti',
        prompt: 'özetle',
        schedule: { type: 'daily', time: '09:00' },
      })
    ).body;
    const run = await t.services.routines.runNow(r.id);
    await t.services.turns.idle();
    await t.db.db.update(schema.turns).set({ costUsd: 0.4 }).where(eq(schema.turns.routineRunId, run!.id));
    await turn(a.id, '2026-11-16T04:00:00.000Z', 1);
    // The turns and runs above were stamped by the real clock, so the report must count from it too.
    t.now.value = new Date();
    const report = (await t.api<UsageReport>('GET', '/api/usage?days=7')).body;
    expect(report.routines).toEqual([
      { routineId: r.id, name: 'Sabah özeti', botId: a.id, costUsd: 0.4, turns: 1, unpriced: 0 },
    ]);
  });

  it('bugünü özetler: botların turları, hatalar ve rutin çalışmaları', async () => {
    const a = await t.bot({ name: 'Katip' });
    // 08:00 in Istanbul; Istanbul's day began at 2026-11-15T21:00Z.
    await turn(a.id, '2026-11-15T20:00:00.000Z', 3);
    await turn(a.id, '2026-11-16T04:00:00.000Z', 1);
    await turn(a.id, '2026-11-16T04:30:00.000Z', null);
    const today = (await t.api<TodayReport>('GET', '/api/today')).body;
    expect(today.date).toBe('2026-11-16');
    expect(today.costUsd).toBe(1);
    expect(today.bots).toEqual([{ botId: a.id, name: 'Katip', turns: 2, failed: 1, costUsd: 1 }]);
    expect(today.runs).toEqual([]);
  });

  it('turları CSV olarak verir; formül gibi başlayan hücreyi zararsızlaştırır', async () => {
    const a = await t.bot({ name: '=HYPERLINK("x")' });
    await turn(a.id, '2026-11-15T09:00:00.000Z', 0.25, { engine: 'claude', model: 'opus' });
    const res = await t.app.inject({ method: 'GET', url: '/api/usage/turns.csv?days=7', headers: AUTH });
    expect(res.headers['content-type']).toContain('text/csv');
    const [head, row] = res.body.trim().split('\n');
    expect(head).toBe('finished_at,bot,source,status,engine,model,cost_usd');
    expect(row).toBe('2026-11-15T09:00:00.000Z,"\'=HYPERLINK(""x"")",user,done,claude,opus,0.25');
  });

  it('yaz saati geçişinde gün atlamaz', () => {
    const days = lastDays(new Date('2026-04-01T12:00:00.000Z'), 5, 'Europe/Berlin');
    expect(days).toEqual(['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01']);
  });
});
