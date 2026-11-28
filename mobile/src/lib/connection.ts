import { NoAnswerError } from '@leafbot/client';
import { sendAgain } from './reconnect';
import type { Link, LiveTunnel } from './tunnelLink';

/**
 * The phone's one link to the chosen server, set by the provider while a server is chosen. Requests
 * and sockets read it when they are made, never keep an earlier tunnel, so each goes through
 * whichever tunnel is open now, including one opened again after the old one dropped.
 */
let current: Link | null = null;

export function setLink(link: Link | null) {
  current = link;
}

export function getLink(): Link | null {
  return current;
}

/** How long a request waits for the head of the server's answer. */
export const HEAD_TIMEOUT_MS = 15_000;

export interface ServerRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | null;
  signal?: AbortSignal | undefined;
  /** How long the answer's head may take; `HEAD_TIMEOUT_MS` by default. */
  timeoutMs?: number;
}

/** An answer from the server with its body not yet read. */
export interface ServerResponse {
  ok: boolean;
  status: number;
  headers: Headers;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  /** Gives up on the rest of the body. */
  cancel(): void;
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const r = await reader.read();
    if (r.done) break;
    parts.push(r.value);
    size += r.value.byteLength;
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * A request to a path on the server, through the tunnel that is open (waiting a little for one that
 * is being opened again). Only a path is sent; the server decides what it is at. A request the
 * tunnel failed under, as when the app comes back from the background on a dead one, goes once
 * more on the next tunnel when that cannot make a change twice (`sendAgain`). No answer, no tunnel
 * and a head that takes too long all come out as `NoAnswerError`; a call-off by `signal` stays an
 * abort.
 */
export async function serverFetch(path: string, init: ServerRequest = {}): Promise<ServerResponse> {
  const link = current;
  if (!link) throw new NoAnswerError('no server');
  try {
    const tunnel = await link.tunnel();
    try {
      return await requestOn(tunnel, path, init);
    } catch (err) {
      if (init.signal?.aborted || !sendAgain(err, init.method)) throw err;
      return await requestOn(await link.tunnelAfter(tunnel), path, init);
    }
  } catch (err) {
    if (init.signal?.aborted) throw err;
    throw new NoAnswerError(err instanceof Error ? err.message : String(err));
  }
}

/** One request on one tunnel, given `timeoutMs` for the head of the answer. */
async function requestOn(tunnel: LiveTunnel, path: string, init: ServerRequest): Promise<ServerResponse> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs ?? HEAD_TIMEOUT_MS);
  const stop = () => ctrl.abort();
  if (init.signal?.aborted) stop();
  else init.signal?.addEventListener('abort', stop, { once: true });
  try {
    const res = await tunnel.request(path, {
      ...(init.method ? { method: init.method } : {}),
      ...(init.headers ? { headers: init.headers } : {}),
      body: init.body ?? null,
      signal: ctrl.signal,
    });
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: res.headers,
      bytes: () => collect(res.body),
      text: async () => new TextDecoder().decode(await collect(res.body)),
      cancel: () => void res.body.cancel().catch(() => undefined),
    };
  } finally {
    clearTimeout(timer);
    init.signal?.removeEventListener('abort', stop);
  }
}

/** The bytes of a `Blob` (a picked file or a recording): `FileReader` on the phone, which has no `Blob.arrayBuffer`. */
export function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer().then((b) => new Uint8Array(b));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsArrayBuffer(blob);
  });
}
