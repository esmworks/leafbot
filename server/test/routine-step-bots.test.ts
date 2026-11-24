import { describeAction, type Message, type Routine, type RoutineRun, type Thread } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, type TestServer } from './helpers';

describe('a routine step another bot does', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, steps: unknown[], extra: Record<string, unknown> = {}) => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Araştırma',
      prompt: 'konuyu seç',
      steps,
      schedule: { type: 'interval', minutes: 30 },
      inMain: false,
      ...extra,
    });
    return r;
  };
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const runOnce = async (r: Routine) => {
    await t.api('POST', `/api/routines/${r.id}/run`);
    for (let i = 0; i < 6; i++) {
      await t.services.routines.settleSteps();
      await t.services.turns.idle();
      await t.services.routines.settled();
    }
    const [run] = await runs(r.id);
    return run!;
  };
  const runThread = async (id: string) =>
    (await t.services.ctx.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, id)))[0]!
      .threadId!;
  const reports = async (botId: string): Promise<Message[]> => {
    const main = (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
    return (await t.messages(main.id)).filter((m) => (m.props as { routineReport?: boolean }).routineReport);
  };

  it('runs the step on the other bot, and the steps after it on its own again', async () => {
    const own = await t.bot();
    const other = await t.bot();
    const made = await make(
      own.id,
      [
        { id: 'arastir', kind: 'agent', prompt: 'konuyu araştır', bot: other.id },
        { id: 'denetle', kind: 'agent', prompt: 'kontrol et' },
      ],
      { model: 'haiku' },
    );
    expect(made.status).toBe(200);
    const run = await runOnce(made.body);
    expect(run.status).toBe('done');
    const home = await runThread(run.id);
    const handed = t.engine.requests.find((q) => q.prompt.includes('konuyu araştır'))!;
    expect(handed.botId).toBe(other.id);
    expect(handed.threadId).not.toBe(home);
    // The other bot works on its own model, not the one the routine names for its own bot.
    expect(handed.model).not.toBe('haiku');
    expect(handed.prompt).toContain(own.name);
    const checked = t.engine.requests.find((q) => q.prompt.includes('kontrol et'))!;
    expect(checked.botId).toBe(own.id);
    expect(checked.threadId).toBe(home);
    expect(checked.model).toBe('haiku');
    // What the other bot wrote reached the step after it, and stays in the run's conversation.
    expect(checked.prompt).toContain('konuyu araştır');
    const kept = (await t.messages(home)).find((m) => m.author === `bot:${other.id}`);
    expect(kept?.text).toContain('konuyu araştır');
    // The other bot's conversation with the routine's bot is where it did the step.
    const peer = await t.services.threads.peerThread(
      other.id,
      own.id,
      await t.services.access.botOwner(own.id),
    );
    expect(handed.threadId).toBe(peer.id);
  });

  it("reports from the routine's own bot when the other bot did the last step", async () => {
    const own = await t.bot();
    const other = await t.bot();
    const made = await make(own.id, [{ id: 'son', kind: 'agent', prompt: 'son işi yap', bot: other.id }]);
    const run = await runOnce(made.body);
    expect(run.status).toBe('done');
    expect((await reports(own.id)).at(-1)?.text).toContain('son işi yap');
  });

  it('fails the step along its failure way when the other bot was archived since', async () => {
    const own = await t.bot();
    const other = await t.bot();
    const made = await make(own.id, [
      { id: 'arastir', kind: 'agent', prompt: 'konuyu araştır', bot: other.id, onError: 'haber' },
      { id: 'yaz', kind: 'agent', prompt: 'yaz', next: 'end' },
      { id: 'haber', kind: 'notify', text: 'Araştıran bot yok' },
    ]);
    expect(made.status).toBe(200);
    expect((await t.api('POST', `/api/bots/${other.id}/archive`)).status).toBe(200);
    const run = await runOnce(made.body);
    expect(run.status).toBe('done');
    expect(run.steps?.map((s) => s.status)).toEqual(['done', 'error', 'skipped', 'done']);
    expect(t.engine.requests.some((q) => q.botId === other.id)).toBe(false);
    expect((await reports(own.id)).at(-1)?.text).toContain('Araştıran bot yok');
  });

  it('is not saved with a bot that is not there or is archived', async () => {
    const own = await t.bot();
    const other = await t.bot();
    const missing = await make(own.id, [{ id: 'a', kind: 'agent', prompt: 'iş', bot: 'yok' }]);
    expect(missing.status).toBe(400);
    await t.api('POST', `/api/bots/${other.id}/archive`);
    const archived = await make(own.id, [{ id: 'a', kind: 'agent', prompt: 'iş', bot: other.id }]);
    expect(archived.status).toBe(400);
  });

  it('names the bot that does the step on the card that sets it up', () => {
    const detail = describeAction(
      'mcp__leafbot__routine_create',
      {
        name: 'Araştırma',
        prompt: 'seç',
        schedule: { type: 'daily', time: '09:00' },
        steps: [{ kind: 'agent', prompt: 'araştır', by_bot: 'Ayşe' }],
      },
      { bot: 'Paşa', locale: 'tr' },
    ).detail;
    expect(detail).toContain('1. Ayşe: araştır');
  });
});
