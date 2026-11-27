import { ApiError, endpoints, NoAnswerError, readAnswer, type SendOptions } from '@leafbot/client';
import type { Tunnel } from '@leafbot/client/tunnel';
import { t, uiLocale } from './i18n';

export { ApiError, NoAnswerError };

/** How long a request may wait for the server before it counts as unreachable. */
const TIMEOUT_MS = 15_000;

/**
 * One request to the server, from the panel, through the tunnel: the server knows the person from
 * the ticket the tunnel was opened with, so no cookie or key goes along.
 */
async function request<T>(
  tunnel: Tunnel,
  method: string,
  path: string,
  body?: unknown,
  opts: SendOptions = {},
) {
  const hasBody = method !== 'GET' && method !== 'DELETE';
  const headers: Record<string, string> = { accept: 'application/json', 'accept-language': uiLocale };
  if (hasBody) headers['content-type'] = 'application/json';
  Object.assign(headers, opts.headers);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const stop = () => ctrl.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  let res: Response;
  try {
    res = await tunnel.fetch(path, {
      method,
      headers,
      body: hasBody ? JSON.stringify(body ?? {}) : undefined,
      signal: ctrl.signal,
    });
  } catch {
    throw new NoAnswerError(t('error.noAnswer'));
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
  }
  const { data, reason } = readAnswer(await res.text());
  if (!res.ok)
    throw new ApiError(
      res.status,
      reason ?? t('error.requestFailed', { status: res.status }),
      reason !== null,
    );
  return data as T;
}

/** Typed endpoints of the server at the other end of `tunnel`. */
export const apiFor = (tunnel: Tunnel) =>
  endpoints((method, path, body, opts) => request(tunnel, method, path, body, opts));

export type Api = ReturnType<typeof apiFor>;

/** The error's own words, for a line under a form. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
