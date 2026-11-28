import { isAbsolute, join, normalize, relative } from 'node:path';

/**
 * The page that shows the account's servers: the web app's `bots` build, shipped inside this app and
 * served from its files, so the window shows the app and never the website. It reaches the account
 * through this app (see `preload-bots.ts`) and the servers only through the tunnel.
 */
export const BOTS_SCHEME = 'leafbot-app';
export const BOTS_HOST = 'bots';
export const BOTS_ORIGIN = `${BOTS_SCHEME}://${BOTS_HOST}`;

/** The page, at the chosen server when there is one (the page opens that one). */
export function botsUrl(server: string | null): string {
  const url = new URL(`${BOTS_ORIGIN}/bots/`);
  if (server) url.searchParams.set('server', server);
  return url.toString();
}

/**
 * The origin of a page address, compared whole: Node's URL gives `null` for any scheme it does not
 * know, which would make every such address look alike. Only the web's own schemes and the bots
 * page have one here; anything else has none and matches nothing.
 */
export function pageOrigin(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  if (url.protocol === `${BOTS_SCHEME}:` && url.host === BOTS_HOST) return BOTS_ORIGIN;
  return null;
}

/**
 * The file an address of the bots page names, inside `dir` (the build's `bots` folder); the page
 * itself for any path that is not a file (`/bots/`, `/bots/?server=…`). Null outside `/bots/`, or for
 * a path that would leave the folder.
 */
export function botsFile(dir: string, raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== `${BOTS_SCHEME}:` || url.host !== BOTS_HOST) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (!path.startsWith('/bots/') && path !== '/bots') return null;
  const inner = path.slice('/bots'.length).replace(/^\/+/, '');
  if (!inner || !/\.[a-z0-9]+$/i.test(inner)) return join(dir, 'index.html');
  const file = normalize(join(dir, inner));
  const rel = relative(dir, file);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return file;
}

const TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  wasm: 'application/wasm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  txt: 'text/plain; charset=utf-8',
};

export function contentType(file: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(file)?.[1]?.toLowerCase() ?? '';
  return TYPES[ext] ?? 'application/octet-stream';
}

/**
 * The page's Content-Security-Policy, the one the website serves the same page with: code only from
 * the app's own files, connections only to the relay (the tunnel itself is WebRTC). What a server
 * sends through the tunnel is shown from `blob:` and `data:` addresses (pictures, files), and cannot
 * load a script, a frame or reach another address by itself. The page holds the bridge to the
 * person's account, so this matters more here.
 */
export function botsPolicy(relayUrl: string): string {
  const relay = new URL(relayUrl).origin;
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "media-src 'self' blob: data:",
    "font-src 'self' data:",
    `connect-src 'self' ${relay}`,
    "frame-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}
