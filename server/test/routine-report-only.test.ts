import type { Approval, Routine, RoutineRun, Thread } from '@leafbot/shared';
import { asc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';

describe('a routine that only tells', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  /** A step that changes something, one that only reads, and bookkeeping the bot keeps for itself. */
  const WRITE = '[izin:Write {"file_path":"a.txt"}] [izin:Read {"file_path":"a.txt"}]';
  const make = async (botId: string, prompt: string, extra: Record<string, unknown> = {}) => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Bakış',
      prompt,
      schedule: { type: 'interval', minutes: 30 },
      ...extra,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const run = async (id: string) => {
    await t.api('POST', `/api/routines/${id}/run`);
    await t.services.turns.idle();
  };
  const turns = async (botId: string) =>
    t.db.db
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.botId, botId))
      .orderBy(asc(schema.turns.createdAt));
  const lastText = async (threadId: string) => (await t.messages(threadId)).at(-1)!.text;

  it('holds every turn of the run to reading, even for a bot at full access; a write is refused, not asked', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const r = await make(bot.id, WRITE, { reportOnly: true });
    expect(r.reportOnly).toBe(true);
    await run(r.id);
    const [turn] = await turns(bot.id);
    expect(turn).toMatchObject({ source: 'routine', modeCap: 'readonly' });
    const report = await lastText((await main(bot.id)).id);
    expect(report).toContain('Write: reddedildi');
    expect(report).toContain('Read: izin verildi');
    // The bot is told why, so it reports instead of trying again.
    expect(report).toContain('yalnızca bakıp rapor ediyor');
    expect((await t.api<Approval[]>('GET', '/api/approvals')).body).toHaveLength(0);
    // It is told what it is, in the prompt of the run.
    expect(t.engine.requests.at(-1)!.prompt).toContain('Bu rutin yalnızca bakar ve rapor eder');
  });

  it("refuses a tool that needs no card at full access when it changes something, and keeps the bot's own notes", async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const r = await make(
      bot.id,
      '[araç:ticket_create {"title":"Siparişi düzelt"}] [araç:memory_write {"content":"Pazartesi siparişleri bakıldı","scope":"bot"}] [araç:routine_create {"name":"Yeni","prompt":"x","schedule":{"type":"daily","time":"09:00"}}]',
      { reportOnly: true },
    );
    await run(r.id);
    const report = await lastText((await main(bot.id)).id);
    expect(report).toMatch(/ticket_create: reddedildi/);
    expect(report).toMatch(/routine_create: reddedildi/);
    expect(report).toMatch(/memory_write: (?!reddedildi|araç yok|hata)/);
    expect(await t.services.routines.list(bot.id)).toHaveLength(1);
  });

  it('hands no work to another bot, whose answer would come back as an unheld turn of the run', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const peer = await t.bot({ permissionMode: 'readonly' });
    const ask = `[araç:bot_send {"bot":"${peer.name}","message":"Bak"}]`;
    await run((await make(bot.id, ask, { reportOnly: true })).id);
    expect(await lastText((await main(bot.id)).id)).toMatch(/bot_send: reddedildi/);
    // The same request in a routine that acts goes through.
    await run((await make(bot.id, ask, { name: 'Eylem' })).id);
    expect(await lastText((await main(bot.id)).id)).not.toMatch(/bot_send: reddedildi/);
  });

  it('a routine that acts is unaffected', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const r = await make(bot.id, WRITE);
    expect(r.reportOnly).toBe(false);
    await run(r.id);
    const [turn] = await turns(bot.id);
    expect(turn!.modeCap).toBeNull();
    const report = await lastText((await main(bot.id)).id);
    expect(report).toContain('Write: izin verildi');
    expect(t.engine.requests.at(-1)!.prompt).not.toContain('yalnızca bakar ve rapor eder');
  });

  it('keeps the hold on the later steps of a routine with steps', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const r = await make(bot.id, '[izin:Read {"file_path":"a.txt"}]', {
      reportOnly: true,
      inMain: false,
      steps: [
        { id: 'a', kind: 'agent', prompt: '[izin:Write {"file_path":"b.txt"}]' },
        { id: 'b', kind: 'agent', prompt: '[izin:Bash {"command":"touch c"}]' },
      ],
    });
    await run(r.id);
    const [done] = (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body;
    expect(done!.steps).toHaveLength(3);
    const mine = (await turns(bot.id)).filter((x) => x.routineRunId);
    expect(mine).toHaveLength(3);
    expect(mine.map((x) => x.modeCap)).toEqual(['readonly', 'readonly', 'readonly']);
    const prompts = t.engine.requests.map((q) => q.prompt);
    expect(prompts.filter((p) => p.includes('Bu rutin yalnızca bakar ve rapor eder'))).toHaveLength(3);
    const report = (await t.messages((await main(bot.id)).id)).find((m) => m.props.routineReport)!;
    expect(report.text).toContain('Bash: reddedildi');
  });

  it('turning the setting off lets the next run act again', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const r = await make(bot.id, WRITE, { reportOnly: true });
    await run(r.id);
    await t.api('PATCH', `/api/routines/${r.id}`, { reportOnly: false });
    t.now.value = new Date(t.now.value.getTime() + 1000);
    await run(r.id);
    const mine = (await turns(bot.id)).filter((x) => x.routineRunId);
    expect(mine.map((x) => x.modeCap)).toEqual(['readonly', null]);
  });

  it('a rehearsal of it is held to reading too', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const r = await make(bot.id, WRITE, { reportOnly: true });
    const started = await t.api('POST', `/api/routines/${r.id}/rehearse`, {});
    expect(started.status).toBe(200);
    await t.services.turns.idle();
    const [turn] = (await turns(bot.id)).filter((x) => x.rehearsalId);
    expect(turn!.modeCap).toBe('readonly');
  });

  describe('in the main conversation', () => {
    it("does not hold the person's next turn to reading", async () => {
      const bot = await t.bot({ permissionMode: 'auto' });
      const r = await make(bot.id, WRITE, { reportOnly: true });
      await run(r.id);
      const thread = await main(bot.id);
      // The run and the person's turn are in the same conversation.
      expect((await turns(bot.id))[0]!.threadId).toBe(thread.id);
      await t.send(thread.id, '[izin:Write {"file_path":"b.txt"}]');
      await t.services.turns.idle();
      const all = await turns(bot.id);
      expect(all.map((x) => [x.source, x.modeCap])).toEqual([
        ['routine', 'readonly'],
        ['user', null],
      ]);
      expect(await lastText(thread.id)).toContain('Write: izin verildi');
    });

    it("does not take the person's message into the running turn of the run", async () => {
      const bot = await t.bot({ permissionMode: 'auto' });
      const r = await make(bot.id, '[bekle:1500]', { reportOnly: true });
      await t.api('POST', `/api/routines/${r.id}/run`);
      const thread = await main(bot.id);
      await waitFor(async () => t.services.turns.isRunning(thread.id));
      const sent = await t.send(thread.id, 'Bir de şuna bak');
      const [queued] = await t.db.db.select().from(schema.turns).where(eq(schema.turns.id, sent.turnId!));
      expect(queued).toMatchObject({ source: 'user', status: 'queued', modeCap: null });
      expect(await t.services.turns.steer(thread.id, queued!.id, sent.id)).toBe(false);
      await t.services.turns.idle();
      const [, own] = await turns(bot.id);
      expect(own).toMatchObject({ source: 'user', modeCap: null });
    });
  });
});
