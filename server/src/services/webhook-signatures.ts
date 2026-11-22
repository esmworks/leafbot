import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How apps prove a webhook call is their own: each signs the body it sends, in its own header and
 * format. Apps where the person types the secret in (GitHub, GitLab, Typeform, Calendly) are given
 * the routine's own webhook secret; apps that make the secret themselves (Stripe, Shopify, Linear,
 * Sentry) are checked with the one the person pasted into the routine.
 */

/** A call older than this, by the time it was signed at, is turned away as one sent again. */
const SIGNED_AT_TOLERANCE_MS = 5 * 60_000;

const hmac = (key: string, data: Buffer | string) => createHmac('sha256', key).update(data).digest();

function same(got: Buffer, want: Buffer): boolean {
  return got.length === want.length && got.length > 0 && timingSafeEqual(got, want);
}

const hex = (s: string) =>
  /^[0-9a-f]+$/i.test(s) && s.length % 2 === 0 ? Buffer.from(s, 'hex') : Buffer.alloc(0);
const base64 = (s: string) => Buffer.from(s, 'base64');

/** `t=<seconds>,v1=<hex>[,v1=<hex>…]`, signed over `<t>.<body>`, as Stripe and Calendly send it. */
function timedSignature(header: string, key: string, raw: Buffer, now: number): boolean {
  const parts = header.split(',').map((p) => p.trim().split('='));
  const t = parts.find(([k]) => k === 't')?.[1];
  const sigs = parts.filter(([k]) => k === 'v1').map(([, v]) => v ?? '');
  if (!t || !/^\d+$/.test(t) || !sigs.length) return false;
  if (Math.abs(now - Number(t) * 1000) > SIGNED_AT_TOLERANCE_MS) return false;
  const want = hmac(key, Buffer.concat([Buffer.from(`${t}.`), raw]));
  return sigs.some((s) => same(hex(s), want));
}

export interface SignatureResult {
  /** The app whose signature the call carries; null for an unsigned call. */
  scheme: string | null;
  /**
   * Which key the signature is checked with: the routine's own secret (`token`, which is also the
   * last part of its address) or the one the app made (`secret`).
   */
  keyed: 'token' | 'secret' | null;
  /** Whether it holds; null when it is signed with a secret the routine was not given. */
  valid: boolean | null;
}

/**
 * Looks for an app's signature on a call and checks it: with `token` for apps the person typed the
 * routine's secret into, with `secret` for apps that made their own.
 */
export function checkSignature(
  header: (name: string) => string | undefined,
  raw: Buffer,
  keys: { token: string; secret: string | null },
  now = Date.now(),
): SignatureResult {
  const withSecret = (scheme: string, check: (secret: string) => boolean): SignatureResult => ({
    scheme,
    keyed: 'secret',
    valid: keys.secret ? check(keys.secret) : null,
  });
  const withToken = (scheme: string, valid: boolean): SignatureResult => ({ scheme, keyed: 'token', valid });
  const github = header('x-hub-signature-256');
  if (github !== undefined) {
    const m = /^sha256=([0-9a-f]{64})$/i.exec(github.trim());
    return withToken('github', !!m && same(hex(m[1]!), hmac(keys.token, raw)));
  }
  const gitlab = header('x-gitlab-token');
  if (gitlab !== undefined) return withToken('gitlab', same(Buffer.from(gitlab), Buffer.from(keys.token)));
  const typeform = header('typeform-signature');
  if (typeform !== undefined) {
    const m = /^sha256=(.+)$/.exec(typeform.trim());
    return withToken('typeform', !!m && same(base64(m[1]!), hmac(keys.token, raw)));
  }
  const calendly = header('calendly-webhook-signature');
  if (calendly !== undefined) return withToken('calendly', timedSignature(calendly, keys.token, raw, now));
  const stripe = header('stripe-signature');
  if (stripe !== undefined) return withSecret('stripe', (s) => timedSignature(stripe, s, raw, now));
  const shopify = header('x-shopify-hmac-sha256');
  if (shopify !== undefined) return withSecret('shopify', (s) => same(base64(shopify.trim()), hmac(s, raw)));
  const linear = header('linear-signature');
  if (linear !== undefined) return withSecret('linear', (s) => same(hex(linear.trim()), hmac(s, raw)));
  const sentry = header('sentry-hook-signature');
  if (sentry !== undefined) return withSecret('sentry', (s) => same(hex(sentry.trim()), hmac(s, raw)));
  return { scheme: null, keyed: null, valid: null };
}

/**
 * Whether a call may start the routine. A signature that is there must hold; once the routine was
 * given an app's own secret, a call must carry a signature made with that secret. One made with the
 * routine's own secret is not enough then, since that secret is part of the address.
 */
export function signatureAllows(result: SignatureResult, secretSet: boolean): boolean {
  if (result.valid === false) return false;
  if (secretSet) return result.valid === true && result.keyed === 'secret';
  return true;
}

/** The kind of event an app names in a header, for the filter's `event`. */
export function eventHeader(header: (name: string) => string | undefined): string | undefined {
  return (
    header('x-github-event') ??
    header('x-gitlab-event') ??
    header('x-event-key') ??
    header('x-shopify-topic') ??
    header('sentry-hook-resource')
  );
}
