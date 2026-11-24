/**
 * Where each note sits on the memory map: linked notes pull together, every two push apart, and
 * notes of the same owner (a bot, the person, a place) are drawn toward their own spot, so each
 * owner's notes read as one cluster. The same notes and links always land in the same place.
 */

export interface MapNode {
  id: string;
  /** Whose note it is: notes of one group cluster together. */
  group: string;
}

export interface MapLink {
  a: string;
  b: string;
  /** How strongly the link pulls, 0–1. */
  weight?: number;
}

export type Placed = Map<string, { x: number; y: number }>;

const ROUNDS = 300;

/** Places `nodes` in a `width` × `height` box, `pad` from its edges. */
export function placeNotes(
  nodes: MapNode[],
  links: MapLink[],
  width: number,
  height: number,
  pad = 24,
): Placed {
  const out: Placed = new Map();
  if (!nodes.length) return out;
  const cx = width / 2;
  const cy = height / 2;
  // Each group gets a spot on a ring around the middle; one group sits in the middle.
  const groups = [...new Set(nodes.map((n) => n.group))];
  const ring = Math.min(width, height) * 0.32;
  const home = new Map(
    groups.map((g, i) => {
      if (groups.length === 1) return [g, { x: cx, y: cy }];
      const angle = (2 * Math.PI * i) / groups.length - Math.PI / 2;
      return [g, { x: cx + ring * Math.cos(angle), y: cy + ring * Math.sin(angle) }];
    }),
  );
  // Start around the group's spot, spread by a fixed rule, not at random.
  const pos = nodes.map((n, i) => {
    const h = home.get(n.group)!;
    const angle = i * 2.399963; // the golden angle spreads points evenly
    const r = 12 + 6 * Math.sqrt(i % 40);
    return { x: h.x + r * Math.cos(angle), y: h.y + r * Math.sin(angle) };
  });
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const edges = links.flatMap((l) => {
    const i = index.get(l.a);
    const j = index.get(l.b);
    return i === undefined || j === undefined || i === j ? [] : [{ i, j, w: l.weight ?? 1 }];
  });
  const area = (width - 2 * pad) * (height - 2 * pad);
  const k = Math.sqrt(area / nodes.length) * 0.6;
  let step = Math.min(width, height) / 10;
  for (let round = 0; round < ROUNDS; round++) {
    const dx = new Float64Array(nodes.length);
    const dy = new Float64Array(nodes.length);
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const x = pos[i]!.x - pos[j]!.x;
        const y = pos[i]!.y - pos[j]!.y;
        const d2 = Math.max(x * x + y * y, 0.01);
        const f = (k * k) / d2;
        dx[i]! += x * f;
        dy[i]! += y * f;
        dx[j]! -= x * f;
        dy[j]! -= y * f;
      }
    }
    for (const { i, j, w } of edges) {
      const x = pos[i]!.x - pos[j]!.x;
      const y = pos[i]!.y - pos[j]!.y;
      const d = Math.max(Math.sqrt(x * x + y * y), 0.1);
      const f = (d / k) * w;
      dx[i]! -= x * f;
      dy[i]! -= y * f;
      dx[j]! += x * f;
      dy[j]! += y * f;
    }
    for (let i = 0; i < nodes.length; i++) {
      const h = home.get(nodes[i]!.group)!;
      dx[i]! += (h.x - pos[i]!.x) * 0.05 * k;
      dy[i]! += (h.y - pos[i]!.y) * 0.05 * k;
      const len = Math.max(Math.sqrt(dx[i]! * dx[i]! + dy[i]! * dy[i]!), 0.01);
      const move = Math.min(len, step);
      pos[i]!.x = clamp(pos[i]!.x + (dx[i]! / len) * move, pad, width - pad);
      pos[i]!.y = clamp(pos[i]!.y + (dy[i]! / len) * move, pad, height - pad);
    }
    step = Math.max(step * 0.97, 0.5);
  }
  nodes.forEach((n, i) => out.set(n.id, pos[i]!));
  return out;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);
