import type { BotMaterial } from '@leafbot/shared';
import { getExample, type AvatarDefinition } from 'open-bot-avatar';

/**
 * Plain shapes beside the engine's own objects, for a bot that should look simple. Same contract as
 * the engine's: one outline wound clockwise in a 0 0 100 100 box, and the eyes where the body has room
 * for them. On the triangle, the drop and the star the eyes sit low and close, where the body is
 * wide enough; the leaf's stem is a second piece joined to it.
 */
const OWN: Record<string, AvatarDefinition> = {
  circle: {
    version: 1,
    id: 'circle',
    name: 'Circle',
    body: { path: 'M50 14A38 38 0 0 1 88 52A38 38 0 0 1 50 90A38 38 0 0 1 12 52A38 38 0 0 1 50 14Z' },
    eyes: { x: 50, y: 48, spacing: 18, scale: 1.2 },
  },
  square: {
    version: 1,
    id: 'square',
    name: 'Square',
    body: {
      path: 'M30 16H70A14 14 0 0 1 84 30V70A14 14 0 0 1 70 84H30A14 14 0 0 1 16 70V30A14 14 0 0 1 30 16Z',
    },
    eyes: { x: 50, y: 46, spacing: 18, scale: 1.2 },
  },
  triangle: {
    version: 1,
    id: 'triangle',
    name: 'Triangle',
    body: { path: 'M43 21Q50 10 57 21L87 73Q93 85 79 85H21Q7 85 13 73Z' },
    eyes: { x: 50, y: 62, spacing: 14, scale: 1 },
  },
  pill: {
    version: 1,
    id: 'pill',
    name: 'Pill',
    body: { path: 'M32 28H68A22 22 0 0 1 90 50A22 22 0 0 1 68 72H32A22 22 0 0 1 10 50A22 22 0 0 1 32 28Z' },
    eyes: { x: 50, y: 48, spacing: 18, scale: 1.1 },
  },
  diamond: {
    version: 1,
    id: 'diamond',
    name: 'Diamond',
    body: { path: 'M44 16Q50 10 56 16L84 44Q90 50 84 56L56 84Q50 90 44 84L16 56Q10 50 16 44Z' },
    eyes: { x: 50, y: 48, spacing: 16, scale: 1.1 },
  },
  hexagon: {
    version: 1,
    id: 'hexagon',
    name: 'Hexagon',
    body: {
      path: 'M34 16H66Q72 16 75 21L88 45Q91 50 88 55L75 79Q72 84 66 84H34Q28 84 25 79L12 55Q9 50 12 45L25 21Q28 16 34 16Z',
    },
    eyes: { x: 50, y: 48, spacing: 18, scale: 1.15 },
  },
  heart: {
    version: 1,
    id: 'heart',
    name: 'Heart',
    body: {
      path: 'M50 30C56 18 70 14 80 20C92 28 92 46 82 58L54 85Q50 89 46 85L18 58C8 46 8 28 20 20C30 14 44 18 50 30Z',
    },
    eyes: { x: 50, y: 47, spacing: 18, scale: 1.1 },
  },
  cloud: {
    version: 1,
    id: 'cloud',
    name: 'Cloud',
    body: {
      path: 'M30 76C18 76 10 68 10 58C10 48 18 41 27 41C28 29 38 21 50 21C61 21 70 28 72 38C82 38 90 46 90 57C90 68 82 76 71 76Z',
    },
    eyes: { x: 50, y: 54, spacing: 18, scale: 1.1 },
  },
  leaf: {
    version: 1,
    id: 'leaf',
    name: 'Leaf',
    body: {
      path:
        'M50 8C70 21 84 40 80 58C77 72 65 80 50 84C35 80 23 72 20 58C16 40 30 21 50 8Z' +
        'M46.5 80H53.5V92H46.5Z',
    },
    eyes: { x: 50, y: 52, spacing: 16, scale: 1.1 },
  },
  drop: {
    version: 1,
    id: 'drop',
    name: 'Drop',
    body: { path: 'M50 10C62 28 80 44 80 62C80 79 67 90 50 90C33 90 20 79 20 62C20 44 38 28 50 10Z' },
    eyes: { x: 50, y: 62, spacing: 16, scale: 1.1 },
  },
  star: {
    version: 1,
    id: 'star',
    name: 'Star',
    body: {
      path: 'M47.5 16.4Q50 11 52.5 16.4L62.3 38L85.9 40.7Q91.8 41.4 87.5 45.4L70 61.5L74.7 84.8Q75.9 90.6 70.7 87.7L50 76L29.3 87.7Q24.1 90.6 25.3 84.8L30 61.5L12.5 45.4Q8.2 41.4 14.1 40.7L37.7 38Z',
    },
    eyes: { x: 50, y: 55, spacing: 12, scale: 0.9 },
  },
};

/**
 * How much larger the eyes are drawn on a fluffy body. The coat buries each eye as a bead, showing
 * little more than half its height and hiding its edge under the fur, so at the flat size the face
 * reads as two specks. Every offered shape still holds eyes this large.
 */
export const FLUFFY_EYE_SCALE = 1.3;

const fluffyDrawings = new Map<string, AvatarDefinition>();

/**
 * The drawing of an object avatar: one of the plain shapes or one of the engine's objects. A fluffy
 * body gets larger eyes (see `FLUFFY_EYE_SCALE`); the same drawing comes back each time, so a mounted
 * avatar is not drawn anew on every render.
 */
export function objectDefinition(id: string, material: BotMaterial = 'flat'): AvatarDefinition | undefined {
  const flat = OWN[id] ?? getExample(id);
  if (!flat || material === 'flat') return flat;
  let fluffy = fluffyDrawings.get(id);
  if (!fluffy) {
    fluffy = { ...flat, eyes: { ...flat.eyes, scale: (flat.eyes.scale ?? 1) * FLUFFY_EYE_SCALE } };
    fluffyDrawings.set(id, fluffy);
  }
  return fluffy;
}
