import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseWindowState, readWindowState, resolveWindowState, writeWindowState } from './window-state';

const screen = { x: 0, y: 0, width: 1920, height: 1080 };
const second = { x: 1920, y: 0, width: 1280, height: 800 };

describe('pencere durumu', () => {
  it('bozuk ya da eksik kaydı yok sayar', () => {
    expect(parseWindowState('{')).toBeNull();
    expect(parseWindowState({ bounds: { x: 0, y: 0, width: 0, height: 10 } })).toBeNull();
    expect(parseWindowState({ bounds: { x: 1.5, y: 0, width: 10, height: 10 } })).toBeNull();
    expect(parseWindowState('{"bounds":{"x":1,"y":2,"width":3,"height":4},"maximized":true}')).toEqual({
      bounds: { x: 1, y: 2, width: 3, height: 4 },
      maximized: true,
    });
  });

  it('kayıt yoksa varsayılan boyutu ekrana sığdırır', () => {
    expect(resolveWindowState(null, [{ x: 0, y: 0, width: 1280, height: 720 }]).bounds).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it('pencereyi en çok örtüştüğü ekranda tutar', () => {
    const r = resolveWindowState({ bounds: { x: 2000, y: 100, width: 1600, height: 900 }, maximized: true }, [
      screen,
      second,
    ]);
    expect(r).toEqual({ bounds: { x: 1920, y: 0, width: 1280, height: 800 }, maximized: true });
  });

  it('artık olmayan bir ekrandaki pencereyi ana ekranın ortasına alır', () => {
    const r = resolveWindowState({ bounds: { x: 5000, y: 0, width: 1000, height: 700 }, maximized: false }, [
      screen,
    ]);
    expect(r.bounds).toEqual({ x: 460, y: 190, width: 1000, height: 700 });
  });

  it('kaydedilen durumu geri okur', () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-window-'));
    try {
      expect(readWindowState(dir)).toBeNull();
      writeWindowState(dir, { bounds: { x: 10, y: 20, width: 1000, height: 700 }, maximized: false });
      expect(readWindowState(dir)).toEqual({
        bounds: { x: 10, y: 20, width: 1000, height: 700 },
        maximized: false,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
