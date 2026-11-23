import { describe, expect, it } from 'vitest';
import { subagentCounts, subagentOf, subagentSeconds, subagentsOf, subagentTime } from './schemas';

describe('alt ajan kartı', () => {
  it('eski kartlar yeni alanlar olmadan da okunur', () => {
    expect(subagentOf({ subagent: { description: 'Tara', state: 'done', steps: 2 } })).toEqual({
      description: 'Tara',
      state: 'done',
      steps: 2,
      tool: null,
      result: null,
      startedAt: null,
      endedAt: null,
    });
  });

  it('süreyi biten kartta bitişe, sürende şu ana kadar sayar', () => {
    const card = subagentOf({
      subagent: { description: '', state: 'running', steps: 0, startedAt: '2026-11-18T10:00:00.000Z' },
    })!;
    expect(subagentSeconds(card, Date.parse('2026-11-18T10:01:30.000Z'))).toBe(90);
    expect(subagentSeconds({ ...card, endedAt: '2026-11-18T10:00:12.400Z' })).toBe(12);
    expect(subagentSeconds(card)).toBeNull();
    expect(subagentSeconds({ ...card, startedAt: null }, Date.now())).toBeNull();
  });

  it('süreyi saniye, bir dakikadan sonra dakika olarak yazar', () => {
    const t = (key: string, vars: { count: number }) =>
      `${key.endsWith('Seconds') ? 's' : 'dk'}:${vars.count}`;
    const card = subagentOf({
      subagent: { description: '', state: 'done', steps: 1, startedAt: '2026-11-18T10:00:00.000Z' },
    })!;
    expect(subagentTime({ ...card, endedAt: '2026-11-18T10:00:59.000Z' }, t)).toBe('s:59');
    expect(subagentTime({ ...card, endedAt: '2026-11-18T10:02:30.000Z' }, t)).toBe('dk:2');
    expect(subagentTime(card, t)).toBeNull();
  });

  it('grup kartını sırasıyla okur; bekleyen durumu tanır, bilinmeyeni çalışıyor sayar', () => {
    const list = subagentsOf({
      subagent: { description: '2 alt görev', state: 'running', steps: 0 },
      subagents: [
        { description: 'A', state: 'waiting', steps: 0 },
        { description: 'B', state: 'yeni-bir-durum', steps: 1 },
        null,
      ],
    })!;
    expect(list.map((s) => [s.description, s.state])).toEqual([
      ['A', 'waiting'],
      ['B', 'running'],
    ]);
    expect(subagentCounts(list)).toEqual({ waiting: 1, running: 1, done: 0, failed: 0, stopped: 0 });
    expect(subagentsOf({ subagent: { description: 'tek', state: 'done', steps: 0 } })).toBeNull();
    expect(subagentsOf({ subagents: [] })).toBeNull();
  });
});
