/**
 * The screen-only page: one bot's computer on a page of its own (`?screen=<botId>`), which the phone
 * app shows in a web view, since the desktop's live stream needs the web viewer.
 */

/** The bot whose computer this page shows, or null on any other page. */
export function screenBotOf(search = typeof location === 'undefined' ? '' : location.search): string | null {
  return new URLSearchParams(search).get('screen') || null;
}

/**
 * What the page tells the phone app once it is drawn. A server from before this page answers with
 * the whole app instead and never says it, so the phone keeps its own view there.
 */
export const SCREEN_READY = 'leafbot:screen-ready';
