import type { Message } from '@leafbot/shared';

/** A message's Markdown as one plain line, so a quote of it reads like the text the person saw. */
function plainText(markdown: string): string {
  return markdown
    .replace(/^```.*$/gm, '')
    .replace(/^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/gm, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+[.)]\s+)/gm, '')
    .replace(/\s*\|\s*/g, ' ')
    .replace(/(\*\*|__|\*|_|~~|`)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The start of a message as plain text, cut on a word at about `max` letters. */
export function excerpt(markdown: string, max = 160): string {
  const text = plainText(markdown);
  if (text.length <= max) return text;
  // Never half of an emoji or another character outside the basic plane.
  const cut = text.slice(0, /[\uD800-\uDBFF]/.test(text[max - 1] ?? '') ? max - 1 : max);
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** What the reply chip and the quote on the sent message say about the message answered. */
export function replyExcerpt(m: Message): string {
  const files = Array.isArray(m.props.files) ? (m.props.files as { name?: string }[]) : [];
  return excerpt(m.text || files.map((f) => f.name ?? '').join(', '));
}

/** The address that opens one conversation in the web app of this server. */
export function threadLink(origin: string, threadId: string): string {
  return `${origin.replace(/\/+$/, '')}/?thread=${encodeURIComponent(threadId)}`;
}

/** Emoji a person can mark a conversation with, to find it again at a glance. */
export const THREAD_ICONS = ['📌', '💼', '🏠', '💡', '📊', '🧾', '✈️', '🛒', '📚', '🔧', '❤️', '⭐'];
