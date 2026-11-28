import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  auth,
  discoverOAuthServerInfo,
  extractResourceMetadataUrl,
  type OAuthClientProvider,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import {
  ElicitRequestSchema,
  McpError,
  type CallToolResult,
  type ElicitResult,
  type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
  OAuthError,
  ServerError,
  TemporarilyUnavailableError,
  TooManyRequestsError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { ElicitForm } from './elicit';
import { MAX_CONNECTION_TOOLS, type MailSettings } from '@leafbot/shared';
import type { StoredConnectionTool } from '../db/schema';
import { Agent } from 'undici';
import { privateHost, publicLookup } from '../services/skill-link';

/**
 * This server as an MCP client of a connection's server. Each connection keeps a few clients, one
 * per call under way, so a long call or a question waiting for the person holds up no other call;
 * an unused client closes after IDLE_MS, and all close when the connection changes. Sign-ins and
 * token renewals run one at a time per connection, so two calls can't both spend a refresh token
 * that may be used only once.
 */

/** An OAuth app registered with a service beforehand, which this server signs in as. */
export interface OwnClient {
  client_id: string;
  client_secret?: string;
}

/** What a connection keeps sealed. */
export interface ConnectionSecrets {
  token?: string;
  /**
   * Request headers the person set for this server (an API key under the name the service wants),
   * by name. Sealed like the token: they never go back to a client or into a bot's context.
   */
  headers?: Record<string, string>;
  ownClient?: OwnClient;
  /** What the person called `ownClient`, so accounts can pick it by name. */
  ownClientName?: string;
  /** A mail account's servers and address (see `MailSettings`); its password is `token`. */
  mail?: MailSettings;
  oauth?: {
    client?: OAuthClientInformationMixed;
    tokens?: OAuthTokens;
    discovery?: unknown;
    /** The redirect address the sign-in used; a refresh must name the same one. */
    redirectUrl?: string;
    /**
     * Scopes the service said a call needs beyond what the sign-in gave (a 403 with
     * `insufficient_scope`); the next sign-in asks for them too.
     */
    wantScope?: string;
    /** A call was refused for lack of scope since the last sign-in the person made. */
    scopePending?: boolean;
  };
}

/** Reads and saves one connection's secrets (sealed by the caller). */
export interface SecretStore {
  get(): ConnectionSecrets;
  save(secrets: ConnectionSecrets): Promise<void>;
  /**
   * Reads the secrets again from where they are kept. Called when the connection's turn comes,
   * since a call that waited may hold a refresh token another call has already used up.
   */
  reload?(): Promise<void>;
}

/** What the client needs of a connection. */
export interface ClientTarget {
  id: string;
  url: string;
  auth: 'oauth' | 'token' | 'none';
  /** Changes whenever the address, the sign-in kind or the secrets change. */
  version: string;
  store: SecretStore;
  /** Scopes to ask for at sign-in, when not all the service lists. */
  scope?: string;
  /**
   * Whether every address the connection and its sign-in reach must be a public one. True for a
   * connection of someone who may not point the server at its own machine or network: the check
   * when it was added covers only the address as it resolved then, not where its sign-in leads or
   * what the name resolves to later.
   */
  publicOnly?: () => Promise<boolean>;
  /**
   * The scopes a sign-in asks for are set by the catalog. A refusal for scope then asks the person
   * to sign in again with them (they may have left one out at the consent), without asking for
   * more: a service may name every scope that would do, the broadest among them.
   */
  scopeFixed?: boolean;
}

/**
 * `forbidden` is a 403: the sign-in holds but the service will not serve this account or app, so
 * signing in again alone seldom helps. `scope` is a 403 that names what the sign-in lacks: a new
 * sign-in that asks for it does help.
 */
export type ClientErrorCode =
  'unauthorized' | 'forbidden' | 'scope' | 'unreachable' | 'notMcp' | 'timeout' | 'tool';

export class ConnectionClientError extends Error {
  constructor(
    readonly code: ClientErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export const CALL_TIMEOUT_MS = 60_000;
/**
 * How long a tool call may run: a report or an export can take minutes. Set from the server's
 * configuration at start (LEAFBOT_MCP_TIMEOUT_SECONDS); listing tools keeps the short limit.
 */
let toolCallMs = 5 * 60_000;
export function setToolCallTimeout(ms: number) {
  toolCallMs = ms;
}
/** A call that may ask the person something waits this long at most. */
export const ELICIT_TIMEOUT_MS = 15 * 60_000;
const CONNECT_TIMEOUT_MS = 20_000;
const IDLE_MS = 5 * 60_000;
const GOOGLE_ACCOUNTS = 'https://accounts.google.com';

export function clientMetadata(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: 'Leaf Bot',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: 'none',
  };
}

/**
 * Where this server describes itself as an OAuth client, so a service that accepts such an
 * address as the client's id signs in without registering the app first.
 */
export const OAUTH_CLIENT_PATH = '/api/connections/oauth/client.json';

/**
 * The address of this server's client description for a sign-in coming back to `redirect`, or
 * undefined when the service could not fetch it: only a public `https` address can be one.
 */
export function clientMetadataUrlFor(redirect: string, path: string): string | undefined {
  let url: URL;
  try {
    url = new URL(redirect);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  const local =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    /^[\d.]+$/.test(host) ||
    host.startsWith('[');
  return url.protocol === 'https:' && !local ? `${url.origin}${path}` : undefined;
}

/**
 * The server's side of an OAuth sign-in, with PKCE. It signs in as the app the person registered
 * with the service when there is one, else registers itself (dynamic client registration). A
 * registration names one redirect address; when the server is reached at another one it registers
 * again.
 */
export class ConnectionOAuthProvider implements OAuthClientProvider {
  authorizationUrl: URL | null = null;
  private stateValue: string | null = null;

  constructor(
    private readonly store: SecretStore,
    private readonly redirect: string,
    private verifier: string | null = null,
    /** Used for calls, where nobody is there to sign in: a needed sign-in is an error. */
    private readonly background = false,
  ) {}

  private get secrets() {
    return this.store.get();
  }

  private async patch(oauth: NonNullable<ConnectionSecrets['oauth']>) {
    const s = this.secrets;
    await this.store.save({ ...s, oauth: { ...s.oauth, ...oauth, redirectUrl: this.redirect } });
  }

  get redirectUrl() {
    return this.redirect;
  }

  /**
   * The SDK asks for the scope a 401 names, else the one the resource's metadata lists, else this
   * one. A service that publishes no resource metadata and names no scope would get a sign-in page
   * with no scope at all, which Microsoft Entra refuses (AADSTS900144): such a service asks for
   * what its sign-in server lists.
   */
  get clientMetadata() {
    const scope = authorizationServerScope(this.secrets.oauth?.discovery);
    return { ...clientMetadata(this.redirect), ...(scope ? { scope } : {}) };
  }

  /**
   * A service that takes an address as the client's id reads this server's description there,
   * instead of a registration it may refuse. Not used with the person's own app.
   */
  get clientMetadataUrl() {
    return this.secrets.ownClient ? undefined : clientMetadataUrlFor(this.redirect, OAUTH_CLIENT_PATH);
  }

  state() {
    this.stateValue ??= randomBytes(24).toString('base64url');
    return this.stateValue;
  }

  get startedState() {
    return this.stateValue;
  }

  get codeVerifierValue() {
    return this.verifier;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    const own = this.secrets.ownClient;
    if (own) return { ...own };
    const saved = this.secrets.oauth?.client;
    const uris = (saved as { redirect_uris?: string[] } | undefined)?.redirect_uris;
    const usable = saved && (!uris || uris.includes(this.redirect)) ? saved : undefined;
    // With nobody there, a registration the service dropped (invalid_client) is not made anew:
    // the SDK would register this server again on every call, and no sign-in could follow it.
    if (!usable && this.background) {
      throw new ConnectionClientError('unauthorized', 'The service asks to sign in again');
    }
    return usable;
  }

  async saveClientInformation(client: OAuthClientInformationMixed) {
    // The person's own app stays where they put it.
    if (this.secrets.ownClient) return;
    await this.patch({ client });
  }

  tokens() {
    return this.secrets.oauth?.tokens;
  }

  async saveTokens(tokens: OAuthTokens) {
    // A refresh may leave out the refresh token; the one we have stays good.
    const refresh = tokens.refresh_token ?? this.secrets.oauth?.tokens?.refresh_token;
    await this.patch({
      tokens: { ...tokens, ...(refresh ? { refresh_token: refresh } : {}) },
      // A sign-in the person made (never a renewal) answers a refusal for scope.
      ...(!this.background && { scopePending: false }),
    });
  }

  redirectToAuthorization(url: URL) {
    if (this.background) {
      // The SDK starts a new sign-in when a refresh fails for any reason. A refused refresh token
      // is dropped before that (invalid_grant), so one still kept means the refresh failed on the
      // way (network, a 5xx): the sign-in holds and the next call tries again.
      if (this.secrets.oauth?.tokens?.refresh_token) {
        throw new ConnectionClientError('unreachable', 'The service could not renew the sign-in just now');
      }
      throw new ConnectionClientError('unauthorized', 'The service asks to sign in again');
    }
    // Google gives a refresh token only when asked for one, with a fresh consent.
    if (url.origin === GOOGLE_ACCOUNTS) {
      url.searchParams.set('access_type', 'offline');
      url.searchParams.set('prompt', 'consent');
    }
    this.authorizationUrl = url;
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier() {
    if (!this.verifier) throw new ConnectionClientError('unauthorized', 'No sign-in is under way');
    return this.verifier;
  }

  async saveDiscoveryState(discovery: unknown) {
    await this.patch({ discovery });
  }

  discoveryState() {
    return this.secrets.oauth?.discovery as never;
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const oauth = { ...this.secrets.oauth };
    if (scope === 'all' || scope === 'client') delete oauth.client;
    if (scope === 'all' || scope === 'tokens') delete oauth.tokens;
    if (scope === 'all' || scope === 'discovery') delete oauth.discovery;
    if (scope === 'all' || scope === 'verifier') this.verifier = null;
    await this.store.save({ ...this.secrets, oauth });
  }
}

/** Begins an OAuth sign-in: where to send the person, or null when already signed in. */
export async function startOAuth(target: ClientTarget, redirectUrl: string) {
  const provider = new ConnectionOAuthProvider(target.store, redirectUrl);
  const run = () =>
    auth(provider, {
      serverUrl: target.url,
      fetchFn: authFetch(target),
      ...(target.scope ? { scope: target.scope } : {}),
    });
  const result = await inLane(target, async () => {
    try {
      return await run();
    } catch (err) {
      if (!refusedForGood(err) || !provider.tokens()?.refresh_token) throw err;
      // The kept refresh token was turned down: the person is here to sign in, so the sign-in
      // starts afresh instead of failing on it.
      await provider.invalidateCredentials('tokens');
      return run();
    }
  }).catch((err: unknown) => {
    throw classify(err);
  });
  if (result === 'AUTHORIZED') {
    // A kept refresh token was used: the connection's clients start over with the new one.
    dropClient(target.id);
    return null;
  }
  if (!provider.authorizationUrl || !provider.startedState || !provider.codeVerifierValue) {
    throw new ConnectionClientError('unauthorized', 'The service did not start a sign-in');
  }
  return {
    url: provider.authorizationUrl.href,
    state: provider.startedState,
    verifier: provider.codeVerifierValue,
  };
}

/** Finishes an OAuth sign-in with the code the service sent back. */
export async function finishOAuth(target: ClientTarget, redirectUrl: string, verifier: string, code: string) {
  const provider = new ConnectionOAuthProvider(target.store, redirectUrl, verifier);
  const result = await inLane(target, () =>
    auth(provider, { serverUrl: target.url, authorizationCode: code, fetchFn: authFetch(target) }),
  ).catch((err: unknown) => {
    throw classify(err);
  });
  if (result !== 'AUTHORIZED')
    throw new ConnectionClientError('unauthorized', 'The sign-in was not accepted');
  dropClient(target.id);
}

/**
 * What went wrong, in words a person can act on. A refused request is said as its HTTP status and
 * the start of the service's answer, instead of the whole answer with no status.
 */
function messageOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: unknown })?.code;
  const refused = /^Streamable HTTP error: Error POSTing to endpoint: ([\s\S]*)$/.exec(message);
  if (refused && typeof code === 'number' && code >= 100) {
    let answer = refused[1]!.trim();
    // Some services refuse with an ordinary JSON-RPC answer as the body, which says nothing of why.
    if (isRpcAnswer(answer)) answer = '';
    return `HTTP ${code}${answer ? `: ${answer.length > 300 ? `${answer.slice(0, 300)}…` : answer}` : ''}`;
  }
  return message;
}

function isRpcAnswer(text: string): boolean {
  try {
    const body = JSON.parse(text) as { jsonrpc?: unknown; result?: unknown };
    return body.jsonrpc === '2.0' && body.result !== undefined;
  } catch {
    return false;
  }
}

/**
 * The authorization server turned a refresh down for good. Services say so in different words:
 * the SDK starts over itself on invalid_grant, but passes on the rest, such as the invalid_request
 * X answers a spent or revoked refresh token with. Only a server error, a pause or a rate limit is
 * in passing; an answer that names no known error comes as a server error.
 */
function refusedForGood(error: unknown): boolean {
  return (
    error instanceof OAuthError &&
    !(
      error instanceof ServerError ||
      error instanceof TemporarilyUnavailableError ||
      error instanceof TooManyRequestsError
    )
  );
}

/** Maps what the SDK or the network threw to a ConnectionClientError. */
export function classify(error: unknown): ConnectionClientError {
  if (error instanceof ConnectionClientError) return error;
  const name = (error as { name?: string })?.name ?? '';
  const message = messageOf(error);
  const code = (error as { code?: number | string })?.code;
  if (error instanceof McpError) {
    // -32001 is the SDK's request timeout.
    if (code === -32001) return new ConnectionClientError('timeout', message);
    return new ConnectionClientError('tool', message);
  }
  // The transport's HTTP errors carry the status as their code.
  if (code === 401) return new ConnectionClientError('unauthorized', message);
  if (code === 403) return new ConnectionClientError('forbidden', message);
  if (code === 404 || code === 405) return new ConnectionClientError('notMcp', message);
  if (name === 'UnauthorizedError' || /unauthori[sz]ed|\b401\b|invalid_token|invalid_grant/i.test(message)) {
    return new ConnectionClientError('unauthorized', message);
  }
  if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out|timeout/i.test(message)) {
    return new ConnectionClientError('timeout', message);
  }
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|certificate|socket/i.test(message)) {
    return new ConnectionClientError('unreachable', message);
  }
  return new ConnectionClientError('notMcp', message);
}

