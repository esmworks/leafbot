import { desktop, type DesktopAnswer } from '@/lib/desktop';

/**
 * The account service as the web app reaches it. On the website: on this origin under /api/v1, with
 * the session cookie the website's sign-in set; writes carry the session's CSRF token, handed out by
 * `GET /session`. In the desktop app: through the app, which holds a session of its own and signs the
 * person in in their browser, so the window never shows the website.
 */
const BASE = '/api/v1';

export type Role = 'owner' | 'admin' | 'member';

export interface ServerEntry {
  id: string;
  name: string;
  role: Role;
  /** The server's Ed25519 public key; a tunnel to a server showing another is refused. */
  publicKey: string;
  seenAt: number;
}

export class AccountError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

/** The desktop app's account, on the page of the account's servers it shows; null on the website. */
export const desktopAccount = desktop?.account ?? null;

let csrf: string | undefined;

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET' && csrf) headers['x-leafbot-csrf'] = csrf;
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new AccountError(0, 'unreachable');
  }
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new AccountError(res.status, data?.error ?? `http_${res.status}`);
  return data as T;
}

/** An answer from the desktop app, as the same value or error a call on the website gives. */
async function fromDesktop<T>(ask: () => Promise<DesktopAnswer<unknown>>): Promise<T> {
  let a: DesktopAnswer<unknown>;
  try {
    a = await ask();
  } catch {
    throw new AccountError(0, 'unreachable');
  }
  if (!a.ok) throw new AccountError(a.status, a.code);
  return a.data as T;
}

export const account = {
  /** Checks the person is signed in (and, on the website, takes the CSRF token for writes). */
  async session(): Promise<void> {
    if (desktopAccount) return;
    const s = await call<{ user: { id: string; email: string }; csrf?: string }>('GET', '/session');
    csrf = s.csrf;
  },
  servers: (): Promise<ServerEntry[]> =>
    desktopAccount
      ? fromDesktop(() => desktopAccount.servers())
      : call<{ servers: ServerEntry[] }>('GET', '/servers').then((r) => r.servers),
  /** A one-time code (as a QR code) that signs a phone in to this account; it works once, for two minutes. */
  async connectCode(): Promise<{ code: string; expiresAt: number; url: string }> {
    if (desktopAccount) return fromDesktop(() => desktopAccount.connectCode());
    if (!csrf) await account.session();
    return call<{ code: string; expiresAt: number; url: string }>('POST', '/connect-codes');
  },
  /** A client ticket for one server, bound to this browser's device key. */
  ticket: (
    serverId: string,
    jkt: string,
  ): Promise<{ ticket: string; publicKey: string; expiresAt: number }> =>
    desktopAccount
      ? fromDesktop(() => desktopAccount.ticket(serverId, jkt))
      : call('POST', `/servers/${encodeURIComponent(serverId)}/ticket`, { jkt }),
};

/** The website's sign-in, coming back here afterwards, to the server the address named if any. */
export function signInUrl(): string {
  return `/login?next=${encodeURIComponent(import.meta.env.BASE_URL.replace(/\/$/, '') + location.search)}`;
}

/**
 * Opens a page of the website (adding a server, say): in place on the website, in the person's
 * browser in the desktop app.
 */
export function openWebsite(path: string) {
  if (desktopAccount) void desktopAccount.openWebsite(path);
  else location.assign(path);
}
