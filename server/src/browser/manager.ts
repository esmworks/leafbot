import { CALL_BINDING, CALL_CAPTURE_SCRIPT, type CaptureState } from './call-capture';
import { browserLocale } from './locale';
import { watchPage, type PageLog } from './logs';
import { addTyping, DESCRIBE, MAX_STEPS, type Target, type TeachStep } from './teach';
import { spawn, type ChildProcess } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { isIP } from 'node:net';
import { basename, extname, join } from 'node:path';
import type { BrowserInput, BrowserState } from '@leafbot/shared';
import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Download,
  type Page,
} from 'playwright-core';
// The same Playwright version with patches for a browser sites see as a person's: it never enables
// the DevTools Runtime domain on a page, and the server's scripts (page.evaluate and the like) run in
// an isolated world the page cannot see. Pages can tell when that domain is on, and bot guards such
// as Cloudflare's check refuse a browser while it is: on a bot's desktop the person passed the check
// by hand in a browser the bot was not connected to, and failed it in the same browser while it was.
// A script in the page's own world can be watched by the page, which then sees the server look for
// its challenge. Used only for the desktop's browser; the server's own headless browser keeps the
// original.
import { chromium as desktopChromium } from 'patchright-core';
import { privateAddress } from '../services/skill-link';

/** The size of every bot's browser window, in CSS pixels. */
export const VIEWPORT = { width: 1280, height: 800 };
/**
 * The screen the page is told it is on: a common one for the computer the server runs on, larger
 * than the window as a real screen is. A headless browser otherwise reports a screen exactly the
 * size of its page, with one pixel per point even on a Mac, which sites read as a robot.
 */
export const SCREEN =
  process.platform === 'darwin'
    ? { width: 1512, height: 982, scale: 2 }
    : { width: 1920, height: 1080, scale: 1 };

const SHORTCUT_MODIFIERS = new Set(['Control', 'Meta', 'Alt']);

export type BrowserErrorCode =
  | 'unavailable'
  | 'userControl'
  | 'full'
  | 'launch'
  | 'badUrl'
  | 'busy'
  | 'hung'
  | 'staleRef'
  | 'covered'
  | 'tabs';

/**
 * Most tabs a bot's browser keeps open. A site that opens more (pop-up after pop-up) has them
 * closed; a sign-in pop-up or two fit well within.
 */
export const MAX_TABS = 10;
/** Largest file a download keeps; a larger one is deleted once it is in. */
export const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;
/** Downloads running at once in one bot's browser; one more is cancelled. */
const MAX_DOWNLOADS = 4;
/** A download still running after this long is cancelled: an endless stream, a stalled server. */
const DOWNLOAD_MS = 10 * 60_000;

/** A file a page downloaded, kept for the bot to move into its folder, or why it was not kept. */
export interface PageDownload {
  name: string;
  /** Where the file waits, until the bot's next step moves it. */
  path?: string;
  size?: number;
  error?: 'tooBig' | 'failed' | 'tooMany' | 'slow';
}

/**
 * A file name a site suggested, made safe to keep: no folders, no characters file systems refuse,
 * no leading dot that would hide it, not too long.
 */
export function safeFileName(suggested: string): string {
  const base = [...basename(suggested.replace(/\\/g, '/'))]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 || '<>:"|?*'.includes(c) ? '_' : c))
    .join('')
    .replace(/^[.\s]+/, '')
    .trim();
  if (!base) return 'download';
  // The conversation folder is where the bot works: a site must not drop in a file an agent reads
  // as its own instructions.
  const named = INSTRUCTION_FILES.test(base) ? `download-${base}` : base;
  if (named.length <= 120) return named;
  const ext = extname(named).slice(0, 16);
  return named.slice(0, 120 - ext.length) + ext;
}

/** Names coding agents read from their working folder as instructions. */
const INSTRUCTION_FILES = /^(claude|claude\.local|agents|gemini)\.md$/i;

export class BrowserError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    detail = '',
  ) {
    super(detail || code);
  }
}

/**
 * A headless Chrome names itself "HeadlessChrome" in every request, which sign-in pages read as a
 * robot; the same browser with a window says "Chrome". Null when there is nothing to change.
 */
export function windowedUserAgent(userAgent: string): string | null {
  return userAgent.includes('HeadlessChrome/') ? userAgent.replaceAll('HeadlessChrome/', 'Chrome/') : null;
}

/** A secure address no network answers, for the page that learns the browser's identity. */
const PROBE_URL = 'https://identity.invalid/';

/** What a page reads of the browser's client hints, from `navigator.userAgentData`. */
export interface SeenHints {
  brands: { brand: string; version: string }[];
  fullVersionList?: { brand: string; version: string }[];
  mobile: boolean;
  platform: string;
  platformVersion?: string;
  architecture?: string;
  model?: string;
  bitness?: string;
}

/**
 * The client hints of the same browser with a window. A headless shell also names itself
 * "HeadlessChrome" among its brands, in the `sec-ch-ua` header and on the page, which the user agent
 * alone does not change. Null when there is nothing to change.
 */
export function windowedHints(seen: SeenHints) {
  const plain = (list: { brand: string; version: string }[]) =>
    list.filter((b) => b.brand !== 'HeadlessChrome');
  if (plain(seen.brands).length === seen.brands.length) return null;
  return {
    brands: plain(seen.brands),
    fullVersionList: plain(seen.fullVersionList ?? []),
    mobile: seen.mobile,
    platform: seen.platform,
    platformVersion: seen.platformVersion ?? '',
    architecture: seen.architecture ?? '',
    model: seen.model ?? '',
    bitness: seen.bitness ?? '',
  };
}