// --------------------------------------------------------------------------------------- lanes

const queues = new Map<string, Promise<unknown>>();

/** Runs `fn` after whatever runs on the same connection. */
function serialized<T>(id: string, fn: () => Promise<T>): Promise<T> {
  const before = queues.get(id) ?? Promise.resolve();
  const next = before.catch(() => undefined).then(fn);
  queues.set(id, next);
  void next
    .finally(() => {
      if (queues.get(id) === next) queues.delete(id);
    })
    .catch(() => undefined);
  return next;
}

/** Runs `fn` on the connection's turn, with its secrets as they are by then. */
function inLane<T>(target: ClientTarget, fn: () => Promise<T>): Promise<T> {
  return serialized(target.id, async () => {
    await target.store.reload?.();
    return fn();
  });
}

// ----------------------------------------------------------------------------------- addresses

/** How long one request of a sign-in (metadata, registration, token) may take. */
const AUTH_REQUEST_MS = 20_000;
/** How many redirects a sign-in's request follows. */
const AUTH_REDIRECTS = 5;

let publicAgent: Agent | undefined;

/** Connects only to the addresses its name lookup checked and found public. */
export function publicDispatcher(): Agent {
  return (publicAgent ??= new Agent({ connect: { lookup: publicLookup() } }));
}

