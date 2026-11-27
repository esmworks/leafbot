import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compileCacheDir, pruneCompileCaches } from './compile-cache';

describe('compile cache folders', () => {
  it('keeps one folder per part and version, and removes the other versions', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-cc-'));
    try {
      for (const v of ['0.9.0', '0.9.1']) {
        mkdirSync(compileCacheDir(dir, v, 'main'), { recursive: true });
        mkdirSync(compileCacheDir(dir, v, 'server'), { recursive: true });
      }
      pruneCompileCaches(dir, '0.9.1');
      expect(existsSync(compileCacheDir(dir, '0.9.1', 'main'))).toBe(true);
      expect(existsSync(compileCacheDir(dir, '0.9.1', 'server'))).toBe(true);
      expect(existsSync(compileCacheDir(dir, '0.9.0', 'main'))).toBe(false);
      expect(existsSync(compileCacheDir(dir, '0.9.0', 'server'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when there is no cache yet', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-cc-'));
    try {
      expect(() => pruneCompileCaches(dir, '1.0.0')).not.toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
