import { performance } from 'node:perf_hooks';

/**
 * How long each stage of this server's start took, in milliseconds since the process began. A
 * start nobody can time is a start nobody can make faster: the desktop app reads these after the
 * ready line, keeps them beside its own stages and shows where the wait went.
 */
const marks: Record<string, number> = {};
/** Steps measured as a span rather than a point: their own length, not when they ended. */
const spans: Record<string, number> = {};

const now = () => Math.round(performance.now() * 10) / 10;

/** Notes that a stage of the start has been reached now. The first note of a name stays. */
export function launchMark(name: string): void {
  marks[name] ??= now();
}

/** Runs one start-up step and keeps how long it took under `name`. */
export async function launchSpan<T>(name: string, step: () => T | Promise<T>): Promise<T> {
  const from = performance.now();
  try {
    return await step();
  } finally {
    spans[name] = Math.round((performance.now() - from) * 10) / 10;
  }
}

/** What the start has measured so far: stage marks and step lengths. */
export function launchTimings(): { marks: Record<string, number>; spans: Record<string, number> } {
  return { marks: { ...marks }, spans: { ...spans } };
}

/** The line the desktop app reads after the ready line; one line, so it never splits. */
export function launchTimingsLine(): string {
  return `LEAFBOT_TIMINGS ${JSON.stringify(launchTimings())}`;
}
