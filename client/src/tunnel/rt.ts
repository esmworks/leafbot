import { encodeRt, RtAssembler } from '@leafbot/shared/tunnel';
import type { Channel } from './channel';

type Data = string | ArrayBuffer | ArrayBufferView | Blob;

/**
 * One Socket.IO connection over an `rt` channel, shaped like the browser's `WebSocket` as far as
 * Socket.IO's WebSocket transport uses it: `onopen`, `onmessage`, `onclose`, `onerror`, `send` and
 * `close`. Each WebSocket message travels as one or more pieces (`encodeRt`).
 */
export class RtSocket {
  binaryType: 'arraybuffer' | 'blob' = 'arraybuffer';
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string | ArrayBuffer }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  private ch: Channel | null = null;
  /** Blobs are read before they go, so messages keep their order. */
  private sending: Promise<void> = Promise.resolve();

  constructor(open: () => Promise<Channel>) {
    open().then(
      (ch) => this.attach(ch),
      (err) => {
        this.onerror?.(err);
        this.finish();
      },
    );
  }

  private attach(ch: Channel) {
    if (this.readyState !== 0) return ch.close();
    this.ch = ch;
    const pieces = new RtAssembler();
    ch.onMessage((raw) => {
      let m: string | Uint8Array | null;
      try {
        if (typeof raw === 'string') throw new Error('text piece');
        m = pieces.push(raw);
      } catch {
        return this.close();
      }
      if (m === null) return;
      const data = typeof m === 'string' ? m : m.slice().buffer;
      this.onmessage?.({ data });
    });
    ch.onClose(() => this.finish());
    this.readyState = 1;
    this.onopen?.();
  }

  send(data: Data) {
    if (this.readyState !== 1 || !this.ch) throw new Error('not open');
    const ch = this.ch;
    this.sending = this.sending.then(async () => {
      let m: string | Uint8Array;
      if (typeof data === 'string') m = data;
      else if (data instanceof Blob) m = new Uint8Array(await data.arrayBuffer());
      else if (data instanceof ArrayBuffer) m = new Uint8Array(data);
      else m = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (this.readyState !== 1) return;
      for (const piece of encodeRt(m)) ch.send(piece);
    });
    // A channel that closed before its close event reached this socket refuses the send; the
    // socket closes as it would on that event, rather than leaving the error unhandled, which ends
    // a Node process.
    this.sending = this.sending.catch(() => this.close());
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.ch?.close();
    this.finish();
  }

  private finish() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.onclose?.({ code: 1000, reason: '' });
  }
}
