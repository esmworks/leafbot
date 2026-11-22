// The computer service: starts one sandboxed Linux desktop per bot and forwards the server's
// requests to the helper inside it. See shared/src/computer.ts for the API.
import './old-env';
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { connect, createServer as createNetServer, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  DesktopAction,
  DesktopExec,
  DesktopGit,
  DesktopId,
  DesktopStart,
  type ComputerErrorCode,
  type DesktopStatus,
  DesktopJobQuery,
  DesktopJobStart,
} from '@leafbot/shared';
import {
  dialPublic,
  EgressError,
  EgressMux,
  join as joinStreams,
  socksAccept,
  socksReply,
  socksReplyFor,
  SOCKS_REPLY,
  upstreamProxy,
} from '@leafbot/shared/egress';
import { createGitRelay, GitGrants } from './git-relay';
import { allocateDisplay, bearerToken, CdpDecoder, checkToken, encodeCdp } from './lib';
import { bwrapArgs, checkSessionPath, collectBinds, type SandboxOptions } from './sandbox';

const TOKEN = process.env.LEAFBOT_COMPUTER_TOKEN ?? '';
if (TOKEN.length < 32) {
  console.error('LEAFBOT_COMPUTER_TOKEN must be set and at least 32 characters long.');
  process.exit(1);
}
const PORT = Number(process.env.LEAFBOT_COMPUTER_PORT ?? 4320);
/** The desktops' browsers go through a proxy on this loopback port (they share its network). */
const SOCKS_PORT = Number(process.env.LEAFBOT_COMPUTER_SOCKS_PORT ?? 4321);
/**
 * A SOCKS5 proxy the browsers leave through when they do not go through the person's computer:
 * some sites refuse a data centre's address outright (see "Tarayıcının çıkış adresi" in
 * docker/README.md). Unset, they leave from here.
 */
const EGRESS_PROXY = upstreamProxy(process.env.LEAFBOT_EGRESS_PROXY);
/** Git in the desktops reaches GitHub through a relay on this loopback port (see git-relay.ts). */
const GIT_PORT = Number(process.env.LEAFBOT_COMPUTER_GIT_PORT ?? 4322);
const STATE = process.env.LEAFBOT_COMPUTER_STATE ?? '/run/computer';
const MAX_DESKTOPS = Number(process.env.LEAFBOT_COMPUTER_MAX ?? 3);
const WORKSPACES_ROOT = (process.env.LEAFBOT_WORKSPACES_ROOT ?? '/data/workspaces').replace(/\/+$/, '');
const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER_SCRIPT = process.env.LEAFBOT_COMPUTER_HELPER ?? join(HERE, 'session.mjs');
const SESSION_SCRIPT = process.env.LEAFBOT_COMPUTER_SESSION_SH ?? join(HERE, '..', 'session.sh');
const MAX_BODY = 1024 * 1024;
const START_TIMEOUT_MS = 90_000;

const log = (msg: string) => console.log(`${new Date().toISOString()} ${msg}`);

interface Session {
  id: string;
  display: number;
  status: 'starting' | 'running';
  startedAt: string;
  ctlDir: string;
  proc: ChildProcess;
  /** Open VNC and CDP bridges; closed together with the session. */
  bridges: Set<() => void>;
  cdpOpen: boolean;
  exited: Promise<void>;
  /**
   * The session's part of every git relay address. The desktops share this container's network, so
   * the relay tells them apart by it.
   */
  relayKey: string;
  /** The GitHub key the server gave for this bot; held here only, never in the session. */
  gitToken: string | null;
  /**
   * Whether the session's git goes through the relay at all (the relay was up and the desktop may
   * reach the internet); a command's own key is given only then.
   */
  gitOn: boolean;
  /**
   * Whether the session's browser leaves through the service's own SOCKS, which refuses private
   * addresses itself. The server skips its own per-request guard on such a browser — the guard
   * costs it the HTTP cache and its service workers — and keeps the guard when it does not.
   */
  browserProxied: boolean;
}

const sessions = new Map<string, Session>();

