import {
  createTranslator,
  INTL_LOCALE,
  isLocale,
  pickLocale,
  type Catalog,
  type Locale,
  type Translate,
} from '@leafbot/shared';
import { create } from 'zustand';
import { desktop } from '@/lib/desktop';
import { en } from './en';
import { tr, type MessageKey } from './tr';

export type { MessageKey };
export type T = Translate<MessageKey>;

const KEY = 'leafbot.locale';
type Messages = Partial<Catalog<MessageKey>>;

/** Turkish and English are whole and always here; what another language lacks shows in English. */
const CATALOGS: Partial<Record<Locale, Messages>> = { tr, en };

/** Other languages load only when picked, so those who never use them do not download them. */
const LOADERS: Partial<Record<Locale, () => Promise<Messages>>> = {
  de: () => import('./de').then((m) => m.de),
};

/** Saved choice in this browser, else the browser's languages, else the default. */
function initial(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (isLocale(saved)) return saved;
  } catch {
    // Storage may be unavailable; fall back to the browser's languages.
  }
  return pickLocale(navigator.languages?.length ? navigator.languages : [navigator.language]);
}

function apply(locale: Locale) {
  document.documentElement.lang = locale;
  try {
    localStorage.setItem(KEY, locale);
  } catch {
    // ignore
  }
  void desktop?.setLocale?.(locale);
}

interface LocaleState {
  locale: Locale;
  /** BCP 47 tag for `Intl` and case mapping. */
  intl: string;
  t: T;
  /** Set when the user picked a language before the server's setting could be saved (login page). */
  unsaved: boolean;
  setLocale(locale: Locale, opts?: { unsaved?: boolean }): void;
}

const state = (locale: Locale) => ({
  locale,
  intl: INTL_LOCALE[locale],
  t: createTranslator(CATALOGS, locale),
});

export const useLocale = create<LocaleState>((set, get) => {
  /** Shows English until the language's own text arrives, then switches to it if it is still the choice. */
  const load = (locale: Locale) => {
    const loader = LOADERS[locale];
    if (!loader || CATALOGS[locale]) return;
    void loader()
      .then((messages) => {
        CATALOGS[locale] = messages;
        if (get().locale === locale) set(state(locale));
      })
      .catch(() => {
        // Offline or a stale build: the English text stays.
      });
  };
  const locale = initial();
  apply(locale);
  load(locale);
  return {
    ...state(locale),
    unsaved: false,
    setLocale: (next, opts) => {
      apply(next);
      set({ ...state(next), unsaved: !!opts?.unsaved });
      load(next);
    },
  };
});

/** The translate function for the current language; components re-render when it changes. */
export const useT = () => useLocale((s) => s.t);

/** Outside React (API errors, realtime): the current translate function. */
export const getT = () => useLocale.getState().t;
