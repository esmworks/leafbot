import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ProviderSignIn } from '@leafbot/shared';
import { HttpError, newId } from '../util';

/** A sign-in nobody finishes is dropped after this long. */
const SIGN_IN_MS = 15 * 60 * 1000;
/** The only sites the sign-in may send the person to; any other address it prints is not shown. */
const SIGN_IN_HOSTS = ['claude.ai', 'claude.com', 'anthropic.com'];
const SDK = '@anthropic-ai/claude-agent-sdk';

let musl: boolean | null = null;
function isMusl(): boolean {
  if (musl === null) {
    const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
    musl = !!report && report.header?.glibcVersionRuntime === undefined;
  }
  return musl;
}

/**
 * The Claude Code program that comes with the Agent SDK, looked up the way the SDK looks it up, so
 * the person needs no Claude Code of their own to sign in. Null when this platform's build is
 * missing. A Claude Code on the PATH is never used: it may be another version, or not there at all.
 */
export function bundledClaude(): string | null {
  let sdkRequire: NodeJS.Require;
  try {
    sdkRequire = createRequire(createRequire(import.meta.url).resolve(SDK));
  } catch {
    return null;
  }
  const { platform, arch } = process;
  const linux = [`${SDK}-linux-${arch}`, `${SDK}-linux-${arch}-musl`];
  const packages =
    platform === 'linux' ? (isMusl() ? linux.reverse() : linux) : [`${SDK}-${platform}-${arch}`];
  const file = platform === 'win32' ? 'claude.exe' : 'claude';
  for (const name of packages) {
    try {
      const path = sdkRequire.resolve(`${name}/${file}`);
      if (existsSync(path)) return path;
    } catch {
      // Not installed for this platform; try the next.
    }
  }
  return null;
}

