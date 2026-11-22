import { createHash } from 'node:crypto';
import {
  MAX_CONNECTIONS,
  catalogEntry,
  connectionSlug,
  headerNameAllowed,
  sharesApp,
  type Connection,
  type ConnectionAuthStart,
  type ConnectionCreate,
  type ConnectionToolPatch,
  type ConnectionUpdate,
  type MailSender,
} from '@leafbot/shared';
import { and, asc, desc, eq, inArray, isNull, lt, ne, or } from 'drizzle-orm';
import {
  authFetch,
  callTool,
  classify,
  ConnectionClientError,
  dropClient,
  finishOAuth,
  joinScopes,
  listTools,
  offersSignIn,
  onToolsChanged,
  readAppResource,
  startOAuth,
  type AppResource,
  type ClientTarget,
  type ConnectionSecrets,
} from '../connections/client';
import type { CallToolResult, ElicitResult } from '@modelcontextprotocol/sdk/types.js';
import type { ElicitForm } from '../connections/elicit';
import { gmailSender, isGmailMcp, runGmailTool, withGmailTools } from '../connections/gmail';
import { inlinePictures } from '../connections/mail-signature';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { StoredConnectionTool } from '../db/schema';
import type { AppTool, ToolImage, ToolResult } from '../engine/types';
import type { T } from '../i18n';
import { HttpError, newId, truncate } from '../util';
import { managesServer } from './access';
import { serverTranslator } from './settings';
import type { VaultService } from './vault';

type Row = typeof schema.connections.$inferSelect;
/** An app a connection signs in as: registered by the person, or by this server with the service. */
type OwnClientLike = { client_id: string; client_secret?: string };

/** What a tool's answer may hand the model, in characters. */
const MAX_RESULT = 25_000;
/** How much of an answer kept in a file comes with its path. */
const PREVIEW = 4_000;
/** A sign-in not finished in this time is forgotten. */
const SIGNIN_TTL_MS = 15 * 60_000;
/** Tool names models accept: letters, digits, `_` and `-`, at most 64 in all. */
const MAX_TOOL_NAME = 64;

export const OAUTH_CALLBACK_PATH = '/api/connections/oauth/callback';
/** The catalog's GitHub, whose sign-in git on a bot's desktop may use. */
const GITHUB_CATALOG_ID = 'github';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
/** How long who a mail account sends as is kept before it is read again: a signature changes rarely. */
const SENDER_TTL_MS = 10 * 60_000;

/**
 * The OAuth callback as the app reaches this server. `host` is the already checked Host header.
 * Behind a TLS proxy the request arrives as plain HTTP, yet services refuse an `http://` callback
 * anywhere but on a loopback host, so a server set up for HTTPS (secure cookies) or told so by the
 * proxy names an `https://` callback. Loopback hosts keep the scheme the request came with.
 */
export function oauthRedirectUrl(req: {
  protocol: string;
  host: string;
  forwardedProto?: string | string[];
  secure: boolean;
}): string {
  const host = req.host.toLowerCase();
  const name = host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]!;
  const forwarded = [req.forwardedProto].flat()[0]?.split(',')[0]?.trim().toLowerCase();
  const https = !LOOPBACK_NAMES.has(name) && (req.secure || forwarded === 'https');
  return `${https ? 'https' : req.protocol}://${req.host}${OAUTH_CALLBACK_PATH}`;
}

/**
 * The name a server's tool goes under for the model, unique within its connection and short
 * enough for `mcp__<slug>__<name>`. Kept stable for the same list, so rules that name it hold.
 */
export function exposedNames(slug: string, names: string[]): Map<string, string> {
  const room = MAX_TOOL_NAME - `mcp__${slug}__`.length;
  const out = new Map<string, string>();
  const used = new Set<string>();
  for (const name of names) {
    let base = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, room) || 'tool';
    if (used.has(base)) {
      const hash = createHash('sha1').update(name).digest('hex').slice(0, 6);
      base = `${base.slice(0, room - 7)}_${hash}`;
    }
    used.add(base);
    out.set(name, base);
  }
  return out;
}

/**
 * The connections a person's work may use: the team's and their own. With null (a team
 * conversation), only the team's.
 */
const usable = (userId: string | null) =>
  userId
    ? or(isNull(schema.connections.userId), eq(schema.connections.userId, userId))!
    : isNull(schema.connections.userId);

/** How long a revocation request may take; the sign-in is already gone here either way. */
const REVOKE_MS = 5_000;

/** The shortest piece of a secret that is taken out; shorter values are not secrets. */
const MIN_SECRET = 8;

/**
 * Text with the given secret values taken out, and the start of one where the text was cut short
 * in the middle of it.
 */
