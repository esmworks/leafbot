import { describe, expect, it } from 'vitest';
import { base64url, codeOfReturn, connectPageUrl, newPkce } from './webSignIn';

describe('web sign-in', () => {
  it('makes a verifier and its S256 challenge as RFC 7636 does (its appendix B example)', async () => {
    const octets = [
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214,
      191, 240, 91, 88, 5, 88, 83, 132, 141, 121,
    ];
    const { verifier, challenge } = await newPkce(
      (n) => new Uint8Array(octets.slice(0, n)),
      async (data) => new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>)),
    );
    expect(verifier).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(challenge).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('writes base64url without padding', () => {
    expect(base64url(new Uint8Array([251, 255, 254]))).toBe('-__-');
    expect(base64url(new Uint8Array([1]))).toBe('AQ');
  });

  it('opens the page in the phone’s language', () => {
    expect(connectPageUrl('https://www.leafbot.app', 'tr', 'abc')).toBe(
      'https://www.leafbot.app/tr/connect?challenge=abc',
    );
    expect(connectPageUrl('https://www.leafbot.app', 'de', 'abc')).toBe(
      'https://www.leafbot.app/connect?challenge=abc',
    );
  });

  it('takes the code from the address the browser closed on, and nothing else', () => {
    expect(codeOfReturn('leafbot://connect?code=ABCDE-FGHJK')).toBe('ABCDE-FGHJK');
    expect(codeOfReturn('leafbot://connect')).toBeNull();
    expect(codeOfReturn('https://evil.example/connect?code=ABCDE-FGHJK')).toBeNull();
  });
});
