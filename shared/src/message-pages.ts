import type { Message } from './schemas.js';

/**
 * A conversation opens with this many of its latest messages: drawing hundreds of messages at once
 * held up opening a long conversation, and the older ones come in as the person scrolls up.
 */
export const CHAT_PAGE = 50;

/** The most the server sends in one page, and what it sends when no smaller page is asked for. */
export const FULL_PAGE = 500;

/**
 * How many of the latest messages to read again when the conversation changes: all that are on
 * screen, so a message further up that was deleted, reacted to or answered shows that too.
 */
export const refreshLimit = (held: number) => Math.min(Math.max(held, CHAT_PAGE), FULL_PAGE);

/**
 * The messages on screen after the latest ones were read again. New messages push the oldest
 * ones out of that read; those stay above it, so neither a gap nor a row vanishing from above
 * the person's place shows up. When the new read shares no message with what was on screen (a
 * long time offline, a conversation started over), what was on screen no longer joins it and
 * only the new read is kept.
 */
export function keepEarlier(held: readonly Message[], latest: Message[]): Message[] {
  if (!held.length || !latest.length) return latest;
  const ids = new Set(latest.map((m) => m.id));
  const joint = held.findIndex((m) => ids.has(m.id));
  if (joint <= 0) return latest;
  return [...held.slice(0, joint), ...latest];
}

/** An older page put above the messages on screen; one already there is not shown twice. */
export function withOlder(page: readonly Message[], held: readonly Message[]): Message[] {
  const ids = new Set(held.map((m) => m.id));
  return [...page.filter((m) => !ids.has(m.id)), ...held];
}
