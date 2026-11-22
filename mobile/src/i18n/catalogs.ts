import type { Catalog, Locale } from '@leafbot/shared/i18n';
import { de as webDe } from '@leafbot/app/src/i18n/de';
import { en as webEn } from '@leafbot/app/src/i18n/en';
import { tr as webTr, type MessageKey as WebKey } from '@leafbot/app/src/i18n/tr';
import { de } from './de';
import { en } from './en';
import { tr, type OwnKey } from './tr';

/** Every key the phone app shows: the web app's, so both say the same thing, and its own. */
export type MessageKey = WebKey | OwnKey;

/** English and Turkish are whole; other languages fall back to English for what they lack. */
export const catalogs: Partial<Record<Locale, Partial<Catalog<MessageKey>>>> = {
  tr: { ...webTr, ...tr },
  en: { ...webEn, ...en },
  de: { ...webDe, ...de },
};
