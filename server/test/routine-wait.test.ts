import { createHmac } from 'node:crypto';
import type { BotEmail, Message, Routine, RoutineRun, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('a wait step of a routine', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (
    botId: string,
    prompt: string,
    steps: unknown[],
    extra: Record<string, unknown> = {},
  ) => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Akış',
      prompt,
      steps,
      schedule: { type: 'interval', minutes: 30 },
      ...extra,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const runOf = async (r: Routine, id: string) => (await runs(r.id)).find((x) => x.id === id)!;
  const runOnce = async (r: Routine) => {
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    return run!;
  };
  const reports = async (botId: string): Promise<Message[]> => {
    const main = (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
    return (await t.messages(main.id)).filter((m) => (m.props as { routineReport?: boolean }).routineReport);
  };
  const hooked = async (r: Routine) => (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
  const deliver = (
    r: Routine,
    token: string,
    event: string,
    body: object,
    id = `${event}-${Math.random()}`,
  ) => {
    const raw = JSON.stringify(body);
    const sig = `sha256=${createHmac('sha256', token).update(raw).digest('hex')}`;
    return t.app.inject({
      method: 'POST',
      url: `/api/hooks/routines/${r.id}/${token}`,
      headers: {
        host: 'localhost',
        'content-type': 'application/json',
        'x-github-event': event,
        'x-github-delivery': id,
        'x-hub-signature-256': sig,
      },
      payload: raw,
    });
  };
  const mail = (botId: string, subject: string): BotEmail => ({
    id: `m${Math.random().toString(36).slice(2)}`,
    botId,
    to: 'bot@ornek.com',
    from: 'musteri@ornek.com',
    fromName: 'Müşteri',
    subject,
    text: 'gövde',
    attachments: [],
    receivedAt: t.now.value.toISOString(),
    readAt: null,
  });
  const later = (ms: number) => {
    t.now.value = new Date(t.now.value.getTime() + ms);
  };
  const tick = async () => {
    await t.services.routines.tick();
    await t.services.routines.settleSteps();
    await t.services.turns.idle();
  };

  it('waits for its time and then goes on', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'bekle', kind: 'wait', on: 'time', minutes: 90 },
      { id: 'sonra', kind: 'agent', prompt: 'sonraki iş' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('waiting');
    expect(run.steps?.map((s) => s.status)).toEqual(['done', 'waiting', 'pending']);
    later(60 * 60_000);
    await tick();
    expect((await runOf(r, run.id)).status).toBe('waiting');
    later(31 * 60_000);
    await tick();
    const done = await runOf(r, run.id);
    expect(done.status).toBe('done');
    expect(done.steps?.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    // The step after the wait builds on the bot step before it.
    expect(t.engine.requests.at(-1)!.prompt).toContain('ilk iş');
    expect(await reports(bot.id)).toHaveLength(1);
  });

  it('goes on after the wait where its way leads, passing over the steps in between', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'bekle', kind: 'wait', on: 'time', minutes: 30, next: 'son' },
      { id: 'ara', kind: 'agent', prompt: 'ara iş' },
      { id: 'son', kind: 'agent', prompt: 'son iş' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('waiting');
    later(31 * 60_000);
    await tick();
    const done = await runOf(r, run.id);
    expect(done.status).toBe('done');
    expect(done.steps?.map((s) => s.status)).toEqual(['done', 'done', 'skipped', 'done']);
    expect(t.engine.requests.some((q) => q.prompt.includes('ara iş'))).toBe(false);
    // The step it went on at builds on the bot step before the wait.
    expect(t.engine.requests.at(-1)!.prompt).toContain('son iş');
    expect(t.engine.requests.at(-1)!.prompt).toContain('ilk iş');
  });

  it('ends the run after the wait when its way is to end', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'bekle', kind: 'wait', on: 'time', minutes: 30, next: 'end' },
      { id: 'son', kind: 'agent', prompt: 'son iş' },
    ]);
    const run = await runOnce(r);
    later(31 * 60_000);
    await tick();
    const done = await runOf(r, run.id);
    expect(done.status).toBe('done');
    expect(t.engine.requests.some((q) => q.prompt.includes('son iş'))).toBe(false);
    const sent = await reports(bot.id);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('ilk iş');
  });

  it('goes on when the person ends the wait', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'bekle', kind: 'wait', on: 'time', minutes: 600 },
      { id: 'sonra', kind: 'agent', prompt: 'sonraki iş' },
    ]);
    const run = await runOnce(r);
    const ended = await t.api<RoutineRun>('POST', `/api/routines/${r.id}/runs/${run.id}/end-wait`);
    expect(ended.status).toBe(200);
    await t.services.turns.idle();
    expect((await runOf(r, run.id)).status).toBe('done');
    // Nothing waits any more.
    expect((await t.api('POST', `/api/routines/${r.id}/runs/${run.id}/end-wait`)).status).toBe(409);
  });

  it('waits for the webhook call its saved value names, and takes it once', async () => {
    const bot = await t.bot();
    const save = JSON.stringify({ name: 'issue', value: '42' });
    const r = await make(bot.id, `issue aç [araç:routine_set ${save}]`, [
      {
        id: 'kapanis',
        kind: 'wait',
        on: 'webhook',
        filter: 'event=issues\naction=closed\nissue.number={{issue}}',
      },
      { id: 'yaz', kind: 'agent', prompt: 'müşteriye yaz' },
    ]);
    const { webhookToken } = await hooked(r);
    const run = await runOnce(r);
    expect(run.status).toBe('waiting');
    // The bot was told which value to save.
    expect(t.engine.requests[0]!.prompt).toContain('routine_set');

    // Another issue closing, or this one being opened, is not it; nor does it start a run.
    expect(
      (await deliver(r, webhookToken!, 'issues', { action: 'closed', issue: { number: 7 } })).json(),
    ).toMatchObject({
      status: 'filtered',
    });
    await deliver(r, webhookToken!, 'issues', { action: 'opened', issue: { number: 42 } });
    await t.services.turns.idle();
    expect(await runs(r.id)).toHaveLength(1);
    expect((await runOf(r, run.id)).status).toBe('waiting');

    const body = { action: 'closed', issue: { number: 42, title: 'Giriş hatası' } };
    expect((await deliver(r, webhookToken!, 'issues', body, 'teslim-1')).json()).toMatchObject({
      runId: run.id,
    });
    await t.services.turns.idle();
    const done = await runOf(r, run.id);
    expect(done.status).toBe('done');
    // The step after it reads what came in, as outside text.
    const last = t.engine.requests.at(-1)!;
    expect(last.prompt).toContain('Giriş hatası');
    expect(last.prompt).toContain('müşteriye yaz');
    // The same delivery sent again starts nothing.
    await deliver(r, webhookToken!, 'issues', body, 'teslim-1');
    await t.services.turns.idle();
    expect(await runs(r.id)).toHaveLength(1);
  });

  it('marks the run as reading outside text once an event came in', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'posta', kind: 'wait', on: 'email', filter: 'subject~=fatura' },
      { id: 'yaz', kind: 'agent', prompt: 'özetle' },
    ]);
    const run = await runOnce(r);
    await t.services.routines.runFromEmail(bot.id, mail(bot.id, 'Merhaba'));
    await t.services.turns.idle();
    expect((await runOf(r, run.id)).status).toBe('waiting');
    await t.services.routines.runFromEmail(bot.id, mail(bot.id, 'Kasım faturası'));
    await t.services.turns.idle();
    expect((await runOf(r, run.id)).status).toBe('done');
    const shown = await t.messages(run.threadId!);
    expect(shown.some((m) => (m.props as { outside?: string }).outside === 'email')).toBe(true);
    // A routine that does not start on mail did not start a run on either.
    expect(await runs(r.id)).toHaveLength(1);
  });

  it('keeps an event that comes while another run holds the slot', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, '[bekle:300] iş', [
      { id: 'posta', kind: 'wait', on: 'email', filter: '' },
      { id: 'yaz', kind: 'agent', prompt: 'özetle' },
    ]);
    const first = await runOnce(r);
    expect(first.status).toBe('waiting');
    later(60_000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    // The second run is at work now; the mail for the first comes meanwhile.
    await t.services.routines.runFromEmail(bot.id, mail(bot.id, 'Cevap'));
    expect((await runOf(r, first.id)).status).toBe('waiting');
    await t.services.turns.idle();
    await t.services.routines.settleSteps();
    await t.services.turns.idle();
    expect((await runOf(r, first.id)).status).toBe('done');
  });

  it('ends the run when a value its filter names was never saved', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'posta', kind: 'wait', on: 'email', filter: 'subject~={{konu}}' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('error');
    expect(run.reason).toContain('konu');
    // An empty value would have let every mail through: none is taken.
    await t.services.routines.runFromEmail(bot.id, mail(bot.id, 'herhangi'));
    expect((await runOf(r, run.id)).status).toBe('error');
  });

  it('ends the run when the event does not come in time', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [{ id: 'posta', kind: 'wait', on: 'email', timeoutDays: 2 }]);
    const run = await runOnce(r);
    later(49 * 60 * 60_000);
    await tick();
    const ended = await runOf(r, run.id);
    expect(ended.status).toBe('error');
    expect(ended.steps?.[1]?.status).toBe('error');
  });
});
