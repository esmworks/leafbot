import { TunnelError, TunnelRequestError } from '@leafbot/client/tunnel';
import { ConnectError } from '@leafbot/client/webrtc';
import { AccountError } from './account';

/**
 * Ends a restart or a passing network fault explains: the connection went away, the server is not at
 * the relay while it restarts, the relay or the setup failed, or the server was busy. A refusal (access
 * taken away, a ticket the server will not take, a server too old, a key that does not match) stays
 * until the sign-in changes, so trying again would only hide it.
 */
const PASSING = new Set<string>(['closed', 'timeout', 'offline', 'relay', 'failed', 'busy']);

/** Whether a tunnel's end (a code) is one to open again after. */
export function passingEnd(code: string): boolean {
  return PASSING.has(code);
}

/** Whether a failure to open is worth trying again. */
export function passing(err: unknown): boolean {
  if (err instanceof TunnelError || err instanceof ConnectError) return PASSING.has(err.code);
  // The account service out of reach, restarting or asking for fewer requests; any other 4xx is an
  // answer about this person.
  if (err instanceof AccountError)
    return err.status === 0 || err.status === 408 || err.status === 429 || err.status >= 500;
  // WebRTC itself failing on this phone is tried again later, as slowly as the rest.
  return true;
}

/** A short name for why opening failed, for the screen to word: the server's own code when it has one. */
export function reasonOf(err: unknown): string {
  if (err instanceof TunnelError || err instanceof ConnectError) return err.code;
  if (err instanceof AccountError)
    return err.status === 401 ? 'signed-out' : err.status === 0 ? 'account' : 'account-error';
  return 'failed';
}

/**
 * What the WebRTC stack said when opening failed on this device, for the screen to show under the
 * reason; null when there is nothing beyond the reason itself.
 */
export function detailOf(err: unknown): string | null {
  if (err instanceof ConnectError) return err.detail ?? null;
  if (err instanceof TunnelError || err instanceof AccountError) return null;
  const text = err instanceof Error ? err.message || err.name : String(err);
  return text ? text.slice(0, 200) : null;
}

/** Waits between attempts: quick at first, as a restart takes seconds, then no more than every 30 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

/**
 * Whether a request that failed on a tunnel may go again on the next one. A tunnel already over sent
 * nothing, so any request may; one cut off on the way may have reached the server, so only a read
 * goes again, never a change that might then be made twice.
 */
export function sendAgain(err: unknown, method = 'GET'): boolean {
  if (err instanceof TunnelError) return passingEnd(err.code);
  const read = method === 'GET' || method === 'HEAD';
  return (
    read &&
    err instanceof TunnelRequestError &&
    (err.message === 'closed' || err.message === 'channel closed')
  );
}
