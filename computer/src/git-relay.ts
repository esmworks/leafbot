// The way git on a bot's desktop reaches GitHub. Git inside a session is told to fetch
// `https://github.com/…` from this relay instead (see `gitEnv` in sandbox.ts); the relay runs in
// the controller, outside the sandbox, and adds the session's GitHub key to each request. The key is
// held in this process only: nothing in the session (its environment, files, `git credential fill`)
// can show it, so a command the bot runs on text from outside cannot send it anywhere.
//
// Only git's own smart HTTP requests go through, to github.com and nowhere else. A push that would
// change a repository's default branch is refused here, whatever the bot was told: work reaches the
// default branch through a pull request a person merges.
import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { Readable } from 'node:stream';
import { connect as tlsConnect } from 'node:tls';
import { dialPublic } from '@leafbot/shared/egress';

export const GITHUB_HOST = 'github.com';
/** A session's relay key: random, and part of every path the session's git asks for. */
export const RELAY_KEY = /^[a-f0-9]{64}$/;
const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const SERVICES = ['git-upload-pack', 'git-receive-pack'] as const;
type Service = (typeof SERVICES)[number];
/** The most a push may send before its list of ref updates ends. */
const MAX_COMMANDS = 1024 * 1024;
/** The most read of a ref advertisement for its first ref line, which names the default branch. */
const MAX_ADVERTISEMENT = 128 * 1024;
/** Request headers git sends that GitHub needs; every other one stays here. */
const PASS_REQUEST = [
  'accept',
  'content-type',
  'content-encoding',
  'content-length',
  'git-protocol',
  'user-agent',
];
const PASS_RESPONSE = [
  'content-type',
  'content-encoding',
  'cache-control',
  'expires',
  'pragma',
  'www-authenticate',
];

/**
 * GitHub keys given for one command each: the person a bot's step works for brings their own key,
 * while the desktop is shared by everyone who talks with the bot. Each command's git reaches the
 * relay at an address of its own, which works only while the command runs and only while its
 * desktop is the same one; a later command, or a process the bot leaves behind, finds it gone.
 */
export class GitGrants {
  private grants = new Map<string, { session: string; token: string }>();

  /** A new relay key for a command of `session` whose git sends `token`. */
  give(session: string, token: string): string {
    const key = randomBytes(32).toString('hex');
    this.grants.set(key, { session, token });
    return key;
  }

  /** The key's GitHub key while `alive(session)` holds; undefined for an unknown or ended one. */
  tokenFor(key: string, alive: (session: string) => boolean): string | undefined {
    const g = this.grants.get(key);
    if (!g) return undefined;
    if (alive(g.session)) return g.token;
    this.grants.delete(key);
    return undefined;
  }

  /** The command ended: its address stops working. */
  end(key: string): void {
    this.grants.delete(key);
  }

  /** The desktop stopped: every address of its commands stops working. */
  endSession(session: string): void {
    for (const [key, g] of this.grants) if (g.session === session) this.grants.delete(key);
  }

  get size(): number {
    return this.grants.size;
  }
}

/** A git request through the relay: which session asks, for which repository, and what. */
export interface GitTarget {
  key: string;
  owner: string;
  repo: string;
  /** `info/refs` (GET, with its service) or a service's POST. */
  op: 'info/refs' | Service;
  service: Service;
}

/**
 * Reads `/<key>/<owner>/<repo>[.git]/<op>` as a git smart HTTP request; null for anything else,
 * including a dumb-HTTP file read, an LFS call or a query that is not git's.
 */
export function parseRelayRequest(method: string, rawUrl: string): GitTarget | null {
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://relay');
  } catch {
    return null;
  }
  const parts = url.pathname.split('/');
  if (parts[0] !== '') return null;
  const [key, owner, repoPart, ...rest] = parts.slice(1);
  if (!key || !RELAY_KEY.test(key) || !owner || !OWNER.test(owner) || !repoPart) return null;
  const repo = repoPart.endsWith('.git') ? repoPart.slice(0, -4) : repoPart;
  if (!REPO.test(repo) || repo === '.' || repo === '..') return null;
  const op = rest.join('/');
  const params = [...url.searchParams.keys()];
  if (op === 'info/refs' && method === 'GET') {
    const service = url.searchParams.get('service');
    if (params.length !== 1 || !SERVICES.includes(service as Service)) return null;
    return { key, owner, repo, op, service: service as Service };
  }
  if ((SERVICES as readonly string[]).includes(op) && method === 'POST' && params.length === 0) {
    return { key, owner, repo, op: op as Service, service: op as Service };
  }
  return null;
}

