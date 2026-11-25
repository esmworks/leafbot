import { router } from 'expo-router';

/**
 * Where each screen lives. Screens open one another only through these, so a route can move
 * without a search through every screen.
 */
export const nav = {
  list: () => (router.canDismiss() ? router.dismissTo('/bots') : router.replace('/bots')),
  /** A bot's conversation: its main one, or `threadId`; `focus` scrolls to a message and marks it. */
  chat: (botId: string, opts: { threadId?: string; focus?: string; find?: string } = {}) =>
    router.push({ pathname: '/chat/[botId]', params: { botId, ...clean(opts) } }),
  /** The same, replacing the screen on top, for moving between conversations of one bot. */
  replaceChat: (botId: string, opts: { threadId?: string; focus?: string; find?: string } = {}) =>
    router.replace({ pathname: '/chat/[botId]', params: { botId, ...clean(opts) } }),
  room: (roomId: string) => router.push({ pathname: '/room/[roomId]', params: { roomId } }),
  /** Create a room, or edit one. */
  roomEdit: (roomId?: string) => router.push({ pathname: '/room-edit', params: clean({ roomId }) }),
  /** The bot's side panel: routines, apps, skills, facts and files. */
  panel: (botId: string) => router.push({ pathname: '/panel/[botId]', params: { botId } }),
  /** Create a bot, or edit one. */
  botEdit: (botId?: string) => router.push({ pathname: '/bot-edit', params: clean({ botId }) }),
  /**
   * Create a routine for a bot, or edit one; `showRuns` opens it at its latest runs, for a routine
   * opened to see why a run failed.
   */
  routine: (opts: { botId?: string; routineId?: string; showRuns?: '1' }) =>
    router.push({ pathname: '/routine', params: clean(opts) }),
  /** A file of a bot's folders; `paths` are the files to step through, as JSON. */
  file: (botId: string, path: string, paths?: string[]) =>
    router.push({
      pathname: '/file',
      params: clean({ botId, path, paths: paths && paths.length > 1 ? JSON.stringify(paths) : undefined }),
    }),
  today: () => router.push('/today'),
  search: (q?: string) => router.push({ pathname: '/search', params: clean({ q }) }),
  /** The list of settings sections, or one of them. */
  settings: (section?: string) =>
    section
      ? router.push({ pathname: '/settings/[section]', params: { section } })
      : router.push('/settings'),
  /** Apps (connections): the catalog, a bot's access, or one connection or catalog entry. */
  apps: (opts: { botId?: string; connectionId?: string; catalogId?: string } = {}) =>
    router.push({ pathname: '/apps', params: clean(opts) }),
  /** A bot's switches for every app connection. */
  botApps: (botId: string) => router.push({ pathname: '/bot-apps/[botId]', params: { botId } }),
  /** One of a bot's tables, its rows to read and search. */
  table: (botId: string, tableId: string) =>
    router.push({ pathname: '/table/[tableId]', params: { tableId, botId } }),
  /** The change a bot's instructions document waits with, to accept or turn down. */
  instructions: (botId: string) => router.push({ pathname: '/instructions/[botId]', params: { botId } }),
  /** What each turn of a conversation changed, with taking a turn back. */
  actionLog: (threadId: string) => router.push({ pathname: '/action-log/[threadId]', params: { threadId } }),
  /** The bot's browser or computer screen. */
  computer: (botId: string) => router.push({ pathname: '/computer/[botId]', params: { botId } }),
};

function clean<T extends Record<string, string | undefined>>(o: T): Record<string, string> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Record<
    string,
    string
  >;
}
