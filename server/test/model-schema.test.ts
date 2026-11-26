import { describe, expect, it } from 'vitest';
import { modelSchema } from '../src/services/connections';

describe('araç şemasının alt şemaları', () => {
  it('true ve false alt şemaları nesneye çevirir; false olan alan düşer', () => {
    expect(
      modelSchema({
        type: 'object',
        properties: { any: true, never: false, list: { type: 'array', items: true }, ok: { type: 'string' } },
        required: ['never', 'ok'],
        additionalProperties: false,
      }),
    ).toEqual({
      type: 'object',
      properties: { any: {}, list: { type: 'array', items: {} }, ok: { type: 'string' } },
      required: ['ok'],
      additionalProperties: false,
    });
  });

  it('iç içe şemalarda ve alternatiflerde de çalışır', () => {
    expect(
      modelSchema({
        type: 'object',
        properties: {
          deep: { type: 'object', properties: { x: true, y: false }, required: ['y'] },
          either: { anyOf: [true, false, { type: 'string' }] },
          none: { oneOf: [false] },
          odd: { not: true, type: 'string' },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        deep: { type: 'object', properties: { x: {} } },
        either: { anyOf: [{}, { type: 'string' }] },
        none: {},
        odd: { type: 'string' },
      },
    });
  });

  it('sayı değerli enum ve sıradan şemalar olduğu gibi kalır', () => {
    const schema = {
      type: 'object',
      properties: { n: { type: 'integer', enum: [1, 2, 3] }, s: { type: 'string', const: 'a' } },
    };
    expect(modelSchema(schema)).toEqual(schema);
  });

  it('tipi yazılmamış enum değerlerinden tip alır; karışık değerlere dokunmaz', () => {
    expect(
      modelSchema({
        type: 'object',
        properties: {
          kind: { enum: ['a', 'b'] },
          size: { enum: [1, 2.5] },
          on: { enum: [true, false] },
          mixed: { enum: ['a', 1] },
          list: { type: 'array', items: { enum: ['x', 'y'] } },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        kind: { enum: ['a', 'b'], type: 'string' },
        size: { enum: [1, 2.5], type: 'number' },
        on: { enum: [true, false], type: 'boolean' },
        mixed: { enum: ['a', 1] },
        list: { type: 'array', items: { enum: ['x', 'y'], type: 'string' } },
      },
    });
  });
});
