import type { Approval, Message, Routine, RoutineRun, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('an approval step of a routine', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, steps: unknown[], prompt = 'taslak yaz') => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Akış',
      prompt,
      steps,
      schedule: { type: 'interval', minutes: 30 },
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const card = async (run: RoutineRun) => {
    const id = run.steps?.find((s) => s.approvalId)?.approvalId;
    expect(id).toBeTruthy();
    return (await t.api<Approval>('GET', `/api/approvals/${id}`)).body;
  };
  const answer = async (id: string, body: Record<string, unknown>) => {
    const res = await t.api('POST', `/api/approvals/${id}`, body);
    expect(res.status).toBe(200);
    await t.services.routines.settleSteps();
    await t.services.turns.idle();
  };
  const reports = async (botId: string): Promise<Message[]> => {
    const main = (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
    return (await t.messages(main.id)).filter((m) => (m.props as { routineReport?: boolean }).routineReport);
  };
  const runOnce = async (r: Routine) => {
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    return run!;
  };

  it('holds the run for the person and goes on when they approve', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, [
      { id: 'onay', kind: 'approval', question: 'Gönderilsin mi?' },
      { id: 'gonder', kind: 'agent', prompt: 'gönder' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('waiting');
    expect(run.reason).toBeTruthy();
    expect(run.steps?.map((s) => s.status)).toEqual(['done', 'waiting', 'pending']);
    const asked = await card(run);
    expect(asked.status).toBe('pending');
    expect(asked.summary).toBe('Gönderilsin mi?');
    // The card shows what the step before it ended with.
    expect(JSON.stringify(asked.input)).toContain('taslak yaz');
    // It stays when the server starts again, unlike a card a turn waits on.
    await t.services.approvals.expireAllPending();
    expect((await card(run)).status).toBe('pending');

    await answer(asked.id, { decision: 'allow', answer: asked.options[0] });
    const [done] = await runs(r.id);
    expect(done!.status).toBe('done');
    expect(done!.steps?.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    // The step after the card reads what the card let through, not the card's answer.
    const last = t.engine.requests.filter((q) => q.prompt.includes('gönder')).at(-1)!.prompt;
    expect(last).toContain('taslak yaz');
    expect(await reports(bot.id)).toHaveLength(1);
  });

  it('ends the run when the person rejects it', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, [
      { id: 'onay', kind: 'approval', question: 'Gönderilsin mi?' },
      { id: 'gonder', kind: 'agent', prompt: 'gönder' },
    ]);
    const asked = await card(await runOnce(r));
    await answer(asked.id, { decision: 'allow', answer: asked.options[1] });
    const [run] = await runs(r.id);
    expect(run!.status).toBe('stopped');
    expect(run!.steps?.map((s) => s.status)).toEqual(['done', 'stopped', 'skipped']);
    expect(t.engine.requests.some((q) => q.prompt.includes('gönder'))).toBe(false);
    expect(await reports(bot.id)).toHaveLength(0);
  });

  it('sends a correction back past a step its condition passed over, to the one that did the work', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, [
      { id: 'kontrol', kind: 'agent', prompt: 'denetle', when: { filter: 'count!=0' } },
      { id: 'onay', kind: 'approval', question: 'Uygun mu?' },
    ]);
    // A bot's prose is no JSON: the filter does not hold, and the step is passed over, not stuck.
    const run = await runOnce(r);
    expect(run.steps?.map((s) => s.status)).toEqual(['done', 'skipped', 'waiting']);
    await answer((await card(run)).id, { decision: 'allow', answer: 'daha kısa olsun' });
    const again = t.engine.requests.at(-1)!.prompt;
    expect(again).toContain('daha kısa olsun');
    expect(again).toContain('taslak yaz');
    expect(t.engine.requests.some((q) => q.prompt.includes('denetle'))).toBe(false);
  });

  it('does the step before it again with a correction in words, then asks again', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, [{ id: 'onay', kind: 'approval', question: 'Uygun mu?' }]);
    const first = await card(await runOnce(r));
    await answer(first.id, { decision: 'allow', answer: 'daha kısa olsun' });
    const again = t.engine.requests.at(-1)!.prompt;
    expect(again).toContain('daha kısa olsun');
    expect(again).toContain('taslak yaz');
    let [run] = await runs(r.id);
    expect(run!.status).toBe('waiting');
    const second = await card(run!);
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe('pending');

    // The card was the last step: approving it reports what it let through.
    await answer(second.id, { decision: 'allow', answer: second.options[0] });
    [run] = await runs(r.id);
    expect(run!.status).toBe('done');
    const sent = await reports(bot.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('daha kısa olsun');
  });

  it('ends the run when nobody answers in time', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, [{ id: 'onay', kind: 'approval', question: 'Uygun mu?', timeoutDays: 1 }]);
    const run = await runOnce(r);
    expect(run.steps?.[1]?.waitUntil).toBeTruthy();
    await t.services.routines.tick();
    expect((await card(run)).status).toBe('pending');

    t.now.value = new Date(t.now.value.getTime() + 25 * 60 * 60_000);
    await t.services.routines.tick();
    await t.services.routines.settleSteps();
    await t.services.turns.idle();
    const [ended] = (await runs(r.id)).filter((x) => x.id === run.id);
    expect(ended!.status).toBe('error');
    expect(ended!.steps?.[1]?.status).toBe('error');
    expect((await card(run)).status).toBe('expired');
  });

  it('lets the next run go while one waits, each in a conversation of its own', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, [{ id: 'onay', kind: 'approval', question: 'Uygun mu?' }]);
    const first = await runOnce(r);
    t.now.value = new Date(t.now.value.getTime() + 60_000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const list = await runs(r.id);
    expect(list).toHaveLength(2);
    expect(list.every((x) => x.status === 'waiting')).toBe(true);
    expect(new Set(list.map((x) => x.threadId)).size).toBe(2);

    // Pausing the routine ends what waits for the person, and closes the cards.
    await t.api('PATCH', `/api/routines/${r.id}`, { enabled: false });
    const after = await runs(r.id);
    expect(after.every((x) => x.status === 'stopped')).toBe(true);
    expect((await card(first)).status).toBe('expired');
  });

  it('goes on from an approval step that was not answered in time when tried again', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, [{ id: 'onay', kind: 'approval', question: 'Uygun mu?', timeoutDays: 1 }]);
    const run = await runOnce(r);
    t.now.value = new Date(t.now.value.getTime() + 25 * 60 * 60_000);
    await t.services.routines.tick();
    await t.services.routines.settleSteps();
    // The routine came due meanwhile: its new run waits for the person too, outside the slot.
    await t.services.turns.idle();
    const retried = await t.api<RoutineRun>('POST', `/api/routines/${r.id}/runs/${run.id}/retry`);
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('waiting');
    const asked = await card(retried.body);
    expect(asked.status).toBe('pending');
    // The bot's own step is not done again: only the new run asked it.
    expect(t.engine.requests.filter((q) => q.prompt.includes('taslak yaz'))).toHaveLength(2);
  });

  it('keeps an approved run held while its bot is paused, and goes on once it is let go', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, [
      { id: 'onay', kind: 'approval', question: 'Gönderilsin mi?' },
      { id: 'gonder', kind: 'agent', prompt: 'gönder' },
    ]);
    const asked = await card(await runOnce(r));
    await t.api('POST', `/api/bots/${bot.id}/pause`, { paused: true });
    await answer(asked.id, { decision: 'allow', answer: asked.options[0] });
    let [run] = await runs(r.id);
    expect(run!.status).toBe('waiting');
    expect(t.engine.requests.some((q) => q.prompt.includes('gönder'))).toBe(false);

    await t.api('POST', `/api/bots/${bot.id}/pause`, { paused: false });
    await t.services.routines.settleSteps();
    await t.services.turns.idle();
    [run] = await runs(r.id);
    expect(run!.status).toBe('done');
  });

  it('turns away an approval step with no question', async () => {
    const bot = await t.bot();
    const res = await t.api('POST', '/api/routines', {
      botId: bot.id,
      name: 'Akış',
      prompt: 'iş',
      steps: [{ id: 'onay', kind: 'approval', question: ' ' }],
      schedule: { type: 'interval', minutes: 30 },
    });
    expect(res.status).toBe(400);
  });
});
