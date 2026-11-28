import { Directory, File, Paths } from 'expo-file-system';
import { useEffect, useState } from 'react';
import { serverFetch } from './connection';

/**
 * Files from the server on the phone. A server is reached only through the tunnel, so an image, a
 * PDF or a download cannot be given to the system as an address; the file is read through the tunnel
 * into the phone's cache and the system gets that local file. Whatever is read stays only in the
 * cache, which is emptied on sign-out.
 */
const DIR = 'server-files';

/** Larger than this is refused: the whole file is held in memory while it comes. */
export const MAX_FILE_BYTES = 64 * 1024 * 1024;

const root = () => new Directory(Paths.cache, DIR);

/** A file name the filesystem takes, from a name the bot chose. */
export function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_').trim() || 'file';
}

/** The name a path names its file by: the last part of the `path` the address asks for. */
export function nameOfPath(path: string): string {
  const query = path.split('?')[1] ?? '';
  const asked = new URLSearchParams(query).get('path') ?? path.split('?')[0]!;
  return safeName(decodeURIComponent(asked.split('/').pop() ?? '') || 'file');
}

/** A short stable word for a path, so two files of one name do not meet in the cache. */
function hashOf(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/**
 * Reads a file of the server into the cache and gives its local address. `kind` names the cache
 * folder, so a file kept to share does not mix with a picture shown.
 */
export async function saveServerFile(
  path: string,
  name = nameOfPath(path),
  signal?: AbortSignal,
): Promise<string> {
  const res = await serverFetch(path, { timeoutMs: 30_000, signal });
  if (!res.ok) {
    res.cancel();
    throw new Error(String(res.status));
  }
  const size = Number(res.headers.get('content-length'));
  if (Number.isFinite(size) && size > MAX_FILE_BYTES) {
    res.cancel();
    throw new Error('too large');
  }
  const bytes = await res.bytes();
  if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('too large');
  const dir = new Directory(root(), hashOf(path));
  dir.create({ intermediates: true, idempotent: true });
  const file = new File(dir, safeName(name));
  file.create({ overwrite: true, intermediates: true });
  await file.write(bytes);
  return file.uri;
}

/** What is already read or being read, by path, so a picture shown twice is fetched once. */
const kept = new Map<string, Promise<string>>();

export function serverFileUri(path: string): Promise<string> {
  let p = kept.get(path);
  if (!p) {
    p = saveServerFile(path);
    kept.set(path, p);
    // A failure is not remembered: the next look asks again.
    p.catch(() => {
      if (kept.get(path) === p) kept.delete(path);
    });
  }
  return p;
}

/** The local address of a file on the server once it has been read; null while it is coming, `failed` if it could not be. */
export function useServerFile(path: string | null | undefined): { uri: string | null; failed: boolean } {
  const [state, setState] = useState<{ path: string; uri: string | null; failed: boolean } | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    serverFileUri(path).then(
      (uri) => live && setState({ path, uri, failed: false }),
      () => live && setState({ path, uri: null, failed: true }),
    );
    return () => {
      live = false;
    };
  }, [path]);
  if (!path || state?.path !== path) return { uri: null, failed: false };
  return { uri: state.uri, failed: state.failed };
}

/** Forgets every file read from the server: another person or server must not find them. */
export function clearServerFiles() {
  kept.clear();
  try {
    const dir = root();
    if (dir.exists) dir.delete();
  } catch {
    // A folder that cannot be removed is emptied by the system with the cache.
  }
}
