import { describe, expect, it } from 'vitest';
import { codeOfLink, parseConnectCode } from './connectCode';

describe('parseConnectCode', () => {
  it('writes a code the way the service shows it, whatever the case, spaces or dashes', () => {
    for (const raw of ['ABCDE-FGHJK', 'abcde-fghjk', ' abcde fghjk ', 'ABCDEFGHJK', 'abc-defgh-jk']) {
      expect(parseConnectCode(raw)).toBe('ABCDE-FGHJK');
    }
  });

  it('refuses what cannot be a code, such as letters that look like digits', () => {
    for (const raw of ['', 'ABCDE', 'ABCDE-FGHJ0', 'ABCDE-FGHJI', 'ABCDE-FGHJKM2', 'hello world!']) {
      expect(parseConnectCode(raw)).toBeNull();
    }
  });

  it('takes the code out of a scanned address and refuses other addresses', () => {
    expect(parseConnectCode('leafbot://connect?code=ABCDE-FGHJK')).toBe('ABCDE-FGHJK');
    expect(parseConnectCode('leafbot://connect/?x=1&code=abcdefghjk#top')).toBe('ABCDE-FGHJK');
    expect(parseConnectCode('https://leafbot.app/connect?code=ABCDE-FGHJK')).toBeNull();
    expect(parseConnectCode('leafbot://connect')).toBeNull();
  });
});

describe('codeOfLink', () => {
  it('gives the code of a connect link only', () => {
    expect(codeOfLink('leafbot://connect?code=ABCDE%2DFGHJK')).toBe('ABCDE-FGHJK');
    expect(codeOfLink('leafbot://other?code=ABCDE-FGHJK')).toBeNull();
    expect(codeOfLink('leafbot://connect?code=%E0%A4%A')).toBeNull();
  });
});
