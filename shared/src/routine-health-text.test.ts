import { describe, expect, it } from 'vitest';
import { askText, findingText, type HealthT } from './routine-health-text';

const t: HealthT = (key, params) => `${key}${params ? ` ${JSON.stringify(params)}` : ''}`;
const usd = (n: number) => `$${n.toFixed(2)}`;

describe('routine health text', () => {
  it('says a finding from its numbers, with the cost of quiet runs when known', () => {
    expect(findingText({ id: 'failing', count: 3 }, t, usd)).toBe('health.finding.failingStreak {"count":3}');
    expect(findingText({ id: 'failing', count: 3, of: 6 }, t, usd)).toContain('health.finding.failing {');
    expect(findingText({ id: 'mostlyQuiet', count: 8, of: 10, costUsd: 0.5 }, t, usd)).toContain('$0.50');
    expect(findingText({ id: 'mostlyQuiet', count: 8, of: 10 }, t, usd)).not.toContain('Cost');
  });

  it('writes a message for the bot only where the bot can help', () => {
    const routine = { name: 'Rapor' };
    expect(askText(routine, { id: 'stepFails', step: 2, count: 3 }, t)).toBe(
      'health.ask.stepFails {"name":"Rapor","step":2}',
    );
    expect(askText(routine, { id: 'signInWait', count: 0 }, t)).toBeNull();
    expect(askText(routine, { id: 'idle', count: 0, enabled: false }, t)).toBeNull();
  });
});
