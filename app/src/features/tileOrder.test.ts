import { describe, expect, it } from 'vitest';
import { orderAt, reconcile, type Box } from './tileOrder';

/** Tiles in one row, left to right, with a 16px gap: [id, width]. */
const row = (tiles: [string, number][], top = 0, height = 100) => {
  const boxes = new Map<string, Box>();
  let left = 0;
  for (const [id, width] of tiles) {
    boxes.set(id, { left, top, width, height });
    left += width + 16;
  }
  return boxes;
};

describe('orderAt', () => {
  it('sürüklenen kutucuğu üstündeki kutucuğun ortasının hangi yanındaysa oraya koyar', () => {
    const boxes = row([
      ['a', 200],
      ['b', 200],
      ['c', 200],
    ]);
    expect(orderAt(['a', 'b', 'c'], 'a', boxes, 600, 50, 1000)).toEqual(['b', 'c', 'a']);
    expect(orderAt(['a', 'b', 'c'], 'a', boxes, 520, 50, 1000)).toEqual(['b', 'a', 'c']);
    expect(orderAt(['a', 'b', 'c'], 'c', boxes, 50, 50, 1000)).toEqual(['c', 'a', 'b']);
  });

  it('kendi yerinde, iki kutucuk arasında ya da zaten o yandaysa bir şey değiştirmez', () => {
    const boxes = row([
      ['a', 200],
      ['b', 200],
    ]);
    expect(orderAt(['a', 'b'], 'a', boxes, 100, 50, 1000)).toBeNull();
    expect(orderAt(['a', 'b'], 'a', boxes, 208, 50, 1000)).toBeNull();
    expect(orderAt(['a', 'b'], 'a', boxes, 250, 50, 1000)).toBeNull();
  });

  it('satır boyu kutucukta yukarı ya da aşağı yarıya bakar', () => {
    const boxes = row([['a', 200]]);
    boxes.set('wide', { left: 0, top: 116, width: 1000, height: 100 });
    expect(orderAt(['a', 'wide'], 'a', boxes, 900, 140, 1000)).toBeNull();
    expect(orderAt(['a', 'wide'], 'a', boxes, 100, 200, 1000)).toEqual(['wide', 'a']);
  });

  it('yer değiştirdikten sonra kıpırdamayan işaretçi kutucukları geri itmez', () => {
    // A narrow tile dragged past a wide one: after they swap the point is over the dragged
    // tile's new place, so asking again changes nothing.
    const before = row([
      ['d', 200],
      ['w', 600],
    ]);
    const x = 216 + 400;
    const next = orderAt(['d', 'w'], 'd', before, x, 50, 1000);
    expect(next).toEqual(['w', 'd']);
    const after = row([
      ['w', 600],
      ['d', 200],
    ]);
    expect(orderAt(next!, 'd', after, x, 50, 1000)).toBeNull();
    expect(orderAt(next!, 'd', after, x - 2, 50, 1000)).toBeNull();
  });
});

describe('reconcile', () => {
  it('silinenleri çıkarır, yeni gelenleri sona ekler', () => {
    expect(reconcile(['b', 'a', 'c'], ['a', 'c', 'd'])).toEqual(['a', 'c', 'd']);
    expect(reconcile(['c', 'a'], ['a', 'b', 'c'])).toEqual(['c', 'a', 'b']);
  });
});
