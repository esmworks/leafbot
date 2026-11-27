import type { Bot, Group } from '@leafbot/shared';
import { placeSections } from './places';

/**
 * The bots in the order the sidebar lists them: those waiting on the person, the pinned ones, then
 * each section's in turn (the team spaces, Private and its folders, those shared with the person).
 */
export function sidebarOrder(
  bots: readonly Bot[],
  groups: readonly Group[],
  waiting: ReadonlySet<string>,
  me: string | undefined,
): Bot[] {
  const rest = bots.filter((b) => !waiting.has(b.id));
  return [
    ...bots.filter((b) => waiting.has(b.id)),
    ...rest.filter((b) => b.pinned),
    ...placeSections(
      rest.filter((b) => !b.pinned),
      groups,
      me,
    ).flatMap((s) => s.bots),
  ];
}

/** Which way a ⌘⇧] / ⌘⇧[ (Ctrl on Windows and Linux) press steps through the bots, or null. */
export function botStep(
  e: Pick<KeyboardEvent, 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): 1 | -1 | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || !e.shiftKey) return null;
  // The key's place, not its character: Shift turns ] into } on most layouts.
  return e.code === 'BracketRight' ? 1 : e.code === 'BracketLeft' ? -1 : null;
}

/** The place (0–8) a ⌘1…⌘9 / Ctrl+1…Ctrl+9 press asks for, or null for any other key. */
export function botShortcut(
  e: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>,
): number | null {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || !/^[1-9]$/.test(e.key)) return null;
  return Number(e.key) - 1;
}
