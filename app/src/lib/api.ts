import {
  ApiError,
  NoAnswerError,
  endpoints,
  readAnswer,
  type SendOptions,
  type UploadOptions,
} from '@leafbot/client';
import { getT, useLocale } from '@/i18n';

export { ApiError, NoAnswerError };
export type { JobView, LibraryFile, Settings } from '@leafbot/client';

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

/** Headers every request carries, with a body's type unless `extra` names another. */
function headersFor(method: string, body: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = {};
  // A file goes as it is; everything else as JSON.
  if (method !== 'GET' && method !== 'DELETE')
    headers['content-type'] = body instanceof Blob ? 'application/octet-stream' : 'application/json';
  // The server writes its error messages in the language the page asks in.
  return { ...headers, ...extra, 'accept-language': useLocale.getState().locale };
}

async function request<T>(method: string, path: string, body?: unknown, opts: SendOptions = {}): Promise<T> {
  if (opts.onProgress && body instanceof Blob) return sendFile<T>(method, path, body, opts);
  const hasBody = method !== 'GET' && method !== 'DELETE';
  const headers = headersFor(method, body, opts.headers);
  const payload = hasBody ? (body instanceof Blob ? body : JSON.stringify(body ?? {})) : undefined;
  let res: Response;
  let text: string;
  // Only a request that got no answer (or lost it on the way) is told apart as such: a mistake
  // made here before sending is thrown as it is.
  try {
    res = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers,
      body: payload,
      ...(opts.keepalive && { keepalive: true }),
      ...(opts.signal && { signal: opts.signal }),
    });
    text = await res.text();
  } catch (err) {
    if (opts.signal?.aborted) throw err;
    throw new NoAnswerError(err instanceof Error ? err.message : String(err));
  }
  const { data, reason } = readAnswer(text);
  if (!res.ok) {
    if (res.status === 401 && path !== '/api/access' && path !== '/api/login') onUnauthorized();
    throw new ApiError(
      res.status,
      reason ?? getT()('error.requestFailed', { status: res.status }),
      reason !== null,
    );
  }
  return data as T;
}

/**
 * Sends a file the way {@link request} does, but reports how much of it has gone up (`part`, 0 to
 * 1) and can be called off with `signal`; fetch can do neither for an upload.
 */
function sendFile<T>(method: string, path: string, file: Blob, opts: SendOptions): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'));
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(headersFor(method, file, opts.headers)))
      xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) opts.onProgress?.(e.loaded / e.total);
    };
    const abort = () => xhr.abort();
    opts.signal?.addEventListener('abort', abort, { once: true });
    const done = () => opts.signal?.removeEventListener('abort', abort);
    xhr.onabort = () => {
      done();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    xhr.onerror = () => {
      done();
      reject(new NoAnswerError(getT()('error.requestFailed', { status: 0 })));
    };
    xhr.onload = () => {
      done();
      const { data, reason } = readAnswer(xhr.responseText);
      if (xhr.status >= 200 && xhr.status < 300) return resolve(data as T);
      if (xhr.status === 401) onUnauthorized();
      reject(new ApiError(xhr.status, reason ?? getT()('error.requestFailed', { status: xhr.status })));
    };
    xhr.send(file);
  });
}

const shared = endpoints(request);

/** Typed endpoints of the server this page came from. */
export const api = {
  ...shared,
  /** Puts a file in the conversation's folder; the server may pick another name if it is taken. */
  uploadFile: (threadId: string, file: File, opts: UploadOptions = {}) =>
    shared.uploadFile(threadId, file.name, file, { ...opts, onProgress: opts.onProgress ?? (() => {}) }),
  /** A reply read aloud, as audio; null when the server could not. */
  speech: async (text: string): Promise<Blob> => {
    const res = await fetch('/api/speech', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', 'accept-language': useLocale.getState().locale },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      throw new Error(data?.error ?? String(res.status));
    }
    return res.blob();
  },
};
