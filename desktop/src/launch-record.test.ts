import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe as group, expect, it } from 'vitest';
import {
  describe,
  HISTORY_FILE,
  kindOf,
  quantile,
  readHistory,
  summarize,
  withRecord,
  writeHistory,
  type LaunchRecord,
} from './launch-record';

const rec = (
  version: string,
  marks: Record<string, number>,
  kind: LaunchRecord['kind'] = 'usual',
): LaunchRecord => ({
  at: '2026-11-28T00:00:00.000Z',
  version,
  kind,
  shown: 'local',
  marks,
});

group('launch record', () => {
  it('tells a first start, a start after an update and a usual one apart', () => {
    expect(kindOf([], '1.0.0')).toBe('first');
    expect(kindOf([rec('1.0.0', {})], '1.0.1')).toBe('updated');
    expect(kindOf([rec('1.0.0', {})], '1.0.0')).toBe('usual');
  });

  it('keeps only the latest starts', () => {
    let list: LaunchRecord[] = [];
    for (let i = 0; i < 5; i++) list = withRecord(list, rec(String(i), {}), 3);
    expect(list.map((r) => r.version)).toEqual(['2', '3', '4']);
  });

  it('summarises usual starts only, by median and 90th percentile', () => {
    const list = [
      rec('1', { window: 9000 }, 'first'),
      ...[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((w) => rec('1', { window: w, ready: 50 })),
    ];
    expect(summarize(list)).toEqual([
      { name: 'ready', p50: 50, p90: 50, n: 10 },
      { name: 'window', p50: 500, p90: 900, n: 10 },
    ]);
    expect(quantile([], 0.5)).toBe(0);
  });

  it('reads back what it wrote, and an unreadable file as no starts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-launch-'));
    try {
      expect(readHistory(dir)).toEqual([]);
      writeHistory(dir, [rec('1', { ready: 1 })]);
      expect(readHistory(dir)).toEqual([rec('1', { ready: 1 })]);
      writeFileSync(join(dir, HISTORY_FILE), '{not json');
      expect(readHistory(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes one log line with the stages in order', () => {
    expect(describe(rec('1', { window: 300.4, ready: 120 }))).toBe(
      'launch (usual, local): ready 120, window 300',
    );
  });
});
