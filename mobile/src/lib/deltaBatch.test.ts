import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBatcher } from './deltaBatch';
import { appendPieces } from './stream';

describe('delta batching', () => {
  let frame: (() => void) | null;
  beforeEach(() => {
    vi.useFakeTimers();
    frame = null;
    vi.stubGlobal('requestAnimationFrame', (cb: () => void) => {
      frame = cb;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {
      frame = null;
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hands over the words of one frame together, in order', () => {
    const got: string[][] = [];
    const b = createBatcher<string>(
      (items) => got.push(items),
      () => false,
    );
    for (const w of ['Mer', 'ha', 'ba']) b.push(w);
    expect(got).toEqual([]);
    frame?.();
    expect(got).toEqual([['Mer', 'ha', 'ba']]);
  });

  it('serves the app in the background, which gets no frames, by a short timer', () => {
    const got: string[][] = [];
    const b = createBatcher<string>(
      (items) => got.push(items),
      () => true,
    );
    b.push('arka plan');
    vi.advanceTimersByTime(60);
    expect(got).toEqual([['arka plan']]);
  });

  it('hands them over even when the frame never comes', () => {
    const got: string[][] = [];
    const b = createBatcher<string>(
      (items) => got.push(items),
      () => false,
    );
    b.push('gizlendi');
    vi.advanceTimersByTime(120);
    expect(frame).toBeNull();
    expect(got).toEqual([['gizlendi']]);
  });

  it('flushes at once for an event that must not overtake the words, and forgets on cancel', () => {
    const got: string[][] = [];
    const b = createBatcher<string>(
      (items) => got.push(items),
      () => false,
    );
    b.push('son söz');
    b.flush();
    expect(got).toEqual([['son söz']]);
    b.push('gitti');
    b.cancel();
    vi.advanceTimersByTime(200);
    expect(got).toEqual([['son söz']]);
  });
});

describe('appendPieces', () => {
  it('gives the same text as adding the pieces one by one', () => {
    const { streams, gaps } = appendPieces({}, [
      { threadId: 't1', turnId: 'a', text: 'Mer' },
      { threadId: 't1', turnId: 'a', text: 'haba' },
      { threadId: 't2', turnId: 'b', text: 'Selam' },
    ]);
    expect(streams.t1).toMatchObject({ turnId: 'a', text: 'Merhaba' });
    expect(streams.t2).toMatchObject({ turnId: 'b', text: 'Selam' });
    expect(gaps).toEqual([]);
  });

  it('starts over on a restart within the frame', () => {
    const { streams } = appendPieces({}, [
      { threadId: 't1', turnId: 'a', text: 'eski' },
      { threadId: 't1', turnId: 'a', text: 'yeni', restart: true },
    ]);
    expect(streams.t1).toMatchObject({ text: 'yeni' });
  });

  it('names a conversation whose piece came after missing words', () => {
    const { gaps } = appendPieces({}, [{ threadId: 't1', turnId: 'a', text: 'geç geldi', at: 40 }]);
    expect(gaps).toEqual(['t1']);
  });
});
