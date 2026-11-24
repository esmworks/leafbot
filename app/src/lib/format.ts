import { createTranslator, INTL_LOCALE, type Locale } from '@leafbot/shared';
import { useMemo } from 'react';
import { useLocale } from '@/i18n';
import { en } from '@/i18n/en';
import { tr } from '@/i18n/tr';

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Date and size labels in one language. */
export function formatters(locale: Locale) {
  const tag = INTL_LOCALE[locale];
  const t = createTranslator({ tr, en }, locale);
  const time = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long' });
  const dayYear = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric' });
  const weekday = new Intl.DateTimeFormat(tag, { weekday: 'long' });
  const weekdayShort = new Intl.DateTimeFormat(tag, { weekday: 'short' });
  const decimal = new Intl.NumberFormat(tag, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const dollars = new Intl.NumberFormat(tag, { style: 'currency', currency: 'USD' });
  const plain = new Intl.NumberFormat(tag, { maximumFractionDigits: 6 });
  // A day key is a calendar date, not a moment: read and shown in UTC so no time zone shifts it.
  const calendar = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const calendarShort = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase(tag) + s.slice(1);

  return {
    /** "Bugün 22:04", "Dün 09:10", "Salı 14:00", "3 Kasım 10:00" (and the same in English). */
    dayLabel(iso: string, now = new Date()): string {
      const d = new Date(iso);
      const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
      const at = time.format(d);
      if (diff === 0) return t('date.today', { time: at });
      if (diff === 1) return t('date.yesterday', { time: at });
      if (diff > 1 && diff < 7) return `${capitalize(weekday.format(d))} ${at}`;
      return `${(d.getFullYear() === now.getFullYear() ? day : dayYear).format(d)} ${at}`;
    },

    /** The time of day alone: "09:00". */
    clock(iso: string): string {
      return time.format(new Date(iso));
    },

    shortTime(iso: string, now = new Date()): string {
      const d = new Date(iso);
      if (startOfDay(d) === startOfDay(now)) return time.format(d);
      const diff = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
      if (diff === 1) return t('date.yesterdayShort');
      if (diff < 7) return capitalize(weekdayShort.format(d));
      return day.format(d);
    },

    /** "$1.25"; a cost above zero that rounds to nothing still shows as one. */
    usd(n: number): string {
      return n > 0 && n < 0.005 ? `<${dollars.format(0.01)}` : dollars.format(n);
    },

    /** A YYYY-MM-DD day: "16 Kasım" / "November 16", or short: "16 Kas". */
    calendarDay(key: string, short = false): string {
      return (short ? calendarShort : calendar).format(new Date(`${key}T00:00:00Z`));
    },

    /** A plain number with the language's separators: "1.500,5" / "1,500.5". */
    number(n: number): string {
      return plain.format(n);
    },

    fileSize(n: number): string {
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${decimal.format(n / 1024)} KB`;
      if (n < 1024 ** 3) return `${decimal.format(n / 1024 / 1024)} MB`;
      return `${decimal.format(n / 1024 ** 3)} GB`;
    },
  };
}

export type Formatters = ReturnType<typeof formatters>;

/** Formatters for the current language. */
export function useFormat(): Formatters {
  const locale = useLocale((s) => s.locale);
  return useMemo(() => formatters(locale), [locale]);
}

export function initials(name: string, intl = 'tr-TR'): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toLocaleUpperCase(intl);
}

export function newClientId(): string {
  return crypto.randomUUID();
}
