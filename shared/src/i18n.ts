/**
 * Languages the app speaks. The first one is the default. Turkish and English hold every text;
 * the others hold what has been translated and show English for the rest (see `FALLBACK_LOCALE`).
 */
export const LOCALES = [
  'tr',
  'en',
  'de',
  'ar',
  'es',
  'fr',
  'hi',
  'id',
  'it',
  'pl',
  'pt',
  'ru',
  'uk',
  'vi',
  'zh',
] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = 'tr';
/** What a language shows for a text not translated into it yet. */
export const FALLBACK_LOCALE: Locale = 'en';
/** The languages every text must be written in; the others may lag behind. */
export const FULL_LOCALES: readonly Locale[] = ['tr', 'en'];

/** Each language's name in itself, for language pickers. */
export const LOCALE_NAMES: Record<Locale, string> = {
  tr: 'Türkçe',
  en: 'English',
  de: 'Deutsch',
  ar: 'العربية',
  es: 'Español',
  fr: 'Français',
  hi: 'हिन्दी',
  id: 'Bahasa Indonesia',
  it: 'Italiano',
  pl: 'Polski',
  pt: 'Português (Brasil)',
  ru: 'Русский',
  uk: 'Українська',
  vi: 'Tiếng Việt',
  zh: '简体中文',
};

/**
 * BCP 47 tag for `Intl` formatting (dates, numbers, case mapping). Chinese is the Simplified
 * script and Portuguese is the Brazilian variant; Arabic uses `ar-EG` so numbers stay Western,
 * the way they are written in prices, tables and the rest of the interface.
 */
export const INTL_LOCALE: Record<Locale, string> = {
  tr: 'tr-TR',
  en: 'en-US',
  de: 'de-DE',
  ar: 'ar-EG',
  es: 'es-ES',
  fr: 'fr-FR',
  hi: 'hi-IN',
  id: 'id-ID',
  it: 'it-IT',
  pl: 'pl-PL',
  pt: 'pt-BR',
  ru: 'ru-RU',
  uk: 'uk-UA',
  vi: 'vi-VN',
  zh: 'zh-CN',
};

/** The language's name in English, for telling a model which language to write in. */
export const LANGUAGE_NAMES: Record<Locale, string> = {
  tr: 'Turkish',
  en: 'English',
  de: 'German',
  ar: 'Arabic',
  es: 'Spanish',
  fr: 'French',
  hi: 'Hindi',
  id: 'Indonesian',
  it: 'Italian',
  pl: 'Polish',
  pt: 'Portuguese',
  ru: 'Russian',
  uk: 'Ukrainian',
  vi: 'Vietnamese',
  zh: 'Chinese (Simplified)',
};

/** Languages written right to left; the interface mirrors itself for them. */
export const RTL_LOCALES: readonly Locale[] = ['ar'];

export function isRtl(locale: Locale): boolean {
  return RTL_LOCALES.includes(locale);
}

export function isLocale(v: unknown): v is Locale {
  return typeof v === 'string' && (LOCALES as readonly string[]).includes(v);
}

/**
 * The first supported language in a preference list, such as `navigator.languages` or an
 * `Accept-Language` header ("en-GB,en;q=0.9,tr;q=0.8"). Regional variants match their language.
 */
export function pickLocale(
  prefs: string | readonly (string | null | undefined)[] | null | undefined,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  const list = typeof prefs === 'string' ? parseAcceptLanguage(prefs) : (prefs ?? []);
  for (const p of list) {
    const lang = p?.trim().toLowerCase().split(/[-_]/)[0];
    if (isLocale(lang)) return lang;
  }
  return fallback;
}

/** Language tags of an `Accept-Language` header, most preferred first. */
export function parseAcceptLanguage(header: string): string[] {
  return header
    .split(',')
    .map((part, i) => {
      const [tag = '', ...params] = part.trim().split(';');
      const q = params.map((x) => /^\s*q=([\d.]+)\s*$/.exec(x)?.[1]).find(Boolean);
      return { tag: tag.trim(), q: q === undefined ? 1 : Number(q), i };
    })
    .filter((x) => x.tag && x.tag !== '*' && x.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i)
    .map((x) => x.tag);
}

/** The CLDR plural categories `Intl.PluralRules` selects between. */
export type PluralCategory = 'zero' | 'one' | 'two' | 'few' | 'many' | 'other';

/**
 * A message, or plural forms picked by the `count` parameter. A language supplies the categories
 * it uses (Russian needs one/few/many, Arabic zero/two/few/many, Chinese only other); the rest
 * fall back to `other`.
 */
export type CatalogMessage = string | (Partial<Record<PluralCategory, string>> & { other: string });
export type Catalog<K extends string = string> = Record<K, CatalogMessage>;
export type Params = Record<string, string | number>;
export type Translate<K extends string> = (key: K, params?: Params) => string;

/** Fills `{name}` placeholders; unknown ones stay as written. */
export function interpolate(text: string, params?: Params): string {
  if (!params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) => (name in params ? String(params[name]) : m));
}

const pluralRules = new Map<Locale, Intl.PluralRules>();

function render(locale: Locale, msg: CatalogMessage, params?: Params): string {
  if (typeof msg === 'string') return interpolate(msg, params);
  let rules = pluralRules.get(locale);
  if (!rules) pluralRules.set(locale, (rules = new Intl.PluralRules(INTL_LOCALE[locale])));
  const count = Number(params?.count ?? 0);
  const category = rules.select(count) as PluralCategory;
  return interpolate(msg[category] ?? msg.other, params);
}

/**
 * A translate function over per-language catalogs. A key missing in one language falls back to
 * English, then to the default language, then to the key itself, so a gap never breaks the screen.
 * A message is put together by the rules of the language it was found in (its plural forms).
 */
export function createTranslator<K extends string>(
  catalogs: Partial<Record<Locale, Partial<Catalog<K>>>>,
  locale: Locale,
): Translate<K> {
  const order = [...new Set<Locale>([locale, FALLBACK_LOCALE, DEFAULT_LOCALE])];
  return (key, params) => {
    for (const lang of order) {
      const c = catalogs[lang];
      // Own entries only: a key like `constructor` must not find an object's built-in member.
      if (c && Object.hasOwn(c, key)) return render(lang, c[key]!, params);
    }
    return key;
  };
}