export function maskSecrets(text: string, values: (string | null | undefined)[]): string {
  let out = text;
  for (const v of values) {
    if (!v || v.length < MIN_SECRET) continue;
    out = out.split(v).join('••••');
    for (let k = v.length - 1; k >= MIN_SECRET; k--) {
      const cut = /…$/.test(out) ? out.slice(0, -1) : out;
      if (cut.endsWith(v.slice(0, k))) {
        out = `${cut.slice(0, -k)}••••${cut === out ? '' : '…'}`;
        break;
      }
    }
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * A tool's input schema as model APIs take it: without `$schema`, which names a draft some refuse
 * inside a tool's parameters, and without `anyOf`/`oneOf`/`allOf` at the top, which some refuse
 * outright, failing the whole turn and not just the tool. Such alternatives become one object with
 * every field they name; a field is required when `allOf` or every alternative requires it.
 */
export function modelSchema(raw: Record<string, unknown>): Record<string, unknown> {
  return plainSubschemas(flattenTopLevel(raw));
}

/**
 * Keywords whose value is one subschema, and those holding a list of them. `true` and `false` are
 * valid JSON Schema in their place, but a model API that expects objects there (Gemini's among
 * them) rejects the whole tool list for one such value.
 */
const ONE_SUBSCHEMA = ['items', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'];
const MANY_SUBSCHEMAS = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];
const NAMED_SUBSCHEMAS = ['properties', 'patternProperties', '$defs', 'definitions'];

/**
 * A schema with `true`/`false` subschemas written as objects: `true` (anything) becomes `{}`, and
 * `false` (nothing) drops the property, alternative or keyword it stood for, since a field that
 * can never be given is no field. Everything else stays as it came.
 */
export function plainSubschemas(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...schema };
  const plain = (v: unknown): unknown => (isRecord(v) ? plainSubschemas(v) : v);
  for (const key of ONE_SUBSCHEMA) {
    if (!(key in out)) continue;
    const v = out[key];
    if (v === true && ['items', 'contains', 'propertyNames'].includes(key)) out[key] = {};
    else if (typeof v === 'boolean') delete out[key];
    else out[key] = plain(v);
  }
  for (const key of MANY_SUBSCHEMAS) {
    if (!Array.isArray(out[key])) continue;
    const list = (out[key] as unknown[]).filter((v) => v !== false).map((v) => (v === true ? {} : plain(v)));
    if (list.length) out[key] = list;
    else delete out[key];
  }
  const dropped = new Set<string>();
  for (const key of NAMED_SUBSCHEMAS) {
    if (!isRecord(out[key])) continue;
    const named: Record<string, unknown> = {};
    for (const [name, v] of Object.entries(out[key] as Record<string, unknown>)) {
      if (v === false) {
        if (key === 'properties') dropped.add(name);
      } else named[name] = v === true ? {} : plain(v);
    }
    out[key] = named;
  }
  if (dropped.size && Array.isArray(out.required)) {
    out.required = (out.required as unknown[]).filter((n) => typeof n !== 'string' || !dropped.has(n));
    if (!(out.required as unknown[]).length) delete out.required;
  }
  return out;
}

function flattenTopLevel(raw: Record<string, unknown>): Record<string, unknown> {
  const COMBINED = ['$schema', 'anyOf', 'oneOf', 'allOf'];
  const top = Object.fromEntries(Object.entries(raw).filter(([k]) => !COMBINED.includes(k)));
  // A branch may name a definition of the same schema; one named elsewhere cannot be merged.
  const defs = {
    ...(isRecord(raw.definitions) ? raw.definitions : {}),
    ...(isRecord(raw.$defs) ? raw.$defs : {}),
  };
  let unresolved = false;
  const resolve = (b: Record<string, unknown>): Record<string, unknown> => {
    if (typeof b.$ref !== 'string') return b;
    const m = /^#\/(?:\$defs|definitions)\/([^/]+)$/.exec(b.$ref);
    const found = m ? defs[m[1]!] : undefined;
    if (isRecord(found)) return found;
    unresolved = true;
    return b;
  };
  const branches = (key: string) => (Array.isArray(raw[key]) ? raw[key].filter(isRecord).map(resolve) : []);
  const alternatives = [...branches('anyOf'), ...branches('oneOf')];
  const all = branches('allOf');
  if (!alternatives.length && !all.length) return top;
  // Merging would leave the tool with fewer fields than it takes: the schema goes as it came.
  if (unresolved) return Object.fromEntries(Object.entries(raw).filter(([k]) => k !== '$schema'));
  const properties: Record<string, unknown> = { ...(isRecord(top.properties) ? top.properties : {}) };
  for (const branch of [...all, ...alternatives]) {
    const own = isRecord(branch.properties) ? branch.properties : {};
    for (const [name, field] of Object.entries(own)) if (!(name in properties)) properties[name] = field;
  }
  const required = new Set([...strings(top.required), ...all.flatMap((b) => strings(b.required))]);
  if (alternatives.length) {
    const [first, ...rest] = alternatives.map((b) => new Set(strings(b.required)));
    for (const name of first!) if (rest.every((r) => r.has(name))) required.add(name);
  }
  const out: Record<string, unknown> = { ...top, type: 'object', properties };
  if (required.size) out.required = [...required];
  else delete out.required;
  return out;
}

export class ConnectionService {
  constructor(
    private ctx: Ctx,
    private vault: VaultService,
  ) {
    // A server that says its tools changed has them listed again, so the bots see the new list.
    onToolsChanged((id) => void this.refresh(id).catch(() => undefined));
  }

  // ------------------------------------------------------------------------------ reading

  private secretsOf(row: Pick<Row, 'secrets'>): ConnectionSecrets {
    if (!row.secrets) return {};
    try {
      return JSON.parse(this.vault.open(row.secrets)) as ConnectionSecrets;
    } catch {
      // Sealed with a key this server no longer has: as if never signed in.
      return {};
    }
  }

  /** Who each mail connection sends as, read lately: the card asks for it with every mail it shows. */
  private senders = new Map<string, { at: number; value: MailSender }>();

  /**
   * Who a mail connection sends as, for the card that shows a mail before it goes. Nothing when
   * the service is not one this server can ask, or the asking fails: the card then goes without.
   */
  async mailSender(id: string): Promise<MailSender> {
    const none: MailSender = { address: null, signature: null };
    const row = await this.row(id);
    if (!isGmailMcp(row.url) || row.status !== 'connected') return none;
    const hit = this.senders.get(id);
    if (hit && Date.now() - hit.at < SENDER_TTL_MS) return hit.value;
    try {
      const found = await gmailSender(
        this.target(row),
        AbortSignal.timeout(this.ctx.config.mcpCallTimeoutMs),
      );
      const value = found.signature ? { ...found, signature: await inlinePictures(found.signature) } : found;
      this.senders.set(id, { at: Date.now(), value });
      return value;
    } catch (err) {
      console.warn('mail sender', err instanceof Error ? err.message : err);
      return none;
    }
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.ctx.db.select().from(schema.connections).where(eq(schema.connections.id, id));
    if (!row) throw new HttpError(404, 'error.notFound.connection');
    return row;
  }

  private async botIdsOf(ids: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>(ids.map((id) => [id, []]));
    if (!ids.length) return out;
    const rows = await this.ctx.db
      .select()
      .from(schema.botConnections)
      .where(inArray(schema.botConnections.connectionId, ids));
    for (const r of rows) out.get(r.connectionId)?.push(r.botId);
    return out;
  }

  private view(row: Row, botIds: string[]): Connection {
    const secrets = this.secretsOf(row);
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      catalogId: row.catalogId,
      url: row.url,
      auth: row.auth,
      status: row.status,
      error: row.error,
      hasToken: !!secrets.token,
      // The names only: what each is set to stays sealed.
      headerNames: Object.keys(secrets.headers ?? {}),
      clientId: secrets.ownClient?.client_id ?? null,
      clientName: (secrets.ownClient && secrets.ownClientName) || null,
      tools: row.tools.map((t) => ({
        name: t.name,
        title: t.title,
        description: t.description,
        hinted: t.hinted,
        kind: t.local ? 'write' : (t.kind ?? t.hinted),
        enabled: t.enabled,
        ...(t.ui && { app: true }),
      })),
      allBots: row.allBots,
      userId: row.userId,
      showApps: row.showApps,
      needsScope: !!secrets.oauth?.scopePending,
      botIds: row.allBots ? [] : botIds,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /** Every connection; with `userId`, the team's and that person's own. */
  /** Every connection; with a person, those they may use; with null, the team's alone. */
  async list(userId?: string | null): Promise<Connection[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.connections)
      .where(userId === undefined ? undefined : usable(userId))
      .orderBy(asc(schema.connections.createdAt));
    const bots = await this.botIdsOf(rows.map((r) => r.id));
    return rows.map((r) => this.view(r, bots.get(r.id) ?? []));
  }

  async get(id: string): Promise<Connection> {
    const row = await this.row(id);
    return this.view(row, (await this.botIdsOf([id])).get(id) ?? []);
  }

  // ------------------------------------------------------------------------------ changing

  /**
   * The scopes a sign-in asks for: the catalog's, else what the service gave or lists, together
   * with any a call was refused for. Nothing beyond the catalog's until a call needed more.
   */
  private signInScope(row: Pick<Row, 'catalogId'>, s: ConnectionSecrets): string | undefined {
    const base = catalogEntry(row.catalogId)?.scope;
    const want = s.oauth?.wantScope;
    if (!want) return base;
    const listed = (
      s.oauth?.discovery as { resourceMetadata?: { scopes_supported?: string[] } } | undefined
    )?.resourceMetadata?.scopes_supported?.join(' ');
    return joinScopes(base ?? s.oauth?.tokens?.scope ?? listed, want);
  }

  /**
   * Whether a connection may reach only public addresses: one of a person who may not point the
   * server at its own machine or network. The team's are added by those who look after it.
   */
  private async mustStayPublic(row: Pick<Row, 'userId'>): Promise<boolean> {
    if (!row.userId) return false;
    const [owner] = await this.ctx.db
      .select({ role: schema.users.role })
      .from(schema.users)
      .where(eq(schema.users.id, row.userId));
    return !owner || !managesServer(owner.role);
  }

  private target(row: Row): ClientTarget {
    let current = this.secretsOf(row);
    const headers = Object.keys(current.headers ?? {}).length
      ? createHash('sha256').update(JSON.stringify(current.headers)).digest('hex')
      : '';
    const version = `${row.url}|${row.auth}|${row.auth === 'token' ? (row.secrets ?? '') : ''}|${headers}`;
    let publicOnly: Promise<boolean> | undefined;
    return {
      id: row.id,
      url: row.url,
      auth: row.auth,
      version,
      scope: this.signInScope(row, current),
      scopeFixed: !!catalogEntry(row.catalogId)?.scope,
      publicOnly: () => (publicOnly ??= this.mustStayPublic(row)),
      store: {
        get: () => current,
        save: async (next) => {
          current = next;
          await this.ctx.db
            .update(schema.connections)
            .set({ secrets: this.vault.seal(JSON.stringify(next)) })
            .where(eq(schema.connections.id, row.id));
        },
        reload: async () => {
          const [now] = await this.ctx.db
            .select({ secrets: schema.connections.secrets })
            .from(schema.connections)
            .where(eq(schema.connections.id, row.id));
          if (now) current = this.secretsOf(now);
        },
      },
    };
  }

  /**
   * The request headers to keep for a connection: the list the person gave, each with the value
   * given or, when that is empty, the one saved under the same name (values never come back to be
   * shown, so an unchanged one is sent empty). Refuses a name the transport or the sign-in owns.
   */
  private headersOf(
    // As the request gives them: a value left out keeps the saved one.
    given: { name: string; value?: string }[],
    saved: Record<string, string>,
    auth: Row['auth'],
  ): Record<string, string> {
    const out: Record<string, string> = {};
    for (const h of given) {
      if (!headerNameAllowed(h.name, auth)) {
        throw new HttpError(
          400,
          h.name.toLowerCase() === 'authorization'
            ? 'error.connectionHeaderAuth'
            : 'error.connectionHeaderReserved',
          { name: h.name },
        );
      }
      const keptName = Object.keys(saved).find((k) => k.toLowerCase() === h.name.toLowerCase());
      const value = h.value || (keptName ? saved[keptName] : '');
      if (!value) throw new HttpError(400, 'error.connectionHeaderValue');
      out[h.name] = value;
    }
    return out;
  }

  private sealed(secrets: ConnectionSecrets): string | null {
    return Object.keys(secrets).length ? this.vault.seal(JSON.stringify(secrets)) : null;
  }

  private changed() {
    this.ctx.bus.refresh({ scope: 'connections' });
    // A GitHub sign-in may be what git on a bot's desktop uses (see `gitToken`).
    void this.ctx.computer?.refreshGit();
  }

  /** A new connection: `userId`'s own, or the team's when null. */
  async create(
    input: ConnectionCreate & { catalogId: string | null; allBots: boolean; botIds: string[] },
    userId: string | null,
  ): Promise<Connection> {
    const all = await this.ctx.db
      .select({ slug: schema.connections.slug, userId: schema.connections.userId })
      .from(schema.connections);
    // Counted per owner, the team's apart from each person's: one person's cannot use up the
    // room the team and everyone else have.
    if (all.filter((r) => r.userId === userId).length >= MAX_CONNECTIONS)
      throw new HttpError(400, 'error.connectionLimit', { max: MAX_CONNECTIONS });
    const secrets: ConnectionSecrets = {};
    if (input.auth === 'token') {
      if (!input.token) throw new HttpError(400, 'error.connectionToken');
      secrets.token = input.token;
    }
    if (input.headers?.length) secrets.headers = this.headersOf(input.headers, {}, input.auth);
    if (input.auth === 'oauth' && input.clientId) {
      secrets.ownClient = {
        client_id: input.clientId,
        ...(input.clientSecret ? { client_secret: input.clientSecret } : {}),
      };
      if (input.clientName) secrets.ownClientName = input.clientName;
    } else if (input.auth === 'oauth' && input.sameAppAs) {
      const sibling = await this.row(input.sameAppAs);
      // Another person's app registration is theirs: only the team's and one's own are shared.
      if (sibling.userId && sibling.userId !== userId) throw new HttpError(404, 'error.notFound.connection');
      if (!sharesApp(sibling, input)) throw new HttpError(400, 'error.connectionSibling');
      const { ownClient, ownClientName } = this.secretsOf(sibling);
      if (ownClient) secrets.ownClient = ownClient;
      if (ownClient && ownClientName) secrets.ownClientName = ownClientName;
    }
    const id = newId();
    await this.ctx.db.insert(schema.connections).values({
      id,
      userId,
      slug: connectionSlug(
        input.name,
        all.map((r) => r.slug),
      ),
      name: input.name,
      catalogId: catalogEntry(input.catalogId) ? input.catalogId : null,
      url: input.url,
      auth: input.auth,
      status: 'signed-out',
      secrets: this.sealed(secrets),
      allBots: input.allBots,
    });
    if (!input.allBots && input.botIds.length)
      await this.setBots(id, { allBots: false, botIds: input.botIds }, false);
    // A server that needs no sign-in, or has its token, is checked right away.
    if (input.auth !== 'oauth') await this.refresh(id);
    this.changed();
    return this.get(id);
  }

  async update(id: string, patch: ConnectionUpdate): Promise<Connection> {
    const row = await this.row(id);
    const secrets = this.secretsOf(row);
    const urlMoved = patch.url !== undefined && patch.url !== row.url;
    const moved = urlMoved || (patch.auth && patch.auth !== row.auth);
    // Another server, or another way in: nothing of the old sign-in goes to it. The headers belong
    // to the server, so another way in to the same one keeps them.
    const next: ConnectionSecrets = moved ? {} : { ...secrets };
    if (moved && !urlMoved && secrets.headers) next.headers = secrets.headers;
    if (patch.token !== undefined) {
      if (patch.token) next.token = patch.token;
      else delete next.token;
    }
    if (patch.clientId !== undefined) {
      if (patch.clientId) {
        const keepSecret =
          patch.clientId === secrets.ownClient?.client_id ? secrets.ownClient?.client_secret : undefined;
        const secret = patch.clientSecret ?? keepSecret;
        next.ownClient = { client_id: patch.clientId, ...(secret ? { client_secret: secret } : {}) };
      } else delete next.ownClient;
      // Tokens from another app don't belong to this one, nor does its name.
      if (patch.clientId !== (secrets.ownClient?.client_id ?? '')) {
        delete next.oauth;
        delete next.ownClientName;
      }
    }
    const auth = patch.auth ?? row.auth;
    if (patch.headers !== undefined) {
      const headers = this.headersOf(patch.headers, next.headers ?? {}, auth);
      if (Object.keys(headers).length) next.headers = headers;
      else delete next.headers;
    } else if (next.headers) {
      // Another way in may make a header the sign-in's own: it goes rather than fight the sign-in.
      const kept = Object.entries(next.headers).filter(([name]) => headerNameAllowed(name, auth));
      if (kept.length) next.headers = Object.fromEntries(kept);
      else delete next.headers;
    }
    if (auth === 'token' && !next.token) throw new HttpError(400, 'error.connectionToken');
    await this.ctx.db
      .update(schema.connections)
      .set({
        ...(patch.name !== undefined && { name: patch.name }),
        ...(patch.url !== undefined && { url: patch.url }),
        ...(patch.showApps !== undefined && { showApps: patch.showApps }),
        auth,
        secrets: this.sealed(next),
        // Another server's tool of the same name may do something else: its list starts over.
        ...(moved && { tools: [], status: 'signed-out' as const, error: null }),
        updatedAt: new Date(),
      })
      .where(eq(schema.connections.id, id));
    dropClient(id);
    // Another server's tools, not the same server reached another way: the rules go only then.
    if (patch.url !== undefined && patch.url !== row.url) await this.dropAllowRules(row.slug);
    const changedAccess =
      moved || patch.token !== undefined || patch.clientId !== undefined || patch.headers !== undefined;
    if (changedAccess && auth !== 'oauth') await this.refresh(id);
    else if (changedAccess && auth === 'oauth') await this.setStatus(id, 'signed-out', null);
    this.changed();
    return this.get(id);
  }

  async remove(id: string) {
    const row = await this.row(id);
    dropClient(id);
    await this.ctx.db.delete(schema.connections).where(eq(schema.connections.id, id));
    // A connection added later under the same name takes the same tool names.
    await this.dropAllowRules(row.slug);
    void this.revoke(row, this.secretsOf(row));
    this.changed();
  }

  /**
   * "Always allow" rules for this connection's tools were given for the server it reached: another
   * server's tool of the same name may do something else. "Always ask" and block rules stay, since
   * they only ever ask more.
   */
  private async dropAllowRules(slug: string) {
    const prefix = `mcp__${slug}__`;
    const gone = (
      await this.ctx.db
        .select({ id: schema.permissionRules.id, pattern: schema.permissionRules.pattern })
        .from(schema.permissionRules)
        .where(eq(schema.permissionRules.list, 'allow'))
    ).filter((r) => r.pattern.trim().startsWith(prefix));
    if (!gone.length) return;
    await this.ctx.db.delete(schema.permissionRules).where(
      inArray(
        schema.permissionRules.id,
        gone.map((r) => r.id),
      ),
    );
    this.ctx.bus.refresh({ scope: 'rules' });
  }

  /**
   * Asks the service to end a sign-in dropped here (RFC 7009), in the background: it is gone here
   * either way, and a service that cannot be reached is left as it is. Left out while another
   * connection holds a sign-in through the same registered app, since a service may end every
   * sign-in of an app and account at once.
   */
  private async revoke(row: Row, secrets: ConnectionSecrets): Promise<void> {
    try {
      const tokens = secrets.oauth?.tokens;
      const endpoint = (
        secrets.oauth?.discovery as
          { authorizationServerMetadata?: { revocation_endpoint?: string } } | undefined
      )?.authorizationServerMetadata?.revocation_endpoint;
      const client = secrets.ownClient ?? (secrets.oauth?.client as OwnClientLike | undefined);
      if (!tokens || !endpoint || !client?.client_id) return;
      if (secrets.ownClient) {
        const others = await this.ctx.db
          .select({ secrets: schema.connections.secrets })
          .from(schema.connections)
          .where(ne(schema.connections.id, row.id));
        const shared = others.some((o) => {
          const s = this.secretsOf(o);
          return s.ownClient?.client_id === client.client_id && !!s.oauth?.tokens;
        });
        if (shared) return;
      }
      const send = authFetch(this.target(row));
      const given: [string | undefined, string][] = [
        [tokens.refresh_token, 'refresh_token'],
        [tokens.access_token, 'access_token'],
      ];
      for (const [token, hint] of given) {
        if (!token) continue;
        const body = new URLSearchParams({ token, token_type_hint: hint, client_id: client.client_id });
        if (client.client_secret) body.set('client_secret', client.client_secret);
        const res = await send(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
          signal: AbortSignal.timeout(REVOKE_MS),
        });
        await res.body?.cancel();
      }
    } catch (err) {
      // Only the kind: a service's answer may quote the token it was sent.
      console.warn('connection revoke', err instanceof Error ? err.name : 'error');
    }
  }

  /** Text a service sent, without this connection's secrets in it: a service may quote what it got. */
  private async masked(id: string, text: string, extra: (string | undefined)[] = []): Promise<string> {
    const [row] = await this.ctx.db
      .select({ secrets: schema.connections.secrets })
      .from(schema.connections)
      .where(eq(schema.connections.id, id));
    const s = row ? this.secretsOf(row) : {};
    return maskSecrets(text, [
      s.token,
      s.ownClient?.client_secret,
      (s.oauth?.client as OwnClientLike | undefined)?.client_secret,
      s.oauth?.tokens?.access_token,
      s.oauth?.tokens?.refresh_token,
      ...Object.values(s.headers ?? {}),
      ...extra,
    ]);
  }

  /**
   * Why an OAuth sign-in ended, kept so a sign-in that drops on its own says why. A wrong token
   * needs no more than the status.
   */
  private async signOutReason(
    row: Pick<Row, 'id' | 'auth' | 'url'>,
    e: ConnectionClientError,
  ): Promise<string | null> {
    return row.auth === 'oauth' ? truncate(await this.masked(row.id, e.message), 500) : null;
  }

  /** What went wrong, as the person reads it under the connection. */
  private async failureText(
    row: Pick<Row, 'id' | 'url' | 'catalogId'>,
    e: ConnectionClientError,
  ): Promise<string> {
    const message = await this.masked(row.id, e.message);
    if (e.code !== 'forbidden') return truncate(message, 500);
    const t = await serverTranslator(this.ctx);
    const key =
      catalogEntry(row.catalogId)?.client?.family === 'google'
        ? 'connection.forbiddenGoogle'
        : 'connection.forbidden';
    const said = message.replace(/^HTTP 403:?\s*/, '');
    return truncate(`${t(key, { host: new URL(row.url).host })}${said ? `\n${said}` : ''}`, 500);
  }

  private async setStatus(id: string, status: Row['status'], error: string | null) {
    await this.ctx.db
      .update(schema.connections)
      .set({ status, error, updatedAt: new Date() })
      .where(eq(schema.connections.id, id));
  }

  /**
   * Lists the server's tools again; marks the connection by how that went. `quiet` is for a check
   * nobody asked for: a connection that works stays connected through a failure in passing, and
   * the next turn's call or retry finds out whether it lasts.
   */
  async refresh(id: string, { quiet = false }: { quiet?: boolean } = {}): Promise<Connection> {
    const row = await this.row(id);
    try {
      const tools = withGmailTools(row.url, await listTools(this.target(row), row.tools), row.tools);
      await this.ctx.db
        .update(schema.connections)
        .set({ tools, status: 'connected', error: null, updatedAt: new Date() })
        .where(eq(schema.connections.id, id));
    } catch (err) {
      const e = classify(err);
      if (e.code === 'unauthorized') await this.signInNeeded(row, e);
      else if (e.code === 'scope') await this.scopeNeeded(row);
      else if (quiet && row.status === 'connected') console.warn('connection refresh', e.code);
      else await this.setStatus(id, 'error', await this.failureText(row, e));
    }
    this.changed();
    return this.get(id);
  }

  /**
   * Marks a connection as one to sign in to again, with why. A server added as needing no sign-in
   * that asks for one becomes a sign-in connection, so the person gets a Sign in button rather
   * than a sign-out nothing can undo; unless it offers no sign-in at all (it wants an API key on
   * every path), when it becomes a connection that asks for a key, which a button could not give.
   * Gives the kind the connection has now.
   */
  private async signInNeeded(row: Row, e: ConnectionClientError): Promise<Row['auth']> {
    const auth =
      row.auth === 'none' ? ((await offersSignIn(this.target(row))) ? 'oauth' : 'token') : row.auth;
    if (auth !== row.auth) {
      await this.ctx.db.update(schema.connections).set({ auth }).where(eq(schema.connections.id, row.id));
    }
    const keyNeeded = auth === 'token' && row.auth === 'none';
    const reason = keyNeeded
      ? (await serverTranslator(this.ctx))('connection.needsKey', { host: new URL(row.url).host })
      : await this.signOutReason({ ...row, auth }, e);
    await this.setStatus(row.id, 'signed-out', reason);
    return auth;
  }

  /**
   * A call was refused for lack of scope: the connection stays as it is (its other tools may well
   * work) and says why, and its card offers a sign-in that asks again.
   */
  private async scopeNeeded(row: Pick<Row, 'id' | 'url'>) {
    const t = await serverTranslator(this.ctx);
    await this.ctx.db
      .update(schema.connections)
      .set({ error: t('connection.needsScope', { host: new URL(row.url).host }), updatedAt: new Date() })
      .where(eq(schema.connections.id, row.id));
  }

  /**
   * Lists again the tools of connections that are connected but were last looked at `maxAgeMs`
   * ago or longer, so tools a service added since show up and those it dropped go.
   */
  async refreshStale(maxAgeMs: number): Promise<number> {
    const rows = await this.ctx.db
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.status, 'connected'),
          lt(schema.connections.updatedAt, new Date(Date.now() - maxAgeMs)),
        ),
      );
    for (const r of rows) {
      await this.refresh(r.id, { quiet: true }).catch((err) => console.warn('connection refresh', err));
    }
    return rows.length;
  }

  async setTool(id: string, name: string, patch: ConnectionToolPatch): Promise<Connection> {
    const row = await this.row(id);
    if (!row.tools.some((t) => t.name === name)) throw new HttpError(404, 'error.notFound.connectionTool');
    const tools = row.tools.map((t) =>
      t.name === name
        ? {
            ...t,
            ...(patch.enabled !== undefined && { enabled: patch.enabled }),
            // The person calling a tool a read is kept even when the app says the same: for a
            // tool that takes an address, only their word makes it one where outside text could
            // be steering the bot.
            ...(patch.kind !== undefined && {
              kind: patch.kind === t.hinted && patch.kind !== 'read' ? null : patch.kind,
            }),
          }
        : t,
    );
    await this.ctx.db
      .update(schema.connections)
      .set({ tools, updatedAt: new Date() })
      .where(eq(schema.connections.id, id));
    this.changed();
    return this.get(id);
  }

  /** Gives a connection to a person, or to the team when null. */
  async setOwner(id: string, userId: string | null): Promise<Connection> {
    await this.row(id);
    await this.ctx.db.update(schema.connections).set({ userId }).where(eq(schema.connections.id, id));
    this.changed();
    return this.get(id);
  }

  /**
   * The sign-in of a GitHub app open to the bot, for git on its desktop when there is no GitHub key
   * of the same owner: a person who connected GitHub need not make a token for git as well. With
   * `owner`, that person's own app, for a command of a step that works for them; without, the
   * team's (see `ApiCredentialService.gitToken`). With several, the one changed last. Only the
   * computer service's relay gets it, and sends it to github.com alone.
   */
  async gitToken(botId: string, owner: string | null = null): Promise<string | null> {
    const github = catalogEntry(GITHUB_CATALOG_ID);
    const chosen = this.ctx.db
      .select({ id: schema.botConnections.connectionId })
      .from(schema.botConnections)
      .where(eq(schema.botConnections.botId, botId));
    const rows = await this.ctx.db
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.status, 'connected'),
          eq(schema.connections.auth, 'oauth'),
          owner ? eq(schema.connections.userId, owner) : isNull(schema.connections.userId),
          or(
            eq(schema.connections.catalogId, GITHUB_CATALOG_ID),
            eq(schema.connections.url, github?.url ?? ''),
          ),
          or(eq(schema.connections.allBots, true), inArray(schema.connections.id, chosen)),
        ),
      )
      .orderBy(desc(schema.connections.updatedAt));
    for (const row of rows) {
      const token = this.secretsOf(row).oauth?.tokens?.access_token;
      if (token && /^[\x21-\x7e]{1,1000}$/.test(token)) return token;
    }
    return null;
  }

  /** Opens a connection to every bot, or limits it to the given ones. */
  async setBots(
    id: string,
    access: { allBots: boolean; botIds: string[] },
    notify = true,
  ): Promise<Connection> {
    await this.row(id);
    const unique = access.allBots ? [] : [...new Set(access.botIds)];
    const known = unique.length
      ? await this.ctx.db
          .select({ id: schema.bots.id })
          .from(schema.bots)
          .where(inArray(schema.bots.id, unique))
      : [];
    if (known.length !== unique.length) throw new HttpError(404, 'error.notFound.bot');
    await this.ctx.db.transaction(async (tx) => {
      await tx
        .update(schema.connections)
        .set({ allBots: access.allBots })
        .where(eq(schema.connections.id, id));
      await tx.delete(schema.botConnections).where(eq(schema.botConnections.connectionId, id));
      if (unique.length)
        await tx.insert(schema.botConnections).values(unique.map((botId) => ({ botId, connectionId: id })));
    });
    if (notify) this.changed();
    return this.get(id);
  }

  // ------------------------------------------------------------------------------ sign-in

  /** Begins an OAuth sign-in; `redirectUrl` is this server's callback as the app reaches it. */
  async startSignIn(id: string, redirectUrl: string): Promise<ConnectionAuthStart> {
    const row = await this.row(id);
    if (row.auth !== 'oauth') return { url: null, connection: await this.refresh(id) };
    const entry = catalogEntry(row.catalogId);
    if (entry?.client && !this.secretsOf(row).ownClient && !entry.client.secretOptional) {
      throw new HttpError(400, 'error.connectionNeedsClient');
    }
    const target = this.target(row);
    // Asked to sign in while not connected, or after a call was refused for scope: a kept token
    // would only be renewed and turned down as before, so the sign-in starts afresh, with a new
    // consent.
    const kept = this.secretsOf(row);
    if ((row.status !== 'connected' || kept.oauth?.scopePending) && kept.oauth?.tokens) {
      const oauth = { ...kept.oauth };
      delete oauth.tokens;
      await target.store.save({ ...kept, oauth });
      dropClient(id);
    }
    let started;
    try {
      started = await startOAuth(target, redirectUrl);
    } catch (err) {
      const message = await this.masked(id, classify(err).message);
      await this.setStatus(id, 'error', truncate(message, 500));
      this.changed();
      throw new HttpError(502, 'error.connectionSignIn', { message: truncate(message, 300) });
    }
    if (!started) return { url: null, connection: await this.refresh(id) };
    // A sign-in begun earlier for the same connection ends: only the newest one may finish, so an
    // older page left open in another tab cannot sign the connection in as another account.
    await this.ctx.db
      .delete(schema.connectionSignins)
      .where(
        or(
          eq(schema.connectionSignins.connectionId, id),
          lt(schema.connectionSignins.createdAt, new Date(Date.now() - SIGNIN_TTL_MS)),
        ),
      );
    await this.ctx.db.insert(schema.connectionSignins).values({
      state: started.state,
      connectionId: id,
      verifier: this.vault.seal(started.verifier),
      redirectUrl,
    });
    return { url: started.url, connection: await this.get(id) };
  }

  /** Finishes a sign-in the service sent back to the callback. Returns the connection's name. */
  async finishSignIn(input: { state: string; code?: string; error?: string }): Promise<string> {
    const [pending] = await this.ctx.db
      .select()
      .from(schema.connectionSignins)
      .where(eq(schema.connectionSignins.state, input.state));
    if (!pending || pending.createdAt.getTime() < Date.now() - SIGNIN_TTL_MS) {
      throw new HttpError(400, 'error.connectionSignInExpired');
    }
    // A state is good for one answer.
    await this.ctx.db.delete(schema.connectionSignins).where(eq(schema.connectionSignins.state, input.state));
    const row = await this.row(pending.connectionId);
    if (input.error || !input.code) {
      throw new HttpError(400, 'error.connectionSignInRefused', {
        message: truncate(input.error ?? '', 200),
      });
    }
    const verifier = this.vault.open(pending.verifier);
    try {
      await finishOAuth(this.target(row), pending.redirectUrl, verifier, input.code);
    } catch (err) {
      // A token endpoint may quote the code and verifier it turned down.
      const message = await this.masked(row.id, classify(err).message, [input.code, verifier]);
      await this.setStatus(row.id, 'signed-out', truncate(message, 500));
      this.changed();
      throw new HttpError(502, 'error.connectionSignIn', { message: truncate(message, 300) });
    }
    await this.refresh(row.id);
    return row.name;
  }

  async signOut(id: string): Promise<Connection> {
    const row = await this.row(id);
    const secrets = this.secretsOf(row);
    // The person's own OAuth app is a setting of theirs and stays.
    const next: ConnectionSecrets = {
      ...(secrets.ownClient
        ? {
            ownClient: secrets.ownClient,
            ...(secrets.ownClientName ? { ownClientName: secrets.ownClientName } : {}),
          }
        : {}),
      // The headers are the person's setting for the server, not part of a sign-in.
      ...(secrets.headers ? { headers: secrets.headers } : {}),
    };
    await this.ctx.db
      .update(schema.connections)
      .set({ secrets: this.sealed(next), status: 'signed-out', error: null, updatedAt: new Date() })
      .where(eq(schema.connections.id, id));
    dropClient(id);
    void this.revoke(row, secrets);
    this.changed();
    return this.get(id);
  }

  // ------------------------------------------------------------------------------ tools for bots

  /** Each connection's name by the name its tools go under. */
  async names(): Promise<Map<string, string>> {
    const rows = await this.ctx.db
      .select({ slug: schema.connections.slug, name: schema.connections.name })
      .from(schema.connections);
    return new Map(rows.map((r) => [r.slug, r.name]));
  }

  private appPages = new Map<string, { page: AppResource | null; at: number }>();

  /** A tool's view page, kept ten minutes: the same view is shown at every call of its tool. */
  private async appResource(row: Row, uri: string): Promise<AppResource | null> {
    const key = `${row.id}|${uri}`;
    const known = this.appPages.get(key);
    if (known && Date.now() - known.at < 10 * 60_000) return known.page;
    const page = await readAppResource(this.target(row), uri);
    this.appPages.set(key, { page, at: Date.now() });
    return page;
  }

  /**
   * A call a tool's view makes from the conversation. Only to its own connection, open to the bot
   * whose turn showed it; a tool that reads runs, any other only for a bot allowed to act without
   * asking, the way the bot's own call would have gone without a card.
   */
  async callFromApp(o: {
    connectionId: string;
    bot: { id: string; permissionMode: string };
    name: string;
    args: Record<string, unknown>;
    /** The person using the app: a connection of someone else's is not theirs to call. */
    userId: string;
  }): Promise<CallToolResult> {
    const row = await this.row(o.connectionId);
    if (row.userId && row.userId !== o.userId) throw new HttpError(403, 'error.appUnavailable');
    if (row.status !== 'connected') throw new HttpError(409, 'error.appUnavailable');
    if (!row.allBots) {
      const [open] = await this.ctx.db
        .select()
        .from(schema.botConnections)
        .where(
          and(eq(schema.botConnections.botId, o.bot.id), eq(schema.botConnections.connectionId, row.id)),
        );
      if (!open) throw new HttpError(403, 'error.appUnavailable');
    }
    // A tool this server adds is the bot's alone, behind its card.
    const tool = row.tools.find((x) => x.name === o.name && x.enabled && !x.local);
    if (!tool) throw new HttpError(404, 'error.notFound');
    if ((tool.kind ?? tool.hinted) !== 'read' && o.bot.permissionMode !== 'auto') {
      throw new HttpError(403, 'error.appCallAsks');
    }
    return callTool(
      this.target(row),
      tool.name,
      o.args,
      AbortSignal.timeout(this.ctx.config.mcpCallTimeoutMs),
    );
  }

  /**
   * The tool a routine's check may call for a bot: of a connected app open to the bot, switched on,
   * and one that only reads. Null when it is not such a tool.
   */
  async checkTool(botId: string, connectionId: string, name: string, userId: string | null) {
    const [row] = await this.ctx.db
      .select()
      .from(schema.connections)
      .where(and(eq(schema.connections.id, connectionId), usable(userId)));
    if (!row) return null;
    if (!row.allBots) {
      const [open] = await this.ctx.db
        .select()
        .from(schema.botConnections)
        .where(and(eq(schema.botConnections.botId, botId), eq(schema.botConnections.connectionId, row.id)));
      if (!open) return null;
    }
    const tool = row.tools.find((x) => x.name === name && x.enabled && !x.appOnly && !x.local);
    if (!tool || (tool.kind ?? tool.hinted) !== 'read') return null;
    return { row, tool };
  }

  /**
   * The app tool a bot names the way it sees it (`mcp__<app>__<tool>`), as a routine's check: the
   * connection and the tool's own name, when it is one `checkTool` allows.
   */
  async checkFromName(
    botId: string,
    exposed: string,
    userId: string | null,
  ): Promise<{ connectionId: string; tool: string } | null> {
    // Claude sees an app's tool as `mcp__<app>__<tool>`; other engines see the tool's name alone.
    const m = /^mcp__([a-z0-9_]+?)__(.+)$/.exec(exposed);
    const rows = await this.ctx.db
      .select()
      .from(schema.connections)
      .where(m ? eq(schema.connections.slug, m[1]!) : undefined)
      .orderBy(asc(schema.connections.createdAt));
    const want = m ? m[2]! : exposed;
    const found: { connectionId: string; tool: string }[] = [];
    for (const row of rows) {
      const names = exposedNames(
        row.slug,
        row.tools.map((x) => x.name),
      );
      const tool = row.tools.find((x) => names.get(x.name) === want || x.name === want);
      if (tool && (await this.checkTool(botId, row.id, tool.name, userId)))
        found.push({ connectionId: row.id, tool: tool.name });
    }
    // Two apps with a tool of that name: the bot has to say which, with the app's part.
    return found.length === 1 ? found[0]! : null;
  }

  /**
   * Calls a routine's check, with no one watching: only a tool `checkTool` allows. Returns the
   * app's name and the answer as text; throws when the call cannot be made or the tool failed.
   */
  async callCheck(
    botId: string,
    check: { connectionId: string; tool: string; args: Record<string, unknown> },
    userId: string | null,
  ) {
    const found = await this.checkTool(botId, check.connectionId, check.tool, userId);
    if (!found) throw new HttpError(400, 'error.routineCheckTool');
    if (found.row.status !== 'connected') throw new HttpError(409, 'error.appUnavailable');
    const result = await callTool(
      this.target(found.row),
      found.tool.name,
      check.args,
      AbortSignal.timeout(this.ctx.config.mcpCallTimeoutMs),
    );
    const text = resultText(result);
    if (result.isError) throw new Error(truncate(text, 500));
    return { app: found.row.name, text };
  }

  /** The connections open to a bot that are not usable now, with why: their tools are left out. */
  async unavailableFor(
    botId: string,
    userId: string | null,
  ): Promise<{ name: string; status: 'signed-out' | 'error' }[]> {
    const chosen = this.ctx.db
      .select({ id: schema.botConnections.connectionId })
      .from(schema.botConnections)
      .where(eq(schema.botConnections.botId, botId));
    const rows = await this.ctx.db
      .select({ name: schema.connections.name, status: schema.connections.status })
      .from(schema.connections)
      .where(
        and(
          ne(schema.connections.status, 'connected'),
          usable(userId),
          or(eq(schema.connections.allBots, true), inArray(schema.connections.id, chosen)),
        ),
      )
      .orderBy(asc(schema.connections.createdAt));
    return rows.flatMap((r) => (r.status === 'connected' ? [] : [{ name: r.name, status: r.status }]));
  }

  /**
   * Tries again the connections that failed (a server down for a moment, a local one started after
   * this one) at least `minAgeMs` ago, so they come back without the person pressing Refresh.
   * Signed-out ones wait for the person: only a new sign-in helps them.
   */
  async retryFailed(minAgeMs: number): Promise<number> {
    const rows = await this.ctx.db
      .select({ id: schema.connections.id })
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.status, 'error'),
          lt(schema.connections.updatedAt, new Date(Date.now() - minAgeMs)),
        ),
      );
    for (const r of rows) await this.refresh(r.id).catch((err) => console.warn('connection retry', err));
    return rows.length;
  }

  /** The tools of the connections open to a bot, as the bot's own tools. */
  /** `elicit` answers a server that asks the person something during a call. */
  async toolsFor(
    botId: string,
    /** The person the bot works for: the team's connections and their own; null for the team's alone. */
    userId: string | null,
    t: T,
    signal: AbortSignal,
    elicit?: TurnElicit,
    /** Keeps an answer too long for the model as a file the bot can read; returns where it went. */
    keep?: KeepResult,
    /** Shows a tool's own view (an MCP app) in the conversation after it was called. */
    showApp?: ShowApp,
    /** Puts a Sign-in card in the conversation when a call finds its connection signed out. */
    showSignIn?: ShowSignIn,
  ): Promise<AppTool[]> {
    const chosen = this.ctx.db
      .select({ id: schema.botConnections.connectionId })
      .from(schema.botConnections)
      .where(eq(schema.botConnections.botId, botId));
    const rows = await this.ctx.db
      .select()
      .from(schema.connections)
      .where(
        and(
          eq(schema.connections.status, 'connected'),
          usable(userId),
          or(eq(schema.connections.allBots, true), inArray(schema.connections.id, chosen)),
        ),
      )
      .orderBy(asc(schema.connections.createdAt));
    // One card per connection for the turn: a bot that calls several tools in a row, or at once,
    // meets the same sign-out each time.
    const carded = new Set<string>();
    const signIn: ShowSignIn | undefined =
      showSignIn &&
      (async (c) => {
        if (carded.has(c.id)) return true;
        carded.add(c.id);
        const shown = await showSignIn(c).catch(() => false);
        if (!shown) carded.delete(c.id);
        return shown;
      });
    const out: AppTool[] = [];
    for (const row of rows) {
      // Named over the whole list, so turning one tool off never renames another.
      const names = exposedNames(
        row.slug,
        row.tools.map((x) => x.name),
      );
      // A tool meant for its view alone is not the bot's to call.
      const tools = row.tools.filter((x) => x.enabled && !x.appOnly);
      for (const tool of tools)
        out.push(this.appTool(row, tool, names.get(tool.name)!, t, signal, elicit, keep, showApp, signIn));
    }
    return out;
  }

  private appTool(
    row: Row,
    tool: StoredConnectionTool,
    exposed: string,
    t: T,
    signal: AbortSignal,
    elicit?: TurnElicit,
    keep?: KeepResult,
    showApp?: ShowApp,
    showSignIn?: ShowSignIn,
  ): AppTool {
    // A tool this server adds sends or changes mail: it always counts as a change, whatever it was set to.
    const kind = tool.local ? 'write' : (tool.kind ?? tool.hinted);
    const about = [tool.title, tool.description].filter(Boolean).join(' — ');
    return {
      name: exposed,
      server: row.slug,
      description: truncate(`[${row.name}] ${about}`, 4000),
      input: {},
      jsonSchema: modelSchema(tool.inputSchema),
      readOnly: kind === 'read',
      internal: false,
      handler: async (args) => {
        // Read again: the connection may have changed or gone since the turn began.
        const [current] = await this.ctx.db
          .select()
          .from(schema.connections)
          .where(eq(schema.connections.id, row.id));
        if (!current || current.status !== 'connected') {
          return t('connection.unavailable', { name: row.name });
        }
        try {
          const result = tool.local
            ? await runGmailTool(this.target(current), tool.name, args, signal)
            : await callTool(
                this.target(current),
                tool.name,
                args,
                signal,
                elicit && ((form) => elicit(form, row.name)),
              );
          if (tool.ui && current.showApps && showApp && !result.isError) {
            // The tool's own view joins the conversation; the bot's answer does not wait on it.
            void this.appResource(current, tool.ui)
              .then((page) =>
                page
                  ? showApp({
                      connectionId: row.id,
                      connection: row.name,
                      tool: tool.name,
                      page,
                      input: args,
                      result,
                    })
                  : undefined,
              )
              .catch((err) => console.warn('mcp app view', err));
          }
          return await toResult(result, t, keep && ((text) => keep(`${row.slug}-${tool.name}`, text)));
        } catch (err) {
          const e = err instanceof ConnectionClientError ? err : classify(err);
          if (e.code === 'scope') {
            await this.scopeNeeded(current);
            this.changed();
            return t('connection.needsScopeCall', { name: row.name });
          }
          if (e.code === 'unauthorized') {
            // A server that lists its tools to anyone but wants a sign-in for calls becomes a
            // sign-in connection (see signInNeeded).
            const auth = await this.signInNeeded(current, e);
            this.changed();
            // The person is told in the conversation, where the card is the way to fix it.
            const card = await showSignIn?.({ id: row.id, name: row.name, auth }).catch(() => false);
            if (card)
              return t(auth === 'token' ? 'connection.needsKeyCard' : 'connection.signedOutCard', {
                name: row.name,
              });
            return t('connection.signedOutCall', { name: row.name });
          }
          return t('connection.callFailed', { name: row.name, message: await this.failureText(row, e) });
        }
      },
    };
  }
}

