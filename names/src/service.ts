/**
 * Gives each Leaf Bot server set up with docker/install.sh a name under the project's own domain
 * (`k3x9q2mf.leafbot.cloud`), so the installer does not have to borrow a name from a public
 * IP-address DNS service. Let's Encrypt counts new certificates per registered domain; under a shared
 * service every install would share that count with everyone else using it, here only with other
 * Leaf Bot servers.
 *
 * A name always points at the address the request came from: whoever asks for a name has shown they
 * hold that address, and nobody can point a name at someone else's server. The server keeps a token
 * that lets it move its name when its address changes and tells the service it is still there; names
 * not heard from for a while are removed, so a name does not keep pointing at an address that has
 * since gone to someone else.
 *
 * Asking for a name needs no token, and anything running on a server (its bots' shells and browsers
 * among them) leaves from the server's address. So a new name never takes the place of an existing
 * one: only the token's holder can move or give up a name, and an address may hold a few names at
 * once, the old ones expiring when no longer renewed.
 */

export interface NameRow {
  label: string;
  ip: string;
  recordId: string;
  tokenHash: string;
  createdAt: number;
  seenAt: number;
}

export interface NameStore {
  byLabel(label: string): Promise<NameRow | null>;
  /** How many names point at `ip`. */
  countByIp(ip: string): Promise<number>;
  /** Of the names pointing at `ip`, the one renewed last. */
  latestByIp(ip: string): Promise<NameRow | null>;
  insert(row: NameRow): Promise<void>;
  setIp(label: string, ip: string, seenAt: number): Promise<void>;
  touch(label: string, seenAt: number): Promise<void>;
  remove(label: string): Promise<void>;
  count(): Promise<number>;
  /** Names handed out since `since`, by anyone. */
  claimsSince(since: number): Promise<number>;
  claimsFromIpSince(ip: string, since: number): Promise<number>;
  logClaim(ip: string, at: number): Promise<void>;
  pruneClaims(before: number): Promise<void>;
  /** Names last heard from before `before`, oldest first. */
  staleBefore(before: number, limit: number): Promise<NameRow[]>;
}

export interface NameDns {
  /** Adds an A record and returns its id. Throws {@link DnsFull} when the zone holds no more records. */
  create(fqdn: string, ip: string): Promise<string>;
  update(recordId: string, ip: string): Promise<void>;
  /** Removes a record; a record already gone is fine. */
  remove(recordId: string): Promise<void>;
}

/** The DNS zone has reached its record quota. */
export class DnsFull extends Error {}

export interface NameLimits {
  /** New names a single address may get in a day. */
  perIpPerDay: number;
  /** Names one address may hold at once: room to set a server up again before the old name expires. */
  perIp: number;
  /**
   * New names in seven days, across all servers. Let's Encrypt gives 50 new certificates a week per
   * registered domain; staying under it leaves room for a certificate asked for again by hand.
   */
  perWeek: number;
  /** Names the zone may hold; the zone's DNS record quota, less room for the zone's own records. */
  total: number;
  /** Days without word from a server after which its name is removed. */
  staleDays: number;
}

export const DEFAULT_LIMITS: NameLimits = {
  perIpPerDay: 3,
  perIp: 3,
  perWeek: 40,
  total: 180,
  staleDays: 30,
};

const DAY = 24 * 60 * 60 * 1000;

/** Machine-readable reasons; the installer only tells whether it got a name. */
export type NameError =
  'ipv4_only' | 'too_many' | 'busy' | 'full' | 'unknown' | 'dns' | 'not_found' | 'bad_request';

export class NameFailure extends Error {
  constructor(
    readonly code: NameError,
    readonly status: number,
  ) {
    super(code);
  }
}

