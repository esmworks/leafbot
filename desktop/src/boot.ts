// The app's entry (package.json "main"). Node keeps the main process's compiled code between starts
// in a folder of its own, which must be set before main.cjs is compiled: so here, in a file that
// loads nothing else first. See compile-cache.ts for the folder and its clean-up.
import { existsSync } from 'node:fs';
import module from 'node:module';
import { join } from 'node:path';
import { app } from 'electron';
import { compileCacheDir } from './compile-cache';

try {
  // The data folder main.ts settles on. Only one that already exists gets the cache: main.ts moves
  // an earlier installation's folder here only when there is none, and making one first would stop
  // that move and start the app empty.
  const userData = process.env.LEAFBOT_DESKTOP_DATA ?? join(app.getPath('appData'), 'esmworks-leafbot');
  if (existsSync(userData)) module.enableCompileCache?.(compileCacheDir(userData, app.getVersion(), 'main'));
} catch {
  // Without the cache the app only starts a little slower.
}
// eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the cache is on.
require('./main.cjs');
