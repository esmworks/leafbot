import { describe, expect, it } from 'vitest';
import { followTarget, REPLY_MARGIN } from './followReply';

const view = { scrollTop: 0, clientHeight: 600 };

describe('cevabı izleme', () => {
  it('kısa bir cevapta sonu izler', () => {
    // The reply starts at 1000 and the content ends at 1300: the end is 700 down, its start is in view.
    expect(followTarget({ ...view, scrollHeight: 1300, replyTop: 1000, released: false })).toEqual({
      top: 700,
      release: false,
    });
  });

  it('ekrandan uzun cevapta başı üste gelince izlemeyi bırakır', () => {
    const r = followTarget({ ...view, scrollTop: 400, scrollHeight: 2400, replyTop: 1000, released: false });
    expect(r).toEqual({ top: 1000 - REPLY_MARGIN, release: true });
  });

  it('başı zaten daha yukarıdaysa kullanıcının yerinde kalır', () => {
    const r = followTarget({ ...view, scrollTop: 1500, scrollHeight: 2400, replyTop: 1000, released: false });
    expect(r).toEqual({ top: 1500, release: true });
  });

  it('bırakılmış cevapta, kişi sona inince, sonu izler', () => {
    expect(followTarget({ ...view, scrollHeight: 2400, replyTop: 1000, released: true }).top).toBe(1800);
  });

  it('en yeni şey cevap değilse (kişinin kendi mesajı) sona iner', () => {
    expect(followTarget({ ...view, scrollHeight: 2400, replyTop: null, released: false }).top).toBe(1800);
  });
});
