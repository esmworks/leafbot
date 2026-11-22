import type { Bot, Memory, MemoryHistoryLine, Room, Translate } from '@leafbot/shared';
// The catalog's keys alone, by a relative path, so the phone app can use these too.
import type { MessageKey } from '../i18n/tr';

type T = Translate<MessageKey>;

/** Lower case without accents, the dotless ı as i: "Sınır" and "sinir" read the same. */
export function foldText(s: string): string {
  return s.toLocaleLowerCase('tr').normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/ı/g, 'i');
}

/** Whether every word typed is in the note's text or its site; no words matches everything. */
export function noteMatches(m: Pick<Memory, 'content' | 'site'>, query: string): boolean {
  const words = foldText(query).split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = foldText(m.site ? `${m.site} ${m.content}` : m.content);
  return words.every((w) => text.includes(w));
}

/** Whether a note's "true until" time has passed. */
export function noteExpired(m: Pick<Memory, 'validUntil'>, now = new Date()): boolean {
  return !!m.validUntil && new Date(m.validUntil).getTime() <= now.getTime();
}

/** A note's "true until" time as the day on the person's own calendar (`2026-11-27`), for a date field. */
export function untilDay(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The end of a day of the person's own calendar (`2026-11-27`), as the time a note is true until. */
export function untilEndOfDay(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d, 23, 59).toISOString();
}

/** Pinned notes first; the rest keep their order. */
export function pinnedFirst<M extends Pick<Memory, 'pinned'>>(notes: readonly M[]): M[] {
  return [...notes.filter((m) => m.pinned), ...notes.filter((m) => !m.pinned)];
}

/**
 * A place's name for the person: its channel in a chat app, or the title of the room when the
 * rooms are known.
 */
export function placeLabel(
  place: string | null | undefined,
  t: T,
  rooms: readonly Pick<Room, 'id' | 'title'>[] = [],
): string {
  const [kind, ...rest] = (place ?? '').split(':');
  const id = rest.join(':');
  if (!id) return t('memory.place.unknown');
  if (kind === 'slack') return t('memory.place.slack', { id });
  if (kind === 'discord') return t('memory.place.discord', { id });
  if (kind === 'room') {
    const title = rooms.find((r) => r.id === id)?.title;
    return title ? t('memory.place.roomNamed', { title }) : t('memory.place.room');
  }
  return t('memory.place.unknown');
}

export interface PlaceNoteGroup {
  place: string;
  label: string;
  notes: Memory[];
}

/** The notes about places grouped by place, in the order of the labels. */
export function placeNoteGroups(
  memory: readonly Memory[],
  t: T,
  rooms: readonly Pick<Room, 'id' | 'title'>[] = [],
): PlaceNoteGroup[] {
  const byPlace = new Map<string, Memory[]>();
  for (const m of memory) {
    if (m.scope !== 'room') continue;
    const place = m.place ?? '';
    byPlace.set(place, [...(byPlace.get(place) ?? []), m]);
  }
  return [...byPlace.entries()]
    .map(([place, notes]) => ({ place, label: placeLabel(place, t, rooms), notes: pinnedFirst(notes) }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/** Who did a history line: the person asking, a bot by its name, or someone unnamed. */
export function historyWho(
  line: Pick<MemoryHistoryLine, 'actor' | 'owner'>,
  me: string | null | undefined,
  bots: readonly Pick<Bot, 'id' | 'name'>[],
  t: T,
): string {
  const { actor } = line;
  if (actor.startsWith('bot:')) return bots.find((b) => b.id === actor.slice(4))?.name ?? t('common.bot');
  if (actor === 'bot') return t('common.bot');
  if (actor === 'tidy') return t('memory.history.tidy');
  if (actor.startsWith('user:') && actor.slice(5) === me) return t('memory.history.you');
  // A note added by hand used to name no one; one in the asker's own notes was theirs.
  if (actor === 'user' && me && line.owner === `user:${me}`) return t('memory.history.you');
  return t('memory.history.person');
}

/** One history line in words: what was done, and the text when it is still kept. */
export function historyText(line: MemoryHistoryLine, t: T): string {
  const what = t(`memory.history.${line.action}`);
  if (line.action === 'pin' || line.action === 'unpin') return what;
  const text = line.action === 'delete' ? line.before : (line.after ?? line.before);
  return `${what} · ${text ?? t('memory.history.notKept')}`;
}
