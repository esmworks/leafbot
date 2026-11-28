import { describe, expect, it, vi } from 'vitest';
import type { Channel } from './channel';
import { RtSocket } from './rt';

/** A channel whose far end has gone: every send throws, as an `RTCDataChannel` does once closed. */
function closedChannel(): Channel & { closed: boolean } {
  return {
    label: 'rt',
    bufferedAmount: 0,
    closed: false,
    send() {
      throw new Error('DataChannel is closed');
    },
    close() {
      this.closed = true;
    },
    onMessage() {},
    onClose() {},
    onDrain() {},
  };
}

describe('RtSocket', () => {
  it('closes instead of leaving an unhandled error when its channel refuses a send', async () => {
    const ch = closedChannel();
    const socket = new RtSocket(() => Promise.resolve(ch));
    await vi.waitFor(() => expect(socket.readyState).toBe(1));
    const onclose = vi.fn();
    socket.onclose = onclose;
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      socket.send('2probe');
      socket.send('2probe');
      await vi.waitFor(() => expect(onclose).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).not.toHaveBeenCalled();
      expect(socket.readyState).toBe(3);
      expect(ch.closed).toBe(true);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });
});