/** Why each desktop's last start failed, until it starts again. */
const startErrors = new Map<string, string>();

const statusOf = (id: string): DesktopStatus => {
  const s = sessions.get(id);
  return {
    id,
    status: s?.status ?? 'off',
    startedAt: s?.startedAt ?? null,
    lastError: s ? null : (startErrors.get(id) ?? null),
    browserProxied: s?.browserProxied ?? false,
  };
};

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ComputerErrorCode,
    message: string,
  ) {
    super(message);
  }
}

// ---- helper client -------------------------------------------------------------------------

function helperCall(
  s: Pick<Session, 'ctlDir'>,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 30_000,
): Promise<{ status: number; json: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = httpRequest(
      {
        socketPath: join(s.ctlDir, 'helper.sock'),
        method,
        path,
        timeout: timeoutMs,
        headers: data
          ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 502, json: text ? JSON.parse(text) : {} });
          } catch {
            reject(new Error('helper sent invalid JSON'));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('helper timed out')));
    req.on('error', reject);
    req.end(data);
  });
}

// ---- sessions ------------------------------------------------------------------------------

function makeXauthCookie(file: string, display: number): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(
      'xauth',
      ['-f', file, 'add', `:${display}`, '.', randomBytes(16).toString('hex')],
      { env: { PATH: process.env.PATH ?? '' } },
      (err, _o, stderr) => (err ? reject(new Error(`xauth: ${stderr.trim() || err.message}`)) : resolve()),
    ),
  );
}

async function startSession(id: string, start: DesktopStart): Promise<DesktopStatus> {
  if (sessions.has(id)) return statusOf(id);
  if (sessions.size >= MAX_DESKTOPS) {
    throw new HttpError(409, 'full', `at most ${MAX_DESKTOPS} desktops can run at once`);
  }
  const display = allocateDisplay([...sessions.values()].map((s) => s.display));
  if (display === null) throw new HttpError(409, 'full', 'no free display');

  const paths = [start.home, start.workdir, ...start.folders.map((f) => f.path)];
  const clean = (p: string) => {
    const ok = checkSessionPath(p, WORKSPACES_ROOT);
    if (!ok) throw new HttpError(400, 'badRequest', `path not allowed: ${p}`);
    return ok;
  };
  for (const p of paths) clean(p);

  // Reserve the slot before any await, so two concurrent starts cannot take the same display.
  const ctlDir = join(STATE, id);
  let release!: () => void;
  const exited = new Promise<void>((r) => (release = r));
  const relayKey = randomBytes(32).toString('hex');
  const placeholder = {
    id,
    display,
    ctlDir,
    exited,
    bridges: new Set(),
    cdpOpen: false,
    relayKey,
    gitToken: null,
    gitOn: gitReady && start.internet,
    browserProxied: false,
  } as Session;
  sessions.set(id, placeholder);
  try {
    rmSync(ctlDir, { recursive: true, force: true });
    mkdirSync(ctlDir, { recursive: true, mode: 0o700 });
    await makeXauthCookie(join(ctlDir, 'xauth'), display);
    mkdirSync(start.home, { recursive: true });
    mkdirSync(start.workdir, { recursive: true });
    // A folder that does not exist (yet) is left out; binding it would stop the whole session.
    const present = start.folders.filter((f) => existsSync(f.path));
    const opts: SandboxOptions = {
      start: { ...start, folders: present },
      display,
      ctlDir,
      workspacesRoot: WORKSPACES_ROOT,
      stateRoot: STATE,
      node: process.execPath,
      helperScript: HELPER_SCRIPT,
      sessionScript: SESSION_SCRIPT,
      ...(socksReady && { proxy: `socks5://127.0.0.1:${SOCKS_PORT}` }),
      ...(gitReady && { gitRelay: `http://127.0.0.1:${GIT_PORT}/${relayKey}/` }),
    };
    collectBinds(opts.start); // throws early on nonsense input before spawning
    // The sandbox gets only what bwrapArgs sets: the controller's environment (and token) stays here.
    const proc = spawn('bwrap', bwrapArgs(opts), {
      env: { PATH: process.env.PATH ?? '' },
      // The sandbox's own complaints are kept: they say why a start failed.
      stdio: ['ignore', 'ignore', 'pipe'],
      detached: true,
    });
    startErrors.delete(id);
    let stderr = '';
    proc.stderr?.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString('utf8')).slice(-2000);
    });
    const s: Session = {
      ...placeholder,
      status: 'starting',
      startedAt: new Date().toISOString(),
      proc,
      browserProxied: socksReady && start.internet,
    };
    sessions.set(id, s);
    log(`desktop ${id}: starting on :${display}`);

    let finished = false;
    const cleanup = () => {
      if (finished) return;
      finished = true;
      clearInterval(poll);
      clearTimeout(giveUp);
      for (const close of [...s.bridges]) close();
      gitGrants.endSession(s.relayKey);
      if (sessions.get(id) === s) sessions.delete(id);
      rmSync(ctlDir, { recursive: true, force: true });
      log(`desktop ${id}: off`);
      release();
    };
    proc.on('exit', (code) => {
      // Gone before it ran: keep why, for the next status.
      if (s.status === 'starting' && !startErrors.has(id)) {
        startErrors.set(id, stderr.trim().split('\n').slice(-3).join(' ') || `exited with code ${code}`);
      }
      cleanup();
    });
    proc.on('error', (e) => {
      log(`desktop ${id}: ${e.message}`);
      cleanup();
    });
    const poll = setInterval(() => {
      helperCall(s, 'GET', '/ping', undefined, 2000)
        .then((r) => {
          if (r.status === 200 && sessions.get(id) === s && s.status === 'starting') {
            s.status = 'running';
            clearInterval(poll);
            clearTimeout(giveUp);
            log(`desktop ${id}: running`);
          }
        })
        .catch(() => {});
    }, 400);
    const giveUp = setTimeout(() => {
      if (s.status === 'starting') {
        log(`desktop ${id}: did not start in time`);
        startErrors.set(id, `did not start within ${START_TIMEOUT_MS / 1000} s`);
        killSession(s);
      }
    }, START_TIMEOUT_MS);
    return statusOf(id);
  } catch (e) {
    sessions.delete(id);
    rmSync(ctlDir, { recursive: true, force: true });
    release();
    throw e;
  }
}

