import { describe, expect, it } from 'vitest';
import { DISPLAY_QUIET_MS, keepDisplayOn } from './display-awake';

describe('ekranın açık tutulması', () => {
  it('bir bot Mac’i kullanırken ve hemen sonrasında açık tutar', () => {
    expect(keepDisplayOn(0)).toBe(true);
    expect(keepDisplayOn(DISPLAY_QUIET_MS - 1)).toBe(true);
  });

  it('sessiz süre dolunca ya da hiç kullanılmadıysa bırakır', () => {
    expect(keepDisplayOn(DISPLAY_QUIET_MS)).toBe(false);
    expect(keepDisplayOn(null)).toBe(false);
    expect(keepDisplayOn(undefined)).toBe(false);
    expect(keepDisplayOn(Number.NaN)).toBe(false);
  });
});