/**
 * Sends a request of a connection. One that must stay public is refused an address on this
 * machine or a private network: first by looking the name up, for an error that says why, then by
 * connecting only to the addresses that lookup checked, so a name that points elsewhere a moment
 * later reaches nothing.
 */
async function reach(target: ClientTarget, input: string | URL | Request, init?: RequestInit) {
  if (!(await target.publicOnly?.())) return fetch(input, init);
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (await privateHost(url.hostname)) {
    throw new ConnectionClientError('unreachable', `${url.host} is on this computer or a private network`);
  }
  return fetch(input, { ...init, dispatcher: publicDispatcher() } as RequestInit);
}

/**
 * A metadata address that answers with a web page instead of a JSON object reads as absent: many
 * hosts answer every path with their own page, and the SDK would stop at parsing it instead of
 * looking where else the metadata may be.
 */
async function metadataJson(url: URL, res: Response): Promise<Response> {
  if (!res.ok || !url.pathname.startsWith('/.well-known/')) return res;
  const text = await res.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: read as absent below.
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return new Response(null, { status: 404 });
  return new Response(text, { status: res.status, headers: { 'content-type': 'application/json' } });
}

/**
 * Fetch for a sign-in's own requests (metadata, registration, tokens). Redirects are followed here,
 * each address checked like the first (see `reach`), since the metadata of a public service could
 * otherwise lead the server to an address of its own network.
 */
