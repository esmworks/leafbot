import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NoAnswerError } from '@leafbot/client';
import { apiFor, ApiError } from './api';
import type { ServerRequest, ServerResponse } from './connection';

// The real catalogs read the phone's language through a native module.
vi.mock('@/i18n', () => ({ locale: 'tr', t: (key: string) => key }));

type Fetch = (path: string, init?: ServerRequest) => Promise<ServerResponse>;
const calls: [string, ServerRequest | undefined][] = [];
let impl: Fetch = () => Promise.reject(new Error('no answer set'));
const serverFetch = {
  /** Answers every call from now on with this, and forgets the calls so far. */
  use(next: Fetch) {
    calls.length = 0;
    impl = next;
  },
  once(next: Fetch) {
    const rest = impl;
    impl = (path, init) => {
      impl = rest;
      return next(path, init);
    };
  },
};
vi.mock('./connection', () => ({
  serverFetch: (path: string, init?: ServerRequest) => {
    calls.push([path, init]);
    return impl(path, init);
  },
  blobBytes: async (blob: Blob) => new Uint8Array(await blob.arrayBuffer()),
}));

/** An answer with this status and body, as the server or a proxy in front of it gives it. */
const answer = (status: number, body: string) =>
  Promise.resolve<ServerResponse>({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    bytes: async () => new TextEncoder().encode(body),
    text: async () => body,
    cancel: () => undefined,
  });

/** What the app asked the tunnel for in its nth call. */
const call = (n = 0) => {
  const [path, init] = calls[n] ?? [];
  return { path, init: init ?? {}, headers: init?.headers ?? {} };
};

beforeEach(() => serverFetch.use(() => Promise.reject(new Error('no answer set'))));

describe('apiFor', () => {
  it('sends a write as JSON to a path on the server, with no origin or cookie', async () => {
    serverFetch.use(() => answer(200, '{"id":"b1"}'));
    expect(await apiFor().updateBot('b1', { name: 'x' })).toEqual({ id: 'b1' });
    const { path, init, headers } = call();
    expect(path).toBe('/api/bots/b1');
    expect(init.method).toBe('PATCH');
    expect(new TextDecoder().decode(init.body ?? new Uint8Array())).toBe('{"name":"x"}');
    expect(headers).toMatchObject({
      'content-type': 'application/json',
      'accept-language': 'tr',
      accept: 'application/json',
    });
    expect(headers).not.toHaveProperty('origin');
  });

  it('sends no body or content type with a read', async () => {
    serverFetch.use(() => answer(200, '[]'));
    await apiFor().bots();
    expect(call().init.body).toBeNull();
    expect(call().headers['content-type']).toBeUndefined();
  });

  it('sends a recording as the bytes it is, with the longer wait of a file', async () => {
    serverFetch.use(() => answer(200, '{"text":"merhaba"}'));
    const audio = new Blob(['x'], { type: 'audio/mp4' });
    expect(await apiFor().transcribe(audio, 'tr')).toEqual({ text: 'merhaba' });
    expect(call().init.body).toEqual(new Uint8Array([120]));
    expect(call().init.timeoutMs).toBeGreaterThan(60_000);
  });

  it("tells the server's own refusal apart from a proxy's error page", async () => {
    serverFetch.once(() => answer(409, '{"error":"arşivde"}'));
    await expect(apiFor().bots()).rejects.toMatchObject({
      status: 409,
      message: 'arşivde',
      fromServer: true,
    });
    serverFetch.once(() => answer(502, '<html>Bad gateway</html>'));
    const err = await apiFor()
      .bots()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(err).toMatchObject({ status: 502, message: 'error.requestFailed', fromServer: false });
  });

  it('lets a missing answer through as NoAnswerError', async () => {
    const down = new NoAnswerError('no tunnel');
    serverFetch.use(() => Promise.reject(down));
    let err: unknown = null;
    try {
      await apiFor().bots();
    } catch (e) {
      err = e;
    }
    expect(err).toBe(down);
  });
});
