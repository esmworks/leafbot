import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SETTING_FILE = 'move-to-applications.json';

/**
 * Whether the app runs from a place macOS keeps it from updating itself: a disk image, or the
 * read-only copy macOS makes of an app opened straight from a download (App Translocation). An
 * app in a folder of the person's own, such as Downloads, can still be replaced, so it is left be.
 */
export function runsFromTransientPlace(platform: string, execPath: string, inApplications: boolean): boolean {
  if (platform !== 'darwin' || inApplications) return false;
  return execPath.includes('/AppTranslocation/') || execPath.startsWith('/Volumes/');
}

/** Whether the person said "not now" to moving the app, so it is not asked again at every start. */
export function readMoveDeclined(dir: string): boolean {
  try {
    return (
      (JSON.parse(readFileSync(join(dir, SETTING_FILE), 'utf8')) as { declined?: unknown }).declined === true
    );
  } catch {
    return false;
  }
}

export function writeMoveDeclined(dir: string, declined: boolean) {
  writeFileSync(join(dir, SETTING_FILE), JSON.stringify({ declined }));
}
