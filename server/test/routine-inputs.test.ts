import type { Approval, Routine, RoutineRun } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';

describe("a routine's inputs", () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, body: object) => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Araştırma',
      schedule: { type: 'interval', minutes: 30 },
      inMain: false,
      ...body,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const asked = () => t.engine.requests.filter((q) => q.prompt.includes('Araştırma')).map((q) => q.prompt);

  it('puts the values typed for a run into its instruction and steps, and the usual ones otherwise', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, {
      prompt: 'Research {{topic}} for {{audience}}; keep {{other}} as written.',
      steps: [{ id: 'a', kind: 'agent', prompt: 'Write the report on {{topic}}.' }],
      inputs: { topic: 'solar panels', audience: 'the team' },
    });
    expect(r.inputs).toEqual({ topic: 'solar panels', audience: 'the team' });

    // Typed for this run: one of its inputs, and a name it has none for, which is left out.
    const typed = await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`, {
      inputs: { topic: 'heat pumps', stranger: 'ignored' },
    });
    expect(typed.status).toBe(200);
    await t.services.turns.idle();
    const [first, second] = asked();
    expect(first).toContain('Research heat pumps for the team; keep {{other}} as written.');
    expect(first).not.toContain('ignored');
    expect(second).toContain('Write the report on heat pumps.');
    // The conversation shows the instruction as the bot was given it.
    const run = (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body[0]!;
    const said = (await t.messages(run.threadId!)).map((m) => m.text);
    expect(said).toContain('Research heat pumps for the team; keep {{other}} as written.');

    // A run nobody typed values for takes the usual ones. A run now is told apart by its time.
    t.engine.requests.length = 0;
    t.now.value = new Date(t.now.value.getTime() + 60_000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect(asked()[0]).toContain('Research solar panels for the team');
  });

  it('turns away more inputs than a routine may have, and a value that is not text', async () => {
    const bot = await t.bot();
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`v${i}`, 'x']));
    const r = await t.api('POST', '/api/routines', {
      botId: bot.id,
      name: 'Çok',
      prompt: 'Do it.',
      schedule: { type: 'interval', minutes: 30 },
      inputs: many,
    });
    expect(r.status).toBe(400);
    const ok = await make(bot.id, { prompt: 'Do {{it}}.', inputs: { it: 'this' } });
    const bad = await t.api('POST', `/api/routines/${ok.id}/run`, { inputs: { it: 5 } });
    expect(bad.status).toBe(400);
  });

  it('asks an approval with the run’s values in its question', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, {
      prompt: 'Draft it.',
      steps: [{ id: 'ok', kind: 'approval', question: 'Send the {{topic}} report?', timeoutDays: 1 }],
      inputs: { topic: 'weekly' },
    });
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const run = (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body[0]!;
    const id = run.steps?.find((s) => s.approvalId)?.approvalId;
    const card = (await t.api<Approval>('GET', `/api/approvals/${id}`)).body;
    expect(card.summary).toBe('Send the weekly report?');
  });

  it('gives a run that waits its turn the usual values, as one started at once', async () => {
    t.dispose();
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const bot = await t.bot({ permissionMode: 'ask' });
    const { table } = await t.services.tables.define(bot.id, 'Decks', [{ name: 'Title', type: 'text' }]);
    const r = await make(bot.id, {
      prompt: 'Prepare the {{topic}} deck. [izin:Write {"file_path":"deck.txt"}]',
      schedule: { type: 'daily', time: '09:00' },
      tableTrigger: table.id,
      inputs: { topic: 'weekly' },
    });
    await t.api('POST', `/api/tables/${table.id}/rows`, { Title: 'First' });
    await waitFor(async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0]);
    await t.api('POST', `/api/tables/${table.id}/rows`, { Title: 'Second' });
    const kept = await t.db.db
      .select({ status: schema.routineRuns.status, inputs: schema.routineRuns.inputs })
      .from(schema.routineRuns)
      .where(eq(schema.routineRuns.routineId, r.id));
    expect(kept.map((k) => k.status).sort()).toEqual(['queued', 'running']);
    for (const k of kept) expect(k.inputs).toEqual({ topic: 'weekly' });
  });
});
