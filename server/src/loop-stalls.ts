import { monitorEventLoopDelay } from 'node:perf_hooks';

type Histogram = ReturnType<typeof monitorEventLoopDelay>;

/**
 * Warns in the log when the server's event loop was held up: while it is, no request, socket
 * event or streamed word moves, and the app feels frozen with nothing to say why. One line a
 * minute at most, only when something held it longer than STALL_MS, with how often and how long.
 */
export const STALL_MS = 250;
const EVERY_MS = 60_000;

export interface StallSummary {
  maxMs: number;
  p99Ms: number;
  meanMs: number;
}

/** The line to log for a minute's delays, or null when nothing held the loop up for long. */
export function stallLine(s: StallSummary, stallMs = STALL_MS): string | null {
  if (s.maxMs < stallMs) return null;
  return `event loop held up: longest ${Math.round(s.maxMs)} ms, 99% under ${Math.round(s.p99Ms)} ms, mean ${s.meanMs.toFixed(1)} ms in the last minute`;
}

const summary = (h: Histogram): StallSummary => ({
  maxMs: h.max / 1e6,
  p99Ms: h.percentile(99) / 1e6,
  meanMs: h.mean / 1e6,
});

/** Starts watching; returns the function that stops it. */
export function watchLoopStalls(warn: (line: string) => void = console.warn): () => void {
  const h = monitorEventLoopDelay({ resolution: 20 });
  h.enable();
  const timer = setInterval(() => {
    const line = stallLine(summary(h));
    if (line) warn(line);
    h.reset();
  }, EVERY_MS);
  timer.unref();
  return () => {
    clearInterval(timer);
    h.disable();
  };
}
