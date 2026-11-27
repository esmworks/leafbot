/** How close to the end the conversation counts as being at its end. */
export const END_MARGIN = 80;
/** How long after a wheel turn, a swipe or a key the scrolling that follows counts as the person's. */
export const READER_INPUT_MS = 250;

/** Which way the person last asked the conversation to scroll, and when. */
export interface ReaderIntent {
  up: boolean;
  at: number;
}

/**
 * Whether the conversation keeps following its end after it scrolled. A scroll the conversation
 * made itself does not let go of the end: rows drawn above the place on screen move it away from
 * the end in a browser that does not hold it there (Safari), and the scroll the conversation made
 * to reach the end is reported only after that, so counting it opened conversations mid-way and
 * stopped following replies. The person scrolling up (a wheel turn, a swipe, a key, the scroll
 * bar) lets go, and so does any other scroll that ends away from the end (focus moved there with
 * Tab, a screen reader, autoscroll). Being back at the end, other than by scrolling up, follows
 * it again.
 */
export function followsEnd(v: {
  following: boolean;
  /** How far the conversation moved since the last scroll; up is negative. */
  moved: number;
  fromEnd: number;
  intent: ReaderIntent | null;
  dragging: boolean;
  /** Whether the conversation stands where it last put itself, so the scroll was its own. */
  self: boolean;
  now: number;
}): boolean {
  const asked = v.intent !== null && v.now - v.intent.at < READER_INPUT_MS;
  const readerUp = v.moved < 0 && (v.dragging || (asked && v.intent!.up));
  if (readerUp) return false;
  if (v.fromEnd < END_MARGIN) return true;
  if (!asked && !v.dragging && !v.self) return false;
  return v.following;
}

/** The way a key scrolls the conversation, or null for a key that does not. */
export function keyIntent(key: string, shift: boolean): boolean | null {
  if (key === 'ArrowUp' || key === 'PageUp' || key === 'Home') return true;
  if (key === 'ArrowDown' || key === 'PageDown' || key === 'End') return false;
  if (key === ' ') return shift;
  return null;
}
