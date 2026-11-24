import { Avatar, DEFAULT_AVATAR, OBJECT_AVATARS, OLD_AVATAR_SHAPES } from '@leafbot/shared';
import { validateAvatar } from 'open-bot-avatar';
import { FLUFFY_EYE_SCALE, objectDefinition } from './object-avatars';
import { describe, expect, it } from 'vitest';

describe('old shape avatars', () => {
  it('still takes every old shape and gives the round object for it', () => {
    for (const s of OLD_AVATAR_SHAPES) expect(Avatar.parse(`shape:${s}`)).toBe(DEFAULT_AVATAR);
    expect(Avatar.safeParse('shape:unicorn').success).toBe(false);
  });

  it('gives a new bot an avatar that is offered', () => {
    expect(OBJECT_AVATARS.map((o) => `object:${o}`)).toContain(DEFAULT_AVATAR);
    expect(Avatar.parse(DEFAULT_AVATAR)).toBe(DEFAULT_AVATAR);
  });
});

describe('object avatars', () => {
  it('accepts every offered object and nothing else', () => {
    for (const o of OBJECT_AVATARS) expect(Avatar.safeParse(`object:${o}`).success).toBe(true);
    expect(Avatar.safeParse('object:unicorn').success).toBe(false);
    expect(Avatar.safeParse('object:').success).toBe(false);
  });

  it('ships a valid drawing for every offered object', () => {
    for (const o of OBJECT_AVATARS) {
      const definition = objectDefinition(o);
      expect(definition, o).toBeDefined();
      const result = validateAvatar(definition);
      expect(result.ok, `${o}: ${JSON.stringify(result)}`).toBe(true);
    }
  });

  it('gives a fluffy body larger eyes that still fit, and leaves the flat drawing as it was', () => {
    for (const o of OBJECT_AVATARS) {
      const flat = objectDefinition(o)!;
      const fluffy = objectDefinition(o, 'fluffy')!;
      expect(objectDefinition(o, 'flat'), o).toBe(flat);
      expect(fluffy.eyes.scale, o).toBeCloseTo((flat.eyes.scale ?? 1) * FLUFFY_EYE_SCALE);
      expect(fluffy.body, o).toBe(flat.body);
      // The same drawing each time, so a mounted avatar is not mounted again.
      expect(objectDefinition(o, 'fluffy'), o).toBe(fluffy);
      const result = validateAvatar(fluffy);
      expect(result.ok, `${o}: ${JSON.stringify(result)}`).toBe(true);
    }
  });
});
