import type { QueryClient } from '@tanstack/react-query';

/**
 * Reads everything again after the live channel was away (a new connection may have missed what
 * changed meanwhile), without throwing away a read already on its way. Over the tunnel the screens
 * often have such a read out when the channel says hello, for what was kept from the last launch or
 * shown before a drop; cancelling it would make them wait a round trip more for the same answer.
 * Instead its answer is shown when it comes, and the entry is read once more after it, since it may
 * have been answered before the channel could hear of a change. A first read still on its way is
 * left as it is, as before.
 */
export function refreshAll(qc: QueryClient): Promise<void> {
  const cache = qc.getQueryCache();
  const afterwards: Promise<unknown>[] = [];
  for (const q of cache.getAll()) {
    if (q.state.fetchStatus !== 'fetching' || q.state.data === undefined) continue;
    const filter = { queryKey: q.queryKey, exact: true } as const;
    afterwards.push(
      // With `cancelRefetch: false` this is the read already out; the second goes after it.
      qc.refetchQueries(filter, { cancelRefetch: false }).then(() => qc.invalidateQueries(filter)),
    );
  }
  return Promise.all([qc.invalidateQueries(undefined, { cancelRefetch: false }), ...afterwards]).then(
    () => undefined,
  );
}
