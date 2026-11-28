import type { Role } from '@leafbot/shared/account';

/** The account service the phone signs in through and asks for a server's ticket. */
export const ACCOUNT_URL: string = process.env.EXPO_PUBLIC_LEAFBOT_ACCOUNT_URL || 'https://api.leafbot.app';

/** The relay the phone and the server find each other through; another one only for development. */
export const RELAY_URL: string =
  process.env.EXPO_PUBLIC_LEAFBOT_RELAY_URL || 'wss://signal.leafbot.app/v1/signal';

/** Where the person makes an account and adds a server. */
export const WEBSITE_URL = 'https://www.leafbot.app';

export interface AccountUser {
  id: string;
  email: string;
  name: string | null;
}

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
  user: AccountUser;
  sessionId: string;
  token: string;
}

/** The service's answer was an error (`status`, and its own `code` such as `invalid_code`), or none came (status 0). */
export class AccountError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export interface AccountDeps {
  fetch: typeof fetch;
  /** The phone's bearer token; null while signed out. */
  token(): string | null;
  base?: string;
  /** How long a call may take, in ms. */
  timeoutMs?: number;
}

export interface AccountClient {
  /**
   * Spends a connect code for a session of this phone's own; `verifier` for a code the phone asked for
   * through the website, which only spends with it.
   */
  redeem(code: string, verifier?: string): Promise<Redeemed>;
  /** The servers the person may reach. */
  servers(): Promise<ServerEntry[]>;
  /** A client ticket for one server, bound to a device key's thumbprint. */
  ticket(serverId: string, jkt: string): Promise<Ticket>;
  /** Ends this phone's session at the service. */
  signOut(): Promise<void>;
}

/** The account service as the phone reaches it: bearer token calls under /v1, no cookie. */
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
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), d.timeoutMs ?? 15_000);
    let res: Response;
    try {
      res = await d.fetch(`${base}/v1${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch {
      throw new AccountError(0, 'unreachable');
    } finally {
      clearTimeout(timer);
    }
    const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
    if (!res.ok) throw new AccountError(res.status, data?.error ?? `http_${res.status}`);
    return data as T;
  }
  return {
    redeem: (code, verifier) =>
      call<Redeemed>('POST', '/connect-codes/redeem', verifier ? { code, verifier } : { code }, false),
    servers: async () => (await call<{ servers: ServerEntry[] }>('GET', '/servers')).servers,
    ticket: (serverId, jkt) =>
      call<Ticket>('POST', `/servers/${encodeURIComponent(serverId)}/ticket`, { jkt }),
    signOut: () => call<unknown>('POST', '/auth/signout').then(() => undefined),
  };
}

/**
 * The server to open: the one the person chose last when it is still theirs, the only one they
 * have, or none (the person picks, or has none yet).
 */
export function pickServer(servers: readonly ServerEntry[], chosen: string | null): ServerEntry | null {
  return servers.find((s) => s.id === chosen) ?? (servers.length === 1 ? (servers[0] ?? null) : null);
}