export function authFetch(target: ClientTarget): typeof fetch {
  return async (input, init) => {
    let url = new URL(input instanceof Request ? input.url : String(input));
    let next: RequestInit = { ...init };
    for (let hop = 0; ; hop++) {
      const res = await reach(target, url, {
        ...next,
        redirect: 'manual',
        signal: next.signal ?? AbortSignal.timeout(AUTH_REQUEST_MS),
      });
      const location = res.headers.get('location');
      if (res.status < 300 || res.status >= 400 || !location) return metadataJson(url, res);
      await res.body?.cancel();
      if (hop >= AUTH_REDIRECTS) {
        throw new ConnectionClientError('unreachable', `${url.host} redirected too many times`);
      }
      url = new URL(location, url);
      // Only 307 and 308 send the same request on; the others go on as a GET.
      if (res.status !== 307 && res.status !== 308) next = { ...next, method: 'GET', body: null };
    }
  };
}

// ----------------------------------------------------------------------------------- sign-in offer

/**
 * Whether a server that refused a request without a sign-in offers one: its refusal names where
 * its sign-in metadata is, or that metadata can be found by the usual addresses. A server that
 * wants a key on every path offers neither, and no Sign in button could work for it. When this
 * cannot be told (the server did not answer), it counts as offering one, as before.
 */
