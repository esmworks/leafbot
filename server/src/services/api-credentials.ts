import {
  ApiAuth,
  ApiCredentialCreate,
  ApiCredentialUpdate,
  ApiKeyImport,
  TrapKeyCreate,
  type ApiKeyImportResult,
  type ApiCredential,
  type ApiCredentialCreate as CreateInput,
  type ApiCredentialUpdate as UpdateInput,
} from '@leafbot/shared';
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, newId, notFound } from '../util';
import { publicDispatcher } from '../connections/client';
import { keptPublic, refusePrivate } from './access';
import { privateHost } from './skill-link';
import type { VaultService } from './vault';
import { envEntries } from './vault-import';

/**
 * The key name a `.env` entry would get: lower case, with the usual endings that only say it is a
 * key taken off (`OPENWEATHER_API_KEY` is `openweather`).
 */
export function keyNameOf(env: string): string {
  const base = env
    .toLowerCase()
    .replace(/[_-]?(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|secret|key)$/, '')
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
  return (
    base ||
    env
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '_')
      .replace(/^[_-]+/, '') ||
    'key'
  ).slice(0, 64);
}

type Row = typeof schema.apiCredentials.$inferSelect;

/** The origin of a key that git on a bot's desktop uses for GitHub. */
export const GITHUB_ORIGIN = 'https://github.com';

/**
 * What a key is bound to when sealed: its row and the origin it is sent to. A key moved to another
 * row, or left in a row whose origin was changed in the database, no longer opens, so it is never
 * sent anywhere but where it was saved for.
 */
const keyBinding = (id: string, origin: string) => ['api_credentials.secret', id, origin];

/** The keys a person may use: the team's and their own; with null (a team conversation), the team's. */
const usableBy = (userId: string | null) =>
  userId
    ? or(isNull(schema.apiCredentials.userId), eq(schema.apiCredentials.userId, userId))!
    : isNull(schema.apiCredentials.userId);

/** Rows of `owner` alone: a person's own, or the team's for null. */
const ownedBy = (owner: string | null) =>
  owner ? eq(schema.apiCredentials.userId, owner) : isNull(schema.apiCredentials.userId);

/**
 * One key per name, as a bot sees them: a person's own outranks the team's under the same name, so
 * someone can use their own account where the team keeps a shared one.
 */
function ownFirst(rows: Row[]): Row[] {
  const byName = new Map<string, Row>();
  for (const r of rows) {
    const had = byName.get(r.name);
    if (!had || (!had.userId && r.userId)) byName.set(r.name, r);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const toCredential = (r: Row): ApiCredential => ({
  id: r.id,
  name: r.name,
  origin: r.origin,
  auth: ApiAuth.parse(r.auth),
  label: r.label,
  botIds: r.botIds ?? null,
  userId: r.userId,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
  lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
  trap: r.trap,
});

/**
 * The address a trap key pretends to be at: on `.internal`, which is set aside for private networks
 * and is never in the public name system, so nothing real answers there and no one can register
 * it. Unlike `.invalid` or `.example`, it looks like what a team's own gateway or proxy is called,
 * so a bot has no reason to treat the key differently from its real ones.
 */
export function trapOrigin(name: string): string {
  const label =
    name
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 30) || 'service';
  return `https://api.${label}-${randomBytes(4).toString('hex')}.internal`;
}

/** The most of a response a bot is given; the rest is cut, and it is told so. */
export const MAX_RESPONSE_CHARS = 20_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** Headers the bot may not set: the key goes in the server's own, and these steer the connection. */
const RESERVED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
  'connection',
  'transfer-encoding',
]);

export interface ApiCall {
  method: string;
  url: string;
  headers?: Record<string, string>;
  /** JSON (an object or array) is sent as JSON; a string as it is. */
  body?: unknown;
}

export interface ApiResult {
  status: number;
  /** The response's content type, as the service said it. */
  type: string;
  /** The response text with the key taken out; cut at MAX_RESPONSE_CHARS. */
  body: string;
  cut: boolean;
  /** Where a redirect pointed; it is not followed, so the key does not go there. */
  location: string | null;
}

