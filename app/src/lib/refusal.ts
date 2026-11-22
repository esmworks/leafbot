import type { Locale } from '@leafbot/shared';

/** How a choice that declines reads in each language: the card shows it less loudly. */
const REFUSALS: Record<Locale, string[]> = {
  tr: ['hayır', 'iptal', 'vazgeç', 'istemiyorum', 'gerek yok', 'şimdilik değil', 'reddet', 'atla'],
  en: ['no', 'cancel', 'not now', "don't", 'do not', 'skip', 'decline', 'none'],
  de: ['nein', 'abbrechen', 'nicht jetzt', 'überspringen', 'ablehnen', 'keine', 'kein'],
};

/** Whether an offered answer declines (No, Cancel, Not now), in either language. */
export function isRefusal(label: string): boolean {
  const text = label
    .trim()
    .toLocaleLowerCase('tr')
    .replace(/[.!…,;:]+$/u, '');
  return Object.values(REFUSALS).some((words) =>
    words.some((w) => text === w || text.startsWith(`${w},`) || text.startsWith(`${w} `)),
  );
}