/** Only web addresses: no file://, chrome:// or javascript: (the browser runs next to the server's data). */
export function webUrl(raw: string): URL {
  const text = raw.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`);
  } catch {
    throw new BrowserError('badUrl', text);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BrowserError('badUrl', text);
  return url;
}

export interface Frame {
  data: Buffer;
  width: number;
  height: number;
}

/** How much slower the tabs the bot is not on run. */
const BACKGROUND_CPU_RATE = 4;
/** How long the page takes to hand over its last recording after listening stops. */
const LAST_RECORDING_MS = 1500;

/** The function a page calls, through the wall below, to say it asked for a passkey. */
const PASSKEY_BINDING = '__leafbotPasskey';

/**
 * Run in every frame before the page's own scripts. The bot's browser holds no passkeys, and a
 * passkey request would otherwise wait on a browser window no one sees (a security key, a phone)
 * until the site gives up, which can take minutes. A request the page makes is refused at once, as
 * a person cancelling it would, and the bot hears of it. A quiet request the page leaves waiting
 * for the person to pick a passkey from the sign-in field (conditional mediation) waits as it
 * would in any browser with none saved, and is not reported: many sign-in pages make one on load.
 */
export const PASSKEY_WALL = `(() => {
  const c = typeof navigator !== 'undefined' ? navigator.credentials : undefined;
  if (!c) return;
  for (const kind of ['get', 'create']) {
    const own = c[kind];
    if (typeof own !== 'function') continue;
    const call = own.bind(c);
    Object.defineProperty(c, kind, {
      configurable: true,
      writable: true,
      value: function (options) {
        if (!options || !options.publicKey) return call(options);
        const signal = options.signal;
        if (options.mediation === 'conditional') {
          return new Promise((_, reject) => {
            if (!signal) return;
            const stop = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
            if (signal.aborted) stop();
            else signal.addEventListener('abort', stop, { once: true });
          });
        }
        try { window.${PASSKEY_BINDING}?.(kind); } catch {}
        return Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));
      },
    });
  }
})();`;

interface Live {
  botId: string;
  /** Set when connected to a browser that runs elsewhere (the bot's desktop); closing disconnects. */
  remote: Browser | null;
  /** Set when that browser leaves through the service's own SOCKS, which refuses private addresses
   * itself; the per-request guard would then only cost the browser its cache and its workers. */
  proxied: boolean;
  context: BrowserContext;
  page: Page;
  title: string | null;
  cast: CDPSession | null;
  lastFrame: Frame | null;
  /** Bot actions running now. */
  busy: number;
  /** A person took control; the bot's actions are refused until they hand it back. */
  userControl: boolean;
  /** Control, Meta and Alt keys the person is holding down. */
  modifiers: Set<string>;
  /** The person's input, applied one event at a time. */
  inputs: Promise<void>;
  /**
   * Passwords and codes typed into this browser from the vault, each with when it stops mattering;
   * hidden from everything the bot reads.
   */
  secrets: Map<string, number>;
  /**
   * Values too short to hide in free text (a card's security code) that the server filled into a
   * field: hidden where a page shows them as a field's value, until the browser closes.
   */
  fieldSecrets: Set<string>;
  lastUsed: number;
  /** Bot actions run one after another, even from two threads of the same bot. */
  queue: Promise<unknown>;
  /** The page's own questions (alert, confirm, prompt) since the bot last heard of them. */
  dialogs: PageDialog[];
  /** How to answer the page's next confirm or prompt, as the bot chose; once. */
  nextAnswer: { accept: boolean; text?: string } | null;
  /** Hosts on this computer or a private network the page tried to reach, since the bot last heard. */
  refused: Set<string>;
  /** Addresses of tabs the bot was on that the site closed itself, since the bot last heard. */
  closedBySite: string[];
  /** Sites that asked for a passkey, which was refused, since the bot last heard. */
  passkeys: string[];
  /** Tabs the site tried to open over the limit, which were closed, since the bot last heard. */
  refusedTabs: number;
  /** Downloads done or refused since the bot last heard. */
  downloads: PageDownload[];
  /** Downloads still coming in: name, and the number each was started as. */
  saving: Map<Promise<void>, { name: string; seq: number }>;
  /** Downloads started so far, refused ones too. */
  started: number;
  /** Tabs the bot or this server is closing, which the site did not close. */
  closing: WeakSet<Page>;
  /**
   * The session each tab's speed is set through. One per tab, kept open: its commands arrive in
   * the order sent, and the setting lasts as long as the session that made it.
   */
  speed: WeakMap<Page, Promise<CDPSession | null>>;
  /** What the person showed in teach mode, step by step; null when not teaching. */
  lesson: TeachStep[] | null;
  /** Each tab's requests and console messages since it opened (see `logs.ts`). */
  logs: WeakMap<Page, PageLog>;
  /** The call the bot listens to in one of its tabs (see `call-capture.ts`), and what takes its audio. */
  call: {
    page: Page;
    onAudio: (audio: Buffer) => void;
    /** Starts the page script again after the tab loads another page, as joining a call may. */
    rearm: () => void;
    release?: () => void;
  } | null;
  /** The page script and binding for listening are in this browser; added on the first call only. */
  callReady: boolean;
}

/** A question a page asked with alert, confirm or prompt, and how it was answered. */
export interface PageDialog {
  type: string;
  message: string;
  accepted: boolean;
}

export interface BrowserListener {
  state(s: BrowserState): void;
  frame(botId: string, f: Frame): void;
}

export interface BrowserManagerOptions {
  executable: string | null;
  /** The bot's own profile folder: its logins and cookies stay between runs. */
  profileDir(botId: string): string;
  sandbox: boolean;
  max: number;
  idleMs: number;
  /**
   * The longest one bot step may take. A page whose main thread hangs never answers, and every
   * later step of that bot would wait behind it; past this the browser starts afresh instead.
   */
  callMs?: number;
  /**
   * Hosts on this computer or a private network the bots' browsers may still reach (a router's
   * page, a service on the LAN). Every other private, loopback or link-local address is refused.
   */
  localHosts?: string[];
  headless?: boolean;
  /** The interface language, which the browser also reports to sites as its own. */
  language?: () => Promise<string>;
  /**
   * Use the Chromium on the bot's desktop instead of starting one here: its DevTools WebSocket
   * address and whether that browser leaves through the service's own SOCKS — that SOCKS refuses
   * private addresses itself — starting the desktop if needed.
   */
  connect?: (botId: string) => Promise<{ url: string; proxied: boolean }>;
  /** True while a person has control of the bot's desktop; the bot's browser steps then wait. */
  blocked?: (botId: string) => boolean;
  /** Keeps the bot's desktop awake during a browser step; returns the release. */
  hold?: (botId: string) => () => void;
  /**
   * The server runs on the person's own computer, so the bot's browser can also open there as an
   * ordinary window for them to sign in by hand.
   */
  windows?: boolean;
  /**
   * A SOCKS5 proxy (`socks5://host:port`) every browser this manager starts goes through: the way
   * out through the person's own computer when it is connected.
   */
  proxy?: string;
  /** Starts a program; tests pass a stand-in so no window opens. */
  spawn?: (command: string, args: string[]) => ChildProcess;
}

/** A window of the bot's browser that a person uses directly; the bot waits until it closes. */
interface Window {
  child: ChildProcess;
  exited: Promise<void>;
}

