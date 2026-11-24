import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AiEndpointService, AiService } from '../src/services/ai-endpoints';
import { SpeechService } from '../src/services/speech';
import { TranscribeService } from '../src/services/transcribe';
import { testServer, type TestServer } from './helpers';

const ELEVEN = 'https://api.elevenlabs.io/v1';

/** The speech settings as the server reads them, with one service set. */
const settings = (s: AiService) => ({ get: async () => s }) as unknown as AiEndpointService;

interface Sent {
  url: string;
  headers: Headers;
  init: RequestInit;
}

function recorder(reply: () => Response) {
  const sent: Sent[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: new Headers(init.headers), init });
    return reply();
  }) as typeof fetch;
  return { sent, fetcher };
}

describe('ElevenLabs', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('konuşmayı kendi biçimiyle yazıya çevirir: xi-api-key, model_id ve language_code', async () => {
    const { sent, fetcher } = recorder(
      () => new Response(JSON.stringify({ text: ' Merhaba Kahya ', language_code: 'tur' }), { status: 200 }),
    );
    const service = new TranscribeService(
      t.services.keys,
      settings({ baseUrl: ELEVEN, model: 'scribe_v2', apiKey: 'xi-test-key', voice: '' }),
      fetcher,
    );
    expect(await service.transcribe(Buffer.from('ses'), 'audio/webm;codecs=opus', 'tr')).toBe(
      'Merhaba Kahya',
    );
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${ELEVEN}/speech-to-text`);
    expect(sent[0]!.headers.get('xi-api-key')).toBe('xi-test-key');
    expect(sent[0]!.headers.get('authorization')).toBeNull();
    const form = sent[0]!.init.body as FormData;
    expect(form.get('model_id')).toBe('scribe_v2');
    expect(form.get('language_code')).toBe('tr');
    expect(form.get('model')).toBeNull();
  });

  it('hatasını detail.message içinden okur', async () => {
    const { fetcher } = recorder(
      () =>
        new Response(JSON.stringify({ detail: { status: 'invalid_api_key', message: 'Invalid API key' } }), {
          status: 401,
        }),
    );
    const service = new TranscribeService(
      t.services.keys,
      settings({ baseUrl: ELEVEN, model: 'scribe_v2', apiKey: 'yanlis', voice: '' }),
      fetcher,
    );
    await expect(service.transcribe(Buffer.from('ses'), 'audio/webm')).rejects.toMatchObject({
      status: 502,
      params: { message: 'Invalid API key' },
    });
  });

  it('yanıtı adresteki sesle okur ve MP3 ister', async () => {
    const { sent, fetcher } = recorder(
      () => new Response(Buffer.from('ID3-ses'), { status: 200, headers: { 'content-type': 'audio/mpeg' } }),
    );
    const speech = new SpeechService(
      settings({ baseUrl: ELEVEN, model: 'eleven_multilingual_v2', apiKey: 'xi-test-key', voice: 'abc123' }),
      fetcher,
    );
    const { audio, type } = await speech.speak('  Merhaba Erhan  ');
    expect(audio.toString()).toBe('ID3-ses');
    expect(type).toBe('audio/mpeg');
    expect(sent[0]!.url).toBe(`${ELEVEN}/text-to-speech/abc123?output_format=mp3_44100_128`);
    expect(sent[0]!.headers.get('xi-api-key')).toBe('xi-test-key');
    expect(JSON.parse(sent[0]!.init.body as string)).toEqual({
      text: 'Merhaba Erhan',
      model_id: 'eleven_multilingual_v2',
    });
  });

  it('ses kimliği yoksa istek atmadan bunu söyler', async () => {
    const { sent, fetcher } = recorder(() => new Response(null, { status: 200 }));
    const speech = new SpeechService(
      settings({ baseUrl: ELEVEN, model: 'eleven_multilingual_v2', apiKey: 'xi-test-key', voice: '' }),
      fetcher,
    );
    await expect(speech.speak('Merhaba')).rejects.toMatchObject({ status: 400, key: 'error.speechVoiceId' });
    expect(sent).toEqual([]);
  });
});
