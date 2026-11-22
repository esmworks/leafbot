import type { Catalog, Locale } from '@leafbot/shared/i18n';
import { es as webEs } from '@leafbot/app/src/i18n/es';
import { fr as webFr } from '@leafbot/app/src/i18n/fr';
import { hi as webHi } from '@leafbot/app/src/i18n/hi';
import { id as webId } from '@leafbot/app/src/i18n/id';
import { it as webIt } from '@leafbot/app/src/i18n/it';
import { pl as webPl } from '@leafbot/app/src/i18n/pl';
import { pt as webPt } from '@leafbot/app/src/i18n/pt';
import { ru as webRu } from '@leafbot/app/src/i18n/ru';
import { uk as webUk } from '@leafbot/app/src/i18n/uk';
import { vi as webVi } from '@leafbot/app/src/i18n/vi';
import { zh as webZh } from '@leafbot/app/src/i18n/zh';
import { de as webDe } from '@leafbot/app/src/i18n/de';
import { en as webEn } from '@leafbot/app/src/i18n/en';
import { tr as webTr, type MessageKey as WebKey } from '@leafbot/app/src/i18n/tr';
import { de } from './de';
import { en } from './en';
import { tr, type OwnKey } from './tr';

/** Every key the phone app shows: the web app's, so both say the same thing, and its own. */
export type MessageKey = WebKey | OwnKey;

/**
 * Arabic is left out on purpose: React Native mirrors a layout only when it starts in right-to-left
 * mode, which needs the app to reload, so Arabic text would sit in a left-to-right layout here.
 * The phone app shows English for Arabic until that is built.
 */
/** English and Turkish are whole; other languages fall back to English for what they lack. */
export const catalogs: Partial<Record<Locale, Partial<Catalog<MessageKey>>>> = {
  tr: { ...webTr, ...tr },
  en: { ...webEn, ...en },
  de: { ...webDe, ...de },
  es: webEs,
  fr: webFr,
  hi: webHi,
  id: webId,
  it: webIt,
  pl: webPl,
  pt: webPt,
  ru: webRu,
  uk: webUk,
  vi: webVi,
  zh: webZh,
};