/**
 * An app's answer as plain text, for comparing one check with the next: the text parts, or the
 * structured answer when there is no text. Pictures and other media are left out.
 */
export function resultText(result: CallToolResult): string {
  const parts = (result.content ?? []).flatMap((c) =>
    c.type === 'text'
      ? [c.text]
      : c.type === 'resource' && 'text' in c.resource
        ? [String(c.resource.text)]
        : [],
  );
  if (parts.length) return parts.join('\n');
  return result.structuredContent ? JSON.stringify(result.structuredContent) : '';
}

/** A tool's view and the call it shows, for the conversation. */
export interface AppView {
  connectionId: string;
  connection: string;
  tool: string;
  page: AppResource;
  input: Record<string, unknown>;
  result: CallToolResult;
}
export type ShowApp = (view: AppView) => Promise<void>;

/**
 * Puts a card in the conversation where the person can sign in to a connection (or enter its
 * key, for `token`). Says whether one was shown.
 */
export type ShowSignIn = (c: { id: string; name: string; auth: Row['auth'] }) => Promise<boolean>;

/** Puts a connection's question to the person in the chat of the turn that made the call. */
export type TurnElicit = (form: ElicitForm, connection: string) => Promise<ElicitResult>;

/** Writes a long answer to a file and gives back its path. */
export type KeepResult = (name: string, text: string) => Promise<string>;

