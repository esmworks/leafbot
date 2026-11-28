import { describe, expect, it, vi } from 'vitest';
import type { TurnRequest } from '../src/engine/types';

const frames: { current: unknown[] | 'hang' } = { current: [] };
type Hook = (input: Record<string, unknown>) => Promise<unknown>;
const last: { hooks?: Record<string, { hooks: Hook[] }[]>; maxTurns?: number } = {};
vi.mock('@anthropic-ai/claude-agent-sdk', async (real) => ({
  ...(await real<object>()),
  query: ({ options }: { options: { hooks: Record<string, { hooks: Hook[] }[]>; maxTurns?: number } }) => {
    last.hooks = options.hooks;
    last.maxTurns = options.maxTurns;
    // 'hang': a CLI that ignores the interrupt; only closing it ends the stream.
    let close = () => {};
    const closed = new Promise<void>((r) => (close = r));
    return {
      interrupt: async () => {},
      close: () => close(),
      async *[Symbol.asyncIterator]() {
        if (frames.current === 'hang') await closed;
        else {
          for (const f of frames.current) {
            // An error in the list is what the SDK throws when the stream breaks.
            if (f instanceof Error) throw f;
            yield f;
          }
        }
      },
    };
  },
}));

const { ClaudeEngine, STOP_GRACE_MS } = await import('../src/engine/claude');

const request = (
  onActivity?: TurnRequest['onActivity'],
  signal = new AbortController().signal,
): TurnRequest => ({
  onActivity,
  turnId: 't',
  threadId: 'th',
  botId: 'b',
  model: 'haiku',
  prompt: 'merhaba',
  sessionId: null,
  systemPrompt: '',
  locale: 'tr',
  sandbox: {
    cwd: '/tmp',
    additionalDirectories: [],
    writable: ['/tmp'],
    internet: true,
    readOnly: false,
  },
  shell: 'sandbox',
  tools: [],
  canUseTool: async () => ({ behavior: 'deny', message: 'hayır' }),
  onText: () => {},
  onSession: () => {},
  signal,
});

const run = (onActivity?: TurnRequest['onActivity'], signal = new AbortController().signal) =>
  new ClaudeEngine({ credential: async () => null }).run(request(onActivity, signal));

const apiError = (error: string, text: string) => ({
  type: 'assistant',
  error,
  message: { content: [{ type: 'text', text }] },
});

