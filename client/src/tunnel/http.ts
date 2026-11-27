import {
  ACK_STEP,
  BUFFER_HIGH,
  decodeAck,
  decodeFrame,
  encodeAck,
  encodeFrame,
  FRAME,
  MAX_FRAME_PAYLOAD,
  MAX_STREAMS,
  ResponseHead,
  STREAM_WINDOW,
  type RequestHead,
} from '@leafbot/shared/tunnel';
import type { Channel } from './channel';

/** What the server answered, with the body still arriving. */
export interface TunnelResponse {
  status: number;
  headers: Headers;
  body: ReadableStream<Uint8Array>;
}

interface Stream {
  head: (r: TunnelResponse) => void;
  fail: (e: Error) => void;
  /** Set once RESPONSE came: where DATA goes. */
  controller: ReadableStreamDefaultController<Uint8Array> | null;
  /** Response bytes that arrived and are not yet read by the page. */
  queue: Uint8Array[];
  /** Set while the page waits for the next piece of the body. */
  waiting: (() => void) | null;
  ended: boolean;
  /** Bytes the page read and the server was not told of yet. */
  unacked: number;
  /** Request body bytes sent and not yet reported written by the server. */
  inflight: number;
  /** Resolves a sender waiting for the window or the channel's buffer. */
  wake: (() => void) | null;
  done: boolean;
}

/** A request failed before or while its answer came: no answer, a reset, or a closed channel. */
export class TunnelRequestError extends Error {}

/**
 * Requests over the `http` channel, each a numbered stream (`shared/src/tunnel.ts`). Both ways keep
 * to `STREAM_WINDOW`: the server sends no more than that ahead of what the page read, and the page
 * no more than that ahead of what the server wrote into the app.
 */
export class HttpStreams {
  private streams = new Map<number, Stream>();
  private next = 1;
  private over = false;

  constructor(private ch: Channel) {
    ch.onMessage((m) => {
      if (typeof m !== 'string') this.frame(m);
    });
    ch.onDrain(() => {
      for (const s of this.streams.values()) this.wakeUp(s);
    });
    ch.onClose(() => this.destroy(new TunnelRequestError('channel closed')));
  }

  get closed() {
    return this.over;
  }

  private out(type: (typeof FRAME)[keyof typeof FRAME], id: number, payload?: Uint8Array) {
    if (!this.over) this.ch.send(encodeFrame(type, id, payload));
  }

  private wakeUp(s: Stream) {
    const w = s.wake;
    s.wake = null;
    w?.();
  }

  private end(id: number, s: Stream, err: Error | null) {
    if (s.done) return;
    s.done = true;
    this.streams.delete(id);
    this.wakeUp(s);
    const w = s.waiting;
    s.waiting = null;
    w?.();
    if (err) {
      s.fail(err);
      try {
        s.controller?.error(err);
      } catch {
        // Already closed by the page.
      }
    }
  }

  private frame(data: Uint8Array) {
    const f = decodeFrame(data);
    if (!f) return;
    const s = this.streams.get(f.stream);
    if (!s) return;
    switch (f.type) {
      case FRAME.RESPONSE: {
        if (s.controller) return this.reset(f.stream, s);
        let head: ResponseHead;
        try {
          head = ResponseHead.parse(JSON.parse(new TextDecoder().decode(f.payload)));
        } catch {
          return this.reset(f.stream, s);
        }
        const headers = new Headers();
        for (const [k, v] of Object.entries(head.headers)) {
          for (const one of Array.isArray(v) ? v : [v]) {
            try {
              headers.append(k, one);
            } catch {
              // A header the browser does not let a page set; the page could not read it anyway.
            }
          }
        }
        const body = new ReadableStream<Uint8Array>(
          {
            start: (c) => {
              s.controller = c;
            },
            pull: () => this.pull(f.stream, s),
            cancel: () => this.reset(f.stream, s),
          },
          { highWaterMark: 0 },
        );
        s.head({ status: head.status, headers, body });
        return;
      }
      case FRAME.DATA:
        if (!s.controller || s.ended) return this.reset(f.stream, s);
        s.queue.push(f.payload.slice());
        return this.feed(f.stream, s);
      case FRAME.END:
        if (!s.controller) return this.end(f.stream, s, new TunnelRequestError('no response'));
        s.ended = true;
        return this.feed(f.stream, s);
      case FRAME.RESET:
        return this.end(f.stream, s, new TunnelRequestError('reset'));
      case FRAME.ACK: {
        const n = decodeAck(f.payload);
        if (n === null) return;
        s.inflight = Math.max(0, s.inflight - n);
        this.wakeUp(s);
        return;
      }
    }
  }

  /** The page wants more of the body: hand over the next piece, or wait until it comes. */
  private pull(id: number, s: Stream): Promise<void> | void {
    if (this.give(id, s)) return;
    return new Promise<void>((r) => {
      s.waiting = r;
    });
  }

  /** A piece (or the end) came in: hand it to a page that is waiting for it. */
  private feed(id: number, s: Stream) {
    const w = s.waiting;
    if (!w) return;
    s.waiting = null;
    if (this.give(id, s)) w();
    else s.waiting = w;
  }

