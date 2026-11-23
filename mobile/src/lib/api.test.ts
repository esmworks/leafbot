import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiFor, ApiError } from './api';

// The real catalogs read the phone's language through a native module.
vi.mock('@/i18n', () => ({ locale: 'tr', t: (key: string) => key }));

const ORIGIN = 'https://bot.example';
const fetchMock = vi.fn<typeof fetch>();

/** An answer with this status and body, as the server or a proxy in front of it gives it. */
const answer = (status: number, body: string) => Promise.resolve(new Response(body, { status }));

/** What the app asked fetch for in its nth call. */
const call = (n = 0) => {
  const [url, init] = fetchMock.mock.calls[n] ?? [];
  return { url, init: init ?? {}, headers: (init?.headers ?? {}) as Record<string, string> };
};

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('apiFor', () => {
  it('sends a write to the server address, saying which origin it comes from', async () => {
    fetchMock.mockImplementation(() => answer(200, '{"id":"b1"}'));
    expect(await apiFor(ORIGIN).updateBot('b1', { name: 'x' })).toEqual({ id: 'b1' });
    const { url, init, headers } = call();
    expect(url).toBe(`${ORIGIN}/api/bots/b1`);
    expect(init).toMatchObject({ method: 'PATCH', credentials: 'include', body: '{"name":"x"}' });
    expect(headers).toMatchObject({
      origin: ORIGIN,
      'content-type': 'application/json',
      'accept-language': 'tr',
      accept: 'application/json',
    });
  });

  it('leaves the origin out of a read', async () => {
    fetchMock.mockImplementation(() => answer(200, '[]'));
    await apiFor(ORIGIN).bots();
    expect(call().headers.origin).toBeUndefined();
    expect(call().headers['content-type']).toBeUndefined();
  });

  it('sends a recording with its own type, not as a plain file', async () => {
    fetchMock.mockImplementation(() => answer(200, '{"text":"merhaba"}'));
    const audio = new Blob(['x'], { type: 'audio/mp4' });
    expect(await apiFor(ORIGIN).transcribe(audio, 'tr')).toEqual({ text: 'merhaba' });
    expect(call().init.body).toBe(audio);
    expect(call().headers['content-type']).toBe('audio/mp4');
  });

  it('gives addresses handed to a viewer the server address', () => {
    expect(apiFor(ORIGIN).fileUrl('b1', 'a b.png', { inline: true })).toBe(
      `${ORIGIN}/api/bots/b1/library/file?path=a%20b.png&inline=1`,
    );
  });

  it("tells the server's own refusal apart from a proxy's error page", async () => {
    fetchMock.mockImplementationOnce(() => answer(409, '{"error":"arşivde"}'));
    await expect(apiFor(ORIGIN).bots()).rejects.toMatchObject({
      status: 409,
      message: 'arşivde',
      fromServer: true,
    });
    fetchMock.mockImplementationOnce(() => answer(502, '<html>Bad gateway</html>'));
    const err = await apiFor(ORIGIN)
      .bots()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, message: 'error.requestFailed', fromServer: false });
  });

  it('gives up on a server that never answers', async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) =>
            init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError'))),
          ),
      );
      const pending = apiFor(ORIGIN).bots();
      const caught = pending.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(await caught).toMatchObject({ name: 'AbortError' });
    } finally {
      vi.useRealTimers();
    }
  });
});
