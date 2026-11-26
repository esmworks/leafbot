import { createHash, createPublicKey, verify, type KeyObject } from 'node:crypto';
import { JWKS_PATH, TICKET_ALG, TICKET_SKEW_S, TICKET_TTL_S, TicketClaims } from '@leafbot/shared/account';
import { ed25519ThumbprintInput, proofMessage, type TunnelDenial } from '@leafbot/shared/tunnel';

/** Why a ticket or proof was refused; the code goes back to the browser as it is. */
export class TunnelRefusal extends Error {
  constructor(readonly code: TunnelDenial) {
    super(code);
  }
}

/** The account service's keys are fetched again at most this often when an unknown `kid` arrives. */
const JWKS_RETRY_MS = 30_000;
/** Keys are fetched again after this long even when every `kid` is known, so removed keys go. */
const JWKS_MAX_AGE_MS = 60 * 60_000;
/** Ticket ids remembered at once; past it new tickets wait until older ones expire. */
const MAX_SEEN = 50_000;
/** Expired ticket ids are swept out at most this often, not on every check. */
const PRUNE_MS = 5_000;

export interface TicketCheckerOptions {
  /** The account service, e.g. `https://api.leafbot.app`; tickets from any other are refused. */
  issuer: string;
  /** This server's id at the account service; tickets for any other server are refused. */
  hostId: string;
  /** Reads the account service's JWKS; by default from `<issuer>/.well-known/jwks.json`. */
  fetchJwks?: () => Promise<unknown>;
  /** Unix seconds. */
  now?: () => number;
}

const b64u = (s: string) => Buffer.from(s, 'base64url');

/**
 * Checks the tickets the account service signs, without asking it: the signature against its
 * published keys, that the ticket is for this server and a person's device, still fresh, signed
 * after the last change of access, and not used before.
 */
export class TicketChecker {
  private keys = new Map<string, KeyObject>();
  private fetchedAt = 0;
  private fetching: Promise<void> | null = null;
  /** Ticket id → the time (Unix seconds) after which it would be refused as expired anyway. */
  private seen = new Map<string, number>();
  private counter = 0;
  private prunedAt = 0;

  constructor(private opts: TicketCheckerOptions) {}

  private now() {
    return this.opts.now?.() ?? Math.floor(Date.now() / 1000);
  }

  /**
   * The server's access counter: the highest `epoch` seen on an accepted ticket or in a revocation.
   * It only goes up, so whoever reports it can take access away but never give it back.
   */
  get epoch() {
    return this.counter;
  }

  raiseEpoch(epoch: number) {
    if (epoch > this.counter) this.counter = epoch;
  }

  /** The claims of a valid ticket; throws TunnelRefusal otherwise. Each ticket passes only once. */
  async check(token: string): Promise<TicketClaims> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new TunnelRefusal('ticket');
    const [h, p, s] = parts as [string, string, string];
    let header: { alg?: unknown; kid?: unknown };
    let payload: unknown;
    try {
      header = JSON.parse(b64u(h).toString('utf8')) as typeof header;
      payload = JSON.parse(b64u(p).toString('utf8'));
    } catch {
      throw new TunnelRefusal('ticket');
    }
    // The algorithm is fixed here, never taken from the ticket, so a ticket cannot pick a weaker one.
    if (header.alg !== TICKET_ALG || typeof header.kid !== 'string') throw new TunnelRefusal('ticket');
    const key = await this.key(header.kid);
    const sig = b64u(s);
    // JWS carries ES256 signatures as raw r‖s, not DER.
    const valid =
      key !== undefined &&
      sig.length === 64 &&
      verify('sha256', Buffer.from(`${h}.${p}`), { key, dsaEncoding: 'ieee-p1363' }, sig);
    if (!valid) throw new TunnelRefusal('ticket');

