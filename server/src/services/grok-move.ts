import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  botImportFromText,
  botImportNames,
  BotImportTextProblem,
  MAX_BOT_IMPORT_BYTES,
} from '@leafbot/shared';
import { z } from 'zod';

/**
 * Moving bots from Grok Bot over a connector. Grok Bot runs a connector from its own cloud, so it
 * needs an https address that reaches this server: the server's public address when it has one,
 * otherwise a Cloudflare quick tunnel from `cloudflared` on this computer to a second listener on
 * loopback that serves this and nothing else. The main API is never tunnelled.
 *
 * Security: every call here is untrusted internet input, and the link's 256-bit key is all a
 * caller holds. A caller can add documents and read a count; it never reads anything back. A
 * document is kept as the import reads it (refused whole with a credential field, keys of a known
 * shape masked), only in memory, and nothing is imported until the person chooses to. The link
 * ends after an hour, when the person ends it, when `cloudflared` exits or when the server stops.
 */

/** The public route of the link, under the paths that need no access key. */
export const MOVE_HOOK_PATH = '/api/hooks/move';
/** The path the loopback listener answers, behind the tunnel. */
const TUNNEL_PATH = '/move/';
export const MOVE_TTL_MS = 60 * 60 * 1000;
const MAX_DOCUMENTS = 100;
const MAX_BYTES = 4 * MAX_BOT_IMPORT_BYTES;
/** A document at the import's cap inside a JSON-RPC envelope. */
export const MOVE_BODY_MAX = MAX_BOT_IMPORT_BYTES + 64 * 1024;
const START_TIMEOUT_MS = 45_000;
const TUNNEL_ADDRESS = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** A document that arrived, as the text the import reads. */
export interface MoveArrival {
  seq: number;
  at: string;
  names: string[];
  text: string;
}

export interface MoveLinkState {
  /** False where no link can be made: no public address and no `cloudflared` on this computer. */
  available: boolean;
  url: string | null;
  expiresAt: string | null;
  /** The link was made and stopped working before the person ended it. */
  stopped: boolean;
  /** What arrived since the person last read it into the import, oldest first; texts are read apart. */
  arrived: Omit<MoveArrival, 'text'>[];
}

/** The `cloudflared` program on this computer: on the PATH or where Homebrew puts it. */
export function findCloudflared(env: NodeJS.ProcessEnv = process.env): string | null {
  const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
  const dirs = [...(env.PATH ?? '').split(delimiter), '/opt/homebrew/bin', '/usr/local/bin'];
  for (const dir of dirs.filter(Boolean)) {
    const path = join(dir, name);
    try {
      if (existsSync(path) && statSync(path).isFile()) return path;
    } catch {
      // not here
    }
  }
  return null;
}

/** The answer to a GET or DELETE on the link: a stateless MCP server has no stream. */
export const MOVE_NOT_ALLOWED = JSON.stringify({
  jsonrpc: '2.0',
  error: { code: -32000, message: 'Method not allowed.' },
  id: null,
});

/** Equal keys, compared in constant time. */
function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

interface Link {
  key: string;
  url: string;
  expiresAt: number;
  timer?: NodeJS.Timeout;
  arrivals: MoveArrival[];
  /** The last arrival the person read into the import; earlier ones are not offered again. */
  read: number;
  bytes: number;
  listener?: Server;
  tunnel?: ChildProcess;
  configDir?: string;
}

export interface MoveLinkOptions {
  /** The server's own public address, when it has one. */
  publicUrl: string | null;
  /** Whether this server runs on the person's computer, where a tunnel may be opened. */
  onUserComputer: boolean;
  /** The export instructions the other app follows, as text. */
  instructions: () => string;
  /** Checks a document as the import would; throws with a message for the other app when it fails. */
  check: (doc: Record<string, unknown>) => Promise<void>;
  /** Told when something arrives, so the person's open page can look. */
  onArrival: () => void;
  findCloudflared?: () => string | null;
  now?: () => number;
}

