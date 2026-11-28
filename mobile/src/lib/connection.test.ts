import { afterEach, describe, expect, it } from 'vitest';
import { NoAnswerError } from '@leafbot/client';
import {
  TunnelError,
  TunnelRequestError,
  type RawRequest,
  type TunnelResponse,
} from '@leafbot/client/tunnel';
import { serverFetch, setLink } from './connection';
import { Link, type LiveTunnel } from './tunnelLink';

const settle = () => new Promise((r) => setTimeout(r, 0));

const answered = (): TunnelResponse => ({
  status: 200,
  headers: new Headers(),
  body: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
});

/** A tunnel that answers, or fails every request with what `fail` gives; `sent` lists the methods. */
function fakeTunnel(fail?: (init: RawRequest | undefined) => Promise<never>) {
  const sent: string[] = [];
  const t: LiveTunnel = {
    request: (_path, init) => {
      sent.push(init?.method ?? 'GET');
      return fail ? fail(init) : Promise.resolve(answered());
    },
    realtime: () => {
      throw new Error('unused');
    },
    close: () => undefined,
  };
  return { t, sent };
}

let link: Link | null = null;

/** A link whose first tunnel is dead: a request on it fails with `err` as the tunnel ends. The next one answers. */
async function deadThenLive(err: Error) {
  const ends: ((c: string) => void)[] = [];
  const first = fakeTunnel(() => {
    ends[0]?.('closed');
    return Promise.reject(err);
  });
  const second = fakeTunnel();
  link = new Link({
    sleep: async () => undefined,
    open: async (onEnd) => {
      ends.push(onEnd);
      return ends.length === 1 ? first.t : second.t;
    },
  });
  link.start();
  await settle();
  setLink(link);
  return { first, second };
}

afterEach(() => {
  link?.stop();
  link = null;
  setLink(null);
});

describe('serverFetch', () => {
  it('reads again on the next tunnel when the one it went on was dead', async () => {
    const { first, second } = await deadThenLive(new TunnelRequestError('closed'));
    const res = await serverFetch('/api/bots');
    expect(res.status).toBe(200);
    expect(first.sent).toEqual(['GET']);
    expect(second.sent).toEqual(['GET']);
  });

  it('does not send a change again when it may have reached the server', async () => {
    const { second } = await deadThenLive(new TunnelRequestError('closed'));
    const err = await serverFetch('/api/bots', { method: 'POST' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NoAnswerError);
    expect(second.sent).toEqual([]);
  });

  it('sends a change again when the tunnel was over before it went out', async () => {
    const { second } = await deadThenLive(new TunnelError('closed'));
    const res = await serverFetch('/api/bots', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(second.sent).toEqual(['POST']);
  });

  it('sends nothing again after a call-off or an answer that took too long', async () => {
    const abortError = () => new DOMException('Aborted', 'AbortError');
    // Fails the way the tunnel does once the request is called off.
    const slow = fakeTunnel((init) =>
      init?.signal?.aborted
        ? Promise.reject(abortError())
        : new Promise<never>((_, fail) => init?.signal?.addEventListener('abort', () => fail(abortError()))),
    );
    link = new Link({ open: async () => slow.t });
    link.start();
    await settle();
    setLink(link);

    const late = await serverFetch('/api/bots', { timeoutMs: 5 }).catch((e: unknown) => e);
    expect(late).toBeInstanceOf(NoAnswerError);
    expect(slow.sent).toEqual(['GET']);

    const ctrl = new AbortController();
    ctrl.abort();
    const off = await serverFetch('/api/bots', { signal: ctrl.signal }).catch((e: unknown) => e);
    expect(off).toBeInstanceOf(DOMException);
    expect(slow.sent).toEqual(['GET', 'GET']);
  });
});
