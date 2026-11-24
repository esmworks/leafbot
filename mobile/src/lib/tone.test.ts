import { describe, expect, it } from 'vitest';
import { inTone, lightness, oklch, TINTED, TONES } from './tone';

const grays = Object.fromEntries(
  TINTED.map((key, i) => [key, ['#FAFAFA', '#FFFFFF', '#F0F0F0', '#636363', '#070707'][i % 5]!]),
) as Record<(typeof TINTED)[number], string>;
const table = { ...grays, foreground: '#121212', brand: '#4F6BED' };

describe('color tone', () => {
  it('leaves the colors as they are in the neutral tone', () => {
    expect(inTone(table, 'neutral', false)).toBe(table);
  });

  it('tints only the gray surfaces and keeps their lightness', () => {
    const slate = inTone(table, 'slate', true);
    expect(slate.foreground).toBe('#121212');
    expect(slate.brand).toBe('#4F6BED');
    expect(slate.card).toBe('#FFFFFF');
    expect(slate.background).not.toBe('#FAFAFA');
    for (const key of TINTED)
      expect(Math.abs(lightness(slate[key]) - lightness(table[key]))).toBeLessThan(0.01);
    // Cool: blue above red.
    const bg = slate.mutedForeground;
    expect(parseInt(bg.slice(5, 7), 16)).toBeGreaterThan(parseInt(bg.slice(1, 3), 16));
  });

  it('keeps every tone readable: each tints the grays without making them lighter or darker', () => {
    for (const tone of TONES.filter((t) => t !== 'neutral'))
      for (const dark of [false, true]) {
        const tinted = inTone(table, tone, dark);
        expect(tinted.background).not.toBe(table.background);
        for (const key of TINTED)
          expect(Math.abs(lightness(tinted[key]) - lightness(table[key]))).toBeLessThan(0.01);
      }
  });

  it('turns a gray into OKLCH and back without a change', () => {
    expect(oklch(lightness('#636363'), 0, 0)).toBe('#636363');
  });
});
