import type { Approval, Message, Thread } from '@leafbot/shared';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpEngine } from '../src/engine/acp';
import { fakeAgent } from './fixtures/fake-acp-agent';
import { testServer, waitFor, type TestServer } from './helpers';

/** A server whose bots run on the given in-process agent through the real coding-agent engine. */
const serverWith = (app: ReturnType<typeof fakeAgent>['app']) =>
  testServer(
    { onUserComputer: true },
    {
      engine: new AcpEngine({
        version: 't',
        start: () => ({ target: app, exited: new Promise<never>(() => {}), close: () => {} }),
      }),
    },
  );

describe('kodlama ajanının turları', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

  it('tam izinli botta bile komutu kartla, "hep izin ver" olmadan sorar; okumayı sormaz', async () => {
    const { app, seen } = fakeAgent({
      onPrompt: async (say, { ask }) => {
        await ask({
          toolCallId: 'r',
          kind: 'read',
          title: 'Read notes.md',
          locations: [{ path: '/tmp/notes.md' }],
        });
        await ask({ toolCallId: 'c', kind: 'execute', title: 'ls', rawInput: { command: 'ls' } });
        await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Bitti' } });
        return 'end_turn';
      },
    });
    t = await serverWith(app);
    const bot = await t.bot({ engine: 'acp', model: 'gemini', permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'klasörü listele');
    const card = await waitFor(async () => (await pending())[0]);
    expect(card.toolName).toBe('Bash');
    const asked = (await t.messages(thread.id)).find((m: Message) => m.role === 'approval')!;
    expect(asked.props.noAlways).toBe(true);
    // The read went through without a card, before the command was asked about.
    expect(seen.answers[0]).toEqual({ outcome: 'selected', optionId: 'once' });
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect(seen.answers).toEqual([
      { outcome: 'selected', optionId: 'once' },
      { outcome: 'selected', optionId: 'once' },
    ]);
    expect((await t.messages(thread.id)).at(-1)!.text).toBe('Bitti');
  });

  it('oturum yükleyemeyen ajanla art arda iki mesaj da cevaplanır', async () => {
    let n = 0;
    const { app, seen } = fakeAgent({
      onPrompt: async (say) => {
        await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `cevap ${++n}` } });
        return 'end_turn';
      },
    });
    t = await serverWith(app);
    const bot = await t.bot({ engine: 'acp', model: 'gemini', permissionMode: 'ask' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'birinci');
    await t.services.turns.idle();
    await t.send(thread.id, 'ikinci');
    await t.services.turns.idle();
    const replies = (await t.messages(thread.id))
      .filter((m: Message) => m.role === 'assistant')
      .map((m) => m.text);
    expect(replies).toEqual(['cevap 1', 'cevap 2']);
    // The second session was told what came before.
    expect(seen.prompts[1]).toContain('birinci');
  });

  it('ajanın uygulama aracı için sorduğu soru kart açmaz; araç kendi kuralıyla çalışır', async () => {
    const { app, seen } = fakeAgent({
      http: true,
      onPrompt: async (say, { ask, mcpUrl }) => {
        await ask({ toolCallId: 'm', kind: 'other', title: 'memory_write (leafbot MCP Server)' });
        const mcp = new Client({ name: 'fake', version: '1' });
        await mcp.connect(new StreamableHTTPClientTransport(new URL(mcpUrl!)));
        seen.toolResults.push(
          await mcp.callTool({ name: 'memory_write', arguments: { content: 'Kahveyi şekersiz içer' } }),
        );
        await mcp.close();
        await say({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Not aldım' } });
        return 'end_turn';
      },
    });
    t = await serverWith(app);
    const bot = await t.bot({ engine: 'acp', model: 'gemini', permissionMode: 'ask' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'bunu hatırla');
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    expect(seen.answers).toEqual([{ outcome: 'selected', optionId: 'once' }]);
    expect(seen.toolResults[0]).not.toMatchObject({ isError: true });
    expect((await t.messages(thread.id)).at(-1)!.text).toBe('Not aldım');
  });

  it('salt okunur botu çalıştırmaz, nedenini söyler', async () => {
    const { app, seen } = fakeAgent({});
    t = await serverWith(app);
    const bot = await t.bot({ engine: 'acp', model: 'gemini', permissionMode: 'readonly' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(seen.prompts).toEqual([]);
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('yalnızca okumaya');
  });
});