/** Terminal colours and links the CLI writes around its text. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  const links = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  // eslint-disable-next-line no-control-regex
  const styles = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
  return text.replace(links, '').replace(styles, '').replace(/\r/g, '');
}

/** The first sign-in page the CLI printed, on Claude's own sites over https only. */
export function signInUrl(output: string): string | null {
  for (const [candidate] of plain(output).matchAll(/https:\/\/[^\s"'<>]+/g)) {
    try {
      const url = new URL(candidate);
      const host = url.hostname.toLowerCase();
      if (SIGN_IN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return url.toString();
    } catch {
      // Not an address after all.
    }
  }
  return null;
}

/** The CLI's last line of text, as the reason a sign-in failed. */
function lastLine(output: string): string | null {
  const lines = plain(output)
    .split('\n')
    // The prompt ends with no line break, so what comes after it shares its line.
    .map((l) => l.replace(/^\s*paste code here(?: if prompted)?\s*>\s*/i, '').trim())
    .filter(Boolean);
  const line = lines.at(-1);
  return line ? line.slice(0, 300) : null;
}

export interface ClaudeSignInOptions {
  /** The Claude Code program to run; null when none came with the server. */
  executable: () => string | null;
  /** The program's environment: the engine's own, so the sign-in is saved where the bots read it. */
  env: () => Record<string, string>;
  /**
   * Called once the program saved the sign-in, before the app hears how it ended: null when Claude
   * answers with the new login, else why not.
   */
  onSignedIn: () => Promise<string | null>;
}

interface Session extends ProviderSignIn {
  child: ChildProcessWithoutNullStreams;
  timer: NodeJS.Timeout;
  output: string;
  /** What the program wrote since the last pasted code; null before any. */
  sincePaste: string | null;
}

const live = (s: Session) => s.status === 'starting' || s.status === 'waiting';

/**
 * Signing in to Claude with the person's own account, through Claude Code's own `auth login`, so
 * nobody has to install Claude Code or open a terminal. The program opens the sign-in page in the
 * browser of the computer it runs on, which comes back to it by itself; it also prints a page that
 * shows a code instead, for a server elsewhere, and the person pastes that code here. The program
 * keeps the login itself (and renews it) where the bots' Claude reads it: the server only follows.
 */
export class ClaudeSignInService {
  private sessions = new Map<string, Session>();

  constructor(private opts: ClaudeSignInOptions) {}

  /** Starts signing in; the app follows it with `status` until it is done. */
  start(): ProviderSignIn {
    const executable = this.opts.executable();
    if (!executable) throw new HttpError(501, 'error.claudeSignInMissing');
    // One at a time: the program listens on a local port for the browser to come back.
    for (const s of this.sessions.values()) if (live(s)) this.end(s, 'cancelled');
    const child = spawn(executable, ['auth', 'login', '--claudeai'], {
      env: this.opts.env(),
      // stdin stays open: the program gives up when it closes before a code arrives.
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const session: Session = {
      id: newId(),
      provider: 'claude',
      status: 'starting',
      url: null,
      userCode: null,
      needsPaste: false,
      error: null,
      message: null,
      child,
      output: '',
      sincePaste: null,
      timer: setTimeout(() => this.end(session, 'cancelled'), SIGN_IN_MS),
    };
    session.timer.unref();
    this.sessions.set(session.id, session);
    const read = (chunk: Buffer) => {
      if (!live(session)) return;
      const text = chunk.toString('utf8');
      session.output = (session.output + text).slice(-8000);
      // A code it cannot take (cut short, say) is answered with why, and it goes on waiting for one.
      if (session.sincePaste !== null) {
        session.sincePaste = (session.sincePaste + text).slice(-2000);
        const line = lastLine(session.sincePaste);
        // Taking a good code is not something to point out.
        session.message = line && !/^signing in/i.test(line) ? line : null;
      }
      if (session.url) return;
      const url = signInUrl(session.output);
      if (!url) return;
      session.url = url;
      session.status = 'waiting';
      session.needsPaste = true;
    };
    child.stdout.on('data', read);
    child.stderr.on('data', read);
    // A write after the program ended is not an error worth a crash.
    child.stdin.on('error', () => {});
    child.on('error', (err) => {
      if (!live(session)) return;
      session.error = err.message;
      this.end(session, 'error');
    });
    child.on('close', (code) => {
      if (!live(session)) return;
      if (code !== 0) {
        session.error = lastLine(session.output) ?? `exit ${code ?? 'signal'}`;
        this.end(session, 'error');
        return;
      }
      // Done only once Claude answers with the new login, so the app's next look shows it connected.
      session.needsPaste = false;
      void this.opts
        .onSignedIn()
        .catch((err: unknown) => (err instanceof Error ? err.message : String(err)))
        .then((problem) => {
          session.error = problem;
          this.end(session, problem ? 'error' : 'done');
        });
    });
    return this.view(session);
  }

  private end(session: Session, status: 'done' | 'error' | 'cancelled') {
    session.status = status;
    session.needsPaste = false;
    clearTimeout(session.timer);
    const { child } = session;
    if (child.exitCode === null && child.signalCode === null) child.kill();
    // Kept a little longer so the app can read how it ended.
    setTimeout(() => this.sessions.delete(session.id), 60_000).unref();
  }

  private view(s: Session): ProviderSignIn {
    return {
      id: s.id,
      provider: s.provider,
      status: s.status,
      url: s.url,
      userCode: s.userCode,
      needsPaste: s.needsPaste,
      error: s.error,
      message: s.message ?? null,
    };
  }

  private get(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, 'error.notFound');
    return s;
  }

  status(id: string): ProviderSignIn {
    return this.view(this.get(id));
  }

  /**
   * The code the sign-in page showed, for a browser that could not come back to the program by
   * itself. It goes to the program only: it is a credential, so it is never kept or logged here.
   */
  paste(id: string, input: string): ProviderSignIn {
    const s = this.get(id);
    if (!live(s) || !s.needsPaste) throw new HttpError(409, 'error.signInNoPaste');
    s.sincePaste = '';
    s.message = null;
    // The field stays: a code the program does not take is pasted again.
    s.child.stdin.write(`${input.replace(/\s+/g, '')}\n`);
    return this.view(s);
  }

  cancel(id: string) {
    const s = this.sessions.get(id);
    if (s && live(s)) this.end(s, 'cancelled');
  }

  /** Ends sign-ins under way, as the server stops. */
  stop() {
    for (const s of this.sessions.values()) if (live(s)) this.end(s, 'cancelled');
  }
}
