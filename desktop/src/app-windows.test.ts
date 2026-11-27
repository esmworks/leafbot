import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { APP_WINDOW_SIZE, appWindowUrl, readAppWindowSize, writeAppWindowSize } from './app-windows';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'leafbot-appwin-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('app windows', () => {
  it("opens the app's own view on the server's page", () => {
    expect(appWindowUrl('http://127.0.0.1:4319', 'a_1')).toBe('http://127.0.0.1:4319/?app=a_1');
  });

  it('keeps each app window at the size it was closed at', () => {
    expect(readAppWindowSize(dir, 'a')).toEqual(APP_WINDOW_SIZE);
    writeAppWindowSize(dir, 'a', { width: 600, height: 500 });
    writeAppWindowSize(dir, 'b', { width: 900, height: 700 });
    expect(readAppWindowSize(dir, 'a')).toEqual({ width: 600, height: 500 });
    expect(readAppWindowSize(dir, 'b')).toEqual({ width: 900, height: 700 });
  });

  it('takes the first size for anything it cannot use', () => {
    writeFileSync(join(dir, 'app-windows.json'), JSON.stringify({ a: { width: 10, height: 'x' } }));
    expect(readAppWindowSize(dir, 'a')).toEqual(APP_WINDOW_SIZE);
    writeFileSync(join(dir, 'app-windows.json'), 'not json');
    expect(readAppWindowSize(dir, 'a')).toEqual(APP_WINDOW_SIZE);
  });
});
