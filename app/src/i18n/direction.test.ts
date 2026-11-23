import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const src = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Physical direction utilities that would keep the interface left-to-right in Arabic. */
const PHYSICAL = [
  /\b(?:ml|mr|pl|pr)-(?=\d|\[|auto|px|1\/2)/,
  /\btext-(?:left|right)\b/,
  /\b-?(?:left|right)-(?=\d|\[|auto|full|1\/2|px)/,
  /\bborder-[lr](?=-|")/,
  /\brounded-[lr](?=-|")/,
  /\brounded-(?:tl|tr|bl|br)(?=-|")/,
  // The other half of CENTERED below: a logical inset with a physical shift is off centre in Arabic.
  /\bstart-(?:1\/2|\[50%\])(?=.*(?:-translate-x-1\/2|translate-x-\[-50%\]))/,
];

/**
 * Centering by half the parent's width less half the element's looks the same in both directions,
 * but only with the physical left: start-1/2 is right:50% in Arabic while the shift still pulls left.
 */
const CENTERED = /\bleft-(?:1\/2|\[50%\])(?=.*(?:-translate-x-1\/2|translate-x-\[-50%\]))/g;

describe('direction', () => {
  it('uses logical direction utilities so a right-to-left language mirrors the layout', () => {
    const offenders: string[] = [];
    for (const file of readdirSync(src, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith('.tsx')) continue;
      const path = join(file.parentPath, file.name);
      const lines = readFileSync(path, 'utf8').split('\n');
      lines.forEach((line, index) => {
        const rest = line.replace(CENTERED, '');
        if (PHYSICAL.some((pattern) => pattern.test(rest))) {
          offenders.push(`${relative(src, path)}:${index + 1} ${line.trim().slice(0, 90)}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });
});
