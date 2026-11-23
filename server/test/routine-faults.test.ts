import type { Routine, RoutineRun } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db';
import { MAX_ROUTINES_PER_BOT } from '../src/services/routines';
import { OWNER_ID } from '../src/users';
import { newId } from '../src/util';
import { testServer, type TestServer } from './helpers';

describe('rutin aksaklıkları', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, name: string, extra: Record<string, unknown> = {}) =>
    (
      await t.api<Routine>('POST', '/api/routines', {
        botId,
        name,
        prompt: `${name} işini yap`,
        schedule: { type: 'interval', minutes: 30 },
        // These runs work in the routine's own conversation, as one that is not in the main one does.
        inMain: false,
        ...extra,
      })
    ).body;
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const routine = async (id: string) =>
    (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.id === id)!;

  it('başlatılamayan rutin hatalı çalıştırma olarak yazılır, sırası ilerler; öbür rutinler yine çalışır', async () => {
    const bot = await t.bot();
    const broken = await make(bot.id, 'Bozuk');
    const fine = await make(bot.id, 'Sağlam');
    const threads = t.services.threads;
    const real = threads.routineThread.bind(threads);
    vi.spyOn(threads, 'routineThread').mockImplementation(async (botId, name, ...rest) => {
      if (name === 'Bozuk') throw new Error('disk dolu');
      return real(botId, name, ...rest);
    });
    t.now.value = new Date(t.now.value.getTime() + 31 * 60_000);
    await t.services.routines.tick();
    await t.services.turns.idle();
    const [failed] = await runs(broken.id);
    expect(failed!.status).toBe('error');
    expect(failed!.reason).toContain('disk dolu');
    expect((await runs(fine.id)).map((r) => r.status)).toEqual(['done']);
    // Its slot passed: it is not tried again on every pass until the fault goes away.
    expect(Date.parse((await routine(broken.id)).nextRunAt!)).toBeGreaterThan(t.now.value.getTime());
  });

  it('turu kuyruğa giremeyen çalıştırma hemen hatayla kapanır, sonrakini engellemez', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'Rapor');
    vi.spyOn(t.services.turns, 'enqueue').mockRejectedValueOnce(new Error('kuyruk kapalı'));
    const started = await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`);
    expect(started.body.status).toBe('error');
    const [first] = await runs(r.id);
    expect(first!.status).toBe('error');
    expect(first!.reason).toContain('kuyruk kapalı');
    t.now.value = new Date(t.now.value.getTime() + 1000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['done', 'error']);
  });

  it('süren çalıştırmanın arkasında atlanan çalıştırmalar tek satırda sayılır', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'Uzun', { prompt: '[bekle:3000]' });
    await t.api('POST', `/api/routines/${r.id}/run`);
    for (let i = 1; i <= 3; i++) {
      t.now.value = new Date(t.now.value.getTime() + 1000);
      await t.api('POST', `/api/routines/${r.id}/run`);
    }
    const list = await runs(r.id);
    expect(list.map((x) => x.status)).toEqual(['skipped', 'running']);
    expect(list[0]!.reason).toContain('3');
    await t.api('POST', `/api/threads/${list[1]!.threadId}/stop`);
    await t.services.turns.idle();
    // A run started after the stuck one ended starts a new line when it is held up in turn.
    t.now.value = new Date(t.now.value.getTime() + 1000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    t.now.value = new Date(t.now.value.getTime() + 1000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    const after = await runs(r.id);
    expect(after.filter((x) => x.status === 'skipped')).toHaveLength(2);
    await t.api('POST', `/api/threads/${after.find((x) => x.status === 'running')!.threadId}/stop`);
    await t.services.turns.idle();
  });

  it('dakikada bir çalışacak cron ifadesi reddedilir, beş dakikalık kabul edilir', async () => {
    const bot = await t.bot();
    const often = await t.api<{ error: string }>('POST', '/api/routines', {
      botId: bot.id,
      name: 'Sık',
      prompt: 'x',
      schedule: { type: 'cron', expr: '* * * * *' },
    });
    expect(often.status).toBe(400);
    expect(often.body.error).toContain('5 dakika');
    const ok = await make(bot.id, 'Seyrek', { schedule: { type: 'cron', expr: '*/5 * * * *' } });
    expect(ok.id).toBeTruthy();
    const patched = await t.api('PATCH', `/api/routines/${ok.id}`, {
      schedule: { type: 'cron', expr: '*/2 9 * * *' },
    });
    expect(patched.status).toBe(400);
    // One that came in another way, paused, is not turned on with it.
    await t.db.db.insert(schema.routines).values({
      id: 'eski',
      botId: bot.id,
      name: 'Eski',
      prompt: 'x',
      schedule: { type: 'cron', expr: '* * * * *' },
      timezone: 'UTC',
      enabled: false,
    });
    expect((await t.api('PATCH', '/api/routines/eski', { enabled: true })).status).toBe(400);
  });

  it('bir botun rutin sayısı sınırlıdır', async () => {
    const bot = await t.bot();
    await t.db.db.insert(schema.routines).values(
      Array.from({ length: MAX_ROUTINES_PER_BOT }, (_, i) => ({
        id: newId(),
        botId: bot.id,
        name: `Rutin ${i}`,
        prompt: 'x',
        schedule: { type: 'interval', minutes: 30 },
        timezone: 'UTC',
      })),
    );
    const over = await t.api<{ error: string }>('POST', '/api/routines', {
      botId: bot.id,
      name: 'Fazla',
      prompt: 'x',
      schedule: { type: 'interval', minutes: 30 },
    });
    expect(over.status).toBe(400);
    expect(over.body.error).toContain(String(MAX_ROUTINES_PER_BOT));
    const other = await t.bot({ name: 'Ayşe' });
    expect((await make(other.id, 'Başka')).id).toBeTruthy();
  });

  it('geçici hatadan sonraki yeniden deneme aralıklı rutinin ritmini kaydırmaz', async () => {
    const bot = await t.bot();
    // The clock stands at 05:00 UTC: the first slot is 06:00, then every hour on the hour.
    const r = await make(bot.id, 'Saatlik', {
      prompt: '[meşgul]',
      schedule: { type: 'interval', minutes: 60 },
    });
    expect(r.nextRunAt).toBe('2026-11-16T06:00:00.000Z');
    t.now.value = new Date('2026-11-16T06:00:30.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    // It failed for a passing reason: tried again five minutes later.
    expect((await routine(r.id)).nextRunAt).toBe('2026-11-16T06:05:30.000Z');
    t.now.value = new Date('2026-11-16T06:06:00.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['error', 'error']);
    // After the retry it goes on from its own slot, not an hour after the retry.
    expect((await routine(r.id)).nextRunAt).toBe('2026-11-16T07:00:00.000Z');
  });
  it('geçici hatayla biten tek seferlik rutin bir kez daha denenir, sonra kapanır', async () => {
    const bot = await t.bot();
    // 09:00 in Istanbul is 06:00 UTC; the clock stands at 05:00 UTC.
    const r = await make(bot.id, 'Bir kez', {
      prompt: '[meşgul]',
      schedule: { type: 'once', date: '2026-11-16', time: '09:00' },
    });
    t.now.value = new Date('2026-11-16T06:00:30.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    // Put aside when it fired, then taken up again for the retry.
    expect(await routine(r.id)).toMatchObject({ enabled: true, nextRunAt: '2026-11-16T06:05:30.000Z' });
    t.now.value = new Date('2026-11-16T06:06:00.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['error', 'error']);
    // The retry failed too: it is not tried a third time.
    expect(await routine(r.id)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('elle başlatılan tek seferlik rutin geçici hatadan sonra yeniden açılmaz', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'Elle', {
      prompt: '[meşgul]',
      schedule: { type: 'once', date: '2026-11-16', time: '09:00' },
    });
    t.now.value = new Date('2026-11-16T06:00:30.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    t.now.value = new Date('2026-11-16T06:06:00.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    expect(await routine(r.id)).toMatchObject({ enabled: false, nextRunAt: null });
    // Long after: the run by hand fails for a passing reason, yet the one-time routine stays put aside.
    t.now.value = new Date('2026-11-16T08:00:00.000Z');
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect(await routine(r.id)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  /** A scheduled run whose turn was running when the server stopped, with or without a step it let through. */
  const cutRun = async (
    r: Routine,
    botId: string,
    acted: boolean,
    occurrence = '2026-11-16T06:00:00.000Z',
  ) => {
    const thread = await t.services.threads.routineThread(botId, r.name, null, OWNER_ID);
    const runId = newId();
    const turnId = newId();
    await t.db.db.insert(schema.routineRuns).values({
      id: runId,
      routineId: r.id,
      occurrence,
      status: 'running',
      scheduled: true,
      threadId: thread.id,
      promptSnapshot: r.prompt,
    });
    await t.db.db.insert(schema.turns).values({
      id: turnId,
      threadId: thread.id,
      botId,
      source: 'routine',
      status: 'running',
      prompt: r.prompt,
      routineRunId: runId,
      changed: acted,
    });
    return runId;
  };

  it('sunucu durunca yarıda kalan tek seferlik rutin bir şey değiştirmediyse yeniden denenir', async () => {
    const bot = await t.bot();
    const once = { type: 'once', date: '2026-11-16', time: '09:00' };
    const clean = await make(bot.id, 'Temiz', { schedule: once });
    const acted = await make(bot.id, 'Yaptı', { schedule: once });
    const handed = await make(bot.id, 'Devretti', { schedule: once });
    t.now.value = new Date('2026-11-16T06:00:30.000Z');
    // As if each had fired and been put aside before the server stopped.
    for (const r of [clean, acted, handed]) {
      await t.db.db
        .update(schema.routines)
        .set({ enabled: false, nextRunAt: null })
        .where(eq(schema.routines.id, r.id));
      const runId = await cutRun(r, bot.id, r === acted);
      if (r === handed) {
        const [cut] = await t.db.db.select().from(schema.turns).where(eq(schema.turns.routineRunId, runId));
        await t.db.db.insert(schema.turns).values({
          id: newId(),
          threadId: cut!.threadId,
          botId: bot.id,
          source: 'routine',
          status: 'done',
          prompt: r.prompt,
          routineRunId: runId,
        });
      }
    }
    await t.services.turns.recover();
    await t.services.routines.recover();
    expect((await runs(clean.id))[0]).toMatchObject({ status: 'error', reason: 'Sunucu yeniden başladı' });
    expect(await routine(clean.id)).toMatchObject({ enabled: true, nextRunAt: '2026-11-16T06:05:30.000Z' });
    // A run that already changed something is not run again from the start.
    expect(await routine(acted.id)).toMatchObject({ enabled: false, nextRunAt: null });
    // Nor is one whose earlier turn handed work to other bots: only its last turn was cut short.
    expect(await routine(handed.id)).toMatchObject({ enabled: false, nextRunAt: null });
    t.now.value = new Date('2026-11-16T06:06:00.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    expect((await runs(clean.id)).map((x) => x.status)).toEqual(['done', 'error']);
  });

  it('çalışırken takılı bulunup kapatılan tur yeniden başlatma sayılmaz, rutin yeniden denenmez', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'Takılı', { schedule: { type: 'once', date: '2026-11-16', time: '09:00' } });
    t.now.value = new Date('2026-11-16T06:00:30.000Z');
    await t.db.db
      .update(schema.routines)
      .set({ enabled: false, nextRunAt: null })
      .where(eq(schema.routines.id, r.id));
    const runId = await cutRun(r, bot.id, false);
    const [turn] = await t.db.db.select().from(schema.turns).where(eq(schema.turns.routineRunId, runId));
    expect(await t.services.turns.endStuck([turn!.id])).toBe(1);
    expect(await routine(r.id)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  /** Ends the routine's run as if its turn finished before `tick` moved the routine past its slot. */
  const endsEarly = async (r: Routine, botId: string) => {
    const runId = await cutRun(r, botId, false, r.nextRunAt!);
    const [turn] = await t.db.db
      .update(schema.turns)
      .set({ status: 'error' })
      .where(eq(schema.turns.routineRunId, runId))
      .returning();
    await t.services.routines.onTurnFinished(turn!, {
      ok: false,
      kind: 'engine',
      message: 'overloaded_error',
      text: '',
      sessionId: null,
      transient: true,
    });
    // What `tick` then does with the row it read before firing.
    const [row] = await t.db.db.select().from(schema.routines).where(eq(schema.routines.id, r.id));
    const advance = (t.services.routines as unknown as { advance(x: unknown): Promise<void> }).advance;
    await advance.call(t.services.routines, { ...row, nextRunAt: new Date(r.nextRunAt!), resumeAt: null });
  };

  it('tur, rutin kendi zamanından ilerlemeden biterse de yeniden deneme kaybolmaz', async () => {
    const bot = await t.bot();
    const once = await make(bot.id, 'Bir kez erken', {
      schedule: { type: 'once', date: '2026-11-16', time: '09:00' },
    });
    const hourly = await make(bot.id, 'Saatlik erken', { schedule: { type: 'interval', minutes: 60 } });
    expect([once.nextRunAt, hourly.nextRunAt]).toEqual([
      '2026-11-16T06:00:00.000Z',
      '2026-11-16T06:00:00.000Z',
    ]);
    t.now.value = new Date('2026-11-16T06:00:30.000Z');
    await endsEarly(once, bot.id);
    await endsEarly(hourly, bot.id);
    expect(await routine(once.id)).toMatchObject({ enabled: true, nextRunAt: '2026-11-16T06:05:30.000Z' });
    expect(await routine(hourly.id)).toMatchObject({ enabled: true, nextRunAt: '2026-11-16T06:05:30.000Z' });
    // After the retry the hourly one goes on from its own next slot.
    t.now.value = new Date('2026-11-16T06:06:00.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    expect((await routine(hourly.id)).nextRunAt).toBe('2026-11-16T07:00:00.000Z');
    expect(await routine(once.id)).toMatchObject({ enabled: false, nextRunAt: null });
  });

  it('botun kendi aracını kullanan tur değiştiren tur sayılır; yalnız okuyan sayılmaz', async () => {
    const bot = await t.bot();
    const thread = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, '[araç:memory_write {"content":"Pazartesi toplantı var","scope":"user"}]');
    await t.services.turns.idle();
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    const turns = await t.db.db
      .select({ prompt: schema.turns.prompt, changed: schema.turns.changed })
      .from(schema.turns)
      .where(eq(schema.turns.threadId, thread.id));
    expect(turns.find((x) => x.prompt.includes('memory_write'))!.changed).toBe(true);
    expect(turns.find((x) => x.prompt.includes('merhaba'))!.changed).toBe(false);
  });
});
