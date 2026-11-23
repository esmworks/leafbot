import type { BotSummary } from '@leafbot/shared';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

/** Per bot, the time of the latest reply the person has seen on this phone ('' for none). */
export type Seen = Readonly<Record<string, string>>;

type Summary = Pick<BotSummary, 'botId' | 'repliedAt'>;

/**
 * Whether the bot wrote after the person last looked. A phone that never kept marks (`seen` null)
 * shows nothing as unread; a bot it has no mark for counts every reply.
 */
export function isUnread(summary: Summary, seen: Seen | null | undefined): boolean {
  if (!seen || !summary.repliedAt) return false;
  return summary.repliedAt > (seen[summary.botId] ?? '');
}

/**
 * The marks after a summary update: the first list on a phone is taken as read, so the dots start
 * from what arrives next rather than from the whole history; bots no longer listed are dropped.
 */
export function nextSeen(seen: Seen | null, summaries: readonly Summary[]): Seen {
  if (!seen) return Object.fromEntries(summaries.map((s) => [s.botId, s.repliedAt ?? '']));
  const listed = new Set(summaries.map((s) => s.botId));
  const kept = Object.entries(seen).filter(([id]) => listed.has(id));
  // The same object when no bot left, so a listener does not see a change that is not there.
  return kept.length === Object.keys(seen).length ? seen : Object.fromEntries(kept);
}

/** The marks with this bot read up to `at`; the same object when nothing changes. */
export function markRead(seen: Seen, botId: string, at: string): Seen {
  return (seen[botId] ?? '') >= at ? seen : { ...seen, [botId]: at };
}

// Marks are kept per server: two servers share no bot ids.
const loaded = new Map<string, Seen | null>();
const listeners = new Set<() => void>();
const keyOf = (origin: string) => `leafbot.seen:${origin}`;

function set(origin: string, seen: Seen) {
  if (loaded.get(origin) === seen) return;
  loaded.set(origin, seen);
  for (const fn of listeners) fn();
  // Not kept only means the dots start over next launch.
  AsyncStorage.setItem(keyOf(origin), JSON.stringify(seen)).catch(() => undefined);
}

function load(origin: string) {
  if (loaded.has(origin)) return;
  AsyncStorage.getItem(keyOf(origin))
    .then((raw) => (raw ? (JSON.parse(raw) as Seen) : null))
    .catch(() => null)
    .then((seen) => {
      if (loaded.has(origin)) return;
      loaded.set(origin, seen);
      for (const fn of listeners) fn();
    });
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/** The marks for a server: undefined while they are read, null when this phone never kept any. */
export function useSeen(origin: string): Seen | null | undefined {
  useEffect(() => load(origin), [origin]);
  return useSyncExternalStore(subscribe, () => loaded.get(origin));
}

/** Brings the marks up to date with a new bot list once they have been read. */
export function syncSeen(origin: string, summaries: readonly Summary[]) {
  if (!loaded.has(origin)) return;
  set(origin, nextSeen(loaded.get(origin) ?? null, summaries));
}

export function markSeen(origin: string, botId: string, at: string) {
  const seen = loaded.get(origin);
  if (!seen) return;
  set(origin, markRead(seen, botId, at));
}

/** The bots with replies not yet read, which the number on the app's icon counts. */
export function unreadBots(summaries: readonly Summary[], seen: Seen | null | undefined): string[] {
  return summaries.filter((s) => isUnread(s, seen)).map((s) => s.botId);
}

// The unread bots of the server the bot list last showed, for the icon's number and the server's
// copy of it. Unknown until the list and the marks have both been read, so a launch does not set
// the number to nothing before it knows.
let unread: { origin: string; key: string; ids: readonly string[] } | null = null;

/** Notes the bot list's unread bots; the same list again changes nothing. */
export function setUnread(origin: string, ids: readonly string[]) {
  const key = ids.join(',');
  if (unread?.origin === origin && unread.key === key) return;
  unread = { origin, key, ids };
  for (const fn of listeners) fn();
}

/** The unread bots on `origin` once known. */
export function useUnread(origin: string | null): readonly string[] | undefined {
  const now = useSyncExternalStore(subscribe, () => unread);
  return origin && now?.origin === origin ? now.ids : undefined;
}
