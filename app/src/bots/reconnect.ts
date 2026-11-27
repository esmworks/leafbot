import { TunnelError } from '@leafbot/client/tunnel';
import { ConnectError } from '@leafbot/client/webrtc';
import { AccountError } from './account';

/**
 * Ends a restart or a passing network fault explains: the connection went away, the server is not at
 * the relay while it restarts, the relay or the setup failed, or the server was busy. A refusal (access
 * taken away, a ticket the server will not take, a server too old, a key that does not match) stays
 * until someone changes something, so trying again would only hide it.
 */
const PASSING = new Set<string>(['closed', 'timeout', 'offline', 'relay', 'failed', 'busy']);

export function passing(err: unknown): boolean {
  if (err instanceof TunnelError || err instanceof ConnectError) return PASSING.has(err.code);
  // The account service out of reach or restarting; a 4xx is an answer about this person.
  if (err instanceof AccountError) return err.status === 0 || err.status >= 500;
  return false;
}

/** Waits between attempts: quick at first, as a restart takes seconds, then no more than every 30 s. */
export function reconnectDelay(attempt: number): number {
  return Math.min(1000 * 2 ** attempt, 30_000);
}

/** How long the page keeps trying before it says the connection was lost and waits for the person. */
export const RECONNECT_FOR_MS = 5 * 60_000;

export interface Reconnect {
  /** Opens a new tunnel; it rejects with why it could not. */
  open: () => Promise<void>;
  /** Whether to go on: false once the person left the server or picked another. */
  current: () => boolean;
  /** Gives up with the last reason; not called when `current` turned false. */
  fail: (err: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Tries to open the tunnel again until it opens, a refusal comes, the time runs out, or the person
 * moves on. Each wait is checked against `current` so an abandoned attempt opens nothing.
 */
export async function reconnect(r: Reconnect): Promise<void> {
  const sleep = r.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const now = r.now ?? Date.now;
  const until = now() + RECONNECT_FOR_MS;
  for (let attempt = 0; ; attempt++) {
    await sleep(reconnectDelay(attempt));
    if (!r.current()) return;
    try {
      await r.open();
      return;
    } catch (err) {
      if (!r.current()) return;
      if (!passing(err) || now() >= until) return r.fail(err);
    }
  }
}
