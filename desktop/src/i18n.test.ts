import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadLocale, saveLocale, setLocale, t } from './i18n';

describe('masaüstü dili', () => {
  const dir = mkdtempSync(join(tmpdir(), 'leafbot-desktop-'));
  afterEach(() => setLocale('tr'));

  it('kayıt yoksa sistem dilini, varsa uygulamanın son dilini kullanır', () => {
    expect(loadLocale(dir, ['en-US', 'tr-TR'])).toBe('en');
    expect(t('menu.quit')).toBe('Quit');
    expect(loadLocale(dir, ['ja-JP'])).toBe('tr');
    // The menu bar app has no German text of its own: a German system reads it in English.
    expect(loadLocale(dir, ['de-DE'])).toBe('de');
    expect(t('menu.quit')).toBe('Quit');
    saveLocale(dir, 'en');
    expect(loadLocale(dir, ['tr-TR'])).toBe('en');
    expect(t('status.remote', { host: 'a.example.com' })).toBe('Remote server: a.example.com');
    rmSync(dir, { recursive: true, force: true });
  });
});
