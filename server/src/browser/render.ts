import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PAGE_LIBRARIES } from '@leafbot/shared';
import type { Page } from 'playwright-core';

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

/** A browser of its own for one page, closed when `use` is done or the signal stops it. */
async function withPage<R>(
  o: RenderOptions,
  before: (page: Page) => Promise<void>,
  use: (page: Page) => Promise<R>,
): Promise<R> {
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
    await before(page);
    await page.setContent(o.html, { waitUntil: 'load', timeout: LOAD_MS });
    await page.waitForLoadState('networkidle', { timeout: SETTLE_MS }).catch(() => {});
    // Written as text: the server is compiled without the page's types.
    await page.evaluate('document.fonts.ready.then(() => 0)').catch(() => {});
    return await use(page);
  } finally {
    o.signal?.removeEventListener('abort', stop);
    await browser.close().catch(() => {});
  }
}

async function render(o: RenderOptions): Promise<Buffer> {
  return withPage(
    o,
    async () => {},
    async (page) => {
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
    },
  );
}

/** The longest page video, in seconds; a short clip for a post or a demo fits well inside it. */
export const MAX_VIDEO_SECONDS = 60;
/** Frames in one video at most: a minute at 30 a second. */
export const MAX_VIDEO_FRAMES = 1800;
/** The largest frame, after the scale: 1080p, which a minute of frames films well inside the time. */
export const MAX_VIDEO_SIZE = { width: 1920, height: 1080 };
export const MAX_VIDEO_PIXELS = MAX_VIDEO_SIZE.width * MAX_VIDEO_SIZE.height;
/** A video that has not been made by then is given up: the frames come one at a time. */
export const VIDEO_MS = 10 * 60_000;
/** One frame that takes longer than this (a `window.render` that never ends) stops the video. */
export const FRAME_MS = 20_000;
/**
 * Script time the page gets before the first frame: one animation frame, so what a page sets up in
 * its first `requestAnimationFrame` or `setTimeout(…, 0)` is already in the first picture.
 */
const LEAD_MS = 16;

export interface VideoOptions extends RenderOptions {
  height: number;
  /** The ffmpeg program that encodes the frames. */
  ffmpeg: string;
  seconds: number;
  fps: number;
  /** Tests shorten these; otherwise `FRAME_MS` and `VIDEO_MS`. */
  frameMs?: number;
  limitMs?: number;
}

/** Why a video could not be made, for the bot to change its page or its request. */
export class VideoError extends Error {
  readonly reason: 'stuck' | 'timeout' | 'ffmpeg';
  constructor(reason: VideoError['reason'], message: string = reason) {
    super(message);
    this.reason = reason;
  }
}

/**
 * Moves the page on to `t` seconds. Animations stand still in the page (their timeline is stopped
 * before it loads), so each running one is moved on here by the time since the last frame, at its
 * own speed: one the page holds paused stays where it is, one played backwards goes back. SVG's own
 * animations and videos are set to the time since they first showed. Then a page that defines
 * `window.render(t)` draws the moment itself. Script timers and `requestAnimationFrame` follow the
 * browser's stopped clock, moved on before this runs.
 */
const SEEK = `async (t) => {
  const last = window.__leafbotLast ?? t;
  window.__leafbotLast = t;
  const seen = window.__leafbotSeen || (window.__leafbotSeen = new Map());
  const since = (x) => { if (!seen.has(x)) seen.set(x, t === 0 ? 0 : t); return t - seen.get(x); };
  for (const a of document.getAnimations()) {
    if (a.playState !== 'running' || a.currentTime == null) continue;
    a.currentTime += (t - last) * 1000 * a.playbackRate;
  }
  for (const svg of document.querySelectorAll('svg')) {
    if (svg.ownerSVGElement) continue;
    const s = since(svg);
    svg.pauseAnimations();
    svg.setCurrentTime(s);
  }
  const seeks = [];
  for (const v of document.querySelectorAll('video')) {
    const s = since(v);
    v.pause();
    const at = v.loop && v.duration > 0 ? s % v.duration : Math.min(s, v.duration || s);
    if (Math.abs(v.currentTime - at) > 0.001) {
      seeks.push(new Promise((r) => { v.addEventListener('seeked', r, { once: true }); setTimeout(r, 2000); }));
      v.currentTime = at;
    }
  }
  await Promise.all(seeks);
  if (typeof window.render === 'function') await window.render(t);
}`;

