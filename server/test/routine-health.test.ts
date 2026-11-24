import type { Routine, RoutineHealth } from '@leafbot/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, type TestServer } from './helpers';

describe('rutin sağlığı', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, prompt: string) =>
    (
      await t.api<Routine>('POST', '/api/routines', {
        botId,
        name: 'Kontrol',
        prompt,
        schedule: { type: 'interval', minutes: 30 },
        inMain: false,
      })
    ).body;
  const runTimes = async (id: string, times: number) => {
    for (let i = 0; i < times; i++) {
      t.now.value = new Date(t.now.value.getTime() + 1000);
      await t.api('POST', `/api/routines/${id}/run`);
      await t.services.turns.idle();
    }
  };
  const outcomes = async (routineId: string) =>
    (
      await t.services.ctx.db
        .select({ outcome: schema.routineRuns.outcome })
        .from(schema.routineRuns)
        .where(eq(schema.routineRuns.routineId, routineId))
    ).map((r) => r.outcome);
  const health = async (routineId: string) =>
    (await t.api<RoutineHealth[]>('GET', '/api/routines/health')).body.find((h) => h.routineId === routineId);

  it('her çalışmanın nasıl bittiğini kaydeder; kullanım sınırı bilinmeyen kalır', async () => {
    const bot = await t.bot();
    const ok = await make(bot.id, 'tamam');
    const quiet = await make(bot.id, '[sessiz]');
    const failed = await make(bot.id, '[hata]');
    const limit = await make(bot.id, '[sınır]');
    for (const r of [ok, quiet, failed, limit]) await runTimes(r.id, 1);
    expect(await outcomes(ok.id)).toEqual(['ok']);
    expect(await outcomes(quiet.id)).toEqual(['quiet']);
    expect(await outcomes(failed.id)).toEqual(['failed']);
    expect(await outcomes(limit.id)).toEqual([null]);
  });

  it('çoğu sessiz biten rutini ne tuttuğuyla gösterir; gizlenince bir dahaki ölçüme kadar saklar', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, '[sessiz]');
    await runTimes(r.id, 10);
    // The fake engine's silent reply costs nothing; each run's turn is priced here instead.
    const runIds = (
      await t.services.ctx.db
        .select({ id: schema.routineRuns.id })
        .from(schema.routineRuns)
        .where(eq(schema.routineRuns.routineId, r.id))
    ).map((x) => x.id);
    await t.services.ctx.db
      .update(schema.turns)
      .set({ costUsd: 0.01 })
      .where(inArray(schema.turns.routineRunId, runIds));
    const h = (await health(r.id))!;
    expect(h).toMatchObject({
      status: 'improvable',
      runs: { total: 10, quiet: 10, ok: 0, failed: 0 },
      hidden: 0,
    });
    expect(h.since).not.toBeNull();
    const finding = h.findings.find((f) => f.id === 'mostlyQuiet')!;
    expect(finding).toMatchObject({ count: 10, of: 10 });
    expect(finding.costUsd).toBeCloseTo(0.1);
    expect(h.costUsd).toBeCloseTo(0.1);

    const dismissed = await t.api<RoutineHealth>('POST', `/api/routines/${r.id}/health/dismiss`, {
      finding: 'mostlyQuiet',
    });
    expect(dismissed.status).toBe(200);
    expect(dismissed.body).toMatchObject({ findings: [], hidden: 1, status: 'good' });
    // Ten more quiet runs after it was set aside meet it again.
    await runTimes(r.id, 10);
    expect((await health(r.id))!.findings.map((f) => f.id)).toEqual(['mostlyQuiet']);
  });

  it('art arda başarısızlığı sorun sayar', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, '[hata]');
    await runTimes(r.id, 3);
    const h = (await health(r.id))!;
    expect(h.status).toBe('problem');
    expect(h.findings).toContainEqual({ id: 'failing', count: 3 });
  });

  it('yalnız botu değiştirebilen kişi görür; gizleme de öyle', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'tamam');
    const ayse = await t.person('ayse');
    const seen = await ayse.api<RoutineHealth[]>('GET', '/api/routines/health');
    expect(seen.status).toBe(200);
    expect(seen.body.find((h) => h.routineId === r.id)).toBeUndefined();
    const dismiss = await ayse.api('POST', `/api/routines/${r.id}/health/dismiss`, { finding: 'idle' });
    expect([403, 404]).toContain(dismiss.status);
  });

  it('bilinmeyen bulguyu reddeder', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'tamam');
    const res = await t.api('POST', `/api/routines/${r.id}/health/dismiss`, { finding: 'nope' });
    expect(res.status).toBe(400);
  });
});
