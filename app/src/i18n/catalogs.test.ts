import type { CatalogMessage, Locale, PluralCategory } from '@leafbot/shared';
import { INTL_LOCALE, LOCALES } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import { en } from './en';
import { tr } from './tr';

type Messages = Partial<Record<string, CatalogMessage>>;

/** Every catalog except the reference pair, loaded the way the app loads it. */
const LOADERS: Record<Exclude<Locale, 'tr' | 'en'>, () => Promise<Messages>> = {
  de: () => import('./de').then((m) => m.de),
  ar: () => import('./ar').then((m) => m.ar),
  es: () => import('./es').then((m) => m.es),
  fr: () => import('./fr').then((m) => m.fr),
  hi: () => import('./hi').then((m) => m.hi),
  id: () => import('./id').then((m) => m.id),
  it: () => import('./it').then((m) => m.it),
  pl: () => import('./pl').then((m) => m.pl),
  pt: () => import('./pt').then((m) => m.pt),
  ru: () => import('./ru').then((m) => m.ru),
  uk: () => import('./uk').then((m) => m.uk),
  vi: () => import('./vi').then((m) => m.vi),
  zh: () => import('./zh').then((m) => m.zh),
};

const placeholders = (msg: CatalogMessage) =>
  [...new Set(JSON.stringify(msg).match(/\{\w+\}/g) ?? [])].sort();

const reference = en as Record<string, CatalogMessage>;

/**
 * The plural categories a language actually selects between for ordinary counts. Russian picks
 * one/few/many, Arabic picks all six, Chinese only other; a translation missing one of these
 * would show the wrong form or fall back to another language's shape.
 */
function categories(locale: Locale): PluralCategory[] {
  const rules = new Intl.PluralRules(INTL_LOCALE[locale]);
  const seen = new Set<PluralCategory>();
  for (let count = 0; count <= 110; count++) seen.add(rules.select(count) as PluralCategory);
  return [...seen].sort();
}

/** Text the interface shows, so a missing form or a renamed placeholder shows up here, not to a user. */
describe('translation catalogs', () => {
  it('keeps Turkish and English at the same keys', () => {
    expect(Object.keys(tr).sort()).toEqual(Object.keys(en).sort());
  });

  for (const locale of LOCALES.filter((l): l is Exclude<Locale, 'tr' | 'en'> => l !== 'tr' && l !== 'en')) {
    describe(`${locale} (${INTL_LOCALE[locale]})`, async () => {
      const catalog = await LOADERS[locale]();

      it('only holds keys the English catalog has', () => {
        expect(Object.keys(catalog).filter((key) => !(key in en))).toEqual([]);
      });

      it('keeps every placeholder the English text has', () => {
        const wrong = Object.entries(catalog).filter(([key, msg]) => {
          const allowed = new Set(placeholders(reference[key]!));
          return placeholders(msg!).some((p) => !allowed.has(p));
        });
        expect(wrong.map(([key]) => key)).toEqual([]);
      });

      it('keeps the shape of the English text (string stays string, plural stays plural)', () => {
        const wrong = Object.entries(catalog).filter(([key, msg]) => {
          return typeof reference[key]! !== typeof msg;
        });
        expect(wrong.map(([key]) => key)).toEqual([]);
      });

      it('says something for every key it holds', () => {
        const empty = Object.entries(catalog)
          .filter(([, msg]) =>
            typeof msg === 'string'
              ? msg.trim() === ''
              : Object.values(msg as Record<string, string>).some((f) => !f?.trim()),
          )
          .map(([key]) => key);
        expect(empty).toEqual([]);
      });

      it(`has the plural forms ${INTL_LOCALE[locale]} selects between`, () => {
        const wanted = categories(locale);
        const missing = Object.entries(catalog)
          .filter(([, msg]) => typeof msg === 'object')
          .filter(([, msg]) => wanted.some((cat) => !(cat in (msg as Record<string, string>))))
          .map(([key]) => key);
        expect(missing).toEqual([]);
      });
    });
  }
});
