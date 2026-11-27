/**
 * Links that open a chat in the desktop app from outside it: a bookmark, a dashboard, a script.
 *
 * - `leafbot://thread/<id>`: one conversation (a bot's or a room's)
 * - `leafbot://bot/<id>`: a bot's chat, as clicking it in the sidebar opens it
 * - `leafbot://room/<id>`: a room
 * - `leafbot://app/<id>`: a page saved as an app, in a window of its own (its launchers open this)
 *
 * Opening one only shows that chat or page: it never sends anything or starts a conversation.
 */
export const LINK_SCHEME = 'leafbot';
/** Links made before the app was renamed (bookmarks, dashboards) keep opening it. */
export const LINK_SCHEMES = [LINK_SCHEME, 'yumakbot'];

export interface AppLink {
  kind: 'thread' | 'bot' | 'room' | 'app';
  id: string;
}

const KINDS = new Set<AppLink['kind']>(['thread', 'bot', 'room', 'app']);

/** The chat a link names, or null for anything else. */
export function parseLink(raw: string): AppLink | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (!LINK_SCHEMES.some((scheme) => url.protocol === `${scheme}:`)) return null;
  // `leafbot://thread/x` reads as host "thread" and path "/x"; `leafbot:thread/x` as a path alone.
  const parts = [url.host, ...url.pathname.split('/')].filter(Boolean).map((p) => decodeURIComponent(p));
  const [kind, id, ...rest] = parts;
  if (!kind || !id || rest.length || !KINDS.has(kind as AppLink['kind'])) return null;
  if (!/^[\w-]{1,64}$/.test(id)) return null;
  return { kind: kind as AppLink['kind'], id };
}

/** The link among a started app's arguments (Windows and Linux pass it there), if any. */
export function linkInArgs(argv: readonly string[]): AppLink | null {
  for (const a of argv) {
    if (LINK_SCHEMES.some((scheme) => a.startsWith(`${scheme}:`))) {
      const link = parseLink(a);
      if (link) return link;
    }
  }
  return null;
}