/**
 * A tool's answer as text (and pictures) for the model. An answer longer than the model should
 * read at once is kept whole in a file when `keep` is given, and its start comes with the path.
 */
export async function toResult(
  result: {
    content?: unknown[];
    structuredContent?: unknown;
    isError?: boolean;
  },
  t: T,
  keep?: (text: string) => Promise<string>,
): Promise<ToolResult> {
  const texts: string[] = [];
  const images: ToolImage[] = [];
  for (const raw of result.content ?? []) {
    const c = raw as { type?: string; text?: string; data?: string; mimeType?: string; resource?: unknown };
    if (c.type === 'text' && typeof c.text === 'string') texts.push(c.text);
    else if (c.type === 'image' && c.data && c.mimeType) images.push({ data: c.data, mimeType: c.mimeType });
    else if (c.type === 'resource' || c.type === 'resource_link') texts.push(JSON.stringify(c.resource ?? c));
  }
  if (!texts.length && result.structuredContent !== undefined)
    texts.push(JSON.stringify(result.structuredContent));
  let text = texts.join('\n\n');
  if (text.length > MAX_RESULT) {
    const path = keep ? await keep(text).catch(() => null) : null;
    text = path
      ? `${text.slice(0, PREVIEW)}\n${t('connection.resultKept', { path, size: String(text.length) })}`
      : `${text.slice(0, MAX_RESULT)}\n${t('connection.resultCut')}`;
  }
  if (result.isError) text = t('connection.toolError', { message: text || '-' });
  if (!text && !images.length) text = t('connection.emptyResult');
  return images.length ? { text, images: images.slice(0, 4) } : text;
}