/** One link at a time; the person who makes it sees what arrives. */
export class MoveLink {
  private link: Link | null = null;
  private stopped = false;
  private starting: Promise<Link> | null = null;
  private seq = 0;

  constructor(private readonly o: MoveLinkOptions) {}

  private get now() {
    return this.o.now?.() ?? Date.now();
  }

  /** Whether a link can be made here at all. */
  available(): boolean {
    return !!this.o.publicUrl || (this.o.onUserComputer && !!(this.o.findCloudflared ?? findCloudflared)());
  }

  state(): MoveLinkState {
    const link = this.link;
    return {
      available: this.available(),
      url: link?.url ?? null,
      expiresAt: link ? new Date(link.expiresAt).toISOString() : null,
      stopped: !link && this.stopped,
      arrived: link ? link.arrivals.filter((a) => a.seq > link.read).map(({ text: _t, ...a }) => a) : [],
    };
  }

  /**
   * What arrived up to `upTo` and was not read yet, as one text for the import's preview; marked
   * read, so it is not offered again. Null when there is no link.
   */
  take(upTo: number): string | null {
    const link = this.link;
    if (!link) return null;
    const fresh = link.arrivals.filter((a) => a.seq > link.read && a.seq <= upTo);
    if (fresh.length) link.read = fresh.at(-1)!.seq;
    return fresh.map((a) => a.text).join('\n\n');
  }

  /** The link to paste into Grok Bot: the one already made while it works, so pasting once is enough. */
  async connect(): Promise<MoveLinkState> {
    if (!this.link) {
      if (!this.available()) return this.state();
      // Two asks at once share one start; the timer is armed only once the link works, so a failed
      // start leaves nothing behind to close a later link.
      this.starting ??= this.open()
        .then((link) => {
          link.timer = setTimeout(() => {
            if (this.link === link) this.close(true);
          }, link.expiresAt - this.now);
          link.timer.unref?.();
          this.link = link;
          this.stopped = false;
          return link;
        })
        .finally(() => (this.starting = null));
      await this.starting;
    }
    return this.state();
  }

  /** Ends the link; what arrived goes with it. */
  end(): MoveLinkState {
    this.close(false);
    return this.state();
  }

