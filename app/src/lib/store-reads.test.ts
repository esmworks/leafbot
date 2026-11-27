import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * A component that reads a whole store, `useUi()` with no selector, draws again on every change to
 * it, a streamed word among them. Every reader picks the fields it uses; this keeps it so.
 */
const STORES = /\buse(Ui|Outbox|Browsers|Computers)\(\s*\)/;
const root = join(import.meta.dirname, '..');

function* sources(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, e.name);
    if (e.isDirectory()) yield* sources(path);
    else if (/\.(ts|tsx)$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) yield path;
  }
}

describe('store reads', () => {
  it('reads stores through a selector, never whole', () => {
    const whole = [...sources(root)].flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (STORES.test(line) ? [`${relative(root, file)}:${i + 1}`] : [])),
    );
    expect(whole).toEqual([]);
  });
});
