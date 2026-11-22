import { describe, expect, it } from 'vitest';
import { createTranslator, parseAcceptLanguage, pickLocale } from './i18n';

describe('dil seçimi', () => {
  it('tarayıcı tercihlerinden desteklenen ilk dili seçer', () => {
    expect(pickLocale(['fr-FR', 'en-GB', 'tr'])).toBe('en');
    expect(pickLocale(['de-AT', 'en-GB'])).toBe('de');
    expect(pickLocale(['tr-TR'])).toBe('tr');
    expect(pickLocale(['fr', 'it'])).toBe('tr');
    expect(pickLocale(['fr'], 'en')).toBe('en');
    expect(pickLocale(undefined)).toBe('tr');
  });

  it('Accept-Language başlığını ağırlığa göre okur', () => {
    expect(parseAcceptLanguage('tr;q=0.5, en-US, *;q=0.1')).toEqual(['en-US', 'tr']);
    expect(pickLocale('fr-FR,fr;q=0.9,tr;q=0.8,en;q=0.7')).toBe('tr');
    expect(pickLocale('')).toBe('tr');
  });
});

describe('çevirmen', () => {
  const catalogs = {
    tr: { hello: 'Merhaba {name}', files: '{count} dosya', onlyTr: 'yalnız Türkçe' },
    en: { hello: 'Hello {name}', files: { one: '{count} file', other: '{count} files' } },
  };

  it('yer tutucuları doldurur ve çoğul biçimi seçer', () => {
    const tr = createTranslator(catalogs, 'tr');
    const en = createTranslator(catalogs, 'en');
    expect(tr('hello', { name: 'Ayşe' })).toBe('Merhaba Ayşe');
    expect(en('hello', { name: 'Ayşe' })).toBe('Hello Ayşe');
    expect(tr('files', { count: 1 })).toBe('1 dosya');
    expect(en('files', { count: 1 })).toBe('1 file');
    expect(en('files', { count: 3 })).toBe('3 files');
  });

  it('eksik çeviride varsayılan dile, o da yoksa anahtara düşer', () => {
    const en = createTranslator<string>(catalogs, 'en');
    expect(en('onlyTr')).toBe('yalnız Türkçe');
    expect(en('missing')).toBe('missing');
  });

  it('Almancada eksik metni İngilizceden, çoğulunu İngilizcenin kuralıyla gösterir', () => {
    const de = createTranslator<string>({ ...catalogs, de: { hello: 'Hallo {name}' } }, 'de');
    expect(de('hello', { name: 'Ayşe' })).toBe('Hallo Ayşe');
    expect(de('files', { count: 1 })).toBe('1 file');
    expect(de('onlyTr')).toBe('yalnız Türkçe');
  });

  it('nesnenin yerleşik üyelerini çeviri sanmaz', () => {
    const en = createTranslator<string>(catalogs, 'en');
    expect(en('constructor')).toBe('constructor');
    expect(en('toString')).toBe('toString');
    expect(en('__proto__')).toBe('__proto__');
  });
});
