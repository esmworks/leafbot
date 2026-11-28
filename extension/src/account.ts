/**
 * The Leaf Bot account as the side panel reaches it: the account service's own host, with the
 * bearer token a one-time code from another signed-in device handed this Chrome. The token is kept
 * in the extension's storage; servers are reached through the tunnel only, never by address.
 */

/** The account service's host for apps that are not the website. */
export const ACCOUNT_API = 'https://api.leafbot.app';

/** The website's page of the person's servers, at one of them when `server` names it. */
export function appUrl(server: string | null): string {
  const url = new URL('/bots/', 'https://www.leafbot.app');
  if (server) url.searchParams.set('server', server);
  return url.toString();
}

export type Role = 'owner' | 'admin' | 'member';

export interface ServerEntry {
  id: string;
  name: string;
  role: Role;
  /** The server's Ed25519 public key; a tunnel to a server showing another is refused. */
  publicKey: string;
  seenAt: number;
}

export interface Ticket {
  ticket: string;
  publicKey: string;
  expiresAt: number;
}

export class AccountError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

const TOKEN = 'accountToken';

export async function loadToken(): Promise<string | null> {
  const v = await chrome.storage.local.get([TOKEN]);
  return typeof v[TOKEN] === 'string' ? (v[TOKEN] as string) : null;
}

const saveToken = (token: string | null) =>
  token ? chrome.storage.local.set({ [TOKEN]: token }) : chrome.storage.local.remove(TOKEN);

async function call<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (token) headers.authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${ACCOUNT_API}/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new AccountError(0, 'unreachable');
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new AccountError(res.status, data?.error ?? `http_${res.status}`);
  return data as T;
}

/** The code from what the person typed or pasted: the code itself, or the link its QR code holds. */
export function codeFrom(text: string): string {
  const trimmed = text.trim();
  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get('code');
    if (code) return code;
  } catch {
    // Not a link: the code as typed.
  }
  return trimmed;
}

async function signedIn(): Promise<string> {
  const token = await loadToken();
  if (!token) throw new AccountError(401, 'unauthorized');
  return token;
}

/** Forgets a token the service no longer takes, so the panel asks for a new code. */
async function guarded<T>(run: (token: string) => Promise<T>): Promise<T> {
  const token = await signedIn();
  try {
    return await run(token);
  } catch (err) {
    if (err instanceof AccountError && err.status === 401) await saveToken(null);
    throw err;
  }
}

export const account = {
  /** Signs this Chrome in with a one-time code shown on a device already signed in. */
  async redeem(text: string): Promise<void> {
    const r = await call<{ token: string }>('POST', '/connect-codes/redeem', null, { code: codeFrom(text) });
    await saveToken(r.token);
  },
  servers: () =>
    guarded((token) => call<{ servers: ServerEntry[] }>('GET', '/servers', token).then((r) => r.servers)),
  /** A client ticket for one server, bound to this Chrome's device key. */
  ticket: (serverId: string, jkt: string) =>
    guarded((token) =>
      call<Ticket>('POST', `/servers/${encodeURIComponent(serverId)}/ticket`, token, { jkt }),
    ),
  /** Ends this Chrome's sign-in at the service too, then forgets the token. */
  async signOut(): Promise<void> {
    const token = await loadToken();
    if (token) await call('POST', '/auth/signout', token).catch(() => undefined);
    await saveToken(null);
  },
};
