import { ApiError, endpoints, NoAnswerError, readAnswer, type SendOptions } from '@leafbot/client';
import { t, uiLocale } from './i18n';

export { ApiError, NoAnswerError };

/** How long a request may wait for the server before it counts as unreachable. */
const TIMEOUT_MS = 15_000;

/**
 * One request to the server at `origin`, from the panel. Chrome sends the session cookie of that
 * server with it, the one pairing set or the one of the Leaf Bot page signed in in this Chrome;
 * the panel never holds the session itself.
 */
async function request<T>(
  origin: string,
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
    res = await fetch(`${origin}${path}`, {
      method,
      headers,
      credentials: 'include',
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

/** Typed endpoints of the server at `origin`. */
export const apiFor = (origin: string) =>
  endpoints((method, path, body, opts) => request(origin, method, path, body, opts), origin);

export type Api = ReturnType<typeof apiFor>;

/** The error's own words, for a line under a form. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
