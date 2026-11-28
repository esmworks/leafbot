import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, NoAnswerError, setUnauthorizedHandler } from './api';

const fetchMock = vi.fn<typeof fetch>();

/** An answer with this status and body, as the server or a proxy in front of it gives it. */
const answer = (status: number, body: string) => Promise.resolve(new Response(body, { status }));

/** What the page asked fetch for in its nth call. */
const call = (n = 0) => {
  const [url, init] = fetchMock.mock.calls[n] ?? [];
  return { url, init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string> };
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  setUnauthorizedHandler(() => {});
});

describe('api', () => {
  it('sends JSON with the cookie and returns the parsed answer', async () => {
    fetchMock.mockReturnValue(answer(200, '{"id":"b1"}'));
    expect(await api.updateBot('b1', { name: 'x' })).toEqual({ id: 'b1' });
    const { url, init, headers } = call();
    expect(url).toBe('/api/bots/b1');
    expect(init).toMatchObject({ method: 'PATCH', credentials: 'same-origin', body: '{"name":"x"}' });
    expect(headers['content-type']).toBe('application/json');
    expect(headers['accept-language']).toBeTruthy();
  });

  it('sends a recording with its own type, not as a plain file', async () => {
    fetchMock.mockReturnValue(answer(200, '{"text":"merhaba"}'));
    const audio = new Blob(['x'], { type: 'audio/mp4' });
    expect(await api.transcribe(audio, 'tr')).toEqual({ text: 'merhaba' });
    expect(call().url).toBe('/api/transcribe?lang=tr');
    expect(call().init.body).toBe(audio);
    expect(call().headers['content-type']).toBe('audio/mp4');
  });

  it('sends the backup password in its header with the file as the body', async () => {
    fetchMock.mockReturnValue(answer(200, '{"tables":1,"files":2}'));
    const file = new File(['x'], 'yedek.leafbot');
    await api.restoreBackup(file, 'gizli söz');
    expect(call().init.body).toBe(file);
    expect(call().headers['x-backup-password']).toBe(encodeURIComponent('gizli söz'));
    expect(call().headers['content-type']).toBe('application/octet-stream');
  });

  it('asks a removal sent while the page closes to outlive it', async () => {
    fetchMock.mockImplementation(() => answer(200, '{"ok":true}'));
    await api.removeFile('t1', 'a b.txt', { keepalive: true });
    await api.removeFile('t1', 'a b.txt');
    expect(call(0).url).toBe('/api/threads/t1/files/a%20b.txt');
    expect(call(0).init).toMatchObject({ method: 'DELETE', keepalive: true });
    expect(call(1).init.keepalive).toBeUndefined();
  });

  it('signs the page out on a refused session, but not on a wrong access key', async () => {
    const out = vi.fn();
    setUnauthorizedHandler(out);
    fetchMock.mockImplementation(() => answer(401, '{"error":"yanlış"}'));
    await expect(api.access('a')).rejects.toMatchObject({ status: 401, message: 'yanlış' });
    expect(out).not.toHaveBeenCalled();
    await expect(api.bots()).rejects.toBeInstanceOf(ApiError);
    expect(out).toHaveBeenCalledTimes(1);
  });

  it("tells the server's own refusal apart from a proxy's error page", async () => {
    fetchMock.mockReturnValueOnce(answer(409, '{"error":"arşivde"}'));
    await expect(api.bots()).rejects.toMatchObject({ status: 409, message: 'arşivde', fromServer: true });
    fetchMock.mockReturnValueOnce(answer(502, '<html>Bad gateway</html>'));
    const err = await api.bots().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, fromServer: false });
  });

  it('reports a request that got no answer at all', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.bots()).rejects.toBeInstanceOf(NoAnswerError);
  });
});
