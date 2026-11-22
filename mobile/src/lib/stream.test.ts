import type { Message } from '@leafbot/shared';
import { describe, expect, it } from 'vitest';
import {
  appendStream,
  dropStream,
  newCardCuts,
  newClientId,
  placeCards,
  streamSaved,
  withPending,
} from './stream';

function msg(over: Partial<Message>): Message {
  return {
    id: 'm1',
    threadId: 't1',
    role: 'assistant',
    author: 'bot:b1',
    text: '',
    props: {},
    clientId: null,
    turnId: null,
    createdAt: '2026-11-15T10:00:00.000Z',
    ...over,
  };
}

describe('stream', () => {
  it('joins pieces of one turn and starts over on a new one', () => {
    let s = appendStream({}, 't1', 'a', 'Mer');
    s = appendStream(s, 't1', 'a', 'haba');
    expect(s.t1).toEqual({ turnId: 'a', text: 'Merhaba' });
    s = appendStream(s, 't1', 'b', 'Yeni');
    expect(s.t1).toEqual({ turnId: 'b', text: 'Yeni' });
  });

  it('replaces the text of a turn whose run started over', () => {
    let s = appendStream({}, 't1', 'a', 'Cut off');
    s = appendStream(s, 't1', 'a', 'Again', true);
    s = appendStream(s, 't1', 'a', ' from the start');
    expect(s.t1).toEqual({ turnId: 'a', text: 'Again from the start' });
  });

  it('drops only the turn it was asked to', () => {
    const s = appendStream({}, 't1', 'b', 'x');
    expect(dropStream(s, 't1', 'a')).toBe(s);
    expect(dropStream(s, 't1', 'b')).toEqual({});
    expect(dropStream(s, 't1')).toEqual({});
    expect(dropStream(s, 't2')).toBe(s);
  });

  it('knows when the saved reply has arrived', () => {
    const stream = { turnId: 'a', text: 'x' };
    expect(streamSaved(stream, [msg({ turnId: 'a', role: 'user' })])).toBe(false);
    expect(streamSaved(stream, [msg({ turnId: 'a' })])).toBe(true);
    expect(streamSaved(undefined, [msg({ turnId: 'a' })])).toBe(false);
  });

  it('shows a sent message once, whichever arrives first', () => {
    const pending = msg({ id: 'local', role: 'user', clientId: 'c1' });
    expect(withPending([], [pending])).toEqual([pending]);
    const saved = msg({ id: 'm2', role: 'user', clientId: 'c1' });
    expect(withPending([saved], [pending])).toEqual([saved]);
  });

  it('makes client ids the server accepts', () => {
    const a = newClientId();
    expect(a.length).toBeGreaterThanOrEqual(8);
    expect(a.length).toBeLessThanOrEqual(64);
    expect(newClientId()).not.toBe(a);
  });
});

describe('cards asked while a reply streams in', () => {
  const card = (id: string, turnId: string | null, approvalId = `a-${id}`) =>
    msg({ id, role: 'approval', turnId, props: { approvalId } });
  const none = new Set<string>();

  it('notes a card of the streaming turn at the text that had arrived', () => {
    const stream = { turnId: 'u1', text: 'Rapor hazır.' };
    expect(newCardCuts([msg({ id: 'r' }), card('q', 'u1')], stream, none, {})).toEqual({ q: 12 });
  });

  it('puts a pending card asked before any text at the start', () => {
    expect(newCardCuts([card('q', 'u1')], undefined, new Set(['a-q']), {})).toEqual({ q: 0 });
    expect(newCardCuts([card('q', 'u2')], { turnId: 'u1', text: 'eski' }, new Set(['a-q']), {})).toEqual({
      q: 0,
    });
  });

  it('keeps the first note and leaves answered or turnless cards alone', () => {
    const stream = { turnId: 'u1', text: 'Daha uzun bir metin' };
    expect(newCardCuts([card('q', 'u1')], stream, none, { q: 4 })).toEqual({});
    expect(newCardCuts([card('old', 'u0'), card('free', null)], stream, new Set(['a-free']), {})).toEqual({});
  });

  it('takes the streaming turn’s noted cards out of the list and gives the last point', () => {
    const rows = [msg({ id: 'u', role: 'user' }), card('q1', 'u1'), card('q2', 'u1'), card('o', 'u0')];
    const placed = placeCards(rows, 'u1', { q1: 3, q2: 8, o: 0 });
    expect(placed.messages.map((m) => m.id)).toEqual(['u', 'o']);
    expect(placed.cards.map((c) => [c.card.id, c.at])).toEqual([
      ['q1', 3],
      ['q2', 8],
    ]);
    expect(placed.end).toBe(8);
  });

  it('leaves the list as it is when nothing streams or no card is noted', () => {
    const rows = [card('q', 'u1')];
    expect(placeCards(rows, null, { q: 3 })).toEqual({ messages: rows, cards: [], end: 0 });
    expect(placeCards(rows, 'u1', {})).toEqual({ messages: rows, cards: [], end: 0 });
  });
});
