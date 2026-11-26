import { BUFFER_LOW } from '@leafbot/shared/tunnel';
import type { TunnelChannel, TunnelPeer } from '../src/tunnel/gateway';

export const CLIENT_FP = 'sha-256 AA:01:02';
export const SERVER_FP = 'sha-256 BB:03:04';

// ---- A data channel pair, delivering asynchronously like a real one ---------------------------

const size = (m: string | Uint8Array) => (typeof m === 'string' ? Buffer.byteLength(m) : m.byteLength);

export class End implements TunnelChannel {
  other!: End;
  bufferedAmount = 0;
  /** The most that ever waited in this end's send buffer. */
  maxBuffered = 0;
  closed = false;
  /** Bytes delivered per millisecond; 0 delivers each message on the next turn. */
  slow = 0;
  private queue: (string | Uint8Array)[] = [];
  private pumping = false;
  private message: ((d: string | Uint8Array) => void)[] = [];
  private closeCbs: (() => void)[] = [];
  private drainCbs: (() => void)[] = [];
  constructor(readonly label: string) {}
  private deliver(m: string | Uint8Array) {
    if (!this.other.closed) for (const cb of this.other.message) cb(m);
  }
  send(d: string | Uint8Array) {
    if (this.closed) throw new Error('closed');
    const copy = typeof d === 'string' ? d : new Uint8Array(d);
    if (!this.slow) return void setImmediate(() => this.deliver(copy));
    this.queue.push(copy);
    this.bufferedAmount += size(copy);
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
    if (this.pumping) return;
    this.pumping = true;
    const tick = () => {
      let budget = this.slow;
      while (this.queue.length && budget > 0) {
        const m = this.queue.shift()!;
        budget -= size(m);
        const was = this.bufferedAmount;
        this.bufferedAmount -= size(m);
        this.deliver(m);
        if (was > BUFFER_LOW && this.bufferedAmount <= BUFFER_LOW) for (const cb of this.drainCbs) cb();
      }
      if (this.queue.length && !this.closed) setTimeout(tick, 1);
      else this.pumping = false;
    };
    setTimeout(tick, 1);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => {
      for (const cb of this.closeCbs) cb();
      this.other.close();
    });
  }
  onMessage(cb: (d: string | Uint8Array) => void) {
    this.message.push(cb);
  }
  onClose(cb: () => void) {
    this.closeCbs.push(cb);
  }
  onDrain(cb: () => void) {
    this.drainCbs.push(cb);
  }
}

export class FakePeer implements TunnelPeer {
  localFingerprint = SERVER_FP;
  remoteFingerprint = CLIENT_FP;
  closed = false;
  serverEnds: End[] = [];
  private channelCb: ((ch: TunnelChannel) => void) | null = null;
  private closeCbs: (() => void)[] = [];
  onChannel(cb: (ch: TunnelChannel) => void) {
    this.channelCb = cb;
  }
  onClose(cb: () => void) {
    this.closeCbs.push(cb);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
  }
  /** The browser opens a channel; returns its end. `slow` holds the server's sends back. */
  open(label: string, slow = 0): End {
    const browser = new End(label);
    const server = new End(label);
    server.slow = slow;
    this.serverEnds.push(server);
    browser.other = server;
    server.other = browser;
    setImmediate(() => this.channelCb?.(server));
    return browser;
  }
}
