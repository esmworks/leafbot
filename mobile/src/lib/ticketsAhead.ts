/** A ticket asked for ahead is used only while well inside its minute. */
const AHEAD_FRESH_MS = 30_000;

/**
 * Tickets for one opening: the relay takes one at the start and the proof another once WebRTC is
 * set up. Both are asked for at once, so the proof does not wait a round trip to the account service
 * after the slow part; each is still used once. Later proofs, and one asked for ahead that failed or
 * grew old, get a fresh ticket.
 */
export function ticketsAhead(fetch: () => Promise<string>, now = Date.now): () => Promise<string> {
  const askedAt = now();
  const first = fetch();
  const second = fetch();
  // Not used, or used later: a failure is seen by whoever takes it.
  first.catch(() => undefined);
  second.catch(() => undefined);
  const ahead = [first, second];
  return async () => {
    const next = ahead.shift();
    if (!next) return fetch();
    if (next === second) {
      const t = await next.catch(() => null);
      return t !== null && now() - askedAt < AHEAD_FRESH_MS ? t : fetch();
    }
    return next;
  };
}