/** The path on GitHub for a relayed request. */
export function upstreamPath(t: GitTarget): string {
  const base = `/${t.owner}/${t.repo}.git`;
  return t.op === 'info/refs' ? `${base}/info/refs?service=${t.service}` : `${base}/${t.op}`;
}

// ---- pkt-line ----------------------------------------------------------------------------------

/** One pkt-line holding `data`. */
export function pkt(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  return Buffer.concat([Buffer.from((body.length + 4).toString(16).padStart(4, '0'), 'ascii'), body]);
}

const FLUSH = Buffer.from('0000', 'ascii');

/**
 * The pkt-lines at the start of `buf` up to and including the first flush (`null` for it).
 * `incomplete` while that flush has not arrived yet.
 */
export function readUntilFlush(buf: Buffer): { lines: (Buffer | null)[]; end: number } | 'incomplete' {
  const lines: (Buffer | null)[] = [];
  let at = 0;
  for (;;) {
    if (buf.length < at + 4) return 'incomplete';
    const head = buf.subarray(at, at + 4).toString('ascii');
    if (!/^[0-9a-f]{4}$/.test(head)) throw new Error('not a pkt-line');
    const size = parseInt(head, 16);
    if (size === 0) {
      lines.push(null);
      return { lines, end: at + 4 };
    }
    // 0001 and 0002 are delimiters of protocol v2; neither belongs in the parts read here.
    if (size < 4) throw new Error('unexpected pkt-line');
    if (buf.length < at + size) return 'incomplete';
    lines.push(buf.subarray(at + 4, at + size));
    at += size;
  }
}

/** A ref update a push asks for. */
export interface RefUpdate {
  old: string;
  new: string;
  ref: string;
}

/**
 * The ref updates at the start of a receive-pack request, with the capabilities the client asked
 * for; `incomplete` until the list has ended.
 */
export function parsePushCommands(
  buf: Buffer,
): { updates: RefUpdate[]; caps: string[]; end: number } | 'incomplete' {
  const read = readUntilFlush(buf);
  if (read === 'incomplete') return read;
  const updates: RefUpdate[] = [];
  let caps: string[] = [];
  for (const line of read.lines) {
    if (!line) break;
    let text = line.toString('utf8').replace(/\n$/, '');
    // A shallow clone names its boundary first; those lines change no ref.
    if (text.startsWith('shallow ')) continue;
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      caps = text
        .slice(nul + 1)
        .split(' ')
        .filter(Boolean);
      text = text.slice(0, nul);
    }
    // A signed push sends its certificate in place of the plain list; it is not read here.
    const m = /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/.exec(text);
    if (!m) throw new Error('unexpected push command');
    updates.push({ old: m[1]!, new: m[2]!, ref: m[3]! });
  }
  return { updates, caps, end: read.end };
}

/** One pkt-line at `at`: its data and where the next starts; null for a flush, `incomplete` if cut. */
function onePkt(buf: Buffer, at: number): { data: Buffer | null; next: number } | 'incomplete' {
  if (buf.length < at + 4) return 'incomplete';
  const head = buf.subarray(at, at + 4).toString('ascii');
  if (!/^[0-9a-f]{4}$/.test(head)) throw new Error('not a pkt-line');
  const size = parseInt(head, 16);
  if (size === 0) return { data: null, next: at + 4 };
  if (size < 4) throw new Error('unexpected pkt-line');
  if (buf.length < at + size) return 'incomplete';
  return { data: buf.subarray(at + 4, at + size), next: at + size };
}

/**
 * The default branch named at the start of an upload-pack ref advertisement (protocol v0: the
 * capabilities of its first ref carry `symref=HEAD:refs/heads/<name>`). Null for an empty
 * repository, which has none yet; undefined when the advertisement does not say (cut short, or in
 * another form), so the caller cannot tell and refuses.
 */
