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

/** Where the person left the end of the conversation: the time of its latest message then. */
export const awayMark = (messages: readonly Message[]) => messages.at(-1)?.createdAt ?? '';

/**
 * The replies that came after the person left the end. Counted by time, not by place in the
 * list: an older page loaded above since then holds no reply the person has not seen.
 */
export const repliesSince = (messages: readonly Message[], mark: string) =>
  messages.filter((m) => m.createdAt > mark && m.author !== 'user').length;

/**
 * The first reply the person had not seen when the conversation opened, marked with a line above
 * it. When every message on screen came after `readUntil` and older ones are not loaded yet, that
 * reply is further back: a line here would call the messages above it read, so there is none.
 */
export function firstNewReply(
  messages: readonly Message[],
  readUntil: string | null | undefined,
  hasOlder: boolean,
): string | null {
  if (readUntil == null) return null;
  const first = messages[0];
  if (hasOlder && first && first.createdAt > readUntil) return null;
  return messages.find((m, i) => i > 0 && m.role === 'assistant' && m.createdAt > readUntil)?.id ?? null;
}
