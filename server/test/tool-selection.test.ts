import type { Bot, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('botun araç seçimi', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;

  it('yalnız seçilen araçlar modele gider; dışarıda kalan araç çağrılırsa çalışmaz', async () => {
    const bot = await t.bot({
      toolSelection: {
        only: true,
        allow: ['mcp__leafbot__memory_*', 'Read'],
        exclude: ['mcp__leafbot__memory_forget'],
      },
    });
    expect(bot.toolSelection.allow).toEqual(['mcp__leafbot__memory_*', 'Read']);
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    const req = t.engine.requests.at(-1)!;
    expect(req.tools.map((x) => x.name).sort()).toEqual([
      'memory_flag',
      'memory_search',
      'memory_update',
      'memory_write',
    ]);
    // The engine's own tools are narrowed by name too.
    expect(req.pickTool?.('Read')).toBe(true);
    expect(req.pickTool?.('Bash')).toBe(false);
    expect(await req.canUseTool({ toolName: 'Bash', input: { command: 'ls' } })).toMatchObject({
      behavior: 'deny',
    });
  });

  it('seçimi olmayan bot bütün araçlarını alır; seçim değiştirilip geri alınabilir', async () => {
    const bot = await t.bot();
    expect(bot.toolSelection).toEqual({ only: false, allow: [], exclude: [] });
    const thread = await main(bot.id);
    await t.send(thread.id, 'x');
    await t.services.turns.idle();
    const all = t.engine.requests.at(-1)!;
    expect(all.pickTool).toBeUndefined();
    expect(all.tools.some((x) => x.name === 'send_file')).toBe(true);

    const patched = await t.api<Bot>('PATCH', `/api/bots/${bot.id}`, {
      toolSelection: { only: false, allow: [], exclude: ['mcp__leafbot__send_file'] },
    });
    expect(patched.status).toBe(200);
    await t.send(thread.id, 'y');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.tools.some((x) => x.name === 'send_file')).toBe(false);
    expect(t.engine.requests.at(-1)!.systemPrompt).toContain('conversations_search');

    // Without the tool to look earlier talk up, the prompt does not point to it.
    await t.api('PATCH', `/api/bots/${bot.id}`, {
      toolSelection: { only: false, allow: [], exclude: ['mcp__leafbot__conversations_search'] },
    });
    await t.send(thread.id, 'z');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.systemPrompt).not.toContain('conversations_search');
    expect((await t.api('PATCH', `/api/bots/${bot.id}`, { toolSelection: { allow: ['a*b'] } })).status).toBe(
      400,
    );
  });
});
