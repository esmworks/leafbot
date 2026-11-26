import { describe, expect, it } from 'vitest';
import { endpoints } from './endpoints';
import { readAnswer, type SendOptions, type Transport } from './http';

/** A transport that answers nothing and keeps what it was asked to send. */
function recorder() {
  const sent: { method: string; path: string; body: unknown; opts: SendOptions | undefined }[] = [];
  const send: Transport = async <T>(method: string, path: string, body?: unknown, opts?: SendOptions) => {
    sent.push({ method, path, body, opts });
    return null as T;
  };
  return { sent, send };
}

describe('endpoints', () => {
  it('sends each call with its method, path and body', async () => {
    const { sent, send } = recorder();
    const api = endpoints(send);
    await api.bots();
    await api.updateBot('b1', { name: 'x' });
    await api.removeRule('r/1');
    await api.endSession('others');
    await api.answerCard('m1', { node: 'n4', rev: 2, values: { time: '09:00' } });
    expect(sent.map(({ method, path, body }) => ({ method, path, body }))).toEqual([
      { method: 'GET', path: '/api/bots', body: undefined },
      { method: 'PATCH', path: '/api/bots/b1', body: { name: 'x' } },
      { method: 'DELETE', path: '/api/rules/r/1', body: undefined },
      { method: 'DELETE', path: '/api/sessions/others', body: undefined },
      {
        method: 'POST',
        path: '/api/messages/m1/card',
        body: { node: 'n4', rev: 2, values: { time: '09:00' } },
      },
    ]);
  });

  it('puts the base address only before addresses handed out as they are', async () => {
    const { sent, send } = recorder();
    const api = endpoints(send, 'https://bot.example');
    expect(api.fileUrl('b1', 'a b.txt', { inline: true })).toBe(
      'https://bot.example/api/bots/b1/library/file?path=a%20b.txt&inline=1',
    );
    expect(api.tableCsvUrl('t1')).toBe('https://bot.example/api/tables/t1/rows.csv');
    expect(endpoints(send).pageUrl('b1', 'p.html', 300)).toBe('/api/bots/b1/library/page?path=p.html&h=300');
    await api.library('b1');
    expect(sent[0]?.path).toBe('/api/bots/b1/library');
  });

  it('hands a file upload its progress, signal and retry id', async () => {
    const { sent, send } = recorder();
    const file = new Blob(['x']);
    const onProgress = () => {};
    const signal = new AbortController().signal;
    await endpoints(send).uploadFile('t1', 'rapor final.txt', file, { uploadId: 'u1', onProgress, signal });
    expect(sent[0]).toEqual({
      method: 'POST',
      path: '/api/threads/t1/files?name=rapor%20final.txt&uploadId=u1',
      body: file,
      opts: { onProgress, signal },
    });
  });

  it('sends the extra headers a call needs', async () => {
    const { sent, send } = recorder();
    const api = endpoints(send);
    await api.restoreBackup(new Blob(['x']), 'şifre 1');
    await api.removeFile('t1', 'a.txt', { keepalive: true });
    expect(sent[0]?.opts).toEqual({ headers: { 'x-backup-password': encodeURIComponent('şifre 1') } });
    expect(sent[1]).toMatchObject({ method: 'DELETE', opts: { keepalive: true } });
  });

  it('turns a transcription answer into its text, empty when there is none', async () => {
    const send: Transport = async <T>() => ({ text: 'merhaba' }) as T;
    expect(await endpoints(send).transcribe(new Blob(['x'], { type: 'audio/mp4' }), 'tr')).toEqual({
      text: 'merhaba',
    });
    const none: Transport = async <T>() => null as T;
    expect(await endpoints(none).transcribe(new Blob(['x']), 'tr')).toEqual({ text: '' });
  });

  it('leaves the language out when the service should tell it', async () => {
    const paths: string[] = [];
    const send: Transport = async <T>(_m: string, path: string) => {
      paths.push(path);
      return null as T;
    };
    await endpoints(send).transcribe(new Blob(['x']), 'en');
    await endpoints(send).transcribe(new Blob(['x']));
    expect(paths).toEqual(['/api/transcribe?lang=en', '/api/transcribe']);
  });
});

describe('readAnswer', () => {
  it("reads the server's reason, and nothing from a page that is not JSON", () => {
    expect(readAnswer('{"error":"bulunamadı"}')).toEqual({
      data: { error: 'bulunamadı' },
      reason: 'bulunamadı',
    });
    expect(readAnswer('<html>502</html>')).toEqual({ data: null, reason: null });
    expect(readAnswer('')).toEqual({ data: null, reason: null });
  });
});
