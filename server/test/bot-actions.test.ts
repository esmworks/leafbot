import type { Approval, BotAction, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH, testServer, waitFor, type TestServer } from './helpers';

const ROUTINE = { name: 'Morning', prompt: 'Say good morning.', schedule: { type: 'daily', time: '08:00' } };
const create = (name = 'Morning') => `[araç:routine_create ${JSON.stringify({ ...ROUTINE, name })}]`;

describe("a bot's list of what it changed", () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const actions = async (botId: string) =>
    (await t.api<BotAction[]>('GET', `/api/bots/${botId}/actions`)).body;
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

  it('keeps a step the bot took by its own level', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, create());
    await t.services.turns.idle();
    const list = await actions(bot.id);
    expect(list).toEqual([
      expect.objectContaining({
        how: 'level',
        toolName: 'mcp__leafbot__routine_create',
        threadId: thread.id,
      }),
    ]);
    expect(list[0]!.summary).not.toBe('');
  });

  it('lists its steps as CSV marked as UTF-8, so a spreadsheet reads İ, ğ and ş as they are', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    await t.send((await main(bot.id)).id, create('Günaydın'));
    await t.services.turns.idle();
    const res = await t.app.inject({ method: 'GET', url: `/api/bots/${bot.id}/actions.csv`, headers: AUTH });
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.body.startsWith('\uFEFF')).toBe(true);
    expect(res.body.slice(1).split('\n')[0]).toBe(
      'at,step,tool,let_through_by,rule,outside_text,approved_by',
    );
    expect(res.body).toContain('mcp__leafbot__routine_create');
  });

  it('keeps a step the person allowed on a card, and leaves out one they refused', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, create());
    const card = await waitFor(async () => (await pending())[0]);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
    expect(await actions(bot.id)).toEqual([]);

    await t.send(thread.id, create('Noon'));
    const next = await waitFor(async () => (await pending())[0]);
    await t.api('POST', `/api/approvals/${next.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect(await actions(bot.id)).toEqual([expect.objectContaining({ how: 'card' })]);
  });

  it('names the rule that let a step through', async () => {
    const bot = await t.bot();
    await t.api('POST', '/api/rules', {
      list: 'allow',
      pattern: 'mcp__leafbot__routine_create',
      botId: bot.id,
    });
    const thread = await main(bot.id);
    await t.send(thread.id, create());
    await t.services.turns.idle();
    expect(await actions(bot.id)).toEqual([
      expect.objectContaining({ how: 'rule', rule: 'mcp__leafbot__routine_create' }),
    ]);
  });

  it('keeps no line for a read', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, `[araç:memory_search ${JSON.stringify({ query: 'anything' })}]`);
    await t.services.turns.idle();
    expect(await actions(bot.id)).toEqual([]);
  });

  it('lets go of lines older than the keeping time', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, create());
    await t.services.turns.idle();
    await t.services.actions.prune(new Date(Date.now() + 80 * 86_400_000));
    expect(await actions(bot.id)).toHaveLength(1);
    await t.services.actions.prune(new Date(Date.now() + 100 * 86_400_000));
    expect(await actions(bot.id)).toEqual([]);
  });
});
