import { describe, expect, it } from 'vitest';
import { reopens, STEADY_MS } from './reopen';

describe('reopens', () => {
  it('opens again a tunnel that worked and then dropped', () => {
    expect(reopens('closed', STEADY_MS)).toBe(true);
    expect(reopens('timeout', STEADY_MS + 1)).toBe(true);
  });

  it('waits for the person after a refusal or a tunnel that keeps dropping', () => {
    expect(reopens('access', STEADY_MS * 10)).toBe(false);
    expect(reopens('revoked', STEADY_MS * 10)).toBe(false);
    expect(reopens('closed', STEADY_MS - 1)).toBe(false);
  });
});
