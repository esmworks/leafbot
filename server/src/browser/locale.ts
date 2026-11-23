import { isLocale } from '@leafbot/shared';

/** The regional form of each interface language that a browser accepts as its own. */
const REGION: Record<string, string> = {
  tr: 'tr-TR',
  en: 'en-US',
  de: 'de-DE',
  ar: 'ar-SA',
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

const FALLBACK = 'en-US';

/** `tr_TR.UTF-8` as `tr-TR`; undefined for C, POSIX or anything that is not a language tag. */
function fromEnvironment(value: string | undefined): string | undefined {
  const tag = value?.split(/[.@:]/)[0]?.replace('_', '-');
  if (!tag || !/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(tag)) return undefined;
  try {
    return Intl.getCanonicalLocales(tag)[0];
  } catch {
    return undefined;
  }
}

/**
 * The language the bots' browser tells sites it prefers. A server whose own locale is C or POSIX
 * would otherwise send an empty or invalid one, which some sites answer with an error page, so
 * the interface language comes first, then the environment, then English.
 */
export function browserLocale(language?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isLocale(language)) return REGION[language] ?? FALLBACK;
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG']) {
    const found = fromEnvironment(env[name]);
    if (found) return found;
  }
  return FALLBACK;
}
