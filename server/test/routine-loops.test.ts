import {
  describeAction,
  ROUTINE_BACK_MAX,
  type Approval,
  type Message,
  type Routine,
  type RoutineRun,
  type Thread,
} from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db';
import type * as SkillLink from '../src/services/skill-link';
import { testServer, type TestServer } from './helpers';

/** What the stand-in address serves each time it is read, and how often it was. */
const web = vi.hoisted(() => ({ asked: 0, answer: (_n: number): string => '{}' }));
vi.mock('../src/services/skill-link', async (original) => ({
  ...(await original<typeof SkillLink>()),
  fetchPublic: async (url: URL) => {
    web.asked++;
    return { body: Buffer.from(web.answer(web.asked)), contentType: 'application/json', url };
  },
}));

describe('a routine that goes back, or on after a no', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
    web.asked = 0;
    web.answer = () => '{}';
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, steps: unknown[], prompt = 'taslak yaz') => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Döngü',
      prompt,
      steps,
      schedule: { type: 'interval', minutes: 30 },
      inMain: false,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      await t.services.routines.settleSteps();
      await t.services.turns.idle();
      await t.services.routines.settled();
    }
  };
  const runOnce = async (r: Routine) => {
    await t.api('POST', `/api/routines/${r.id}/run`);
    await settle();
    const [run] = await runs(r.id);
    return run!;
  };
  const card = async (run: RoutineRun) => {
    const id = run.steps?.find((s) => s.status === 'waiting' && s.approvalId)?.approvalId;
    expect(id).toBeTruthy();
    return (await t.api<Approval>('GET', `/api/approvals/${id}`)).body;
  };
  const answer = async (a: Approval, option: number) => {
    expect(
      (await t.api('POST', `/api/approvals/${a.id}`, { decision: 'allow', answer: a.options[option] }))
        .status,
    ).toBe(200);
    await settle();
  };
  const reports = async (botId: string): Promise<Message[]> => {
    const main = (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
    return (await t.messages(main.id)).filter((m) => (m.props as { routineReport?: boolean }).routineReport);
  };
  const runRow = async (id: string) =>
    (await t.services.ctx.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, id)))[0]!;
  const streak = async (id: string) =>
    (await t.services.ctx.db.select().from(schema.routines).where(eq(schema.routines.id, id)))[0]!
      .failureStreak;

  it('goes on along the way for a no, with what was turned down, without counting it', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, [
      { id: 'onay', kind: 'approval', question: 'Gönderilsin mi?', onReject: 'haber' },
      { id: 'gonder', kind: 'agent', prompt: 'gönder', next: 'end' },
      { id: 'haber', kind: 'notify', text: 'Taslak gönderilmedi' },
    ]);
    await answer(await card(await runOnce(r)), 1);
    const [run] = await runs(r.id);
    expect(run!.status).toBe('done');
    expect(run!.steps?.map((s) => s.status)).toEqual(['done', 'stopped', 'skipped', 'done']);
    expect(t.engine.requests.some((q) => q.prompt.includes('gönder'))).toBe(false);
    const sent = (await reports(bot.id)).at(-1)!.text;
    expect(sent).toContain('Taslak gönderilmedi');
    expect(sent).toContain('2. adımda kullanıcı bunu reddetti');
    expect(sent).toContain('taslak yaz');
    expect(await streak(r.id)).toBe(0);
  });

  it('goes back to write it again after a no, and asks again', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, [
      { id: 'yaz', kind: 'agent', prompt: 'mektubu yaz' },
      { id: 'onay', kind: 'approval', question: 'Gönderilsin mi?', onReject: 'yaz' },
      { id: 'gonder', kind: 'agent', prompt: 'gönder' },
    ]);
    const first = await runOnce(r);
    await answer(await card(first), 1);
    const [again] = await runs(r.id);
    expect(again!.status).toBe('waiting');
    // The writing step was asked again, with that the person turned its draft down.
    const rewrite = t.engine.requests.filter((q) => q.prompt.includes('mektubu yaz'));
    expect(rewrite).toHaveLength(2);
    expect(rewrite[1]!.prompt).toContain('kullanıcı bunu reddetti');
    await answer(await card(again!), 0);
    const [done] = await runs(r.id);
    expect(done!.status).toBe('done');
    expect(done!.steps?.map((s) => s.status)).toEqual(['done', 'done', 'done', 'done']);
    expect((await runRow(done!.id)).backs).toBe(1);
  });

  it('reads a page again every half hour until what it waits for is there', async () => {
    const bot = await t.bot();
    web.answer = (n) => JSON.stringify({ hazir: n >= 3 });
    const r = await make(bot.id, [
      { id: 'oku', kind: 'fetch', url: 'https://ornek.com/durum.json' },
      {
        id: 'bildir',
        kind: 'notify',
        text: 'Hazır',
        withBefore: false,
        when: { contains: '"hazir":true', otherwise: 'goto', goto: 'bekle' },
        next: 'end',
      },
      { id: 'bekle', kind: 'wait', on: 'time', minutes: 30, next: 'oku' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('waiting');
    for (let i = 0; i < 2; i++) {
      t.now.value = new Date(t.now.value.getTime() + 31 * 60_000);
      await t.services.routines.tick();
      await settle();
    }
    // The routine's own schedule came round meanwhile; this run is the one that waited.
    const done = (await runs(r.id)).find((x) => x.id === run.id);
    expect(done!.status).toBe('done');
    expect(web.asked).toBe(3);
    expect((await reports(bot.id)).at(-1)!.text).toBe('Hazır');
    // The wait was not on the last pass.
    expect(done!.steps?.map((s) => s.status)).toEqual(['done', 'done', 'done', 'skipped']);
    expect((await runRow(done!.id)).backs).toBe(2);
  });

  it('stops a run that never comes out of its loop, as failed', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, [
      { id: 'oku', kind: 'fetch', url: 'https://ornek.com/a.json' },
      { id: 'yine', kind: 'fetch', url: 'https://ornek.com/b.json', next: 'oku' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('error');
    expect(run.reason).toContain(String(ROUTINE_BACK_MAX));
    // Every pass reads twice: the first, and one more after each time it went back.
    expect(web.asked).toBe(2 * (ROUTINE_BACK_MAX + 1));
    expect(await streak(r.id)).toBe(1);
  });

  it('shows the way for a no on the card that sets it up', () => {
    const detail = describeAction(
      'mcp__leafbot__routine_create',
      {
        name: 'Döngü',
        prompt: 'yaz',
        schedule: { type: 'daily', time: '09:00' },
        steps: [
          { id: 'onay', kind: 'approval', question: 'Gönderilsin mi?', on_reject: 'haber' },
          { id: 'haber', kind: 'notify', text: 'Gönderilmedi' },
        ],
      },
      { bot: 'Paşa', locale: 'tr' },
    ).detail;
    expect(detail).toContain('1. sana sorar: Gönderilsin mi? → reddedilirse 2. adım');
  });
});
