import type { Tunnel } from '@leafbot/client/tunnel';
import { create } from 'zustand';

/**
 * How this page reaches its server. Served by the server itself, the page asks its own origin with
 * its cookie. Served from the website (`/bots`), it reaches the server only through a tunnel, and
 * every request, Socket.IO connection and file goes through that instead; nothing about the server
 * is ever fetched from the website's origin, which belongs to the account service.
 */
interface TransportState {
  tunnel: Tunnel | null;
}

export const useTransport = create<TransportState>(() => ({ tunnel: null }));

export function setTunnel(tunnel: Tunnel | null) {
  useTransport.setState({ tunnel });
}

export function currentTunnel(): Tunnel | null {
  return useTransport.getState().tunnel;
}

/** Whether the page reaches its server through the tunnel (the web app on the website). */
export function viaTunnel(): boolean {
  return currentTunnel() !== null;
}

/** A request to a path on this page's server, by whichever way the page reaches it. */
export function serverFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const tunnel = currentTunnel();
  if (tunnel) return tunnel.fetch(path, init);
  return fetch(path, { credentials: 'same-origin', ...init });
}

/**
 * Whether the server offers a part of the app. A server reached directly serves the page that
 * matches it, so it offers everything; one reached through the tunnel says what it offers.
 */
export function useServerFeature(name: string): boolean {
  return useTransport((s) => !s.tunnel || s.tunnel.has(name));
}

export function serverFeature(name: string): boolean {
  const tunnel = currentTunnel();
  return !tunnel || tunnel.has(name);
}

/**
 * Where people outside reach the server (shared pages): its public address, else the page's own
 * origin when the server serves the page. On the web app the origin is the website's, so without a
 * public address there is none.
 */
export function publicOrigin(publicUrl: string | null | undefined): string | null {
  return publicUrl ?? (viaTunnel() ? null : window.location.origin);
}

let onMissing: ((feature: string) => void) | null = null;

/** What to tell the person when they reach for a part their server does not offer. */
export function setMissingFeatureHandler(handler: ((feature: string) => void) | null) {
  onMissing = handler;
}

/**
 * For actions that open a part of the app: whether the server offers it. When it does not, the
 * person is told so and the part stays closed, rather than opening onto requests that fail.
 */
export function offers(feature: string): boolean {
  if (serverFeature(feature)) return true;
  onMissing?.(feature);
  return false;
}