  private async open(): Promise<Link> {
    const key = randomBytes(32).toString('base64url');
    const base = { key, expiresAt: this.now + MOVE_TTL_MS, arrivals: [], read: 0, bytes: 0 };
    if (this.o.publicUrl) {
      return { ...base, url: `${this.o.publicUrl.replace(/\/+$/, '')}${MOVE_HOOK_PATH}/${key}` };
    }
    const bin = (this.o.findCloudflared ?? findCloudflared)();
    if (!bin) throw new Error('cloudflared is not on this computer');
    const listener = createServer((req, res) => void this.serveLoopback(req, res));
    const link: Link = { ...base, url: '', listener };
    try {
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
      });
      link.url = await this.tunnel(link, bin, (listener.address() as AddressInfo).port);
      return link;
    } catch (err) {
      this.dispose(link);
      throw err;
    }
  }

  /** Opens the quick tunnel to `port`; its address, with the link's path. */
  private async tunnel(link: Link, bin: string, port: number): Promise<string> {
    // An empty configuration of its own, so a tunnel the person set up for something else is not
    // the one this opens.
    const configDir = mkdtempSync(join(tmpdir(), 'leafbot-move-'));
    link.configDir = configDir;
    writeFileSync(join(configDir, 'config.yml'), '');
    const tunnel = spawn(
      bin,
      [
        'tunnel',
        '--no-autoupdate',
        '--config',
        join(configDir, 'config.yml'),
        '--url',
        `http://127.0.0.1:${port}`,
      ],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? '',
          USERPROFILE: process.env.USERPROFILE ?? '',
        },
        windowsHide: true,
      },
    );
    link.tunnel = tunnel;
    const address = await new Promise<string>((resolve, reject) => {
      let log = '';
      const timeout = setTimeout(() => reject(new Error('cloudflared gave no address')), START_TIMEOUT_MS);
      const read = (chunk: Buffer) => {
        log = (log + chunk.toString('utf8')).slice(-8192);
        const found = TUNNEL_ADDRESS.exec(log)?.[0];
        if (found) {
          clearTimeout(timeout);
          resolve(found);
        }
      };
      tunnel.stdout?.on('data', read);
      tunnel.stderr?.on('data', read);
      tunnel.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      tunnel.once('exit', () => {
        clearTimeout(timeout);
        reject(new Error('cloudflared stopped'));
      });
    });
    tunnel.once('exit', () => {
      if (this.link === link) this.close(true);
    });
    return `${address}${TUNNEL_PATH}${link.key}`;
  }

  private close(stopped: boolean) {
    const link = this.link;
    if (!link) return;
    this.link = null;
    this.stopped = stopped;
    this.dispose(link);
  }

  private dispose(link: Link) {
    clearTimeout(link.timer);
    link.tunnel?.kill();
    link.listener?.close();
    if (link.configDir) rmSync(link.configDir, { recursive: true, force: true });
  }

  /** Stops the link with the server. */
  stop() {
    this.close(false);
  }

  /**
   * The loopback listener: only the link's own path, and on it only POST; without sessions there
   * is no stream to open or close, so GET and DELETE are told so. Anything else is 404, no body.
   */
  private async serveLoopback(req: IncomingMessage, res: ServerResponse) {
    const key = req.url?.startsWith(TUNNEL_PATH) ? req.url.slice(TUNNEL_PATH.length) : '';
    if (!this.matches(key)) {
      res.writeHead(404).end();
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'application/json' });
      res.end(MOVE_NOT_ALLOWED);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await readBody(req, MOVE_BODY_MAX));
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null }));
      return;
    }
    await this.handle(req, res, body);
  }

  /** Whether `key` is the open link's. */
  matches(key: string): boolean {
    return !!this.link && sameKey(key, this.link.key);
  }

  /** One MCP request on the link, over streamable HTTP without sessions. */
  async handle(req: IncomingMessage, res: ServerResponse, body: unknown) {
    const mcp = this.server();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private server(): McpServer {
    const mcp = new McpServer(
      { name: 'leafbot-move', version: '1.0.0' },
      {
        instructions:
          'Moves bots from Grok Bot to Leaf Bot. Call move_status, then get_export_instructions, then send_export with the document those instructions describe: one call per bot, or one for all of them. Nothing changes in Grok Bot.',
      },
    );
    const said = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], isError });
    mcp.registerTool(
      'move_status',
      {
        description:
          'Check the link to Leaf Bot: whether it works, how many bots have arrived and when it stops working. Call this first.',
        inputSchema: {},
      },
      async () => {
        const link = this.link;
        if (!link)
          return said('This link no longer works. Ask the person for a new one from Leaf Bot.', true);
        const names = new Set(link.arrivals.flatMap((a) => a.names));
        return said(
          `Connected to Leaf Bot. ${names.size} bot(s) received so far. This link works until ${new Date(link.expiresAt).toISOString()}, while Leaf Bot stays open. Read get_export_instructions, then send each bot with send_export.`,
        );
      },
    );
    mcp.registerTool(
      'get_export_instructions',
      {
        description:
          'How to write the document send_export takes: its exact shape, its limits and what to leave out. Read it before the first send_export.',
        inputSchema: {},
      },
      async () => said(this.o.instructions()),
    );
    mcp.registerTool(
      'send_export',
      {
        description:
          'Send bots to Leaf Bot. `document` is a leafbot-bot-import document as get_export_instructions describes. Send one bot per call when the bots are large; parts of one bot sent with the same ref are joined. A document with passwords, API keys, tokens or cookies is refused. The person sees what arrived in Leaf Bot and chooses what to import.',
        inputSchema: { document: z.union([z.record(z.string(), z.unknown()), z.string()]) },
      },
      async ({ document }) => {
        const link = this.link;
        if (!link)
          return said('This link no longer works. Ask the person for a new one from Leaf Bot.', true);
        const raw = typeof document === 'string' ? document : JSON.stringify(document);
        let doc: Record<string, unknown>;
        try {
          doc = botImportFromText(raw);
        } catch (err) {
          if (!(err instanceof BotImportTextProblem)) throw err;
          return said(refusal(err), true);
        }
        try {
          await this.o.check(doc);
        } catch (err) {
          return said(
            `Leaf Bot refused the document: ${(err as Error).message}. Fix it and send it again.`,
            true,
          );
        }
        const text = JSON.stringify(doc);
        const size = Buffer.byteLength(text);
        if (link.arrivals.length >= MAX_DOCUMENTS || link.bytes + size > MAX_BYTES) {
          return said(
            'This link has taken all it can. Ask the person to import what arrived and make a new link.',
            true,
          );
        }
        link.bytes += size;
        const names = botImportNames(doc);
        link.arrivals.push({ seq: ++this.seq, at: new Date(this.now).toISOString(), names, text });
        this.o.onArrival();
        return said(
          `Received: ${names.join(', ')}. The person sees it in Leaf Bot and chooses what to import. Send the next bot, or tell the person you are done.`,
        );
      },
    );
    return mcp;
  }
}

