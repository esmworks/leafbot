import type { TunnelEndCode } from '@leafbot/client/tunnel';

/** How long a tunnel must have worked before its drop is taken as passing rather than as a fault. */
export const STEADY_MS = 5_000;

/** A tunnel open this long counts as working again, so its drop starts the count over. */
export const SETTLED_MS = 60_000;

/** How many times in a row the panel opens a dropped tunnel by itself. */
export const MAX_REOPENS = 3;

/**
 * How long to wait before opening a tunnel that ended again by itself, or null to wait for the
 * person: only after it worked a while and then dropped (the server restarted, or the person got
 * another role), a few times in a row at most, waiting longer each time. A refusal, or a tunnel that
 * keeps dropping, waits for the person.
 */
export function reopenDelay(code: TunnelEndCode, openFor: number, reopened: number): number | null {
  if ((code !== 'closed' && code !== 'timeout') || openFor < STEADY_MS) return null;
  const n = openFor >= SETTLED_MS ? 0 : reopened;
  return n < MAX_REOPENS ? 1_000 * 2 ** n : null;
}
