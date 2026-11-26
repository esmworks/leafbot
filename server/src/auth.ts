import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Params, Role, SessionInfo } from '@leafbot/shared';
import { and, desc, eq } from 'drizzle-orm';
import type { Config } from './config';
import { schema, type Db } from './db';
import { LoginThrottle } from './account';
import type { ServerKey } from './i18n';
import { OWNER_ID, Users } from './users';
import { HttpError } from './util';

export const SESSION_COOKIE = 'leafbot_session';
/**
 * The session cookie's name before the app was renamed. Browsers and phones signed in then still
 * send it; it is read where the new one is missing, so the rename signs no one out.
 */
export const OLD_SESSION_COOKIE = 'yumakbot_session';
/** A session unused for this long ends; every use moves the end further away. */
export const SESSION_IDLE_MS = 90 * 24 * 60 * 60_000;
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/** Access key from the environment, or a 0600 file in the data dir (created on first run). */
export function loadAccessKey(config: Config): string {
  if (config.accessKey) return config.accessKey;
  const file = join(config.dataDir, 'access-key');
  if (existsSync(file)) return readFileSync(file, 'utf8').trim();
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const key = randomBytes(32).toString('base64url');
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  return key;
}

export function sameSecret(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

export const hashSession = (token: string) => createHash('sha256').update(token).digest('hex');

function hostName(host: string): string {
  // Strip port; keep IPv6 brackets.
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
  return host.split(':')[0] ?? host;
}

export const PROXY_HEADER = 'x-leafbot-proxy';
/** The header's name before the rename, still set by reverse proxies configured by hand then. */
export const OLD_PROXY_HEADER = 'x-yumakbot-proxy';

/**
 * The address a request comes from, for the sign-in limit. Only a request from the reverse proxy,
 * proven by its secret, may name another address: the last X-Forwarded-For entry, which the proxy
 * itself wrote. Anyone else could write any address there and so dodge the limit.
 */
export function clientAddress(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string,
  config: Pick<Config, 'proxySecret'>,
): string {
  const sent = headers[PROXY_HEADER] ?? headers[OLD_PROXY_HEADER];
  if (!config.proxySecret || typeof sent !== 'string') return socketAddress;
  const a = Buffer.from(sent);
  const b = Buffer.from(config.proxySecret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return socketAddress;
  const forwarded = headers['x-forwarded-for'];
  const last = (Array.isArray(forwarded) ? forwarded.join(',') : (forwarded ?? '')).split(',').at(-1)?.trim();
  return last || socketAddress;
}

/**
 * A request's path as the router reads it, to decide what needs a sign-in (never to serve
 * anything): percent escapes undone, since the router decodes them before matching and so
 * `/%61pi/bots` reaches `/api/bots`; backslashes, repeated slashes and dot segments folded; lower
 * case.
 */
export function routedPath(url: string): string {
  let path = url.split('?')[0] ?? '';
  // Undone until it stops changing (a few rounds at most), so a doubly escaped path is caught too.
  for (let i = 0; i < 4; i++) {
    let next: string;
    try {
      next = decodeURIComponent(path);
    } catch {
      next = path.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    }
    if (next === path) break;
    path = next;
  }
  const parts: string[] = [];
  for (const seg of path.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return `/${parts.join('/')}`.toLowerCase();
}

const isApiPath = (p: string) => p === '/api' || p.startsWith('/api/');

/**
 * Whether a request needs the access key or a session. The route it matched decides, as that is
 * the handler that runs: an /api route does unless `open` names it. A request that matched no
 * route, or only a catch-all, is judged by its path as the router reads it: anything that looks
 * like the API does, so no spelling of a path slips past.
 */
export function needsSignIn(
  route: string | undefined,
  url: string,
  open: (route: string) => boolean,
): boolean {
  if (route !== undefined && !route.includes('*')) return isApiPath(route) && !open(route);
  return isApiPath(routedPath(url));
}

export interface RequestMeta {
  host: string | undefined;
  origin: string | undefined;
  method: string;
}

/**
 * Host and Origin checks against DNS rebinding and cross-site requests.
 * Returns the error to send (403), or null if the request may proceed.
 */
export function checkHostOrigin(
  meta: RequestMeta,
  config: Config,
  /** Addresses the server is reached at for now (its Tailscale address while shared there). */
  extraHosts: readonly string[] = [],
): HttpError | null {
  const refuse = (key: ServerKey, params?: Params) => new HttpError(403, key, params);
  const host = meta.host?.toLowerCase();
  if (!host) return refuse('error.hostMissing');
  // The public address's host is one the server is reached at by definition.
  const publicHost = config.publicUrl ? [new URL(config.publicUrl).host.toLowerCase()] : [];
  const allowedHosts = new Set([
    ...LOOPBACK_HOSTS,
    ...config.allowedHosts.map((h) => h.toLowerCase()),
    ...publicHost,
    ...extraHosts,
  ]);
  if (!allowedHosts.has(hostName(host)) && !allowedHosts.has(host))
    return refuse('error.hostNotAllowed', { host });
  const origin = meta.origin;
  if (origin === undefined) return null;
  if (origin === 'null') return refuse('error.originNull');
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return refuse('error.originInvalid');
  }
  if (url.host.toLowerCase() === host) return null;
  if (config.allowedOrigins.includes(url.origin)) return null;
  return refuse('error.originNotAllowed', { origin });
}

/** How long a pairing code works, and how many may wait at once. */
export const PAIRING_MS = 5 * 60_000;
const MAX_PAIRING_CODES = 5;
/** Letters and digits that cannot be mistaken for each other when read off a screen. */
const PAIRING_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** A pairing code as typed: case, spaces and dashes do not matter. */
export const normalizePairingCode = (code: string) => code.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Who a request comes from, and how it proved it. */
export interface Principal {
  userId: string;
  role: Role;
  /**
   * The access key (always the owner), a signed-in device's session, or a browser that proved
   * over the tunnel which account it is (see `tunnel/gateway.ts`).
   */
  via: 'key' | 'session' | 'tunnel';
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Who the request comes from; null on the routes open without signing in. */
    principal: Principal | null;
  }
}

/** What the server keeps on each socket. */
export interface SocketData {
  principal: Principal | null;
}

/** Whether a role may manage the server and its people: the owner and admins. */
export const canAdminister = (role: Role) => role === 'owner' || role === 'admin';

/** Refuses a request whose person may not manage the server. */
export function requireAdmin(principal: Principal | null | undefined): Principal {
  if (!principal || !canAdminister(principal.role)) throw new HttpError(403, 'error.adminOnly');
  return principal;
}

interface SeenSession {
  userId: string;
  role: Role;
  at: number;
}

export class Auth {
  /** Sessions checked in the last minute, by hash, with whose they are. */
  private cache = new Map<string, SeenSession>();
  /** Tunnelled people's roles by person, read again after a minute like a session's. */
  private tunnelCache = new Map<string, { role: Role; at: number }>();
  /** Pairing codes waiting to be used, by hash, with whose they are and when each stops working. */
  private pairing = new Map<string, { userId: string; until: number }>();
  readonly users: Users;
  /** Wrong passwords and pairing codes. */
  readonly throttle = new LoginThrottle();
  /** Wrong access keys, at sign-in and as a Bearer key. */
  readonly keyThrottle = new LoginThrottle();
  constructor(
    private db: Db,
    private key: string,
  ) {
    this.users = new Users(db);
  }

  checkKey(candidate: string): boolean {
    return sameSecret(candidate, this.key);
  }

  /**
   * A code that signs one more device in, once, within five minutes: typed on a phone or another
   * computer instead of the password or the access key. Only a signed-in device makes one, and
   * the new device signs in as the same person.
   */
  createPairingCode(userId: string, now = Date.now()): { code: string; expiresAt: string } {
    for (const [h, p] of this.pairing) if (p.until <= now) this.pairing.delete(h);
    // The oldest goes first when too many wait.
    while (this.pairing.size >= MAX_PAIRING_CODES) this.pairing.delete(this.pairing.keys().next().value!);
    const bytes = randomBytes(8);
    const raw = [...bytes].map((b) => PAIRING_ALPHABET[b % PAIRING_ALPHABET.length]).join('');
    const until = now + PAIRING_MS;
    this.pairing.set(hashSession(raw), { userId, until });
    return { code: `${raw.slice(0, 4)}-${raw.slice(4)}`, expiresAt: new Date(until).toISOString() };
  }

  /** Spends a pairing code: once, for a code that is still good, whose person it signs in as. */
  usePairingCode(code: string, now = Date.now()): string | null {
    const h = hashSession(normalizePairingCode(code));
    const p = this.pairing.get(h);
    if (p === undefined) return null;
    this.pairing.delete(h);
    return p.until > now ? p.userId : null;
  }

  async createSession(userId: string, userAgent?: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db
      .insert(schema.sessions)
      .values({ id: hashSession(token), userId, userAgent: userAgent ? userAgent.slice(0, 300) : null });
    return token;
  }

  /**
   * The person a token signs in as, when it belongs to a live session. A session is kept alive by
   * use: one unused for longer than SESSION_IDLE_MS ends, so a device left behind does not stay
   * signed in for ever. A disabled person's sessions stop working.
   */
  async validSession(token: string | undefined, now = new Date()): Promise<Principal | null> {
    if (!token) return null;
    const id = hashSession(token);
    const seen = this.cache.get(id);
    if (seen && now.getTime() - seen.at < 60_000)
      return { userId: seen.userId, role: seen.role, via: 'session' };
    const [row] = await this.db
      .select({ lastSeenAt: schema.sessions.lastSeenAt, user: schema.users })
      .from(schema.sessions)
      .innerJoin(schema.users, eq(schema.users.id, schema.sessions.userId))
      .where(eq(schema.sessions.id, id))
      .limit(1);
    if (!row || row.user.disabledAt) return null;
    if (now.getTime() - row.lastSeenAt.getTime() > SESSION_IDLE_MS) {
      await this.db.delete(schema.sessions).where(eq(schema.sessions.id, id));
      return null;
    }
    this.cache.set(id, { userId: row.user.id, role: row.user.role, at: now.getTime() });
    await this.db.update(schema.sessions).set({ lastSeenAt: now }).where(eq(schema.sessions.id, id));
    return { userId: row.user.id, role: row.user.role, via: 'session' };
  }

  /** A person's signed-in devices, the one asking marked, most recently used first. */
  async listSessions(current: string | undefined, userId: string): Promise<SessionInfo[]> {
    const mine = current ? hashSession(current) : null;
    const rows = await this.db
      .select()
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userId))
      .orderBy(desc(schema.sessions.lastSeenAt));
    const live = rows.filter((r) => Date.now() - r.lastSeenAt.getTime() <= SESSION_IDLE_MS);
    return live.map((r) => ({
      // A short public name: the stored id is a hash, but it is still what a token is checked against.
      id: r.id.slice(0, 16),
      userAgent: r.userAgent,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: r.lastSeenAt.toISOString(),
      current: r.id === mine,
    }));
  }

  /**
   * Signs out one of a person's devices, named by `id` (from listSessions), or every other one of
   * theirs with `others`.
   */
  async revokeSessions(
    current: string | undefined,
    userId: string,
    target: { id: string } | 'others',
  ): Promise<number> {
    const mine = current ? hashSession(current) : null;
    const rows = await this.db
      .select({ id: schema.sessions.id })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, userId));
    const gone = rows
      .map((r) => r.id)
      .filter((id) => id !== mine && (target === 'others' || id.slice(0, 16) === target.id));
    for (const id of gone) {
      this.cache.delete(id);
      await this.db
        .delete(schema.sessions)
        .where(and(eq(schema.sessions.id, id), eq(schema.sessions.userId, userId)));
    }
    return gone.length;
  }

  /**
   * Forgets what was remembered about a person's sessions, so a new role counts from their next
   * request; with `signOut`, ends every session and pairing code of theirs too.
   */
  async forgetPerson(userId: string, signOut: boolean) {
    for (const [id, seen] of this.cache) if (seen.userId === userId) this.cache.delete(id);
    this.tunnelCache.delete(userId);
    if (!signOut) return;
    for (const [h, p] of this.pairing) if (p.userId === userId) this.pairing.delete(h);
    await this.db.delete(schema.sessions).where(eq(schema.sessions.userId, userId));
  }

  async endSession(token: string | undefined) {
    if (!token) return;
    const id = hashSession(token);
    this.cache.delete(id);
    await this.db.delete(schema.sessions).where(eq(schema.sessions.id, id));
  }

  /**
   * The person a tunnelled connection was proven to be, remembered for a minute like a session.
   * A change made here (`forgetPerson`) takes effect at once. Null when they are gone or disabled.
   */
  async tunnelPrincipal(userId: string, now = Date.now()): Promise<Principal | null> {
    const seen = this.tunnelCache.get(userId);
    if (seen && now - seen.at < 60_000) return { userId, role: seen.role, via: 'tunnel' };
    const [row] = await this.db
      .select({ role: schema.users.role, disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!row || row.disabledAt) {
      this.tunnelCache.delete(userId);
      return null;
    }
    this.tunnelCache.set(userId, { role: row.role, at: now });
    return { userId, role: row.role, via: 'tunnel' };
  }

  /**
   * Bearer key or session cookie. With the address the request comes from, wrong Bearer keys
   * count against it like wrong passwords, and an address with too many is refused (429). The
   * access key is the owner's.
   */
  async authenticate(
    headers: { authorization?: string | undefined },
    cookie: string | undefined,
    from?: string,
  ): Promise<Principal | null> {
    const auth = headers.authorization;
    if (auth?.startsWith('Bearer ')) {
      const attempt = from === undefined ? null : this.keyThrottle.attempt(from, { shared: false });
      if (from !== undefined && !attempt) throw new HttpError(429, 'error.loginBlocked');
      if (!this.checkKey(auth.slice(7).trim())) return null;
      attempt?.succeeded();
      return { userId: OWNER_ID, role: 'owner', via: 'key' };
    }
    return this.validSession(cookie);
  }
}

export function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}
