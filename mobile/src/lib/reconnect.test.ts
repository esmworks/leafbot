import { describe, expect, it } from 'vitest';
import { TunnelError, TunnelRequestError } from '@leafbot/client/tunnel';
import { ConnectError } from '@leafbot/client/webrtc';
import { sendAgain } from './reconnect';

describe('sendAgain', () => {
  it('sends any request again when the tunnel was already over, as nothing went out', () => {
    expect(sendAgain(new TunnelError('closed'), 'POST')).toBe(true);
    expect(sendAgain(new TunnelError('closed'))).toBe(true);
    expect(sendAgain(new ConnectError('failed'), 'POST')).toBe(true);
    expect(sendAgain(new TunnelError('timeout'), 'POST')).toBe(false);
    expect(sendAgain(new TunnelError('host-proof'), 'GET')).toBe(false);
  });

  it('sends only a read again when the tunnel closed under it, as a change may have arrived', () => {
    expect(sendAgain(new TunnelRequestError('closed'), 'GET')).toBe(true);
    expect(sendAgain(new TunnelRequestError('channel closed'))).toBe(true);
    expect(sendAgain(new TunnelRequestError('closed'), 'POST')).toBe(false);
    expect(sendAgain(new TunnelRequestError('reset'), 'GET')).toBe(false);
  });

  it('leaves a call-off and other failures alone', () => {
    expect(sendAgain(new DOMException('Aborted', 'AbortError'))).toBe(false);
    expect(sendAgain(new Error('closed'))).toBe(false);
  });
});
