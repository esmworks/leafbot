/** What one request may carry besides its method, path and body. */
export interface SendOptions {
  /** Added to the request's own; a `content-type` here wins over the one the body would get. */
  headers?: Record<string, string>;
  /** Sent while the page closes, so the request outlives it. */
  keepalive?: boolean;
  signal?: AbortSignal;
  /** How much of a file body has gone up, 0 to 1; only an upload reports it. */
  onProgress?: (part: number) => void;
}

/**
 * One request to the server, made the way the platform makes it: the browser with its own cookie
 * on the same origin, the phone at the server's address with a timeout. A `Blob` body goes as it
 * is, anything else as JSON. Resolves with the parsed answer; throws `ApiError` when the server
 * refused and `NoAnswerError` when nothing came back.
 */
export type Transport = <T>(method: string, path: string, body?: unknown, opts?: SendOptions) => Promise<T>;

export const httpOf = (send: Transport) => ({
  get: <T>(p: string) => send<T>('GET', p),
  post: <T>(p: string, b?: unknown) => send<T>('POST', p, b),
  patch: <T>(p: string, b?: unknown) => send<T>('PATCH', p, b),
  put: <T>(p: string, b?: unknown) => send<T>('PUT', p, b),
  del: <T>(p: string) => send<T>('DELETE', p),
});

/**
 * The parsed body of an answer, or null when it is empty or not JSON (a proxy's error page), with
 * the server's own reason when it refused.
 */
export function readAnswer(text: string): { data: unknown; reason: string | null } {
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  const reason = (data as { error?: unknown } | null)?.error;
  return { data, reason: typeof reason === 'string' ? reason : null };
}