function killSession(s: Session): void {
  const pid = s.proc?.pid;
  if (!pid) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3000).unref();
}

async function stopSession(id: string): Promise<DesktopStatus> {
  const s = sessions.get(id);
  if (!s) return statusOf(id);
  killSession(s);
  await Promise.race([s.exited, new Promise((r) => setTimeout(r, 6000))]);
  return statusOf(id);
}

function running(id: string): Session {
  const s = sessions.get(id);
  if (!s || s.status !== 'running') throw new HttpError(409, 'notRunning', 'desktop is not running');
  return s;
}

// ---- HTTP ----------------------------------------------------------------------------------

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(json) });
  res.end(json);
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new HttpError(413, 'badRequest', 'body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'badRequest', 'invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function parse<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: Error } },
  v: unknown,
): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, 'badRequest', r.error.message);
  return r.data;
}

/**
 * A command's output names GitHub as git saw it, at the session's relay address or the command's
 * own; the bot gets GitHub's own address back, and the relay keys stay out of its notes and
 * messages.
 */
function withoutRelay(json: unknown): unknown {
  if (!json || typeof json !== 'object' || typeof (json as { output?: unknown }).output !== 'string')
    return json;
  const o = json as { output: string };
  return {
    ...o,
    output: o.output.replace(relayAddress, 'https://github.com/'),
  };
}

