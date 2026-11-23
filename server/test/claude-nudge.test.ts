import { describe, expect, it, vi } from 'vitest';
import type { TurnRequest } from '../src/engine/types';

// One entry per message the engine sends in: what the CLI answers it with.
const scripts: { current: unknown[][] } = { current: [] };
const sent: string[] = [];
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: ({ prompt }: { prompt: AsyncIterable<{ message: { content: string } }> }) => ({
    interrupt: async () => {},
    close: () => {},
    async *[Symbol.asyncIterator]() {
      let n = 0;
      for await (const message of prompt) {
        sent.push(message.message.content);
        for (const f of scripts.current[n++] ?? []) yield f;
      }
    },
  }),
}));

const { ClaudeEngine } = await import('../src/engine/claude');

const run = (over: Partial<TurnRequest> = {}) =>
  new ClaudeEngine({ credential: async () => null }).run({
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
    canUseTool: async () => ({ behavior: 'deny', message: 'hayır' }),
    onText: () => {},
    onSession: () => {},
    signal: new AbortController().signal,
    ...over,
  });

let id = 0;
const said = (text: string, tool?: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: {
    id: `m${++id}`,
    content: [
      { type: 'text', text },
      ...(tool ? [{ type: 'tool_use', id: `u${id}`, name: tool, input: {} }] : []),
    ],
  },
});
const done = (result: string, extra: object = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result,
  total_cost_usd: 0,
  ...extra,
});

describe('Claude: yapacağını söyleyip duran tur', () => {
  it('çağrı yapmadan "şimdi yapıyorum" deyip biten turu aynı oturumda devam ettirir; cevap duyuruyu tekrarlamaz', async () => {
    sent.length = 0;
    scripts.current = [
      [said('Şimdi dosyayı okuyorum.'), done('Şimdi dosyayı okuyorum.')],
      [said('Okudum', 'Read'), said('Dosyada 3 satır var.'), done('Dosyada 3 satır var.')],
    ];
    const out = await run();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('made no tool call');
    expect(out).toMatchObject({ ok: true, text: 'Dosyada 3 satır var.' });
  });

  it('en çok iki kez devam ettirir', async () => {
    sent.length = 0;
    const again = [said("I'll check the file now."), done("I'll check the file now.")];
    scripts.current = [again, again, again, again];
    const out = await run();
    expect(sent).toHaveLength(3);
    expect(out.ok).toBe(true);
  });

  it('başka bota verilen işin cevabını beklerken, soru sorarken ve araç çağrısından sonra devam ettirmez', async () => {
    sent.length = 0;
    scripts.current = [[said('Şimdi ona soruyorum.'), done('Şimdi ona soruyorum.')]];
    await run({ awaitsAnswers: async () => true });
    expect(sent).toHaveLength(1);

    sent.length = 0;
    scripts.current = [[said('Hangi dosyayı okuyayım?'), done('Hangi dosyayı okuyayım?')]];
    await run();
    expect(sent).toHaveLength(1);

    sent.length = 0;
    scripts.current = [[said("I'll check the file now.", 'Read'), done("I'll check the file now.")]];
    await run();
    expect(sent).toHaveLength(1);
  });
});

describe('Claude: sağlayıcının reddi', () => {
  it('reddi yedek modele geçilebilir diye işaretler; yazılanı cevap saymaz', async () => {
    scripts.current = [
      [
        said('Bir şeyler yazdım'),
        {
          type: 'system',
          subtype: 'model_refusal_no_fallback',
          content: 'refused',
          api_refusal_explanation: 'policy',
        },
        done('Bir şeyler yazdım', { stop_reason: 'refusal' }),
      ],
    ];
    const out = await run();
    expect(out).toMatchObject({ ok: false, kind: 'engine', refused: true });
    if (!out.ok) expect(out.message).toContain('reddetti');
  });
});

describe('Claude: özetleme sırasında', () => {
  it('CLI özetlerken tur sessiz sayılmasın diye başlangıcı ve bitişi söyler', async () => {
    sent.length = 0;
    const calls: boolean[] = [];
    scripts.current = [
      [
        { type: 'system', subtype: 'status', status: 'compacting' },
        { type: 'system', subtype: 'compact_boundary', compact_metadata: {} },
        done('Tamam.'),
      ],
    ];
    await run({ onCompacting: (on) => calls.push(on) });
    expect(calls.slice(0, 2)).toEqual([true, false]);
    expect(calls.at(-1)).toBe(false);
  });
});
