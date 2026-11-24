import type { Routine, RoutineFix, RoutineRun } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { parseFix } from '../src/services/routine-fix';
import { testServer, type TestServer } from './helpers';

describe('a fix proposed for a routine from its runs', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, prompt: string, steps: unknown[] = []) => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Özet',
      prompt,
      steps,
      schedule: { type: 'interval', minutes: 30 },
      inMain: false,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const runOnce = async (r: Routine) => {
    await t.api('POST', `/api/routines/${r.id}/run`);
    for (let i = 0; i < 6; i++) {
      await t.services.routines.settleSteps();
      await t.services.turns.idle();
      await t.services.routines.settled();
    }
    return (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body[0]!;
  };
  /** The call that wrote the proposal, among the server's other small calls (titles, memory). */
  const asked = () => t.engine.completions.filter((c) => c.system.includes('You look after a routine'));

  it('proposes a new instruction and bot step from how the runs went, and changes nothing', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'gelen kutusunu özetle; şifre: gizli12345', [
      { id: 'gonder', kind: 'agent', prompt: 'özeti gönder [hata]' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('error');
    t.engine.completer = (req) =>
      req.system.includes('You look after a routine')
        ? JSON.stringify({
            why: 'Gönderim adımı her seferinde hata verdi.',
            prompt: 'gelen kutusunu özetle, yalnız okunmamışları',
            steps: [
              { id: 'gonder', prompt: 'özeti kısa tut ve gönder' },
              { id: 'yok', prompt: 'olmayan adım' },
            ],
          })
        : '{}';
    const res = await t.api<RoutineFix>('POST', `/api/routines/${r.id}/fix`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      why: 'Gönderim adımı her seferinde hata verdi.',
      prompt: 'gelen kutusunu özetle, yalnız okunmamışları',
      steps: [{ id: 'gonder', prompt: 'özeti kısa tut ve gönder' }],
      runs: 1,
    });
    const [call] = asked();
    // It read the run as data, with how its step ended, and no secret left in what the run wrote.
    // The instruction goes as it is: the bot reads it on every run, and a fix keeps it whole.
    const runs = call!.user.slice(call!.user.indexOf('<runs>'));
    expect(runs).toContain('step 1 (agent): error');
    expect(runs).toContain('gelen kutusunu özetle');
    expect(runs).not.toContain('gizli12345');
    // Only proposed: the routine is as it was, and what the call cost is counted.
    expect((await t.services.routines.get(r.id)).prompt).toBe(r.prompt);
    const calls = await t.services.ctx.db
      .select()
      .from(schema.backgroundCalls)
      .where(eq(schema.backgroundCalls.kind, 'routineFix'));
    expect(calls).toHaveLength(1);
  });

  it('applies through a change of the routine, which an earlier version takes back', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'haberleri topla');
    await runOnce(r);
    t.engine.completer = (req) =>
      req.system.includes('You look after a routine')
        ? JSON.stringify({ why: 'Rapor boştu.', prompt: 'haberleri topla, kaynak ver', steps: [] })
        : '{}';
    const fix = (await t.api<RoutineFix>('POST', `/api/routines/${r.id}/fix`)).body;
    expect((await t.api('PATCH', `/api/routines/${r.id}`, { prompt: fix.prompt })).status).toBe(200);
    const versions = (await t.api<{ prompt: string }[]>('GET', `/api/routines/${r.id}/revisions`)).body;
    // Both saved in the same test second: which one is listed first is not looked at.
    expect(versions.map((v) => v.prompt).sort()).toEqual(['haberleri topla', 'haberleri topla, kaynak ver']);
  });

  it('is not proposed before the routine ran, nor when the model wrote no proposal', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'haberleri topla');
    expect((await t.api('POST', `/api/routines/${r.id}/fix`)).status).toBe(409);
    await runOnce(r);
    t.engine.completer = () => 'olmadı';
    expect((await t.api('POST', `/api/routines/${r.id}/fix`)).status).toBe(502);
  });

  it('keeps to what it may change', () => {
    const steps = [
      { id: 'a', kind: 'agent' as const, prompt: 'yaz', model: '' },
      { id: 'n', kind: 'notify' as const, text: 'bitti', withBefore: true },
    ];
    expect(
      parseFix(
        'Öneri: {"why":"İyi gitti.","prompt":"topla","steps":[{"id":"a","prompt":"yaz"},{"id":"n","prompt":"x"}]}',
        'topla',
        steps,
      ),
    ).toEqual({ why: 'İyi gitti.', prompt: null, steps: [] });
    expect(parseFix('{"prompt":"x"}', 'topla', steps)).toBeNull();
  });
});
