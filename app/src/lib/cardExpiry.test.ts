import { describe, expect, it } from 'vitest';
import { parseExpiry } from './cardExpiry';

describe('kart son kullanma tarihi', () => {
  it.each([
    '12/27',
    '1227',
    '12-27',
    '12.27',
    '12 27',
    '2027-12',
    '12/2027',
    ' 12 / 27 ',
    '122027',
    '12\\27',
  ])('%s ayı ve yılı verir', (text) => {
    expect(parseExpiry(text)).toEqual({ month: 12, year: 2027 });
  });

  it('tek haneli ayı da okur', () => {
    expect(parseExpiry('1/27')).toEqual({ month: 1, year: 2027 });
    expect(parseExpiry('127')).toEqual({ month: 1, year: 2027 });
    expect(parseExpiry('01/2030')).toEqual({ month: 1, year: 2030 });
  });

  it('ay ve yıl olmayanı reddeder', () => {
    for (const text of ['', '13/27', '00/27', '12', '12/7', '12/202', '1/2/3', 'ab/cd', '12/1999', '12345']) {
      expect(parseExpiry(text), text).toBeNull();
    }
  });
});
