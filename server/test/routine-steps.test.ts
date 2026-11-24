import type { Message, Routine, RoutineRun, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, waitFor, type TestServer } from './helpers';

describe('a routine with steps', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, prompt: string, steps: unknown[]) => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Akış',
      prompt,
      steps,
      schedule: { type: 'interval', minutes: 30 },
      // Its report reaches the main conversation from a conversation of its own.
      inMain: false,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const reports = async (botId: string): Promise<Message[]> =>
    (await t.messages((await main(botId)).id)).filter(
      (m) => (m.props as { routineReport?: boolean }).routineReport,
    );

  it('does each step in order, with the one before it, and reports only the last', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'a', kind: 'agent', prompt: 'ikinci iş' },
      { id: 'b', kind: 'agent', prompt: 'üçüncü iş', model: 'haiku' },
    ]);
    expect(r.steps?.map((s) => s.id)).toEqual(['a', 'b']);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    expect(run!.status).toBe('done');
    expect(run!.steps?.map((s) => [s.kind, s.status])).toEqual([
      ['prompt', 'done'],
      ['agent', 'done'],
      ['agent', 'done'],
    ]);
    // Each step of the run says which step it was, so the flow view shows it on that step's box.
    expect(run!.steps?.map((s) => s.stepId)).toEqual([undefined, 'a', 'b']);
    const asked = t.engine.requests.filter((q) => q.prompt.includes('Akış'));
    expect(asked).toHaveLength(3);
    // The second step reads what the first one ended with; the last runs on its own model.
    expect(asked[1]!.prompt).toContain('ikinci iş');
    expect(asked[1]!.prompt).toContain('ilk iş');
    expect(asked[2]!.model).toBe('haiku');
    expect(asked[1]!.model).not.toBe('haiku');
    const sent = await reports(bot.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('üçüncü iş');
  });

  it('ends at a failed step and skips the rest, without running again by itself', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'a', kind: 'agent', prompt: '[hata] ikinci iş' },
      { id: 'b', kind: 'agent', prompt: 'üçüncü iş' },
    ]);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    expect(run!.status).toBe('error');
    expect(run!.steps?.map((s) => s.status)).toEqual(['done', 'error', 'skipped']);
    expect(await reports(bot.id)).toHaveLength(0);
    // The steps before it may already have changed something: no second try is put in.
    const routine = (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.id === r.id)!;
    expect(Date.parse(routine.nextRunAt!)).toBeGreaterThan(t.now.value.getTime() + 20 * 60_000);
  });

  it('goes on from a stopped step when tried again, without doing the steps before it', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'a', kind: 'agent', prompt: '[bekle:400] ikinci iş' },
      { id: 'b', kind: 'agent', prompt: 'üçüncü iş' },
    ]);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await waitFor(() => Promise.resolve(t.engine.requests.some((q) => q.prompt.includes('ikinci iş'))));
    await t.api('POST', `/api/threads/${(await runs(r.id))[0]!.threadId}/stop`);
    await t.services.turns.idle();
    let [run] = await runs(r.id);
    expect(run!.status).toBe('stopped');
    expect(run!.steps?.map((s) => s.status)).toEqual(['done', 'stopped', 'skipped']);

    // The routine's own instruction goes to the bot once, whatever is tried again after it.
    const own = () => t.engine.requests.filter((q) => q.prompt.startsWith('Rutin "Akış" zamanı')).length;
    expect(own()).toBe(1);
    const retried = await t.api<RoutineRun>('POST', `/api/routines/${r.id}/runs/${run!.id}/retry`);
    expect(retried.status).toBe(200);
    // It is going again: at work, or in line until its turn starts.
    expect(['running', 'waiting']).toContain(retried.body.status);
    await t.services.turns.idle();
    [run] = await runs(r.id);
    expect(run!.status).toBe('done');
    expect(run!.steps?.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    expect(own()).toBe(1);
    // The step tried again reads what the first one ended with.
    const again = t.engine.requests.filter((q) => q.prompt.includes('ikinci iş')).at(-1)!.prompt;
    expect(again).toContain('ilk iş');
    expect(await reports(bot.id)).toHaveLength(1);
    // A run that ended well is not tried again.
    expect((await t.api('POST', `/api/routines/${r.id}/runs/${run!.id}/retry`)).status).toBe(409);
  });

  it('ends the run when a step has nothing to do', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, '[sessiz]', [{ id: 'a', kind: 'agent', prompt: 'ikinci iş' }]);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    expect(run!.status).toBe('done');
    expect(run!.reason).toBeTruthy();
    expect(run!.steps?.map((s) => s.status)).toEqual(['done', 'skipped']);
    expect(await reports(bot.id)).toHaveLength(0);
  });

  it('keeps the steps a run started with when the routine changes meanwhile', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, '[bekle:300] ilk iş', [{ id: 'a', kind: 'agent', prompt: 'eski adım' }]);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.api('PATCH', `/api/routines/${r.id}`, {
      steps: [{ id: 'a', kind: 'agent', prompt: 'yeni adım' }],
    });
    await t.services.turns.idle();
    const asked = t.engine.requests.map((q) => q.prompt).join('\n');
    expect(asked).toContain('eski adım');
    expect(asked).not.toContain('yeni adım');
  });

  it('keeps where the flow view placed its boxes, without a new line in its history', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [{ id: 'a', kind: 'agent', prompt: 'ikinci iş' }]);
    expect(r.flowLayout).toBeNull();
    const layout = { start: { x: 24, y: 24 }, prompt: { x: 360, y: 24 }, a: { x: 24, y: 320 } };
    const saved = await t.api<Routine>('PATCH', `/api/routines/${r.id}`, { flowLayout: layout });
    expect(saved.status).toBe(200);
    expect(saved.body.flowLayout).toEqual(layout);
    expect((await t.services.routines.get(r.id)).flowLayout).toEqual(layout);
    expect(await t.services.routines.revisions(r.id)).toHaveLength(1);
    // A place off the canvas is turned down.
    const wrong = await t.api('PATCH', `/api/routines/${r.id}`, { flowLayout: { a: { x: -5, y: 0 } } });
    expect(wrong.status).toBe(400);
  });

  it('leaves a routine without steps as it was', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'tek iş', []);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    expect(run!.status).toBe('done');
    expect(run!.steps).toBeUndefined();
    const retried = await t.api('POST', `/api/routines/${r.id}/runs/${run!.id}/retry`);
    expect(retried.status).toBe(409);
  });

  it('sends a notify step as it is, with no AI, and goes on', async () => {
    const bot = await t.bot();
    const save = JSON.stringify({ name: 'issue', value: '42' });
    const r = await make(bot.id, `issue aç [araç:routine_set ${save}]`, [
      { id: 'bildir', kind: 'notify', text: 'Issue {{issue}} açıldı; {{yok}}bitti.' },
      { id: 'son', kind: 'agent', prompt: 'son iş' },
    ]);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    expect(run!.status).toBe('done');
    expect(run!.steps?.map((s) => [s.kind, s.status])).toEqual([
      ['prompt', 'done'],
      ['notify', 'done'],
      ['agent', 'done'],
    ]);
    // Two turns of the bot: the notify step asked none.
    expect(t.engine.requests).toHaveLength(2);
    const sent = await reports(bot.id);
    expect(sent).toHaveLength(2);
    expect(sent[0]!.text).toContain('Issue 42 açıldı; bitti.');
    // What the bot step ended with comes after the step's own text.
    expect(sent[0]!.text).toContain('kaydedildi');
    // The step after it builds on the bot step before it, not on the message.
    expect(t.engine.requests[1]!.prompt).toContain('kaydedildi');
    expect(t.engine.requests[1]!.prompt).not.toContain('Issue 42');
  });

  it('passes over a step whose condition does not hold, with no AI, handing on what reached it', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'a', kind: 'agent', prompt: 'ikinci iş', when: { contains: 'olmayan söz' } },
      { id: 'b', kind: 'agent', prompt: 'üçüncü iş', when: { contains: 'İLK İŞ' } },
    ]);
    expect(r.steps?.[0]?.when).toMatchObject({ contains: 'olmayan söz', absent: false, otherwise: 'skip' });
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    expect(run!.status).toBe('done');
    expect(run!.steps?.map((s) => s.status)).toEqual(['done', 'skipped', 'done']);
    expect(run!.steps?.[1]?.reason).toContain('olmayan söz');
    const asked = t.engine.requests.filter((q) => q.prompt.includes('Akış'));
    // The passed-over step asked no model; the one after it read what the first step ended with.
    expect(asked).toHaveLength(2);
    expect(asked[1]!.prompt).toContain('üçüncü iş');
    expect(asked[1]!.prompt).toContain('ilk iş');
    expect(asked[1]!.prompt).not.toContain('ikinci iş');
    const sent = await reports(bot.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('üçüncü iş');
  });

  it('ends the run where a condition says so, reporting what came so far', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      {
        id: 'a',
        kind: 'agent',
        prompt: 'ikinci iş',
        when: { contains: 'ilk', absent: true, otherwise: 'end' },
      },
      { id: 'b', kind: 'notify', text: 'bitti' },
    ]);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    expect(run!.status).toBe('done');
    expect(run!.reason).toContain('koşulu tutmadı');
    expect(run!.steps?.map((s) => s.status)).toEqual(['done', 'skipped', 'skipped']);
    expect(t.engine.requests.filter((q) => q.prompt.includes('Akış'))).toHaveLength(1);
    const sent = await reports(bot.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('ilk iş');
    expect(sent[0]!.text).not.toContain('bitti');
  });

  it('turns away two steps with the same id', async () => {
    const bot = await t.bot();
    const res = await t.api('POST', '/api/routines', {
      botId: bot.id,
      name: 'Akış',
      prompt: 'ilk iş',
      steps: [
        { id: 'a', kind: 'agent', prompt: 'bir' },
        { id: 'a', kind: 'agent', prompt: 'iki' },
      ],
      schedule: { type: 'interval', minutes: 30 },
    });
    expect(res.status).toBe(400);
  });
});
