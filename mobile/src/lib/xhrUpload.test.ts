import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { xhrUpload } from './xhrUpload';

class FakeXhr {
  static last: FakeXhr;
  upload: { onprogress?: (e: { loaded: number; total: number; lengthComputable: boolean }) => void } = {};
  onload?: () => void;
  onerror?: () => void;
  ontimeout?: () => void;
  status = 0;
  responseText = '';
  withCredentials = false;
  aborted = false;
  headers: Record<string, string> = {};
  constructor() {
    FakeXhr.last = this;
  }
  open() {}
  setRequestHeader(name: string, value: string) {
    this.headers[name] = value;
  }
  send() {}
  abort() {
    this.aborted = true;
  }
}

const req = (extra = {}) => ({
  url: 'https://bot.example/api/x',
  method: 'POST',
  headers: { origin: 'https://bot.example' },
  body: new Blob(['x']),
  idleMs: 60_000,
  ...extra,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('XMLHttpRequest', FakeXhr);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('xhrUpload', () => {
  it('keeps going past the idle limit in total while data still flows, and reports progress', async () => {
    const progress: number[] = [];
    const p = xhrUpload(req({ onProgress: (n: number) => progress.push(n) }));
    for (let i = 1; i <= 5; i++) {
      await vi.advanceTimersByTimeAsync(50_000);
      FakeXhr.last.upload.onprogress?.({ loaded: i, total: 5, lengthComputable: true });
    }
    FakeXhr.last.status = 200;
    FakeXhr.last.responseText = '{"name":"a"}';
    FakeXhr.last.onload?.();
    await expect(p).resolves.toEqual({ ok: true, status: 200, text: '{"name":"a"}' });
    expect(progress).toEqual([0.2, 0.4, 0.6, 0.8, 1]);
    expect(FakeXhr.last.headers.origin).toBe('https://bot.example');
    expect(FakeXhr.last.withCredentials).toBe(true);
  });

  it('cuts the upload off after the idle limit with no progress', async () => {
    const caught = xhrUpload(req()).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await caught).toMatchObject({ name: 'AbortError' });
    expect(FakeXhr.last.aborted).toBe(true);
  });

  it('fails as a dropped connection, or when called off', async () => {
    const dropped = xhrUpload(req()).catch((e: unknown) => e);
    FakeXhr.last.onerror?.();
    expect(await dropped).toBeInstanceOf(TypeError);

    const ctrl = new AbortController();
    const off = xhrUpload(req({ signal: ctrl.signal })).catch((e: unknown) => e);
    ctrl.abort();
    expect(await off).toMatchObject({ name: 'AbortError' });
  });
});
