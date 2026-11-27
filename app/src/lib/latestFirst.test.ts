import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EARLIER_PER_FRAME, firstSkip, LATEST_FIRST, nextSkip, useLatestFirst } from './latestFirst';

describe('önce en yeni satırlar', () => {
  beforeEach(() => vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] }));
  afterEach(() => vi.useRealTimers());

  it('kısa sohbet hepsiyle açılır', () => {
    expect(firstSkip(LATEST_FIRST)).toBe(0);
  });

  it('uzun sohbet son satırlarıyla açılır, öncekiler karelerle gelir', () => {
    expect(firstSkip(50)).toBe(50 - LATEST_FIRST);
    expect(nextSkip(5)).toBe(0);
    const { result } = renderHook(() => useLatestFirst(50, false));
    expect(result.current).toBe(50 - LATEST_FIRST);
    act(() => void vi.advanceTimersToNextFrame());
    expect(result.current).toBe(50 - LATEST_FIRST - EARLIER_PER_FRAME);
    for (let i = 0; i < 10; i++) act(() => void vi.advanceTimersToNextFrame());
    expect(result.current).toBe(0);
  });

  it('getirilecek bir mesaj varken hepsi hemen çizilir', () => {
    const { result, rerender } = renderHook(({ all }) => useLatestFirst(50, all), {
      initialProps: { all: false },
    });
    expect(result.current).toBeGreaterThan(0);
    rerender({ all: true });
    expect(result.current).toBe(0);
  });

  it('satırlar sonradan gelince açılışta yine son satırlar önce çizilir', () => {
    const { result, rerender } = renderHook(({ count }) => useLatestFirst(count, false), {
      initialProps: { count: 0 },
    });
    expect(result.current).toBe(0);
    rerender({ count: 40 });
    expect(result.current).toBe(40 - LATEST_FIRST);
  });

  it('bitince sonradan eklenen satırlar hemen çizilir', () => {
    const { result, rerender } = renderHook(({ count }) => useLatestFirst(count, false), {
      initialProps: { count: 5 },
    });
    expect(result.current).toBe(0);
    rerender({ count: 100 });
    expect(result.current).toBe(0);
  });
});
