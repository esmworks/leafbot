import type { Message, Routine, RoutineRun, Thread } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, type TestServer } from './helpers';

describe('a wait step for a chat reply', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, filter = '') => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Teklif',
      prompt: 'teklifi yaz',
      steps: [
        { id: 'bekle', kind: 'wait', on: 'chat', filter },
        { id: 'incele', kind: 'agent', prompt: 'cevabı incele' },
      ],
      schedule: { type: 'interval', minutes: 60 },
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const runOnce = async (r: Routine) => {
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const [run] = await runs(r.id);
    expect(run!.status).toBe('waiting');
    return run!;
  };
  const after = async (r: Routine, id: string) => {
    await t.services.turns.idle();
    return (await runs(r.id)).find((x) => x.id === id)!;
  };
  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const triggerOf = async (runId: string) =>
    (
      await t.services.ctx.db
        .select({ trigger: schema.routineRuns.trigger })
        .from(schema.routineRuns)
        .where(eq(schema.routineRuns.id, runId))
    )[0]!.trigger;
  const turnsIn = async (threadId: string) =>
    t.services.ctx.db.select().from(schema.turns).where(eq(schema.turns.threadId, threadId));

  it('goes on with a message written in the run’s own conversation, which starts no turn of its own', async () => {
    const bot = await t.bot();
    const r = await make(bot.id);
    const run = await runOnce(r);
    const before = (await turnsIn(run.threadId!)).length;
    await t.send(run.threadId!, 'Fiyat uygun, devam edelim');
    const done = await after(r, run.id);
    expect(done.status).toBe('done');
    expect(done.steps?.map((s) => s.status)).toEqual(['done', 'done', 'done']);
    const review = t.engine.requests.at(-1)!.prompt;
    expect(review).toContain('cevabı incele');
    expect(review).toContain('Fiyat uygun, devam edelim');
    // One turn more: the step after the wait. The message itself started none.
    expect((await turnsIn(run.threadId!)).length).toBe(before + 1);
    expect(await triggerOf(run.id)).toBeNull();
  });

  it('goes on with a reply to the run’s message from the main conversation', async () => {
    const bot = await t.bot();
    const r = await make(bot.id);
    const run = await runOnce(r);
    const home = await main(bot.id);
    const said = (await t.services.threads.addMessage({
      threadId: home.id,
      role: 'assistant',
      author: `bot:${bot.id}`,
      text: 'Teklif hazır, gönderilsin mi?',
      props: { routineRunId: run.id, routineReport: true },
    })) as { message: Message };
    await t.services.inbox.send(home.id, {
      text: 'evet',
      replyTo: said.message.id,
      userId: 'owner',
      props: { via: 'telegram' },
    });
    expect((await after(r, run.id)).status).toBe('done');
    expect(t.engine.requests.at(-1)!.prompt).toContain('evet');
  });

  it('takes a chat app’s message in the main conversation only when the step names a filter it meets', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'text~=onay');
    const run = await runOnce(r);
    const home = await main(bot.id);
    await t.services.inbox.send(home.id, {
      text: 'bugün hava nasıl',
      userId: 'owner',
      props: { via: 'slack' },
    });
    expect((await after(r, run.id)).status).toBe('waiting');
    // Typed in the app, not from a chat app: the main conversation is not the run's.
    await t.send(home.id, 'onay veriyorum');
    expect((await after(r, run.id)).status).toBe('waiting');
    await t.services.inbox.send(home.id, {
      text: 'onay veriyorum',
      userId: 'owner',
      props: { via: 'slack' },
    });
    expect((await after(r, run.id)).status).toBe('done');
  });

  it('waits on with no filter for a message in another conversation', async () => {
    const bot = await t.bot();
    const r = await make(bot.id);
    const run = await runOnce(r);
    const home = await main(bot.id);
    await t.services.inbox.send(home.id, { text: 'merhaba', userId: 'owner', props: { via: 'telegram' } });
    expect((await after(r, run.id)).status).toBe('waiting');
  });

  it('reads an answer on WhatsApp as outside text, and never someone else’s words', async () => {
    const bot = await t.bot();
    const r = await make(bot.id);
    const run = await runOnce(r);
    const ayse = await t.person('ayse');
    await t.services.inbox.send(run.threadId!, {
      text: 'Ali (+905550000000)\n\nTamam, kabul',
      userId: ayse.id,
      props: { via: 'whatsapp', outside: 'whatsapp', whatsappReply: '905550000000@s.whatsapp.net' },
    });
    expect((await after(r, run.id)).status).toBe('waiting');
    await t.services.inbox.send(run.threadId!, {
      text: 'Ali (+905550000000)\n\nTamam, kabul',
      userId: 'owner',
      props: { via: 'whatsapp', outside: 'whatsapp', whatsappReply: '905550000000@s.whatsapp.net' },
    });
    const done = await after(r, run.id);
    expect(done.status).toBe('done');
    expect(await triggerOf(run.id)).toBe('whatsapp');
  });
});
