import type { Routine, RoutineRevision, RoutineVersionReport } from '@leafbot/shared';
import { isNotNull } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, type TestServer } from './helpers';

describe('rutin talimat geçmişi', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async () => {
    const bot = await t.bot();
    return (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Rapor',
        prompt: 'Haftalık raporu yaz',
        schedule: { type: 'interval', minutes: 60 },
      })
    ).body;
  };
  const history = async (id: string) =>
    (await t.api<RoutineRevision[]>('GET', `/api/routines/${id}/revisions`)).body.map((r) => r.prompt);
  const later = () => {
    t.now.value = new Date(t.now.value.getTime() + 60_000);
  };

  it('her talimat değişikliği yeni sürüm olur, en yenisi başta', async () => {
    const r = await make();
    expect(await history(r.id)).toEqual(['Haftalık raporu yaz']);
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: 'Günlük raporu yaz' });
    // Talimat dışı bir değişiklik geçmişe yazılmaz.
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { name: 'Günlük rapor' });
    expect(await history(r.id)).toEqual(['Günlük raporu yaz', 'Haftalık raporu yaz']);
  });

  it('eski sürüme dönmek onu yeniden en yeni yapar; geçmiş silinmez', async () => {
    const r = await make();
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: 'Günlük raporu yaz' });
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: 'Haftalık raporu yaz' });
    expect(await history(r.id)).toEqual(['Haftalık raporu yaz', 'Günlük raporu yaz', 'Haftalık raporu yaz']);
  });

  it('geçmiş tutulmadan önce yapılmış rutinin ilk değişikliği de geri alınabilir', async () => {
    const r = await make();
    await t.db.db.delete(schema.routineRevisions);
    expect(await history(r.id)).toEqual(['Haftalık raporu yaz']);
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: 'Günlük raporu yaz' });
    expect(await history(r.id)).toEqual(['Günlük raporu yaz', 'Haftalık raporu yaz']);
  });

  it('aynı haliyle kaydetmek ya da yalnız kapatmak sürüm yazmaz; adım, model ya da koşul değişikliği yazar', async () => {
    const r = await make();
    later();
    // The form sends every field on save, also those it did not change.
    await t.api('PATCH', `/api/routines/${r.id}`, {
      prompt: r.prompt,
      steps: [],
      model: '',
      condition: null,
      schedule: r.schedule,
    });
    await t.api('PATCH', `/api/routines/${r.id}`, { enabled: false });
    expect(await history(r.id)).toHaveLength(1);
    later();
    const step = { id: 'a', kind: 'approval', question: 'Gönderilsin mi?', timeoutDays: 7 };
    await t.api('PATCH', `/api/routines/${r.id}`, { steps: [step] });
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { model: 'claude-haiku-5-5' });
    const list = (await t.api<RoutineRevision[]>('GET', `/api/routines/${r.id}/revisions`)).body;
    expect(list).toHaveLength(3);
    expect(list[0]).toMatchObject({ full: true, model: 'claude-haiku-5-5', steps: [step] });
    expect(list[1]).toMatchObject({ full: true, model: '', steps: [step] });
    expect(list[2]).toMatchObject({ full: true, steps: [], condition: null });
  });

  it('botun yazdığı adımı formdaki boş alanlarıyla aynen kaydetmek sürüm yazmaz', async () => {
    const r = await make();
    later();
    const bare = { id: 'a', kind: 'agent', prompt: 'Özetle', model: '' };
    const saved = (await t.api<Routine>('PATCH', `/api/routines/${r.id}`, { steps: [bare] })).body;
    expect(await history(r.id)).toHaveLength(2);
    later();
    // As the form sends it back: each step with its empty fields written out.
    const steps = (saved.steps ?? []).map((x) => ({ ...x, when: null, next: '', onError: '' }));
    const res = await t.api('PATCH', `/api/routines/${r.id}`, { prompt: saved.prompt, steps, model: '' });
    expect(res.status).toBe(200);
    expect(await history(r.id)).toHaveLength(2);
  });

  const runTimes = async (id: string, times: number) => {
    for (let i = 0; i < times; i++) {
      t.now.value = new Date(t.now.value.getTime() + 1000);
      await t.api('POST', `/api/routines/${id}/run`);
      await t.services.turns.idle();
    }
  };
  const versions = async (id: string) =>
    (await t.api<RoutineVersionReport>('GET', `/api/routines/${id}/versions`)).body;

  it('her çalışma başladığı sürümün altında sayılır', async () => {
    const bot = await t.bot();
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Kontrol',
        prompt: 'tamam',
        schedule: { type: 'interval', minutes: 30 },
        inMain: false,
      })
    ).body;
    await runTimes(r.id, 2);
    later();
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: '[hata]' });
    await runTimes(r.id, 1);
    const [now, before] = (await t.api<RoutineRevision[]>('GET', `/api/routines/${r.id}/revisions`)).body;
    // The fake engine's replies cost nothing; each run's turn is priced here instead.
    await t.db.db.update(schema.turns).set({ costUsd: 0.01 }).where(isNotNull(schema.turns.routineRunId));
    const v = await versions(r.id);
    expect(v.versions[before!.id]).toMatchObject({ total: 2, ok: 2, failed: 0, unpricedRuns: 0 });
    expect(v.versions[before!.id]!.costUsd).toBeCloseTo(0.02);
    expect(v.versions[now!.id]).toMatchObject({ total: 1, ok: 0, failed: 1 });
    expect(v.versions[now!.id]!.costUsd).toBeCloseTo(0.01);
    expect(v.untracked).toBeNull();
  });

  it('sürümün yalnız talimatı tutulmuş rutin ilk çalışmasında tam sürüm alır; eski çalışmalar ayrı sayılır', async () => {
    const bot = await t.bot();
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Kontrol',
        prompt: 'tamam',
        schedule: { type: 'interval', minutes: 30 },
        inMain: false,
      })
    ).body;
    await runTimes(r.id, 1);
    // As kept before this: the instruction alone, and runs with no version on them.
    await t.db.db.update(schema.routineRevisions).set({ full: false, steps: null, model: null });
    await t.db.db.update(schema.routineRuns).set({ revisionId: null });
    later();
    await runTimes(r.id, 1);
    const list = (await t.api<RoutineRevision[]>('GET', `/api/routines/${r.id}/revisions`)).body;
    expect(list.map((x) => x.full)).toEqual([true, false]);
    expect(list[1]).not.toHaveProperty('steps');
    const v = await versions(r.id);
    expect(v.untracked).toMatchObject({ total: 1, ok: 1 });
    expect(v.versions[list[0]!.id]).toMatchObject({ total: 1, ok: 1 });
  });

  it('kaydetmeden önce okunmuş kopyayla başlayan çalışma eski sürümde sayılır; en yeni sürüm kaydedilen kalır', async () => {
    const bot = await t.bot();
    const made = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Kontrol',
        prompt: 'tamam',
        schedule: { type: 'interval', minutes: 30 },
        inMain: false,
      })
    ).body;
    // As a pass reads it before a slow page read; the person saves meanwhile.
    const before = await t.services.routines.get(made.id);
    later();
    await t.api('PATCH', `/api/routines/${made.id}`, { prompt: 'yeni talimat' });
    later();
    await t.services.routines['fire'](before, 'eski-kopya');
    await t.services.turns.idle();
    const list = (await t.api<RoutineRevision[]>('GET', `/api/routines/${made.id}/revisions`)).body;
    expect(list.map((x) => x.prompt)).toEqual(['yeni talimat', 'tamam']);
    expect((await versions(made.id)).versions[list[1]!.id]).toMatchObject({ total: 1 });
  });

  it('eski sürümlü rutinde aynı anda başlayan iki çalışma tek sürüm yazar', async () => {
    const r = await make();
    await t.db.db.update(schema.routineRevisions).set({ full: false, steps: null, model: null });
    later();
    const routine = await t.services.routines.get(r.id);
    const ids = await Promise.all([
      t.services.routines['revisionFor'](routine),
      t.services.routines['revisionFor'](routine),
    ]);
    expect(ids[0]).toBe(ids[1]);
    expect((await t.api<RoutineRevision[]>('GET', `/api/routines/${r.id}/revisions`)).body).toHaveLength(2);
  });

  it('başkasının botunun rutin sürümlerini göstermez', async () => {
    const r = await make();
    const ayse = await t.person('ayse');
    const res = await ayse.api('GET', `/api/routines/${r.id}/versions`);
    expect([403, 404]).toContain(res.status);
  });

  it('rutin silinince geçmişi de gider', async () => {
    const r = await make();
    await t.api('DELETE', `/api/routines/${r.id}`);
    expect(await t.db.db.select().from(schema.routineRevisions)).toHaveLength(0);
  });
});
