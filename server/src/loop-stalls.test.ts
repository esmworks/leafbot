import { describe, expect, it } from 'vitest';
import { stallLine, watchLoopStalls } from './loop-stalls';

describe('event loop stalls', () => {
  it('says nothing for a minute of short delays', () => {
    expect(stallLine({ maxMs: 40, p99Ms: 21, meanMs: 20.2 })).toBeNull();
  });

  it('says how long the loop was held up', () => {
    expect(stallLine({ maxMs: 812.4, p99Ms: 33, meanMs: 20.71 })).toBe(
      'event loop held up: longest 812 ms, 99% under 33 ms, mean 20.7 ms in the last minute',
    );
  });

  it('starts and stops without keeping the process alive', () => {
    const stop = watchLoopStalls(() => {});
    expect(typeof stop).toBe('function');
    stop();
  });
});
