import type { Schedule } from '@leafbot/shared';
import { INTL_LOCALE } from '@leafbot/shared/i18n';
import { locale, t } from '@/i18n';

const tag = INTL_LOCALE[locale];
const shortDay = new Intl.DateTimeFormat(tag, { weekday: 'long', timeZone: 'UTC' });
const shortDays = new Intl.DateTimeFormat(tag, { weekday: 'short', timeZone: 'UTC' });

/** A 2023 Sunday (formatted in UTC, so a zone west of it does not read the day before), so weekday number n falls on the nth day after it. */
const dayOf = (n: number) => new Date(Date.UTC(2023, 0, 1 + n));

/**
 * A routine's schedule in words. The shared helper sits behind the package's barrel, which the
 * phone cannot load, so the sentences come from this app's own catalog.
 */
export function describeSchedule(s: Schedule): string {
  const names = (days: number[], fmt: Intl.DateTimeFormat) =>
    [...days]
      .sort()
      .map((d) => fmt.format(dayOf(d)))
      .join(', ');
  switch (s.type) {
    case 'hourly':
      return t('panel.sched.hourly', { minute: String(s.minute).padStart(2, '0') });
    case 'daily':
    case 'weekdays':
      return t(s.type === 'daily' ? 'panel.sched.daily' : 'panel.sched.weekdays', { time: s.time });
    case 'weekly':
      return t('panel.sched.weekly', { days: names(s.days, shortDay), time: s.time });
    case 'monthly':
      return t('panel.sched.monthly', { day: s.day, time: s.time });
    case 'interval': {
      const every =
        s.minutes % 60 === 0
          ? t('panel.sched.hours', { count: s.minutes / 60 })
          : t('panel.sched.minutes', { count: s.minutes });
      const parts = [every];
      if (s.days) parts.push(names(s.days, shortDays));
      if (s.from && s.to) parts.push(t('panel.sched.between', { from: s.from, to: s.to }));
      return parts.join(', ');
    }
    case 'cron':
      return t('panel.sched.cron', { expr: s.expr });
    case 'once': {
      const [y, m, d] = s.date.split('-').map(Number) as [number, number, number];
      const date = new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(tag, {
        timeZone: 'UTC',
        dateStyle: 'medium',
      });
      return t('panel.sched.once', { date, time: s.time });
    }
    case 'unscheduled':
      return t('panel.sched.unscheduled');
  }
}
