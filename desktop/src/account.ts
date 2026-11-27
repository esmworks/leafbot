/**
 * The account service as this app's main process reaches it: on the website's origin under
 * /api/v1, with the session cookie the person's sign-in in the window set. The window shows the
 * website, so the sign-in is the website's; the main process only borrows the cookie to ask for
 * the person's servers and a ticket for one. Writes carry the session's CSRF token, handed out by
 * `GET /session`, and the website's origin, as the page there sends them.
 */

/** The website: the account's page, and the host of the account service. */
export const WEBSITE = 'https://www.leafbot.app';

/** The sign-in cookie the website sets; host-only, so no other host of leafbot.app sees it. */
export const SESSION_COOKIE = '__Host-leafbot_session';

const CSRF_HEADER = 'x-leafbot-csrf';

/** The website's page of the person's servers, at one of them when `server` names it. */
export function accountUrl(server: string | null): string {
  const url = new URL('/bots/', WEBSITE);
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

export interface AccountDeps {
  /** The website's address; the website by default. */
  base?: string;
  /** A plain `fetch`: the cookie and the origin are set here, not by a browser. */
  fetch: typeof fetch;
  /** The window's sign-in cookie as a `Cookie` header value; null while the person is signed out. */
  cookie(): Promise<string | null>;
}

export interface AccountClient {
  /** The servers the person may reach. */
  servers(): Promise<ServerEntry[]>;
  /** A client ticket for one server, bound to a device key's thumbprint. */
  ticket(serverId: string, jkt: string): Promise<Ticket>;
}

export function accountClient(d: AccountDeps): AccountClient {
  const base = d.base ?? WEBSITE;
  // The token follows from the cookie's value, so it is asked for again only when that changes.
  let csrf: { cookie: string; token: string } | null = null;

  async function call<T>(method: string, path: string, cookie: string, body?: unknown, token?: string) {
    const headers: Record<string, string> = { cookie, accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (method !== 'GET') {
      headers.origin = base;
      if (token) headers[CSRF_HEADER] = token;
    }
    let res: Response;
    try {
      res = await d.fetch(`${base}/api/v1${path}`, {
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

  const signedIn = async (): Promise<string> => {
    const cookie = await d.cookie();
    if (!cookie) throw new AccountError(401, 'unauthorized');
    return cookie;
  };

  return {
    async servers() {
      const cookie = await signedIn();
      return (await call<{ servers: ServerEntry[] }>('GET', '/servers', cookie)).servers;
    },
    async ticket(serverId, jkt) {
      const cookie = await signedIn();
      if (csrf?.cookie !== cookie) {
        const s = await call<{ csrf?: string }>('GET', '/session', cookie);
        if (!s.csrf) throw new AccountError(401, 'unauthorized');
        csrf = { cookie, token: s.csrf };
      }
      try {
        return await call<Ticket>(
          'POST',
          `/servers/${encodeURIComponent(serverId)}/ticket`,
          cookie,
          { jkt },
          csrf.token,
        );
      } catch (err) {
        // A token the service no longer takes (the cookie was renewed) is asked for again next time.
        if (err instanceof AccountError && err.code === 'csrf') csrf = null;
        throw err;
      }
    },
  };
}
