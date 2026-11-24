import { describe, expect, it } from 'vitest';
import type { AiEndpointService, AiService } from '../src/services/ai-endpoints';
import { SpeechService } from '../src/services/speech';

const GOOGLE = 'https://texttospeech.googleapis.com/v1';

/** The speech settings as the server reads them, with one service set. */
const settings = (s: AiService) => ({ get: async () => s }) as unknown as AiEndpointService;

function recorder(reply: () => Response) {
  const sent: { url: string; headers: Headers; body: unknown }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    sent.push({ url, headers: new Headers(init.headers), body: JSON.parse(init.body as string) });
    return reply();
  }) as typeof fetch;
  return { sent, fetcher };
}

const mp3 = () =>
  new Response(JSON.stringify({ audioContent: Buffer.from('ID3-ses').toString('base64') }), { status: 200 });

describe('Google seslendirme', () => {
  it('Chirp 3 HD sesini adıyla ister, dili sesin adından alır, anahtarı başlıkta gönderir', async () => {
    const { sent, fetcher } = recorder(mp3);
    const speech = new SpeechService(
      settings({
        baseUrl: GOOGLE,
        model: 'chirp3-hd',
        apiKey: 'goog-test-key',
        voice: 'tr-TR-Chirp3-HD-Kore',
      }),
      fetcher,
    );
    const { audio, type } = await speech.speak('  Merhaba Erhan  ', 'en');
    expect(audio.toString()).toBe('ID3-ses');
    expect(type).toBe('audio/mpeg');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe(`${GOOGLE}/text:synthesize`);
    expect(sent[0]!.url).not.toContain('key=');
    expect(sent[0]!.headers.get('x-goog-api-key')).toBe('goog-test-key');
    expect(sent[0]!.headers.get('authorization')).toBeNull();
    expect(sent[0]!.body).toEqual({
      input: { text: 'Merhaba Erhan' },
      voice: { languageCode: 'tr-TR', name: 'tr-TR-Chirp3-HD-Kore' },
      audioConfig: { audioEncoding: 'MP3' },
    });
  });

  it('Gemini sesinde modeli söyler, dili kişinin dilinden bölgesiyle verir', async () => {
    const { sent, fetcher } = recorder(mp3);
    const speech = new SpeechService(
      settings({ baseUrl: GOOGLE, model: 'gemini-2.5-flash-tts', apiKey: 'k', voice: 'Kore' }),
      fetcher,
    );
    await speech.speak('Merhaba', 'tr');
    expect(sent[0]!.body).toMatchObject({
      voice: { languageCode: 'tr-TR', name: 'Kore', modelName: 'gemini-2.5-flash-tts' },
    });
  });

  it('metni 4.000 baytı aşmayacak biçimde, harfi bölmeden keser', async () => {
    const { sent, fetcher } = recorder(mp3);
    const speech = new SpeechService(
      settings({ baseUrl: GOOGLE, model: 'chirp3-hd', apiKey: 'k', voice: 'tr-TR-Chirp3-HD-Kore' }),
      fetcher,
    );
    await speech.speak('ğ'.repeat(3000));
    const text = (sent[0]!.body as { input: { text: string } }).input.text;
    expect(Buffer.byteLength(text)).toBe(4000);
    expect(text).toBe('ğ'.repeat(2000));
  });

  it('ses adı yoksa istek atmadan söyler; Google hatasını kendi mesajıyla iletir', async () => {
    const none = recorder(mp3);
    await expect(
      new SpeechService(
        settings({ baseUrl: GOOGLE, model: 'chirp3-hd', apiKey: 'k', voice: '' }),
        none.fetcher,
      ).speak('Merhaba'),
    ).rejects.toMatchObject({ status: 400, key: 'error.speechVoiceName' });
    expect(none.sent).toEqual([]);

    const denied = recorder(
      () =>
        new Response(
          JSON.stringify({
            error: { code: 400, message: 'API key not valid. Please pass a valid API key.' },
          }),
          {
            status: 400,
          },
        ),
    );
    await expect(
      new SpeechService(
        settings({ baseUrl: GOOGLE, model: 'chirp3-hd', apiKey: 'yanlis', voice: 'tr-TR-Chirp3-HD-Kore' }),
        denied.fetcher,
      ).speak('Merhaba'),
    ).rejects.toMatchObject({
      status: 502,
      params: { message: 'API key not valid. Please pass a valid API key.' },
    });
  });
});