/** The ffmpeg arguments: PNG frames in, an H.264 MP4 that plays everywhere and starts at once out. */
export function videoArgs(fps: number, out: string): string[] {
  return [
    ...['-hide_banner', '-loglevel', 'error', '-y'],
    ...['-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'png', '-i', '-'],
    // H.264 in 4:2:0 needs even sides; a page of odd pixels loses its last row or column. The
    // colours go into BT.709 and are labelled so, which players assume for a video this size.
    ...[
      '-vf',
      'scale=trunc(iw/2)*2:trunc(ih/2)*2:out_color_matrix=bt709:out_range=tv,format=yuv420p,' +
        'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709:range=tv',
    ],
    ...['-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p'],
    ...['-movflags', '+faststart', '-an', out],
  ];
}

/**
 * Videos wait for each other but not for pictures: a minute-long video takes minutes, and a
 * picture asked for meanwhile should not wait all that time. At most one of each runs at once.
 */
let videoQueue: Promise<unknown> = Promise.resolve();

/**
 * Films a bot's page frame by frame into an MP4, in the same closed-off browser as a picture. Time
 * stands still in the page and moves on by one frame before each picture, so a slow computer makes
 * the same video as a fast one; nothing is filmed in real time.
 */
export function renderVideo(o: VideoOptions): Promise<Buffer> {
  const run = () => film(o);
  const result = videoQueue.then(run, run);
  videoQueue = result.catch(() => {});
  return result;
}

/** `work`, or a `VideoError` of `reason` once `ms` have passed without it ending. */
function within<R>(work: Promise<R>, ms: number, reason: 'stuck'): Promise<R> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new VideoError(reason)), ms);
  });
  work.catch(() => {});
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

async function film(o: VideoOptions): Promise<Buffer> {
  const frames = Math.round(o.seconds * o.fps);
  // The tool asks for at least one; a video of none has nothing for ffmpeg to encode.
  if (frames < 1) throw new Error('A video needs at least one frame.');
  const dir = await mkdtemp(join(tmpdir(), 'leafbot-video-'));
  const out = join(dir, 'video.mp4');
  const limit = AbortSignal.timeout(o.limitMs ?? VIDEO_MS);
  const signal = AbortSignal.any([...(o.signal ? [o.signal] : []), limit]);
  try {
    await withPage(
      { ...o, signal },
      async (page) => {
        // Its animations are held at their start before it loads: a short one would otherwise run
        // out while the page settles and be gone before the first frame.
        const cdp = await page.context().newCDPSession(page);
        await cdp.send('Animation.enable');
        await cdp.send('Animation.setPlaybackRate', { playbackRate: 0 });
        // The page's clock is stopped before it loads too; it moves only when a frame asks.
        const start = Date.now();
        await page.clock.install({ time: start });
        await page.clock.pauseAt(start + 1000);
      },
      async (page) => {
        const ffmpeg = spawn(o.ffmpeg, videoArgs(o.fps, out), { stdio: ['pipe', 'ignore', 'pipe'] });
        let errors = '';
        ffmpeg.stderr.on('data', (d: Buffer) => (errors = (errors + d.toString()).slice(-2000)));
        const done = new Promise<number | null>((resolve, reject) => {
          ffmpeg.on('error', reject);
          ffmpeg.on('close', resolve);
        });
        // An unhandled failure here would stop the server; it is read where the video is awaited.
        done.catch(() => {});
        // Writing to an ffmpeg that has stopped fails; its exit says why, below.
        ffmpeg.stdin.on('error', () => {});
        const failed = done.then((code) => {
          throw new VideoError('ffmpeg', errors.trim() || `exit ${code}`);
        });
        failed.catch(() => {});
        const kill = () => ffmpeg.kill('SIGKILL');
        signal.addEventListener('abort', kill, { once: true });
        const frameMs = o.frameMs ?? FRAME_MS;
        try {
          let clock = 0;
          for (let i = 0; i < frames; i++) {
            signal.throwIfAborted();
            const ms = LEAD_MS + Math.round((i * 1000) / o.fps);
            if (ms > clock) await within(page.clock.runFor(ms - clock), frameMs, 'stuck');
            clock = ms;
            await within(page.evaluate(`(${SEEK})(${i / o.fps})`), frameMs, 'stuck');
            // PNG, not JPEG: one lossy step fewer before the video's own.
            const png = await within(page.screenshot({ type: 'png', timeout: frameMs }), frameMs, 'stuck');
            // An ffmpeg that stops while the frames wait for room ends the video there.
            if (!ffmpeg.stdin.write(png))
              await Promise.race([once(ffmpeg.stdin, 'drain', { signal }), failed]);
          }
          ffmpeg.stdin.end();
          const code = await done;
          signal.throwIfAborted();
          if (code !== 0) throw new VideoError('ffmpeg', errors.trim() || `exit ${code}`);
        } finally {
          signal.removeEventListener('abort', kill);
          if (ffmpeg.exitCode === null) kill();
        }
      },
    );
    return await readFile(out);
  } catch (err) {
    // The time ran out: the browser was closed under the frame it was taking, whose error says only that.
    if (limit.aborted && !o.signal?.aborted) throw new VideoError('timeout');
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
