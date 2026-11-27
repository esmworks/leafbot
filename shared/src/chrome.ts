import { z } from 'zod';

/**
 * The person's own Chrome, through the Leaf Bot extension's side panel while it is open and
 * connected. A bot may list the open tabs and read the text of one, only in work the person's own
 * message from that panel started; nothing in a tab is changed.
 */

/**
 * The extension's id, fixed by the public key in its manifest, so the server can let exactly its
 * pages in (see `checkHostOrigin`). Any other extension id is refused like any other origin.
 */
export const CHROME_EXTENSION_ID = 'jiookhggigofoigogpclmhamkbaapkei';
export const CHROME_EXTENSION_ORIGIN = `chrome-extension://${CHROME_EXTENSION_ID}`;

/** At most this many tabs are listed. */
export const CHROME_MAX_TABS = 50;
/** At most this much of a page's text comes back. */
export const CHROME_MAX_TEXT = 40_000;
/**
 * How long a bot waits for Chrome. A page on a site the extension may not read yet waits for the
 * person to allow that site in the panel, which Chrome lets happen only on their click.
 */
export const CHROME_ANSWER_MS = 90_000;

export const ChromeTab = z.object({
  /** Chrome's own tab id. */
  id: z.number().int().nonnegative(),
  url: z.string().max(8_192),
  title: z.string().max(500),
  /** The tab in front in the window the person last used. */
  active: z.boolean(),
});
export type ChromeTab = z.infer<typeof ChromeTab>;

export const ChromeAsk = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('tabs') }),
  /** Without `tabId`, the tab in front. `bot` names who asks, on the panel's card for a new site. */
  z.object({
    kind: z.literal('read'),
    tabId: z.number().int().nonnegative().optional(),
    bot: z.string().max(200).optional(),
  }),
]);
export type ChromeAsk = z.infer<typeof ChromeAsk>;

/**
 * Chrome's answer. `off`: the person stopped sharing in the panel; `denied`: they did not allow the
 * extension to read that site; `notFound`: no such tab is open; `notWeb`: the tab holds no web page
 * (a settings page, a new tab, a file).
 */
export const ChromeAnswer = z.union([
  z.object({ ok: z.literal(true), kind: z.literal('tabs'), tabs: z.array(ChromeTab).max(CHROME_MAX_TABS) }),
  z.object({
    ok: z.literal(true),
    kind: z.literal('read'),
    tab: ChromeTab,
    text: z.string().max(CHROME_MAX_TEXT),
    /** The page had more text than came back. */
    cut: z.boolean(),
  }),
  z.object({ ok: z.literal(false), reason: z.enum(['off', 'denied', 'notFound', 'notWeb', 'failed']) }),
]);
export type ChromeAnswer = z.infer<typeof ChromeAnswer>;
