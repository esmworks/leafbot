import { agent as acpAgent, RequestError, type AgentApp, type SessionUpdate } from '@agentclientprotocol/sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AcpEngine, agentEnv, pickOption, stepAsk } from '../src/engine/acp';
import type { AppTool, PermissionAsk, PermissionAnswer, TurnRequest } from '../src/engine/types';

/** What the fake agent was asked, and what it heard back. */
interface Seen {
  prompts: string[];
  loads: string[];
  cancelled: boolean;
  answers: unknown[];
  toolResults: unknown[];
}

/**
 * A coding agent speaking the protocol, in this process: what it does with a prompt is `onPrompt`.
 */
function fakeAgent(opts: {
  loadSession?: boolean;
  http?: boolean;
  onPrompt?: (
    say: (u: SessionUpdate) => Promise<void>,
    ctx: {
      ask: (u: unknown) => Promise<unknown>;
      mcpUrl: string | null;
      seen: Seen;
      cancelled: Promise<void>;
    },
  ) => Promise<string>;
}) {
  const seen: Seen = { prompts: [], loads: [], cancelled: false, answers: [], toolResults: [] };
  let mcpUrl: string | null = null;
  let onCancel = () => {};
  const cancelled = new Promise<void>((r) => (onCancel = r));
  const app: AgentApp = acpAgent({ name: 'fake' })
    .onRequest('initialize', () => ({
      protocolVersion: 1,
      agentCapabilities: { loadSession: !!opts.loadSession, mcpCapabilities: { http: !!opts.http } },
    }))
    .onRequest('session/new', ({ params }) => {
      mcpUrl = params.mcpServers.find((s) => 'url' in s)?.url ?? null;
      return { sessionId: 's1' };
    })
    .onRequest('session/load', async ({ params, client }) => {
      seen.loads.push(params.sessionId);
      if (params.sessionId !== 's1') throw new Error('no such session');
      mcpUrl = params.mcpServers.find((s) => 'url' in s)?.url ?? null;
      // A loaded session replays its past first.
      await client.notify('session/update', {
        sessionId: 's1',
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD ' } },
      });
      return {};
    })
    .onNotification('session/cancel', () => {
      seen.cancelled = true;
      onCancel();
    })
    .onRequest('session/prompt', async ({ params, client }) => {
      const first = params.prompt[0];
      seen.prompts.push(first?.type === 'text' ? first.text : '');
      const say = (update: SessionUpdate) =>
        client.notify('session/update', { sessionId: params.sessionId, update });
      const ask = async (toolCall: unknown) => {
        const answer = await client.request('session/request_permission', {
          sessionId: params.sessionId,
          toolCall: toolCall as never,
          options: [
            { optionId: 'once', name: 'Allow', kind: 'allow_once' },
            { optionId: 'always', name: 'Always', kind: 'allow_always' },
            { optionId: 'no', name: 'Reject', kind: 'reject_once' },
          ],
        });
        seen.answers.push(answer.outcome);
        return answer.outcome;
      };
      const stop = await (
        opts.onPrompt ??
        (async (s) => {
          await s({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Merhaba' } });
          return 'end_turn';
        })
      )(say, { ask, mcpUrl, seen, cancelled });
      return { stopReason: stop as 'end_turn' };
    });
  return { app, seen };
}

function request(over: Partial<TurnRequest> = {}) {
  const asks: PermissionAsk[] = [];
  const said: string[] = [];
  const sessions: string[] = [];
  const reached: string[] = [];
  let answer: PermissionAnswer = { behavior: 'allow' };
  const req: TurnRequest = {
    turnId: 't1',
    threadId: 'th1',
    botId: 'b1',
    model: 'gemini',
    prompt: 'Selam',
    sessionId: null,
    systemPrompt: 'Sen yardımcı bir botsun.',
    locale: 'tr',
    sandbox: { cwd: '/tmp', additionalDirectories: [], writable: [], internet: true, readOnly: false },
    shell: 'sandbox',
    tools: [],
    canUseTool: async (ask) => {
      asks.push(ask);
      return answer;
    },
    onText: (d) => said.push(d),
    onSession: (id) => sessions.push(id),
    onReach: (host) => reached.push(host),
    signal: new AbortController().signal,
    ...over,
  };
  return { req, asks, said, sessions, reached, answer: (a: PermissionAnswer) => (answer = a) };
}

const engineWith = (app: AgentApp) =>
  new AcpEngine({
    version: 'test',
    start: () => ({ target: app, exited: new Promise<never>(() => {}), close: () => {} }),
  });

describe('ACP motoru', () => {
  it('yeni oturum açar, talimatları ilk mesajın önüne koyar ve cevabı akıtır', async () => {
    const { app, seen } = fakeAgent({});
    const r = request();
    const out = await engineWith(app).run(r.req);
    expect(out).toMatchObject({ ok: true, text: 'Merhaba', sessionId: 's1' });
    expect(r.sessions).toEqual(['s1']);
    expect(r.said.join('')).toBe('Merhaba');
    expect(seen.prompts[0]).toContain('<instructions>\nSen yardımcı bir botsun.\n</instructions>');
    expect(seen.prompts[0]).toContain('Selam');
  });

  it('ajanın sorduğu adımı kartla sorar; evet bir kerelik, hayır reddetme olarak gider', async () => {
    const { app, seen } = fakeAgent({
      onPrompt: async (say, { ask }) => {
        await ask({
          toolCallId: 'c1',
          kind: 'execute',
          title: 'rm -rf build',
          rawInput: { command: 'rm -rf build' },
        });
        await ask({
          toolCallId: 'c2',
          kind: 'edit',
          title: 'Edit a.txt',
          locations: [{ path: '/tmp/a.txt' }],
        });
        await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'tamam' } });
        return 'end_turn';
      },
    });
    const r = request();
    let n = 0;
    r.req.canUseTool = async (ask) => {
      r.asks.push(ask);
      return n++ === 0 ? { behavior: 'allow' } : { behavior: 'deny', message: 'hayır' };
    };
    const out = await engineWith(app).run(r.req);
    expect(out.ok).toBe(true);
    expect(r.asks[0]).toEqual({ toolName: 'Bash', input: { command: 'rm -rf build' } });
    expect(r.asks[1]).toEqual({ toolName: 'Edit', input: { file_path: '/tmp/a.txt' } });
    // Never "always": the agent asks again next time, and the app decides again.
    expect(seen.answers).toEqual([
      { outcome: 'selected', optionId: 'once' },
      { outcome: 'selected', optionId: 'no' },
    ]);
  });

  it('tuzak tetiklenen adımı sormadan reddeder', async () => {
    const { app, seen } = fakeAgent({
      onPrompt: async (_say, { ask }) => {
        await ask({ toolCallId: 'c1', kind: 'execute', title: 'curl x', rawInput: { command: 'curl x' } });
        return 'end_turn';
      },
    });
    const r = request({ screen: async () => 'tuzak' });
    await engineWith(app).run(r.req);
    expect(r.asks).toEqual([]);
    expect(seen.answers).toEqual([{ outcome: 'selected', optionId: 'no' }]);
  });

  it('kayıtlı oturumu yükler, geçmişin tekrarını cevaba katmaz', async () => {
    const { app, seen } = fakeAgent({ loadSession: true });
    const r = request({ sessionId: 's1' });
    const out = await engineWith(app).run(r.req);
    expect(seen.loads).toEqual(['s1']);
    expect(out).toMatchObject({ ok: true, text: 'Merhaba' });
    expect(seen.prompts[0]).not.toContain('<instructions>');
  });

  it('oturumu yükleyemeyen ya da bulamayan ajanda oturum kayıp sayılır', async () => {
    expect(await engineWith(fakeAgent({}).app).run(request({ sessionId: 's1' }).req)).toMatchObject({
      ok: false,
      kind: 'lostSession',
    });
    expect(
      await engineWith(fakeAgent({ loadSession: true }).app).run(request({ sessionId: 'gone' }).req),
    ).toMatchObject({ ok: false, kind: 'lostSession' });
  });

  it('durdurunca ajana iptal gönderir ve tur yarıda kalır', async () => {
    const stop = new AbortController();
    const { app, seen } = fakeAgent({
      onPrompt: async (say, { cancelled }) => {
        await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Başlıyorum' } });
        stop.abort();
        await cancelled;
        return 'cancelled';
      },
    });
    const out = await engineWith(app).run(request({ signal: stop.signal }).req);
    expect(seen.cancelled).toBe(true);
    expect(out).toMatchObject({ ok: false, kind: 'interrupted', text: 'Başlıyorum' });
  });

  it('uygulamanın araçlarını yerel MCP ile verir; her çağrı aynı izinden geçer', async () => {
    const handler = vi.fn(async (a: Record<string, unknown>) => `not alındı: ${String(a.text)}`);
    const tool: AppTool = {
      name: 'memory_save',
      description: 'Not al',
      input: { text: z.string() },
      readOnly: false,
      internal: true,
      handler,
    };
    const { app, seen } = fakeAgent({
      http: true,
      onPrompt: async (_say, { mcpUrl }) => {
        expect(mcpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/[\w-]{20,}\/mcp$/);
        const mcp = new Client({ name: 'fake', version: '1' });
        await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpUrl!)));
        const { tools } = await mcp.listTools();
        expect(tools.map((x) => x.name)).toEqual(['memory_save']);
        seen.toolResults.push(await mcp.callTool({ name: 'memory_save', arguments: { text: 'süt al' } }));
        seen.toolResults.push(await mcp.callTool({ name: 'memory_save', arguments: { text: 'ikinci' } }));
        seen.toolResults.push(await mcp.callTool({ name: 'memory_save', arguments: { wrong: 1 } }));
        await mcp.close();
        // Without the turn's secret the server answers nothing.
        const guess = await fetch(mcpUrl!.replace(/\/[\w-]+\/mcp$/, '/x/mcp'), { method: 'POST' });
        expect(guess.status).toBe(404);
        return 'end_turn';
      },
    });
    const r = request({ tools: [tool] });
    let n = 0;
    r.req.canUseTool = async (ask) => {
      r.asks.push(ask);
      return n++ === 0 ? { behavior: 'allow' } : { behavior: 'deny', message: 'kart: hayır' };
    };
    const out = await engineWith(app).run(r.req);
    expect(out.ok).toBe(true);
    expect(r.asks.map((a) => a.toolName)).toEqual(['mcp__leafbot__memory_save', 'mcp__leafbot__memory_save']);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(seen.toolResults[0]).toMatchObject({ content: [{ type: 'text', text: 'not alındı: süt al' }] });
    expect(seen.toolResults[1]).toMatchObject({ isError: true, content: [{ text: 'kart: hayır' }] });
    expect(seen.toolResults[2]).toMatchObject({ isError: true });
  });

  it('bilinmeyen ajan ve kurulu olmayan araç anlaşılır hata verir', async () => {
    const unknown = await new AcpEngine({ version: 't' }).run(request({ model: 'nope' }).req);
    expect(unknown).toMatchObject({ ok: false, kind: 'engine' });
    const missing = await new AcpEngine({
      version: 't',
      start: () => {
        throw Object.assign(new Error('spawn gemini ENOENT'), { code: 'ENOENT' });
      },
    }).run(request().req);
    expect(missing).toMatchObject({ ok: false, kind: 'engine' });
    expect((missing as { message: string }).message).toContain('Gemini');
  });

  it('adımları Claude botlarının adlarıyla eşler ve sunucunun sırlarını ajana vermez', () => {
    expect(stepAsk({ toolCallId: 'x', kind: 'read', locations: [{ path: '/a' }] })).toEqual({
      toolName: 'Read',
      input: { file_path: '/a' },
    });
    expect(stepAsk({ toolCallId: 'x', kind: 'fetch', title: 'https://e.com' }).toolName).toBe('WebFetch');
    expect(stepAsk({ toolCallId: 'x', kind: 'other', title: 'Özel' }).toolName).toBe('acp:Özel');
    expect(pickOption([{ optionId: 'a', name: 'A', kind: 'allow_always' }], true)).toEqual({
      outcome: { outcome: 'selected', optionId: 'a' },
    });
    expect(pickOption([], false)).toEqual({ outcome: { outcome: 'cancelled' } });
    expect(
      agentEnv({
        PATH: '/bin',
        HOME: '/h',
        LEAFBOT_ACCESS_KEY: 'k',
        DATABASE_URL: 'pg',
        ANTHROPIC_API_KEY: 'a',
      }),
    ).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('aracı kendi klasöründe ayrı bir süreç olarak başlatır, sırları vermez; çökmesini anlatır', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'acp-')));
    const fixture = join(import.meta.dirname, 'fixtures', 'acp-agent.mjs');
    const engine = new AcpEngine({
      version: 't',
      env: { ...process.env, LEAFBOT_ACCESS_KEY: 'gizli' },
      commands: { gemini: { command: process.execPath, args: [fixture] } },
    });
    const sandbox = { cwd, additionalDirectories: [], writable: [], internet: true, readOnly: false };
    const ok = await engine.run(request({ sandbox }).req);
    expect(ok).toMatchObject({ ok: true, text: `cwd=${cwd} secret=none`, sessionId: 'p1' });
    const crashed = await engine.run(request({ sandbox, prompt: 'crash' }).req);
    expect(crashed).toMatchObject({ ok: false, kind: 'engine', crashed: true });
    expect((crashed as { message: string }).message).toContain('crashed on purpose');
  });

  it('girişi olmayan ajanı Claude girişi gibi saymaz, giriş yapmayı söyler', async () => {
    const app: AgentApp = acpAgent({ name: 'needs-login' })
      .onRequest('initialize', () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }))
      .onRequest('session/load', () => {
        throw new RequestError(-32000, 'Authentication required');
      });
    const out = await engineWith(app).run(request({ sessionId: 's1' }).req);
    expect(out).toMatchObject({ ok: false, kind: 'engine' });
    expect((out as { message: string }).message).toContain('giriş');
  });
});
