import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProviderInfo } from '@leafbot/shared';
import {
  completeSimple,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
  registerFauxProvider,
  streamSimple,
  type FauxProviderRegistration,
} from '@earendil-works/pi-ai/compat';
import type { StreamFn } from '@earendil-works/pi-agent-core';
import type { Model } from '@earendil-works/pi-ai';
import { eq } from 'drizzle-orm';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { schema } from '../src/db';
import { FileWatch } from '../src/services/turn-changes';
import {
  announcesAction,
  dropOldImages,
  MAX_STEPS,
  MAX_TOOLS,
  PiEngine,
  providerTrouble,
  replyText,
  RESULT_TOOL,
  trimHistory,
} from '../src/engine/pi';
import {
  capText,
  cutPoint,
  elideResults,
  EXCERPT_CHARS,
  excerptSummary,
  recentTranscript,
  SUMMARY_SYSTEM,
  transcriptChunks,
  withSummary,
} from '../src/engine/pi-context';
import { translator } from '../src/i18n';
import { asOutsideData } from '../src/runtime/outside';
import { CONTEXT_FULL } from '../src/runtime/turns';
import { endpointApi, endpointUrl, keySafeAt, unlistedModel } from '../src/services/keys';
import { getModels } from '@earendil-works/pi-ai/compat';
import type {
  AppTool,
  PermissionAsk,
  PermissionAnswer,
  SubagentState,
  TurnRequest,
} from '../src/engine/types';
import { limiter, SUBAGENTS_AT_ONCE } from '../src/engine/pi-subagent';
import { testServer, type TestServer } from './helpers';

let faux: FauxProviderRegistration;
beforeAll(() => {
  faux = registerFauxProvider({
    provider: 'deneme',
    models: [{ id: 'm1' }, { id: 'dusunen', reasoning: true }, { id: 'metin', input: ['text'] }],
    tokensPerSecond: 0,
  });
});

