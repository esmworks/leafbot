import type { Message, Routine, RoutineRun, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, waitFor, type TestServer } from './helpers';

describe('a routine run that hands work to another bot', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, prompt: string, extra: Record<string, unknown> = {}) =>
    (
      await t.api<Routine>('POST', '/api/routines', {
        botId,
        name: 'Rapor',
        prompt,
        schedule: { type: 'interval', minutes: 30 },
        // Its report reaches the main conversation from a conversation of its own.
        inMain: false,
        ...extra,
      })
    ).body;
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const reports = async (botId: string): Promise<Message[]> =>
    (await t.messages((await main(botId)).id)).filter(
      (m) => (m.props as { routineReport?: boolean }).routineReport,
    );

  it('reports the teammate-informed answer once, not the interim note, and ends only then', async () => {
    const a = await t.bot({ name: 'Ali' });
    await t.bot({ name: 'Ayşe' });
    const r = await make(a.id, '[araç:bot_send {"bot":"Ayşe","message":"[bekle:300] rapor hazır mı"}]');
    await t.api('POST', `/api/routines/${r.id}/run`);
    // The requester's own turn ends first; the run is still open while its request is.
    await waitFor(async () => (await t.services.turns.isRunning((await runs(r.id))[0]!.threadId!)) === false);
    expect((await runs(r.id))[0]!.status).toBe('running');
    expect(await reports(a.id)).toHaveLength(0);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    expect(run!.status).toBe('done');
    const sent = await reports(a.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('Ayşe cevap verdi');
  });

  it('carries the run through a routine that works in the main conversation', async () => {
    const a = await t.bot({ name: 'Ali' });
    await t.bot({ name: 'Ayşe' });
    const r = await make(a.id, '[araç:bot_send {"bot":"Ayşe","message":"selam"}]', { inMain: true });
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['done']);
  });

  it('a request that fails still ends the run, with the reply read by the bot', async () => {
    const a = await t.bot({ name: 'Ali' });
    await t.bot({ name: 'Ayşe' });
    const r = await make(a.id, '[araç:bot_send {"bot":"Ayşe","message":"[hata] bozuk"}]');
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['done']);
  });

  it('ends the run when its bot is archived while the request is open', async () => {
    const a = await t.bot({ name: 'Ali' });
    await t.bot({ name: 'Ayşe' });
    const r = await make(a.id, '[araç:bot_send {"bot":"Ayşe","message":"[bekle:300] rapor hazır mı"}]');
    await t.api('POST', `/api/routines/${r.id}/run`);
    await waitFor(async () => (await t.services.turns.isRunning((await runs(r.id))[0]!.threadId!)) === false);
    expect((await runs(r.id))[0]!.status).toBe('running');
    await t.services.bots.archive(a.id);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    expect(run!.status).toBe('error');
    expect(run!.reason).toBeTruthy();
  });

  it('a silent answer after the delegation is not reported', async () => {
    const a = await t.bot({ name: 'Ali' });
    await t.bot({ name: 'Ayşe' });
    const r = await make(a.id, '[araç:bot_send {"bot":"Ayşe","message":"selam"}] [sessiz]');
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['done']);
  });
});

describe('a routine run the person stops', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('is saved as stopped, not as a failure', async () => {
    const bot = await t.bot();
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Uzun',
        prompt: '[bekle:5000]',
        schedule: { type: 'interval', minutes: 30 },
      })
    ).body;
    await t.api('POST', `/api/routines/${r.id}/run`);
    const list = async () => (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body;
    await t.api('POST', `/api/threads/${(await list())[0]!.threadId}/stop`);
    await t.services.turns.idle();
    const [run] = await list();
    expect(run!.status).toBe('stopped');
    // No second try is scheduled for something the person chose to end.
    const routine = (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.id === r.id)!;
    expect(Date.parse(routine.nextRunAt!)).toBeGreaterThan(t.now.value.getTime());
    expect((await list()).filter((x) => x.status === 'error')).toHaveLength(0);
  });

  it('still counts an engine failure as failed', async () => {
    const bot = await t.bot();
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Bozuk',
        prompt: '[hata]',
        schedule: { type: 'interval', minutes: 30 },
      })
    ).body;
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect((await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body[0]!.status).toBe('error');
  });
});
