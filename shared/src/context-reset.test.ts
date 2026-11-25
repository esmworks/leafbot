import { describe, expect, it } from 'vitest';
import { lastResetIndex } from './context-reset';

describe('lastResetIndex', () => {
  it('finds the last reset line, so a second reset starts over from there', () => {
    const lines = [
      { props: {} },
      { props: { kind: 'contextReset' } },
      { props: {} },
      { props: { kind: 'contextReset' } },
      { props: {} },
    ];
    expect(lastResetIndex(lines)).toBe(3);
  });

  it('is -1 for a conversation never reset', () => {
    expect(lastResetIndex([{ props: {} }, { props: null }, {}])).toBe(-1);
    expect(lastResetIndex([])).toBe(-1);
  });
});
