/**
 * Collects items and hands them over together, once per animation frame: a fast reply would
 * otherwise draw the conversation again for every word. In the background the app gets no frames,
 * so a short timer serves it; in the front the timer is there too in case the frame never comes.
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

/** `hidden` says whether the app is in the background now. */
export function createBatcher<T>(apply: (items: T[]) => void, hidden: () => boolean): Batcher<T> {
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
      waiting = hidden()
        ? { frame: null, timer: setTimeout(flush, HIDDEN_FLUSH_MS) }
        : { frame: requestAnimationFrame(flush), timer: setTimeout(flush, FRAME_FALLBACK_MS) };
    },
    flush,
    cancel() {
      unschedule();
      queue = [];
    },
  };
}
