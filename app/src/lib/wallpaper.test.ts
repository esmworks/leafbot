import { beforeEach, describe, expect, it, vi } from 'vitest';

async function load() {
  vi.resetModules();
  return import('./wallpaper');
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.removeAttribute('data-wallpaper');
  document.documentElement.removeAttribute('data-wallpaper-sharp');
  document.documentElement.removeAttribute('data-wallpaper-solid');
  document.documentElement.style.removeProperty('--wallpaper-dim');
});

describe('clampDim', () => {
  it('keeps the dimming inside the range that leaves text readable', async () => {
    const { clampDim, DIM_DEFAULT, DIM_MAX, DIM_MIN } = await load();
    expect(clampDim(30)).toBe(30);
    expect(clampDim('55')).toBe(55);
    expect(clampDim(-10)).toBe(DIM_MIN);
    expect(clampDim(100)).toBe(DIM_MAX);
    expect(clampDim(42.6)).toBe(43);
    expect(clampDim('lots')).toBe(DIM_DEFAULT);
    expect(clampDim(undefined)).toBe(DIM_DEFAULT);
    expect(clampDim(Number.NaN)).toBe(DIM_DEFAULT);
  });
});

describe('fitSize', () => {
  it('scales a large photo down to the long edge and keeps its shape', async () => {
    const { fitSize, LONG_EDGE } = await load();
    expect(fitSize(4032, 3024)).toEqual({ width: LONG_EDGE, height: 1920 });
    expect(fitSize(3024, 4032)).toEqual({ width: 1920, height: LONG_EDGE });
  });

  it('leaves a picture that already fits as it is', async () => {
    const { fitSize } = await load();
    expect(fitSize(1280, 720)).toEqual({ width: 1280, height: 720 });
  });
});

describe('useWallpaper', () => {
  it('starts with no picture and the default dimming', async () => {
    const { useWallpaper, DIM_DEFAULT } = await load();
    expect(useWallpaper.getState().url).toBeNull();
    expect(useWallpaper.getState().dim).toBe(DIM_DEFAULT);
    expect(document.documentElement.hasAttribute('data-wallpaper')).toBe(false);
    expect(document.documentElement.style.getPropertyValue('--wallpaper-dim')).toBe(`${DIM_DEFAULT}%`);
  });

  it('keeps the dimming on this device and applies it', async () => {
    const first = await load();
    first.useWallpaper.getState().setDim(70);
    expect(first.useWallpaper.getState().dim).toBe(70);
    expect(document.documentElement.style.getPropertyValue('--wallpaper-dim')).toBe('70%');
    const again = await load();
    expect(again.useWallpaper.getState().dim).toBe(70);
  });

  it('falls back to the default for a stored value it does not understand', async () => {
    localStorage.setItem('leafbot.wallpaper.dim', 'dark');
    const { useWallpaper, DIM_DEFAULT } = await load();
    expect(useWallpaper.getState().dim).toBe(DIM_DEFAULT);
  });

  it("blurs the picture and frosts the person's own bubbles until told otherwise", async () => {
    const { useWallpaper } = await load();
    expect(useWallpaper.getState().blur).toBe(true);
    expect(useWallpaper.getState().ownBubble).toBe('glass');
    expect(document.documentElement.hasAttribute('data-wallpaper-sharp')).toBe(false);
    expect(document.documentElement.hasAttribute('data-wallpaper-solid')).toBe(false);
  });

  it('keeps blur and the bubble choice on this device and applies them', async () => {
    const first = await load();
    first.useWallpaper.getState().setBlur(false);
    first.useWallpaper.getState().setOwnBubble('solid');
    expect(document.documentElement.hasAttribute('data-wallpaper-sharp')).toBe(true);
    expect(document.documentElement.hasAttribute('data-wallpaper-solid')).toBe(true);
    document.documentElement.removeAttribute('data-wallpaper-sharp');
    document.documentElement.removeAttribute('data-wallpaper-solid');
    const again = await load();
    expect(again.useWallpaper.getState().blur).toBe(false);
    expect(again.useWallpaper.getState().ownBubble).toBe('solid');
    expect(document.documentElement.hasAttribute('data-wallpaper-sharp')).toBe(true);
    expect(document.documentElement.hasAttribute('data-wallpaper-solid')).toBe(true);
    again.useWallpaper.getState().setBlur(true);
    expect(document.documentElement.hasAttribute('data-wallpaper-sharp')).toBe(false);
  });

  it('falls back to blur and glass for stored values it does not understand', async () => {
    localStorage.setItem('leafbot.wallpaper.blur', 'maybe');
    localStorage.setItem('leafbot.wallpaper.ownBubble', 'neon');
    const { useWallpaper } = await load();
    expect(useWallpaper.getState().blur).toBe(true);
    expect(useWallpaper.getState().ownBubble).toBe('glass');
  });

  it('refuses a file too large to be a photo before reading it', async () => {
    const { shrink, MAX_FILE_BYTES, WallpaperError } = await load();
    const huge = { size: MAX_FILE_BYTES + 1 } as Blob;
    await expect(shrink(huge)).rejects.toBeInstanceOf(WallpaperError);
    await expect(shrink(huge)).rejects.toMatchObject({ reason: 'tooLarge' });
  });
});
