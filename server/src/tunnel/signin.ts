import { hostname } from 'node:os';
import type { Locale } from '@leafbot/shared';
import type { ServerKey } from '../i18n';
import { OWNER_ID } from '../users';
import { HttpError } from '../util';
import type { AccountHost, AccountHostState } from './host';
import type { AccountLinks } from './links';

/** How long the account's sign-in waits for the name before it is let go. */
const PENDING_MS = 30 * 60_000;
/** The longest name the account keeps, as a ticket's `name` claim allows. */
export const MAX_ACCOUNT_NAME = 80;

interface AccountUser {
  id: string;
  email: string;
  name?: string;
}

export interface SignedIn {
  email: string;
  name: string;
  /** The account has no name yet: the app asks for it next. */
  needsName: boolean;
  host: AccountHostState;
}

/** A name as typed: spaces folded, control and formatting characters gone; null when unusable. */
export function cleanName(raw: string): string | null {
  const name = raw
    .normalize('NFC')
    .replace(/\s/g, ' ')
    // Formatting characters go, but the joiners some scripts (Persian, Hindi) need in names stay;
    // spaces are folded after, so one that stood around a removed character is not left double.
    .replace(/(?![\u200c\u200d])[\p{Cc}\p{Cf}]/gu, '')
    .replace(/ +/g, ' ')
    .trim();
  return name && name.length <= MAX_ACCOUNT_NAME ? name : null;
}

/**
 * The owner signing in to their Leaf Bot account from this server's own app: the server asks the
 * account service for a sign-in code, checks it, gets an install code with that sign-in and links
 * itself, so the owner is the account from then on and reaches the server from anywhere. The
 * account's token stays here, in memory, only until the name is known, then the sign-in is ended;
 * the server keeps only its own machine token, as when it is linked by hand.
 */
export class AccountSignIn {
  private pending: { token: string; until: number; timer: ReturnType<typeof setTimeout> } | null = null;
  private fetcher: typeof fetch;

  constructor(
    private deps: {
      issuer: string;
      host: AccountHost;
      links: AccountLinks;
      fetcher?: typeof fetch;
      now?: () => number;
    },
  ) {
    this.fetcher = deps.fetcher ?? ((i, init) => fetch(i, init));
  }

  private now() {
    return (this.deps.now ?? Date.now)();
  }

