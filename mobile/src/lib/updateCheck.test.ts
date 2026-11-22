import { describe, expect, it } from 'vitest';
import { shouldCheck, UPDATE_CHECK_EVERY_MS } from './updateCheck';

describe('looking for an update', () => {
  it('looks again at most once an hour', () => {
    expect(shouldCheck(null, 0)).toBe(true);
    expect(shouldCheck(1000, 1000 + UPDATE_CHECK_EVERY_MS - 1)).toBe(false);
    expect(shouldCheck(1000, 1000 + UPDATE_CHECK_EVERY_MS)).toBe(true);
  });
});
