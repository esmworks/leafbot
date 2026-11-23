import { describe, expect, it } from 'vitest';
import { dayAllowed, monthGrid, monthOf, shiftMonth } from './calendar';

describe('the card date picker month', () => {
  it('lays a month out in weeks from Monday', () => {
    // 1 December 2026 is a Tuesday.
    const weeks = monthGrid(2026, 11);
    expect(weeks[0]).toEqual([
      null,
      '2026-12-01',
      '2026-12-02',
      '2026-12-03',
      '2026-12-04',
      '2026-12-05',
      '2026-12-06',
    ]);
    expect(weeks.at(-1)).toEqual(['2026-12-28', '2026-12-29', '2026-12-30', '2026-12-31', null, null, null]);
    expect(weeks.flat().filter(Boolean)).toHaveLength(31);
  });

  it('knows February in a leap year', () => {
    expect(monthGrid(2028, 1).flat().filter(Boolean).at(-1)).toBe('2028-02-29');
  });

  it('opens on the month of the chosen day, else today, and moves across years', () => {
    expect(monthOf('2026-03-15')).toEqual({ year: 2026, month: 2 });
    expect(monthOf(undefined, new Date(Date.UTC(2027, 6, 4)))).toEqual({ year: 2027, month: 6 });
    expect(shiftMonth({ year: 2026, month: 11 }, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth({ year: 2026, month: 0 }, -1)).toEqual({ year: 2025, month: 11 });
  });

  it('keeps to the days allowed', () => {
    expect(dayAllowed('2026-05-05', '2026-05-01', '2026-05-31')).toBe(true);
    expect(dayAllowed('2026-04-30', '2026-05-01')).toBe(false);
    expect(dayAllowed('2026-06-01', undefined, '2026-05-31')).toBe(false);
  });
});
