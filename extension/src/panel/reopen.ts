import type { TunnelEndCode } from '@leafbot/client/tunnel';

/** How long a tunnel must have worked before its drop is taken as passing rather than as a fault. */
export const STEADY_MS = 5_000;

/** How long the panel waits before opening a dropped tunnel again. */
export const REOPEN_MS = 1_000;

/**
 * Whether a tunnel that ended is opened again by itself: only after it worked for a while and then
 * dropped (the server restarted, or the person got another role). A refusal, or a tunnel that keeps
 * dropping, waits for the person instead.
 */
export function reopens(code: TunnelEndCode, openFor: number): boolean {
  return (code === 'closed' || code === 'timeout') && openFor >= STEADY_MS;
}
