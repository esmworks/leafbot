import {
  ChromeAsk,
  CHROME_MAX_TABS,
  CHROME_MAX_TEXT,
  type ChromeAnswer,
  type ChromeTab,
} from '@leafbot/shared';

/** A tab as this code needs it; Chrome's own carries more. */
export interface OpenTab {
  id?: number;
  url?: string;
  title?: string;
}

/** What answering a bot needs from Chrome and from the person; the panel gives Chrome's own. */
export interface Browser {
  /** Every open tab, in every window. */
  tabs(): Promise<OpenTab[]>;
  /** The tab in front in the window the person last used. */
  front(): Promise<OpenTab | null>;
  tab(id: number): Promise<OpenTab | null>;
  /** Whether the extension may read pages of this origin already. */
  mayRead(origin: string): Promise<boolean>;
  /** Asks the person on the panel, and Chrome on their click; whether they allowed it. */
  askToRead(origin: string, bot: string | null): Promise<boolean>;
  /** The visible text of the page in this tab. */
  text(tabId: number): Promise<string>;
}

/** Only web pages are shared: never Chrome's own pages, an extension's, or a file. */
export const isWeb = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

export function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.origin : null;
  } catch {
    return null;
  }
}

/** The host-permission pattern Chrome grants for one origin. */
export const sitePattern = (origin: string) => `${origin}/*`;

const shown = (tab: OpenTab, front: number | undefined): ChromeTab => ({
  id: tab.id!,
  url: (tab.url ?? '').slice(0, 8_192),
  title: (tab.title ?? '').slice(0, 500),
  active: tab.id === front,
});

/**
 * Chrome's answer to one question from the server at `server`. Nothing is read while sharing is off;
 * a page is read only on a site the person allowed, now or before. The server's own pages are asked
 * for each time: the extension may reach them to talk to the server, which is no yes to reading them.
 */
export async function answerAsk(
  raw: unknown,
  sharing: boolean,
  browser: Browser,
  server: string,
): Promise<ChromeAnswer> {
  if (!sharing) return { ok: false, reason: 'off' };
  const parsed = ChromeAsk.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'failed' };
  const ask = parsed.data;
  try {
    if (ask.kind === 'tabs') {
      const [all, front] = await Promise.all([browser.tabs(), browser.front()]);
      const web = all.filter((x) => x.id !== undefined && isWeb(x.url));
      // The tab in front first, so a bot that wants "this page" finds it at once.
      web.sort((a, b) => Number(b.id === front?.id) - Number(a.id === front?.id));
      return { ok: true, kind: 'tabs', tabs: web.slice(0, CHROME_MAX_TABS).map((x) => shown(x, front?.id)) };
    }
    const front = await browser.front();
    const tab = ask.tabId === undefined ? front : await browser.tab(ask.tabId);
    if (!tab || tab.id === undefined) return { ok: false, reason: 'notFound' };
    const origin = isWeb(tab.url) ? originOf(tab.url) : null;
    if (!origin) return { ok: false, reason: 'notWeb' };
    const allowed =
      (origin !== server && (await browser.mayRead(origin))) ||
      (await browser.askToRead(origin, ask.bot ?? null));
    if (!allowed) return { ok: false, reason: 'denied' };
    const text = (await browser.text(tab.id)).trim();
    return {
      ok: true,
      kind: 'read',
      tab: shown(tab, front?.id),
      text: text.slice(0, CHROME_MAX_TEXT),
      cut: text.length > CHROME_MAX_TEXT,
    };
  } catch {
    // A tab that closed while it was read, a page Chrome does not let extensions into.
    return { ok: false, reason: 'failed' };
  }
}

/** Chrome's own tabs and pages, for `answerAsk`. `askToRead` is the panel's. */
export function chromeBrowser(askToRead: Browser['askToRead']): Browser {
  return {
    tabs: () => chrome.tabs.query({}),
    front: async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0] ?? null,
    tab: async (id) => {
      try {
        return await chrome.tabs.get(id);
      } catch {
        return null;
      }
    },
    mayRead: (origin) => chrome.permissions.contains({ origins: [sitePattern(origin)] }),
    askToRead,
    text: async (tabId) => {
      // Runs apart from the page's own scripts, which cannot see or change what it reads.
      const [first] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => document.body?.innerText ?? '',
      });
      return typeof first?.result === 'string' ? first.result : '';
    },
  };
}