/** Sends the helper's answer on, or turns a helper failure into a 502. */
async function forward(
  res: ServerResponse,
  s: Session,
  path: string,
  body: unknown,
  timeoutMs?: number,
): Promise<void> {
  try {
    const r = await helperCall(s, 'POST', path, body, timeoutMs);
    send(res, r.status, withoutRelay(r.json));
  } catch (e) {
    throw new HttpError(502, 'failed', e instanceof Error ? e.message : 'helper unreachable');
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!checkToken(bearerToken(req.headers.authorization), TOKEN)) {
    throw new HttpError(401, 'unauthorized', 'unauthorized');
  }
  const url = new URL(req.url ?? '/', 'http://x');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  if (method === 'GET' && path === '/health') return send(res, 200, { ok: true });
  if (method === 'GET' && path === '/desktops') return send(res, 200, [...sessions.keys()].map(statusOf));

  const m = /^\/desktops\/([^/]+)(?:\/([a-z-]+))?$/.exec(path);
  if (!m) throw new HttpError(404, 'badRequest', 'not found');
  const id = DesktopId.safeParse(m[1]);
  if (!id.success) throw new HttpError(400, 'badRequest', 'invalid desktop id');
  const action = m[2];

  if (method === 'GET' && !action) return send(res, 200, statusOf(id.data));
  if (method !== 'POST') throw new HttpError(404, 'badRequest', 'not found');

  const body = await readJson(req);
  switch (action) {
    case 'start':
      return send(res, 200, await startSession(id.data, parse(DesktopStart, body)));
    case 'stop':
      return send(res, 200, await stopSession(id.data));
    case 'exec': {
      const { git, ...b } = parse(DesktopExec, body);
      const s = running(id.data);
      const key = grantGit(s, git);
      try {
        return await forward(res, s, '/exec', { ...b, ...relayFor(key) }, b.timeoutMs + 15_000);
      } finally {
        if (key) gitGrants.end(key);
      }
    }
    case 'jobs-start': {
      const { git, ...b } = parse(DesktopJobStart, body);
      const s = running(id.data);
      const key = grantGit(s, git);
      let r: { status: number; json: unknown };
      try {
        r = await helperCall(s, 'POST', '/jobs/start', { ...b, ...relayFor(key) });
      } catch (e) {
        if (key) gitGrants.end(key);
        throw new HttpError(502, 'failed', e instanceof Error ? e.message : 'helper unreachable');
      }
      const job = (r.json as { id?: unknown; running?: unknown } | null) ?? {};
      if (key) {
        if (r.status === 200 && typeof job.id === 'string' && job.running === true) watchJob(s, job.id, key);
        else gitGrants.end(key);
      }
      return send(res, r.status, withoutRelay(r.json));
    }
    case 'jobs-status': {
      const q = parse(DesktopJobQuery, body);
      return forward(res, running(id.data), '/jobs/status', q, q.waitMs + 15_000);
    }
    case 'git': {
      // Kept for the session that is starting or running now; the next start is given it again.
      const s = sessions.get(id.data);
      if (!s) throw new HttpError(409, 'notRunning', 'desktop is not running');
      s.gitToken = parse(DesktopGit, body).token;
      return send(res, 200, {});
    }
    case 'screenshot':
      return forward(res, running(id.data), '/screenshot', {});
    case 'action':
      return forward(res, running(id.data), '/action', parse(DesktopAction, body));
    default:
      throw new HttpError(404, 'badRequest', 'not found');
  }
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) return res.destroy();
    if (e instanceof HttpError) return send(res, e.status, { error: e.message, code: e.code });
    log(`request failed: ${e instanceof Error ? e.message : String(e)}`);
    send(res, 500, { error: 'internal error', code: 'failed' });
  });
});

// ---- WebSocket bridges ---------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

