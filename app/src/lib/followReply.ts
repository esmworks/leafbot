/** How far under the top of the conversation the start of a reply is kept: the bar over it. */
export const REPLY_MARGIN = 80;

/**
 * Where the conversation scrolls to follow the end of a growing reply, without pushing its start
 * out of view: a reply taller than the screen is followed only until its first line reaches the
 * top, and the person reads on from there. `replyTop` is the reply's offset from the top of the
 * scrollable content, null when the newest thing is not a reply; `released` is a reply that was
 * already let go of (or was there before the conversation opened), which goes back to ordinary
 * following if the person scrolls to the end themselves.
 */
export function followTarget(v: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
  replyTop: number | null;
  released: boolean;
}): { top: number; release: boolean } {
  const bottom = Math.max(0, v.scrollHeight - v.clientHeight);
  if (v.replyTop === null || v.released) return { top: bottom, release: false };
  const start = Math.max(0, v.replyTop - REPLY_MARGIN);
  // The start is already further up than that: stay where the person is.
  if (start < bottom) return { top: Math.max(v.scrollTop, start), release: true };
  return { top: bottom, release: false };
}
