import { describe, expect, it } from 'vitest';
import { browserLocale } from './locale';

describe('browserLocale', () => {
  it('uses the interface language first', () => {
    expect(browserLocale('tr', { LANG: 'de_DE.UTF-8' })).toBe('tr-TR');
    expect(browserLocale('en', {})).toBe('en-US');
  });

  it('falls back to the environment when the language is unknown', () => {
    expect(browserLocale(undefined, { LANG: 'de_DE.UTF-8' })).toBe('de-DE');
    expect(browserLocale('xx', { LC_ALL: 'fr_FR@euro', LANG: 'de_DE' })).toBe('fr-FR');
  });

  it('skips C, POSIX and invalid environment locales', () => {
    expect(browserLocale(undefined, { LANG: 'C' })).toBe('en-US');
    expect(browserLocale(undefined, { LC_ALL: 'POSIX', LANG: 'C.UTF-8' })).toBe('en-US');
    expect(browserLocale(undefined, { LANG: '' })).toBe('en-US');
    expect(browserLocale(undefined, { LC_ALL: 'C', LANG: 'es_ES.UTF-8' })).toBe('es-ES');
  });
});
