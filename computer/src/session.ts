// The helper that runs inside one bot's sandbox. The controller reaches it over unix sockets in the
// session's control directory:
//   helper.sock  HTTP: GET /ping, POST /exec, /screenshot, /action, /browser/open
//   cdp.sock     raw stream to the session's Chromium (Chrome DevTools Protocol, NUL-framed)
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';
import type { Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { hostname } from 'node:os';
import { join } from 'node:path';
import {
  DESKTOP_SIZE,
  DesktopAction,
  DesktopExec,
  DesktopJobQuery,
  DesktopJobStart,
  type GitAuthor,
} from '@leafbot/shared';
import { clearForeignProfileLock, isOpenableUrl, Jobs, pngSize, TailBuffer, xdotoolArgs } from './lib';
import { authorEnv, commandGitEnv } from './sandbox';

const CTL = process.env.LEAFBOT_CTL ?? '/run/ctl';
const HOME = process.env.HOME ?? '/tmp';
// Google Chrome in the computer image (see computer/Dockerfile); any Chromium-based browser works.
const CHROMIUM = process.env.LEAFBOT_CHROMIUM ?? 'google-chrome-stable';
const MAX_OUTPUT = 100_000;
const MAX_BODY = 1024 * 1024;

// The profile keeps the folder of the Chromium the image had before Chrome, so bots keep their sign-ins.
const PROFILE = join(HOME, '.config', 'chromium');
/**
 * The bot's language for the browser's menus and the pages it asks for. Left to itself Chromium
 * asks every site in English, and a Turkish address asking in English is one more thing bot guards
 * weigh against a browser.
 */
const browserLanguage = (process.env.LANG ?? '').startsWith('tr')
  ? ['--lang=tr', '--accept-lang=tr-TR,tr,en-US,en']
  : ['--lang=en-US', '--accept-lang=en-US,en'];
const chromiumArgs = [
  '--user-data-dir=' + PROFILE,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-session-crashed-bubble',
  '--start-maximized',
  ...browserLanguage,
  // The DevTools pipe makes Chromium report navigator.webdriver = true, which bot guards (Akamai
  // and the like) read as a program driving the browser and answer by cutting the site's requests.
  '--disable-blink-features=AutomationControlled',
  // Chromium builds send the experimental TLS Trust Anchor IDs extension (0xca34), which Google
  // Chrome does not; the extra extension makes the handshake unlike any Chrome a site knows, and the
  // same bot guards refuse it. The flag keeps it off whichever browser LEAFBOT_CHROMIUM names.
  '--disable-features=TLSTrustAnchorIDs',
  // The desktop has no GPU, and Chromium no longer falls back to drawing WebGL in software on its
  // own: without this flag pages get no WebGL at all. Maps need it, and bot guards such as
  // Cloudflare's check read a browser without WebGL as a program.
  '--enable-unsafe-swiftshader',
  // The controller's proxy: the way out through the person's own computer when it is connected.
  // WebRTC would otherwise send UDP around it and show sites this machine's address.
  ...(process.env.LEAFBOT_PROXY
    ? [
        `--proxy-server=${process.env.LEAFBOT_PROXY}`,
        '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      ]
    : []),
];

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

const fail = (res: ServerResponse, status: number, code: string, error: string) =>
  send(res, status, { error, code });

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

// ---- exec ----------------------------------------------------------------------------------

/**
 * The environment of one command: the session's, with git sent to the command's own relay address
 * when the computer service gave one (a key brought by the person the step works for), and the
 * commits written by the account of the key the command's git uses, when the server named it.
 */
function commandEnv(body: unknown, author: GitAuthor | undefined): NodeJS.ProcessEnv | undefined {
  const git = commandGitEnv((body as { gitRelay?: unknown } | null)?.gitRelay);
  const by = authorEnv(author);
  return git || author ? { ...process.env, ...git, ...by } : undefined;
}

function runCommand(command: string, cwd: string, timeoutMs: number, env?: NodeJS.ProcessEnv) {
  return new Promise<{ exitCode: number | null; output: string; truncated: boolean; timedOut: boolean }>(
    (resolve) => {
      const tail = new TailBuffer(MAX_OUTPUT);
      const child = spawn('bash', ['-lc', command], {
        cwd,
        env,
        detached: true, // its own process group, so a timeout can kill everything it started
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      // Separate decoders: a character split across chunks must not be joined with the other pipe's.
      const out = new StringDecoder('utf8');
      const err = new StringDecoder('utf8');
      child.stdout.on('data', (c: Buffer) => tail.push(out.write(c)));
      child.stderr.on('data', (c: Buffer) => tail.push(err.write(c)));
      let timedOut = false;
      let done = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid!, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }, timeoutMs);
      const finish = (exitCode: number | null) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        tail.push(out.end() + err.end());
        child.stdout.destroy();
        child.stderr.destroy();
        resolve({ exitCode, ...tail.result(), timedOut });
      };
      child.on('error', (e) => {
        tail.push(`${e.message}\n`);
        finish(null);
      });
      // A background process that keeps the pipes open must not hold the answer back.
      child.on('exit', (code) => setTimeout(() => finish(code), 150));
      child.on('close', (code) => finish(code));
    },
  );
}

/** Commands left running in the background, for builds and installs longer than one call. */
const jobs = new Jobs((command, cwd, env) =>
  spawn('bash', ['-lc', command], {
    cwd,
    env,
    detached: true, // its own process group, so the whole job can be stopped
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
);
process.on('exit', () => jobs.stopAll());

// ---- desktop tools -------------------------------------------------------------------------

const run = (file: string, args: string[], timeout = 15_000) =>
  new Promise<void>((resolve, reject) =>
    execFile(file, args, { timeout }, (err, _out, stderr) =>
      err ? reject(new Error(stderr.trim() || err.message)) : resolve(),
    ),
  );

async function screenshot() {
  const dir = mkdtempSync('/tmp/shot-');
  const file = join(dir, 's.png');
  try {
    await run('scrot', ['-o', file]);
    const png = readFileSync(file);
    const size = pngSize(png) ?? DESKTOP_SIZE;
    return { png: png.toString('base64'), width: size.width, height: size.height };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---- Chromium ------------------------------------------------------------------------------

let chromium: ChildProcess | null = null;
let toBrowser: Writable | null = null;
let cdpClient: Socket | null = null;

/** Starts the one Chromium of this session (with the DevTools pipe) unless it is running. */
function ensureChromium(url?: string): boolean {
  if (chromium && chromium.exitCode === null) return false;
  if (clearForeignProfileLock(PROFILE, hostname()))
    console.error('chromium: removed a lock left by another host');
  const args = ['--remote-debugging-pipe', ...chromiumArgs, ...(url ? ['--', url] : [])];
  // fd 3: Chromium reads our commands; fd 4: Chromium writes its answers and events.
  const child = spawn(CHROMIUM, args, { stdio: ['ignore', 'inherit', 'inherit', 'pipe', 'pipe'] });
  chromium = child;
  toBrowser = child.stdio[3] as Writable;
  toBrowser.on('error', () => {});
  const fromBrowser = child.stdio[4]!;
  // Always drain: events pile up in the pipe even when nobody listens. Only the current Chromium
  // speaks to the client: one that relaunched itself may keep the pipe after this child exited,
  // and its answers would reach a client that never asked them.
  fromBrowser.on('data', (d: Buffer) => {
    if (chromium === child) cdpClient?.write(d);
  });
  fromBrowser.on('error', () => {});
  child.on('error', (e) => console.error('chromium:', e.message));
  child.on('exit', () => {
    if (chromium === child) {
      chromium = null;
      toBrowser = null;
      cdpClient?.destroy();
    }
  });
  return true;
}

/** Opens a URL in the session's Chromium, starting it first if needed. */
function openInBrowser(url: string): void {
  if (ensureChromium(url || undefined)) return;
  // Already running: a second launch on the same profile hands the URL to the running one and
  // exits. This avoids sharing the single DevTools pipe with a client that may be connected.
  const args = [...chromiumArgs, ...(url ? ['--', url] : [])];
  spawn(CHROMIUM, args, { stdio: 'ignore', detached: true })
    .on('error', () => {})
    .unref();
}

// ---- servers -------------------------------------------------------------------------------

const http = createHttpServer(async (req, res) => {
  try {
    const path = (req.url ?? '').split('?')[0];
    if (req.method === 'GET' && path === '/ping') return send(res, 200, { ok: true });
    if (req.method !== 'POST') return fail(res, 404, 'badRequest', 'not found');
    const raw = await readBody(req);

    if (path === '/browser/open') {
      const url = (new URLSearchParams(raw).get('url') ?? '').trim();
      if (!isOpenableUrl(url)) return fail(res, 400, 'badRequest', 'url not allowed');
      openInBrowser(url);
      return send(res, 200, { ok: true });
    }

    let json: unknown = {};
    if (raw) {
      try {
        json = JSON.parse(raw);
      } catch {
        return fail(res, 400, 'badRequest', 'invalid JSON');
      }
    }
    if (path === '/exec') {
      const p = DesktopExec.safeParse(json);
      if (!p.success) return fail(res, 400, 'badRequest', p.error.message);
      return send(
        res,
        200,
        await runCommand(p.data.command, p.data.cwd, p.data.timeoutMs, commandEnv(json, p.data.author)),
      );
    }
    if (path === '/jobs/start') {
      const p = DesktopJobStart.safeParse(json);
      if (!p.success) return fail(res, 400, 'badRequest', p.error.message);
      try {
        return send(
          res,
          200,
          await jobs.status(jobs.run(p.data.command, p.data.cwd, commandEnv(json, p.data.author))),
        );
      } catch (e) {
        return fail(res, 409, 'failed', e instanceof Error ? e.message : String(e));
      }
    }
    if (path === '/jobs/status') {
      const p = DesktopJobQuery.safeParse(json);
      if (!p.success) return fail(res, 400, 'badRequest', p.error.message);
      const job = await jobs.status(p.data.id, p.data.waitMs);
      return job ? send(res, 200, job) : fail(res, 404, 'badRequest', 'no such job');
    }
    if (path === '/screenshot') return send(res, 200, await screenshot());
    if (path === '/action') {
      const p = DesktopAction.safeParse(json);
      if (!p.success) return fail(res, 400, 'badRequest', p.error.message);
      await run('xdotool', xdotoolArgs(p.data));
      return send(res, 200, { ok: true });
    }
    return fail(res, 404, 'badRequest', 'not found');
  } catch (e) {
    fail(res, 500, 'failed', e instanceof Error ? e.message : String(e));
  }
});

// One CDP client at a time: a second connection is closed at once.
const cdp = createNetServer((sock) => {
  if (cdpClient) return void sock.destroy();
  ensureChromium();
  cdpClient = sock;
  sock.on('data', (d) => toBrowser?.write(d));
  sock.on('error', () => {});
  sock.on('close', () => {
    if (cdpClient === sock) cdpClient = null;
  });
});

function listen(server: ReturnType<typeof createNetServer> | typeof http, path: string): void {
  rmSync(path, { force: true });
  server.listen(path, () => chmodSync(path, 0o600));
}

listen(cdp, join(CTL, 'cdp.sock'));
listen(http, join(CTL, 'helper.sock'));

const stop = () => {
  chromium?.kill('SIGTERM');
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
