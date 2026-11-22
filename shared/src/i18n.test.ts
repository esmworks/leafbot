import { describe, expect, it } from 'vitest';
import { createTranslator, parseAcceptLanguage, pickLocale } from './i18n';

describe('dil seçimi', () => {
  it('tarayıcı tercihlerinden desteklenen ilk dili seçer', () => {
    expect(pickLocale(['ja-JP', 'en-GB', 'tr'])).toBe('en');
    expect(pickLocale(['de-AT', 'en-GB'])).toBe('de');
    expect(pickLocale(['tr-TR'])).toBe('tr');
    expect(pickLocale(['ja', 'nl'])).toBe('tr');
    expect(pickLocale(['ja'], 'en')).toBe('en');
    expect(pickLocale(undefined)).toBe('tr');
  });

  it('bölge ve betik eklerini atarak yeni dilleri de tanır', () => {
    expect(pickLocale(['zh-Hans-CN'])).toBe('zh');
    expect(pickLocale(['pt-BR'])).toBe('pt');
    expect(pickLocale(['ar-EG'])).toBe('ar');
    expect(pickLocale(['es-419', 'en'])).toBe('es');
    expect(pickLocale(['hi-IN'])).toBe('hi');
  });

  it('Accept-Language başlığını ağırlığa göre okur', () => {
    expect(parseAcceptLanguage('tr;q=0.5, en-US, *;q=0.1')).toEqual(['en-US', 'tr']);
    expect(pickLocale('ja-JP,ja;q=0.9,tr;q=0.8,en;q=0.7')).toBe('tr');
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

  it('Rusça ve Arapçada dilin kendi çoğul kategorilerini kullanır', () => {
    const forms = {
      tr: { files: '{count} dosya' },
      en: { files: '{count} file' },
      ru: {
        files: {
          one: '{count} файл',
          few: '{count} файла',
          many: '{count} файлов',
          other: '{count} файла',
        },
      },
      ar: {
        files: {
          zero: 'لا ملفات',
          one: 'ملف واحد',
          two: 'ملفان',
          few: '{count} ملفات',
          many: '{count} ملفًا',
          other: '{count} ملف',
        },
      },
    };
    const ru = createTranslator<string>(forms, 'ru');
    expect(ru('files', { count: 1 })).toBe('1 файл');
    expect(ru('files', { count: 3 })).toBe('3 файла');
    expect(ru('files', { count: 5 })).toBe('5 файлов');
    expect(ru('files', { count: 21 })).toBe('21 файл');
    const ar = createTranslator<string>(forms, 'ar');
    expect(ar('files', { count: 0 })).toBe('لا ملفات');
    expect(ar('files', { count: 2 })).toBe('ملفان');
    expect(ar('files', { count: 3 })).toBe('3 ملفات');
    expect(ar('files', { count: 11 })).toBe('11 ملفًا');
  });

  it('eksik çoğul kategorisinde other biçimine düşer', () => {
    const partial = {
      tr: { files: '{count} dosya' },
      en: { files: { one: '{count} file', other: '{count} files' } },
      ru: { files: { other: '{count} файла' } },
    };
    const ru = createTranslator<string>(partial, 'ru');
    expect(ru('files', { count: 1 })).toBe('1 файла');
    expect(ru('files', { count: 5 })).toBe('5 файла');
  });
});
