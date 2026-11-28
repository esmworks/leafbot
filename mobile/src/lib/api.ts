import {
  ApiError,
  NoAnswerError,
  endpoints,
  readAnswer,
  type SendOptions,
  type UploadOptions,
} from '@leafbot/client';
import { locale, t } from '@/i18n';
import { blobBytes, serverFetch } from './connection';

export { ApiError, NoAnswerError };
export type { JobView, LibraryFile, Settings } from '@leafbot/client';

/** How long a file may take to go up and be answered. */
const UPLOAD_MS = 10 * 60_000;

/**
 * One request to the chosen server, through the tunnel: the person is whoever the tunnel proved, so
 * there is no cookie, key or origin to send. A `Blob` body goes as it is, anything else as JSON.
 */
async function request<T>(method: string, path: string, body?: unknown, opts: SendOptions = {}): Promise<T> {
  const hasBody = method !== 'GET' && method !== 'DELETE';
  const raw = body instanceof Blob;
  const headers: Record<string, string> = { accept: 'application/json' };
  // A file goes as it is; everything else as JSON.
  if (hasBody) headers['content-type'] = raw ? 'application/octet-stream' : 'application/json';
  Object.assign(headers, opts.headers);
  // The server writes its error messages in the language the app asks in.
  headers['accept-language'] = locale;
  const payload = !hasBody
    ? null
    : raw
      ? await blobBytes(body)
      : new TextEncoder().encode(JSON.stringify(body ?? {}));
  // The tunnel reports no progress on a file: it is 0 until the answer comes, then 1.
  if (raw) opts.onProgress?.(0);
  const res = await serverFetch(path, {
    method,
    headers,
    body: payload,
    signal: opts.signal,
    ...(raw ? { timeoutMs: UPLOAD_MS } : {}),
  });
  const { data, reason } = readAnswer(await res.text());
  if (!res.ok) {
    throw new ApiError(
      res.status,
      reason ?? t('error.requestFailed', { status: res.status }),
      reason !== null,
    );
  }
  if (raw) opts.onProgress?.(1);
  return data as T;
}

/** A file picked on the phone, by where it lies on the device. */
export interface PickedFile {
  uri: string;
  name: string;
}

async function blobOf(file: PickedFile): Promise<Blob> {
  return (await fetch(file.uri)).blob();
}

/**
 * Typed endpoints of the chosen server; paths mirror the server routes. The addresses that come
 * out of it for a file or page (`fileUrl`, `pageUrl`) are paths on the server, not web addresses:
 * they are read through the tunnel (serverFiles.ts), never handed to an image or a web view.
 */
export function apiFor() {
  const shared = endpoints(request, '');
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