    const parsed = TicketClaims.safeParse(payload);
    if (!parsed.success) throw new TunnelRefusal('ticket');
    const c = parsed.data;
    if (c.iss !== this.opts.issuer || c.aud !== this.opts.hostId) throw new TunnelRefusal('ticket');
    if (c.kind !== 'client' || !c.cnf || !c.hkey || !c.role || !c.mid) throw new TunnelRefusal('ticket');
    const now = this.now();
    if (c.iat > now + TICKET_SKEW_S || c.exp <= now - TICKET_SKEW_S) throw new TunnelRefusal('ticket');
    if (c.exp < c.iat || c.exp - c.iat > TICKET_TTL_S + TICKET_SKEW_S) throw new TunnelRefusal('ticket');
    if (c.epoch < this.counter) throw new TunnelRefusal('revoked');

    if (Date.now() - this.prunedAt >= PRUNE_MS || this.seen.size >= MAX_SEEN) {
      this.prunedAt = Date.now();
      for (const [id, until] of this.seen) if (until < now) this.seen.delete(id);
    }
    if (this.seen.has(c.jti)) throw new TunnelRefusal('ticket');
    if (this.seen.size >= MAX_SEEN) throw new TunnelRefusal('busy');
    this.seen.set(c.jti, c.exp + TICKET_SKEW_S);
    this.raiseEpoch(c.epoch);
    return c;
  }

  private async key(kid: string): Promise<KeyObject | undefined> {
    const age = Date.now() - this.fetchedAt;
    if (this.keys.has(kid) && age < JWKS_MAX_AGE_MS) return this.keys.get(kid);
    // Never fetched yet, or not for a while. A failed fetch counts too, so while the account
    // service is down a stream of tickets does not turn into a stream of requests to it.
    if (age >= JWKS_RETRY_MS || this.fetchedAt === 0) await this.refresh();
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    this.fetching ??= this.load().finally(() => (this.fetching = null));
    return this.fetching;
  }

  private async load() {
    let jwks: unknown;
    try {
      jwks = this.opts.fetchJwks
        ? await this.opts.fetchJwks()
        : await fetch(new URL(JWKS_PATH, this.opts.issuer), { signal: AbortSignal.timeout(10_000) }).then(
            (r) => (r.ok ? r.json() : Promise.reject(new Error(`jwks ${r.status}`))),
          );
    } catch {
      // The keys held stay in use; the next unknown kid tries again after the retry interval.
      this.fetchedAt = Date.now();
      return;
    }
    const next = new Map<string, KeyObject>();
    const list = (jwks as { keys?: unknown })?.keys;
    for (const jwk of Array.isArray(list) ? list : []) {
      const k = jwk as { kty?: unknown; crv?: unknown; kid?: unknown; x?: unknown; y?: unknown };
      if (k.kty !== 'EC' || k.crv !== 'P-256' || typeof k.kid !== 'string') continue;
      if (typeof k.x !== 'string' || typeof k.y !== 'string') continue;
      try {
        next.set(k.kid, createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: k.x, y: k.y }, format: 'jwk' }));
      } catch {
        // A key this server cannot read is skipped; the others still work.
      }
    }
    this.keys = next;
    this.fetchedAt = Date.now();
  }
}

/**
 * Checks that the device holding the ticket signed this very connection: its key is the one the
 * ticket names (`cnf.jkt`), and the signature covers the ticket, both DTLS fingerprints and the
 * nonce this server just sent.
 */
export function checkProof(p: {
  claims: TicketClaims;
  ticket: string;
  /** The device's Ed25519 public key, raw, base64url. */
  key: string;
  sig: string;
  clientFingerprint: string;
  serverFingerprint: string;
  nonce: string;
}): void {
  const jkt = createHash('sha256').update(ed25519ThumbprintInput(p.key)).digest('base64url');
  if (!p.claims.cnf || jkt !== p.claims.cnf.jkt) throw new TunnelRefusal('proof');
  let key: KeyObject;
  let message: Uint8Array;
  try {
    key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: p.key }, format: 'jwk' });
    message = proofMessage(p);
  } catch {
    throw new TunnelRefusal('proof');
  }
  const sig = b64u(p.sig);
  if (sig.length !== 64 || !verify(null, message, key, sig)) throw new TunnelRefusal('proof');
}