describe('Claude API hatası', () => {
  it('hatanın metnini bot yanıtı saymaz, nedenini anlaşılır sözlerle söyler', async () => {
    const said =
      'API Error: 402 {"type":"error","error":{"type":"billing_error","message":"Credit balance is too low"}}';
    frames.current = [
      apiError('billing_error', said),
      { type: 'result', subtype: 'success', is_error: true, result: said },
    ];
    const out = await run();
    expect(out.ok).toBe(false);
    expect(out.text).toBe('');
    if (!out.ok) {
      expect(out.message).toContain('bakiye');
      expect(out.message).toContain('Credit balance is too low');
      expect(out.message).not.toContain('{');
    }
  });

  it('Claude Code işleminin çökmesi yeniden denenebilir hata olarak işaretlenir', async () => {
    frames.current = [new Error('Claude Code process exited with code 1\nStderr: boom')];
    expect(await run()).toMatchObject({ ok: false, kind: 'engine', crashed: true, transient: true });
    frames.current = [new Error('Claude Code process terminated by signal SIGKILL')];
    expect(await run()).toMatchObject({ ok: false, crashed: true });
    // Another thrown error is not a crash.
    frames.current = [new Error('Something else broke')];
    const other = await run();
    expect(other).toMatchObject({ ok: false, kind: 'engine' });
    expect(other).not.toHaveProperty('crashed');
    // A durdurma is not a crash either.
    const stop = new AbortController();
    stop.abort();
    frames.current = [new Error('Claude Code process exited with code 143')];
    expect(await run(undefined, stop.signal)).toMatchObject({ ok: false, kind: 'interrupted' });
  });

  it('bakiye hatası yedek modele geçilebilir diye işaretlenir', async () => {
    const said =
      'API Error: 402 {"type":"error","error":{"type":"billing_error","message":"Credit balance is too low"}}';
    frames.current = [
      apiError('billing_error', said),
      { type: 'result', subtype: 'success', is_error: true, result: said },
    ];
    expect(await run()).toMatchObject({ ok: false, kind: 'engine', billing: true });
    // The CLI's own error code is enough, whatever its text says.
    frames.current = [
      apiError('billing_error', 'Your account is not active'),
      { type: 'result', subtype: 'success', is_error: true, result: 'Your account is not active' },
    ];
    const out = await run();
    expect(out).toMatchObject({ ok: false, billing: true });
    if (!out.ok) expect(out.message).toContain('bakiye');
  });

  it('başka bir servise giden anahtarın bakiye hatası o servisin adını söyler', async () => {
    const { gatewayName } = await import('../src/engine/claude');
    expect(gatewayName({ kind: 'apiKey', value: 'k', baseUrl: 'https://gw.example.com/v1' })).toBe(
      'gw.example.com',
    );
    expect(gatewayName({ kind: 'apiKey', value: 'k', baseUrl: 'https://api.anthropic.com' })).toBeNull();
    expect(gatewayName({ kind: 'token', value: 't' })).toBeNull();
    const said =
      'API Error: 402 {"type":"error","error":{"type":"billing_error","message":"Credit balance is too low"}}';
    frames.current = [
      apiError('billing_error', said),
      { type: 'result', subtype: 'success', is_error: true, result: said },
    ];
    const engine = new ClaudeEngine({
      credential: async () => ({ kind: 'apiKey', value: 'k', baseUrl: 'https://gw.example.com/v1' }),
    });
    const out = await engine.run(request());
    expect(out).toMatchObject({ ok: false, billing: true });
    if (!out.ok) {
      expect(out.message).toContain('gw.example.com');
      expect(out.message).not.toContain('Claude');
    }
  });

  it('kaldırılmış model yedeğe geçilebilir diye işaretlenir', async () => {
    const said =
      'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-old"}}';
    frames.current = [
      apiError('invalid_request', said),
      { type: 'result', subtype: 'success', is_error: true, result: said },
    ];
    const out = await run();
    expect(out).toMatchObject({ ok: false, kind: 'engine', modelGone: true });
    if (!out.ok) expect(out.message).toContain('artık sunmuyor');
  });

  it('CLI kullanamadığı modeli yalnız sonuç metninde söylese de yedeğe geçilebilir diye işaretlenir', async () => {
    const said =
      "There's an issue with the selected model (claude-old). It may not exist or you may not have access to it.";
    frames.current = [{ type: 'result', subtype: 'success', is_error: true, result: said }];
    expect(await run()).toMatchObject({ ok: false, kind: 'engine', modelGone: true });
  });

  it('ek kullanımla süren reddedilmiş olay planın sınırı sayılmaz', async () => {
    const rejected = (extra: object) => ({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', ...extra },
    });
    const failed = { type: 'result', subtype: 'success', is_error: true, result: 'Başka bir hata' };
    frames.current = [rejected({ overageStatus: 'allowed' }), failed];
    expect(await run()).toMatchObject({ ok: false, kind: 'engine' });
    frames.current = [rejected({ overageStatus: 'rejected' }), failed];
    expect(await run()).toMatchObject({ ok: false, kind: 'limit' });
  });

  it('sonradan başarıyla biten tur başarılı sayılır', async () => {
    frames.current = [
      apiError('server_error', 'API Error: 500'),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'tamam' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'tamam' },
    ];
    expect(await run()).toMatchObject({ ok: true, text: 'tamam' });
  });

  it('hızlı cevaplarla birlikte yazılan yanıt, aramadan sonraki kısa satırla kaybolmaz', async () => {
    // The CLI sends each block of one API message apart, under the same message id.
    const block = (id: string, block: object) => ({ type: 'assistant', message: { id, content: [block] } });
    const done = (id: string) => ({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
    });
    const close = 'Hangisini istersen başlatırım.';
    frames.current = [
      block('m1', { type: 'text', text: 'Bakıyorum.' }),
      block('m1', { type: 'tool_use', id: 'u1', name: 'Bash', input: {} }),
      done('u1'),
      block('m2', { type: 'text', text: 'Uzun rapor.' }),
      block('m2', { type: 'tool_use', id: 'u2', name: 'mcp__leafbot__quick_replies', input: {} }),
      done('u2'),
      block('m3', { type: 'text', text: close }),
      { type: 'result', subtype: 'success', is_error: false, result: close },
    ];
    expect(await run()).toMatchObject({ ok: true, text: `Uzun rapor.\n\n${close}` });

    // Text before a working tool stays an interim step.
    frames.current = [
      block('m1', { type: 'text', text: 'Bakıyorum.' }),
      block('m1', { type: 'tool_use', id: 'u1', name: 'Bash', input: {} }),
      done('u1'),
      block('m2', { type: 'text', text: 'Sonuç.' }),
      { type: 'result', subtype: 'success', is_error: false, result: 'Sonuç.' },
    ];
    expect(await run()).toMatchObject({ ok: true, text: 'Sonuç.' });
  });

  it('adım sınırında boş hata listesi yerine sınırı söyler', async () => {
    frames.current = [{ type: 'result', subtype: 'error_max_turns', errors: [], total_cost_usd: 0.8 }];
    const out = await run();
    // What the failed turn spent still counts.
    expect(out).toMatchObject({ ok: false, kind: 'engine', costUsd: 0.8, stepLimit: true });
    if (!out.ok) expect(out.message).toContain('50');
    expect(last.maxTurns).toBe(50);
  });

  it('gives Claude the step limit the turn was given, and names it when the turn stops there', async () => {
    frames.current = [{ type: 'result', subtype: 'error_max_turns', errors: [], total_cost_usd: 0.8 }];
    const out = await new ClaudeEngine({ credential: async () => null }).run({ ...request(), maxSteps: 200 });
    expect(last.maxTurns).toBe(200);
    expect(out).toMatchObject({ ok: false, stepLimit: true });
    if (!out.ok) expect(out.message).toContain('200');
  });

  it('her çerçevede ve her araç başlayıp bittiğinde canlılık işareti verir', async () => {
    const seen: (string | undefined)[] = [];
    const onActivity: TurnRequest['onActivity'] = (tool) =>
      seen.push(tool && `${tool.running ? '+' : '-'}${tool.id}${tool.name ? `:${tool.name}` : ''}`);
    frames.current = [
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'u1', name: 'Bash', input: {} }] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'u1', content: 'ok' }] } },
      { type: 'result', subtype: 'success', is_error: false, result: 'bitti' },
    ];
    expect(await run(onActivity)).toMatchObject({ ok: true });
    expect(seen).toEqual([undefined, undefined, '-u1', undefined]);

    seen.length = 0;
    const call = (event: string) =>
      last.hooks![event]![0]!.hooks[0]!({
        hook_event_name: event,
        tool_use_id: 'u2',
        tool_name: 'Bash',
        error: 'x',
      });
    await call('PreToolUse');
    await call('PostToolUse');
    await call('PostToolUseFailure');
    expect(seen).toEqual(['+u2:Bash', '-u2:Bash', '-u2:Bash']);
  });

  it('durdurmaya yanıt vermeyen CLI kısa bir süre sonra kapatılır; tur durmuş olarak biter', async () => {
    frames.current = 'hang';
    const stop = new AbortController();
    const started = Date.now();
    const out = run(undefined, stop.signal);
    setTimeout(() => stop.abort(), 50);
    expect(await out).toMatchObject({ ok: false, kind: 'interrupted' });
    expect(Date.now() - started).toBeLessThan(STOP_GRACE_MS + 2_000);
  });
});