describe('Pi motoru', () => {
  let dir: string;
  let cwd: string;
  let outside: string;
  let asks: PermissionAsk[];
  let answer: PermissionAnswer;
  let keys: Record<string, string>;
  let seenKeys: (string | undefined)[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'leafbot-pi-'));
    cwd = join(dir, 'thread');
    outside = join(dir, 'disari');
    mkdirSync(cwd);
    mkdirSync(outside);
    asks = [];
    answer = { behavior: 'allow' };
    keys = { deneme: 'test-anahtar-12345' };
    seenKeys = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const engine = () =>
    new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      streamFn: ((model, context, options) => {
        seenKeys.push(options?.apiKey);
        return streamSimple(model, context, options);
      }) as StreamFn,
    });

  const request = (over: Partial<TurnRequest> = {}) => {
    const text: string[] = [];
    const sessions: string[] = [];
    const ctrl = new AbortController();
    const req: TurnRequest = {
      turnId: 't1',
      threadId: 'th1',
      botId: 'b1',
      model: 'deneme/m1',
      prompt: 'merhaba',
      sessionId: null,
      systemPrompt: 'Sen bir test botusun.',
      locale: 'tr',
      sandbox: { cwd, additionalDirectories: [], writable: [cwd], internet: true, readOnly: false },
      shell: 'sandbox',
      tools: [],
      canUseTool: async (ask) => {
        asks.push(ask);
        return answer;
      },
      onText: (d) => text.push(d),
      onSession: (s) => sessions.push(s),
      signal: ctrl.signal,
      ...over,
    };
    return { req, text, sessions, ctrl };
  };

  it('yanıtı akıtır, oturumu saklar ve sonraki turda geçmişle devam eder', async () => {
    faux.setResponses([fauxAssistantMessage('Selam!')]);
    const first = request();
    const out = await engine().run(first.req);
    expect(out).toMatchObject({ ok: true, text: 'Selam!' });
    expect(first.text.join('')).toBe('Selam!');
    expect(first.sessions).toHaveLength(1);
    expect(out.sessionId).toBe(first.sessions[0]);
    // The stored key reaches only the provider call.
    expect(seenKeys).toEqual(['test-anahtar-12345']);

    let seen = 0;
    faux.setResponses([
      (ctx) => {
        seen = ctx.messages.length;
        return fauxAssistantMessage('Hatırlıyorum.');
      },
    ]);
    const second = request({ sessionId: out.sessionId, prompt: 'beni hatırlıyor musun' });
    const out2 = await engine().run(second.req);
    expect(out2).toMatchObject({ ok: true, text: 'Hatırlıyorum.', sessionId: out.sessionId });
    expect(second.sessions).toHaveLength(0);
    // user + assistant from the first turn, then the new user message.
    expect(seen).toBeGreaterThanOrEqual(3);
  });

  it('yapacağını söyleyip araç çağırmadan duran modele devam etmesini söyler', async () => {
    let nudge = '';
    faux.setResponses([
      fauxAssistantMessage('Şimdi dosyaya bakıyorum:'),
      (ctx) => {
        const last = ctx.messages.at(-1);
        nudge =
          last?.role === 'user' && typeof last.content === 'string'
            ? last.content
            : JSON.stringify(last?.content);
        return fauxAssistantMessage('Baktım; dosya boş.');
      },
    ]);
    const out = await engine().run(request().req);
    expect(out).toMatchObject({ ok: true, text: 'Baktım; dosya boş.' });
    expect(nudge).toContain('tool call');
  });

  it('araç sınırını aşınca küçük uygulamaları bütün tutar; sığmayana arayıp onayla ulaşılır', async () => {
    let names: string[] = [];
    let system = '';
    const found: string[] = [];
    faux.setResponses([
      () =>
        fauxAssistantMessage([fauxToolCall('find_tool', { query: 'arac139' })], { stopReason: 'toolUse' }),
      (ctx) => {
        const last = ctx.messages.at(-1) as { content: { text?: string }[] };
        found.push(last.content.map((c) => c.text ?? '').join(''));
        return fauxAssistantMessage(
          [fauxToolCall('use_tool', { name: 'uzak__arac139', arguments: { n: 1 } })],
          { stopReason: 'toolUse' },
        );
      },
      (ctx) => {
        const last = ctx.messages.at(-1) as { content: { text?: string }[] };
        found.push(last.content.map((c) => c.text ?? '').join(''));
        return fauxAssistantMessage('Tamam.');
      },
    ]);
    const own: AppTool = {
      name: 'hatirla',
      description: 'not al',
      input: {},
      readOnly: true,
      internal: true,
      handler: async () => '',
    };
    const app = (server: string, count: number): AppTool[] =>
      Array.from({ length: count }, (_, i) => ({
        name: `arac${i}`,
        description: `${server} aracı ${i}`,
        input: {},
        server,
        jsonSchema: { type: 'object', properties: { n: { type: 'number' } } },
        readOnly: true,
        internal: false,
        handler: async (args) => `${server} ${i} çalıştı ${JSON.stringify(args)}`,
      }));
    const watching = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      streamFn: ((model, context, options) => {
        if (!names.length) {
          names = context.messages.flatMap((m) =>
            m.role === 'system' ? (m.toolsAdded ?? []).map((x: { name: string }) => x.name) : [],
          );
          system = context.messages
            .map((m) => (m.role === 'system' && typeof m.content === 'string' ? m.content : ''))
            .join('\n');
        }
        return streamSimple(model, context, options);
      }) as StreamFn,
    });
    const out = await watching.run(request({ tools: [...app('uzak', 140), ...app('kucuk', 3), own] }).req);
    expect(out).toMatchObject({ ok: true, text: 'Tamam.' });
    // The small app is listed whole; the big one is reached by search.
    expect(names).toContain('kucuk__arac2');
    expect(names).toContain('hatirla');
    expect(names).not.toContain('uzak__arac0');
    expect(names).toEqual(expect.arrayContaining(['find_tool', 'use_tool']));
    expect(names.length).toBeLessThanOrEqual(MAX_TOOLS);
    expect(system).toContain('find_tool');
    expect(found[0]).toContain('uzak__arac139');
    expect(found[1]).toContain('uzak 139 çalıştı {"n":1}');
    // The call asked as the tool itself, with its own arguments.
    expect(asks.at(-1)).toEqual({ toolName: 'mcp__uzak__arac139', input: { n: 1 } });
  });

  it('akıl yürüten modele botun düşünme seviyesini verir, ötekine vermez', async () => {
    const levels: unknown[] = [];
    const watching = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      streamFn: ((model, context, options) => {
        levels.push(options?.reasoning);
        return streamSimple(model, context, options);
      }) as StreamFn,
    });
    faux.setResponses([fauxAssistantMessage('Tamam.'), fauxAssistantMessage('Tamam.')]);
    await watching.run(request({ model: 'deneme/dusunen', effort: 'high' }).req);
    await watching.run(request({ model: 'deneme/m1', effort: 'high' }).req);
    expect(levels[0]).toBe('high');
    expect(levels[1]).toBeUndefined();
  });

  it('duyurulan eylemi tanır, soruyu ve uzun yanıtı duyuru saymaz', () => {
    expect(announcesAction('Let me check the file:')).toBe(true);
    expect(announcesAction("I'll open the page now")).toBe(true);
    expect(announcesAction('Şimdi kontrol ediyorum')).toBe(true);
    expect(announcesAction('Hemen bakayım…')).toBe(true);
    expect(announcesAction('我先看看这个文件：')).toBe(true);
    expect(announcesAction('要我打开吗？')).toBe(false);
    expect(announcesAction('Dosyayı okuyayım mı?')).toBe(false);
    expect(announcesAction('Bitti, rapor hazır.')).toBe(false);
    expect(announcesAction(`Let me explain: ${'x'.repeat(400)}`)).toBe(false);
  });

  it('hızlı cevaplarla birlikte yazılan yanıt, aramadan sonraki kısa satırla kaybolmaz', () => {
    const said = (text: string, ...tools: string[]) =>
      ({
        role: 'assistant',
        content: [
          ...(text ? [{ type: 'text', text }] : []),
          ...tools.map((name, i) => ({ type: 'toolCall', id: `${name}${i}`, name, arguments: {} })),
        ],
      }) as never;
    const result = (name: string) =>
      ({ role: 'toolResult', toolCallId: name, toolName: name, content: [] }) as never;
    const asked = { role: 'user', content: 'Dükkanın gidişatı' } as never;

    expect(
      replyText([
        asked,
        said('Bakıyorum.', 'read_sheet'),
        result('read_sheet'),
        said('Uzun rapor.', 'quick_replies'),
        result('quick_replies'),
        said('Hangisini istersen başlatırım.'),
      ]),
    ).toBe('Uzun rapor.\n\nHangisini istersen başlatırım.');
    // Nothing after the call: the answer still stands.
    expect(replyText([asked, said('Uzun rapor.', 'quick_replies'), result('quick_replies'), said('')])).toBe(
      'Uzun rapor.',
    );
    // Text before a working tool stays an interim step.
    expect(replyText([asked, said('Bakıyorum.', 'read_sheet'), result('read_sheet'), said('Sonuç.')])).toBe(
      'Sonuç.',
    );
    expect(replyText([asked, said('Sonuç.')])).toBe('Sonuç.');
  });

  it('yerleşik listede olmayan modeli kişinin kendi uç noktasından alır', async () => {
    faux.setResponses([fauxAssistantMessage('Yerelden selam.')]);
    keys['custom-ev'] = 'none';
    const asked: string[] = [];
    const e = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: () => undefined,
      customModel: async (p, id) => {
        asked.push(`${p}/${id}`);
        return p === 'custom-ev' ? { ...faux.getModel('m1')!, provider: 'custom-ev', id } : undefined;
      },
      streamFn: ((model, context, options) =>
        streamSimple({ ...model, provider: 'deneme', id: 'm1' }, context, options)) as StreamFn,
    });
    const out = await e.run(request({ model: 'custom-ev/qwen3' }).req);
    expect(out).toMatchObject({ ok: true, text: 'Yerelden selam.' });
    expect(asked).toEqual(['custom-ev/qwen3']);
    expect(await e.run(request({ model: 'baska/qwen3' }).req)).toMatchObject({ ok: false });
  });

  it('klasör içindeki dosyayı izin sorarak yazar', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'not.txt', content: 'içerik' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Yazdım.'),
    ]);
    const { req } = request();
    const out = await engine().run(req);
    expect(out).toMatchObject({ ok: true, text: 'Yazdım.' });
    expect(readFileSync(join(cwd, 'not.txt'), 'utf8')).toBe('içerik');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.toolName).toBe('Write');
    expect(String(asks[0]!.input.file_path)).toMatch(/not\.txt$/);
  });

  it('bir dosya aracını çalışmadan önce modelin yazdığı yolla gösterir; turu geri almak için kaydı tutulur', async () => {
    const lines: { kind: string; op: string; label: string; before: unknown }[] = [];
    const watch = new FileWatch(
      { record: async (_s: unknown, c: (typeof lines)[number]) => void lines.push(c) } as never,
      { turnId: 't1', threadId: 'th1', botId: 'b1', userId: 'u1' },
      cwd,
      [cwd],
      0,
    );
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'geri.txt', content: 'yeni' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Yazdım.'),
    ]);
    const { req } = request({
      screen: async (ask) => {
        await watch.before(ask.toolName, ask.input);
        return null;
      },
    });
    await engine().run(req);
    await watch.finish();
    expect(lines).toEqual([
      expect.objectContaining({ kind: 'file', op: 'create', label: 'geri.txt', before: { exists: false } }),
    ]);
  });

  it('araç başlayıp bittiğinde ve her olayda canlılık işareti verir', async () => {
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'canli.txt', content: 'x' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Yazdım.'),
    ]);
    const tools: string[] = [];
    let beats = 0;
    const { req } = request({
      onActivity: (tool) => {
        beats++;
        if (tool) tools.push(`${tool.running ? '+' : '-'}${tool.name}`);
      },
    });
    expect(await engine().run(req)).toMatchObject({ ok: true, text: 'Yazdım.' });
    expect(tools).toEqual(['+Write', '-Write']);
    expect(beats).toBeGreaterThan(tools.length);
  });

  it('görüntü dosyasını metin diye okumaz; görebilen modele görüntüyü gösterir', async () => {
    // A 1x1 PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    writeFileSync(join(cwd, 'resim.png'), png);
    const seen: { type: string; data?: string; mimeType?: string; text?: string }[][] = [];
    const reply = (ctx: { messages: unknown[] }) => {
      seen.push((ctx.messages.at(-1) as { content: (typeof seen)[number] }).content);
      return fauxAssistantMessage('Gördüm.');
    };
    const call = () =>
      fauxAssistantMessage([fauxToolCall('read_file', { path: 'resim.png' })], { stopReason: 'toolUse' });
    faux.setResponses([call(), reply, call(), reply]);
    expect(await engine().run(request().req)).toMatchObject({ ok: true, text: 'Gördüm.' });
    const image = seen[0]!.find((c) => c.type === 'image')!;
    expect(image).toMatchObject({ mimeType: 'image/png', data: png.toString('base64') });

    // A model that cannot see pictures is told so, not handed the bytes as text.
    await engine().run(request({ model: 'deneme/metin' }).req);
    expect(seen[1]!.some((c) => c.type === 'image')).toBe(false);
    expect(seen[1]!.map((c) => c.text ?? '').join('')).toContain('görüntü göremiyor');
  });

  it('araç almayan modele araçsız istek gönderir', async () => {
    let names: string[] | null = null;
    faux.setResponses([fauxAssistantMessage('Merhaba.')]);
    const toolless = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      takesTools: async () => false,
      streamFn: ((model, context, options) => {
        names = context.messages.flatMap((m) =>
          m.role === 'system' ? (m.toolsAdded ?? []).map((x: { name: string }) => x.name) : [],
        );
        return streamSimple(model, context, options);
      }) as StreamFn,
    });
    expect(await toolless.run(request().req)).toMatchObject({ ok: true, text: 'Merhaba.' });
    expect(names).toEqual([]);
  });

  it('reddedilen yazma yapılmaz, sonuç modele hata olarak döner', async () => {
    answer = { behavior: 'deny', message: 'Kullanıcı reddetti' };
    let toolResult = '';
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'x.txt', content: 'y' })], {
        stopReason: 'toolUse',
      }),
      (ctx) => {
        const last = ctx.messages.at(-1) as { content: { type: string; text?: string }[] };
        toolResult = last.content.map((c) => c.text ?? '').join('');
        return fauxAssistantMessage('Tamam.');
      },
    ]);
    const out = await engine().run(request().req);
    expect(out.ok).toBe(true);
    expect(existsSync(join(cwd, 'x.txt'))).toBe(false);
    expect(toolResult).toContain('Kullanıcı reddetti');
  });

  it('klasör dışına ve bağlantı (symlink) üzerinden kaçışa izin vermez; izin bile sorulmaz', async () => {
    writeFileSync(join(outside, 'gizli.txt'), 'gizli');
    symlinkSync(outside, join(cwd, 'kacis'));
    const results: string[] = [];
    const capture = (ctx: { messages: unknown[] }) => {
      const last = ctx.messages.at(-1) as { content: { text?: string }[] };
      results.push(last.content.map((c) => c.text ?? '').join(''));
    };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read_file', { path: join(outside, 'gizli.txt') })], {
        stopReason: 'toolUse',
      }),
      (ctx) => {
        capture(ctx);
        return fauxAssistantMessage([fauxToolCall('read_file', { path: 'kacis/gizli.txt' })], {
          stopReason: 'toolUse',
        });
      },
      (ctx) => {
        capture(ctx);
        return fauxAssistantMessage(
          [fauxToolCall('write_file', { path: '../disari/yeni.txt', content: 'x' })],
          {
            stopReason: 'toolUse',
          },
        );
      },
      (ctx) => {
        capture(ctx);
        return fauxAssistantMessage('Olmadı.');
      },
    ]);
    const out = await engine().run(request().req);
    expect(out.ok).toBe(true);
    expect(asks).toHaveLength(0);
    expect(results).toHaveLength(3);
    for (const r of results) expect(r).not.toContain('gizli\n');
    expect(results.join(' ')).toMatch(/dışında|izni yok/);
    expect(existsSync(join(outside, 'yeni.txt'))).toBe(false);
  });

  it('hedefi olmayan bağlantı üzerinden klasör dışına dosya oluşturmaz', async () => {
    symlinkSync(join(outside, 'yok.txt'), join(cwd, 'link.txt'));
    symlinkSync(join(cwd, 'gercek.txt'), join(cwd, 'ic-link.txt'));
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'link.txt', content: 'x' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage([fauxToolCall('write_file', { path: 'ic-link.txt', content: 'y' })], {
        stopReason: 'toolUse',
      }),
      fauxAssistantMessage('Olmadı.'),
    ]);
    answer = { behavior: 'allow' };
    const out = await engine().run(request().req);
    expect(out.ok).toBe(true);
    expect(existsSync(join(outside, 'yok.txt'))).toBe(false);
    // A link inside the folder is not followed either.
    expect(existsSync(join(cwd, 'gercek.txt'))).toBe(false);
  });

  it('adım sınırında turu durdurur', async () => {
    let calls = 0;
    const loop = () => {
      calls++;
      return fauxAssistantMessage([fauxToolCall('list_files', {})], { stopReason: 'toolUse' });
    };
    faux.setResponses(Array.from({ length: MAX_STEPS + 5 }, () => loop));
    const out = await engine().run(request().req);
    expect(out).toMatchObject({ ok: false, kind: 'engine' });
    expect(!out.ok && out.message).toContain('Adım sınırı');
    // The abort lands while the next request starts; that one is cut off.
    expect(calls).toBeLessThanOrEqual(MAX_STEPS + 1);
    expect(calls).toBeGreaterThanOrEqual(MAX_STEPS);
  });

  it('modeli kayıtlı anahtarla tek kısa istekle dener', async () => {
    faux.setResponses([fauxAssistantMessage('OK')]);
    expect(await engine().testModel('deneme/m1', 'tr')).toEqual({ ok: true });
    expect(faux.state.callCount).toBeGreaterThan(0);

    faux.setResponses([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Invalid API key' })]);
    expect(await engine().testModel('deneme/m1', 'tr')).toEqual({ ok: false, detail: 'Invalid API key' });

    expect((await engine().testModel('deneme/yok', 'tr')).ok).toBe(false);
    delete keys.deneme;
    const noKey = await engine().testModel('deneme/m1', 'tr');
    expect(noKey).toMatchObject({ ok: false, detail: expect.stringContaining('deneme') });
  });

  it('rutin ön kontrolünü botun kendi modeliyle yapar; cevap veremezse hata verir', async () => {
    const asks: string[] = [];
    const e = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      complete: (async (model, context) => {
        asks.push(`${model.id}: ${context.systemPrompt?.slice(0, 32)}`);
        return fauxAssistantMessage('{"decision":"skip","reason":"Yeni bir şey yok."}');
      }) as typeof completeSimple,
    });
    const request = {
      routine: { name: 'Siparişler', prompt: 'Yeni sipariş gelirse özetle' },
      trigger: 'webhook' as const,
      input: '{"note":"önemsiz"}',
      lastReport: null,
      locale: 'tr' as const,
      signal: new AbortController().signal,
    };
    expect(await e.gate({ ...request, model: 'deneme/m1' })).toMatchObject({
      decision: 'skip',
      reason: 'Yeni bir şey yok.',
    });
    expect(asks).toEqual(['m1: An assistant bot is about to run']);
    // No model, or no key for it: the check fails and the routine runs.
    await expect(e.gate(request)).rejects.toThrow();
    delete keys.deneme;
    await expect(e.gate({ ...request, model: 'deneme/m1' })).rejects.toThrow();
    expect(asks).toHaveLength(1);
  });

  it('modeli denerken bir oturum kimliği verir; OpenCode onsuz isteği geri çevirir', async () => {
    const seen: (string | undefined)[] = [];
    const e = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      complete: (async (_model, _context, options) => {
        seen.push(options?.sessionId);
        return fauxAssistantMessage('OK');
      }) as typeof completeSimple,
    });
    expect(await e.testModel('deneme/m1', 'tr')).toEqual({ ok: true });
    expect(await e.testModel('deneme/m1', 'tr')).toEqual({ ok: true });
    expect(seen[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(seen[1]).not.toBe(seen[0]);
  });

  it('geçmişi kullanıcı mesajında başlayacak şekilde kırpar', () => {
    const u = (n: number) => ({ role: 'user', content: `u${n}`, timestamp: n }) as never;
    const a = (n: number) => ({ role: 'assistant', content: [], n }) as never;
    const t = (n: number) => ({ role: 'toolResult', n }) as never;
    const sys = { role: 'system', content: 's' } as never;
    const msgs = [sys, u(1), a(1), t(1), a(2), u(2), a(3), t(2), a(4), u(3), a(5)];
    const out = trimHistory(msgs, 5);
    expect(out[0]).toBe(sys);
    expect(out.slice(1).map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
    expect(trimHistory(msgs, 50)).toBe(msgs);
  });

  it('istekte yalnız son üç görüntüyü bırakır; eskileri bir notla değiştirir, kayıtlı geçmişe dokunmaz', () => {
    const shot = (n: number) =>
      ({
        role: 'toolResult',
        content: [
          { type: 'text', text: `ekran ${n}` },
          { type: 'image', data: `veri${n}`, mimeType: 'image/jpeg' },
        ],
      }) as never;
    const msgs = [1, 2, 3, 4, 5].map(shot);
    const out = dropOldImages(msgs, '(eski)') as unknown as { content: { type: string; text?: string }[] }[];
    expect(out.map((m) => m.content.map((c) => c.type).join('+'))).toEqual([
      'text+text',
      'text+text',
      'text+image',
      'text+image',
      'text+image',
    ]);
    expect(out[0]!.content[1]!.text).toBe('(eski)');
    expect(out[0]!.content[0]!.text).toBe('ekran 1');
    // The messages saved to the session are left as they were.
    expect((msgs[0] as unknown as { content: { type: string }[] }).content[1]!.type).toBe('image');
  });

  it('salt okunur botta yazma aracı hiç verilmez', async () => {
    let names: string[] = [];
    faux.setResponses([
      (ctx) => {
        const sys = ctx.messages[0] as { toolsAdded?: { name: string }[] };
        names = (sys.toolsAdded ?? []).map((t) => t.name);
        return fauxAssistantMessage('ok');
      },
    ]);
    const { req } = request({
      sandbox: { cwd, additionalDirectories: [], writable: [], internet: true, readOnly: true },
    });
    await engine().run(req);
    expect(names).toEqual(expect.arrayContaining(['read_file', 'list_files', 'grep']));
    expect(names).not.toContain('write_file');
    expect(names).not.toContain('edit_file');
  });

  it('uygulama araçlarını izin adıyla sorar ve çalıştırır', async () => {
    const calls: unknown[] = [];
    const tool: AppTool = {
      name: 'memory_search',
      description: 'ara',
      input: { query: z.string() },
      readOnly: true,
      internal: true,
      handler: async (args) => {
        calls.push(args);
        return 'bulundu';
      },
    };
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('memory_search', { query: 'kahve' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Buldum.'),
    ]);
    const out = await engine().run(request({ tools: [tool] }).req);
    expect(out.ok).toBe(true);
    expect(asks.map((a) => a.toolName)).toEqual(['mcp__leafbot__memory_search']);
    expect(calls).toEqual([{ query: 'kahve' }]);
  });

  it('bağlantı araçlarını kendi adıyla, verilen JSON şemasıyla sunar', async () => {
    const calls: unknown[] = [];
    const schema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    const remote: AppTool = {
      name: 'search',
      server: 'notion',
      description: 'Notion araması',
      input: {},
      jsonSchema: schema,
      readOnly: true,
      internal: false,
      handler: async (args) => {
        calls.push(args);
        return 'sonuç';
      },
    };
    const own: AppTool = {
      name: 'bots_list',
      description: 'botlar',
      input: {},
      readOnly: true,
      internal: true,
      handler: async () => 'yok',
    };
    let seen: { name: string; parameters: unknown }[] = [];
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('notion__search', { q: 'plan' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('Tamam.'),
    ]);
    const watching = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async (p) => keys[p] ?? null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      streamFn: ((model, context, options) => {
        seen = context.messages
          .flatMap((m) => (m.role === 'system' ? (m.toolsAdded ?? []) : []))
          .map((x) => ({ name: x.name, parameters: x.parameters }));
        return streamSimple(model, context, options);
      }) as StreamFn,
    });
    const out = await watching.run(request({ tools: [remote, own] }).req);
    expect(out.ok).toBe(true);
    expect(seen.find((x) => x.name === 'notion__search')?.parameters).toEqual(schema);
    // The app's own tools keep their Zod-made schema.
    expect(seen.find((x) => x.name === 'bots_list')?.parameters).toMatchObject({
      type: 'object',
      additionalProperties: false,
    });
    expect(asks.map((a) => a.toolName)).toEqual(['mcp__notion__search']);
    expect(calls).toEqual([{ q: 'plan' }]);
  });

  it('planla açılan oturumun jetonunu ve planın adresini modele verir', async () => {
    let seen: { key?: string; baseUrl?: string } = {};
    const signedIn = new PiEngine({
      sessionsDir: join(dir, 'sessions'),
      apiKey: async () => null,
      auth: async (p) =>
        p === 'deneme' ? { apiKey: 'plan-jetonu', baseUrl: 'https://api.plan.example' } : null,
      resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
      streamFn: ((model, context, options) => {
        seen = { key: options?.apiKey, baseUrl: model.baseUrl };
        return streamSimple(model, context, options);
      }) as StreamFn,
    });
    faux.setResponses([fauxAssistantMessage('Selam!')]);
    const { req } = request();
    expect(await signedIn.run(req)).toMatchObject({ ok: true });
    expect(seen).toEqual({ key: 'plan-jetonu', baseUrl: 'https://api.plan.example' });
  });

  it('anahtar yoksa ya da model biçimi yanlışsa açık bir hata verir', async () => {
    keys = {};
    const noKey = await engine().run(request().req);
    expect(noKey).toMatchObject({ ok: false, kind: 'engine' });
    expect(!noKey.ok && noKey.message).toContain('API anahtarı yok');

    const bad = await engine().run(request({ model: 'sonnet' }).req);
    expect(!bad.ok && bad.message).toContain('sağlayıcı/model');

    const unknown = await engine().run(request({ model: 'yok/m9' }).req);
    expect(!unknown.ok && unknown.message).toContain('Model bulunamadı');
  });

  it('model hatasında geçmişi bozmaz', async () => {
    faux.setResponses([fauxAssistantMessage('ilk')]);
    const first = await engine().run(request().req);
    faux.setResponses([
      fauxAssistantMessage([fauxText('')], { stopReason: 'error', errorMessage: '429 çok fazla istek' }),
    ]);
    const failed = await engine().run(request({ sessionId: first.sessionId }).req);
    expect(failed).toMatchObject({ ok: false, kind: 'limit', provider: 'deneme' });
    expect(!failed.ok && failed.message).toContain('429');
    const saved = JSON.parse(readFileSync(join(dir, 'sessions', `${first.sessionId}.json`), 'utf8'));
    expect(saved.messages).toHaveLength(2);
  });

  it('durdurulunca yarıda keser', async () => {
    const { req, ctrl } = request();
    faux.setResponses([
      async () => {
        ctrl.abort();
        await new Promise((r) => setTimeout(r, 20));
        return fauxAssistantMessage('geç kaldı');
      },
    ]);
    const out = await engine().run(req);
    expect(out).toMatchObject({ ok: false, kind: 'interrupted' });
  });

  describe('danışman', () => {
    type Ctx = { messages: { role: string; content: unknown; toolsAdded?: { name: string }[] }[] };
    const toolsOf = (ctx: Ctx) =>
      ctx.messages.filter((m) => m.role === 'system').flatMap((m) => (m.toolsAdded ?? []).map((x) => x.name));
    const isHelper = (ctx: Ctx) => JSON.stringify(ctx.messages).includes('yardımcı bir ajansın');
    const ask = (...questions: string[]) =>
      fauxAssistantMessage(
        questions.map((q, i) => fauxToolCall('Advisor', { question: q }, { id: `d${i + 1}` })),
        { stopReason: 'toolUse' },
      );
    const results = (ctx: Ctx) =>
      ctx.messages.filter((m) => m.role === 'toolResult').map((m) => JSON.stringify(m.content));
    /** An engine whose advisor answers come from `complete`; each request it got is kept. */
    const advised = (complete: (system: string, user: string) => string | Promise<string>) => {
      const asked: { model: string; system: string; user: string }[] = [];
      const pi = new PiEngine({
        sessionsDir: join(dir, 'sessions'),
        apiKey: async (p) => keys[p] ?? null,
        resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
        complete: (async (model, ctx) => {
          const user = String(ctx.messages[0]!.content);
          asked.push({ model: model.id, system: ctx.systemPrompt ?? '', user });
          const reply = fauxAssistantMessage(await complete(ctx.systemPrompt ?? '', user));
          return { ...reply, usage: { ...reply.usage, cost: { ...reply.usage.cost, total: 0.05 } } };
        }) as typeof completeSimple,
      });
      return { pi, asked };
    };

    it('ayar yoksa ya da bot zaten o modeldeyse araç sunulmaz', async () => {
      const offered: string[][] = [];
      const reply = (ctx: Ctx) => {
        offered.push(toolsOf(ctx));
        return fauxAssistantMessage('tamam');
      };
      faux.setResponses([reply, reply, reply]);
      await engine().run(request().req);
      await engine().run(request({ advisorModel: 'deneme/m1' }).req);
      await engine().run(request({ advisorModel: 'deneme/dusunen' }).req);
      expect(offered[0]).not.toContain('Advisor');
      expect(offered[1]).not.toContain('Advisor');
      expect(offered[2]).toContain('Advisor');
    });

    it('danışman talimatı, son araç sonucunu ve soruyu görür; cevabı bota döner, maliyeti tura sayılır', async () => {
      writeFileSync(join(cwd, 'not.txt'), 'GİZLİ-SONUÇ-42');
      const { pi, asked } = advised(() => 'Önce dosyanın tarihine bak.');
      let back: string[] = [];
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('read_file', { path: 'not.txt' })], { stopReason: 'toolUse' }),
        ask('Bu sonuca güvenebilir miyim?'),
        (ctx) => {
          back = results(ctx as unknown as Ctx);
          return fauxAssistantMessage('Bakıyorum.');
        },
      ]);
      const out = await pi.run(request({ advisorModel: 'deneme/dusunen' }).req);
      expect(out).toMatchObject({ ok: true, text: 'Bakıyorum.' });
      expect(asked).toHaveLength(1);
      expect(asked[0]!.model).toBe('dusunen');
      expect(asked[0]!.system).toContain('You advise an assistant bot');
      expect(asked[0]!.user).toContain('Sen bir test botusun.');
      expect(asked[0]!.user).toContain('GİZLİ-SONUÇ-42');
      expect(asked[0]!.user).toContain('<question>\nBu sonuca güvenebilir miyim?');
      expect(back.at(-1)).toContain('Önce dosyanın tarihine bak.');
      expect(out.costUsd).toBeGreaterThanOrEqual(0.05);
      // No approval card: asking for advice changes nothing.
      expect(asks.map((a) => a.toolName)).not.toContain('Advisor');
    });

    it('danışman cevap veremezse tur sürer; bir turda en fazla üç soru gider', async () => {
      let n = 0;
      const { pi, asked } = advised(() => {
        if (++n === 1) throw new Error('sağlayıcı kapalı');
        return 'TAVSİYE';
      });
      let back: string[] = [];
      faux.setResponses([
        ask('bir', 'iki', 'üç', 'dört'),
        (ctx) => {
          back = results(ctx as unknown as Ctx);
          return fauxAssistantMessage('Kendim hallettim.');
        },
      ]);
      const out = await pi.run(request({ advisorModel: 'deneme/dusunen' }).req);
      expect(out).toMatchObject({ ok: true, text: 'Kendim hallettim.' });
      expect(asked).toHaveLength(3);
      expect(back).toHaveLength(4);
      expect(back.some((r) => r.includes('sağlayıcı kapalı'))).toBe(true);
      expect(back.filter((r) => r.includes('TAVSİYE'))).toHaveLength(2);
      expect(back.some((r) => r.includes('3 kez soruldu'))).toBe(true);
    });

    it('durdurulunca danışmanın cevabı beklenmez', async () => {
      const { req, ctrl } = request({ advisorModel: 'deneme/dusunen' });
      let cut = false;
      const pi = new PiEngine({
        sessionsDir: join(dir, 'sessions'),
        apiKey: async (p) => keys[p] ?? null,
        resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
        complete: (async (_model, _ctx, options) => {
          setTimeout(() => ctrl.abort(), 10);
          await new Promise<void>((resolve) =>
            options!.signal!.addEventListener('abort', () => {
              cut = true;
              resolve();
            }),
          );
          return fauxAssistantMessage('', { stopReason: 'aborted' });
        }) as typeof completeSimple,
      });
      faux.setResponses([ask('ne yapayım?'), fauxAssistantMessage('geç kaldı')]);
      const out = await pi.run(req);
      expect(cut).toBe(true);
      expect(out).toMatchObject({ ok: false, kind: 'interrupted' });
    });

    it('danışmana en yeni mesajlar gider; tek başına sığmayan son mesaj kesilerek yine gider', () => {
      const msg = (i: number, size: number) => ({
        role: 'user' as const,
        content: `${i} ${'z'.repeat(size)}`,
        timestamp: i,
      });
      const few = recentTranscript([msg(0, 100), msg(1, 100)], 8_000);
      expect(few.dropped).toBe(false);
      expect(few.text.indexOf('0 ')).toBeLessThan(few.text.indexOf('1 '));
      const many = recentTranscript(
        Array.from({ length: 10 }, (_, i) => msg(i, 3_000)),
        8_000,
      );
      expect(many.dropped).toBe(true);
      expect(many.text.length).toBeLessThanOrEqual(8_000);
      expect(many.text).toContain('9 ');
      expect(many.text).not.toContain('0 z');
      const huge = recentTranscript([msg(0, 100), msg(1, 3_000)], 1_000);
      expect(huge.dropped).toBe(true);
      expect(huge.text.length).toBeGreaterThan(900);
      expect(huge.text.length).toBeLessThanOrEqual(1_000);
      expect(huge.text).toContain('1 z');
    });

    it('danışmanın sağlayıcısının anahtarı yoksa araç sunulmaz', async () => {
      const offered: string[][] = [];
      faux.setResponses([
        (ctx) => {
          offered.push(toolsOf(ctx as unknown as Ctx));
          return fauxAssistantMessage('tamam');
        },
      ]);
      const pi = new PiEngine({
        sessionsDir: join(dir, 'sessions'),
        apiKey: async (p) => (p === 'deneme' ? keys[p]! : null),
        resolveModel: (p, id) => faux.getModel(id) ?? (p === 'baska' ? faux.getModel('m1') : undefined),
      });
      await pi.run(request({ advisorModel: 'baska/m1' }).req);
      expect(offered[0]).not.toContain('Advisor');
    });

    it('yardımcı ajanlara danışman verilmez', async () => {
      const helperTools: string[][] = [];
      const reply = (ctx: Ctx) => {
        if (isHelper(ctx)) {
          helperTools.push(toolsOf(ctx));
          return fauxAssistantMessage('yardım bitti');
        }
        if (!results(ctx).length) {
          return fauxAssistantMessage(
            [fauxToolCall('Agent', { description: 'İş', prompt: 'iş' }, { id: 'g1' })],
            { stopReason: 'toolUse' },
          );
        }
        return fauxAssistantMessage('tamam');
      };
      faux.setResponses([reply, reply, reply]);
      const out = await engine().run(request({ advisorModel: 'deneme/dusunen' }).req);
      expect(out).toMatchObject({ ok: true, text: 'tamam' });
      expect(helperTools).toHaveLength(1);
      expect(helperTools[0]).not.toContain('Advisor');
    });
  });

  describe('alt ajanlar', () => {
    // Words of the helper's own system prompt, which tell its requests from the bot's.
    const HELPER = 'yardımcı bir ajansın';
    // A request carries its system prompt and the tools it offers as system messages.
    type Ctx = { messages: { role: string; content: unknown; toolsAdded?: { name: string }[] }[] };
    const system = (ctx: Ctx) => ctx.messages.filter((m) => m.role === 'system');
    const isHelper = (ctx: Ctx) => system(ctx).some((m) => String(m.content).includes(HELPER));
    const toolsOf = (ctx: Ctx) => system(ctx).flatMap((m) => (m.toolsAdded ?? []).map((x) => x.name));
    const helpers = (n: number) =>
      fauxAssistantMessage(
        Array.from({ length: n }, (_, i) =>
          fauxToolCall(
            'Agent',
            { description: `Görev ${i + 1}`, prompt: `görev-${i + 1}` },
            { id: `g${i + 1}` },
          ),
        ),
        { stopReason: 'toolUse' },
      );
    /** Each subagent's states in the order its card heard them. */
    const track = () => {
      const states = new Map<string, string[]>();
      const last = new Map<string, SubagentState>();
      let peak = 0;
      const onSubagent = (s: SubagentState) => {
        states.set(s.id, [...(states.get(s.id) ?? []), s.state]);
        last.set(s.id, s);
        peak = Math.max(peak, [...last.values()].filter((x) => x.state === 'running').length);
      };
      return { states, last, onSubagent, peak: () => peak };
    };

    it('aynı mesajdaki alt ajanlar birlikte çalışır; kartları izlenir, cevapları bota döner', async () => {
      // The first helper's request waits for the second: only helpers that run together both get through.
      let arrived = 0;
      let firstHeld = false;
      let together = false;
      let bothIn!: () => void;
      const second = new Promise<void>((r) => (bothIn = r));
      const parallel = new PiEngine({
        sessionsDir: join(dir, 'sessions'),
        apiKey: async (p) => keys[p] ?? null,
        resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
        streamFn: (async (model, context, options) => {
          if (isHelper(context as unknown as Ctx) && ++arrived <= 2) {
            if (arrived === 2) {
              // Together only if the first is still held when the second comes.
              together = firstHeld;
              bothIn();
            } else {
              firstHeld = true;
              await Promise.race([second, new Promise((r) => setTimeout(r, 2000))]);
              firstHeld = false;
            }
          }
          return streamSimple(model, context, options);
        }) as StreamFn,
      });
      const results: string[] = [];
      const reply = (ctx: Ctx) => {
        if (isHelper(ctx)) {
          return fauxAssistantMessage(
            JSON.stringify(ctx.messages).includes('görev-1') ? 'Kira 900.' : 'Kedi olur.',
          );
        }
        const done = ctx.messages.filter((m) => m.role === 'toolResult');
        if (!done.length) return helpers(2);
        results.push(...done.map((m) => JSON.stringify(m.content)));
        return fauxAssistantMessage('İkisi de tamam.');
      };
      faux.setResponses(Array.from({ length: 6 }, () => reply));
      const seen = track();
      const out = await parallel.run(request({ onSubagent: seen.onSubagent }).req);
      expect(out).toMatchObject({ ok: true, text: 'İkisi de tamam.' });
      expect(together).toBe(true);
      expect(seen.states.get('g1')).toEqual(['waiting', 'running', 'done']);
      expect(seen.last.get('g1')).toMatchObject({
        description: 'Görev 1',
        state: 'done',
        result: 'Kira 900.',
      });
      expect(seen.last.get('g2')).toMatchObject({ state: 'done', result: 'Kedi olur.' });
      expect(results.join(' ')).toContain('Kira 900.');
      expect(results.join(' ')).toContain('Kedi olur.');
      // Starting a helper asks no one; its own steps would.
      expect(asks.map((a) => a.toolName)).not.toContain('Agent');
    });

    it('aynı anda çalışan alt ajan sayısı sınırlıdır; fazlası bekler, sonra çalışır', async () => {
      const n = SUBAGENTS_AT_ONCE + 1;
      const reply = (ctx: Ctx) => {
        if (isHelper(ctx)) return fauxAssistantMessage('Tamam.');
        return ctx.messages.some((m) => m.role === 'toolResult')
          ? fauxAssistantMessage('Bitti.')
          : helpers(n);
      };
      faux.setResponses(Array.from({ length: n + 3 }, () => reply));
      const seen = track();
      const out = await engine().run(request({ onSubagent: seen.onSubagent }).req);
      expect(out).toMatchObject({ ok: true, text: 'Bitti.' });
      expect(seen.peak()).toBe(SUBAGENTS_AT_ONCE);
      expect([...seen.last.values()].map((s) => s.state)).toEqual(Array.from({ length: n }, () => 'done'));
      // The last one waited while the others held every place.
      const order = [...seen.states.entries()];
      expect(order).toHaveLength(n);
      expect(seen.states.get(`g${n}`)).toEqual(['waiting', 'running', 'done']);
    });

    it('durdurulan tur çalışan ve sırada bekleyen alt ajanları durdurur', async () => {
      // Helpers' requests hang until they are aborted; one that never is gives up after a while.
      let sent = 0;
      let aborted = 0;
      const held = new PiEngine({
        sessionsDir: join(dir, 'sessions'),
        apiKey: async (p) => keys[p] ?? null,
        resolveModel: (p, id) => (p === 'deneme' ? faux.getModel(id) : undefined),
        streamFn: (async (model, context, options) => {
          if (isHelper(context as unknown as Ctx)) {
            sent++;
            await new Promise<void>((resolve) => {
              const end = () => {
                aborted++;
                clearTimeout(timer);
                resolve();
              };
              const timer = setTimeout(resolve, 5000);
              if (options?.signal?.aborted) end();
              else options?.signal?.addEventListener('abort', end);
            });
          }
          return streamSimple(model, context, options);
        }) as StreamFn,
      });
      const n = SUBAGENTS_AT_ONCE + 2;
      faux.setResponses([helpers(n), ...Array.from({ length: n + 2 }, () => fauxAssistantMessage('Yarım.'))]);
      const seen = track();
      const { req, ctrl } = request({
        onSubagent: (s) => {
          seen.onSubagent(s);
          if (seen.peak() === SUBAGENTS_AT_ONCE) ctrl.abort();
        },
      });
      const began = Date.now();
      const out = await held.run(req);
      expect(out).toMatchObject({ ok: false, kind: 'interrupted' });
      expect(Date.now() - began).toBeLessThan(4000);
      // Every request a helper got out ended with the stop; how many got out depends on timing.
      expect(sent).toBeLessThanOrEqual(SUBAGENTS_AT_ONCE);
      expect(aborted).toBe(sent);
      expect([...seen.last.values()].map((s) => s.state)).toEqual(Array.from({ length: n }, () => 'stopped'));
      // The ones still in line never started.
      expect(seen.states.get(`g${n}`)).toEqual(['waiting', 'stopped']);
    });

    it('alt ajanın kendi adımları sorulur; ona alt ajan aracı verilmez', async () => {
      const offered: { helper: boolean; tools: string[] }[] = [];
      const reply = (ctx: Ctx) => {
        offered.push({ helper: isHelper(ctx), tools: toolsOf(ctx) });
        if (isHelper(ctx)) {
          return ctx.messages.some((m) => m.role === 'toolResult')
            ? fauxAssistantMessage('Yazdım.')
            : fauxAssistantMessage([fauxToolCall('write_file', { path: 'yardim.txt', content: 'x' })], {
                stopReason: 'toolUse',
              });
        }
        return ctx.messages.some((m) => m.role === 'toolResult')
          ? fauxAssistantMessage('Bitti.')
          : helpers(1);
      };
      faux.setResponses(Array.from({ length: 6 }, () => reply));
      const seen = track();
      expect(await engine().run(request({ onSubagent: seen.onSubagent }).req)).toMatchObject({ ok: true });
      expect(asks.map((a) => a.toolName)).toEqual(['Write']);
      expect(readFileSync(join(cwd, 'yardim.txt'), 'utf8')).toBe('x');
      expect(seen.last.get('g1')).toMatchObject({
        state: 'done',
        steps: 1,
        tool: 'Write',
        result: 'Yazdım.',
      });
      expect(offered.find((o) => !o.helper)!.tools).toContain('Agent');
      expect(offered.find((o) => o.helper)!.tools).not.toContain('Agent');
    });

    it('araç seçiminden çıkarılan alt ajan aracı modele hiç sunulmaz', async () => {
      const offered: string[][] = [];
      faux.setResponses([
        (ctx: Ctx) => {
          offered.push(toolsOf(ctx));
          return fauxAssistantMessage('Selam.');
        },
      ]);
      await engine().run(request({ pickTool: (name) => name !== 'Agent' }).req);
      expect(offered[0]).not.toContain('Agent');
      expect(offered[0]).toContain('read_file');
    });

    it('sınırlayıcı sırayla yer verir; iptal edilen bekleyen sıradan çıkar', async () => {
      const slots = limiter(1);
      const free = (await slots.acquire(new AbortController().signal))!;
      const gone = new AbortController();
      const waiting = slots.acquire(gone.signal);
      const next = slots.acquire(new AbortController().signal);
      gone.abort();
      expect(await waiting).toBeNull();
      free();
      const got = await next;
      expect(got).toBeTypeOf('function');
      // Freeing twice gives back one place only.
      got!();
      got!();
      const a = await slots.acquire(new AbortController().signal);
      let b: unknown = 'bekliyor';
      void slots.acquire(new AbortController().signal).then((x) => (b = x));
      await new Promise((r) => setTimeout(r, 10));
      expect(a).toBeTypeOf('function');
      expect(b).toBe('bekliyor');
      const stopped = new AbortController();
      stopped.abort();
      expect(await slots.acquire(stopped.signal)).toBeNull();
    });
  });

  describe('bağlam', () => {
    /** A model of a small window, and summaries written by `complete`. */
    const small = (complete?: typeof completeSimple, window = 20_000) =>
      new PiEngine({
        sessionsDir: join(dir, 'sessions'),
        apiKey: async (p) => keys[p] ?? null,
        resolveModel: (p, id) =>
          p === 'deneme' ? { ...faux.getModel(id)!, contextWindow: window, maxTokens: 1_000 } : undefined,
        ...(complete && { complete }),
      });
    /** A session saved before summaries existed, with `n` long exchanges. */
    const oldSession = (n: number) => {
      const id = '11111111-2222-3333-4444-555555555555';
      const messages = [];
      for (let i = 0; i < n; i++) {
        messages.push({ role: 'user', content: `<eski-${i}> ${'x'.repeat(3_000)}`, timestamp: 1_000 + i });
        messages.push(fauxAssistantMessage(`<cevap-${i}> ${'y'.repeat(3_000)}`));
      }
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      writeFileSync(join(dir, 'sessions', `${id}.json`), JSON.stringify({ version: 1, messages }));
      return id;
    };
    /** The first message of the conversation; the system prompt goes before it. */
    const firstText = (ctx: { messages: { role: string; content: unknown }[] }) =>
      JSON.stringify(ctx.messages.find((m) => m.role !== 'system')!.content);
    const allText = (ctx: { messages: unknown[] }) => JSON.stringify(ctx.messages);
    /** The tool a bot looks up earlier talk with. */
    const recallTool: AppTool = {
      name: 'conversations_search',
      description: 'Geçmiş sohbetlerde ara.',
      input: { query: z.string() },
      readOnly: true,
      internal: true,
      handler: async () => 'yok',
    };

    it('pencereye sığmayan eski kısmı bir kez özetler; sonraki tur özeti yeniden yazmaz', async () => {
      const id = oldSession(20);
      const asked: string[] = [];
      const complete = (async (_m, ctx) => {
        asked.push(String(ctx.messages[0]!.content));
        const reply = fauxAssistantMessage('ÖZET: ilk iş konuşuldu');
        return { ...reply, usage: { ...reply.usage, cost: { ...reply.usage.cost, total: 0.01 } } };
      }) as typeof completeSimple;
      const seen: { messages: unknown[] }[] = [];
      faux.setResponses([
        (ctx) => {
          seen.push(ctx as never);
          return fauxAssistantMessage('tamam');
        },
      ]);
      let compacted = 0;
      const out = await small(complete).run(
        request({ sessionId: id, prompt: 'devam', tools: [recallTool], onCompacted: () => compacted++ }).req,
      );
      expect(out).toMatchObject({ ok: true, text: 'tamam' });
      // What the summaries cost counts toward the turn.
      expect(out.costUsd).toBeGreaterThanOrEqual(0.01 * asked.length);
      expect(asked.length).toBeGreaterThan(0);
      expect(asked[0]).toContain('<eski-0>');
      expect(compacted).toBe(1);
      expect(firstText(seen[0] as never)).toContain('ÖZET');
      expect(firstText(seen[0] as never)).toContain('conversations_search');
      expect(allText(seen[0] as never)).not.toContain('<eski-0> ');
      expect(allText(seen[0] as never)).toContain('<eski-19>');
      const saved = JSON.parse(readFileSync(join(dir, 'sessions', `${id}.json`), 'utf8'));
      expect(saved).toMatchObject({ version: 2, summary: expect.stringContaining('ÖZET') });
      expect(saved.folded).toBeGreaterThan(0);
      // The whole history stays on disk.
      expect(saved.messages).toHaveLength(42);
      expect(saved.messages[saved.folded].role).toBe('user');

      const calls = asked.length;
      faux.setResponses([
        (ctx) => {
          seen.push(ctx as never);
          return fauxAssistantMessage('yine tamam');
        },
      ]);
      const again = await small(complete).run(request({ sessionId: id, prompt: 'sonra' }).req);
      expect(again).toMatchObject({ ok: true, text: 'yine tamam' });
      expect(asked).toHaveLength(calls);
      expect(firstText(seen[1] as never)).toContain('ÖZET');
    });

    it('özeti botun kendi modeline özetleme talimatıyla yazdırır', async () => {
      const id = oldSession(20);
      let summaries = 0;
      let answered = '';
      const reply = (ctx: { systemPrompt?: string; messages: { role: string; content: unknown }[] }) => {
        // The provider gets the system prompt as the conversation's first, system message.
        if (ctx.messages[0]?.role === 'system' && ctx.messages[0].content === SUMMARY_SYSTEM) {
          summaries++;
          return fauxAssistantMessage(`MODEL-ÖZETİ ${summaries}`);
        }
        answered = firstText(ctx);
        return fauxAssistantMessage('tamam');
      };
      faux.setResponses(Array.from({ length: 8 }, () => reply as never));
      const out = await small().run(request({ sessionId: id, prompt: 'devam' }).req);
      expect(out).toMatchObject({ ok: true, text: 'tamam' });
      expect(summaries).toBeGreaterThan(0);
      // Each step builds on the summary before it; the last one is what the bot sees.
      expect(answered).toContain(`MODEL-ÖZETİ ${summaries}`);
    });

    it('tek uzun turda eski araç sonuçlarını çıkarır, sonuncusunu bırakır ve cevap verir', async () => {
      for (let i = 0; i < 6; i++)
        writeFileSync(join(cwd, `d${i}.txt`), `<dosya-${i}>\n${'veri satırı\n'.repeat(1_100)}`);
      const asked: number[] = [];
      const complete = (async () => {
        asked.push(1);
        return fauxAssistantMessage('özet');
      }) as typeof completeSimple;
      let sent = '';
      faux.setResponses([
        ...Array.from({ length: 6 }, (_, i) =>
          fauxAssistantMessage([fauxToolCall('read_file', { path: `d${i}.txt` })], { stopReason: 'toolUse' }),
        ),
        (ctx) => {
          sent = allText(ctx as never);
          return fauxAssistantMessage('hepsini okudum');
        },
      ]);
      const out = await small(complete).run(request({ prompt: 'hepsini oku' }).req);
      expect(out).toMatchObject({ ok: true, text: 'hepsini okudum' });
      // One user message: nothing to fold at, so no summary is asked for.
      expect(asked).toHaveLength(0);
      expect(sent).not.toContain('<dosya-0>');
      expect(sent).toContain('<dosya-5>');
      expect(sent).toContain('eski bir araç sonucu');
    });

    it('çok sayıda ekran görüntüsü, gönderilmeyenler sayılmadığı için özetlemeye yol açmaz', async () => {
      const id = '22222222-3333-4444-5555-666666666666';
      const pixel =
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const messages: unknown[] = [];
      for (let i = 0; i < 20; i++) {
        const call = fauxAssistantMessage([fauxToolCall('ekran', {})], { stopReason: 'toolUse' });
        const callId = (call.content[0] as { id: string }).id;
        messages.push({ role: 'user', content: `bak ${i}`, timestamp: i });
        messages.push(call);
        messages.push({
          role: 'toolResult',
          toolCallId: callId,
          toolName: 'ekran',
          content: [{ type: 'image', data: pixel, mimeType: 'image/png' }],
          isError: false,
          timestamp: i,
        });
        messages.push(fauxAssistantMessage(`gördüm ${i}`));
      }
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      writeFileSync(join(dir, 'sessions', `${id}.json`), JSON.stringify({ version: 1, messages }));
      const asked: number[] = [];
      const complete = (async () => {
        asked.push(1);
        return fauxAssistantMessage('özet');
      }) as typeof completeSimple;
      let sent = '';
      faux.setResponses([
        (ctx) => {
          sent = allText(ctx as never);
          return fauxAssistantMessage('tamam');
        },
      ]);
      const out = await small(complete).run(request({ sessionId: id, prompt: 'devam' }).req);
      expect(out.ok).toBe(true);
      expect(asked).toHaveLength(0);
      expect(sent).toContain('bak 0');
      expect(sent).toContain('daha eski bir görüntü');
    });

    it('önceki turun yanıtı yeni modelin penceresini aşsa da başka bir hatayı taşma saymaz', async () => {
      const id = '33333333-4444-5555-6666-777777777777';
      const old = fauxAssistantMessage('eski cevap');
      const big = { ...old, usage: { ...old.usage, input: 50_000, totalTokens: 50_000 } };
      mkdirSync(join(dir, 'sessions'), { recursive: true });
      writeFileSync(
        join(dir, 'sessions', `${id}.json`),
        JSON.stringify({ version: 1, messages: [{ role: 'user', content: 'eski', timestamp: 1 }, big] }),
      );
      const broken = new PiEngine({
        sessionsDir: join(dir, 'sessions'),
        apiKey: async (p) => keys[p] ?? null,
        resolveModel: (p, id2) =>
          p === 'deneme' ? { ...faux.getModel(id2)!, contextWindow: 20_000, maxTokens: 1_000 } : undefined,
        streamFn: (() => {
          throw new Error('socket hang up');
        }) as StreamFn,
      });
      const out = await broken.run(request({ sessionId: id, prompt: 'devam' }).req);
      expect(out.ok).toBe(false);
      expect(!out.ok && out.contextFull).toBeFalsy();
    });

    it('özet yazılamazsa tur yine cevap verir; en yeni eski mesajlar kelimesi kelimesine kalır', async () => {
      const id = oldSession(20);
      const complete = (async () => {
        throw new Error('özetleyici düştü');
      }) as typeof completeSimple;
      let sent = '';
      faux.setResponses([
        (ctx) => {
          sent = firstText(ctx as never);
          return fauxAssistantMessage('cevap');
        },
      ]);
      const out = await small(complete).run(request({ sessionId: id, prompt: 'devam' }).req);
      expect(out).toMatchObject({ ok: true, text: 'cevap' });
      expect(sent).toContain('özette yok');
      // Without the tools to look it up, the bot is not told to use them.
      expect(sent).not.toContain('conversations_search');
      expect(sent).not.toContain('<eski-0> ');
      const saved = JSON.parse(readFileSync(join(dir, 'sessions', `${id}.json`), 'utf8'));
      expect(saved).toMatchObject({ version: 2, lost: true });
      // The newest folded messages stand in for the summary, word for word.
      const lastFolded = saved.messages[saved.folded - 1].content[0].text.slice(0, 12);
      expect(lastFolded).toMatch(/^<cevap-\d+>/);
      expect(saved.summary).toContain(lastFolded);
      expect(saved.summary).toContain('No summary could be written');
      expect(sent).toContain(lastFolded);
    });

    it('özet yazılamayıp tur da düşerse kayıtlı oturum eski hâlinde kalır; özet sonra yazılır', async () => {
      const id = oldSession(20);
      const file = join(dir, 'sessions', `${id}.json`);
      const before = readFileSync(file, 'utf8');
      const complete = (async () => {
        throw new Error('429 çok fazla istek');
      }) as typeof completeSimple;
      faux.setResponses([fauxAssistantMessage([fauxText('')], { stopReason: 'error', errorMessage: '503' })]);
      const out = await small(complete).run(request({ sessionId: id, prompt: 'devam' }).req);
      expect(out.ok).toBe(false);
      // The excerpt that stood in for the summary is not kept: the next turn may write the summary.
      expect(readFileSync(file, 'utf8')).toBe(before);
    });

    it('durdurulan tur, yolda yazılan özeti saklar; sonraki tur yeniden ödemez', async () => {
      const id = oldSession(20);
      const { req, ctrl } = request({ sessionId: id, prompt: 'devam' });
      let calls = 0;
      const complete = (async () => {
        calls++;
        return fauxAssistantMessage('ÖZET: saklanan');
      }) as typeof completeSimple;
      faux.setResponses([
        () => {
          ctrl.abort();
          return fauxAssistantMessage([fauxText('')], { stopReason: 'aborted' });
        },
      ]);
      const out = await small(complete).run(req);
      expect(out).toMatchObject({ ok: false, kind: 'interrupted' });
      const saved = JSON.parse(readFileSync(join(dir, 'sessions', `${id}.json`), 'utf8'));
      expect(saved).toMatchObject({ version: 2, summary: 'ÖZET: saklanan' });
      // Only the history from before the stopped turn.
      expect(saved.messages).toHaveLength(40);
      const made = calls;
      faux.setResponses([fauxAssistantMessage('tamam')]);
      const again = await small(complete).run(request({ sessionId: id, prompt: 'sonra' }).req);
      expect(again.ok).toBe(true);
      expect(calls).toBe(made);
    });

    it('bağlam yine taşarsa özet yeni oturuma geçsin diye sonuçla döner', async () => {
      const id = oldSession(20);
      const complete = (async () => fauxAssistantMessage('ÖZET: devredilen')) as typeof completeSimple;
      faux.setResponses([
        fauxAssistantMessage([fauxText('')], {
          stopReason: 'error',
          errorMessage: 'Range of input length should be [1, 30720]',
        }),
      ]);
      const out = await small(complete).run(request({ sessionId: id, prompt: 'devam' }).req);
      expect(out).toMatchObject({ ok: false, contextFull: true, summary: 'ÖZET: devredilen' });
    });

    it('özet yazılırken turun sessiz sayılmaması için başlangıcı ve bitişi bildirir', async () => {
      const id = oldSession(20);
      const events: string[] = [];
      const complete = (async () => {
        events.push('özet');
        return fauxAssistantMessage('ÖZET: kısa');
      }) as typeof completeSimple;
      faux.setResponses([fauxAssistantMessage('tamam')]);
      const out = await small(complete).run(
        request({
          sessionId: id,
          prompt: 'devam',
          onCompacting: (on) => events.push(on ? 'başladı' : 'bitti'),
        }).req,
      );
      expect(out.ok).toBe(true);
      expect(events[0]).toBe('başladı');
      expect(events.at(-1)).toBe('bitti');
      expect(events).toContain('özet');
    });

    it('OpenAI doğrulayamadığı şifreli akıl yürütmeyi reddederse yeni oturumla devam edilsin diye oturum kayıp sayılır', async () => {
      const id = oldSession(2);
      faux.setResponses([
        fauxAssistantMessage([fauxText('')], {
          stopReason: 'error',
          errorMessage:
            '400 {"error":{"code":"invalid_encrypted_content","message":"The encrypted content gAAA could not be verified."}}',
        }),
      ]);
      const out = await engine().run(request({ sessionId: id, prompt: 'devam' }).req);
      expect(out).toMatchObject({ ok: false, kind: 'lostSession', sessionId: null });
    });

    it('özete sığmayan en eski kısmı kayıp sayar ve bota söyler', () => {
      const msgs = Array.from({ length: 12 }, (_, i) => ({
        role: 'user' as const,
        content: `${i} ${'z'.repeat(5_000)}`,
        timestamp: i,
      }));
      const { chunks, dropped } = transcriptChunks(msgs, 6_000);
      expect(chunks).toHaveLength(4);
      expect(dropped).toBe(true);
      expect(chunks.join('')).toContain('11 ');
      expect(transcriptChunks(msgs.slice(0, 2), 6_000).dropped).toBe(false);
    });

    it('özete sığmayan en eski kısım kayıp sayılır ve bota söylenir', async () => {
      const id = oldSession(60);
      const complete = (async () => fauxAssistantMessage('ÖZET: son kısım')) as typeof completeSimple;
      let sent = '';
      faux.setResponses([
        (ctx) => {
          sent = firstText(ctx as never);
          return fauxAssistantMessage('tamam');
        },
      ]);
      const out = await small(complete).run(request({ sessionId: id, prompt: 'devam' }).req);
      expect(out.ok).toBe(true);
      expect(sent).toContain('ÖZET: son kısım');
      expect(sent).toContain('özette yok');
      const saved = JSON.parse(readFileSync(join(dir, 'sessions', `${id}.json`), 'utf8'));
      expect(saved).toMatchObject({ summary: 'ÖZET: son kısım', lost: true });
    });

    it('pencereye sığan eski oturumu olduğu gibi okur, özet istemez', async () => {
      const id = oldSession(2);
      const complete = (async () => {
        throw new Error('çağrılmamalı');
      }) as typeof completeSimple;
      let sent = '';
      faux.setResponses([
        (ctx) => {
          sent = allText(ctx as never);
          return fauxAssistantMessage('tamam');
        },
      ]);
      const out = await small(complete).run(request({ sessionId: id, prompt: 'devam' }).req);
      expect(out.ok).toBe(true);
      expect(sent).toContain('<eski-0>');
      expect(sent).not.toContain('conversations_search');
    });

    it('çok uzun araç sonucunu pencereye göre keser, tamamını saklar ve gerisi sayfa sayfa okunur', async () => {
      writeFileSync(join(cwd, 'buyuk.txt'), 'satır\n'.repeat(40_000));
      const results: string[] = [];
      const last = (ctx: unknown) => {
        const r = (ctx as { messages: { role: string; content: { text?: string }[] }[] }).messages.findLast(
          (m) => m.role === 'toolResult',
        )!;
        results.push(r.content.map((c) => c.text ?? '').join(''));
        return results.at(-1)!;
      };
      let shown = 0;
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('read_file', { path: 'buyuk.txt' })], { stopReason: 'toolUse' }),
        (ctx) => {
          const [, id, offset] = /id "([^"]+)", offset (\d+)/.exec(last(ctx))!;
          shown = Number(offset);
          return fauxAssistantMessage([fauxToolCall(RESULT_TOOL, { id: id!, offset: shown, limit: 200 })], {
            stopReason: 'toolUse',
          });
        },
        (ctx) => {
          last(ctx);
          return fauxAssistantMessage([fauxToolCall(RESULT_TOOL, { id: 'yok' })], { stopReason: 'toolUse' });
        },
        (ctx) => {
          last(ctx);
          return fauxAssistantMessage('okudum');
        },
      ]);
      const out = await small().run(request({ prompt: 'oku' }).req);
      expect(out).toMatchObject({ ok: true, text: 'okudum' });
      expect(results[0]!.length).toBeLessThan(20_000);
      expect(results[0]).toContain('Tamamı bu sohbet için saklandı');
      // The page picks up at the line after the last one the cut part showed in whole.
      const lines = [...results[0]!.matchAll(/(\d+)\tsatır\n/g)];
      const next = Number(lines.at(-1)![1]) + 1;
      expect(results[1]).toContain(`(Saklanan sonucun ${shown}–${shown + 200} arası`);
      expect(results[1]).toContain(`${next}\tsatır`);
      expect(results[2]).toContain('"yok" diye saklanan bir sonuç yok');
    });

    it('dışarıdan gelen uzun sonucun saklanan parçaları da dış veri olarak işaretlenir', async () => {
      const page: AppTool = {
        name: 'sayfa',
        description: 'bir sayfa',
        input: {},
        readOnly: true,
        internal: false,
        handler: async () =>
          asOutsideData('örnek.com', `${'x'.repeat(100_000)}ARTIK TALİMAT`, translator('tr')),
      };
      let read = '';
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall('sayfa', {})], { stopReason: 'toolUse' }),
        (ctx) => {
          const r = (ctx as { messages: { role: string; content: { text?: string }[] }[] }).messages.findLast(
            (m) => m.role === 'toolResult',
          )!;
          const [, id] = /id "([^"]+)"/.exec(r.content.map((c) => c.text ?? '').join(''))!;
          return fauxAssistantMessage([fauxToolCall(RESULT_TOOL, { id: id!, offset: 99_000 })], {
            stopReason: 'toolUse',
          });
        },
        (ctx) => {
          const r = (ctx as { messages: { role: string; content: { text?: string }[] }[] }).messages.findLast(
            (m) => m.role === 'toolResult',
          )!;
          read = r.content.map((c) => c.text ?? '').join('');
          return fauxAssistantMessage('tamam');
        },
      ]);
      const out = await small().run(request({ prompt: 'oku', tools: [page] }).req);
      expect(out).toMatchObject({ ok: true });
      expect(read).toContain('ARTIK TALİMAT');
      expect(read).toContain('<outside-data source="örnek.com">');
    });

    it('sağlayıcının bağlam taşması sözünü, kendi ifadesi ne olursa olsun bildirir', async () => {
      faux.setResponses([
        fauxAssistantMessage([fauxText('')], {
          stopReason: 'error',
          errorMessage: 'Range of input length should be [1, 30720]',
        }),
      ]);
      const out = await engine().run(request().req);
      expect(out).toMatchObject({ ok: false, kind: 'engine', contextFull: true });
      expect(CONTEXT_FULL.test(!out.ok ? out.message : '')).toBe(false);
    });

    it('özeti hep bir kullanıcı mesajında keser; araç sonucunu çağrısından ayırmaz', () => {
      const u = (s: string) => ({ role: 'user', content: s, timestamp: 0 }) as never;
      const call = { role: 'assistant', content: [{ type: 'toolCall', name: 'x', arguments: {} }] } as never;
      const res = (s: string) =>
        ({ role: 'toolResult', toolName: 'x', content: [{ type: 'text', text: s }] }) as never;
      const big = 'z'.repeat(3_500);
      const msgs = [
        u(big),
        call,
        res(big),
        u(big),
        call,
        res(big),
        res(big),
        call,
        res(big),
        u('son'),
        call,
        res('r'),
      ];
      for (const keep of [10, 500, 1_500, 2_500, 4_000]) {
        const cut = cutPoint(msgs, 0, keep);
        expect((msgs as { role: string }[])[cut]!.role).toBe('user');
      }
      // Already folded up to the last user message: nowhere further to fold.
      expect(cutPoint(msgs, 9, 10)).toBe(9);
    });

    it('uzun turda eski araç sonuçlarını çıkarır, sonuncusunu bırakır', () => {
      const res = (s: string) =>
        ({ role: 'toolResult', toolName: 'x', content: [{ type: 'text', text: s }] }) as never;
      const msgs = [res('a'.repeat(7_000)), res('b'.repeat(7_000)), res('c'.repeat(7_000))];
      const out = elideResults(msgs, 3_000, 'çıkarıldı') as { content: { text: string }[] }[];
      expect(out[0]!.content[0]!.text).toBe('çıkarıldı');
      expect(out[2]!.content[0]!.text).toHaveLength(7_000);
      expect(elideResults(msgs, 100_000, 'x')).toBe(msgs);
    });

    it('alıntı yedeği sınırlı kalır, en yenileri tutar ve önceki özeti korur', () => {
      const msgs = Array.from({ length: 30 }, (_, i) => ({
        role: 'user',
        content: `<m-${i}> ${'q'.repeat(2_000)}`,
        timestamp: 0,
      })) as never[];
      const out = excerptSummary('ÖNCEKİ', msgs);
      expect(out.startsWith('ÖNCEKİ')).toBe(true);
      expect(out).toContain('<m-29>');
      expect(out).not.toContain('<m-0>');
      expect(out.length).toBeLessThan(EXCERPT_CHARS + 500);
      // Failures in a row do not pile up.
      let s = '';
      for (let i = 0; i < 10; i++) s = excerptSummary(s, msgs);
      expect(s.length).toBeLessThan(20_000);
      expect(excerptSummary(null, [])).toBe('');
    });

    it('özeti ilk kullanıcı mesajının başına koyar; metni de parçalı içeriği de bozmaz', () => {
      const a = withSummary([{ role: 'user', content: 'soru', timestamp: 1 }], 'ÖZET') as never as {
        content: { text: string }[];
      }[];
      expect(a[0]!.content.map((c) => c.text)).toEqual(['ÖZET', 'soru']);
      const b = withSummary(
        [{ role: 'user', content: [{ type: 'text', text: 'parça' }], timestamp: 1 }],
        'ÖZET',
      );
      expect(JSON.stringify(b)).toBe(
        JSON.stringify([
          {
            role: 'user',
            content: [
              { type: 'text', text: 'ÖZET' },
              { type: 'text', text: 'parça' },
            ],
            timestamp: 1,
          },
        ]),
      );
      expect(capText('kısa', 10, () => 'not')).toBe('kısa');
      expect(capText('x'.repeat(20), 10, (shown, total) => `${shown}/${total}`)).toBe(
        `${'x'.repeat(10)}\n\n10/20`,
      );
    });
  });
});

