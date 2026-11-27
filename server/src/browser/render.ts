import { PAGE_LIBRARIES } from '@leafbot/shared';

/** The largest side of a picture, before the scale; a poster or a banner fits well inside it. */
export const MAX_RENDER_SIDE = 4096;
/** A page that has not settled by then is taken as it is, or fails if it never loaded. */
const LOAD_MS = 20_000;
/** Late requests (a font, a chart's data) get this long once the page has loaded. */
const SETTLE_MS = 5_000;

export interface RenderOptions {
  /** The browser program to start; the bots' own browsers are never used for this. */
  executable: string;
  sandbox: boolean;
  /** A page made whole by `bundlePage`: nothing in it is read from this server. */
  html: string;
  width: number;
  /** Omitted: as tall as the page, up to the largest side. */
  height?: number;
  /** 2 gives a sharper picture at twice the pixels. */
  scale?: number;
  /** Whether the page may load its libraries and fonts from the usual public CDNs. */
  libraries: boolean;
  signal?: AbortSignal;
}

/** One at a time: each picture starts a browser, and several at once would load the computer. */
let queue: Promise<unknown> = Promise.resolve();

/**
 * Takes a picture of a bot's page in a browser of its own: no profile, no cookies, and no way out
 * but the libraries a page shown in the chat may load too. Everything else it asks for, this
 * server and the local network included, is refused.
 */
export function renderPage(o: RenderOptions): Promise<Buffer> {
  const run = () => render(o);
  const result = queue.then(run, run);
  queue = result.catch(() => {});
  return result;
}

async function render(o: RenderOptions): Promise<Buffer> {
  o.signal?.throwIfAborted();
  // Loaded here rather than at start: most starts render no page.
  const { chromium } = await import('playwright-core');
  const browser = await chromium.launch({
    executablePath: o.executable,
    headless: true,
    chromiumSandbox: o.sandbox,
    args: ['--disable-dev-shm-usage', '--mute-audio'],
    timeout: 30_000,
  });
  const stop = () => void browser.close().catch(() => {});
  o.signal?.addEventListener('abort', stop, { once: true });
  try {
    const context = await browser.newContext({
      viewport: { width: o.width, height: o.height ?? 800 },
      deviceScaleFactor: o.scale ?? 1,
      acceptDownloads: false,
      serviceWorkers: 'block',
    });
    await context.route('**/*', (route) => {
      let origin = '';
      try {
        origin = new URL(route.request().url()).origin;
      } catch {
        // Not a web address: refused below.
      }
      return o.libraries && PAGE_LIBRARIES.includes(origin)
        ? route.continue()
        : route.abort('blockedbyclient');
    });
    // A WebSocket passes the request filter above: it is closed before it connects.
    await context.routeWebSocket(/.*/, (ws) => ws.close());
    const page = await context.newPage();
    await page.setContent(o.html, { waitUntil: 'load', timeout: LOAD_MS });
    await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
    // Written as text: the server is compiled without the page's types.
    await page.evaluate('document.fonts.ready.then(() => 0)').catch(() => {});
    let height = o.height;
    if (!height) {
      // The page's own height: measured in a window shorter than it, which it would otherwise fill.
      await page.setViewportSize({ width: o.width, height: 1 });
      const measured = Number(await page.evaluate('document.documentElement.scrollHeight')) || 1;
      height = Math.min(MAX_RENDER_SIDE, Math.max(1, measured));
      await page.setViewportSize({ width: o.width, height });
    }
    return await page.screenshot({
      type: 'png',
      animations: 'disabled',
      clip: { x: 0, y: 0, width: o.width, height },
      timeout: LOAD_MS,
    });
  } finally {
    o.signal?.removeEventListener('abort', stop);
    await browser.close().catch(() => {});
  }
}
