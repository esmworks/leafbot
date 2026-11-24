import { INTL_LOCALE, type Locale, type Translate } from '@leafbot/shared/i18n';
import type { MessageKey } from '@/i18n/catalogs';

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function daysBetween(earlier: Date, later: Date) {
  return Math.round((startOfDay(later) - startOfDay(earlier)) / 86_400_000);
}

/** Date labels in one language, worded as the web app words them. */
export function formatters(locale: Locale, t: Translate<MessageKey>) {
  const tag = INTL_LOCALE[locale];
  const time = new Intl.DateTimeFormat(tag, { hour: '2-digit', minute: '2-digit' });
  const day = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long' });
  const dayYear = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', year: 'numeric' });
  const calendar = new Intl.DateTimeFormat(tag, { day: 'numeric', month: 'long', timeZone: 'UTC' });
  const weekday = new Intl.DateTimeFormat(tag, { weekday: 'long' });
  const weekdayShort = new Intl.DateTimeFormat(tag, { weekday: 'short' });
  const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase(tag) + s.slice(1);

  return {
    /** Above a run of messages: "Bugün 22:04", "Dün 09:10", "Salı 14:00", "3 Kasım 10:00". */
    dayLabel(iso: string, now = new Date()): string {
      const d = new Date(iso);
      const diff = daysBetween(d, now);
      const at = time.format(d);
      if (diff === 0) return t('date.today', { time: at });
      if (diff === 1) return t('date.yesterday', { time: at });
      if (diff > 1 && diff < 7) return `${capitalize(weekday.format(d))} ${at}`;
      return `${(d.getFullYear() === now.getFullYear() ? day : dayYear).format(d)} ${at}`;
    },

    /** A YYYY-MM-DD day on its own: "16 Kasım" / "November 16". */
    calendarDay(key: string): string {
      return calendar.format(new Date(`${key}T00:00:00Z`));
    },

    /** The time of day alone: "09:00". */
    clock(iso: string): string {
      return time.format(new Date(iso));
    },

    /** Beside a bot in the list: the time today, "Dün", a weekday this week, else the day. */
    shortTime(iso: string, now = new Date()): string {
      const d = new Date(iso);
      const diff = daysBetween(d, now);
      if (diff === 0) return time.format(d);
      if (diff === 1) return t('date.yesterdayShort');
      if (diff > 1 && diff < 7) return capitalize(weekdayShort.format(d));
      return day.format(d);
    },
  };
}

export type Formatters = ReturnType<typeof formatters>;

/** A date line goes above the first message and above one written over an hour after the last. */
export function needsDivider(prev: { createdAt: string } | undefined, next: { createdAt: string }): boolean {
  if (!prev) return true;
  return new Date(next.createdAt).getTime() - new Date(prev.createdAt).getTime() > 60 * 60 * 1000;
}