describe('motor değişimi', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('bot motor değiştirince eski oturumlar devam ettirilmez', async () => {
    const bot = await t.bot({ name: 'Değişken' });
    const thread = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.services.threads.setSession(thread.id, '11111111-2222-3333-4444-555555555555');
    await t.api('PATCH', `/api/bots/${bot.id}`, { model: 'opus' });
    expect((await t.services.threads.row(thread.id)).engineSessionId).not.toBeNull();
    await t.api('PATCH', `/api/bots/${bot.id}`, { engine: 'pi', model: 'openai/gpt-4o-mini' });
    expect((await t.services.threads.row(thread.id)).engineSessionId).toBeNull();
  });
});

describe('sağlayıcı anahtarları', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('anahtarı saklar ama API yalnızca ipucunu döndürür', async () => {
    const put = await t.api('PUT', '/api/providers/openai/key', { key: 'sk-test-abcdefgh1234' });
    expect(put.status).toBe(200);
    const list = await t.api<ProviderInfo[]>('GET', '/api/providers');
    const openai = list.body.find((p) => p.id === 'openai')!;
    expect(openai).toEqual({ id: 'openai', configured: true, hint: '…1234', signIn: { signedIn: false } });
    expect(JSON.stringify(list.body)).not.toContain('abcdefgh');
    expect(await t.services.keys.get('openai')).toBe('sk-test-abcdefgh1234');
    // Settings never include secrets.
    expect(JSON.stringify((await t.api('GET', '/api/settings')).body)).not.toContain('sk-test');

    expect((await t.api('DELETE', '/api/providers/openai/key')).status).toBe(200);
    expect(await t.services.keys.get('openai')).toBeNull();
  });

  it('abonelik jetonlarını ve bilinmeyen sağlayıcıları reddeder', async () => {
    const oat = await t.api('PUT', '/api/providers/anthropic/key', { key: 'sk-ant-oat01-xxxxxxxxxxxx' });
    expect(oat.status).toBe(400);
    expect((await t.api('PUT', '/api/providers/uydurma/key', { key: 'abcdefghijk' })).status).toBe(404);
    expect((await t.api('PUT', '/api/providers/github-copilot/key', { key: 'abcdefghijk' })).status).toBe(
      404,
    );
    const models = await t.api<string[]>('GET', '/api/providers/openai/models');
    expect(models.body.length).toBeGreaterThan(0);
  });

  it('modeli denemeden önce anahtarı ve modeli doğrular', async () => {
    const [model] = (await t.api<string[]>('GET', '/api/providers/openai/models')).body;
    const before = await t.api('POST', '/api/providers/openai/test', { model });
    expect(before.status).toBe(400);
    await t.api('PUT', '/api/providers/openai/key', { key: 'sk-test-abcdefgh1234' });
    expect((await t.api('POST', '/api/providers/openai/test', { model })).body).toEqual({ ok: true });
    // A model the catalog does not list yet is tried as well; the request tells whether it exists.
    expect((await t.api('POST', '/api/providers/openai/test', { model: 'yeni-cikan-model' })).body).toEqual({
      ok: true,
    });
    expect((await t.api('POST', '/api/providers/openai/test', { model: 'hata-model' })).body).toMatchObject({
      ok: false,
    });
    expect((await t.api('POST', '/api/providers/uydurma/test', { model })).status).toBe(404);
  });

  it('katalogda olmayan modeli sağlayıcının en benzer modelinin ayarlarıyla kurar', async () => {
    const listed = (await t.api<string[]>('GET', '/api/providers/openai/models')).body;
    const base = listed.find((m) => m.startsWith('gpt-'))!;
    const made = await t.services.keys.customModel('openai', `${base}-yeni`);
    expect(made).toMatchObject({
      id: `${base}-yeni`,
      name: `${base}-yeni`,
      provider: 'openai',
      cost: { input: 0, output: 0 },
    });
    expect(made?.api).toBeTruthy();
    expect(made?.baseUrl).toMatch(/^https:/);
    // Subscription-only and unknown providers are not given made-up models.
    expect(await t.services.keys.customModel('github-copilot', 'gpt-x')).toBeUndefined();
    expect(await t.services.keys.customModel('uydurma', 'gpt-x')).toBeUndefined();
  });

  it('anahtarı kasa anahtarıyla şifreli saklar; eski düz anahtarı okurken şifreler', async () => {
    await t.api('PUT', '/api/providers/openai/key', { key: 'sk-test-abcdefgh1234' });
    const stored = async (k: string) =>
      String((await t.db.db.select().from(schema.kv).where(eq(schema.kv.key, k)))[0]?.value);
    expect(await stored('secret.apikey.openai')).toMatch(/^v1:/);
    expect(await stored('secret.apikey.openai')).not.toContain('abcdefgh');

    await t.db.db.insert(schema.kv).values({ key: 'secret.apikey.groq', value: 'gsk-eski-duz-anahtar' });
    expect(await t.services.keys.get('groq')).toBe('gsk-eski-duz-anahtar');
    expect(await stored('secret.apikey.groq')).toMatch(/^v1:/);
    const groq = (await t.api<ProviderInfo[]>('GET', '/api/providers')).body.find((p) => p.id === 'groq');
    expect(groq?.hint).toBe('…htar');
  });

  describe('kendi uç noktası', () => {
    let server: Server;
    let base: string;
    let auth: (string | undefined)[];
    beforeEach(async () => {
      auth = [];
      server = createServer((req, res) => {
        if (req.url !== '/v1/models') return void res.writeHead(404).end();
        auth.push(req.headers.authorization);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            data: [
              { id: 'qwen3', context_length: 32_768, top_provider: { max_completion_tokens: 4_096 } },
              { id: 'llama3', max_model_len: 8_192, architecture: { input_modalities: ['text', 'image'] } },
              { id: 'qwen3' },
            ],
          }),
        );
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    });
    afterEach(() => new Promise<void>((r) => server.close(() => r())));

    it('Ollama sunucusunu tanır: gömme modellerini listelemez, araç almayan modeli işaretler', async () => {
      const ollama = createServer((req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        if (req.url === '/v1/models') {
          return res.end(JSON.stringify({ data: [{ id: 'qwen3' }, { id: 'nomic-embed' }, { id: 'kucuk' }] }));
        }
        if (req.url === '/api/version') return res.end(JSON.stringify({ version: '0.9.0' }));
        if (req.url === '/api/show') {
          let body = '';
          req.on('data', (c: Buffer) => (body += c.toString()));
          return req.on('end', () => {
            const model = (JSON.parse(body) as { model: string }).model;
            const caps = {
              qwen3: ['completion', 'tools'],
              'nomic-embed': ['embedding'],
              kucuk: ['completion', 'vision'],
            };
            res.end(JSON.stringify({ capabilities: caps[model as keyof typeof caps] }));
          });
        }
        res.writeHead(404).end();
      });
      await new Promise<void>((r) => ollama.listen(0, '127.0.0.1', r));
      try {
        const url = `http://127.0.0.1:${(ollama.address() as AddressInfo).port}/v1`;
        const add = await t.api<ProviderInfo>('POST', '/api/providers/custom', {
          name: 'Ollama',
          baseUrl: url,
        });
        expect(add.status).toBe(200);
        const models = (await t.api<string[]>('GET', `/api/providers/${add.body.id}/models`)).body;
        expect(models).toEqual(['kucuk', 'qwen3']);
        expect(await t.services.keys.takesTools(add.body.id, 'qwen3')).toBe(true);
        expect(await t.services.keys.takesTools(add.body.id, 'kucuk')).toBe(false);
      } finally {
        await new Promise<void>((r) => ollama.close(() => r()));
      }
    });

    it('anahtarı düz http ile başka bir bilgisayara göndermez', async () => {
      const r = await t.api<{ message: string }>('POST', '/api/providers/custom', {
        name: 'Uzak',
        baseUrl: 'http://192.168.1.20:11434/v1',
        key: 'sk-uzak-12345678',
      });
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.body)).toContain('https');
    });

    it('modellerini sorar, sağlayıcılar arasında listelenir ve silinebilir', async () => {
      const add = await t.api<ProviderInfo>('POST', '/api/providers/custom', {
        name: 'Evdeki Ollama',
        baseUrl: `${base}/`,
        key: 'sk-yerel-12345678',
      });
      expect(add.status).toBe(200);
      expect(add.body).toEqual({
        id: 'custom-evdeki-ollama',
        configured: true,
        hint: '…5678',
        custom: { name: 'Evdeki Ollama', baseUrl: base },
      });
      expect(auth).toEqual(['Bearer sk-yerel-12345678']);
      const models = await t.api<string[]>('GET', '/api/providers/custom-evdeki-ollama/models');
      expect(models.body).toEqual(['llama3', 'qwen3']);
      expect(await t.services.keys.customModel('custom-evdeki-ollama', 'qwen3')).toMatchObject({
        api: 'openai-completions',
        // A server that is not OpenAI's gets none of the OpenAI-only request fields.
        compat: { supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens' },
        baseUrl: base,
        provider: 'custom-evdeki-ollama',
        contextWindow: 32_768,
        maxTokens: 4_096,
        input: ['text'],
      });
      // A small window leaves room for the input; a model that takes pictures says so.
      expect(await t.services.keys.customModel('custom-evdeki-ollama', 'llama3')).toMatchObject({
        contextWindow: 8_192,
        maxTokens: 2_048,
        input: ['text', 'image'],
      });
      expect(
        (await t.api('POST', '/api/providers/custom-evdeki-ollama/test', { model: 'qwen3' })).body,
      ).toEqual({
        ok: true,
      });

      // A second one by the same name gets its own id; one with no key still counts as usable.
      const again = await t.api<ProviderInfo>('POST', '/api/providers/custom', {
        name: 'Evdeki Ollama',
        baseUrl: base,
      });
      expect(again.body.id).toBe('custom-evdeki-ollama-2');
      expect(await t.services.keys.credential('custom-evdeki-ollama-2')).toBe('none');
      expect(await t.services.keys.credential('openai')).toBeNull();

      expect((await t.api('DELETE', '/api/providers/custom-evdeki-ollama')).status).toBe(200);
      const ids = (await t.api<ProviderInfo[]>('GET', '/api/providers')).body.map((p) => p.id);
      expect(ids).not.toContain('custom-evdeki-ollama');
      expect(await t.services.keys.get('custom-evdeki-ollama')).toBeNull();
    });

    it('bilgisayarda çalışan model sunucularını bulur; eklenmiş olanı yeniden önermez', async () => {
      const candidates = [
        { name: 'Yerel', baseUrl: base },
        { name: 'Kapalı', baseUrl: 'http://127.0.0.1:9/v1' },
      ];
      expect(await t.services.keys.discover(candidates)).toEqual([
        { name: 'Yerel', baseUrl: base, models: ['llama3', 'qwen3'] },
      ]);
      await t.api('POST', '/api/providers/custom', { name: 'Yerel', baseUrl: base });
      expect(await t.services.keys.discover(candidates)).toEqual([]);
      // No key goes out in a probe.
      expect(auth.every((a) => a === undefined)).toBe(true);
      expect((await t.api('GET', '/api/providers/discover')).status).toBe(200);
    });

    it('kayıtlı uç nokta düzenlenir; boş anahtar eskisini korur, yeni adres modelleri yeniden sorar', async () => {
      const add = await t.api<ProviderInfo>('POST', '/api/providers/custom', {
        name: 'Yerel',
        baseUrl: `${base}/yok`,
        key: 'sk-eski-12345678',
        models: ['elle'],
      });
      const id = add.body.id;
      const renamed = await t.api<ProviderInfo>('PATCH', `/api/providers/${id}`, {
        name: 'Ev sunucusu',
        key: '',
      });
      expect(renamed.body).toMatchObject({ custom: { name: 'Ev sunucusu' }, hint: '…5678' });
      const moved = await t.api<ProviderInfo>('PATCH', `/api/providers/${id}`, {
        baseUrl: base,
        key: 'sk-yeni-87654321',
      });
      expect(moved.body).toMatchObject({ custom: { baseUrl: base }, hint: '…4321' });
      expect(auth.at(-1)).toBe('Bearer sk-yeni-87654321');
      expect((await t.api<string[]>('GET', `/api/providers/${id}/models`)).body).toEqual(['llama3', 'qwen3']);
      expect((await t.api('PATCH', `/api/providers/${id}`, { baseUrl: `${base}/yok` })).status).toBe(400);

      // A model the server leaves out is named by hand; an empty list keeps the saved one.
      await t.api('PATCH', `/api/providers/${id}`, { models: ['qwen3', 'elle-eklenen', 'qwen3'] });
      expect((await t.api<string[]>('GET', `/api/providers/${id}/models`)).body).toEqual([
        'qwen3',
        'elle-eklenen',
      ]);
      await t.api('PATCH', `/api/providers/${id}`, { name: 'Ev', models: [] });
      expect((await t.api<string[]>('GET', `/api/providers/${id}/models`)).body).toEqual([
        'qwen3',
        'elle-eklenen',
      ]);
      // A model typed for the endpoint is tried even when it is on no list.
      expect((await t.api('POST', `/api/providers/${id}/test`, { model: 'listede-yok' })).body).toEqual({
        ok: true,
      });
    });

    it('model listesi alınamazsa modellerin elle yazılmasını ister', async () => {
      const bad = await t.api<{ error: string }>('POST', '/api/providers/custom', {
        name: 'Uzak',
        baseUrl: `${base}/yok`,
      });
      expect(bad.status).toBe(400);
      expect(bad.body.error).toContain('HTTP 404');
      const typed = await t.api<ProviderInfo>('POST', '/api/providers/custom', {
        name: 'Uzak',
        baseUrl: `${base}/yok`,
        models: ['benim-modelim'],
      });
      expect(typed.status).toBe(200);
      expect((await t.api<string[]>('GET', `/api/providers/${typed.body.id}/models`)).body).toEqual([
        'benim-modelim',
      ]);
      expect(
        (await t.api('POST', '/api/providers/custom', { name: 'X', baseUrl: 'file:///etc' })).status,
      ).toBe(400);
      expect(endpointUrl('http://kisi:sifre@yerel/v1')).toBeNull();
      // A key travels over plain http only to this computer.
      expect(keySafeAt('https://openrouter.ai/api/v1')).toBe(true);
      expect(keySafeAt('http://127.0.0.1:11434/v1')).toBe(true);
      expect(keySafeAt('http://localhost:1234/v1')).toBe(true);
      expect(keySafeAt('http://[::1]:8080/v1')).toBe(true);
      expect(keySafeAt('http://192.168.1.20:11434/v1')).toBe(false);
      expect(keySafeAt('http://gateway.example.com/v1')).toBe(false);
      expect(endpointUrl('https://openrouter.ai/api/v1/?x=1')).toBe('https://openrouter.ai/api/v1');
    });
  });

  it('yeni botların motoru ve diğer sağlayıcı modeli ayarlarda saklanır', async () => {
    const s0 = await t.api<{ defaultEngine: string; piModel: string }>('GET', '/api/settings');
    expect(s0.body).toMatchObject({ defaultEngine: 'claude', piModel: '' });
    const ok = await t.api('PATCH', '/api/settings', { defaultEngine: 'pi', piModel: 'openai/gpt-4o-mini' });
    expect(ok.status).toBe(200);
    expect((await t.api('GET', '/api/settings')).body).toMatchObject({
      defaultEngine: 'pi',
      piModel: 'openai/gpt-4o-mini',
    });
    expect((await t.api('PATCH', '/api/settings', { piModel: 'modelsiz' })).status).toBe(400);
    expect((await t.api('PATCH', '/api/settings', { defaultEngine: 'gpt' })).status).toBe(400);
  });
});

