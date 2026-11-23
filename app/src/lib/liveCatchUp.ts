import { useEffect } from 'react';
import { api } from './api';
import { useUi } from './store';

/** Fetches in a row for one conversation while words keep going missing; then the next piece tries again. */
const MAX_ROUNDS = 5;

/** The conversations on screen, counted by how many views show each. */
const watched = new Map<string, number>();
const fetching = new Set<string>();

/**
 * Brings in what the bot has written so far of the reply it is writing, when this page missed
 * some of it: the socket was down for a while, or the page opened mid-reply. Pieces that came
 * meanwhile follow it; a turn that ended in the meantime leaves the stream as it is.
 */
export function catchUp(threadId: string, round = 1): void {
  if (fetching.has(threadId)) return;
  fetching.add(threadId);
  let again = false;
  void api
    .live(threadId)
    .then(({ live }) => {
      if (live) again = useUi.getState().seedStream(threadId, live);
    })
    .catch(() => undefined)
    .finally(() => {
      fetching.delete(threadId);
      if (again && round < MAX_ROUNDS) catchUp(threadId, round + 1);
    });
}

/** Catches up every conversation on screen; after a reconnect nothing live is trusted. */
export function catchUpWatched(): void {
  for (const id of watched.keys()) catchUp(id);
}

/** Keeps a conversation's live reply whole while it is on screen (see `catchUp`). */
export function useLiveCatchUp(threadId: string | null | undefined): void {
  useEffect(() => {
    if (!threadId) return;
    watched.set(threadId, (watched.get(threadId) ?? 0) + 1);
    catchUp(threadId);
    return () => {
      const n = (watched.get(threadId) ?? 1) - 1;
      if (n > 0) watched.set(threadId, n);
      else watched.delete(threadId);
    };
  }, [threadId]);
}
