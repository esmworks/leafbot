import { describe, expect, it } from 'vitest';
import { de } from '../i18n/de';
import { en } from '../i18n/en';

const placeholders = (msg: string | undefined) => [...new Set(msg?.match(/\{\w+\}/g) ?? [])].sort();

/** A translation that names another placeholder, or drops one, would show a raw {name} or lose a value. */
describe('German catalog of the phone app', () => {
  it('only holds keys the English catalog has, with the same placeholders', () => {
    const wrong = Object.entries(de).filter(
      ([key, msg]) =>
        !(key in en) || placeholders(msg).join() !== placeholders(en[key as keyof typeof en]).join(),
    );
    expect(wrong.map(([key]) => key)).toEqual([]);
  });
});
