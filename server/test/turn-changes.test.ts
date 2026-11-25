import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Thread, TurnChanges, TurnLogEntry } from '@leafbot/shared';
import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { FILE_KEEP_MAX, CHANGE_KEEP_DAYS } from '../src/services/turn-changes';
import { OWNER_ID } from '../src/users';
import { workspacePaths } from '../src/workspace';
import { testServer, waitFor, type TestServer } from './helpers';

const ROUTINE = { name: 'Morning', prompt: 'Say good morning.', schedule: { type: 'daily', time: '08:00' } };

describe('taking back what one turn changed', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const say = async (threadId: string, text: string) => {
    await t.send(threadId, text);
    await t.services.turns.idle();
  };
  const lastTurn = async (threadId: string) => {
    const [turn] = await t.services.ctx.db
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.threadId, threadId))
      .orderBy(desc(schema.turns.createdAt))
      .limit(1);
    return turn!.id;
  };
  const preview = async (turnId: string) =>
    (await t.api<TurnChanges>('GET', `/api/turns/${turnId}/changes`)).body;
  const undo = (turnId: string) => t.api<TurnChanges>('POST', `/api/turns/${turnId}/undo`);
  /** A bot that works by itself, and where its files go. */
  const setup = async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const dir = workspacePaths(t.dataDir, bot.id, thread.id, bot.groupId).threadDir;
    return { bot, thread, dir };
  };
  const write = (file: string, content: string) =>
    `[dosya:Write ${JSON.stringify({ file_path: file, content })}]`;
  const edit = (file: string, from: string, to: string) =>
    `[dosya:Edit ${JSON.stringify({ file_path: file, old_string: from, new_string: to })}]`;

  it('puts a file back as it was before an edit', async () => {
    const { thread, dir } = await setup();
    const file = join(dir, 'notes.txt');
    await say(thread.id, write(file, 'one two'));
    await say(thread.id, edit(file, 'two', 'three'));
    expect(readFileSync(file, 'utf8')).toBe('one three');
    const turn = await lastTurn(thread.id);
    expect((await preview(turn)).items).toEqual([
      expect.objectContaining({ kind: 'file', op: 'update', label: 'notes.txt', outcome: null }),
    ]);
    const res = await undo(turn);
    expect(res.status).toBe(200);
    expect(res.body.items[0]!.outcome).toBe('restored');
    expect(readFileSync(file, 'utf8')).toBe('one two');
    // The result is said in the conversation.
    const said = (await t.messages(thread.id)).filter((m) => m.props.kind === 'turnUndo');
    expect(said).toHaveLength(1);
    expect(said[0]!.role).toBe('system');
    expect(said[0]!.text).toContain('notes.txt');
  });

  it('removes a file the turn created', async () => {
    const { thread, dir } = await setup();
    const file = join(dir, 'made', 'new.txt');
    await say(thread.id, write(file, 'hello'));
    expect(existsSync(file)).toBe(true);
    const res = await undo(await lastTurn(thread.id));
    expect(res.body.items[0]).toMatchObject({ kind: 'file', op: 'create', outcome: 'restored' });
    expect(existsSync(file)).toBe(false);
  });

  it('leaves a file that changed after the turn, and says so', async () => {
    const { thread, dir } = await setup();
    const file = join(dir, 'shared.txt');
    await say(thread.id, write(file, 'first'));
    const first = await lastTurn(thread.id);
    await say(thread.id, edit(file, 'first', 'second'));
    const res = await undo(first);
    expect(res.body.items[0]!.outcome).toBe('later');
    expect(readFileSync(file, 'utf8')).toBe('second');
    const said = (await t.messages(thread.id)).find((m) => m.props.kind === 'turnUndo')!;
    expect(said.text).toContain('shared.txt');
  });

  it('writes nothing for a file step that was refused', async () => {
    const bot = await t.bot({ permissionMode: 'readonly' });
    const thread = await main(bot.id);
    const dir = workspacePaths(t.dataDir, bot.id, thread.id, bot.groupId).threadDir;
    await say(thread.id, write(join(dir, 'no.txt'), 'x'));
    expect((await preview(await lastTurn(thread.id))).items).toEqual([]);
  });

  it('puts table rows back: added, changed and deleted', async () => {
    const { bot, thread } = await setup();
    const table = await t.services.tables.define(bot.id, 'Notes', [{ name: 'Title', type: 'text' }]);
    const rows = () => t.services.tables.rows(table.table.id);
    await say(thread.id, '[araç:table_add {"table":"Notes","rows":[{"Title":"a"},{"Title":"b"}]}]');
    const added = await lastTurn(thread.id);
    const [a, b] = await rows();
    await say(
      thread.id,
      `[araç:table_update ${JSON.stringify({ table: 'Notes', id: a!.id, values: { Title: 'a2' } })}]`,
    );
    const updated = await lastTurn(thread.id);
    await say(thread.id, `[araç:table_delete_rows ${JSON.stringify({ table: 'Notes', ids: [b!.id] })}]`);
    const deleted = await lastTurn(thread.id);
    expect((await rows()).map((r) => r.values.Title)).toEqual(['a2']);

    expect((await undo(deleted)).body.items[0]!.outcome).toBe('restored');
    expect((await rows()).map((r) => r.values.Title)).toEqual(['a2', 'b']);
    expect((await undo(updated)).body.items[0]!.outcome).toBe('restored');
    expect((await rows()).map((r) => r.values.Title)).toEqual(['a', 'b']);
    const res = await undo(added);
    expect(res.body.items.map((i) => i.outcome)).toEqual(['restored', 'restored']);
    expect(await rows()).toEqual([]);
  });

  it('leaves a table row the person changed since', async () => {
    const { bot, thread } = await setup();
    const table = await t.services.tables.define(bot.id, 'Notes', [{ name: 'Title', type: 'text' }]);
    await say(thread.id, '[araç:table_add {"table":"Notes","rows":[{"Title":"a"}]}]');
    const [row] = await t.services.tables.rows(table.table.id);
    await t.services.tables.updateRow(table.table.id, row!.id, { Title: 'by hand' });
    const res = await undo(await lastTurn(thread.id));
    expect(res.body.items[0]!.outcome).toBe('later');
    expect((await t.services.tables.rows(table.table.id)).map((r) => r.values.Title)).toEqual(['by hand']);
  });

  it('removes a routine the turn created', async () => {
    const { bot, thread } = await setup();
    await say(thread.id, `[araç:routine_create ${JSON.stringify(ROUTINE)}]`);
    expect(await t.services.routines.list(bot.id)).toHaveLength(1);
    const res = await undo(await lastTurn(thread.id));
    expect(res.body.items[0]).toMatchObject({ kind: 'routine', op: 'create', outcome: 'restored' });
    expect(await t.services.routines.list(bot.id)).toHaveLength(0);
  });

  it('puts a changed routine and a deleted one back, and leaves one changed since', async () => {
    const { bot, thread } = await setup();
    const made = await t.services.routines.create({
      botId: bot.id,
      name: 'Noon',
      prompt: 'Say hi.',
      // A routine of several steps, started by a reaction too: it comes back with all of it.
      steps: [{ id: 'tell', kind: 'notify', text: 'Done.', withBefore: true }],
      schedule: { type: 'daily', time: '12:00' },
      timezone: 'UTC',
      enabled: true,
      missed: 'run',
      carryReport: false,
      reportOnly: false,
      inMain: false,
      slackChannel: null,
      slackReaction: 'eyes',
      onStartup: false,
      watchUrl: null,
      check: null,
      webhookFilter: '',
      webhookPost: false,
      model: '',
      emailTrigger: false,
      emailFilter: '',
      whatsappGroup: null,
      whatsappPeople: false,
      tableTrigger: null,
      tableFilter: '',
      flowLayout: null,
      flowNotes: [{ id: 'why', x: 24, y: 400, w: 240, h: 160, text: 'Why it runs.', color: 'yellow' }],
      inputs: { topic: 'news' },
      condition: null,
    });
    await say(thread.id, `[araç:routine_update ${JSON.stringify({ routine: 'Noon', prompt: 'Say bye.' })}]`);
    const changed = await lastTurn(thread.id);
    expect((await undo(changed)).body.items[0]!.outcome).toBe('restored');
    expect((await t.services.routines.get(made.id)).prompt).toBe('Say hi.');

    await say(thread.id, `[araç:routine_delete ${JSON.stringify({ routine: 'Noon' })}]`);
    const deleted = await lastTurn(thread.id);
    expect(await t.services.routines.list(bot.id)).toHaveLength(0);
    expect((await undo(deleted)).body.items[0]!.outcome).toBe('restored');
    const [back] = await t.services.routines.list(bot.id);
    expect(back).toMatchObject({
      name: 'Noon',
      prompt: 'Say hi.',
      steps: [{ id: 'tell', kind: 'notify', text: 'Done.', withBefore: true }],
      slackReaction: 'eyes',
      flowNotes: [{ id: 'why', text: 'Why it runs.' }],
      inputs: { topic: 'news' },
    });

    await say(thread.id, `[araç:routine_update ${JSON.stringify({ routine: 'Noon', prompt: 'Say bye.' })}]`);
    const again = await lastTurn(thread.id);
    await t.services.routines.update(back!.id, { prompt: 'Edited by the person.' });
    expect((await undo(again)).body.items[0]!.outcome).toBe('later');
    expect((await t.services.routines.get(back!.id)).prompt).toBe('Edited by the person.');

    // A change to its steps alone since the turn is seen too.
    await say(thread.id, `[araç:routine_update ${JSON.stringify({ routine: 'Noon', prompt: 'Say bye.' })}]`);
    const stepsLater = await lastTurn(thread.id);
    await t.services.routines.update(back!.id, { steps: [] });
    expect((await undo(stepsLater)).body.items[0]!.outcome).toBe('later');
    expect((await t.services.routines.get(back!.id)).prompt).toBe('Say bye.');
  });

  it('puts a ticket and a skill back', async () => {
    const { bot, thread } = await setup();
    await say(thread.id, '[araç:ticket_create {"title":"Fix it"}]');
    expect(await t.services.tickets.list()).toHaveLength(1);
    expect((await undo(await lastTurn(thread.id))).body.items[0]!.outcome).toBe('restored');
    expect(await t.services.tickets.list()).toHaveLength(0);

    await say(thread.id, '[araç:skill_save {"name":"greet","description":"Greets","body":"Say hello."}]');
    expect((await t.services.skills.forBot(bot.id)).map((k) => k.name)).toEqual(['greet']);
    expect((await undo(await lastTurn(thread.id))).body.items[0]!.outcome).toBe('restored');
    expect(await t.services.skills.list()).toHaveLength(0);
  });

  it('deletes only finished tickets, and puts a deleted one back with its comments', async () => {
    const { thread } = await setup();
    const done = await t.services.tickets.create({ title: 'Shipped', description: 'all of it' });
    await t.services.tickets.comment(done.id, 'went out on Monday');
    await t.services.tickets.update(done.id, { status: 'done' });
    const open = await t.services.tickets.create({ title: 'Still going' });

    await say(thread.id, `[araç:ticket_delete ${JSON.stringify({ tickets: [done.number, open.number] })}]`);
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain(`#${done.number}`);
    expect(reply).toContain(`#${open.number} silinmedi`);
    expect((await t.services.tickets.list()).map((k) => k.title)).toEqual(['Still going']);

    const turn = await lastTurn(thread.id);
    expect((await preview(turn)).items).toEqual([
      expect.objectContaining({ kind: 'ticket', op: 'delete', label: `#${done.number} Shipped` }),
    ]);
    expect((await undo(turn)).body.items[0]!.outcome).toBe('restored');
    const back = await t.services.tickets.get(done.id);
    expect(back).toMatchObject({
      number: done.number,
      title: 'Shipped',
      status: 'done',
      description: 'all of it',
    });
    expect(back.comments.map((c) => c.text)).toEqual(['went out on Monday']);
  });

  it('leaves a deleted ticket gone when its number was given to another since', async () => {
    const { thread } = await setup();
    const done = await t.services.tickets.create({ title: 'Last one' });
    await t.services.tickets.update(done.id, { status: 'wont_do' });
    await say(thread.id, `[araç:ticket_delete ${JSON.stringify({ tickets: [done.number] })}]`);
    const turn = await lastTurn(thread.id);
    const next = await t.services.tickets.create({ title: 'New one' });
    expect(next.number).toBe(done.number);
    expect((await undo(turn)).body.items[0]!.outcome).toBe('later');
    expect((await t.services.tickets.list()).map((k) => k.title)).toEqual(['New one']);
  });

  it('puts a memory note back: written, changed and forgotten', async () => {
    const { thread } = await setup();
    await say(thread.id, '[araç:memory_write {"content":"Likes tea"}]');
    const [note] = await t.services.memory.list();
    expect(note!.content).toBe('Likes tea');

    await say(thread.id, `[araç:memory_update ${JSON.stringify({ id: note!.id, content: 'Likes coffee' })}]`);
    const changed = await lastTurn(thread.id);
    expect((await t.services.memory.get(note!.id)).content).toBe('Likes coffee');
    expect((await undo(changed)).body.items[0]!.outcome).toBe('restored');
    expect((await t.services.memory.get(note!.id)).content).toBe('Likes tea');

    // Forgotten on purpose: no words are kept, so the step is listed as not undoable.
    await say(thread.id, `[araç:memory_forget ${JSON.stringify({ id: note!.id })}]`);
    const forgot = await lastTurn(thread.id);
    expect(await t.services.memory.list()).toHaveLength(0);
    const view = await preview(forgot);
    expect(view.items).toEqual([expect.objectContaining({ kind: 'memory', reason: 'deleted', label: '' })]);
    const [line] = await t.services.ctx.db
      .select()
      .from(schema.turnChanges)
      .where(eq(schema.turnChanges.turnId, forgot));
    expect(JSON.stringify(line)).not.toContain('Likes tea');
    expect((await undo(forgot)).body.items[0]!.outcome).toBe('notUndoable');
    expect(await t.services.memory.list()).toHaveLength(0);
    // The earlier lines of the forgotten note lost their words too.
    const rows = await t.services.ctx.db.select().from(schema.turnChanges);
    expect(JSON.stringify(rows)).not.toMatch(/Likes (tea|coffee)/);
  });

  it('clears a note’s earlier words from the journal when the person deletes it in the app', async () => {
    const { thread } = await setup();
    await say(thread.id, '[araç:memory_write {"content":"Likes tea"}]');
    const [note] = await t.services.memory.list();
    await say(thread.id, `[araç:memory_update ${JSON.stringify({ id: note!.id, content: 'Likes coffee' })}]`);
    const before = await t.services.ctx.db.select().from(schema.turnChanges);
    expect(JSON.stringify(before)).toContain('Likes tea');
    expect((await t.api('DELETE', `/api/memory/${note!.id}`)).status).toBe(200);
    const rows = await t.services.ctx.db.select().from(schema.turnChanges);
    expect(JSON.stringify(rows)).not.toMatch(/Likes (tea|coffee)/);
  });

  it('lists the steps that went outside as not undoable', async () => {
    const { thread, dir } = await setup();
    const file = join(dir, 'out.txt');
    await say(thread.id, `${write(file, 'x')} [izin:Bash {"command":"curl https://example.com"}]`);
    const view = await preview(await lastTurn(thread.id));
    expect(view.items).toHaveLength(1);
    expect(view.outside).toHaveLength(1);
    expect(view.outside[0]!.summary).toContain('curl');
    const res = await undo(await lastTurn(thread.id));
    const said = (await t.messages(thread.id)).find((m) => m.props.kind === 'turnUndo')!;
    expect(res.body.outside).toHaveLength(1);
    expect(said.text).toContain('curl');
  });

  it('keeps an action log of the turns that changed or sent something, newest first', async () => {
    const { thread, dir } = await setup();
    await say(thread.id, write(join(dir, 'a.txt'), 'x'));
    const first = await lastTurn(thread.id);
    await say(thread.id, 'hello');
    await say(
      thread.id,
      `${write(join(dir, 'b.txt'), 'y')} [izin:Bash {"command":"curl https://example.com"}]`,
    );
    const second = await lastTurn(thread.id);
    expect((await undo(first)).status).toBe(200);
    const log = (await t.api<TurnLogEntry[]>('GET', `/api/threads/${thread.id}/action-log`)).body;
    // The turn that only said hello changed nothing and is left out.
    expect(log.map((e) => e.turnId)).toEqual([second, first]);
    expect(log[0]).toMatchObject({
      undone: false,
      items: [expect.objectContaining({ label: 'b.txt', outcome: null })],
      outside: [expect.objectContaining({ summary: expect.stringContaining('curl') })],
    });
    expect(log[0]!.request).toContain('b.txt');
    expect(log[1]).toMatchObject({ undone: true, items: [expect.objectContaining({ outcome: 'restored' })] });
    // Another person sees none of it.
    const other = await t.person('someone-else');
    const theirs = await other.api<TurnLogEntry[]>('GET', `/api/threads/${thread.id}/action-log`);
    expect(theirs.status >= 400 || theirs.body.length === 0).toBe(true);
  });

  it('does not offer a turn that changed nothing, and refuses another person', async () => {
    const { thread, dir } = await setup();
    await say(thread.id, 'hello');
    expect((await preview(await lastTurn(thread.id))).items).toEqual([]);
    await say(thread.id, write(join(dir, 'mine.txt'), 'x'));
    const turn = await lastTurn(thread.id);
    const other = await t.person('someone-else');
    const res = await other.api('POST', `/api/turns/${turn}/undo`);
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(dir, 'mine.txt'))).toBe(true);
    // Not even an admin who looks after the server may take someone else's turn back.
    const admin = await t.person('an-admin', 'admin');
    expect((await admin.api('POST', `/api/turns/${turn}/undo`)).status).toBeGreaterThanOrEqual(400);
    expect(existsSync(join(dir, 'mine.txt'))).toBe(true);
    expect(
      (await t.api<Record<string, number>>('GET', `/api/threads/${thread.id}/turn-changes`)).body,
    ).toEqual({
      [turn]: 1,
    });
  });

  it('refuses a turn that is still running', async () => {
    const { bot, thread } = await setup();
    await t.services.tables.define(bot.id, 'Notes', [{ name: 'Title', type: 'text' }]);
    await t.send(thread.id, '[araç:table_add {"table":"Notes","rows":[{"Title":"a"}]}] [bekle:1500]');
    const turn = await waitFor(async () => {
      const id = await lastTurn(thread.id).catch(() => null);
      return id && (await preview(id)).items.length ? id : null;
    });
    expect((await preview(turn)).running).toBe(true);
    const res = await undo(turn);
    expect(res.status).toBe(409);
    await t.services.turns.idle();
    expect((await undo(turn)).status).toBe(200);
  });

  it('refuses to take a turn back twice', async () => {
    const { thread, dir } = await setup();
    const file = join(dir, 'twice.txt');
    await say(thread.id, write(file, 'x'));
    const turn = await lastTurn(thread.id);
    expect((await undo(turn)).status).toBe(200);
    expect((await undo(turn)).status).toBe(409);
    expect((await preview(turn)).undone).toBe(true);
    expect(
      (await t.api<Record<string, number>>('GET', `/api/threads/${thread.id}/turn-changes`)).body,
    ).toEqual({});
  });

  it('lists a file too large to keep as one that cannot be put back', async () => {
    const { thread, dir } = await setup();
    const file = join(dir, 'big.txt');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `needle${'x'.repeat(FILE_KEEP_MAX + 10)}`);
    await say(thread.id, edit(file, 'needle', 'thread'));
    const turn = await lastTurn(thread.id);
    const view = await preview(turn);
    expect(view.items).toEqual([expect.objectContaining({ kind: 'file', reason: 'tooBig' })]);
    const res = await undo(turn);
    expect(res.body.items[0]!.outcome).toBe('notUndoable');
    expect(readFileSync(file, 'utf8').startsWith('thread')).toBe(true);
  });

  it('lets go of what is older than the keeping time', async () => {
    const { thread, dir } = await setup();
    await say(thread.id, write(join(dir, 'old.txt'), 'x'));
    const turn = await lastTurn(thread.id);
    const day = 86_400_000;
    await t.services.changes.prune(new Date(Date.now() + (CHANGE_KEEP_DAYS - 1) * day));
    expect(await t.services.changes.count([turn])).toBe(1);
    await t.services.changes.prune(new Date(Date.now() + (CHANGE_KEEP_DAYS + 1) * day));
    expect(await t.services.changes.count([turn])).toBe(0);
  });
  it('keeps no more than 20 MB of earlier files for one turn', async () => {
    const { thread, dir } = await setup();
    mkdirSync(dir, { recursive: true });
    const names = Array.from({ length: 11 }, (_, n) => join(dir, `big${n}.txt`));
    for (const file of names) writeFileSync(file, `needle${'x'.repeat(FILE_KEEP_MAX - 100)}`);
    await say(thread.id, names.map((f) => edit(f, 'needle', 'thread')).join(' '));
    const view = await preview(await lastTurn(thread.id));
    expect(view.items).toHaveLength(11);
    expect(view.items.filter((i) => i.reason === 'tooBig')).toHaveLength(1);
  });

  it('keeps a changed note too large to keep out of the journal text', async () => {
    const { bot, thread } = await setup();
    const turn = await t.services.ctx.db
      .insert(schema.turns)
      .values({
        id: 'turn-big',
        threadId: thread.id,
        botId: bot.id,
        source: 'user',
        status: 'done',
        prompt: 'x',
      })
      .returning();
    await t.services.changes.record(
      { turnId: turn[0]!.id, threadId: thread.id, botId: bot.id, userId: thread.userId! },
      {
        kind: 'memory',
        op: 'delete',
        targetId: 'n1',
        label: 'big',
        before: { content: 'x'.repeat(FILE_KEEP_MAX + 1) },
      },
    );
    const [row] = await t.services.ctx.db.select().from(schema.turnChanges);
    expect(row).toMatchObject({ reason: 'tooBig', before: null, bytes: 0 });
  });

  it('shows a turn only to the person whose turn it was, and leaves bot-level changes to the bot’s owner', async () => {
    const bot = await t.bot({ name: 'Shared', permissionMode: 'auto' });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
    const ayse = await t.person('ayse');
    const hers = (await ayse.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await ayse.api('POST', `/api/threads/${hers.id}/messages`, { clientId: 'c-ayse-1234', text: 'hi' });
    await t.services.turns.idle();
    const turn = await lastTurn(hers.id);
    await t.services.changes.record(
      { turnId: turn, threadId: hers.id, botId: bot.id, userId: 'ayse' },
      {
        kind: 'routine',
        op: 'create',
        targetId: 'r1',
        label: 'Daily',
        scopeBotId: bot.id,
        after: { sig: 'x' },
      },
    );
    // The owner of the server is not the person whose turn it was.
    await expect(t.services.changes.preview(turn, OWNER_ID)).rejects.toMatchObject({ status: 404 });
    await expect(
      t.services.changes.undo(turn, OWNER_ID, await t.services.settings.translator()),
    ).rejects.toMatchObject({
      status: 404,
    });
    const view = (await ayse.api<TurnChanges>('GET', `/api/turns/${turn}/changes`)).body;
    expect(view.items).toEqual([expect.objectContaining({ kind: 'routine', needsOwner: true })]);
    const res = await ayse.api<TurnChanges>('POST', `/api/turns/${turn}/undo`);
    expect(res.body.items[0]!.outcome).toBe('needsOwner');
  });
});
