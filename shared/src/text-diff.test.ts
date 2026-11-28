import { describe, expect, it } from 'vitest';
import { lineHunks, textDiff } from './text-diff';

const join = (parts: { type: string; text: string }[], keep: string) =>
  parts
    .filter((p) => p.type === 'same' || p.type === keep)
    .map((p) => p.text)
    .join('');

describe('textDiff', () => {
  it('marks the words that changed and keeps the rest', () => {
    expect(textDiff('Send the weekly report', 'Send the daily report')).toEqual([
      { type: 'same', text: 'Send the ' },
      { type: 'removed', text: 'weekly' },
      { type: 'added', text: 'daily' },
      { type: 'same', text: ' report' },
    ]);
  });

  it('puts either version back together from its parts', () => {
    const before = 'Check the inbox.\nReply to urgent mail.\nSummarise the rest.';
    const after = 'Check the inbox every morning.\nSummarise the rest in three lines.';
    const parts = textDiff(before, after);
    expect(join(parts, 'removed')).toBe(before);
    expect(join(parts, 'added')).toBe(after);
  });

  it('handles empty versions', () => {
    expect(textDiff('', 'new')).toEqual([{ type: 'added', text: 'new' }]);
    expect(textDiff('old', '')).toEqual([{ type: 'removed', text: 'old' }]);
    expect(textDiff('same', 'same')).toEqual([{ type: 'same', text: 'same' }]);
  });

  it('compares a very long text line by line and stays correct', () => {
    const before = Array.from({ length: 2500 }, (_, i) => `line ${i} word`).join('\n');
    const after = before.replace('line 1200 word', 'line 1200 changed');
    const parts = textDiff(before, after);
    expect(join(parts, 'removed')).toBe(before);
    expect(join(parts, 'added')).toBe(after);
    expect(parts.filter((p) => p.type !== 'same')).toHaveLength(2);
  });
});

describe('lineHunks', () => {
  const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`);

  it('keeps a few unchanged lines around each change and leaves the rest out', () => {
    const before = lines(20);
    const after = [...before];
    after[1] = 'second';
    after[17] = 'eighteenth';
    const hunks = lineHunks(before.join('\n'), after.join('\n'), 2)!;
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toEqual([
      { type: 'same', text: 'line 1' },
      { type: 'removed', text: 'line 2' },
      { type: 'added', text: 'second' },
      { type: 'same', text: 'line 3' },
      { type: 'same', text: 'line 4' },
    ]);
    expect(hunks[1]!.filter((l) => l.type !== 'same')).toEqual([
      { type: 'removed', text: 'line 18' },
      { type: 'added', text: 'eighteenth' },
    ]);
  });

  it('joins changes close together into one hunk', () => {
    const before = lines(6);
    const after = ['line 1', 'two', 'line 3', 'four', 'line 5', 'line 6'];
    expect(lineHunks(before.join('\n'), after.join('\n'), 1)).toHaveLength(1);
  });

  it('shows a new file as added and a removed one as taken out', () => {
    expect(lineHunks('', 'a\nb\n')).toEqual([
      [
        { type: 'added', text: 'a' },
        { type: 'added', text: 'b' },
      ],
    ]);
    expect(lineHunks('a\n', '')).toEqual([[{ type: 'removed', text: 'a' }]]);
    expect(lineHunks('same\n', 'same')).toEqual([]);
  });

  it('gives up on parts too long to compare', () => {
    const a = lines(3000).join('\n');
    const b = lines(3000)
      .map((l) => `${l}!`)
      .join('\n');
    expect(lineHunks(a, b)).toBeNull();
  });
});