export function defaultBranch(advert: Buffer): string | null | undefined {
  try {
    let at = 0;
    let line = onePkt(advert, at);
    if (line === 'incomplete') return undefined;
    // Smart HTTP puts `# service=…` and a flush first.
    if (line.data?.toString('utf8').startsWith('# service=')) {
      const flush = onePkt(advert, line.next);
      if (flush === 'incomplete' || flush.data !== null) return undefined;
      at = flush.next;
      line = onePkt(advert, at);
      if (line === 'incomplete') return undefined;
    }
    if (!line.data) return null;
    const text = line.data.toString('utf8');
    const nul = text.indexOf('\0');
    if (nul < 0) return undefined;
    if (/^0+ capabilities\^\{\}$/.test(text.slice(0, nul))) return null;
    for (const cap of text
      .slice(nul + 1)
      .trim()
      .split(' ')) {
      const m = /^symref=HEAD:(refs\/heads\/.+)$/.exec(cap);
      if (m) return m[1]!;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * The answer to a refused push, as receive-pack itself gives one: every update is reported as not
 * done (git pushes all or nothing here), each with why, and git shows them as "remote rejected".
 */
export function refusedPush(updates: RefUpdate[], caps: string[], reasons: Map<string, string>): Buffer {
  const other = 'another ref in this push was refused';
  const report = Buffer.concat([
    pkt('unpack ok\n'),
    ...updates.map((u) => pkt(`ng ${u.ref} ${reasons.get(u.ref) ?? other}\n`)),
    FLUSH,
  ]);
  const band = caps.includes('side-band-64k') ? 65515 : caps.includes('side-band') ? 995 : 0;
  if (!band) return report;
  const out: Buffer[] = [];
  for (let at = 0; at < report.length; at += band) {
    out.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(at, at + band)])));
  }
  const why = [...new Set(reasons.values())].join('; ');
  out.push(pkt(Buffer.concat([Buffer.from([2]), Buffer.from(`${why}\n`, 'utf8')])));
  out.push(FLUSH);
  return Buffer.concat(out);
}

// ---- the relay ---------------------------------------------------------------------------------

export interface UpstreamRequest {
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: Readable;
}

export interface UpstreamResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Readable;
}

/** Sends a request to GitHub. Tests pass a stand-in. */
export type Upstream = (req: UpstreamRequest) => Promise<UpstreamResponse>;

export interface GitRelayOptions {
  /**
   * The GitHub key of the session with this relay key: undefined when no session has it, null for a
   * session without a key (public repositories still work).
   */
  tokenFor(key: string): string | null | undefined;
  upstream?: Upstream;
}