export async function offersSignIn(target: ClientTarget): Promise<boolean> {
  const send = authFetch(target);
  try {
    const probe = await send(target.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    await probe.body?.cancel();
    if (probe.status === 401 && extractResourceMetadataUrl(probe)) return true;
    const found = await discoverOAuthServerInfo(target.url, { fetchFn: send });
    return !!(found.resourceMetadata || found.authorizationServerMetadata);
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------------------------------- scope

/**
 * The scopes a sign-in server lists, for a service with no resource metadata; undefined when the
 * resource has metadata (it names the scope, or none is wanted) or the server lists none.
 */
export function authorizationServerScope(discovery: unknown): string | undefined {
  const d = discovery as
    { resourceMetadata?: unknown; authorizationServerMetadata?: { scopes_supported?: unknown } } | undefined;
  if (!d || d.resourceMetadata) return undefined;
  const listed = d.authorizationServerMetadata?.scopes_supported;
  if (!Array.isArray(listed)) return undefined;
  return listed.filter((s): s is string => typeof s === 'string' && !!s).join(' ') || undefined;
}

/** Scope lists joined, each scope once; undefined when there is none. */
export function joinScopes(...lists: (string | undefined)[]): string | undefined {
  const all = [...new Set(lists.flatMap((l) => (l ?? '').split(/\s+/).filter(Boolean)))];
  return all.length ? all.join(' ') : undefined;
}

/** The scopes a 403 challenge says are missing; null when it is no `insufficient_scope` challenge. */
export function missingScope(challenge: string | null): string | null {
  if (!challenge || !/\berror\s*=\s*"?insufficient_scope\b/i.test(challenge)) return null;
  return /\bscope\s*=\s*"([^"]*)"/i.exec(challenge)?.[1]?.trim() ?? '';
}

/**
 * Notes that a call was refused for scope, with the scopes it names unless the catalog sets them
 * (see `scopeFixed`), so the next sign-in asks for them, and says so as a `scope` error. Renewing
 * the token cannot widen what it may do: only a new consent can.
 */
async function needScope(target: ClientTarget, res: Response): Promise<never> {
  const wanted = missingScope(res.headers.get('www-authenticate')) ?? '';
  await res.body?.cancel();
  await inLane(target, async () => {
    const s = target.store.get();
    const wantScope = target.scopeFixed ? s.oauth?.wantScope : joinScopes(s.oauth?.wantScope, wanted);
    await target.store.save({
      ...s,
      oauth: { ...s.oauth, scopePending: true, ...(wantScope ? { wantScope } : {}) },
    });
  });
  throw new ConnectionClientError('scope', `The service asks for more access${wanted ? `: ${wanted}` : ''}`);
}

const refusedForScope = (target: ClientTarget, res: Response) =>
  target.auth === 'oauth' && res.status === 403 && missingScope(res.headers.get('www-authenticate')) !== null;

// ---------------------------------------------------------------------------------------- tokens

/** The token a connection's requests carry now. */
function bearerOf(target: ClientTarget): string | undefined {
  if (target.auth === 'token') return target.store.get().token;
  if (target.auth === 'oauth') return target.store.get().oauth?.tokens?.access_token;
  return undefined;
}

/**
 * Renews a refused OAuth token on the connection's turn. A call that waited for its turn finds
 * the token another call renewed meanwhile and uses that, instead of spending the refresh token
 * again. Throws a ConnectionClientError when only a new sign-in helps or the renewal failed on
 * the way.
 */
async function renew(target: ClientTarget, refused: string | undefined) {
  await inLane(target, async () => {
    const now = target.store.get().oauth?.tokens?.access_token;
    if (now && now !== refused) return;
    const redirect = target.store.get().oauth?.redirectUrl;
    if (!redirect) throw new ConnectionClientError('unauthorized', 'The service asks to sign in');
    try {
      await auth(new ConnectionOAuthProvider(target.store, redirect, null, true), {
        serverUrl: target.url,
        fetchFn: authFetch(target),
      });
    } catch (err) {
      // The tokens stay for now, so the service's words can still be masked; the sign-in the
      // person starts next leaves them out (see startSignIn).
      if (refusedForGood(err)) throw new ConnectionClientError('unauthorized', messageOf(err));
      throw classify(err);
    }
  });
}

// ------------------------------------------------------------------------------ custom headers

/** How many redirects of the server's own address a request with custom headers follows. */
const HEADER_REDIRECTS = 5;

/**
 * Puts the headers the person set on a request, never over one already there and never over the
 * sign-in's own `Authorization`: with a token or OAuth, that header is the connection's.
 */
function applyCustomHeaders(target: ClientTarget, headers: Headers) {
  for (const [name, value] of Object.entries(target.store.get().headers ?? {})) {
    if (headers.has(name)) continue;
    if (name.toLowerCase() === 'authorization' && target.auth !== 'none') continue;
    headers.set(name, value);
  }
}

/**
 * Sends a request of the transport with the connection's custom headers. A redirect is followed
 * here, not by `fetch`: `fetch` takes off only its own few headers when a redirect leads to
 * another site, so the person's headers would go along with it. Redirects within the server's own
 * address keep them; one that leads elsewhere ends the request.
 */
async function withCustomHeaders(
  target: ClientTarget,
  endpoint: URL,
  input: string | URL | Request,
  init: RequestInit & { headers: Headers },
): Promise<Response> {
  if (!Object.keys(target.store.get().headers ?? {}).length) return reach(target, input, init);
  let url = new URL(input instanceof Request ? input.url : String(input));
  let next = init;
  for (let hop = 0; ; hop++) {
    if (url.origin !== endpoint.origin) {
      throw new ConnectionClientError('unreachable', `${endpoint.host} redirected to ${url.host}`);
    }
    const headers = new Headers(next.headers);
    applyCustomHeaders(target, headers);
    const res = await reach(target, url, { ...next, headers, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status < 300 || res.status >= 400 || !location || hop >= HEADER_REDIRECTS) return res;
    await res.body?.cancel();
    url = new URL(location, url);
    // Only 307 and 308 send the same request on; the others go on as a GET.
    if (res.status !== 307 && res.status !== 308) next = { ...next, method: 'GET', body: null };
  }
}

// ---------------------------------------------------------------------------------------- pool

/** Answers a server's question in the middle of a tool call; set only while such a call runs. */
export type Elicit = (form: ElicitForm) => Promise<ElicitResult>;

/**
 * Who a client works for right now: the connection as the call holding it read it, and who
 * answers a question its server asks during that call. A client runs one call at a time, so a
 * question that arrives belongs to that call.
 */
interface Holder {
  target: ClientTarget;
  ask?: Elicit;
}
interface Pooled {
  client: Client;
  holder: Holder;
  usedAt: number;
  createdAt: number;
}
interface Pool {
  version: string;
  free: Pooled[];
  busy: number;
  waiters: (() => void)[];
  closed: boolean;
}

/** At most this many calls run on one connection at once; more wait for one to end. */
const MAX_CLIENTS = 4;
const pools = new Map<string, Pool>();
let sweeper: NodeJS.Timeout | undefined;

/** Told when a connection's server says its list of tools changed. */
let toolsChanged: ((id: string) => void) | undefined;
export function onToolsChanged(fn: ((id: string) => void) | undefined) {
  toolsChanged = fn;
}

/**
 * Fetch for a connection's transport. It never opens the standalone GET stream: only calls and
 * tool lists are used, and a server answers 405 when it has no such stream, which the SDK takes as
 * such. Each request carries the connection's token as it is then; a refused OAuth token is
 * renewed once (see `renew`) and the request sent again, and a 403 naming missing scopes becomes a
 * `scope` error.
 */
function connectionFetch(endpoint: URL, holder: Holder): typeof fetch {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
    if (
      method.toUpperCase() === 'GET' &&
      url.href === endpoint.href &&
      !new Headers(init?.headers).has('last-event-id')
    ) {
      return new Response(null, { status: 405 });
    }
    const target = holder.target;
    const send = (token: string | undefined) => {
      const headers = new Headers(init?.headers);
      if (token) headers.set('Authorization', `Bearer ${token}`);
      return withCustomHeaders(target, endpoint, input, { ...init, headers });
    };
    const used = bearerOf(target);
    let res = await send(used);
    if (target.auth !== 'oauth') return res;
    if (res.status === 401 && target.store.get().oauth?.redirectUrl) {
      await res.body?.cancel();
      await renew(target, used);
      res = await send(bearerOf(target));
    }
    if (refusedForScope(target, res)) await needScope(target, res);
    return res;
  };
}

/**
 * Opens a client, once more after a moment when the first try met a dropped network or a server
 * error: a passing fault would otherwise leave the app out of the bot's turn.
 */
async function connect(holder: Holder): Promise<Client> {
  try {
    return await connectOnce(holder);
  } catch (error) {
    if (!(error instanceof ConnectionClientError) || !(error as { passing?: boolean }).passing) throw error;
    await new Promise((r) => setTimeout(r, CONNECT_RETRY_MS));
    return connectOnce(holder);
  }
}

/** How long a connection that failed in passing waits before its second try. */
const CONNECT_RETRY_MS = 1000;

async function connectOnce(holder: Holder): Promise<Client> {
  // Forms only: a server asking to open a web page is declined.
  const client = new Client(
    { name: 'LeafBot', version: '0.10.2' },
    {
      capabilities: {
        elicitation: { form: {} },
        // MCP apps: the conversation can show a tool's own view.
        extensions: { [UI_EXTENSION]: { mimeTypes: [APP_MIME] } },
      },
      // A server that says its tools changed gets them listed again by the connection's owner.
      listChanged: {
        tools: { autoRefresh: false, debounceMs: 2000, onChanged: () => toolsChanged?.(holder.target.id) },
      },
    },
  );
  client.setRequestHandler(ElicitRequestSchema, async (req) => {
    const ask = holder.ask;
    const params = req.params as Partial<ElicitForm> & { mode?: string };
    if (!ask || params.mode === 'url' || !params.requestedSchema?.properties) return { action: 'decline' };
    return ask({ message: params.message ?? '', requestedSchema: params.requestedSchema });
  });
  const endpoint = new URL(holder.target.url);
  const transport = new StreamableHTTPClientTransport(endpoint, { fetch: connectionFetch(endpoint, holder) });
  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
  } catch (error) {
    await client.close().catch(() => undefined);
    const failure = classify(error);
    const out = failure.code === 'tool' ? new ConnectionClientError('notMcp', failure.message) : failure;
    const status = (error as { code?: unknown })?.code;
    const passing =
      failure.code === 'unreachable' || (typeof status === 'number' && status >= 500 && status < 600);
    throw Object.assign(out, { passing });
  }
  return client;
}

const closeQuietly = (p: Pooled) => void p.client.close().catch(() => undefined);

function sweepIdle() {
  const now = Date.now();
  for (const [id, pool] of pools) {
    const idle = pool.free.filter((p) => now - p.usedAt > IDLE_MS);
    pool.free = pool.free.filter((p) => now - p.usedAt <= IDLE_MS);
    idle.forEach(closeQuietly);
    if (!pool.free.length && !pool.busy) {
      pools.delete(id);
      pool.closed = true;
    }
  }
  if (!pools.size && sweeper) {
    clearInterval(sweeper);
    sweeper = undefined;
  }
}

function poolFor(target: ClientTarget): Pool {
  let pool = pools.get(target.id);
  if (pool && pool.version !== target.version) {
    dropClient(target.id);
    pool = undefined;
  }
  if (!pool) {
    pool = { version: target.version, free: [], busy: 0, waiters: [], closed: false };
    pools.set(target.id, pool);
    sweeper ??= setInterval(sweepIdle, 60_000);
    sweeper.unref?.();
  }
  return pool;
}

const wake = (pool: Pool) => pool.waiters.shift()?.();

/** A client of the connection for one call: an idle one, else a new one. */
async function lease(target: ClientTarget): Promise<{ pool: Pool; pooled: Pooled }> {
  const pool = poolFor(target);
  while (pool.busy >= MAX_CLIENTS) await new Promise<void>((r) => pool.waiters.push(r));
  pool.busy++;
  try {
    // The oldest client first: a server that keeps state per session finds the calls that don't
    // overlap on one session, and the others close when they go unused.
    const oldest = pool.free.reduce<Pooled | undefined>(
      (a, b) => (!a || b.createdAt < a.createdAt ? b : a),
      undefined,
    );
    let pooled = oldest;
    if (pooled) {
      pool.free.splice(pool.free.indexOf(pooled), 1);
      pooled.holder.target = target;
    } else {
      const holder: Holder = { target };
      const now = Date.now();
      pooled = { client: await connect(holder), holder, usedAt: now, createdAt: now };
    }
    return { pool, pooled };
  } catch (error) {
    pool.busy--;
    wake(pool);
    throw error;
  }
}

/** Gives a client back; one that failed, or of a connection that changed meanwhile, is closed. */
function release(pool: Pool, pooled: Pooled, keep: boolean) {
  pool.busy--;
  pooled.holder.ask = undefined;
  if (keep && !pool.closed) {
    pooled.usedAt = Date.now();
    pool.free.push(pooled);
  } else closeQuietly(pooled);
  wake(pool);
}

/**
 * Closes a connection's idle clients (it changed, was signed out of or removed); a call under way
 * ends first, then its client closes.
 */
export function dropClient(id: string) {
  const pool = pools.get(id);
  if (!pool) return;
  pools.delete(id);
  pool.closed = true;
  pool.free.splice(0).forEach(closeQuietly);
}

/** Closes every client (server shutdown, tests). */
export function dropAllClients() {
  for (const id of [...pools.keys()]) dropClient(id);
}

async function withClient<T>(
  target: ClientTarget,
  fn: (client: Client, holder: Holder) => Promise<T>,
): Promise<T> {
  let leased;
  try {
    leased = await lease(target);
  } catch (error) {
    throw classify(error);
  }
  let keep = true;
  try {
    return await fn(leased.pooled.client, leased.pooled.holder);
  } catch (error) {
    const failure = classify(error);
    keep = failure.code === 'tool';
    throw failure;
  } finally {
    release(leased.pool, leased.pooled, keep);
  }
}

// --------------------------------------------------------------------------------------- tools

export const hintedKind = (tool: Pick<Tool, 'annotations'>): 'read' | 'write' =>
  tool.annotations?.readOnlyHint === true ? 'read' : 'write';

export const UI_EXTENSION = 'io.modelcontextprotocol/ui';
export const APP_MIME = 'text/html;profile=mcp-app';

const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;

/** A tool's view: `_meta.ui.resourceUri`, or the older flat `ui/resourceUri`; only a ui:// one. */
export function toolUi(tool: { _meta?: unknown }): string | null {
  const meta = record(tool._meta);
  const ui = record(meta?.ui);
  const uri = typeof ui?.resourceUri === 'string' ? ui.resourceUri : meta?.['ui/resourceUri'];
  return typeof uri === 'string' && uri.startsWith('ui://') ? uri : null;
}

/** A tool its server meant for the view alone: `_meta.ui.visibility` without "model". */
export function appOnlyTool(tool: { _meta?: unknown }): boolean {
  const seen = record(record(tool._meta)?.ui)?.visibility;
  return Array.isArray(seen) && !seen.includes('model');
}

/** A view's page and what it may load, as its server describes it. */
export interface AppResource {
  html: string;
  connect: string[];
  resources: string[];
}

/** Reads a tool's view; null when it is not an HTML app page or is too large. */
export async function readAppResource(target: ClientTarget, uri: string): Promise<AppResource | null> {
  return withClient(target, async (client) => {
    const r = await client.readResource({ uri }, { timeout: CALL_TIMEOUT_MS });
    const page = r.contents.find((c) => c.uri === uri) ?? r.contents[0];
    if (!page || typeof (page as { text?: unknown }).text !== 'string') return null;
    if (!String(page.mimeType ?? '').startsWith('text/html')) return null;
    const html = (page as { text: string }).text;
    if (html.length > 1_000_000) return null;
    const csp = record(record(record(page._meta)?.ui)?.csp);
    const list = (v: unknown) =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    return { html, connect: list(csp?.connectDomains), resources: list(csp?.resourceDomains) };
  });
}

/** Lists the server's tools, keeping the person's choices for tools it still has. */
export async function listTools(
  target: ClientTarget,
  kept: StoredConnectionTool[] = [],
): Promise<StoredConnectionTool[]> {
  const before = new Map(kept.map((t) => [t.name, t]));
  return withClient(target, async (client) => {
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: CALL_TIMEOUT_MS });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor && tools.length < MAX_CONNECTION_TOOLS);
    return tools.slice(0, MAX_CONNECTION_TOOLS).map((tool) => {
      const old = before.get(tool.name);
      return {
        name: tool.name,
        title: tool.title ?? tool.annotations?.title ?? null,
        description: (tool.description ?? '').slice(0, 4000),
        inputSchema: (tool.inputSchema ?? { type: 'object' }) as Record<string, unknown>,
        hinted: hintedKind(tool),
        ui: toolUi(tool),
        appOnly: appOnlyTool(tool),
        kind: old?.kind ?? null,
        enabled: old?.enabled ?? true,
      };
    });
  });
}

