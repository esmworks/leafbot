import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One start of the app, stage by stage: the main process's own stages, the server's (from its
 * LEAFBOT_TIMINGS line) and the page's. Times are milliseconds since the main process began. The
 * last starts are kept on this computer only, so a slower build or a slow stage shows as numbers
 * rather than as a feeling; `scripts/launch-report.mjs` prints them.
 */
export interface LaunchRecord {
  at: string;
  version: string;
  /** The first start ever, the first after an update, or a usual one: each pays different costs. */
  kind: 'first' | 'updated' | 'usual';
  shown: 'local' | 'remote';
  marks: Record<string, number>;
  /** The server's stages, counted from the server process's own start. */
  server?: { marks: Record<string, number>; spans: Record<string, number> };
  /** Main-thread work in the page that ran 50 ms or longer before the chat was drawn. */
  pageLongTasks?: { count: number; totalMs: number };
}

export const HISTORY_FILE = 'launch-history.json';
export const KEEP = 50;

export function readHistory(dir: string): LaunchRecord[] {
  try {
    const list = JSON.parse(readFileSync(join(dir, HISTORY_FILE), 'utf8')) as unknown;
    return Array.isArray(list) ? (list as LaunchRecord[]) : [];
  } catch {
    return [];
  }
}

export function writeHistory(dir: string, list: LaunchRecord[]): void {
  writeFileSync(join(dir, HISTORY_FILE), JSON.stringify(list));
}

export const kindOf = (history: LaunchRecord[], version: string): LaunchRecord['kind'] => {
  const last = history.at(-1);
  if (!last) return 'first';
  return last.version === version ? 'usual' : 'updated';
};

export const withRecord = (history: LaunchRecord[], rec: LaunchRecord, keep = KEEP): LaunchRecord[] =>
  [...history, rec].slice(-keep);

/** The value below which `q` of the sorted values fall (nearest rank). */
export const quantile = (values: number[], q: number): number => {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};

/** Each main-process and page stage's median and 90th percentile over the usual starts. */
export function summarize(history: LaunchRecord[]): { name: string; p50: number; p90: number; n: number }[] {
  const usual = history.filter((r) => r.kind === 'usual');
  const names = [...new Set(usual.flatMap((r) => Object.keys(r.marks)))];
  return names
    .map((name) => {
      const values = usual.map((r) => r.marks[name]).filter((v): v is number => typeof v === 'number');
      return { name, p50: quantile(values, 0.5), p90: quantile(values, 0.9), n: values.length };
    })
    .sort((a, b) => a.p50 - b.p50);
}

/** One line for the log: the stages of this start in order. */
export const describe = (rec: LaunchRecord): string =>
  `launch (${rec.kind}, ${rec.shown}): ` +
  Object.entries(rec.marks)
    .sort((a, b) => a[1] - b[1])
    .map(([name, ms]) => `${name} ${Math.round(ms)}`)
    .join(', ');