  private async call(
    path: string,
    init: { method: string; body?: unknown; token?: string; lang?: Locale },
  ): Promise<{ status: number; body: Record<string, unknown> | null }> {
    const headers: Record<string, string> = { 'user-agent': 'Leaf Bot server' };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    if (init.lang) headers['accept-language'] = init.lang;
    const res = await this.fetcher(`${this.deps.issuer}${path}`, {
      method: init.method,
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    }).catch(() => null);
    if (!res) throw new HttpError(502, 'error.accountUnreachable');
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: res.status, body };
  }

  /**
   * The account service's refusal as the app shows it. `badRequest`: what a plain 400 means at this
   * step; only the email can be wrong when the code is asked for.
   */
  private refused(
    r: { status: number; body: Record<string, unknown> | null },
    badRequest: ServerKey = 'error.accountEmailInvalid',
  ): never {
    const code = typeof r.body?.error === 'string' ? r.body.error : '';
    if (r.status === 429) throw new HttpError(429, 'error.accountTooManyTries');
    if (code === 'invalid_code') throw new HttpError(400, 'error.accountCodeWrong');
    if (code === 'mail_unavailable' || code === 'mail_failed')
      throw new HttpError(503, 'error.accountMailUnavailable');
    if (r.status === 400) throw new HttpError(400, badRequest);
    throw new HttpError(502, 'error.accountUnreachable');
  }

  /** Mails a sign-in code to the address, in the app's language. */
  async start(email: string, lang: Locale): Promise<void> {
    const r = await this.call('/v1/auth/email/start', { method: 'POST', body: { email }, lang });
    if (r.status !== 204 && r.status !== 200) this.refused(r);
  }

  /**
   * Checks the code, then links this server to the account with an install code that sign-in gets,
   * and makes the account this server's owner here. The account's name, when it has one, becomes
   * the owner's. `signal`: the person stopped (the terminal's Ctrl+C); the server is then not linked,
   * unless it already was by the time they did.
   */
  async verify(email: string, code: string, opts: { signal?: AbortSignal } = {}): Promise<SignedIn> {
    const stopped = async (token: string) => {
      if (!opts.signal?.aborted) return;
      await this.end(token);
      throw opts.signal.reason;
    };
    const r = await this.call('/v1/auth/email/verify', {
      method: 'POST',
      body: { email, code, client: 'desktop' },
    });
    const user = r.body?.user as AccountUser | undefined;
    const token = typeof r.body?.token === 'string' ? r.body.token : null;
    if (r.status !== 200 || !user?.id || !token) this.refused(r);
    await stopped(token);
    const name = serverName();
    const install = await this.call('/v1/servers/install-codes', { method: 'POST', body: { name }, token });
    const installCode = typeof install.body?.code === 'string' ? install.body.code : null;
    if (install.status !== 201 || !installCode) {
      await this.end(token);
      this.refused(install, 'error.accountInstallRefused');
    }
    await stopped(token);
    let host: AccountHostState;
    try {
      host = await this.deps.host.link(installCode, name);
    } catch (e) {
      await this.end(token);
      throw e;
    }
    try {
      await this.deps.links.linkOwner(user.id);
    } catch (e) {
      // Linked with no owner here, the account would reach the server as nobody: let it go again,
      // so the app asks for the sign-in once more.
      await this.end(token);
      host = await this.deps.host.unlink().catch(() => host);
      throw e;
    }
    // A sign-in still waiting for a name is replaced by this one.
    await this.drop();
    const accountName = typeof user.name === 'string' ? user.name.trim() : '';
    if (accountName) {
      try {
        await this.deps.links.useName(OWNER_ID, accountName);
      } finally {
        await this.end(token);
      }
    } else this.hold(token);
    return { email: user.email, name: accountName, needsName: !accountName, host };
  }

  /**
   * Gives the account the name the owner typed, and calls the owner by it here. Without a sign-in
   * waiting (the server restarted in between), the name is kept here only; the website asks the
   * account for it on its next visit there.
   */
  async setName(raw: string): Promise<{ name: string; savedToAccount: boolean }> {
    const name = cleanName(raw);
    if (!name) throw new HttpError(400, 'error.accountNameInvalid');
    const token = await this.take();
    let saved = false;
    if (token) {
      const r = await this.call('/v1/me', { method: 'PATCH', body: { name }, token }).catch(() => null);
      saved = r?.status === 200;
      await this.end(token);
    }
    await this.deps.links.useName(OWNER_ID, name, { always: true });
    return { name, savedToAccount: saved };
  }

  /**
   * Keeps the account's sign-in for the name the app asks next, and ends it when no name comes in
   * time, so it does not stay among the account's sign-ins. A restart forgets it; it then runs out
   * on the account's side.
   */
  private hold(token: string) {
    const timer = setTimeout(() => {
      if (this.pending?.token !== token) return;
      this.pending = null;
      void this.end(token);
    }, PENDING_MS);
    timer.unref?.();
    this.pending = { token, until: this.now() + PENDING_MS, timer };
  }

  /** The sign-in waiting for the name, while it is still good; an expired one is ended. */
  private async take(): Promise<string | null> {
    const p = this.pending;
    if (!p) return null;
    this.pending = null;
    clearTimeout(p.timer);
    if (p.until > this.now()) return p.token;
    await this.end(p.token);
    return null;
  }

  /** Ends the sign-in waiting for the name, if there is one. */
  private async drop() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    clearTimeout(p.timer);
    await this.end(p.token);
  }

  /** Ends the account sign-in the server held; a failure only leaves it to run out by itself. */
  private async end(token: string) {
    await this.call('/v1/auth/signout', { method: 'POST', token }).catch(() => null);
  }
}

/**
 * What the account lists this server as: `LEAFBOT_SERVER_NAME`, else the computer's name. In a
 * container the computer's name is the container's id, which tells the owner nothing.
 */
function serverName(): string {
  return (
    (process.env.LEAFBOT_SERVER_NAME?.trim() || hostname().replace(/\.local$/, '')).trim().slice(0, 80) ||
    'Leaf Bot'
  );
}
