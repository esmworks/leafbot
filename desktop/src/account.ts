/**
 * The account service as this app reaches it: bearer-token calls under /v1, as the phone makes them.
 * The person signs in in their own browser, on the website's connect page; the code it hands back
 * through a `leafbot://connect` link is spent here, with this sign-in's PKCE verifier, for a session
 * of this app's own. The window never shows the website: a browser is where a sign-in belongs, with
 * the person's passwords and their Google or Apple sign-in, and an app window is not one.
 */
import { createHash, randomBytes } from 'node:crypto';

/** The website: where the person signs in, makes an account and adds a server. */
export const WEBSITE = 'https://www.leafbot.app';

/** The account service; another one only for development. */
export const ACCOUNT_URL = process.env.LEAFBOT_ACCOUNT_URL || 'https://api.leafbot.app';

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

export interface Redeemed {
  user: { id: string; email: string; name?: string | null };
  sessionId: string;
  token: string;
}

/** The service's answer was an error (`status`, and its own `code`), or none came (status 0). */
export class AccountError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface AccountDeps {
  /** The account service's address; the real one by default. */
  base?: string;
  fetch: typeof fetch;
  /** This app's bearer token; null while the person is signed out. */
  token(): string | null;
}

export interface AccountClient {
  /** Spends a code the connect page handed back, with the verifier of the sign-in that asked for it. */
  redeem(code: string, verifier: string): Promise<Redeemed>;
  /** The servers the person may reach. */
  servers(): Promise<ServerEntry[]>;
  /** A client ticket for one server, bound to a device key's thumbprint. */
  ticket(serverId: string, jkt: string): Promise<Ticket>;
  /** A one-time code that signs a phone in to this account. */
  connectCode(): Promise<{ code: string; expiresAt: number; url: string }>;
  /** Ends this app's session at the service. */
  signOut(): Promise<void>;
}

export function accountClient(d: AccountDeps): AccountClient {
  const base = d.base ?? ACCOUNT_URL;

  async function call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (auth) {
      const token = d.token();
      if (!token) throw new AccountError(401, 'unauthorized');
      headers.authorization = `Bearer ${token}`;
    }
    let res: Response;
    try {
      res = await d.fetch(`${base}/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AccountError(0, 'unreachable');
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) throw new AccountError(res.status, data?.error ?? `http_${res.status}`);
    return data as T;
  }

  return {
    redeem: (code, verifier) => call<Redeemed>('POST', '/connect-codes/redeem', { code, verifier }, false),
    servers: async () => (await call<{ servers: ServerEntry[] }>('GET', '/servers')).servers,
    ticket: (serverId, jkt) =>
      call<Ticket>('POST', `/servers/${encodeURIComponent(serverId)}/ticket`, { jkt }),
    connectCode: () => call<{ code: string; expiresAt: number; url: string }>('POST', '/connect-codes', {}),
    signOut: () => call<unknown>('POST', '/auth/signout').then(() => undefined),
  };
}

/** Bytes as base64url without padding, as PKCE writes a verifier and its challenge. */
const base64url = (b: Buffer) => b.toString('base64url');

/**
 * A fresh verifier and its S256 challenge. The website makes the code with the challenge; only this
 * app, holding the verifier, can spend it, so a code caught on its way back is of no use to anyone.
 */
export function newPkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash('sha256').update(verifier).digest());
  return { verifier, challenge };
}

/** The website's page that signs the app in, in the app's language where the site has it. */
export function connectPageUrl(locale: string, challenge: string, website = WEBSITE): string {
  const prefix = locale === 'tr' ? '/tr' : '';
  return `${website}${prefix}/connect?challenge=${encodeURIComponent(challenge)}`;
}

/** The characters a connect code is made of: no 0, 1, I, L or O, which look alike. */
const CODE = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{10}$/;

/**
 * The code of a `leafbot://connect?code=…` link, in the form the account service takes it
 * (`ABCDE-FGHJK`); null for any other link or a code that cannot be one.
 */
export function codeOfConnectLink(link: string): string | null {
  let url: URL;
  try {
    url = new URL(link.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'leafbot:' || url.host !== 'connect' || url.pathname.replace(/\/$/, '') !== '')
    return null;
  const code = (url.searchParams.get('code') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return CODE.test(code) ? `${code.slice(0, 5)}-${code.slice(5)}` : null;
}

/** Whether a link is a `leafbot://connect` one, with a code or not: it is the sign-in's, not a chat's. */
export function isConnectLink(link: string): boolean {
  try {
    const url = new URL(link.trim());
    return url.protocol === 'leafbot:' && url.host === 'connect';
  } catch {
    return false;
  }
}
