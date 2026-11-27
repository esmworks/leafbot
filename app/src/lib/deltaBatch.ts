/**
 * Collects items and hands them over together, once per animation frame: a fast stream would
 * otherwise redraw the screen for every token. A hidden tab gets no frames, so it is served by a
 * short timer; a visible one has the timer as well in case the frame never comes.
 */
export const HIDDEN_FLUSH_MS = 50;
const FRAME_FALLBACK_MS = 100;

export interface Batcher<T> {
  push(item: T): void;
  /** Hands over what is waiting now; used before an event that must not overtake it. */
  flush(): void;
  /** Forgets what is waiting. */
  cancel(): void;
}

export function createBatcher<T>(apply: (items: T[]) => void): Batcher<T> {
  let queue: T[] = [];
  let waiting: { frame: number | null; timer: ReturnType<typeof setTimeout> } | null = null;

  const unschedule = () => {
    if (!waiting) return;
    if (waiting.frame !== null) cancelAnimationFrame(waiting.frame);
    clearTimeout(waiting.timer);
    waiting = null;
  };
  const flush = () => {
    unschedule();
    if (!queue.length) return;
    const items = queue;
    queue = [];
    apply(items);
  };
  return {
    push(item) {
      queue.push(item);
      if (waiting) return;
      if (document.hidden) {
        waiting = { frame: null, timer: setTimeout(flush, HIDDEN_FLUSH_MS) };
      } else {
        waiting = { frame: requestAnimationFrame(flush), timer: setTimeout(flush, FRAME_FALLBACK_MS) };
      }
    },
    flush,
    cancel() {
      unschedule();
      queue = [];
    },
  };
}
