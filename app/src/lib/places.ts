import type { Bot, Group } from '@leafbot/shared';
import { UNGROUPED, type SectionKey } from './botLayout';

/*
 * Where a bot sits for the one looking: a team space they see, their own Private (with their
 * folders in it), or, for a bot someone shared with them alone, "Shared with me". A space's bot
 * is open to its people; a bot in Private is its owner's alone.
 */

/** The sidebar section of bots shared with the person that sit in no place of theirs. */
export const SHARED: SectionKey = 'shared';

/** A team space, not someone's own folder. Groups from servers older than spaces count as spaces. */
export const isSpace = (g: Group) => !g.ownerUserId;

/** The bot is the person's own; on a server that does not say whose bots are, every bot is. */
export const isMine = (b: Bot, me: string | undefined) => !me || !b.ownerUserId || b.ownerUserId === me;

/** The section the bot shows in: a group's id, Private (`UNGROUPED`) or `SHARED`. */
export function placeOf(b: Bot, groups: readonly Group[], me: string | undefined): SectionKey {
  // The person sees only spaces open to them and their own folders, so a bot in another
  // place is one shared with them alone.
  if (b.groupId && groups.some((g) => g.id === b.groupId)) return b.groupId;
  return isMine(b, me) ? UNGROUPED : SHARED;
}

export type SectionKind = 'space' | 'private' | 'folder' | 'shared';

export interface PlaceSection<B extends Bot = Bot> {
  key: SectionKey;
  kind: SectionKind;
  group: Group | null;
  bots: B[];
}

/** The sections in sidebar order: the team spaces, Private, its folders, then those shared with the person. */
export function placeSections<B extends Bot>(
  bots: readonly B[],
  groups: readonly Group[],
  me: string | undefined,
): PlaceSection<B>[] {
  const at = (key: SectionKey) => bots.filter((b) => placeOf(b, groups, me) === key);
  return [
    ...groups.filter(isSpace).map((g) => ({ key: g.id, kind: 'space' as const, group: g, bots: at(g.id) })),
    { key: UNGROUPED, kind: 'private' as const, group: null, bots: at(UNGROUPED) },
    ...groups
      .filter((g) => !isSpace(g))
      .map((g) => ({ key: g.id, kind: 'folder' as const, group: g, bots: at(g.id) })),
    { key: SHARED, kind: 'shared' as const, group: null, bots: at(SHARED) },
  ];
}

/**
 * The places the person may put the bot: Private, their folders and the spaces open to them for
 * it. A new bot (no `bot`) starts in Private or a folder; only once it is there may it go into a
 * space. Null when the person may not move the bot at all.
 */
export function placesFor(
  bot: Bot | undefined,
  groups: readonly Group[],
  me: string | undefined,
  manages: boolean,
): (Group | null)[] | null {
  const mine = !bot || isMine(bot, me);
  const inSpace = !!bot?.groupId && groups.some((g) => g.id === bot.groupId && isSpace(g));
  // Those who look after the server change the bots in spaces, not the ones in someone's Private.
  if (!mine && !(manages && inSpace)) return null;
  // A server older than spaces says nothing of who is in them and lets a bot go into any group.
  const old = (g: Group) => g.memberIds === undefined;
  const spaces = groups.filter(
    (g) => isSpace(g) && (old(g) || (!!bot && (manages || (!!me && g.memberIds!.includes(me))))),
  );
  if (!mine) return spaces;
  return [null, ...groups.filter((g) => !isSpace(g)), ...spaces];
}

/** How many people besides the bot's owner reach it through the space. */
export const othersIn = (g: Group | undefined, b: Bot) =>
  g && isSpace(g) ? (g.memberIds ?? []).filter((id) => id !== b.ownerUserId).length : 0;
