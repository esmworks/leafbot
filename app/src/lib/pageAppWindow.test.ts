import { describe, expect, it } from 'vitest';
import { pageAppWindowOf } from './pageAppWindow';

describe('pageAppWindowOf', () => {
  it("reads the app a window is for, and nothing that is not an app's id", () => {
    expect(pageAppWindowOf('?app=a_1-B')).toBe('a_1-B');
    expect(pageAppWindowOf('?quick=1')).toBeNull();
    expect(pageAppWindowOf('?app=../x')).toBeNull();
    expect(pageAppWindowOf('?app=')).toBeNull();
  });
});
