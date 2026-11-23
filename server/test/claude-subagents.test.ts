import { describe, expect, it, vi } from 'vitest';
import type { SubagentState } from '../src/engine/types';

const frames: { current: unknown[] } = { current: [] };
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: () => ({
    interrupt: async () => {},
    close: () => {},
    async *[Symbol.asyncIterator]() {
      for (const f of frames.current) yield f;
    },
  }),
}));

const { ClaudeEngine } = await import('../src/engine/claude');

const run = (onSubagent: (s: SubagentState) => void) =>
  new ClaudeEngine({ credential: async () => null }).run({
    onSubagent,
    turnId: 't',
    threadId: 'th',
    botId: 'b',
    model: 'haiku',
    prompt: 'merhaba',
    sessionId: null,
    systemPrompt: '',
    locale: 'tr',
    sandbox: { cwd: '/tmp', additionalDirectories: [], writable: ['/tmp'], internet: true, readOnly: false },
    shell: 'sandbox',
    tools: [],
    canUseTool: async () => ({ behavior: 'allow' }),
    onText: () => {},
    onSession: () => {},
    signal: new AbortController().signal,
  });

const start = (id: string, description: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_use', id, name: 'Agent', input: { description, prompt: 'x' } }] },
});
const said = (parent: string, text: string) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content: [{ type: 'text', text }] },
});
const result = (id: string, text: string) => ({
  type: 'user',
  parent_tool_use_id: null,
  message: { content: [{ type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] }] },
});

describe('Claude alt ajanları', () => {
  it('başlayan alt ajan kendinden bir şey gelene kadar bekler; yalnız metin de çalıştığını söyler', async () => {
    const states = new Map<string, string[]>();
    frames.current = [
      start('a', 'Birinci'),
      start('b', 'İkinci'),
      said('a', 'Bakıyorum.'),
      result('a', 'A bitti.'),
      { type: 'stream_event', parent_tool_use_id: 'b', event: { type: 'message_start' } },
      result('b', 'B bitti.'),
      { type: 'result', subtype: 'success', is_error: false, result: 'Tamam.' },
    ];
    await run((s) => states.set(s.id, [...(states.get(s.id) ?? []), s.state]));
    expect(states.get('a')).toEqual(['waiting', 'running', 'done']);
    expect(states.get('b')).toEqual(['waiting', 'running', 'done']);
  });

  it('hiç başlamadan biten tur bekleyeni durmuş sayar', async () => {
    const last = new Map<string, SubagentState>();
    frames.current = [
      start('a', 'Birinci'),
      { type: 'result', subtype: 'success', is_error: false, result: 'x' },
    ];
    await run((s) => last.set(s.id, s));
    expect(last.get('a')?.state).toBe('stopped');
  });
});
