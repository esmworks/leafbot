import { describe, expect, it } from 'vitest';
import { MAX_REOPENS, reopenDelay, SETTLED_MS, STEADY_MS } from './reopen';

describe('reopenDelay', () => {
  it('opens again a tunnel that worked and then dropped, waiting longer each time', () => {
    expect(reopenDelay('closed', STEADY_MS, 0)).toBe(1_000);
    expect(reopenDelay('timeout', STEADY_MS, 1)).toBe(2_000);
    expect(reopenDelay('closed', STEADY_MS, 2)).toBe(4_000);
  });

  it('stops after a few tries in a row, and starts over after a tunnel that stayed up', () => {
    expect(reopenDelay('closed', STEADY_MS, MAX_REOPENS)).toBeNull();
    expect(reopenDelay('closed', SETTLED_MS, MAX_REOPENS)).toBe(1_000);
  });

  it('waits for the person after a refusal or a tunnel that dropped at once', () => {
    expect(reopenDelay('access', SETTLED_MS, 0)).toBeNull();
    expect(reopenDelay('revoked', SETTLED_MS, 0)).toBeNull();
    expect(reopenDelay('closed', STEADY_MS - 1, 0)).toBeNull();
  });
});
