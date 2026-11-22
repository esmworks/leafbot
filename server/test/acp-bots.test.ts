import type { AcpAgentState, Bot, Message, Routine, Thread } from '@leafbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('kodlama ajanıyla çalışan botlar', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const last = async (threadId: string) =>
    (await t.api<Message[]>('GET', `/api/threads/${threadId}/messages`)).body.at(-1)!;

  it('sunucu sahibin bilgisayarında değilse ajan seçilemez ve listelenmez', async () => {
    t = await testServer({ onUserComputer: false });
    expect((await t.api<AcpAgentState[]>('GET', '/api/acp-agents')).body).toEqual([]);
    const r = await t.api('POST', '/api/bots', { name: 'Gemini', engine: 'acp', model: 'gemini' });
    expect(r.status).toBe(400);
  });

  it('yalnızca sahip, yalnızca bilinen bir ajana geçirir', async () => {
    t = await testServer({ onUserComputer: true });
    const agents = (await t.api<AcpAgentState[]>('GET', '/api/acp-agents')).body;
    expect(agents.map((a) => a.id)).toEqual(['gemini', 'codex', 'opencode', 'kimi']);
    expect((await t.api('POST', '/api/bots', { name: 'X', engine: 'acp', model: 'nope' })).status).toBe(400);
    const bot = await t.bot({ engine: 'acp', model: 'gemini' });
    expect(bot.engine).toBe('acp');

    const member = await t.person('ayse');
    const other = await t.bot();
    await t.api('PUT', `/api/bots/${other.id}/access`, { everyone: 'edit', people: {} });
    expect(
      (await member.api('PATCH', `/api/bots/${other.id}`, { engine: 'acp', model: 'gemini' })).status,
    ).toBe(403);
    expect(
      (await member.api('POST', '/api/bots', { name: 'Y', engine: 'acp', model: 'gemini' })).status,
    ).toBe(403);
    // The access list is the owner's alone.
    expect((await member.api('GET', '/api/acp-agents')).status).toBe(403);
  });

  it('sahibin kendi mesajını yürütür; rutini nedenini söyleyerek reddeder', async () => {
    t = await testServer({ onUserComputer: true });
    const bot = await t.bot({ engine: 'acp', model: 'gemini', permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(t.engine.requests).toHaveLength(1);
    expect(t.engine.requests[0]!.model).toBe('gemini');

    const routine = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Gece',
        prompt: 'raporla',
        schedule: { type: 'weekly', days: [0], time: '18:00' },
      })
    ).body;
    await t.api('POST', `/api/routines/${routine.id}/run`);
    await t.services.turns.idle();
    // The routine's run never reached the agent.
    expect(t.engine.requests).toHaveLength(1);
    const runs = (await t.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body.filter(
      (x) => x.kind === 'routine',
    );
    expect(runs.length).toBeGreaterThan(0);
    expect((await last(runs[0]!.id)).text).toContain('yalnızca sunucunun sahibinin kendi mesajlarını');
  });

  it('yöneticinin aracıyla bir bot ajana geçirilemez', async () => {
    t = await testServer({ onUserComputer: true });
    const manager = await t.bot({ isManager: true, permissionMode: 'auto' });
    const worker = await t.bot();
    const thread = await main(manager.id);
    await t.send(thread.id, `[araç:bot_update {"bot":"${worker.id}","engine":"acp","model":"gemini"}]`);
    await t.services.turns.idle();
    expect((await t.api<Bot>('GET', `/api/bots/${worker.id}`)).body.engine).toBe('claude');
  });
});
