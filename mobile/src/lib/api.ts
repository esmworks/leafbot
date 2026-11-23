import {
  ApiError,
  NoAnswerError,
  endpoints,
  readAnswer,
  type SendOptions,
  type UploadOptions,
} from '@leafbot/client';
import { locale, t } from '@/i18n';

export { ApiError, NoAnswerError };
export type { JobView, LibraryFile, Settings } from '@leafbot/client';

/** How long a request may wait for the server before it counts as unreachable. */
const TIMEOUT_MS = 15_000;

/**
 * `fetch` that gives up after `ms`, so an address that never answers does not hang the screen;
 * `signal` calls it off sooner.
 */
async function fetchWithin(
  url: string,
  init: RequestInit,
  ms: number,
  signal?: AbortSignal,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  const stop = () => ctrl.abort();
  // Called off before it started (the chip was removed during the wait before a second try).
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
  }
}

/**
 * One request to the server at `origin`. The sign-in cookie lives in the phone's own cookie store,
 * which keeps it across launches, so no token is handled here.
 */
async function request<T>(
  origin: string,
  method: string,
  path: string,
  body?: unknown,
  opts: SendOptions = {},
): Promise<T> {
  const hasBody = method !== 'GET' && method !== 'DELETE';
  const raw = body instanceof Blob;
  const headers: Record<string, string> = { accept: 'application/json' };
  // A file goes as it is; everything else as JSON.
  if (hasBody) headers['content-type'] = raw ? 'application/octet-stream' : 'application/json';
  Object.assign(headers, opts.headers);
  // The server writes its error messages in the language the app asks in.
  headers['accept-language'] = locale;
  // The server takes a signed-in write only from a page of its own origin; a browser says so in
  // this header, and the app, which has no page, says it for itself.
  if (method !== 'GET') headers.origin = origin;
  const res = await fetchWithin(
    `${origin}${path}`,
    {
      method,
      credentials: 'include',
      headers,
      body: hasBody ? (raw ? body : JSON.stringify(body ?? {})) : undefined,
    },
    // A large file may take a while to go up over a home network.
    raw ? 10 * 60_000 : TIMEOUT_MS,
    opts.signal,
  );
  const { data, reason } = readAnswer(await res.text());
  if (!res.ok) {
    throw new ApiError(
      res.status,
      reason ?? t('error.requestFailed', { status: res.status }),
      reason !== null,
    );
  }
  return data as T;
}

/** Whether an LeafBot server answers at the origin. */
export async function answers(origin: string): Promise<boolean> {
  try {
    const res = await fetchWithin(`${origin}/api/health`, {}, 6000);
    const data = (await res.json()) as { ok?: unknown } | null;
    return res.status === 200 && data?.ok === true;
  } catch {
    return false;
  }
}

/** A file picked on the phone, by where it lies on the device. */
export interface PickedFile {
  uri: string;
  name: string;
}

async function blobOf(file: PickedFile): Promise<Blob> {
  return (await fetch(file.uri)).blob();
}

/** Typed endpoints of the server at `origin`; paths mirror the server routes. */
export function apiFor(origin: string) {
  const shared = endpoints((method, path, body, opts) => request(origin, method, path, body, opts), origin);
  return {
    ...shared,
    /**
     * Puts a file in the conversation's folder; the server may pick another name if it is taken.
     * `uploadId` is the same on a second try, so the server keeps one copy (see the shared retry).
     */
    uploadFile: async (threadId: string, file: PickedFile, opts: UploadOptions = {}) => {
      const body = await blobOf(file);
      try {
        return await shared.uploadFile(threadId, file.name, body, opts);
      } catch (err) {
        if (err instanceof ApiError || opts.signal?.aborted) throw err;
        throw new NoAnswerError(t('error.requestFailed', { status: 0 }));
      }
    },
    /** What a bot import file would make; saves nothing. */
    previewBotImport: async (file: PickedFile) => shared.previewBotImport(await blobOf(file)),
    importBots: async (file: PickedFile) => shared.importBots(await blobOf(file)),
  };
}
export type Api = ReturnType<typeof apiFor>;