const basic = (token: string) => `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

async function readAtMost(body: Readable, max: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of body) {
    const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
    chunks.push(b);
    size += b.length;
    if (size >= max) break;
  }
  body.destroy();
  return Buffer.concat(chunks);
}

/** The relay's request handler. */
export function createGitRelay(o: GitRelayOptions) {
  const upstream = o.upstream ?? githubUpstream;

  /** Why each update of a push is refused; empty when the push may go on. */
  async function check(
    t: GitTarget,
    updates: RefUpdate[],
    auth: string | undefined,
  ): Promise<Map<string, string>> {
    const reasons = new Map<string, string>();
    if (!updates.length) return reasons;
    const unknown = () => {
      for (const u of updates) reasons.set(u.ref, 'the relay could not check the default branch; try again');
      return reasons;
    };
    let head: string | null | undefined;
    try {
      const r = await upstream({
        method: 'GET',
        path: upstreamPath({ ...t, op: 'info/refs', service: 'git-upload-pack' }),
        headers: { 'user-agent': 'git/2 (leafbot relay)', ...(auth && { authorization: auth }) },
      });
      // Git has just read this repository's refs with the same key, so anything else is refused.
      if (r.status !== 200) {
        r.body.resume();
        return unknown();
      }
      head = defaultBranch(await readAtMost(r.body, MAX_ADVERTISEMENT));
    } catch {
      return unknown();
    }
    if (head === undefined) return unknown();
    for (const u of updates) {
      if (head && u.ref === head) {
        reasons.set(
          u.ref,
          `${head.slice('refs/heads/'.length)} is the default branch; push another branch and open a pull request`,
        );
      }
    }
    return reasons;
  }

  async function relay(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t = parseRelayRequest(req.method ?? 'GET', req.url ?? '/');
    if (!t) return sendText(res, 404, 'Only git requests to GitHub repositories go through this relay.\n');
    const token = o.tokenFor(t.key);
    if (token === undefined) return sendText(res, 403, 'This relay address belongs to no running desktop.\n');

    const headers: Record<string, string> = {};
    for (const name of PASS_REQUEST) {
      const v = req.headers[name];
      if (typeof v === 'string') headers[name] = v;
    }
    // With a key here, git's own credentials (if any) are not sent along.
    const clientAuth = typeof req.headers.authorization === 'string' ? req.headers.authorization : undefined;
    const auth = token ? basic(token) : clientAuth;
    if (auth) headers.authorization = auth;

    let body: Readable | undefined;
    if (req.method === 'POST') body = req;
    if (t.op === 'git-receive-pack') {
      const encoding = (req.headers['content-encoding'] ?? 'identity').toString().toLowerCase();
      if (encoding !== 'identity') return sendText(res, 415, 'A compressed push is not accepted here.\n');
      const it = req[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
      let head = Buffer.alloc(0);
      let parsed: ReturnType<typeof parsePushCommands> = 'incomplete';
      try {
        while (parsed === 'incomplete') {
          const next = await it.next();
          if (next.done) break;
          head = Buffer.concat([head, next.value]);
          if (head.length > MAX_COMMANDS) throw new Error('too long');
          parsed = parsePushCommands(head);
        }
      } catch {
        return sendText(res, 400, 'This push could not be read.\n');
      }
      if (parsed === 'incomplete') return sendText(res, 400, 'This push ended early.\n');
      const reasons = await check(t, parsed.updates, auth);
      if (reasons.size) {
        // Read the rest first: git waits to finish sending before it reads the answer.
        for (let n = await it.next(); !n.done; n = await it.next());
        const answer = refusedPush(parsed.updates, parsed.caps, reasons);
        res.writeHead(200, {
          'content-type': 'application/x-git-receive-pack-result',
          'cache-control': 'no-cache',
          'content-length': answer.length,
        });
        return void res.end(answer);
      }
      const first = head;
      body = Readable.from(
        (async function* () {
          yield first;
          for (let n = await it.next(); !n.done; n = await it.next()) yield n.value;
        })(),
      );
    }

    let up: UpstreamResponse;
    try {
      up = await upstream({
        method: t.op === 'info/refs' ? 'GET' : 'POST',
        path: upstreamPath(t),
        headers,
        body,
      });
    } catch {
      return sendText(res, 502, 'GitHub could not be reached.\n');
    }
    const out: Record<string, string | string[]> = {};
    for (const name of PASS_RESPONSE) {
      const v = up.headers[name];
      if (v !== undefined) out[name] = v;
    }
    // A moved repository: git follows to the new place, through this relay again.
    const location = up.headers.location;
    if (typeof location === 'string' && location.startsWith(`https://${GITHUB_HOST}/`) && req.headers.host) {
      out.location = `http://${req.headers.host}/${t.key}/${location.slice(`https://${GITHUB_HOST}/`.length)}`;
    }
    res.writeHead(up.status, out);
    up.body.on('error', () => res.destroy());
    up.body.pipe(res);
  }

  return (req: IncomingMessage, res: ServerResponse) => {
    relay(req, res).catch(() => {
      if (res.headersSent) res.destroy();
      else sendText(res, 502, 'The relay failed.\n');
    });
  };
}

/** GitHub itself, reached only at a public address. */
const githubUpstream: Upstream = (r) =>
  new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        host: GITHUB_HOST,
        // Without an agent Node takes port 80 as the default and names it in the Host header;
        // GitHub then redirects the request to https, to the same address, again and again.
        port: 443,
        defaultPort: 443,
        servername: GITHUB_HOST,
        method: r.method,
        path: r.path,
        headers: r.headers,
        // Connected here rather than by the agent, so the address is checked as it is dialed.
        createConnection: ((_opts: unknown, done: (err: Error | null, s?: Socket) => void) => {
          dialPublic(GITHUB_HOST, 443, { ports: [443] }).then(
            (sock) => {
              const tls = tlsConnect({ socket: sock, servername: GITHUB_HOST, ALPNProtocols: ['http/1.1'] });
              done(null, tls as unknown as Socket);
            },
            (err: Error) => done(err),
          );
          return undefined;
        }) as never,
      },
      (res) => resolve({ status: res.statusCode ?? 502, headers: res.headers, body: res }),
    );
    req.setTimeout(120_000, () => req.destroy(new Error('GitHub timed out')));
    req.on('error', reject);
    if (r.body) {
      r.body.on('error', (e) => req.destroy(e));
      r.body.pipe(req);
    } else req.end();
  });
