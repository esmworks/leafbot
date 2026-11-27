import { describe, expect, it } from 'vitest';
import { END_MARGIN, followsEnd, keyIntent, READER_INPUT_MS } from './readerScroll';

const at = { following: true, moved: 0, fromEnd: 0, intent: null, dragging: false, now: 1000 };

describe('sohbetin sonunu izleme', () => {
  it('yukarıya çizilen satırlar sohbeti sondan uzaklaştırınca izlemeyi bırakmaz', () => {
    expect(followsEnd({ ...at, fromEnd: 2500 })).toBe(true);
  });

  it('sohbetin kendi kaydırması geç bildirilse de izlemeyi bırakmaz', () => {
    expect(followsEnd({ ...at, moved: -300, fromEnd: 2500 })).toBe(true);
  });

  it('kişi tekerlekle yukarı kaydırınca izlemeyi bırakır', () => {
    expect(followsEnd({ ...at, moved: -40, fromEnd: 40, intent: { up: true, at: 950 } })).toBe(false);
  });

  it('kaydırma çubuğunu yukarı sürükleyince izlemeyi bırakır', () => {
    expect(followsEnd({ ...at, moved: -40, fromEnd: 300, dragging: true })).toBe(false);
  });

  it('eski bir tekerlek hareketi sonraki kaydırmayı kişinin saymaz', () => {
    const intent = { up: true, at: 1000 - READER_INPUT_MS - 1 };
    expect(followsEnd({ ...at, moved: -40, fromEnd: 300, intent })).toBe(true);
  });

  it('bırakılmışken kişi sona inince yeniden izler', () => {
    const intent = { up: false, at: 990 };
    expect(followsEnd({ ...at, following: false, moved: 200, fromEnd: END_MARGIN - 1, intent })).toBe(true);
  });

  it('bırakılmışken sondan uzakta kalır', () => {
    expect(followsEnd({ ...at, following: false, moved: 0, fromEnd: 900 })).toBe(false);
  });

  it('tuşların kaydırma yönü', () => {
    expect(keyIntent('PageUp', false)).toBe(true);
    expect(keyIntent('End', false)).toBe(false);
    expect(keyIntent(' ', true)).toBe(true);
    expect(keyIntent('a', false)).toBeNull();
  });
});
