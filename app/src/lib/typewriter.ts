import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/** Slowest reveal speed, in characters per second. */
const MIN_RATE = 45;
/** Any backlog is revealed within roughly this many milliseconds. */
const CATCH_UP_MS = 600;

/**
 * Characters revealed so far, per turn. Kept outside components so that when the live stream card is
 * replaced by the saved message, the text carries on from where it was instead of jumping or restarting.
 */
const progress = new Map<string, number>();

/** Moves a cut point past a high surrogate so an emoji is never split in half. */
function safeCut(text: string, n: number): number {
  if (n <= 0 || n >= text.length) return Math.max(0, Math.min(n, text.length));
  const c = text.charCodeAt(n - 1);
  return c >= 0xd800 && c <= 0xdbff ? n + 1 : n;
}

/**
 * Reveals text letter by letter. While `live`, the text is still streaming in. Otherwise the text is shown
 * at once, unless this turn was already being revealed, in which case it finishes from where it was.
 */
export function useTypewriter(text: string, key: string | null | undefined, live = false): string {
  const animate = !!key && (live || progress.has(key));
  const [shown, setShown] = useState(() =>
    animate ? Math.min(progress.get(key!) ?? 0, text.length) : text.length,
  );
  const latest = useRef(text);
  useLayoutEffect(() => {
    latest.current = text;
  }, [text]);

  useEffect(() => {
    if (!animate || !key) return;
    let raf = 0;
    let last = performance.now();
    let pos = progress.get(key) ?? 0;
    let carry = 0;
    const tick = (now: number) => {
      // Started over from outside (`restartTyping`): the text now begins anew.
      if (pos > 0 && !progress.has(key)) {
        pos = 0;
        setShown(0);
      }
      const target = latest.current.length;
      const dt = Math.min(now - last, 100);
      last = now;
      const backlog = target - pos;
      if (backlog > 0) {
        const rate = Math.max(MIN_RATE, (backlog * 1000) / CATCH_UP_MS);
        carry += (rate * dt) / 1000;
        const step = Math.floor(carry);
        if (step > 0) {
          carry -= step;
          pos = safeCut(latest.current, Math.min(target, pos + step));
          progress.set(key, pos);
          setShown(pos);
        }
      } else if (pos > target) {
        pos = target;
        setShown(pos);
      }
      if (!live && pos >= target) {
        progress.delete(key);
        return;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate, key, live]);

  return animate ? text.slice(0, shown) : text;
}

/** Starts the reveal of a turn over, for text that now begins after a card instead of at the top. */
export function restartTyping(key: string) {
  progress.delete(key);
}
