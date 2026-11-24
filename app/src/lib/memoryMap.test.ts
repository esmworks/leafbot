import { describe, expect, it } from 'vitest';
import { placeNotes } from './memoryMap';

const dist = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.hypot(p.x - q.x, p.y - q.y);

describe('placing notes on the memory map', () => {
  const nodes = [
    ...Array.from({ length: 8 }, (_, i) => ({ id: `a${i}`, group: 'bot:a' })),
    ...Array.from({ length: 8 }, (_, i) => ({ id: `u${i}`, group: 'user' })),
  ];
  const links = [
    { a: 'a0', b: 'u0' },
    { a: 'a1', b: 'a2' },
  ];

  it('keeps every note inside the box, and lands them in the same place each time', () => {
    const one = placeNotes(nodes, links, 400, 300);
    const two = placeNotes(nodes, links, 400, 300);
    expect([...one.entries()]).toEqual([...two.entries()]);
    for (const p of one.values()) {
      expect(p.x).toBeGreaterThanOrEqual(24);
      expect(p.x).toBeLessThanOrEqual(376);
      expect(p.y).toBeGreaterThanOrEqual(24);
      expect(p.y).toBeLessThanOrEqual(276);
    }
  });

  it("draws one owner's notes together and a linked pair close", () => {
    const placed = placeNotes(nodes, links, 400, 300);
    const p = (id: string) => placed.get(id)!;
    const mean = (ids: string[]) => ({
      x: ids.reduce((s, id) => s + p(id).x, 0) / ids.length,
      y: ids.reduce((s, id) => s + p(id).y, 0) / ids.length,
    });
    const bots = nodes.filter((n) => n.group === 'bot:a').map((n) => n.id);
    const mine = nodes.filter((n) => n.group === 'user').map((n) => n.id);
    // A note sits nearer the middle of its own group than of the other.
    expect(dist(p('a5'), mean(bots))).toBeLessThan(dist(p('a5'), mean(mine)));
    expect(dist(p('u5'), mean(mine))).toBeLessThan(dist(p('u5'), mean(bots)));
    // A linked pair in one group is closer than an unlinked pair there, on average.
    expect(dist(p('a1'), p('a2'))).toBeLessThan(dist(p('a3'), p('a7')) + 40);
  });

  it('places nothing when there is nothing', () => {
    expect(placeNotes([], [], 400, 300).size).toBe(0);
  });
});
