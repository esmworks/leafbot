import { describe, expect, it } from 'vitest';
import { withSaved } from './savedChoice';

describe('withSaved', () => {
  it('keeps the choices as they are when the saved value is one of them', () => {
    const choices = [0, 100, 200];
    expect(withSaved(choices, 100)).toBe(choices);
  });

  it('puts a saved value the menu lacks among the choices, in order', () => {
    expect(withSaved([0, 100, 200, 500], 150)).toEqual([0, 100, 150, 200, 500]);
  });
});