/** Whether `ip` is an IPv4 address on the public internet, where Let's Encrypt can reach it. */
export function isPublicIpv4(ip: string): boolean {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return false;
  const [a, b, c] = m.slice(1).map(Number) as [number, number, number, number];
  if (m.slice(1).some((p) => Number(p) > 255 || (p.length > 1 && p.startsWith('0')))) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return true;
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const ALPHABET = LETTERS + '0123456789';

function randomFrom(chars: string, count: number): string {
  let out = '';
  // Bytes at or above the last whole multiple of the alphabet's size are dropped, so every
  // character is equally likely.
  const cap = 256 - (256 % chars.length);
  while (out.length < count) {
    for (const byte of crypto.getRandomValues(new Uint8Array(count * 2))) {
      if (byte < cap && out.length < count) out += chars[byte % chars.length];
    }
  }
  return out;
}

/** Eight characters, starting with a letter: hard to guess, short enough to read out. */
export function randomLabel(): string {
  return randomFrom(LETTERS, 1) + randomFrom(ALPHABET, 7);
}

export const LABEL = /^[a-z][a-z0-9]{7}$/;

function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export interface NameServiceOptions {
  store: NameStore;
  dns: NameDns;
  /** The zone names are made under, such as `leafbot.cloud`. */
  domain: string;
  limits?: Partial<NameLimits>;
  now?: () => number;
}

export class NameService {
  private readonly limits: NameLimits;
  private readonly now: () => number;

  constructor(private readonly o: NameServiceOptions) {
    this.limits = { ...DEFAULT_LIMITS, ...o.limits };
    this.now = o.now ?? Date.now;
  }

  private fqdn(label: string): string {
    return `${label}.${this.o.domain}`;
  }

  /** Hands out a new name pointing at `ip`, with the token that keeps it. */
  async claim(ip: string): Promise<{ name: string; token: string }> {
    const { store, dns } = this.o;
    if (!isPublicIpv4(ip)) throw new NameFailure('ipv4_only', 400);
    const now = this.now();
    if ((await store.claimsFromIpSince(ip, now - DAY)) >= this.limits.perIpPerDay)
      throw new NameFailure('too_many', 429);
    if ((await store.countByIp(ip)) >= this.limits.perIp) throw new NameFailure('too_many', 429);
    if ((await store.claimsSince(now - 7 * DAY)) >= this.limits.perWeek) throw new NameFailure('busy', 503);
    if ((await store.count()) >= this.limits.total) throw new NameFailure('full', 503);
    await store.logClaim(ip, now);

    let label = randomLabel();
    while (await store.byLabel(label)) label = randomLabel();
    let recordId: string;
    try {
      recordId = await dns.create(this.fqdn(label), ip);
    } catch (e) {
      if (e instanceof DnsFull) throw new NameFailure('full', 503);
      throw new NameFailure('dns', 502);
    }
    const token = randomToken();
    try {
      await store.insert({
        label,
        ip,
        recordId,
        tokenHash: await hashToken(token),
        createdAt: now,
        seenAt: now,
      });
    } catch (e) {
      await dns.remove(recordId).catch(() => {});
      throw e;
    }
    return { name: this.fqdn(label), token };
  }

  private async owned(label: string, token: string): Promise<NameRow> {
    const row = LABEL.test(label) ? await this.o.store.byLabel(label) : null;
    // A wrong token and a name that does not exist answer alike, so neither can be found by trying.
    if (!row || row.tokenHash !== (await hashToken(token))) throw new NameFailure('unknown', 404);
    return row;
  }

  /** The server says it is still there, from `ip`; the name moves there if the address changed. */
  async refresh(label: string, token: string, ip: string): Promise<{ name: string; ip: string }> {
    const row = await this.owned(label, token);
    if (!isPublicIpv4(ip)) throw new NameFailure('ipv4_only', 400);
    const now = this.now();
    if (row.ip === ip) {
      await this.o.store.touch(label, now);
    } else {
      // Other names on the new address are left alone: their tokens are not here, and they expire by
      // themselves if their server is gone.
      try {
        await this.o.dns.update(row.recordId, ip);
      } catch {
        throw new NameFailure('dns', 502);
      }
      await this.o.store.setIp(label, ip, now);
    }
    return { name: this.fqdn(label), ip };
  }

  /**
   * The name pointing at `ip`, for someone who set a server up through their provider's user data and
   * knows only its address. Names are no secret: DNS answers for them and every certificate issued
   * for one is published in Certificate Transparency logs.
   */
  async nameFor(ip: string): Promise<string | null> {
    if (!isPublicIpv4(ip)) return null;
    const row = await this.o.store.latestByIp(ip);
    return row ? this.fqdn(row.label) : null;
  }

  /** Gives a name up, for a server that is going away. */
  async release(label: string, token: string): Promise<void> {
    await this.drop(await this.owned(label, token));
  }

  private async drop(row: NameRow): Promise<void> {
    await this.o.dns.remove(row.recordId);
    await this.o.store.remove(row.label);
  }

  /** Removes names not heard from in `staleDays`, and forgets claims older than any limit looks at. */
  async sweep(): Promise<number> {
    const now = this.now();
    const stale = await this.o.store.staleBefore(now - this.limits.staleDays * DAY, 100);
    for (const row of stale) await this.drop(row);
    await this.o.store.pruneClaims(now - 8 * DAY);
    return stale.length;
  }
}