function rejectUpgrade(socket: Duplex, status: number, code: ComputerErrorCode, message: string): void {
  const body = JSON.stringify({ error: message, code });
  socket.end(
    `HTTP/1.1 ${status} Error\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
  );
}

/** Registers a bridge so it is torn down with the session, and keeps the connection alive. */
function track(s: Session, ws: WebSocket, upstream: Socket): void {
  const close = () => {
    ws.terminate();
    upstream.destroy();
  };
  s.bridges.add(close);
  let alive = true;
  ws.on('pong', () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return close();
    alive = false;
    ws.ping();
  }, 30_000);
  const end = () => {
    clearInterval(ping);
    s.bridges.delete(close);
    close();
  };
  ws.on('close', end);
  ws.on('error', end);
  upstream.on('close', end);
  upstream.on('error', end);
}

function bridgeVnc(s: Session, ws: WebSocket): void {
  const upstream = connect(join(s.ctlDir, 'vnc.sock'));
  track(s, ws, upstream);
  const HIGH = 8 * 1024 * 1024;
  upstream.on('data', (chunk) => {
    ws.send(chunk, { binary: true }, () => {
      if (ws.bufferedAmount < HIGH / 2) upstream.resume();
    });
    // The browser may read slower than the screen changes; stop reading until it catches up.
    if (ws.bufferedAmount > HIGH) upstream.pause();
  });
  ws.on('message', (data) => {
    if (Buffer.isBuffer(data)) upstream.write(data);
  });
}

function bridgeCdp(s: Session, ws: WebSocket): void {
  if (s.cdpOpen) return ws.close(1013, 'another client is connected');
  const upstream = connect(join(s.ctlDir, 'cdp.sock'));
  s.cdpOpen = true;
  track(s, ws, upstream);
  ws.on('close', () => (s.cdpOpen = false));
  const decoder = new CdpDecoder();
  upstream.on('data', (chunk) => {
    try {
      for (const msg of decoder.push(chunk as Buffer)) ws.send(msg);
    } catch {
      ws.close(1009, 'message too large');
    }
  });
  ws.on('message', (data, isBinary) => {
    const text = isBinary ? null : data.toString('utf8');
    // A NUL would end the message early on the pipe.
    if (text === null || text.includes('\0')) return ws.close(1007, 'text frames without NUL only');
    upstream.write(encodeCdp(text));
  });
}

// ---- the way out through the person's computer ---------------------------------------------

/**
 * The server's connection for the desktops' browser traffic. While it says the person's computer
 * is there, each new browser connection is sent to it; otherwise, or when it answers that the
 * computer is gone, the connection is made from here as before.
 */
let egress: { ws: WebSocket; mux: EgressMux; route: boolean } | null = null;

function bridgeEgress(ws: WebSocket): void {
  egress?.ws.terminate();
  const link = {
    ws,
    route: false,
    mux: new EgressMux({
      send: (f) => {
        if (ws.readyState === ws.OPEN) ws.send(f, { binary: true });
      },
    }),
  };
  egress = link;
  let alive = true;
  ws.on('pong', () => (alive = true));
  const ping = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 30_000);
  ws.on('message', (data, isBinary) => {
    if (isBinary) return link.mux.receive(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
    try {
      link.route = (JSON.parse(data.toString('utf8')) as { route?: unknown }).route === true;
    } catch {
      /* not a state message */
    }
  });
  const end = () => {
    clearInterval(ping);
    link.mux.close();
    if (egress === link) egress = null;
  };
  ws.on('close', end);
  ws.on('error', end);
}

/**
 * From here: the controller's network reaches the internet only, not the server's private one.
 * With the upstream proxy, through it; while it cannot be reached, from here, said in the log at
 * most once a minute.
 */
let proxyDownLogged = 0;
const dialHere = (host: string, port: number) =>
  dialPublic(host, port, {
    anyAddress: true,
    ...(EGRESS_PROXY && {
      via: EGRESS_PROXY,
      onViaDown: (err: Error) => {
        if (Date.now() - proxyDownLogged < 60_000) return;
        proxyDownLogged = Date.now();
        log(`browser proxy: ${err.message}; leaving from here`);
      },
    }),
  });

let socksReady = false;
const socks = createNetServer({ allowHalfOpen: true }, (client) => {
  client.on('error', () => {});
  void (async () => {
    let target: { host: string; port: number };
    try {
      target = await socksAccept(client);
    } catch {
      return;
    }
    let up: Duplex;
    try {
      const link = egress;
      up =
        link?.route === true
          ? await link.mux.open(target.host, target.port).catch((err: unknown) => {
              if (err instanceof EgressError && err.code === 'unavailable') {
                return dialHere(target.host, target.port);
              }
              throw err;
            })
          : await dialHere(target.host, target.port);
    } catch (err) {
      return socksReply(client, socksReplyFor(err));
    }
    if (client.destroyed) return void up.destroy();
    socksReply(client, SOCKS_REPLY.ok);
    joinStreams(client, up);
  })();
});
socks.on('error', (e) => log(`browser proxy: ${e.message}`));
socks.listen(SOCKS_PORT, '127.0.0.1', () => {
  socksReady = true;
  log(`browser proxy on 127.0.0.1:${SOCKS_PORT}`);
});

// ---- git ---------------------------------------------------------------------------------------

let gitReady = false;
/** The keys of single commands, given for the person their step works for (see GitGrants). */
const gitGrants = new GitGrants();
const relayAddress = new RegExp(`http://127\\.0\\.0\\.1:${GIT_PORT}/[a-f0-9]{64}/`, 'g');
const sessionAlive = (relayKey: string) => [...sessions.values()].some((s) => s.relayKey === relayKey);

/** A relay key for one command that brings its own GitHub key; none when it brings none. */
function grantGit(s: Session, git: { token: string | null } | undefined): string | undefined {
  if (!git?.token || !s.gitOn) return undefined;
  return gitGrants.give(s.relayKey, git.token);
}

/** What the helper is told: the address the command's git uses in place of the session's. */
const relayFor = (key: string | undefined) =>
  key ? { gitRelay: `http://127.0.0.1:${GIT_PORT}/${key}/` } : {};

/**
 * A background command keeps its key until it ends; the helper is asked now and then. Only a clear
 * answer ends it (the job is over or unknown, or the desktop is gone): a status call that fails on
 * the way must not cut a long clone off GitHub halfway.
 */
function watchJob(s: Session, jobId: string, key: string): void {
  const timer = setInterval(() => {
    if (!sessionAlive(s.relayKey)) return stop();
    helperCall(s, 'POST', '/jobs/status', { id: jobId, waitMs: 0 }, 10_000).then(
      (r) => {
        if (r.status === 404 || (r.status === 200 && (r.json as { running?: unknown }).running !== true)) {
          stop();
        }
      },
      () => undefined,
    );
  }, 15_000);
  timer.unref();
  function stop() {
    clearInterval(timer);
    gitGrants.end(key);
  }
}

const gitRelay = createServer(
  createGitRelay({
    tokenFor: (key) => {
      for (const s of sessions.values()) if (s.relayKey === key) return s.gitToken;
      return gitGrants.tokenFor(key, sessionAlive);
    },
  }),
);
gitRelay.on('error', (e) => log(`git relay: ${e.message}`));
gitRelay.listen(GIT_PORT, '127.0.0.1', () => {
  gitReady = true;
  log(`git relay on 127.0.0.1:${GIT_PORT}`);
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://x');
  if (!checkToken(url.searchParams.get('token'), TOKEN)) {
    return rejectUpgrade(socket, 401, 'unauthorized', 'unauthorized');
  }
  if (url.pathname === '/egress') return wss.handleUpgrade(req, socket, head, bridgeEgress);
  const m = /^\/desktops\/([^/]+)\/(vnc|cdp)$/.exec(url.pathname);
  const id = m && DesktopId.safeParse(m[1]);
  if (!m || !id || !id.success) return rejectUpgrade(socket, 404, 'badRequest', 'not found');
  const s = sessions.get(id.data);
  if (!s || s.status !== 'running') return rejectUpgrade(socket, 409, 'notRunning', 'desktop is not running');
  wss.handleUpgrade(req, socket, head, (ws) => (m[2] === 'vnc' ? bridgeVnc : bridgeCdp)(s, ws));
});

// ---- startup and shutdown ------------------------------------------------------------------

mkdirSync(STATE, { recursive: true, mode: 0o700 });
server.listen(PORT, '0.0.0.0', () => log(`computer service on :${PORT} (max ${MAX_DESKTOPS} desktops)`));

function shutdown(): void {
  log('shutting down');
  for (const s of sessions.values()) killSession(s);
  server.close();
  socks.close();
  gitRelay.close();
  setTimeout(() => process.exit(0), 1500).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
