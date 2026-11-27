import { useEffect, useState } from 'react';

/** The rows drawn when a conversation opens: enough to fill the screen at its end. */
export const LATEST_FIRST = 10;
/** The earlier rows drawn in each frame after that, so none of them holds up the page. */
export const EARLIER_PER_FRAME = 10;

/** The rows left out at first when a conversation of `count` rows opens. */
export const firstSkip = (count: number) => Math.max(0, count - LATEST_FIRST);
/** The rows still left out after one more frame. */
export const nextSkip = (skip: number) => Math.max(0, skip - EARLIER_PER_FRAME);

/**
 * How many of a conversation's first rows to leave out for now. It opens showing its latest rows,
 * which is what the person reads first, and the earlier ones are drawn above them a few each
 * frame. Rows that come later, new ones or older pages, are drawn at once. With `all` (a message
 * to bring into view, an older page on its way) every row is drawn now.
 */
export function useLatestFirst(count: number, all: boolean): number {
  const [skip, setSkip] = useState<number | null>(null);
  // Set while drawing, as the rows first arrive: a frame drawn with them all first would be lost.
  if (skip === null && count > 0) setSkip(firstSkip(count));
  // Once every row was needed they stay drawn.
  else if (all && skip) setSkip(0);
  const left = all ? 0 : (skip ?? 0);
  useEffect(() => {
    if (!skip || all) return;
    const frame = requestAnimationFrame(() => setSkip((s) => nextSkip(s ?? 0)));
    return () => cancelAnimationFrame(frame);
  }, [skip, all]);
  return left;
}
