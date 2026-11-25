import { afterEach, describe, expect, it, vi } from 'vitest';

// The theme follows the system's dark mode, which jsdom does not report.
vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
const { getT, useLocale } = await import('@/i18n');
const { matchCommands, paletteCommands } = await import('./commands');
const { useUi } = await import('./store');
const { useTheme } = await import('./theme');

useLocale.getState().setLocale('en', { unsaved: true });
const t = getT();

describe('⌘K komutları', () => {
  afterEach(() => {
    useUi.getState().openSettings(null);
    useTheme.getState().setChoice('system');
  });

  it('yazılan her sözcüğü adında ya da anahtar sözcüklerinde taşıyanları bulur', () => {
    const all = paletteCommands(t, { manages: true, known: true });
    expect(matchCommands(all, '', 'en')).toEqual([]);
    // The command itself comes before the settings section whose words also hold it.
    expect(matchCommands(all, 'theme dark', 'en').map((c) => c.id)).toEqual([
      'theme:dark',
      'settings:general',
    ]);
    expect(matchCommands(all, 'new bot', 'en')[0]!.id).toBe('new-bot');
    // A settings section is found by its own keywords too.
    expect(matchCommands(all, 'time zone', 'en').map((c) => c.id)).toContain('settings:general');
    expect(matchCommands(all, 's', 'en').length).toBeLessThanOrEqual(6);
  });

  it('sunucuya ait bölümleri yalnız sunucuyu yönetene sunar', () => {
    const ids = (manages: boolean, known: boolean) => paletteCommands(t, { manages, known }).map((c) => c.id);
    expect(ids(false, true)).not.toContain('settings:usage');
    expect(ids(false, true)).toContain('settings:profile');
    expect(ids(true, true)).toContain('settings:usage');
    expect(ids(false, false)).toContain('settings:usage');
  });

  it('bilgisayar kullanımını yalnız botların kullanabileceği bir bilgisayar varken sunar', () => {
    const ids = (computer?: boolean) =>
      paletteCommands(t, { manages: true, known: true, computer }).map((c) => c.id);
    expect(ids(true)).toContain('settings:computer');
    expect(ids(false)).not.toContain('settings:computer');
  });

  it('seçilen komut yerini açar ya da ayarı değiştirir', () => {
    const all = paletteCommands(t, { manages: true, known: true });
    all.find((c) => c.id === 'settings:vault')!.run();
    expect(useUi.getState().settingsTab).toBe('vault');
    all.find((c) => c.id === 'theme:dark')!.run();
    expect(useTheme.getState().choice).toBe('dark');
  });
});
