import { describe, expect, it } from 'vitest';
import { DISPLAY_QUIET_MS, DisplayHold, keepDisplayOn } from './display-awake';

describe('ekranın açık tutulması', () => {
  it('bir bot Mac’i kullanırken ve hemen sonrasında açık tutar', () => {
    expect(keepDisplayOn(0)).toBe(true);
    expect(keepDisplayOn(DISPLAY_QUIET_MS - 1)).toBe(true);
  });

  it('sessiz süre dolunca ya da hiç kullanılmadıysa bırakır', () => {
    expect(keepDisplayOn(DISPLAY_QUIET_MS)).toBe(false);
    expect(keepDisplayOn(null)).toBe(false);
    expect(keepDisplayOn(undefined)).toBe(false);
    expect(keepDisplayOn(Number.NaN)).toBe(false);
  });
});

describe('ekranı açık tutma nedenleri', () => {
  const hold = () => {
    const log: string[] = [];
    let next = 0;
    const h = new DisplayHold(
      () => {
        log.push('start');
        return ++next;
      },
      (id) => log.push(`stop ${id}`),
    );
    return { h, log };
  };

  it('bu bilgisayarın sunucusu boşta dese de, Mac’i kullanan uzak bot varken ekran açık kalır', () => {
    const { h, log } = hold();
    h.set('mac', true);
    h.set('local', false);
    expect(h.held).toBe(true);
    h.set('local', true);
    h.set('local', false);
    expect(log).toEqual(['start']);
    h.set('mac', false);
    expect(h.held).toBe(false);
    expect(log).toEqual(['start', 'stop 1']);
  });

  it('kilit bir kez alınır, iki neden de bitince bir kez bırakılır', () => {
    const { h, log } = hold();
    h.set('local', true);
    h.set('mac', true);
    h.set('local', false);
    h.set('mac', false);
    h.set('mac', false);
    expect(log).toEqual(['start', 'stop 1']);
  });
});
