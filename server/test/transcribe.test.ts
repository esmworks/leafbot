import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscribeService } from '../src/services/transcribe';
import { AUTH, testServer, type TestServer } from './helpers';

describe('sesle yazdırma', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('anahtar yokken kullanılamaz; kayıt sunucuya gelir ama sağlayıcı yoksa açık bir hata döner', async () => {
    expect((await t.api('GET', '/api/transcribe')).body).toEqual({ available: false });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/transcribe?lang=tr',
      headers: { ...AUTH, 'content-type': 'audio/webm;codecs=opus' },
      payload: Buffer.from('ses'),
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('OpenAI ya da Groq');
  });

  it('kayıtlı OpenAI anahtarıyla sesi gönderir, dili ve biçimi söyler, metni döndürür', async () => {
    await t.services.keys.set('openai', 'sk-test-transcribe-1234');
    const sent: { url: string; auth: string | null; model: unknown; language: unknown; name: string }[] = [];
    const fake = (async (url: string, init: RequestInit) => {
      const form = init.body as FormData;
      sent.push({
        url,
        auth: new Headers(init.headers).get('authorization'),
        model: form.get('model'),
        language: form.get('language'),
        name: (form.get('file') as File).name,
      });
      return new Response(JSON.stringify({ text: ' Merhaba dünya ' }), { status: 200 });
    }) as typeof fetch;
    const service = new TranscribeService(t.services.keys, undefined, fake);
    expect(await service.available()).toBe(true);
    expect(await service.transcribe(Buffer.from('ses'), 'audio/webm;codecs=opus', 'tr')).toBe(
      'Merhaba dünya',
    );
    expect(sent).toEqual([
      {
        url: 'https://api.openai.com/v1/audio/transcriptions',
        auth: 'Bearer sk-test-transcribe-1234',
        model: 'gpt-4o-mini-transcribe',
        language: 'tr',
        name: 'speech.webm',
      },
    ]);
    expect((await t.api('GET', '/api/transcribe')).body).toEqual({ available: true });
  });

  it('dil verilmeyen istekte dili servise bırakır', async () => {
    await t.services.keys.set('openai', 'sk-test-transcribe-1234');
    const languages: unknown[] = [];
    const fake = (async (_url: string, init: RequestInit) => {
      languages.push((init.body as FormData).get('language'));
      return new Response(JSON.stringify({ text: 'hello' }), { status: 200 });
    }) as typeof fetch;
    Object.assign(t.services.transcribe, { fetcher: fake });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/transcribe',
      headers: { ...AUTH, 'content-type': 'audio/webm;codecs=opus' },
      payload: Buffer.from('ses'),
    });
    expect(res.json()).toEqual({ text: 'hello' });
    expect(languages).toEqual([null]);
  });

  it('servise ulaşılamazsa genel sunucu hatası yerine nedenini söyler', async () => {
    await t.services.keys.set('openai', 'sk-test-transcribe-1234');
    const refused = (async () => {
      throw new TypeError('fetch failed', {
        cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }),
      });
    }) as typeof fetch;
    Object.assign(t.services.transcribe, { fetcher: refused });
    const res = await t.app.inject({
      method: 'POST',
      url: '/api/transcribe?lang=tr',
      headers: { ...AUTH, 'content-type': 'audio/webm;codecs=opus' },
      payload: Buffer.from('ses'),
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('Ses yazıya çevirme servisine ulaşılamadı: ECONNREFUSED');
  });

  it('servis zamanında yanıt vermezse bunu söyler', async () => {
    await t.services.keys.set('openai', 'sk-test-transcribe-1234');
    const slow = (async () => {
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    }) as typeof fetch;
    const service = new TranscribeService(t.services.keys, undefined, slow);
    await expect(service.transcribe(Buffer.from('ses'), 'audio/webm', 'tr')).rejects.toMatchObject({
      status: 504,
      key: 'error.transcribeTimeout',
      params: { seconds: 120 },
    });
  });
});
