import { codeOfLink, parseConnectCode } from './connectCode';

/** Where the website hands the app its code: the address the sign-in browser closes on. */
export const RETURN_URL = 'leafbot://connect';

/** Bytes as base64url without padding, as PKCE writes a verifier and its challenge. */
export function base64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh verifier and its S256 challenge. The website makes the code with the challenge; only this
 * app, holding the verifier, can spend it, so a code caught on its way back is of no use to anyone.
 */
export async function newPkce(
  random: (n: number) => Uint8Array,
  sha256: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<{ verifier: string; challenge: string }> {
  const verifier = base64url(random(32));
  const challenge = base64url(await sha256(new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

/** The website's page that signs the app in, in the phone's language where the site has it. */
export function connectPageUrl(website: string, locale: string, challenge: string): string {
  const prefix = locale === 'tr' ? '/tr' : '';
  return `${website}${prefix}/connect?challenge=${encodeURIComponent(challenge)}`;
}

/** The code in the address the sign-in browser closed on, or null when it brought none. */
export function codeOfReturn(url: string): string | null {
  const raw = codeOfLink(url);
  return raw ? parseConnectCode(raw) : null;
}
