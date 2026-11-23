export interface UploadRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Blob;
  /** The upload is cut off when nothing has gone up or come back for this long. */
  idleMs: number;
  signal?: AbortSignal;
  /** The part sent so far, from 0 to 1. */
  onProgress?: (part: number) => void;
}

export interface UploadAnswer {
  ok: boolean;
  status: number;
  text: string;
}

const failure = (name: string, message: string) => Object.assign(new Error(message), { name });

/**
 * Sends a file with XMLHttpRequest, the one request the phone's runtime reports upload progress
 * for. A file may take as long as the connection needs, so the limit is on silence, not on the
 * total: it is cut off only when no more has gone up for `idleMs`. A cut-off or called-off upload
 * fails as `fetch` does (AbortError), a dropped connection as a TypeError.
 */
export function xhrUpload(req: UploadRequest): Promise<UploadAnswer> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const done = () => {
      clearTimeout(timer);
      req.signal?.removeEventListener('abort', cancel);
    };
    const fail = (err: Error) => {
      done();
      xhr.abort();
      reject(err);
    };
    const cancel = () => fail(failure('AbortError', 'Aborted'));
    const idle = () => {
      clearTimeout(timer);
      timer = setTimeout(() => fail(failure('AbortError', 'Upload stalled')), req.idleMs);
    };
    xhr.open(req.method, req.url);
    xhr.withCredentials = true;
    for (const [name, value] of Object.entries(req.headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      idle();
      if (e.lengthComputable && e.total > 0) req.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      done();
      resolve({
        ok: xhr.status >= 200 && xhr.status < 300,
        status: xhr.status,
        text: xhr.responseText ?? '',
      });
    };
    xhr.onerror = () => fail(new TypeError('Network request failed'));
    xhr.ontimeout = () => fail(new TypeError('Network request failed'));
    if (req.signal?.aborted) return cancel();
    req.signal?.addEventListener('abort', cancel, { once: true });
    idle();
    xhr.send(req.body);
  });
}