  /** Enqueues the next piece or closes the body; false when there is nothing to give yet. */
  private give(id: number, s: Stream): boolean {
    if (s.done || !s.controller) return true;
    const chunk = s.queue.shift();
    if (chunk) {
      s.controller.enqueue(chunk);
      this.read(id, s, chunk.byteLength);
      return true;
    }
    if (s.ended) {
      s.controller.close();
      this.end(id, s, null);
      return true;
    }
    return false;
  }

  private read(id: number, s: Stream, n: number) {
    s.unacked += n;
    if (s.unacked >= ACK_STEP || s.queue.length === 0) {
      const used = s.unacked;
      s.unacked = 0;
      if (!s.done && !s.ended) this.out(FRAME.ACK, id, encodeAck(used));
    }
  }

  private reset(id: number, s: Stream) {
    if (s.done) return;
    this.out(FRAME.RESET, id);
    this.end(id, s, new TunnelRequestError('reset'));
  }

  /**
   * Sends one request. Resolves when the server's answer begins; its body is read as it arrives. A
   * body is sent within the window, a frame at a time, waiting while the channel's buffer is full.
   */
  request(
    head: RequestHead,
    body: ReadableStream<Uint8Array> | Uint8Array | null,
    signal?: AbortSignal,
  ): Promise<TunnelResponse> {
    if (this.over) return Promise.reject(new TunnelRequestError('channel closed'));
    if (this.streams.size >= MAX_STREAMS) return Promise.reject(new TunnelRequestError('too many requests'));
    const id = this.next;
    this.next = this.next >= 0xffffffff ? 1 : this.next + 1;
    return new Promise<TunnelResponse>((resolve, reject) => {
      const s: Stream = {
        head: resolve,
        fail: reject,
        controller: null,
        queue: [],
        waiting: null,
        ended: false,
        unacked: 0,
        inflight: 0,
        wake: null,
        done: false,
      };
      this.streams.set(id, s);
      if (signal) {
        const abort = () => {
          const err = new DOMException('Aborted', 'AbortError');
          if (s.done) return;
          this.out(FRAME.RESET, id);
          this.end(id, s, err);
        };
        if (signal.aborted) return abort();
        signal.addEventListener('abort', abort, { once: true });
      }
      this.out(FRAME.REQUEST, id, new TextEncoder().encode(JSON.stringify(head)));
      void this.sendBody(id, s, body).catch(() => this.reset(id, s));
    });
  }

  private async room(s: Stream, need: number) {
    while (!s.done && (s.inflight + need > STREAM_WINDOW || this.ch.bufferedAmount >= BUFFER_HIGH)) {
      await new Promise<void>((r) => {
        s.wake = r;
      });
    }
  }

  private async sendBody(id: number, s: Stream, body: ReadableStream<Uint8Array> | Uint8Array | null) {
    if (body) {
      const reader =
        body instanceof Uint8Array ? null : (body.getReader() as ReadableStreamDefaultReader<Uint8Array>);
      let pending: Uint8Array | null = body instanceof Uint8Array ? body : null;
      for (;;) {
        if (!pending || pending.byteLength === 0) {
          if (!reader) break;
          const r = await reader.read();
          if (r.done) break;
          pending = r.value;
          continue;
        }
        const n = Math.min(pending.byteLength, MAX_FRAME_PAYLOAD);
        await this.room(s, n);
        if (s.done) {
          void reader?.cancel();
          return;
        }
        this.out(FRAME.DATA, id, pending.subarray(0, n));
        s.inflight += n;
        pending = pending.subarray(n);
      }
    }
    if (!s.done) this.out(FRAME.END, id);
  }

  destroy(err: Error = new TunnelRequestError('closed')) {
    if (this.over) return;
    this.over = true;
    for (const [id, s] of [...this.streams]) this.end(id, s, err);
    this.ch.close();
  }
}

const NULL_BODY = new Set([101, 103, 204, 205, 304]);

/**
 * A `fetch` for paths on the server, answered over the tunnel. Only paths are sent, never a full
 * address: the server writes the Host itself, so nothing here can reach another site.
 */
export async function tunnelFetch(
  http: () => Promise<HttpStreams>,
  input: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!input.startsWith('/') || input.startsWith('//')) throw new TypeError('tunnel requests take a path');
  // A Request reads every body type (string, Blob, FormData, URLSearchParams) and sets its type.
  const req = new Request(`http://tunnel.invalid${input}`, init);
  const method = req.method.toUpperCase() as RequestHead['method'];
  const headers: Record<string, string> = {};
  req.headers.forEach((v, k) => {
    headers[k] = v;
  });
  let body: Uint8Array | null = null;
  if (method !== 'GET' && method !== 'HEAD' && req.body) body = new Uint8Array(await req.arrayBuffer());
  const url = new URL(req.url);
  const res = await (
    await http()
  ).request(
    { method, path: url.pathname + url.search, headers, ...(body ? { length: body.byteLength } : {}) },
    body,
    init.signal ?? undefined,
  );
  if (res.status < 200 || NULL_BODY.has(res.status) || method === 'HEAD') {
    void res.body.cancel();
    return new Response(null, { status: res.status < 200 ? 502 : res.status, headers: res.headers });
  }
  return new Response(res.body, { status: res.status, headers: res.headers });
}
