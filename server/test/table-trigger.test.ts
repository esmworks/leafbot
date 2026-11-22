import type { Approval, Routine, RoutineRun, TableRow, Thread } from '@leafbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';

describe('a routine that starts on new table rows', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  const runs = async (routineId: string) =>
    (await t.api<RoutineRun[]>('GET', `/api/routines/${routineId}/runs`)).body;
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

  /** A bot with a work list and a routine that picks up its rows whose Status is todo. */
  const setUp = async (prompt = 'Prepare the deck for the new row.') => {
    t = await testServer({ unattendedApprovalMs: 5_000 });
    const bot = await t.bot({ permissionMode: 'ask' });
    const { table } = await t.services.tables.define(bot.id, 'Decks', [
      { name: 'Title', type: 'text' },
      { name: 'Status', type: 'text' },
    ]);
    const res = await t.api<Routine>('POST', '/api/routines', {
      botId: bot.id,
      name: 'Deck maker',
      prompt,
      schedule: { type: 'daily', time: '09:00' },
      tableTrigger: table.id,
      tableFilter: 'Status=todo',
    });
    expect(res.status).toBe(200);
    return { bot, table, routine: res.body };
  };
  const addRow = (tableId: string, values: Record<string, string>) =>
    t.api<TableRow>('POST', `/api/tables/${tableId}/rows`, values);

  it('runs once on a row the person adds that meets the filter, as their own words', async () => {
    const { table, routine } = await setUp();
    expect(routine.tableTrigger).toBe(table.id);
    expect((await addRow(table.id, { Title: 'Draft only', Status: 'later' })).status).toBe(200);
    const row = (await addRow(table.id, { Title: 'Q4 review', Status: 'todo' })).body;
    const done = await waitFor(async () => (await runs(routine.id))[0]);
    await t.services.turns.idle();
    expect(await runs(routine.id)).toHaveLength(1);
    expect(done.occurrence).toBe(`table:${row.id}`);
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt).toContain('Q4 review');
    expect(prompt).not.toContain('Draft only');
    // The person typed the row: the run is not marked as reading outside text.
    const [kept] = await t.db.db.select({ trigger: schema.routineRuns.trigger }).from(schema.routineRuns);
    expect(kept!.trigger).toBeNull();
  });

  it('runs once a row the app added empty is filled in, and not again when it changes later', async () => {
    const { table, routine } = await setUp();
    const row = (await addRow(table.id, {})).body;
    await t.api('PATCH', `/api/tables/${table.id}/rows/${row.id}`, { Title: 'Board update' });
    expect(await runs(routine.id)).toHaveLength(0);
    await t.api('PATCH', `/api/tables/${table.id}/rows/${row.id}`, { Status: 'todo' });
    await waitFor(async () => (await runs(routine.id))[0]);
    await t.api('PATCH', `/api/tables/${table.id}/rows/${row.id}`, { Title: 'Board update, v2' });
    await t.services.turns.idle();
    expect(await runs(routine.id)).toHaveLength(1);
    expect(t.engine.requests.at(-1)!.prompt).toContain('Board update');
  });

  it('reads a row the bot wrote as outside text when the person only hands it over', async () => {
    const { bot, table, routine } = await setUp();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(
      thread.id,
      '[araç:table_add {"table":"Decks","rows":[{"Title":"From a mail","Status":"later"}]}]',
    );
    await t.services.turns.idle();
    const [row] = await t.services.tables.rows(table.id);
    await t.api('PATCH', `/api/tables/${table.id}/rows/${row!.id}`, { Status: 'todo' });
    await waitFor(async () => (await runs(routine.id))[0]);
    await t.services.turns.idle();
    // The title came from the bot, maybe from a mail: the run changes nothing without a card.
    const [kept] = await t.db.db.select({ trigger: schema.routineRuns.trigger }).from(schema.routineRuns);
    expect(kept!.trigger).toBe('stored');
  });

  it('refuses a filter on a column the table does not have, as written', async () => {
    const { table, routine } = await setUp();
    const res = await t.api<{ error: string }>('PATCH', `/api/routines/${routine.id}`, {
      tableFilter: 'status=todo',
    });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('Status');
    expect(
      (
        await t.api('PATCH', `/api/routines/${routine.id}`, {
          tableTrigger: table.id,
          tableFilter: 'Status!=done',
        })
      ).status,
    ).toBe(200);
  });

  it('does not run on a row the bot writes, so a run that fills the table cannot start itself', async () => {
    const { bot, table, routine } = await setUp();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, '[araç:table_add {"table":"Decks","rows":[{"Title":"Loop","Status":"todo"}]}]');
    await t.services.turns.idle();
    expect((await t.services.tables.rows(table.id)).map((r) => r.values.Title)).toEqual(['Loop']);
    expect(await runs(routine.id)).toHaveLength(0);
  });

  it('does not run on a row someone else adds, since the run works with its own person’s things', async () => {
    const { bot, table, routine } = await setUp();
    const ayse = await t.person('ayse');
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'none', people: { ayse: 'edit' } });
    expect(
      (await ayse.api('POST', `/api/tables/${table.id}/rows`, { Title: 'Hers', Status: 'todo' })).status,
    ).toBe(200);
    await t.services.turns.idle();
    expect(await runs(routine.id)).toHaveLength(0);
  });

  it('keeps a row added while a run is busy and runs it once that run ends', async () => {
    const { table, routine } = await setUp('Prepare the deck. [izin:Write {"file_path":"deck.txt"}]');
    await addRow(table.id, { Title: 'First', Status: 'todo' });
    const card = await waitFor(async () => (await pending())[0]);
    await addRow(table.id, { Title: 'Second', Status: 'todo' });
    expect((await runs(routine.id)).map((r) => r.status).sort()).toEqual(['queued', 'running']);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    const next = await waitFor(async () => (await pending()).find((a) => a.id !== card.id));
    await t.api('POST', `/api/approvals/${next.id}`, { decision: 'deny' });
    await t.services.turns.idle();
    expect((await runs(routine.id)).map((r) => r.status)).toEqual(['done', 'done']);
    expect(t.engine.requests.some((r) => r.prompt.includes('Second'))).toBe(true);
  });

  it('refuses a table of another bot', async () => {
    const { routine } = await setUp();
    const other = await t.bot({ name: 'Other' });
    const { table } = await t.services.tables.define(other.id, 'Theirs', [{ name: 'Title', type: 'text' }]);
    const res = await t.api('PATCH', `/api/routines/${routine.id}`, { tableTrigger: table.id });
    expect(res.status).toBe(400);
  });

  it('lets go of the trigger when the person deletes the table', async () => {
    const { table, routine } = await setUp();
    await t.api('DELETE', `/api/tables/${table.id}`);
    expect((await t.services.routines.get(routine.id)).tableTrigger).toBeNull();
  });
});
