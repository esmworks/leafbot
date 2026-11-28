import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AccountError, codeOfConnectLink, connectPageUrl, newPkce, type AccountClient } from './account';

/** How long a sign-in started in the browser waits for its code to come back. */
export const SIGN_IN_WAIT_MS = 10 * 60_000;

const FILE = 'account-session';

export interface SessionFile {
  /** Encrypts with the system's keychain (Electron's safeStorage); throws where none is available. */
  encrypt(text: string): Buffer;
  decrypt(data: Buffer): string;
}

/**
 * This app's session at the account service, kept encrypted with the system's keychain in the
 * app's data folder (readable by this user only). Nothing is kept where the keychain is missing:
 * the person signs in again on the next start.
 */
export function readSession(dir: string, crypt: SessionFile): string | null {
  const file = join(dir, FILE);
  if (!existsSync(file)) return null;
  try {
    const token = crypt.decrypt(readFileSync(file)).trim();
    return token || null;
  } catch {
    return null;
  }
}

export function writeSession(dir: string, crypt: SessionFile, token: string | null) {
  const file = join(dir, FILE);
  if (!token) {
    rmSync(file, { force: true });
    return;
  }
  writeFileSync(file, crypt.encrypt(token), { mode: 0o600 });
}

/** How a sign-in ended: signed in, or why not, in a word the page turns into text. */
export type SignInResult =
  { ok: true } | { ok: false; reason: 'replaced' | 'expired' | 'rejected' | 'unreachable' | 'failed' };

export interface SignInDeps {
  account: Pick<AccountClient, 'redeem'>;
  /** Opens an address in the person's browser. */
  openBrowser(url: string): Promise<void>;
  locale(): string;
  /** Keeps the new session; the app is signed in from now on. */
  signedIn(token: string): void;
  now?: () => number;
  waitMs?: number;
}

/**
 * One sign-in at a time: `start` opens the website's connect page in the browser with a fresh PKCE
 * challenge and waits; `finish` takes the `leafbot://connect` link the page sends back and spends its
 * code with the waiting sign-in's verifier. A second start replaces the first, whose code then fails.
 */
export class BrowserSignIn {
  private waiting: {
    verifier: string;
    startedAt: number;
    done(r: SignInResult): void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

  constructor(private d: SignInDeps) {}

  private now() {
    return (this.d.now ?? Date.now)();
  }

  /** Opens the browser; resolves when the code came back and was spent, or the sign-in ended. */
  start(): Promise<SignInResult> {
    this.end({ ok: false, reason: 'replaced' });
    const { verifier, challenge } = newPkce();
    return new Promise<SignInResult>((resolve) => {
      const timer = setTimeout(
        () => this.end({ ok: false, reason: 'expired' }),
        this.d.waitMs ?? SIGN_IN_WAIT_MS,
      );
      timer.unref?.();
      this.waiting = { verifier, startedAt: this.now(), done: resolve, timer };
      this.d
        .openBrowser(connectPageUrl(this.d.locale(), challenge))
        .catch(() => this.end({ ok: false, reason: 'failed' }));
    });
  }

  /** Whether a sign-in waits for its code. */
  get pending(): boolean {
    return this.waiting !== null;
  }

  /**
   * Takes a `leafbot://connect` link. Without a sign-in waiting for it (the app restarted, or the
   * link came from somewhere else) it is not spent: a code is spent only by the sign-in that asked.
   */
  async finish(link: string): Promise<SignInResult | null> {
    const w = this.waiting;
    if (!w) return null;
    const code = codeOfConnectLink(link);
    if (!code) return this.end({ ok: false, reason: 'rejected' });
    if (this.now() - w.startedAt > (this.d.waitMs ?? SIGN_IN_WAIT_MS))
      return this.end({ ok: false, reason: 'expired' });
    try {
      const r = await this.d.account.redeem(code, w.verifier);
      if (this.waiting !== w) return null;
      this.d.signedIn(r.token);
      return this.end({ ok: true });
    } catch (err) {
      if (this.waiting !== w) return null;
      const reason = err instanceof AccountError && err.status === 0 ? 'unreachable' : 'rejected';
      return this.end({ ok: false, reason });
    }
  }

  /** Stops waiting (the person signed in another way, or quit); the page hears `replaced`. */
  cancel() {
    this.end({ ok: false, reason: 'replaced' });
  }

  private end(r: SignInResult): SignInResult {
    const w = this.waiting;
    if (w) {
      this.waiting = null;
      clearTimeout(w.timer);
      w.done(r);
    }
    return r;
  }
}
