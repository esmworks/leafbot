import { useEffect, useState } from 'react';
import { currentTunnel, useTransport } from './transport';

/**
 * Files from the server on the web app at /bots. There the page's origin is the website's, and its
 * policy lets pictures, sound and video load only from /bots, `blob:` and `data:`. A file from the
 * server is fetched through the tunnel and shown from a `blob:` address, which takes the page's
 * origin: so only types that run nothing are let through. An SVG can carry script and an HTML page
 * certainly does, so neither is ever made a `blob:` here.
 */
const MEDIA =
  /^(image\/(png|jpeg|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/;

/** A path on the server, as opposed to a `blob:`, `data:` or web address. */
function serverPath(src: string): boolean {
  return src.startsWith('/') && !src.startsWith('//');
}

interface Entry {
  url: Promise<string | null>;
  users: number;
  drop: ReturnType<typeof setTimeout> | null;
}

/** Shared by every element showing the same file; let go a while after the last one goes. */
const cache = new Map<string, Entry>();
const KEEP_MS = 60_000;

async function fetchMedia(path: string): Promise<string | null> {
  const tunnel = currentTunnel();
  if (!tunnel) return null;
  const res = await tunnel.fetch(path).catch(() => null);
  if (!res?.ok) return null;
  const type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!MEDIA.test(type)) {
    void res.body?.cancel();
    return null;
  }
  return URL.createObjectURL(new Blob([await res.arrayBuffer()], { type }));
}

function hold(path: string): Promise<string | null> {
  let e = cache.get(path);
  if (!e) {
    e = { url: fetchMedia(path).catch(() => null), users: 0, drop: null };
    cache.set(path, e);
  }
  if (e.drop) clearTimeout(e.drop);
  e.drop = null;
  e.users++;
  return e.url;
}

function release(path: string) {
  const e = cache.get(path);
  if (!e || --e.users > 0) return;
  e.drop = setTimeout(() => {
    cache.delete(path);
    void e.url.then((u) => u && URL.revokeObjectURL(u));
  }, KEEP_MS);
}

/** Forgets every file from the server the page was on. */
export function dropServerFiles() {
  for (const [path, e] of cache) {
    if (e.drop) clearTimeout(e.drop);
    void e.url.then((u) => u && URL.revokeObjectURL(u));
    cache.delete(path);
  }
}

/**
 * The address to show a picture, sound or video from the server at. Reached directly, that is the
 * path itself; through the tunnel, a `blob:` address once the file has come, and nothing before
 * (or when the server sent something other than a picture, sound or video).
 */
export function useServerMedia(src: string | null | undefined): string | undefined {
  const tunnel = useTransport((s) => s.tunnel);
  const path = tunnel && src && serverPath(src) ? src : null;
  const [loaded, setLoaded] = useState<{ path: string; url: string | null } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    void hold(path).then((url) => {
      if (live) setLoaded({ path, url });
    });
    return () => {
      live = false;
      release(path);
    };
  }, [path, tunnel]);
  if (!src) return undefined;
  if (!path) return src;
  return loaded?.path === path ? (loaded.url ?? undefined) : undefined;
}

function fileName(res: Response, fallback: string): string {
  const cd = res.headers.get('content-disposition') ?? '';
  const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
  if (star) {
    try {
      return decodeURIComponent(star[1]!.trim());
    } catch {
      // Fall through to the plain name.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(cd);
  return plain?.[1]?.trim() || fallback;
}

/**
 * Saves a file from the server through the tunnel. It is always saved, never opened in a tab: a
 * `blob:` page would run in the website's origin, so the type is set to one the browser only saves.
 */
export async function saveServerFile(path: string, name?: string | null): Promise<void> {
  const tunnel = currentTunnel();
  if (!tunnel) return;
  const res = await tunnel.fetch(path);
  if (!res.ok) throw new Error(`${res.status}`);
  const fallback = decodeURIComponent(path.split('?')[0]!.split('/').pop() || 'download');
  const blob = new Blob([await res.arrayBuffer()], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || fileName(res, fallback);
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), KEEP_MS);
}

/**
 * Through the tunnel, a link to a path on the server would lead to the website instead. Every such
 * link on the page is caught here and its file saved through the tunnel; links elsewhere are left
 * alone. Returns the function that stops it.
 */
export function catchServerLinks(onError: (err: unknown) => void): () => void {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || (e.type === 'auxclick' && e.button !== 1)) return;
    const a = (e.target as Element | null)?.closest?.('a[href]');
    if (!(a instanceof HTMLAnchorElement)) return;
    let url: URL;
    try {
      url = new URL(a.href);
    } catch {
      return;
    }
    if (url.origin !== location.origin || !url.pathname.startsWith('/api/')) return;
    e.preventDefault();
    saveServerFile(url.pathname + url.search, a.getAttribute('download')).catch(onError);
  };
  document.addEventListener('click', onClick, true);
  document.addEventListener('auxclick', onClick, true);
  return () => {
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('auxclick', onClick, true);
  };
}