/** Why the reader refused a document, for the other app to fix it. */
function refusal(err: BotImportTextProblem): string {
  switch (err.code) {
    case 'credentials':
      return `Refused: the document has credential fields (${err.keys.join(', ')}). Leave out passwords, API keys, tokens and cookies entirely, then send it again.`;
    case 'tooLarge':
      return 'Refused: the document is too large. Send one bot per call, or split a bot into parts with the same ref.';
    case 'cutOff':
      return 'Refused: the document is cut off. Send it again whole.';
    default:
      return 'Refused: this is not a leafbot-bot-import document. Read get_export_instructions and send the document in that shape.';
  }
}

async function readBody(req: IncomingMessage, max: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) throw new Error('too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** How the file the other app writes is named; a browser adds ` (1)` to a second one. */
export const EXPORT_FILE = /^leafbot-bots[^/\\]*\.json$/i;
const MAX_FOUND = 5;
/** Older ones are left: an export from months ago is not the one the person is moving now. */
const FOUND_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface FoundExport {
  name: string;
  modifiedAt: string;
  bots: string[];
}

/** The newest export files in the person's Downloads folder that read as an import, newest first. */
export function findExports(home: string, now = Date.now()): FoundExport[] {
  const folder = join(home, 'Downloads');
  let names: string[];
  try {
    names = readdirSync(folder).filter((n) => EXPORT_FILE.test(n));
  } catch {
    return [];
  }
  const files = names
    .flatMap((name) => {
      try {
        // A link is refused: only a real file by that name counts.
        const stat = lstatSync(join(folder, name));
        return stat.isFile() && stat.size <= MAX_BOT_IMPORT_BYTES && now - stat.mtimeMs < FOUND_MAX_AGE_MS
          ? [{ name, mtime: stat.mtimeMs }]
          : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FOUND);
  return files.flatMap(({ name, mtime }) => {
    try {
      const doc = botImportFromText(readFileSync(join(folder, name), 'utf8'));
      return [{ name, modifiedAt: new Date(mtime).toISOString(), bots: botImportNames(doc) }];
    } catch {
      return [];
    }
  });
}

/** The texts of export files in Downloads, by the names `findExports` gave. */
export function readExports(home: string, names: string[]): string {
  const folder = join(home, 'Downloads');
  return names
    .filter((n) => EXPORT_FILE.test(n))
    .map((name) => {
      const path = join(folder, name);
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.size > MAX_BOT_IMPORT_BYTES) throw new Error('not a file');
      return readFileSync(path, 'utf8');
    })
    .join('\n\n');
}
