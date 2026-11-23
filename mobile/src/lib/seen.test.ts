import { describe, expect, it, vi } from 'vitest';

vi.mock('@react-native-async-storage/async-storage', () => ({ default: {} }));

const { isUnread, markRead, nextSeen, unreadBots } = await import('./seen');

describe('seen', () => {
  it('marks a bot unread only after a reply the person has not seen', () => {
    const s = { botId: 'b1', repliedAt: '2026-11-15T10:00:00.000Z' };
    expect(isUnread(s, null)).toBe(false);
    expect(isUnread(s, {})).toBe(true);
    expect(isUnread(s, { b1: '2026-11-15T10:00:00.000Z' })).toBe(false);
    expect(isUnread(s, { b1: '2026-11-15T09:00:00.000Z' })).toBe(true);
    expect(isUnread({ botId: 'b1', repliedAt: null }, {})).toBe(false);
  });

  it('takes the first list as read and forgets bots that are gone', () => {
    const list = [
      { botId: 'b1', repliedAt: 'x' },
      { botId: 'b2', repliedAt: null },
    ];
    expect(nextSeen(null, list)).toEqual({ b1: 'x', b2: '' });
    expect(nextSeen({ b1: 'a', b3: 'c' }, list)).toEqual({ b1: 'a' });
    const same = { b1: 'a' };
    expect(nextSeen(same, list)).toBe(same);
  });

  it('only moves a mark forward', () => {
    const seen = { b1: 'b' };
    expect(markRead(seen, 'b1', 'a')).toBe(seen);
    expect(markRead(seen, 'b1', 'c')).toEqual({ b1: 'c' });
    expect(markRead(seen, 'b2', 'a')).toEqual({ b1: 'b', b2: 'a' });
  });

  it('counts the bots with unread replies for the icon', () => {
    const list = [
      { botId: 'b1', repliedAt: 'b' },
      { botId: 'b2', repliedAt: 'a' },
      { botId: 'b3', repliedAt: null },
    ];
    expect(unreadBots(list, null)).toEqual([]);
    expect(unreadBots(list, { b1: 'a', b2: 'a' })).toEqual(['b1']);
    expect(unreadBots(list, {})).toEqual(['b1', 'b2']);
  });
});
