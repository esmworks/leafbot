import { personJobOf, type Approval, type Bot, type Message, type Thread } from '@leafbot/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { managerMayNotAnswer } from '../src/services/approvals';
import { OWNER_ID } from '../src/users';
import { testServer, waitFor, type Person, type TestServer } from './helpers';

/** Stands in for a desktop app with "Bots may run commands" on: answers as it would, keeps the requests. */
class FakeDesktop {
  sent: Record<string, unknown>[] = [];
  /** What a run answers: ended at once by default. */
  run: Record<string, unknown> = { ok: true, running: false, exitCode: 0, output: 'ok\n', truncated: false };
  async handle(req: Record<string, unknown>): Promise<unknown> {
    this.sent.push(req);
    if (req.op === 'where') {
      const cwd = String(req.cwd);
      return { ok: true, cwd: cwd === '~' ? '/Users/ayse' : cwd.replace(/^~/, '/Users/ayse'), secret: null };
    }
    if (req.op === 'run') return { cwd: req.cwd, ...this.run };
    if (req.op === 'stop') return { ok: true, stopped: true };
    return { ok: true };
  }
  ops() {
    return this.sent.map((r) => r.op);
  }
}

describe('commands on the person’s own computer', () => {
  let t: TestServer;
  let desk: FakeDesktop;
  let ayse: Person;
  let bot: Bot;
  beforeEach(async () => {
    t = await testServer();
    desk = new FakeDesktop();
    t.services.ctx.macs!.attach(async (_socketId, req) => desk.handle(req));
    ayse = await t.person('ayse');
    // Free to act alone at its level: the command still asks.
    bot = await t.bot({ name: 'Kurucu', permissionMode: 'auto' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'edit', people: {} });
    await t.api('PATCH', `/api/bots/${bot.id}`, { personComputer: true });
  });
  afterEach(() => t.dispose());

  const toolNames = () => t.engine.requests.at(-1)!.tools.map((x) => x.name);
  const thread = async (who: { api: TestServer['api'] }) =>
    (await who.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
  const sendAs = async (who: Person, threadId: string, text: string) => {
    const r = await who.api('POST', `/api/threads/${threadId}/messages`, {
      clientId: `c-${Math.random()}`,
      text,
    });
    expect(r.status).toBeLessThan(300);
  };
  const pending = async () => (await ayse.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
  const run = (input: Record<string, unknown>) => `[araç:person_command_run ${JSON.stringify(input)}]`;
  const said = (threadId: string, text: string) =>
    waitFor(async () => {
      const last = (await messages(threadId)).filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
      return last.includes(text) ? last : null;
    });
  const jobCard = async (threadId: string) =>
    waitFor(async () =>
      (await messages(threadId)).map((m: Message) => personJobOf(m.props ?? {})).find(Boolean),
    );
  const jobs = () => t.db.db.select().from(schema.personJobs);
  /** The conversation as Ayşe sees it: hers, not the owner's to read. */
  const messages = async (threadId: string) =>
    (await ayse.api<Message[]>('GET', `/api/threads/${threadId}/messages`)).body;

  it('offers the tools only when the person’s computer lets bots run commands', async () => {
    const mine = await thread(ayse);
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i');
    await sendAs(ayse, mine.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames()).not.toContain('person_command_run');
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i', true);
    await sendAs(ayse, mine.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames()).toContain('person_command_run');
    // Not in someone else's conversation, nor for the owner, whose computer is not connected.
    await t.send((await thread(t)).id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames()).not.toContain('person_command_run');
  });

  it('asks on a card at every level, with the folder the computer resolved, and runs on a yes', async () => {
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i', true);
    const mine = await thread(ayse);
    await sendAs(ayse, mine.id, run({ command: 'npm test', cwd: '~/shop' }));
    const card = await waitFor(async () => (await pending())[0]);
    expect(card).toMatchObject({
      toolName: 'person_command_run',
      input: { command: 'npm test', cwd: '/Users/ayse/shop' },
    });
    // Only the folder was looked up: nothing ran before the yes.
    expect(desk.ops()).toEqual(['where']);
    await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    expect(await said(mine.id, 'çıkış kodu 0')).toContain('ok');
    expect(desk.sent.at(-1)).toMatchObject({
      op: 'run',
      command: 'npm test',
      cwd: '/Users/ayse/shop',
      bot: 'Kurucu',
    });
    expect(await jobCard(mine.id)).toMatchObject({ status: 'done', exitCode: 0, cwd: '/Users/ayse/shop' });
    // Its output is outside text: the turn reads as such from then on.
    const turns = await t.db.db.select().from(schema.turns).where(eq(schema.turns.threadId, mine.id));
    expect(turns.some((x) => x.outside === 'web')).toBe(true);
  });

  it('remembers "always allow" as this command in this folder for this person only', async () => {
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i', true);
    const mine = await thread(ayse);
    await sendAs(ayse, mine.id, run({ command: 'npm test', cwd: '~/shop' }));
    const card = await waitFor(async () => (await pending())[0]);
    await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', remember: true });
    await said(mine.id, 'çıkış kodu 0');
    const rules = await t.db.db
      .select()
      .from(schema.permissionRules)
      .where(eq(schema.permissionRules.botId, bot.id));
    expect(rules).toEqual([
      expect.objectContaining({
        list: 'allow',
        userId: 'ayse',
        pattern: 'person_command_run(npm test @ /Users/ayse/shop)',
      }),
    ]);
    // Not full access: the bot's level is as it was.
    expect((await t.api<Bot>('GET', `/api/bots/${bot.id}`)).body.permissionMode).toBe('auto');

    // The same command in the same folder runs without a card, even in this conversation, which
    // has read the first command's output; another folder asks.
    await sendAs(ayse, mine.id, run({ command: 'npm test', cwd: '/Users/ayse/shop' }));
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    expect(desk.ops().filter((o) => o === 'run')).toHaveLength(2);
    await sendAs(ayse, mine.id, run({ command: 'npm test', cwd: '~/other' }));
    const again = await waitFor(async () => (await pending())[0]);
    await ayse.api('POST', `/api/approvals/${again.id}`, { decision: 'deny' });
    await t.services.turns.idle();

    // The owner's own computer, same bot, same command and folder: their card, not Ayşe's rule.
    t.services.ctx.macs!.offer('s2', OWNER_ID, 'Sahip', true);
    desk.sent = [];
    await t.send((await thread(t)).id, run({ command: 'npm test', cwd: '/Users/ayse/shop' }));
    const owners = await waitFor(async () =>
      (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body.find(
        (a) => a.toolName === 'person_command_run',
      ),
    );
    expect(owners).toBeDefined();
    expect(desk.ops()).toEqual(['where']);
  });

  it('asks each time for a place keys are kept, and keeps no rule for it', async () => {
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i', true);
    const mine = await thread(ayse);
    await sendAs(ayse, mine.id, run({ command: 'cat ~/.ssh/config' }));
    const card = await waitFor(async () => (await pending())[0]);
    const line = (await messages(mine.id)).find((m) => m.props?.approvalId === card.id);
    expect(line?.props).toMatchObject({ noAlways: true });
    await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', remember: true });
    await said(mine.id, 'çıkış kodu 0');
    expect(await t.db.db.select().from(schema.permissionRules)).toEqual([]);
  });

  it('refuses a command no level lets through, without asking or running', async () => {
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i', true);
    const mine = await thread(ayse);
    await sendAs(ayse, mine.id, run({ command: 'rm -rf /' }));
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    expect(desk.sent).toEqual([]);
  });

  it('goes on in the background, wakes the bot once when it ends, and hears only its owner', async () => {
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i', true);
    desk.run = { ok: true, running: true, exitCode: null, output: 'derleniyor\n' };
    const mine = await thread(ayse);
    await sendAs(ayse, mine.id, run({ command: 'npm run build', cwd: '~/shop', wait_seconds: 1 }));
    const card = await waitFor(async () => (await pending())[0]);
    await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await said(mine.id, 'arka planda sürüyor');
    const [job] = await jobs();
    expect(job).toMatchObject({ status: 'running', wake: true, userId: 'ayse' });

    // Someone else's computer cannot tell this job's end.
    await t.services.personJobs.onEvent(OWNER_ID, {
      id: job!.id,
      running: false,
      tail: 'sahte',
      exitCode: 0,
    });
    expect((await jobs())[0]!.status).toBe('running');

    const end = { id: job!.id, running: false, tail: '\u001b[32mbitti\u001b[0m', exitCode: 0 };
    await t.services.personJobs.onEvent('ayse', end);
    await t.services.personJobs.onEvent('ayse', end);
    expect((await jobs())[0]).toMatchObject({ status: 'done', exitCode: 0, tail: 'bitti' });
    await t.services.turns.idle();
    const wakes = await t.db.db
      .select()
      .from(schema.turns)
      .where(and(eq(schema.turns.threadId, mine.id), eq(schema.turns.source, 'followup')));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]!.outside).toBe('web');
    expect(await jobCard(mine.id)).toMatchObject({ status: 'done', tail: 'bitti' });
  });

  it('closes as lost what the computer no longer runs, and stops only the person’s own job', async () => {
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i', true);
    desk.run = { ok: true, running: true, exitCode: null, output: '' };
    const mine = await thread(ayse);
    await sendAs(ayse, mine.id, run({ command: 'sleep 100', wait_seconds: 0 }));
    const card = await waitFor(async () => (await pending())[0]);
    await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await said(mine.id, 'arka planda sürüyor');
    const [job] = await jobs();

    expect((await t.api<{ stopped: boolean }>('POST', `/api/person-jobs/${job!.id}/stop`)).body.stopped).toBe(
      false,
    );
    expect(desk.ops()).not.toContain('stop');
    expect(
      (await ayse.api<{ stopped: boolean }>('POST', `/api/person-jobs/${job!.id}/stop`)).body.stopped,
    ).toBe(true);
    expect(desk.sent.at(-1)).toEqual({ op: 'stop', id: job!.id });

    // The computer came back without it: it ended while nobody heard.
    await t.services.personJobs.onSnapshot('ayse', 'Ayşe’nin Mac’i', { running: [] });
    expect((await jobs())[0]!.status).toBe('lost');
  });

  it('offers "always allow" for a new command after the conversation read a command’s output', async () => {
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i', true);
    const mine = await thread(ayse);
    await sendAs(ayse, mine.id, run({ command: 'ls', cwd: '~/shop' }));
    const first = await waitFor(async () => (await pending())[0]);
    await ayse.api('POST', `/api/approvals/${first.id}`, { decision: 'allow' });
    await said(mine.id, 'çıkış kodu 0');

    await sendAs(ayse, mine.id, run({ command: 'git status', cwd: '~/shop' }));
    const card = await waitFor(async () => (await pending())[0]);
    const line = (await messages(mine.id)).find((m) => m.props?.approvalId === card.id);
    expect(line?.props?.noAlways).toBeUndefined();
    await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', remember: true });
    await t.services.turns.idle();
    const rules = await t.db.db.select().from(schema.permissionRules);
    expect(rules.map((r) => r.pattern)).toEqual(['person_command_run(git status @ /Users/ayse/shop)']);
  });

  it('shows a command the computer would not start as not run, and wakes nothing for it', async () => {
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i', true);
    desk.run = { ok: false, error: 'refused' };
    const mine = await thread(ayse);
    await sendAs(ayse, mine.id, run({ command: 'make deploy' }));
    const card = await waitFor(async () => (await pending())[0]);
    await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect((await jobs())[0]).toMatchObject({ status: 'refused', wake: false });
    expect(await jobCard(mine.id)).toMatchObject({ status: 'refused' });
  });

  it('keeps a job open when the computer does not answer, and wakes the bot when it tells the end', async () => {
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i', true);
    const handle = desk.handle.bind(desk);
    desk.handle = async (req) => {
      if (req.op === 'run') throw new Error('gone');
      return handle(req);
    };
    const mine = await thread(ayse);
    await sendAs(ayse, mine.id, run({ command: 'npm run build' }));
    const card = await waitFor(async () => (await pending())[0]);
    await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await said(mine.id, 'yanıt vermedi');
    const [job] = await jobs();
    expect(job).toMatchObject({ status: 'running', wake: true });

    await t.services.personJobs.onEvent('ayse', { id: job!.id, running: false, tail: 'bitti', exitCode: 0 });
    await t.services.turns.idle();
    const wakes = await t.db.db
      .select()
      .from(schema.turns)
      .where(and(eq(schema.turns.threadId, mine.id), eq(schema.turns.source, 'followup')));
    expect(wakes).toHaveLength(1);
  });

  it('counts a stop as done only when a computer stopped the job', async () => {
    t.services.ctx.macs!.offer('s1', 'ayse', 'Ayşe’nin Mac’i', true);
    desk.run = { ok: true, running: true, exitCode: null, output: '' };
    const handle = desk.handle.bind(desk);
    desk.handle = async (req) => (req.op === 'stop' ? { ok: true, stopped: false } : handle(req));
    const mine = await thread(ayse);
    await sendAs(ayse, mine.id, run({ command: 'sleep 100', wait_seconds: 0 }));
    const card = await waitFor(async () => (await pending())[0]);
    await ayse.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await said(mine.id, 'arka planda sürüyor');
    const [job] = await jobs();
    expect(await t.services.personJobs.stop(job!.id, 'ayse')).toBe(true);
    expect((await jobs())[0]!.status).toBe('lost');
  });

  it('keeps a command card with the person, out of a manager’s reach', () => {
    const card = {
      kind: 'tool',
      toolName: 'person_command_run',
      input: {},
      options: [],
      summary: '',
      botId: 'w',
    };
    expect(managerMayNotAnswer(card as unknown as Approval, {}, 'm')).toBe('cards.keep.device');
  });
});
