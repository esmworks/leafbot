/** How long after a bot last touched the person's Mac the screen is still kept on. */
export const DISPLAY_QUIET_MS = 2 * 60_000;

/** How often the server is asked while a bot works. */
export const DISPLAY_POLL_MS = 10_000;

/**
 * Whether the screen must stay on: a bot is using the person's Mac, or did moments ago. A screenshot
 * of a sleeping display comes back black, and a bot pauses between steps while it thinks, so the
 * quiet period outlasts those pauses. `idleMs` is null when no bot has used the Mac.
 */
export function keepDisplayOn(idleMs: unknown, quietMs = DISPLAY_QUIET_MS): boolean {
  return typeof idleMs === 'number' && Number.isFinite(idleMs) && idleMs < quietMs;
}
