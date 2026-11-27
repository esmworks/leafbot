/**
 * The account service as the web app on the website reaches it: on this origin under /api/v1, with
 * the session cookie the website's sign-in set. Writes carry the session's
 * CSRF token, handed out by `GET /session`.
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

export const account = {
  async session(): Promise<{ user: { id: string; email: string } }> {
    const s = await call<{ user: { id: string; email: string }; csrf?: string }>('GET', '/session');
    csrf = s.csrf;
    return s;
  },
  servers: () => call<{ servers: ServerEntry[] }>('GET', '/servers').then((r) => r.servers),
  /** A client ticket for one server, bound to this browser's device key. */
  ticket: (serverId: string, jkt: string) =>
    call<{ ticket: string; publicKey: string; expiresAt: number }>(
      'POST',
      `/servers/${encodeURIComponent(serverId)}/ticket`,
      { jkt },
    ),
};

/** The website's sign-in, coming back here afterwards, to the server the address named if any. */
export function signInUrl(): string {
  return `/login?next=${encodeURIComponent(import.meta.env.BASE_URL.replace(/\/$/, '') + location.search)}`;
}