describe('OpenCode oturum başlığı', () => {
  it('oturum kimliği verilen istek x-opencode-session başlığıyla gider', async () => {
    const headers: (string | string[] | undefined)[] = [];
    const server = createServer((req, res) => {
      headers.push(req.headers['x-opencode-session']);
      res.writeHead(500, { 'content-type': 'application/json' }).end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const listed = getModels('opencode-go' as never) as Model<string>[];
      const model = { ...listed[0]!, baseUrl: base };
      await completeSimple(model, { messages: [{ role: 'user', content: 'OK?', timestamp: Date.now() }] }, {
        apiKey: 'test-anahtar',
        maxTokens: 8,
        sessionId: 'oturum-1',
        maxRetries: 0,
      } as never);
      expect(headers[0]).toBe('oturum-1');
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('katalogda olmayan model', () => {
  const model = (id: string, api: string) =>
    ({
      id,
      name: id,
      api,
      provider: 'p',
      baseUrl: `https://${api}.example`,
      reasoning: false,
      input: ['text'],
      cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 1000,
      maxTokens: 100,
    }) as Model<string>;
  const listed = [model('claude-opus-5', 'anthropic-messages'), model('gpt-6-sol', 'openai-responses')];

  it('adı en çok benzeyen modelin API ve adresini alır, fiyatı bilinmez sayar', () => {
    expect(unlistedModel(listed, 'gpt-6.2')).toMatchObject({
      id: 'gpt-6.2',
      api: 'openai-responses',
      baseUrl: 'https://openai-responses.example',
      cost: { input: 0, output: 0 },
    });
    expect(unlistedModel(listed, 'claude-opus-6')).toMatchObject({ api: 'anthropic-messages' });
    expect(endpointApi('https://api.openai.com/v1')).toEqual({ api: 'openai-responses' });
    expect(endpointApi('https://API.OPENAI.com/v1/').api).toBe('openai-responses');
    expect(endpointApi('https://api.openai.com.evil.example/v1').api).toBe('openai-completions');
    expect(endpointApi('http://127.0.0.1:11434/v1')).toMatchObject({ compat: { supportsStore: false } });
    // Nothing alike: the first listed model stands in.
    expect(unlistedModel(listed, 'zzz')?.api).toBe('anthropic-messages');
    expect(unlistedModel([], 'gpt-6.2')).toBeUndefined();
  });
});

describe('sağlayıcı hataları', () => {
  const t = translator('tr');
  it('anahtar, bakiye, sınır, yoğunluk ve erişim hatalarını açıklar', () => {
    expect(providerTrouble('401 Unauthorized: invalid api key', 'openai', t)).toMatchObject({
      kind: 'engine',
    });
    expect(providerTrouble('401 Unauthorized', 'openai', t).message).toContain('API anahtarını kabul etmedi');
    expect(providerTrouble('402 Insufficient credits', 'openrouter', t).message).toContain('bakiye');
    expect(providerTrouble('413 Request Entity Too Large', 'openai', t)).toMatchObject({
      kind: 'engine',
      message: expect.stringContaining('çok büyük'),
    });
    expect(CONTEXT_FULL.test(providerTrouble('413 Payload Too Large', 'openai', t).message)).toBe(true);
    for (const raw of [
      'The model refused to complete the request',
      'Provider finish_reason: content_filter',
      'Provider stopped with: SAFETY',
      'Provider stopped with: PROHIBITED_CONTENT',
      'Provider stopped with: sensitive',
    ]) {
      expect(providerTrouble(raw, 'openai', t), raw).toMatchObject({
        kind: 'engine',
        refused: true,
        message: expect.stringContaining('reddetti'),
      });
    }
    expect(providerTrouble('Provider stopped with: MAX_TOKENS', 'google', t).refused).toBeUndefined();
    expect(providerTrouble('429 Too Many Requests', 'groq', t)).toMatchObject({ kind: 'limit' });
    expect(providerTrouble('503 Service Unavailable', 'groq', t)).toMatchObject({ transient: true });
    expect(providerTrouble('fetch failed: ECONNREFUSED', 'custom-ev', t).message).toContain('ulaşılamadı');
    expect(providerTrouble('Stream ended without finish_reason', 'opencode-go', t)).toMatchObject({
      kind: 'engine',
      transient: true,
      cut: true,
      message: expect.stringContaining('yanıtı bitirmeden kesti'),
    });
    expect(providerTrouble('TypeError: terminated', 'openai', t)).toMatchObject({ cut: true });
    expect(providerTrouble('process terminated by signal', 'openai', t).cut).toBeUndefined();
    expect(providerTrouble('strange', 'x', t)).toEqual({ kind: 'engine', message: 'strange' });
  });

  it('kaldırılmış ya da adı bilinmeyen modeli yedeğe geçilebilir diye işaretler', () => {
    const gone = [
      'API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-old"}}',
      'HTTP 410 Gone',
      'The model `gpt-old` does not exist or you do not have access to it.',
      'Error code: model_not_found',
      'models/gemini-old is not found for API version v1beta',
      'gpt-old is not a valid model ID',
      'No endpoints found for openai/gpt-old.',
      'The model gpt-old has been deprecated',
      "There's an issue with the selected model (claude-old). It may not exist or you may not have access to it.",
    ];
    for (const raw of gone) {
      expect(providerTrouble(raw, 'openai', t), raw).toMatchObject({
        kind: 'engine',
        modelGone: true,
        message: expect.stringContaining('artık sunmuyor'),
      });
    }
    // Other errors that only share a number or a word with it.
    for (const raw of [
      'max_tokens: 4100 is too large',
      'The model hit an unknown error',
      '404 page not found at https://example.com',
      // A mistyped address answers 404 whatever the model.
      '404 Not Found for model my-model',
      'not_found_error: file_abc was not found',
      'This model does not support image input',
    ]) {
      expect(providerTrouble(raw, 'openai', t).modelGone, raw).toBeUndefined();
    }
  });
});
