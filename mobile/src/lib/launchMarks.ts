/**
 * How long the first screens took on this launch, written to the development log only: kept data
 * in the cache, the tunnel open, the live channel's hello. Each step is noted once a launch.
 */
const start = Date.now();
const noted = new Set<string>();

export function launchMark(step: string): void {
  if (!__DEV__ || noted.has(step)) return;
  noted.add(step);
  console.log(`[launch] ${step} +${Date.now() - start} ms`);
}