/** Calls a tool. Throws a ConnectionClientError when the server can't be used; a tool's own error comes back in the result. */
export async function callTool(
  target: ClientTarget,
  name: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
  elicit?: Elicit,
): Promise<CallToolResult> {
  return withClient(target, async (client, holder) => {
    holder.ask = elicit;
    return (await client.callTool({ name, arguments: args }, undefined, {
      // A question to the person may take a while; the call waits for the answer.
      timeout: elicit ? ELICIT_TIMEOUT_MS : toolCallMs,
      maxTotalTimeout: elicit ? ELICIT_TIMEOUT_MS : toolCallMs,
      ...(signal ? { signal } : {}),
    })) as CallToolResult;
  });
}

/**
 * Calls the service's own API (not its MCP server) with the connection's sign-in. A refused access
 * token is renewed once, the way the MCP client renews it; refused again, the connection needs a
 * new sign-in. `noteScope` off leaves a refusal for scope as the answer it is, for a read nobody
 * asked for (the sender shown on a mail card), which should not send the person to sign in again.
 */
export async function fetchSignedIn(
  target: ClientTarget,
  url: string,
  init: RequestInit = {},
  { noteScope = true }: { noteScope?: boolean } = {},
): Promise<Response> {
  if (target.auth !== 'oauth' || !target.store.get().oauth?.redirectUrl) {
    throw new ConnectionClientError('unauthorized', 'The service asks to sign in');
  }
  const send = () => {
    const headers = new Headers(init.headers);
    const token = bearerOf(target);
    if (token) headers.set('Authorization', `Bearer ${token}`);
    return reach(target, url, { ...init, headers });
  };
  const used = bearerOf(target);
  let res = await send();
  if (res.status === 401) {
    await res.body?.cancel();
    await renew(target, used);
    res = await send();
    if (res.status === 401) {
      await res.body?.cancel();
      throw new ConnectionClientError('unauthorized', 'The service asks to sign in again');
    }
  }
  if (noteScope && refusedForScope(target, res)) await needScope(target, res);
  return res;
}
