import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));

describe('color tone', () => {
  beforeEach(() => {
    vi.resetModules();
    localStorage.clear();
    delete document.documentElement.dataset.tone;
  });

  it('is neutral at first and marks nothing on the page', async () => {
    const { useTheme } = await import('./theme');
    expect(useTheme.getState().tone).toBe('neutral');
    expect(document.documentElement.dataset.tone).toBeUndefined();
  });

  it('marks the page with the tone picked and keeps it on this device', async () => {
    const { useTheme } = await import('./theme');
    useTheme.getState().setTone('slate');
    expect(document.documentElement.dataset.tone).toBe('slate');
    expect(localStorage.getItem('leafbot.tone')).toBe('slate');
    useTheme.getState().setTone('neutral');
    expect(document.documentElement.dataset.tone).toBeUndefined();
  });

  it('takes the saved tone at start and ignores one it does not know', async () => {
    localStorage.setItem('leafbot.tone', 'leaf');
    expect((await import('./theme')).useTheme.getState().tone).toBe('leaf');
    vi.resetModules();
    localStorage.setItem('leafbot.tone', 'purple');
    expect((await import('./theme')).useTheme.getState().tone).toBe('neutral');
  });
});
