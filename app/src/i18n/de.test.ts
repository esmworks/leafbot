import type { CatalogMessage } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { de } from './de';
import { en } from './en';

const placeholders = (msg: CatalogMessage | undefined) =>
  [...new Set(JSON.stringify(msg ?? '').match(/\{\w+\}/g) ?? [])].sort();

/** A translation that names another placeholder, or drops one, would show a raw {name} or lose a value. */
describe('German catalog', () => {
  it('only holds keys the English catalog has', () => {
    const extra = Object.keys(de).filter((k) => !(k in en));
    expect(extra).toEqual([]);
  });

  it('keeps every placeholder and plural shape of the English text', () => {
    const wrong = Object.entries(de).filter(([key, msg]) => {
      const source = en[key as keyof typeof en];
      if (typeof source !== typeof msg) return true;
      return placeholders(msg).join() !== placeholders(source).join();
    });
    expect(wrong.map(([key]) => key)).toEqual([]);
  });
});
