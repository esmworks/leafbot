/**
 * A month laid out as weeks for the card's date picker. The phone has no date picker of its own
 * without a native module, which would need a new build of the app; this one is drawn in plain
 * views. Weeks start on Monday. Days are `YYYY-MM-DD`, read and written in UTC so a day never
 * shifts with the phone's time zone.
 */

const pad = (n: number) => String(n).padStart(2, '0');

export const dayOf = (year: number, month: number, date: number) => `${year}-${pad(month + 1)}-${pad(date)}`;

/** The year and month (0-11) a day falls in; today's for no day. */
export function monthOf(day: string | undefined, today: Date = new Date()): { year: number; month: number } {
  const m = day ? /^(\d{4})-(\d{2})-\d{2}$/.exec(day) : null;
  return m
    ? { year: Number(m[1]), month: Number(m[2]) - 1 }
    : { year: today.getUTCFullYear(), month: today.getUTCMonth() };
}

/** The month before or after, `by` months away. */
export function shiftMonth(at: { year: number; month: number }, by: number): { year: number; month: number } {
  const d = new Date(Date.UTC(at.year, at.month + by, 1));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() };
}

/** The month's weeks, Monday first; days outside the month are null. */
export function monthGrid(year: number, month: number): (string | null)[][] {
  const first = new Date(Date.UTC(year, month, 1));
  const days = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  // Sunday is 0; Monday leads the week.
  const lead = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => dayOf(year, month, i + 1)),
  ];
  while (cells.length % 7) cells.push(null);
  const weeks: (string | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

/** Whether a day may be picked, given the card's first and last day allowed. */
export const dayAllowed = (day: string, min?: string, max?: string) =>
  !(min && day < min) && !(max && day > max);