/** Why a call was refused before it left: the bot is told in its own words. */
export class ApiCallError extends Error {
  constructor(
    readonly reason: 'noKey' | 'notAllowed' | 'badUrl' | 'origin' | 'header' | 'private',
    readonly detail = '',
  ) {
    super(reason);
  }
}

/**
 * API keys the person saved, for bots to call services with. A bot names the key; the server adds
 * it to a request only when the request goes to the key's own origin, and takes it out of whatever
 * comes back. No key reaches a bot, its prompt or a message.
 */
export class ApiCredentialService {
  constructor(
    private ctx: Ctx,
    private vault: VaultService,
    private fetcher: typeof fetch = fetch,
  ) {}

  /** Every key; with `userId`, the team's and that person's own. */
  async list(userId?: string): Promise<ApiCredential[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.apiCredentials)
      .where(userId ? usableBy(userId) : undefined)
      .orderBy(asc(schema.apiCredentials.name));
    return rows.map(toCredential);
  }

  async get(id: string): Promise<ApiCredential> {
    return toCredential(await this.row(id));
  }

  /**
   * The keys a bot may use while it works for `userId` (null in a team conversation): one per name,
   * the person's own before the team's.
   */
  async forBot(botId: string, userId: string | null): Promise<ApiCredential[]> {
    return (await this.usable(botId, userId)).map(toCredential);
  }

  private async usable(botId: string, userId: string | null): Promise<Row[]> {
    const rows = await this.ctx.db.select().from(schema.apiCredentials).where(usableBy(userId));
    return ownFirst(rows.filter((r) => !r.botIds || r.botIds.includes(botId)));
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.apiCredentials)
      .where(eq(schema.apiCredentials.id, id))
      .limit(1);
    if (!row) throw notFound('apiKey');
    return row;
  }

  /** The key `owner` keeps under `name`: a person's own, or the team's for null. */
  async owned(name: string, owner: string | null): Promise<ApiCredential | null> {
    const row = await this.byName(name, owner);
    return row ? toCredential(row) : null;
  }

  /** The trap keys a person made, for the trip-wire check. */
  async traps(userId: string): Promise<{ name: string; origin: string; botIds: string[] | null }[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.apiCredentials)
      .where(and(eq(schema.apiCredentials.userId, userId), eq(schema.apiCredentials.trap, true)));
    return rows.map((r) => ({ name: r.name, origin: r.origin, botIds: r.botIds ?? null }));
  }

  /**
   * Makes a trap key for `userId`: a name, and an address the server makes up. It stores no real
   * secret. It is always the person's own, and it may not take the name of a key already usable
   * by them (a team key of that name would be hidden behind it, and a bot would see one key where
   * there were two).
   */
  async createTrap(raw: TrapKeyCreate, userId: string): Promise<ApiCredential> {
    const input = TrapKeyCreate.parse(raw);
    const taken = await this.ctx.db
      .select({ id: schema.apiCredentials.id })
      .from(schema.apiCredentials)
      .where(and(eq(schema.apiCredentials.name, input.name), usableBy(userId)))
      .limit(1);
    if (taken.length) throw new HttpError(409, 'error.trapKeyNameTaken');
    const id = newId();
    const origin = trapOrigin(input.name);
    const [row] = await this.ctx.db
      .insert(schema.apiCredentials)
      .values({
        id,
        userId,
        name: input.name,
        origin,
        auth: { type: 'bearer' },
        label: '',
        secret: this.vault.seal('trap', keyBinding(id, origin)),
        botIds: input.botIds ?? null,
        trap: true,
      })
      .returning();
    this.ctx.bus.refresh({ scope: 'info' });
    return toCredential(row!);
  }

  private async byName(name: string, owner: string | null): Promise<Row | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.apiCredentials)
      .where(and(eq(schema.apiCredentials.name, name.trim().toLowerCase()), ownedBy(owner)))
      .limit(1);
    return row ?? null;
  }

  /** Keys saved before they were bound to row and origin, bound now. */
  private ready(): Promise<void> {
    return this.vault.bindOnce('api_credentials', async () => {
      const rows = await this.ctx.db.select().from(schema.apiCredentials);
      for (const r of rows) {
        const secret = this.vault.rebind(r.secret, keyBinding(r.id, r.origin));
        if (!secret) continue;
        await this.ctx.db
          .update(schema.apiCredentials)
          .set({ secret })
          .where(eq(schema.apiCredentials.id, r.id));
      }
    });
  }

  /** Saves a key, `userId`'s own or the team's when null. */
  async create(raw: CreateInput, userId: string | null): Promise<ApiCredential> {
    const input = ApiCredentialCreate.parse(raw);
    await refusePrivate(this.ctx, input.origin, userId);
    if (await this.byName(input.name, userId)) throw new HttpError(409, 'error.apiKeyNameTaken');
    const id = newId();
    const [row] = await this.ctx.db
      .insert(schema.apiCredentials)
      .values({
        id,
        userId,
        name: input.name,
        origin: input.origin,
        auth: input.auth,
        label: input.label,
        secret: this.vault.seal(input.value, keyBinding(id, input.origin)),
        botIds: input.botIds ?? null,
      })
      .returning();
    this.ctx.bus.refresh({ scope: 'info' });
    this.keysChanged();
    return toCredential(row!);
  }

  /**
   * Saves the key a person typed on a bot's card under its name, for `owner`: a new one, or a new
   * value (and origin and way of sending) for the one `owner` already keeps under that name. Saved as
   * a person's own, the team's key of that name is never touched; theirs outranks it from then on.
   * The team (null) is the owner only when one who looks after the server chose it on the card. The
   * bots that may use an existing key stay as they were.
   */
  async put(raw: CreateInput, owner: string | null): Promise<ApiCredential> {
    const input = ApiCredentialCreate.parse(raw);
    const existing = await this.byName(input.name, owner);
    if (!existing) return this.create(input, owner);
    return this.update(existing.id, {
      origin: input.origin,
      auth: input.auth,
      value: input.value,
      ...(input.label && { label: input.label }),
    });
  }

  /** Changes a key; `owner` moves it to that person, or to the team when null. */
  async update(id: string, raw: UpdateInput, owner?: string | null): Promise<ApiCredential> {
    const input = ApiCredentialUpdate.parse(raw);
    await this.ready();
    const old = await this.row(id);
    // A trap key stays what it was made as: only the bots it is shown to and its label change.
    if (
      old.trap &&
      (input.origin !== undefined ||
        input.auth !== undefined ||
        input.value !== undefined ||
        (owner !== undefined && owner !== old.userId))
    )
      throw new HttpError(409, 'error.apiKeyTrap');
    const origin = input.origin ?? old.origin;
    if (input.origin !== undefined || (owner !== undefined && owner !== old.userId)) {
      await refusePrivate(this.ctx, origin, owner === undefined ? old.userId : owner);
    }
    // A new origin needs the key bound to it: a key not typed anew is sealed again for it.
    const secret =
      input.value !== undefined
        ? this.vault.seal(input.value, keyBinding(id, origin))
        : origin !== old.origin
          ? this.vault.reseal(old.secret, keyBinding(id, old.origin), keyBinding(id, origin))
          : undefined;
    if (owner !== undefined && owner !== old.userId && (await this.byName(old.name, owner)))
      throw new HttpError(409, 'error.apiKeyNameTaken');
    const [row] = await this.ctx.db
      .update(schema.apiCredentials)
      .set({
        ...(input.origin !== undefined && { origin: input.origin }),
        ...(input.auth !== undefined && { auth: input.auth }),
        ...(input.label !== undefined && { label: input.label }),
        ...(secret !== undefined && { secret }),
        ...(input.botIds !== undefined && { botIds: input.botIds }),
        ...(owner !== undefined && { userId: owner }),
        updatedAt: new Date(),
      })
      .where(eq(schema.apiCredentials.id, id))
      .returning();
    this.ctx.bus.refresh({ scope: 'info' });
    this.keysChanged();
    return toCredential(row!);
  }

  /**
   * Keys from a `.env` file, for `userId` or the team when null. Without `keys` it only names the
   * file's entries; with them, each chosen entry is saved under its name for its origin, unless the
   * owner already has a key by that name. A value never comes back.
   */
  async importEnv(raw: ApiKeyImport, userId: string | null): Promise<ApiKeyImportResult> {
    const input = ApiKeyImport.parse(raw);
    const entries = envEntries(input.env);
    const result: ApiKeyImportResult = {
      entries: entries.map((e) => ({ line: e.line, env: e.name, name: keyNameOf(e.name) })),
      saved: [],
      skipped: [],
    };
    for (const k of input.keys ?? []) {
      const entry = entries.find((e) => e.name === k.env);
      if (!entry || entry.value.length > 8000) {
        result.skipped.push({ env: k.env, reason: 'missing' });
        continue;
      }
      if (await this.byName(k.name, userId)) {
        result.skipped.push({ env: k.env, reason: 'exists' });
        continue;
      }
      await this.create(
        {
          name: k.name,
          origin: k.origin,
          auth: k.auth,
          label: k.label,
          value: entry.value,
          botIds: input.botIds,
        },
        userId,
      );
      result.saved.push(k.name);
    }
    return result;
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.ctx.db.delete(schema.apiCredentials).where(eq(schema.apiCredentials.id, id));
    this.ctx.bus.refresh({ scope: 'info' });
    this.keysChanged();
  }

  /**
   * Calls a service with the key saved under `name`, for a bot that may use it while it works for
   * `userId` (null in a team conversation): that person's own key under the name, else the team's.
   * The request must go to the key's origin; redirects are not followed, since a header of the
   * service's own (unlike Authorization) would be carried to wherever the redirect points.
   */
  async call(
    botId: string,
    userId: string | null,
    name: string,
    req: ApiCall,
    signal?: AbortSignal,
  ): Promise<ApiResult> {
    await this.ready();
    const key = name.trim().toLowerCase();
    const named = (
      await this.ctx.db
        .select()
        .from(schema.apiCredentials)
        .where(and(eq(schema.apiCredentials.name, key), usableBy(userId)))
    ).filter((r) => !r.botIds || r.botIds.includes(botId));
    const row = ownFirst(named)[0];
    // A trap key never sends anything anywhere; the turn manager has already stopped the bot that
    // names one, this is the last line if a call gets here by another way.
    if (row?.trap) throw new ApiCallError('noKey', name);
    if (!row) {
      const any = await this.ctx.db
        .select({ id: schema.apiCredentials.id })
        .from(schema.apiCredentials)
        .where(and(eq(schema.apiCredentials.name, key), usableBy(userId)))
        .limit(1);
      throw new ApiCallError(any.length ? 'notAllowed' : 'noKey', name);
    }
    const auth = ApiAuth.parse(row.auth);
    const value = this.vault.open(row.secret, keyBinding(row.id, row.origin));
    const result = await this.send(
      row.origin,
      { auth, value },
      req,
      signal,
      await keptPublic(this.ctx, row.userId),
    );
    await this.ctx.db
      .update(schema.apiCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiCredentials.id, row.id));
    return result;
  }

  /** The desktops' git keeps up with a key that was added, changed or removed, without waiting. */
  private keysChanged() {
    void this.ctx.computer?.refreshGit();
  }

  /**
   * The key git on the bot's desktop uses for GitHub: one of the team's saved for
   * `https://github.com` that the bot may use. With several, the one saved or changed last: it is the
   * one someone just typed because git failed, while an older one may have expired or been revoked.
   * With `owner`, that person's own key alone, for a command of a step that works for them; without,
   * the team's, which the desktop keeps for everything else (the desktop is the bot's, and everyone
   * who talks with it works on it). Only the computer service's relay gets it, and sends it to
   * GitHub alone, the origin it was saved for; the server asks GitHub's API once with it which
   * account it is, so the commits pushed with it carry that account (see github-author.ts).
   */
  async gitToken(botId: string, owner: string | null = null): Promise<string | null> {
    await this.ready();
    const rows = await this.ctx.db
      .select()
      .from(schema.apiCredentials)
      .where(and(eq(schema.apiCredentials.origin, GITHUB_ORIGIN), ownedBy(owner)))
      .orderBy(desc(schema.apiCredentials.updatedAt), asc(schema.apiCredentials.name));
    const row = rows.find((r) => !r.botIds || r.botIds.includes(botId));
    if (!row) return null;
    const value = this.vault.open(row.secret, keyBinding(row.id, row.origin));
    return value && /^[\x21-\x7e]{1,1000}$/.test(value) ? value : null;
  }

  /** A call to `origin` with no key, for an API the person added that needs none. */
  callOpen(origin: string, req: ApiCall, signal?: AbortSignal): Promise<ApiResult> {
    return this.send(origin, null, req, signal);
  }

  private async send(
    origin: string,
    key: { auth: ApiAuth; value: string } | null,
    req: ApiCall,
    signal?: AbortSignal,
    publicOnly = false,
  ): Promise<ApiResult> {
    let url: URL;
    try {
      url = new URL(req.url, origin);
    } catch {
      throw new ApiCallError('badUrl', req.url);
    }
    if (url.origin !== origin || url.username || url.password) throw new ApiCallError('origin', origin);
    // Looked at again as it is sent, for a key saved before this was checked or a name that has
    // since moved; then connected only to the addresses that lookup found public.
    if (publicOnly && (await privateHost(url.hostname))) throw new ApiCallError('private', url.host);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lower = k.toLowerCase();
      if (
        RESERVED_HEADERS.has(lower) ||
        (key?.auth.type === 'header' && lower === key.auth.header.toLowerCase())
      ) {
        throw new ApiCallError('header', k);
      }
      headers.set(k, v);
    }
    if (key?.auth.type === 'bearer') headers.set('authorization', `Bearer ${key.value}`);
    if (key?.auth.type === 'header') headers.set(key.auth.header, key.value);
    if (key?.auth.type === 'basic') {
      headers.set(
        'authorization',
        `Basic ${Buffer.from(`${key.auth.username}:${key.value}`).toString('base64')}`,
      );
    }
    if (key?.auth.type === 'query') url.searchParams.set(key.auth.param, key.value);
    let body: string | undefined;
    if (req.body !== undefined && req.body !== null) {
      if (typeof req.body === 'string') body = req.body;
      else {
        body = JSON.stringify(req.body);
        if (!headers.has('content-type')) headers.set('content-type', 'application/json');
      }
    }
    const method = req.method.toUpperCase();
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const res = await this.fetcher(url, {
      method,
      headers,
      body: method === 'GET' || method === 'HEAD' ? undefined : body,
      redirect: 'manual',
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      ...(publicOnly && { dispatcher: publicDispatcher() }),
    } as RequestInit);
    const text = await readLimited(res, MAX_RESPONSE_BYTES);
    const clean = key ? scrub(text, key.value, key.auth) : text;
    const location = res.headers.get('location');
    return {
      status: res.status,
      type: res.headers.get('content-type') ?? '',
      body: clean.slice(0, MAX_RESPONSE_CHARS),
      cut: clean.length > MAX_RESPONSE_CHARS,
      location: location ? (key ? scrub(location, key.value, key.auth) : location) : null,
    };
  }
}

/** A response's text, read no further than `max` bytes. */
async function readLimited(res: Response, max: number): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    if (size >= max) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** `text` with the key taken out, in every form a service might echo it back. */
export function scrub(text: string, value: string, auth: ApiAuth): string {
  const forms = new Set([value, encodeURIComponent(value)]);
  if (auth.type === 'basic') forms.add(Buffer.from(`${auth.username}:${value}`).toString('base64'));
  let out = text;
  // Short values would take ordinary words out with them; a real key is never that short.
  for (const f of forms) if (f.length >= 6) out = out.split(f).join('[key]');
  return out;
}
