import { ApiError } from '@leafbot/client';
import { AppState } from 'react-native';

/** What a proxy in front of the server answers while the server is away (a restart, a redeploy). */
const AWAY = [502, 503, 504];

/**
 * A send that failed because the server could not be reached, not because it said no: no answer
 * came (the phone was coming back from the background, or was off the network), or a proxy answered
 * for a server that is away. Any other error is one a second try would only repeat.
 */
export const isOffline = (err: unknown): boolean =>
  err instanceof ApiError ? AWAY.includes(err.status) && !err.fromServer : true;

/** Waits between tries; the last one is the final one. */
const BACKOFF_MS = [3_000, 8_000, 20_000, 45_000];
/** A message older than this is not sent behind the person's back after a long absence. */
const GIVE_UP_MS = 5 * 60_000;

interface Deps {
  offline?: (err: unknown) => boolean;
  /** Resolves when the app is in the foreground; at once if it already is. */
  active?: () => Promise<void>;
  wait?: (ms: number) => Promise<void>;
  now?: () => number;
  backoff?: number[];
}

const appActive = () =>
  AppState.currentState === 'active'
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
        const sub = AppState.addEventListener('change', (s) => {
          if (s !== 'active') return;
          sub.remove();
          resolve();
        });
      });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `attempt`, and runs it again while it fails for want of a connection: only once the app is
 * in the foreground, after a growing wait, and for a few minutes at most. Every try carries the
 * same client message id, so a send that did reach the server counts once. The error that ends it
 * is the last one thrown.
 */
export async function sendWithRetry<T>(attempt: () => Promise<T>, deps: Deps = {}): Promise<T> {
  const {
    offline = isOffline,
    active = appActive,
    wait = sleep,
    now = Date.now,
    backoff = BACKOFF_MS,
  } = deps;
  const started = now();
  for (let i = 0; ; i++) {
    try {
      return await attempt();
    } catch (err) {
      if (!offline(err) || i >= backoff.length) throw err;
      await active();
      await wait(backoff[i]!);
      if (now() - started > GIVE_UP_MS) throw err;
    }
  }
}
