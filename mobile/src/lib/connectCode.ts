/** The characters a connect code is made of: no 0, 1, I, L or O, which look alike. */
const ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/;

/**
 * A connect code as typed, pasted or scanned, in the form the account service shows it (`ABCDE-FGHJK`),
 * or null when it cannot be one. Case, spaces and dashes do not matter; a scanned
 * `leafbot://connect?code=…` address gives its code.
 */
export function parseConnectCode(raw: string): string | null {
  let text = raw.trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    const fromLink = codeOfLink(text);
    if (!fromLink) return null;
    text = fromLink;
  }
  const code = text.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return ALPHABET.test(code) ? `${code.slice(0, 5)}-${code.slice(5)}` : null;
}

/** The `code` of a `leafbot://connect?code=…` address, or null for any other address. */
export function codeOfLink(link: string): string | null {
  const m = /^leafbot:\/\/connect\/?\?(.*)$/i.exec(link.trim());
  if (!m) return null;
  const query = m[1]!.split('#')[0]!;
  for (const pair of query.split('&')) {
    const [k, v = ''] = pair.split('=');
    if (k === 'code') {
      try {
        return decodeURIComponent(v);
      } catch {
        return null;
      }
    }
  }
  return null;
}
