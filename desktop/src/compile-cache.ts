import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Node keeps the compiled form of the app's code between starts when given a folder for it, so a
 * start after the first skips most of compiling: about a fifth of the server's start, measured with
 * `scripts/bench-server-start.mjs`. Each app version gets its own folder and the others are removed,
 * so code an update replaced does not pile up.
 */
export const COMPILE_CACHE = 'compile-cache';

export const compileCacheDir = (userData: string, version: string, part: 'main' | 'server') =>
  join(userData, COMPILE_CACHE, `${part}-${version}`);

/** Removes the folders of other versions; a folder that cannot be read or removed is left. */
export function pruneCompileCaches(userData: string, version: string): void {
  const root = join(userData, COMPILE_CACHE);
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (name.endsWith(`-${version}`)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
    } catch {
      // Still in use by a copy of the app that is open: the next start tries again.
    }
  }
}
