import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The size a saved app's window opens at the first time. */
export const APP_WINDOW_SIZE = { width: 1000, height: 760 };
const FILE = 'app-windows.json';
/** Sizes are kept for this many apps; the oldest go first. */
const KEPT = 200;

type Sizes = Record<string, { width: number; height: number }>;

/** The page a saved app's window shows: the app's own view, without the chat (`?app=<id>`). */
export function appWindowUrl(origin: string, id: string): string {
  const url = new URL(origin);
  url.searchParams.set('app', id);
  return url.toString();
}

const fits = (n: unknown, min: number) =>
  typeof n === 'number' && Number.isFinite(n) && n >= min && n <= 10_000;

function read(dir: string): Sizes {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, FILE), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Sizes) : {};
  } catch {
    return {};
  }
}

/** The size the app's window had when it was last closed, else the first size. */
export function readAppWindowSize(dir: string, id: string): { width: number; height: number } {
  const kept = read(dir)[id];
  return kept && fits(kept.width, 360) && fits(kept.height, 280)
    ? { width: Math.round(kept.width), height: Math.round(kept.height) }
    : APP_WINDOW_SIZE;
}

export function writeAppWindowSize(dir: string, id: string, size: { width: number; height: number }) {
  const sizes = read(dir);
  delete sizes[id];
  sizes[id] = size;
  const ids = Object.keys(sizes);
  for (const old of ids.slice(0, Math.max(0, ids.length - KEPT))) delete sizes[old];
  try {
    writeFileSync(join(dir, FILE), JSON.stringify(sizes));
  } catch {
    // Not kept: the window opens at the first size next time.
  }
}
