import { describe, expect, it } from 'vitest';
import { addPiece, hasGap, seedStream, streamEnded } from './live-stream';

describe('live stream', () => {
  it('joins the pieces of one turn in order', () => {
    let s = addPiece(undefined, 'a', { text: 'Mer', at: 0 });
    s = addPiece(s, 'a', { text: 'haba', at: 3 });
    expect(s).toEqual({ turnId: 'a', text: 'Merhaba' });
  });

  it('starts over for another turn and for a run that restarted', () => {
    const s = addPiece({ turnId: 'a', text: 'eski' }, 'b', { text: 'yeni', at: 0 });
    expect(s).toEqual({ turnId: 'b', text: 'yeni' });
    expect(addPiece(s, 'b', { text: 'baştan', restart: true })).toEqual({ turnId: 'b', text: 'baştan' });
  });

  it('adds a piece seen twice only once', () => {
    const s = { turnId: 'a', text: 'Merhaba' };
    expect(addPiece(s, 'a', { text: 'haba', at: 3 })).toBe(s);
    expect(addPiece(s, 'a', { text: 'haba dünya', at: 3 })).toEqual({ turnId: 'a', text: 'Merhaba dünya' });
  });

  it('notices a gap instead of gluing a later piece on', () => {
    // A page opened mid-reply, or a socket that was down for a while.
    let s = addPiece(undefined, 'a', { text: ' dünya', at: 7 });
    expect(hasGap(s)).toBe(true);
    expect(s.text).toBe('');
    s = addPiece(s, 'a', { text: '!', at: 13 });
    // The text before the gap comes from the server; what came meanwhile follows it.
    s = seedStream(s, { turnId: 'a', text: 'Merhaba' });
    expect(s).toEqual({ turnId: 'a', text: 'Merhaba dünya!' });
    expect(hasGap(s)).toBe(false);
  });

  it('keeps a gap open when the fetched text is still short of the pieces', () => {
    let s = addPiece({ turnId: 'a', text: 'Mer' }, 'a', { text: 'dünya', at: 8 });
    s = seedStream(s, { turnId: 'a', text: 'Merhaba' });
    expect(hasGap(s)).toBe(true);
    expect(s.text).toBe('Merhaba');
  });

  it('keeps text longer than what was fetched', () => {
    const s = { turnId: 'a', text: 'Merhaba dünya' };
    expect(seedStream(s, { turnId: 'a', text: 'Merhaba' })).toBe(s);
    expect(seedStream(s, { turnId: 'b', text: 'Yeni' })).toEqual({ turnId: 'b', text: 'Yeni' });
  });

  it('takes pieces from an older server that says nothing of where they go', () => {
    let s = addPiece(undefined, 'a', { text: 'Mer' });
    s = addPiece(s, 'a', { text: 'haba' });
    expect(s).toEqual({ turnId: 'a', text: 'Merhaba' });
  });
});

describe('stream ended', () => {
  it('ends when another turn runs, even with no rest in between', () => {
    expect(streamEnded('a', { state: 'running', turnId: 'b' })).toBe(true);
    expect(streamEnded('a', { state: 'queued', turnId: null })).toBe(true);
  });

  it('goes on while its own turn runs or waits on a card', () => {
    expect(streamEnded('a', { state: 'running', turnId: 'a' })).toBe(false);
    expect(streamEnded('a', { state: 'waiting', turnId: 'a' })).toBe(false);
  });

  it('ends only at rest with an older server that names no turn', () => {
    expect(streamEnded('a', { state: 'running' })).toBe(false);
    expect(streamEnded('a', { state: 'idle' })).toBe(true);
  });
});
