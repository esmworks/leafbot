import { describe, expect, it } from 'vitest';
import { launchMark, launchSpan, launchTimings, launchTimingsLine } from './launch-timings';

describe('launch timings', () => {
  it('keeps the first mark of a name and the length of each step', async () => {
    launchMark('a');
    const first = launchTimings().marks.a;
    launchMark('a');
    expect(launchTimings().marks.a).toBe(first);
    await launchSpan('step', () => new Promise((r) => setTimeout(r, 5)));
    expect(launchTimings().spans.step).toBeGreaterThanOrEqual(4);
  });

  it('times a step that fails, and lets the failure through', async () => {
    await expect(launchSpan('broken', () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(launchTimings().spans.broken).toBeGreaterThanOrEqual(0);
  });

  it('prints one line the desktop app can read back', () => {
    const line = launchTimingsLine();
    expect(line.startsWith('LEAFBOT_TIMINGS ')).toBe(true);
    expect(JSON.parse(line.slice('LEAFBOT_TIMINGS '.length))).toEqual(launchTimings());
  });
});