/**
 * One browser per bot, started on first use. The bot drives it with tools; people can watch its
 * screen live and take control (for a login or a captcha), during which the bot waits.
 */
export class BrowserManager {
  private live = new Map<string, Live>();
  private starting = new Map<string, Promise<Live>>();
  private watchers = new Map<string, Set<string>>();
  private hosts = new Map<string, { ok: boolean; at: number }>();
  private listeners = new Set<BrowserListener>();
  private sweep: NodeJS.Timeout | null = null;
  private closed = false;
  private userAgent: Promise<string | undefined> | null = null;
  /** Set on each page of a launched headless browser whose hints still say it is headless. */
  private hints: {
    userAgent: string;
    userAgentMetadata: NonNullable<ReturnType<typeof windowedHints>>;
  } | null = null;
  private windows = new Map<string, Window>();

  constructor(private opts: BrowserManagerOptions) {}

  get available() {
    return !!this.opts.executable || !!this.opts.connect;
  }

  get executable() {
    return this.opts.executable;
  }

  /** Whether a person can open the bot's browser as a window of its own on this computer. */
  get windowAvailable() {
    return !!this.opts.windows && !!this.opts.executable && !this.opts.connect;
  }

  on(l: BrowserListener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  state(botId: string): BrowserState {
    if (this.windows.has(botId)) return { botId, status: 'window', url: null, title: null, tabs: 0 };
    const l = this.live.get(botId);
    if (!l) return { botId, status: 'off', url: null, title: null, tabs: 0 };
    const url = l.page.url();
    return {
      botId,
      status: l.userControl ? 'user' : l.busy > 0 ? 'bot' : 'idle',
      url: url && url !== 'about:blank' ? url : null,
      title: l.title || null,
      tabs: l.context.pages().length,
    };
  }

  private get callMs() {
    return this.opts.callMs ?? 90_000;
  }

  /** Runs a bot action on its active page, starting the browser if needed. */
  async use<T>(botId: string, fn: (page: Page) => Promise<T>): Promise<T> {
    const live = await this.get(botId);
    const run = async () => {
      if (live.userControl || this.windows.has(botId) || this.opts.blocked?.(botId)) {
        throw new BrowserError('userControl');
      }
      live.busy++;
      this.emitState(live);
      const release = this.opts.hold?.(botId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const step = fn(live.page);
      try {
        return await Promise.race([
          step,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // Closing the browser also ends the call still waiting on it.
              step.catch(() => {});
              if (this.live.get(botId) === live) void this.close(botId);
              reject(new BrowserError('hung', String(Math.round(this.callMs / 1000))));
            }, this.callMs);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        release?.();
        live.busy--;
        live.lastUsed = Date.now();
        this.emitState(live);
      }
    };
    const result = live.queue.then(run, run);
    live.queue = result.catch(() => {});
    return result;
  }

  /**
   * Refuses every request of the browser to this computer or a private network: a page, a link it
   * follows, a redirect or a script on it could otherwise reach the server's own API, other local
   * services, the LAN or a cloud's metadata address with the server's network position.
   */
  private async guardNetwork(live: Live, context: BrowserContext) {
    await context.route('**/*', async (route) => {
      let host = '';
      try {
        host = new URL(route.request().url()).hostname;
      } catch {
        return route.continue();
      }
      if (await this.reachable(host)) return route.continue();
      live.refused.add(host.replace(/^\[|\]$/g, ''));
      return route.abort('blockedbyclient');
    });
  }

  /** Whether a host is public (or allowed); answers are kept a minute. */
  private async reachable(raw: string): Promise<boolean> {
    const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || this.opts.localHosts?.includes(host)) return true;
    const known = this.hosts.get(host);
    if (known && Date.now() - known.at < 60_000) return known.ok;
    let ok: boolean;
    if (isIP(host)) ok = !privateAddress(host);
    else if (host === 'localhost' || host.endsWith('.localhost')) ok = false;
    else {
      // A name that does not resolve fails in the browser anyway.
      const addresses = await lookup(host, { all: true }).catch(() => []);
      ok = !addresses.some((a) => privateAddress(a.address));
    }
    this.hosts.set(host, { ok, at: Date.now() });
    return ok;
  }

  /** The private hosts the page tried to reach since the bot last heard of them; heard once. */
  takeRefused(botId: string): string[] {
    const l = this.live.get(botId);
    if (!l) return [];
    const out = [...l.refused];
    l.refused.clear();
    return out;
  }

  /** The page's questions since the bot last heard of them; heard once. */
  takeDialogs(botId: string): PageDialog[] {
    const l = this.live.get(botId);
    if (!l) return [];
    const out = l.dialogs;
    l.dialogs = [];
    return out;
  }

  /** Tabs that stay open: not the ones being closed. */
  private openTabs(live: Live): Page[] {
    return live.context.pages().filter((p) => !live.closing.has(p));
  }

  /** How many tabs the site tried to open over the limit since the bot last heard; heard once. */
  takeRefusedTabs(botId: string): number {
    const l = this.live.get(botId);
    if (!l) return 0;
    const n = l.refusedTabs;
    l.refusedTabs = 0;
    return n;
  }

  /**
   * Saves what a page downloads, in the background: a large file must not hold the bot's step, nor
   * count against the time a step may take.
   */
  private keepDownload(live: Live, download: Download) {
    const name = safeFileName(download.suggestedFilename());
    const seq = ++live.started;
    if (live.saving.size >= MAX_DOWNLOADS) {
      void download.cancel().catch(() => {});
      live.downloads.push({ name, error: 'tooMany' });
      return;
    }
    const job = (async () => {
      // Inside the profile folder, so it goes when the bot does; the browser leaves it alone.
      const dir = join(this.opts.profileDir(live.botId), 'bot-downloads');
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const file = join(dir, `${randomUUID()}-${name}`);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const slow = new Promise<'slow'>((r) => {
        timer = setTimeout(() => r('slow'), DOWNLOAD_MS);
      });
      const saved = download.saveAs(file).then(
        () => 'ok' as const,
        () => 'failed' as const,
      );
      const result = await Promise.race([saved, slow]);
      clearTimeout(timer);
      if (result !== 'ok') {
        if (result === 'slow') await download.cancel().catch(() => {});
        rmSync(file, { force: true });
        live.downloads.push({ name, error: result });
        return;
      }
      const size = statSync(file).size;
      if (size > MAX_DOWNLOAD_BYTES) {
        rmSync(file, { force: true });
        live.downloads.push({ name, error: 'tooBig' });
        return;
      }
      live.downloads.push({ name, path: file, size });
    })()
      .catch(() => {
        live.downloads.push({ name, error: 'failed' });
      })
      .finally(() => live.saving.delete(job));
    live.saving.set(job, { name, seq });
  }

  /** How many downloads the bot's browser has started; the mark `downloadsSettled` waits from. */
  downloadMark(botId: string): number {
    return this.live.get(botId)?.started ?? 0;
  }

  /**
   * Waits up to `ms` for the downloads started after `since` (those the step itself set off; an
   * older long one does not slow every later step); the names of all still running after. Runs
   * outside the bot's step, so a slow file holds no other step of the browser.
   */
  async downloadsSettled(botId: string, ms: number, since = 0): Promise<string[]> {
    const l = this.live.get(botId);
    if (!l?.saving.size) return [];
    const mine = [...l.saving].filter(([, d]) => d.seq > since).map(([job]) => job);
    if (mine.length) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled(mine),
        new Promise<void>((r) => {
          timer = setTimeout(r, ms);
        }),
      ]);
      clearTimeout(timer);
    }
    return [...l.saving.values()].map((d) => d.name);
  }

  /** Downloads done or refused since the bot last heard; heard once. */
  takeDownloads(botId: string): PageDownload[] {
    const l = this.live.get(botId);
    if (!l) return [];
    const out = l.downloads;
    l.downloads = [];
    return out;
  }

  /** Sites that asked for a passkey since the bot last heard; heard once. */
  takePasskeys(botId: string): string[] {
    const l = this.live.get(botId);
    if (!l) return [];
    const out = l.passkeys;
    l.passkeys = [];
    return out;
  }

  /** Tabs the bot was on that the site closed itself, since the bot last heard; heard once. */
  takeClosedTabs(botId: string): string[] {
    const l = this.live.get(botId);
    if (!l) return [];
    const out = l.closedBySite;
    l.closedBySite = [];
    return out;
  }

  /** Closes one of the bot's tabs at its own wish, which is not the site closing it. */
  async closePage(botId: string, page: Page) {
    this.live.get(botId)?.closing.add(page);
    await page.close();
  }

  /** How the bot wants the page's next confirm or prompt answered. */
  answerNextDialog(botId: string, answer: { accept: boolean; text?: string }) {
    const l = this.live.get(botId);
    if (l) l.nextAnswer = answer;
  }

  /** The bot's open tabs, the active one marked. */
  pages(botId: string): { pages: Page[]; active: Page } | null {
    const l = this.live.get(botId);
    return l ? { pages: l.context.pages(), active: l.page } : null;
  }

  /** A tab's requests and console messages since it opened; null for a tab not of this bot. */
  log(botId: string, page: Page): PageLog | null {
    return this.live.get(botId)?.logs.get(page) ?? null;
  }

  /**
   * Remember a password typed into this bot's browser, so tool output never shows it. A short-lived
   * secret (a two-step code) is let go after `ttlMs`: six digits would otherwise keep matching
   * ordinary numbers on later pages.
   */
  rememberSecret(botId: string, secret: string, ttlMs = Infinity) {
    const l = this.live.get(botId);
    if (!l) return;
    l.secrets.set(secret, Math.max(l.secrets.get(secret) ?? 0, Date.now() + ttlMs));
  }

  /** Remember a short value filled into a field (see `fieldSecrets`). */
  rememberFieldSecret(botId: string, value: string) {
    this.live.get(botId)?.fieldSecrets.add(value);
  }

  fieldSecrets(botId: string): string[] {
    return [...(this.live.get(botId)?.fieldSecrets ?? [])];
  }

  secrets(botId: string): string[] {
    const l = this.live.get(botId);
    if (!l) return [];
    const now = Date.now();
    for (const [secret, until] of l.secrets) if (until <= now) l.secrets.delete(secret);
    return [...l.secrets.keys()];
  }

  /**
   * Whether a host is this computer, or a private host the operator let the browsers reach (a
   * router's page): plain http there crosses no one else's network.
   */
  localHost(raw: string): boolean {
    const host = raw.replace(/^\[|\]$/g, '').toLowerCase();
    if (this.opts.localHosts?.includes(host)) return true;
    if (host === 'localhost' || host.endsWith('.localhost') || host === '::1') return true;
    return isIP(host) === 4 && host.startsWith('127.');
  }

  async newPage(botId: string): Promise<Page> {
    const l = await this.get(botId);
    if (this.openTabs(l).length >= MAX_TABS) throw new BrowserError('tabs', String(MAX_TABS));
    const page = await l.context.newPage();
    this.activate(l, page);
    return page;
  }

  select(botId: string, page: Page) {
    const l = this.live.get(botId);
    if (l && l.context.pages().includes(page)) this.activate(l, page);
  }

  watch(botId: string, watcherId: string): { state: BrowserState; frame: Frame | null } {
    let set = this.watchers.get(botId);
    if (!set) this.watchers.set(botId, (set = new Set()));
    set.add(watcherId);
    const l = this.live.get(botId);
    if (l) l.lastUsed = Date.now();
    if (l && !l.cast) void this.startCast(l);
    return { state: this.state(botId), frame: l?.lastFrame ?? null };
  }

  unwatch(botId: string, watcherId: string) {
    const set = this.watchers.get(botId);
    if (!set?.delete(watcherId) || set.size) return;
    this.watchers.delete(botId);
    const l = this.live.get(botId);
    if (!l) return;
    void this.stopCast(l);
    // Nobody is looking any more: control goes back to the bot.
    this.release(l);
  }

  /** Take control (starting the browser if it is off) or hand it back to the bot. */
  async setControl(botId: string, on: boolean) {
    if (!on) {
      const l = this.live.get(botId);
      if (l) this.release(l);
      return;
    }
    const l = await this.get(botId);
    l.userControl = true;
    this.emitState(l);
  }

  private release(l: Live) {
    if (!l.userControl) return;
    l.userControl = false;
    l.lastUsed = Date.now();
    // Keys still held by the person would otherwise stay down for the bot.
    for (const key of l.modifiers) void l.page.keyboard.up(key).catch(() => {});
    l.modifiers.clear();
    this.emitState(l);
  }

  /**
   * Starts teach mode: the person takes control, and what they do is written down as steps until
   * they stop (see `teach.ts`).
   */
  async startTeaching(botId: string) {
    const l = await this.get(botId);
    l.userControl = true;
    l.lesson = [];
    const url = l.page.url();
    if (/^https?:/.test(url)) l.lesson.push({ kind: 'open', url });
    this.emitState(l);
  }

  /** Ends teach mode and hands back what was shown; null when the bot's browser was not teaching. */
  stopTeaching(botId: string): TeachStep[] | null {
    const l = this.live.get(botId);
    if (!l?.lesson) return null;
    const steps = l.lesson;
    l.lesson = null;
    return steps;
  }

  /** How many steps the lesson under way has; null when not teaching. */
  teaching(botId: string): number | null {
    return this.live.get(botId)?.lesson?.length ?? null;
  }

  /** Writes down one input of the person's in teach mode, before it is applied. */
  private async record(l: Live, input: BrowserInput, x: number, y: number) {
    const lesson = l.lesson;
    if (!lesson || lesson.length >= MAX_STEPS) return;
    const page = l.page;
    const url = page.url();
    const describe = (at: [number, number] | null) =>
      page.evaluate(`(${DESCRIBE})(${JSON.stringify(at)})`).catch(() => null) as Promise<Target | null>;
    switch (input.type) {
      case 'mouse': {
        if (input.action !== 'down' || (input.button ?? 'left') !== 'left') return;
        const target = await describe([x, y]);
        if (target) lesson.push({ kind: 'click', target, url });
        return;
      }
      case 'key': {
        if (input.action !== 'down') return;
        if ([...input.key].length === 1 && !l.modifiers.size) {
          const target = await describe(null);
          if (target) addTyping(lesson, target, input.key, url);
        } else if (input.key === 'Backspace') {
          const last = lesson.at(-1);
          if (last?.kind === 'type' && !last.secret) last.text = [...last.text].slice(0, -1).join('');
        } else if (
          ['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'PageDown', 'PageUp'].includes(input.key)
        ) {
          lesson.push({ kind: 'key', key: input.key, url });
        }
        return;
      }
      case 'text': {
        const target = await describe(null);
        if (target) addTyping(lesson, target, input.text, url);
        return;
      }
      case 'nav':
        lesson.push({ kind: 'nav', action: input.action, url });
        return;
      case 'open':
        lesson.push({ kind: 'open', url: webUrl(input.url).toString() });
        return;
    }
  }

  /** A person's mouse, keyboard or address bar input; ignored unless they have control. */
  input(botId: string, input: BrowserInput): Promise<void> {
    const l = this.live.get(botId);
    if (!l?.userControl) return Promise.resolve();
    // In arrival order: a click must land before the keys typed after it.
    l.inputs = l.inputs.then(() => this.apply(l, input)).catch(() => {});
    return l.inputs;
  }

  private async apply(l: Live, input: BrowserInput) {
    if (!l.userControl) return;
    l.lastUsed = Date.now();
    const page = l.page;
    const at = (x: number, y: number) =>
      [Math.round(x * VIEWPORT.width), Math.round(y * VIEWPORT.height)] as const;
    try {
      if (l.lesson) {
        const [x, y] = 'x' in input ? at(input.x, input.y) : [0, 0];
        await this.record(l, input, x, y);
      }
      switch (input.type) {
        case 'mouse': {
          const [x, y] = at(input.x, input.y);
          await page.mouse.move(x, y);
          if (input.action === 'down') await page.mouse.down({ button: input.button });
          if (input.action === 'up') await page.mouse.up({ button: input.button });
          break;
        }
        case 'wheel': {
          const [x, y] = at(input.x, input.y);
          await page.mouse.move(x, y);
          await page.mouse.wheel(input.dx, input.dy);
          break;
        }
        case 'key': {
          const { key, action } = input;
          if (SHORTCUT_MODIFIERS.has(key)) {
            if (action === 'down') l.modifiers.add(key);
            else l.modifiers.delete(key);
          }
          if ([...key].length === 1) {
            if (action !== 'down') break;
            // With Control, Meta or Alt held it is a shortcut (Ctrl+A); otherwise it is typed as
            // text, so any keyboard layout (ş, ğ, ü) works.
            if (l.modifiers.size) await page.keyboard.press(key);
            else await page.keyboard.insertText(key);
          } else if (action === 'down') await page.keyboard.down(key);
          else await page.keyboard.up(key);
          break;
        }
        case 'text':
          await page.keyboard.insertText(input.text);
          break;
        case 'nav':
          if (input.action === 'back') await page.goBack({ timeout: 15_000 });
          else if (input.action === 'forward') await page.goForward({ timeout: 15_000 });
          else await page.reload({ timeout: 15_000 });
          break;
        case 'open':
          await page.goto(webUrl(input.url).toString(), { waitUntil: 'domcontentloaded', timeout: 30_000 });
          break;
      }
    } catch {
      // A key the browser does not know or a page that would not load: nothing to report back.
    }
  }

  async close(botId: string) {
    const l = this.live.get(botId);
    if (!l) return;
    this.live.delete(botId);
    if (l.call) {
      l.call.page.off('load', l.call.rearm);
      l.call.release?.();
    }
    l.call = null;
    await this.stopCast(l);
    if (l.remote) await l.remote.close().catch(() => {});
    else await l.context.close().catch(() => {});
    this.emitState(l);
  }

  /**
   * Starts taking the audio of the call open in the bot's current tab; `onAudio` gets each
   * recording. The page script and its binding go in only now, for the rest of this browser's life:
   * both are marks a site could see, so a bot that never listens to a call never has them.
   * While it listens, the browser and its computer are not closed for being idle.
   */
  async listen(botId: string, onAudio: (audio: Buffer) => void, segmentMs?: number) {
    const live = await this.get(botId);
    if (live.call) throw new BrowserError('busy');
    if (!live.callReady) {
      await live.context.exposeBinding(CALL_BINDING, (source, audio: unknown) => {
        const call = this.live.get(botId)?.call;
        if (call && source.page === call.page && typeof audio === 'string')
          call.onAudio(Buffer.from(audio, 'base64'));
      });
      await live.context.addInitScript(CALL_CAPTURE_SCRIPT);
      live.callReady = true;
    }
    const page = live.page;
    const start = `window.__leafbotCall && window.__leafbotCall.start(${segmentMs ?? 0})`;
    await page.evaluate(CALL_CAPTURE_SCRIPT);
    await page.evaluate(start);
    const rearm = () => {
      if (this.live.get(botId)?.call?.page === page) void page.evaluate(start).catch(() => {});
    };
    page.on('load', rearm);
    live.call = { page, onAudio, rearm, release: this.opts.hold?.(botId) };
  }

  /** Stops listening; the recording under way is still handed over before this returns. */
  async unlisten(botId: string) {
    const live = this.live.get(botId);
    const call = live?.call;
    if (!live || !call) return;
    call.page.off('load', call.rearm);
    await call.page.evaluate('window.__leafbotCall && window.__leafbotCall.stop()').catch(() => {});
    // The page sends the last recording once the recorder has closed it, a moment after stopping.
    await new Promise((r) => setTimeout(r, LAST_RECORDING_MS));
    if (live.call === call) live.call = null;
    call.release?.();
    live.lastUsed = Date.now();
  }

  /**
   * How listening goes; null once the tab or the browser is gone. A page between two documents (it
   * cannot be asked, or its new one is not listening yet) reads as not listening, not as gone.
   */
  async listenState(botId: string): Promise<CaptureState | null> {
    const call = this.live.get(botId)?.call;
    if (!call || call.page.isClosed()) return null;
    const state = (await call.page
      .evaluate('window.__leafbotCall ? window.__leafbotCall.state() : null')
      .catch(() => null)) as CaptureState | null;
    return state ?? { listening: false, tracks: 0, audio: 'none' };
  }

  /**
   * Opens the bot's browser as an ordinary window, with its own profile and not driven by this
   * server, so the person can sign in to sites that refuse a remote-controlled browser. The cookies
   * stay in the profile; the bot's browser starts again with them once the window is closed.
   */
  async openWindow(botId: string, url?: string) {
    if (this.closed || !this.windowAvailable) throw new BrowserError('unavailable');
    if (this.windows.has(botId)) return;
    const address = url ? webUrl(url).toString() : null;
    await this.starting.get(botId)?.catch(() => {});
    const l = this.live.get(botId);
    if (l?.busy) throw new BrowserError('busy');
    if (this.windows.has(botId)) return;
    // Marked first: from here the bot's steps are refused and its browser cannot start again.
    let done!: () => void;
    const window: Window = { child: null!, exited: new Promise<void>((r) => (done = r)) };
    this.windows.set(botId, window);
    this.emitBot(botId);
    // Two programs cannot share a profile: the bot's browser closes first.
    await this.close(botId);
    const args = [
      `--user-data-dir=${this.opts.profileDir(botId)}`,
      // The bot's browser keeps its cookies under these settings; the window must read the same.
      '--password-store=basic',
      '--use-mock-keychain',
      '--disable-sync',
      '--no-first-run',
      '--no-default-browser-check',
      ...(address ? [address] : []),
    ];
    let child: ChildProcess;
    try {
      child = (this.opts.spawn ?? defaultSpawn)(this.opts.executable!, args);
    } catch (err) {
      this.windows.delete(botId);
      done();
      this.emitBot(botId);
      throw new BrowserError('launch', (err as Error).message.split('\n')[0]);
    }
    window.child = child;
    const end = () => {
      if (this.windows.get(botId) !== window) return;
      this.windows.delete(botId);
      done();
      this.emitBot(botId);
    };
    child.once('exit', end);
    child.once('error', end);
  }

  /**
   * Closes the window. On a Mac the browser keeps running after its last window closes, so this
   * asks it to quit. Chrome saves new cookies to disk only every 30 seconds: on SIGINT it quits as
   * from its menu and saves them first, while SIGTERM quits at once and loses them. Windows has no
   * such signal, so there the cookies are given time to be saved before the program is stopped.
   */
  async closeWindow(botId: string) {
    const w = this.windows.get(botId);
    // Still closing the bot's own browser: the program has not started yet.
    if (!w?.child) return;
    if (process.platform === 'win32') {
      const ended = await Promise.race([w.exited.then(() => true), sleep(COOKIE_SAVE_MS).then(() => false)]);
      if (ended) return;
    }
    w.child.kill(process.platform === 'win32' ? 'SIGTERM' : 'SIGINT');
    const timer = setTimeout(() => w.child.kill('SIGKILL'), 15_000);
    await w.exited;
    clearTimeout(timer);
  }

  async shutdown() {
    this.closed = true;
    if (this.sweep) clearInterval(this.sweep);
    await Promise.allSettled([...this.starting.values()]);
    await Promise.allSettled([
      ...[...this.live.keys()].map((id) => this.close(id)),
      ...[...this.windows.keys()].map((id) => this.closeWindow(id)),
    ]);
  }

  private async get(botId: string): Promise<Live> {
    const l = this.live.get(botId);
    if (l) return l;
    let p = this.starting.get(botId);
    if (!p) {
      p = this.launch(botId).finally(() => this.starting.delete(botId));
      this.starting.set(botId, p);
    }
    return p;
  }

  private async launch(botId: string): Promise<Live> {
    if (this.closed || !this.available) throw new BrowserError('unavailable');
    if (this.windows.has(botId)) throw new BrowserError('userControl');
    await this.makeRoom();
    let context: BrowserContext;
    let remote: Browser | null = null;
    let proxied = false;
    if (this.opts.connect) {
      try {
        const desktop = await this.opts.connect(botId);
        proxied = desktop.proxied;
        // Same API and version as playwright-core; only its overloaded types do not match by name.
        remote = (await desktopChromium.connectOverCDP(desktop.url, {
          timeout: 30_000,
        })) as unknown as Browser;
      } catch (err) {
        throw new BrowserError('launch', (err as Error).message.split('\n')[0]);
      }
      // The desktop's browser has one default context: its profile, tabs and windows.
      context = remote.contexts()[0] ?? (await remote.newContext());
      return this.adopt(botId, context, remote, proxied);
    }
    const dir = this.opts.profileDir(botId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Files a closed browser downloaded that no step took: the bot never heard of them.
    rmSync(join(dir, 'bot-downloads'), { recursive: true, force: true });
    const headless = this.opts.headless ?? true;
    const userAgent = headless ? await this.windowedUserAgent() : undefined;
    const locale = browserLocale(await this.opts.language?.().catch(() => undefined));
    try {
      context = await chromium.launchPersistentContext(dir, {
        executablePath: this.opts.executable ?? undefined,
        headless,
        ...(userAgent ? { userAgent } : {}),
        // Sets Accept-Language and navigator.language; without it they follow the server's own locale.
        locale,
        chromiumSandbox: this.opts.sandbox,
        viewport: VIEWPORT,
        screen: { width: SCREEN.width, height: SCREEN.height },
        deviceScaleFactor: SCREEN.scale,
        // A download goes to a folder of the bot's own first; its next step moves it to the
        // conversation's folder (see keepDownload).
        acceptDownloads: true,
        // A service worker's own requests pass neither the request filter nor its notes to the bot,
        // and it keeps running after the page is gone.
        serviceWorkers: 'block',
        // Sites such as Google refuse to sign in a browser that says it is driven by a program: no
        // "controlled by automated software" mark, and navigator.webdriver stays false.
        ignoreDefaultArgs: ['--enable-automation'],
        ...(this.opts.proxy && { proxy: { server: this.opts.proxy } }),
        args: [
          '--disable-dev-shm-usage',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-blink-features=AutomationControlled',
          // A page the bot opens never plays sound on the computer the server runs on.
          '--mute-audio',
          `--lang=${locale}`,
          // WebRTC would otherwise send UDP around the proxy and show sites the server's address.
          ...(this.opts.proxy ? ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] : []),
        ],
        timeout: 30_000,
      });
    } catch (err) {
      throw new BrowserError('launch', (err as Error).message.split('\n')[0]);
    }
    return this.adopt(botId, context, null, false);
  }

  /**
   * The identity this browser gives with a window, learned once from a short headless start with
   * no profile. Undefined when it cannot be learned: the browser then keeps its own.
   */
  private windowedUserAgent(): Promise<string | undefined> {
    this.userAgent ??= (async () => {
      const browser = await chromium.launch({
        executablePath: this.opts.executable ?? undefined,
        headless: true,
        chromiumSandbox: this.opts.sandbox,
        args: ['--disable-dev-shm-usage'],
        timeout: 30_000,
      });
      try {
        const page = await browser.newPage();
        // Client hints are given only to a secure page; this one is answered here, never fetched.
        await page.route(PROBE_URL, (route) => route.fulfill({ body: '', contentType: 'text/html' }));
        await page.goto(PROBE_URL).catch(() => {});
        const seen = await page.evaluate(async () => {
          const data = (
            navigator as unknown as {
              userAgentData?: Omit<SeenHints, 'fullVersionList'> & {
                getHighEntropyValues(keys: string[]): Promise<Partial<SeenHints>>;
              };
            }
          ).userAgentData;
          const high = data
            ? await data.getHighEntropyValues([
                'architecture',
                'bitness',
                'model',
                'platformVersion',
                'fullVersionList',
              ])
            : {};
          return {
            userAgent: navigator.userAgent,
            hints: data
              ? { brands: data.brands, mobile: data.mobile, platform: data.platform, ...high }
              : null,
          };
        });
        const userAgent = windowedUserAgent(seen.userAgent) ?? undefined;
        const metadata = seen.hints ? windowedHints(seen.hints as SeenHints) : null;
        if (metadata) this.hints = { userAgent: userAgent ?? seen.userAgent, userAgentMetadata: metadata };
        return userAgent;
      } finally {
        await browser.close();
      }
    })().catch(() => undefined);
    return this.userAgent;
  }

  /**
   * Refuses passkey requests at once (see PASSKEY_WALL) and notes the site for the bot. Pages
   * already open got no wall: they run on as they are, as do browsers that refuse the script.
   */
  private async wallPasskeys(live: Live, context: BrowserContext) {
    try {
      await context.exposeBinding(PASSKEY_BINDING, ({ page }) => {
        let site = '';
        try {
          site = new URL(page.url()).hostname;
        } catch {
          // A page without an address of its own (about:blank) is named by nothing.
        }
        if (live.passkeys.includes(site)) return;
        live.passkeys.push(site);
        if (live.passkeys.length > 5) live.passkeys.shift();
      });
      await context.addInitScript(PASSKEY_WALL);
    } catch {
      // Without it a passkey request waits until the site gives up, as before.
    }
  }

  private async adopt(
    botId: string,
    context: BrowserContext,
    remote: Browser | null,
    proxied: boolean,
  ): Promise<Live> {
    context.setDefaultTimeout(15_000);
    // On a desktop the last tab is the one most likely in front.
    const page = context.pages().at(-1) ?? (await context.newPage());
    const live: Live = {
      botId,
      remote,
      proxied,
      context,
      page,
      title: null,
      cast: null,
      lastFrame: null,
      busy: 0,
      userControl: false,
      lesson: null,
      modifiers: new Set(),
      inputs: Promise.resolve(),
      secrets: new Map(),
      fieldSecrets: new Set(),
      lastUsed: Date.now(),
      queue: Promise.resolve(),
      dialogs: [],
      nextAnswer: null,
      refused: new Set(),
      closedBySite: [],
      passkeys: [],
      refusedTabs: 0,
      downloads: [],
      saving: new Map(),
      started: 0,
      closing: new WeakSet(),
      speed: new WeakMap(),
      logs: new WeakMap(),
      call: null,
      callReady: false,
    };
    // A desktop's browser that leaves through the service's own SOCKS skips the per-request guard:
    // the SOCKS refuses private addresses itself, and the guard would only cost that browser its
    // HTTP cache and its service workers. A browser without that SOCKS keeps the guard — without
    // it nothing would keep the pages it opens away from the server's private network.
    if (!live.proxied) await this.guardNetwork(live, context);
    // The wall leaves a binding on every page's window, one more mark of a program for bot guards.
    // A desktop shows the passkey window on its own screen, where the bot or the person closes it.
    if (!remote) await this.wallPasskeys(live, context);
    for (const p of context.pages()) {
      this.track(live, p);
      if (!remote) await this.disguise(live, p);
    }
    context.on('page', (p) => {
      // On the person's desktop the browser is theirs too: their own tabs are never closed.
      if (!live.remote && !live.userControl && this.openTabs(live).length > MAX_TABS) {
        live.closing.add(p);
        live.refusedTabs++;
        void p.close().catch(() => {});
        return;
      }
      this.track(live, p);
      if (!live.remote) void this.disguise(live, p);
      // Links that open a new tab: follow them, as a person would.
      this.activate(live, p);
    });
    const gone = () => {
      if (this.live.get(botId) !== live) return;
      this.live.delete(botId);
      live.cast = null;
      this.emitState(live);
    };
    context.on('close', gone);
    // The person may close the desktop's browser, or the desktop may go to sleep.
    remote?.on('disconnected', gone);
    this.live.set(botId, live);
    this.startSweep();
    if (this.watchers.has(botId)) void this.startCast(live);
    this.emitState(live);
    return live;
  }

  /** Gives a page of a headless shell the client hints of a windowed browser (see windowedHints). */
  private async disguise(live: Live, page: Page) {
    if (!this.hints) return;
    try {
      const cdp = await live.context.newCDPSession(page);
      await cdp.send('Emulation.setUserAgentOverride', this.hints);
    } catch {
      // A page already gone, or a browser without the protocol: it keeps its own hints.
    }
  }

  private track(live: Live, page: Page) {
    if (!live.logs.has(page)) live.logs.set(page, watchPage(page));
    // Without a listener a page's confirm is cancelled unseen, and the click that asked it does
    // nothing the bot can tell. A notice is let through; a confirm or prompt is answered as the bot
    // said beforehand, else cancelled, and either way the bot hears what the page asked.
    page.on('dialog', (dialog) => {
      const type = dialog.type();
      const answer = type === 'confirm' || type === 'prompt' ? live.nextAnswer : { accept: true };
      if (type === 'confirm' || type === 'prompt') live.nextAnswer = null;
      const accepted = !!answer?.accept;
      live.dialogs.push({ type, message: dialog.message().slice(0, 500), accepted });
      if (live.dialogs.length > 5) live.dialogs.shift();
      void (accepted ? dialog.accept(answer?.text) : dialog.dismiss()).catch(() => {});
    });
    page.on('download', (download) => this.keepDownload(live, download));
    page.on('framenavigated', (frame) => {
      if (frame !== page.mainFrame() || live.page !== page) return;
      this.emitState(live);
    });
    page.on('load', () => {
      if (live.page !== page) return;
      void page
        .title()
        .then((title) => {
          live.title = title;
          this.emitState(live);
        })
        .catch(() => {});
    });
    // A tab whose page crashed (out of memory, say) cannot be used again: the same address
    // opens in a fresh tab and the dead one closes, so the bot's next step finds a page.
    page.on('crash', () => {
      const url = page.url();
      console.warn(`browser page crashed: ${url}`);
      // Counted out of the open tabs first, so the fresh one is not refused at the limit.
      live.closing.add(page);
      void (async () => {
        const fresh = await live.context.newPage();
        if (/^https?:/i.test(url)) await fresh.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
        this.activate(live, fresh);
        await page.close().catch(() => {});
      })().catch(() => {});
    });
    page.on('close', () => {
      if (live.page !== page || !this.live.has(live.botId)) return;
      // The site closed the tab the bot was on (a sign-in pop-up done, a `window.close()`): the bot
      // hears of it, or it would read whichever tab is in front now as if it were the same page.
      if (!live.closing.has(page)) {
        live.closedBySite.push(page.url());
        if (live.closedBySite.length > 5) live.closedBySite.shift();
      }
      const rest = live.context.pages().filter((p) => p !== page);
      if (rest.length) this.activate(live, rest.at(-1)!);
      else void live.context.newPage().catch(() => {});
    });
  }

  private activate(live: Live, page: Page) {
    if (live.page === page) return;
    const before = live.page;
    live.page = page;
    // A tab out of sight still runs its page's scripts and timers; slowed down, it leaves the
    // computer to the tab the bot works in. The tab in front runs at full speed again.
    // A call being listened to keeps its speed: slowed down, its recordings would break up.
    if (live.call?.page !== before) void this.throttle(live, before, BACKGROUND_CPU_RATE);
    void this.throttle(live, page, 1);
    live.title = null;
    void page
      .title()
      .then((title) => {
        live.title = title;
        this.emitState(live);
      })
      .catch(() => {});
    if (this.watchers.has(live.botId)) void this.startCast(live);
    this.emitState(live);
  }

  /**
   * Slows a tab's scripts by `rate` (1 is full speed); a closed tab or a refused call is let be.
   * Calls for one tab take effect in the order made, so the last switch decides its speed.
   */
  private async throttle(live: Live, page: Page, rate: number) {
    if (page.isClosed()) return;
    let session = live.speed.get(page);
    if (!session) {
      session = live.context.newCDPSession(page).catch(() => null);
      live.speed.set(page, session);
    }
    const cdp = await session;
    // Some browsers (another engine, an old Chromium) do not take it; the tab just runs as it is.
    await cdp?.send('Emulation.setCPUThrottlingRate', { rate }).catch(() => {});
  }

  private async startCast(live: Live) {
    await this.stopCast(live);
    const page = live.page;
    let cdp: CDPSession;
    try {
      cdp = await live.context.newCDPSession(page);
    } catch {
      return;
    }
    live.cast = cdp;
    cdp.on('Page.screencastFrame', (f) => {
      void cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      if (live.cast !== cdp) return;
      const frame = {
        data: Buffer.from(f.data, 'base64'),
        width: Math.round(f.metadata.deviceWidth),
        height: Math.round(f.metadata.deviceHeight),
      };
      live.lastFrame = frame;
      for (const l of this.listeners) l.frame(live.botId, frame);
    });
    await cdp
      .send('Page.startScreencast', {
        format: 'jpeg',
        quality: 60,
        maxWidth: VIEWPORT.width,
        maxHeight: VIEWPORT.height,
      })
      .catch(() => {});
  }

  private async stopCast(live: Live) {
    const cdp = live.cast;
    live.cast = null;
    if (!cdp) return;
    await cdp.send('Page.stopScreencast').catch(() => {});
    await cdp.detach().catch(() => {});
  }

  /** At the limit, the least recently used browser nobody is using or watching is closed. */
  private async makeRoom() {
    if (this.live.size < this.opts.max) return;
    const idle = [...this.live.values()]
      // Someone watching does not keep it: a view left open would hold the browser for good.
      .filter((l) => !l.busy && !l.userControl && !l.saving.size && !l.call)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    if (!idle[0]) throw new BrowserError('full');
    await this.close(idle[0].botId);
  }

  private startSweep() {
    if (this.sweep) return;
    this.sweep = setInterval(() => {
      const now = Date.now();
      for (const l of this.live.values()) {
        // A view left open does not keep an idle browser; a person holding control does, and so
        // do a download still coming in and a call being listened to.
        if (l.busy || l.userControl || l.saving.size || l.call) continue;
        if (now - l.lastUsed > this.opts.idleMs) void this.close(l.botId);
      }
    }, 60_000);
    this.sweep.unref();
  }

  private emitState(live: Live) {
    this.emitBot(live.botId);
  }

  private emitBot(botId: string) {
    const s = this.state(botId);
    for (const l of this.listeners) l.state(s);
  }
}

/** A little longer than the interval at which Chrome saves new cookies to disk. */
const COOKIE_SAVE_MS = 32_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function defaultSpawn(command: string, args: string[]): ChildProcess {
  return spawn(command, args, { stdio: 'ignore' });
}
