import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AiEndpoints, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ID } from '../src/users';
import { aiEndpointsFrom } from '../src/config';
import { schema } from '../src/db';
import { stagingDir } from '../src/uploads';
import { AUTH, testServer, type TestServer } from './helpers';

/** Words that mean the same thing share one number, so nearness follows meaning, not spelling. */
const CONCEPTS = [
  ['eş', 'eşim', 'karım', 'kocam', 'spouse', 'wife'],
  ['kedi', 'kedim', 'kedimin', 'cat'],
  ['araba', 'arabam', 'car'],
];

function vector(text: string): number[] {
  const words = text.toLocaleLowerCase('tr').split(/[^\p{L}]+/u);
  return [...CONCEPTS.map((c) => words.filter((w) => c.includes(w)).length), 0.05];
}

/** An OpenAI-compatible server: embeddings, transcription and speech, recording each call. */
function fakeService() {
  const calls: { path: string; auth?: string; body: string }[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      calls.push({ path: req.url!, auth: req.headers.authorization, body });
      if (req.url === '/v1/embeddings') {
        const { input } = JSON.parse(body) as { input: string[] };
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ data: input.map((t, index) => ({ index, embedding: vector(t) })) }));
      }
      if (req.url === '/v1/audio/transcriptions') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ text: ' Yarın saat dokuzda toplantı var. ' }));
      }
      if (req.url === '/v1/audio/speech') {
        res.writeHead(200, { 'content-type': 'audio/mpeg' });
        return res.end(Buffer.from('ID3-ses-verisi'));
      }
      res.writeHead(404).end();
    });
  });
  return {
    calls,
    async start() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('yapay zekâ servisleri', () => {
  let t: TestServer;
  let svc: ReturnType<typeof fakeService>;
  let base: string;
  beforeEach(async () => {
    t = await testServer();
    svc = fakeService();
    base = await svc.start();
  });
  afterEach(async () => {
    await t.dispose();
    await svc.close();
  });

  it('ortam değişkenleri ayar yokken geçerlidir; ayarlar onların yerine geçer, anahtar dönmez', () => {
    expect(
      aiEndpointsFrom({
        AI_EMBEDDINGS_MODEL: 'bge-m3',
        AI_EMBEDDINGS_BASE_URL: 'http://ollama:11434/v1/',
        AI_EMBEDDINGS_API_KEY: 'ollama',
        STT_PROVIDER: 'openai-compatible',
        STT_MODEL: 'deepdml/faster-whisper-large-v3-turbo-ct2',
        STT_BASE_URL: 'http://whisper:8000/v1',
        TTS_MODEL: 'yalniz-model',
      }),
    ).toEqual({
      embeddings: { baseUrl: 'http://ollama:11434/v1', model: 'bge-m3', apiKey: 'ollama', voice: '' },
      stt: {
        baseUrl: 'http://whisper:8000/v1',
        model: 'deepdml/faster-whisper-large-v3-turbo-ct2',
        apiKey: '',
        voice: '',
      },
    });
  });

  it('anlama göre arar: kelimesi tutmayan ama anlamı yakın notu bulur, ilgisizini bulmaz', async () => {
    await t.services.memory.create({
      scope: 'user',
      botId: null,
      content: 'Ayşe benim karım',
      source: 'user',
    });
    await t.services.memory.create({
      scope: 'user',
      botId: null,
      content: 'Kedimin adı Pamuk',
      source: 'user',
    });
    // By words alone, "eşim" finds nothing.
    expect(await t.services.memory.search([], OWNER_ID, 'eşim')).toEqual([]);

    const set = await t.api('PUT', '/api/ai-endpoints/embeddings', {
      baseUrl: base,
      model: 'bge-m3',
      apiKey: 'gizli-anahtar',
    });
    expect(set.status).toBe(200);
    const listed = (await t.api<AiEndpoints>('GET', '/api/ai-endpoints')).body;
    expect(listed.embeddings).toMatchObject({
      baseUrl: base,
      model: 'bge-m3',
      hasKey: true,
      source: 'settings',
    });
    expect(JSON.stringify(listed)).not.toContain('gizli-anahtar');

    const found = await t.services.memory.search([], OWNER_ID, 'eşim kim');
    expect(found.map((m) => m.content)).toEqual(['Ayşe benim karım']);
    expect(svc.calls.find((c) => c.path === '/v1/embeddings')!.auth).toBe('Bearer gizli-anahtar');
    // Words still count: a note holding the query comes first.
    expect((await t.services.memory.search([], OWNER_ID, 'Pamuk')).map((m) => m.content)).toEqual([
      'Kedimin adı Pamuk',
    ]);
    // A changed note is indexed again before the next search.
    const cat = (await t.services.memory.list()).find((m) => m.content.startsWith('Kedimin'))!;
    await t.services.memory.update(cat.id, { content: 'Arabam kırmızı' }, 'user');
    expect((await t.services.memory.search([], OWNER_ID, 'car')).map((m) => m.content)).toEqual([
      'Arabam kırmızı',
    ]);
    expect(
      (await t.api<{ memoryIndex: { indexed: number } }>('GET', '/api/ai-endpoints')).body.memoryIndex,
    ).toEqual({
      indexed: 2,
      total: 2,
    });
    expect(
      (await t.api<{ ok: boolean; detail: string }>('POST', '/api/ai-endpoints/embeddings/test')).body,
    ).toEqual({
      ok: true,
      detail: '4',
    });

    // The service down: search goes by words again instead of failing.
    await svc.close();
    expect((await t.services.memory.search([], OWNER_ID, 'Arabam')).map((m) => m.content)).toEqual([
      'Arabam kırmızı',
    ]);
    svc = fakeService();
  });

  it('adres https olmalı; düz http yalnız yerel ağdaki bir servise olur', async () => {
    expect(
      (await t.api('PUT', '/api/ai-endpoints/stt', { baseUrl: 'http://api.example.com/v1', model: 'm' }))
        .status,
    ).toBe(400);
    expect(
      (await t.api('PUT', '/api/ai-endpoints/stt', { baseUrl: 'http://whisper:8000/v1', model: 'm' })).status,
    ).toBe(200);
    expect(
      (await t.api('PUT', '/api/ai-endpoints/stt', { baseUrl: 'https://api.example.com/v1', model: 'm' }))
        .status,
    ).toBe(200);
    const cleared = await t.api<{ source: string }>('DELETE', '/api/ai-endpoints/stt');
    expect(cleared.body.source).toBe('none');
  });

  it('seslendirme ve yazıya çevirme ayarlanan servisle olur', async () => {
    expect((await t.api<{ available: boolean }>('GET', '/api/speech')).body.available).toBe(false);
    await t.api('PUT', '/api/ai-endpoints/tts', { baseUrl: base, model: 'kokoro', voice: 'af_bella' });
    expect((await t.api<{ available: boolean }>('GET', '/api/speech')).body.available).toBe(true);
    const audio = await t.app.inject({
      method: 'POST',
      url: '/api/speech',
      headers: { ...AUTH, host: 'localhost', origin: 'http://localhost', 'content-type': 'application/json' },
      payload: { text: 'Merhaba' },
    });
    expect(audio.statusCode).toBe(200);
    expect(audio.headers['content-type']).toBe('audio/mpeg');
    expect(audio.body).toBe('ID3-ses-verisi');
    expect(JSON.parse(svc.calls.at(-1)!.body)).toMatchObject({
      model: 'kokoro',
      input: 'Merhaba',
      voice: 'af_bella',
    });

    await t.api('PUT', '/api/ai-endpoints/stt', { baseUrl: base, model: 'whisper-large' });
    expect((await t.api<{ available: boolean }>('GET', '/api/transcribe')).body.available).toBe(true);
    const text = await t.app.inject({
      method: 'POST',
      url: '/api/transcribe?lang=tr',
      headers: { ...AUTH, host: 'localhost', origin: 'http://localhost', 'content-type': 'audio/webm' },
      payload: Buffer.from('kayit'),
    });
    expect(text.json()).toEqual({ text: 'Yarın saat dokuzda toplantı var.' });
    expect(svc.calls.at(-1)!.body).toContain('whisper-large');
  });

  it('sohbet uygulamasından gelen sesli mesaj yazıya çevrilip bota metin olarak gider', async () => {
    await t.api('PUT', '/api/ai-endpoints/stt', { baseUrl: base, model: 'whisper-large' });
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const staging = stagingDir(t.dataDir, thread.id);
    mkdirSync(staging, { recursive: true });
    writeFileSync(`${staging}/voice-42.ogg`, Buffer.from('OggS-ses'));
    const { message } = await t.services.inbox.send(thread.id, {
      text: '',
      files: ['voice-42.ogg'],
      props: { via: 'telegram' },
    });
    expect(message.text).toBe('🎤 Yarın saat dokuzda toplantı var.');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).toContain('Yarın saat dokuzda toplantı var.');
  });

  it('goes through a provider: its saved key serves the service, and a removed key turns it off', async () => {
    // A provider that has no key yet, or does not do this, cannot be picked.
    expect(
      (await t.api('PUT', '/api/ai-endpoints/stt', { provider: 'openai', model: 'gpt-4o-mini-transcribe' }))
        .status,
    ).toBe(400);
    await t.services.keys.set('openai', 'sk-test-speech-1234');
    expect((await t.api('PUT', '/api/ai-endpoints/tts', { provider: 'groq', model: 'x' })).status).toBe(400);

    const set = await t.api<Record<string, unknown>>('PUT', '/api/ai-endpoints/stt', {
      provider: 'openai',
      model: 'gpt-4o-mini-transcribe',
    });
    expect(set.status).toBe(200);
    expect(set.body).toMatchObject({
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      hasKey: true,
      source: 'settings',
      gone: false,
    });
    expect(JSON.stringify(set.body)).not.toContain('sk-test-speech-1234');
    expect(await t.services.ai.get('stt')).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-speech-1234',
    });

    await t.services.keys.remove('openai');
    expect(await t.services.ai.get('stt')).toBeNull();
    expect((await t.api<AiEndpoints>('GET', '/api/ai-endpoints')).body.stt).toMatchObject({
      provider: 'openai',
      gone: true,
    });
  });

  it('an endpoint of your own serves speech; ElevenLabs is saved without a list of chat models', async () => {
    const eleven = await t.api<{ id: string }>('POST', '/api/providers/custom', {
      name: 'ElevenLabs',
      baseUrl: 'https://api.elevenlabs.io/v1',
      key: 'xi-test-key-1234',
    });
    expect(eleven.status).toBe(200);
    expect(await t.services.keys.models(eleven.body.id)).toEqual([]);
    const own = await t.api<{ id: string }>('POST', '/api/providers/custom', {
      name: 'Kokoro',
      baseUrl: base,
      models: ['kokoro'],
    });
    await t.api('PUT', '/api/ai-endpoints/tts', {
      provider: own.body.id,
      model: 'kokoro',
      voice: 'af_bella',
    });
    expect(await t.services.ai.get('tts')).toEqual({
      baseUrl: base,
      apiKey: '',
      model: 'kokoro',
      voice: 'af_bella',
    });
    await t.api('PUT', '/api/ai-endpoints/stt', { provider: eleven.body.id, model: 'scribe_v2' });
    expect(await t.services.ai.get('stt')).toEqual({
      baseUrl: 'https://api.elevenlabs.io/v1',
      apiKey: 'xi-test-key-1234',
      model: 'scribe_v2',
      voice: '',
    });
  });

  it('files services saved with their own address and key under Providers, once, without indexing again', async () => {
    const db = t.services.ctx.db;
    const put = (key: string, value: unknown) => db.insert(schema.kv).values({ key, value });
    await put('ai.stt', { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini-transcribe', voice: '' });
    await put('secret.ai.stt', t.services.vault.seal('sk-old-openai-1234'));
    await put('ai.tts', {
      baseUrl: 'https://texttospeech.googleapis.com/v1',
      model: 'chirp3-hd',
      voice: 'tr-TR-Chirp3-HD-Kore',
    });
    await put('secret.ai.tts', t.services.vault.seal('google-old-key-1234'));
    await put('ai.embeddings', { baseUrl: base, model: 'bge-m3', voice: '' });
    const moved: string[] = [];
    t.services.ai.onChange((k) => moved.push(k));

    const all = (await t.api<AiEndpoints>('GET', '/api/ai-endpoints')).body;
    expect(all.stt).toMatchObject({ provider: 'openai', baseUrl: 'https://api.openai.com/v1', hasKey: true });
    expect(all.tts).toMatchObject({
      provider: 'custom-google-text-to-speech',
      baseUrl: 'https://texttospeech.googleapis.com/v1',
      model: 'chirp3-hd',
      voice: 'tr-TR-Chirp3-HD-Kore',
      hasKey: true,
    });
    expect(all.embeddings).toMatchObject({ baseUrl: base, model: 'bge-m3', hasKey: false });
    // The OpenAI key now serves the bots too; the services keep no key of their own.
    expect(await t.services.keys.get('openai')).toBe('sk-old-openai-1234');
    expect(await t.services.ai.get('tts')).toMatchObject({ apiKey: 'google-old-key-1234' });
    const left = await db.select().from(schema.kv);
    expect(left.filter((r) => r.key.startsWith('secret.ai.'))).toEqual([]);
    expect(moved).toEqual([]);

    // Read again, nothing is filed twice.
    await t.services.ai.all();
    const endpoints = (await t.api<{ id: string }[]>('GET', '/api/providers')).body.filter((p) =>
      p.id.startsWith('custom-'),
    );
    expect(endpoints.map((p) => p.id)).toHaveLength(2);
    expect(endpoints.map((p) => p.id)).toContain('custom-google-text-to-speech');
  });
});
