import { dehydrate, hydrate, type DehydratedState, type QueryClient } from '@tanstack/react-query';

/**
 * What the screens showed last, kept on the phone so the next launch draws them at once instead of
 * waiting for the tunnel (which takes seconds to open on a phone network); they are read again as
 * soon as it is open. Only the lists the first screens show are kept: AsyncStorage is not the
 * keychain, so secrets, connections, people and memory never go there. It is kept for one person on
 * one server and forgotten on signing out.
 */
export const KEPT_KEY = 'leafbot.kept';
/** Raised when what is kept changes shape, so an older copy is not read as the new one. */
const FORMAT = 1;

/** The first part of each query key that is kept. */
const KEPT = new Set([
  'session',
  'settings',
  'bots',
  'summaries',
  'groups',
  'rooms',
  'info',
  'today',
  'threads',
  'main-thread',
  'thread',
  'messages',
]);
/** Conversations whose latest words are kept, most recently read first. */
export const KEPT_THREADS = 6;
/** Messages kept of each: the screen opens at the end, and the rest is read once online. */
export const KEPT_MESSAGES = 40;
/** Well under the size an Android AsyncStorage row can be read back at. */
export const KEPT_MAX_CHARS = 1_500_000;

export interface Kept {
  format: number;
  version: string;
  user: string;
  origin: string;
  state: DehydratedState;
}

export interface KeptStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface Who {
  user: string;
  origin: string;
  /** The app's version: a copy from another one is not read. */
  version: string;
}

/**
 * The part of the cache worth keeping for `origin`: loaded lists only, the latest messages of the
 * conversations read last, and less of them when it would not fit.
 */
export function pickKept(qc: QueryClient, origin: string): DehydratedState {
  const state = dehydrate(qc, {
    shouldDehydrateQuery: (q) =>
      q.state.status === 'success' &&
      q.state.data !== undefined &&
      q.queryKey[1] === origin &&
      KEPT.has(String(q.queryKey[0])),
  });
  const messages = state.queries
    .filter((q) => q.queryKey[0] === 'messages' && Array.isArray(q.state.data))
    .sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
  const keptThreads = new Set(messages.slice(0, KEPT_THREADS).map((q) => q.queryHash));
  const queries = state.queries
    .filter((q) => q.queryKey[0] !== 'messages' || keptThreads.has(q.queryHash))
    .map((q) =>
      q.queryKey[0] === 'messages' && Array.isArray(q.state.data)
        ? { ...q, state: { ...q.state, data: (q.state.data as unknown[]).slice(-KEPT_MESSAGES) } }
        : q,
    );
  return { mutations: [], queries };
}

function fits(kept: Kept): string | null {
  const raw = JSON.stringify(kept);
  return raw.length <= KEPT_MAX_CHARS ? raw : null;
}

/** The kept copy as it goes to storage; without the messages when it would be too large. */
export function serializeKept(state: DehydratedState, who: Who): string | null {
  const kept: Kept = { format: FORMAT, version: who.version, user: who.user, origin: who.origin, state };
  return (
    fits(kept) ??
    fits({ ...kept, state: { ...state, queries: state.queries.filter((q) => q.queryKey[0] !== 'messages') } })
  );
}

/** The kept copy, when it is this format and was kept for this person on this server by this version. */
export function readKept(raw: string | null, who: Who): DehydratedState | null {
  if (!raw) return null;
  try {
    const kept = JSON.parse(raw) as Partial<Kept>;
    if (
      kept.format !== FORMAT ||
      kept.version !== who.version ||
      kept.user !== who.user ||
      kept.origin !== who.origin ||
      !Array.isArray(kept.state?.queries)
    )
      return null;
    return kept.state;
  } catch {
    return null;
  }
}

/** Puts what was kept for `who` into the cache, before the first screen asks for it. */
export async function restoreKept(qc: QueryClient, storage: KeptStorage, who: Who): Promise<boolean> {
  const state = readKept(await storage.getItem(KEPT_KEY).catch(() => null), who);
  if (!state) return false;
  // The entries keep the time they were read, so they count as stale and are read again on use.
  hydrate(qc, state);
  return true;
}

/**
 * Keeps the cache for `who` from now on: a while after each answer that came in, so a burst of
 * answers is written once. Returns the stop, which drops a write still waiting.
 */
export function keepQueries(qc: QueryClient, storage: KeptStorage, who: Who, delayMs = 2_000): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = () => {
    timer = null;
    const state = pickKept(qc, who.origin);
    if (!state.queries.length) return;
    const raw = serializeKept(state, who);
    // Not kept only means the next launch waits for the tunnel, as it did before.
    if (raw) storage.setItem(KEPT_KEY, raw).catch(() => undefined);
  };
  const off = qc.getQueryCache().subscribe((e) => {
    if (e.type !== 'updated' || e.action.type !== 'success' || timer) return;
    if (e.query.queryKey[1] !== who.origin || !KEPT.has(String(e.query.queryKey[0]))) return;
    timer = setTimeout(write, delayMs);
  });
  return () => {
    off();
    if (timer) clearTimeout(timer);
    timer = null;
  };
}
