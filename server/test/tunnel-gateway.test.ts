import { createHash, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import {
  BUFFER_HIGH,
  BUFFER_LOW,
  CHANNEL,
  encodeRt,
  hostProofMessage,
  MAX_FRAME_PAYLOAD,
  MAX_MESSAGE,
  RtAssembler,
  decodeFrame,
  ed25519ThumbprintInput,
  encodeAck,
  encodeFrame,
  FRAME,
  proofMessage,
  SERVER_FEATURES,
  STREAM_WINDOW,
  TUNNEL_VERSION,
  type CtlToClient,
} from '@leafbot/shared/tunnel';
import Fastify, { type FastifyInstance } from 'fastify';
import { Server as IOServer } from 'socket.io';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TunnelGateway, type TunnelChannel, type TunnelPeer } from '../src/tunnel/gateway';
import { tunnelIdentity } from '../src/tunnel/identity';
import { TicketChecker } from '../src/tunnel/ticket';

const ISSUER = 'https://accounts.example';
const HOST_ID = 'host_12345678';
const CLIENT_FP = 'sha-256 AA:01:02';
const SERVER_FP = 'sha-256 BB:03:04';

// ---- A data channel pair, delivering asynchronously like a real one ---------------------------

const size = (m: string | Uint8Array) => (typeof m === 'string' ? Buffer.byteLength(m) : m.byteLength);

class End implements TunnelChannel {
  other!: End;
  bufferedAmount = 0;
  /** The most that ever waited in this end's send buffer. */
  maxBuffered = 0;
  closed = false;
  /** Bytes delivered per millisecond; 0 delivers each message on the next turn. */
  slow = 0;
  private queue: (string | Uint8Array)[] = [];
  private pumping = false;
  private message: ((d: string | Uint8Array) => void)[] = [];
  private closeCbs: (() => void)[] = [];
  private drainCbs: (() => void)[] = [];
  constructor(readonly label: string) {}
  private deliver(m: string | Uint8Array) {
    if (!this.other.closed) for (const cb of this.other.message) cb(m);
  }
  send(d: string | Uint8Array) {
    if (this.closed) throw new Error('closed');
    const copy = typeof d === 'string' ? d : new Uint8Array(d);
    if (!this.slow) return void setImmediate(() => this.deliver(copy));
    this.queue.push(copy);
    this.bufferedAmount += size(copy);
    this.maxBuffered = Math.max(this.maxBuffered, this.bufferedAmount);
    if (this.pumping) return;
    this.pumping = true;
    const tick = () => {
      let budget = this.slow;
      while (this.queue.length && budget > 0) {
        const m = this.queue.shift()!;
        budget -= size(m);
        const was = this.bufferedAmount;
        this.bufferedAmount -= size(m);
        this.deliver(m);
        if (was > BUFFER_LOW && this.bufferedAmount <= BUFFER_LOW) for (const cb of this.drainCbs) cb();
      }
      if (this.queue.length && !this.closed) setTimeout(tick, 1);
      else this.pumping = false;
    };
    setTimeout(tick, 1);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    setImmediate(() => {
      for (const cb of this.closeCbs) cb();
      this.other.close();
    });
  }
  onMessage(cb: (d: string | Uint8Array) => void) {
    this.message.push(cb);
  }
  onClose(cb: () => void) {
    this.closeCbs.push(cb);
  }
  onDrain(cb: () => void) {
    this.drainCbs.push(cb);
  }
}

class FakePeer implements TunnelPeer {
  localFingerprint = SERVER_FP;
  remoteFingerprint = CLIENT_FP;
  closed = false;
  serverEnds: End[] = [];
  private channelCb: ((ch: TunnelChannel) => void) | null = null;
  private closeCbs: (() => void)[] = [];
  onChannel(cb: (ch: TunnelChannel) => void) {
    this.channelCb = cb;
  }
  onClose(cb: () => void) {
    this.closeCbs.push(cb);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) cb();
  }
  /** The browser opens a channel; returns its end. `slow` holds the server's sends back. */
  open(label: string, slow = 0): End {
    const browser = new End(label);
    const server = new End(label);
    server.slow = slow;
    this.serverEnds.push(server);
    browser.other = server;
    server.other = browser;
    setImmediate(() => this.channelCb?.(server));
    return browser;
  }
}

// ---- Tickets -------------------------------------------------------------------------------

const issuerKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
/** This server's own key; tickets name its public half. */
const hostKey = generateKeyPairSync('ed25519');
const HKEY = hostKey.publicKey.export({ format: 'jwk' }).x!;
const jwk = { ...issuerKey.publicKey.export({ format: 'jwk' }), kid: 'k1' };

function device() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const x = publicKey.export({ format: 'jwk' }).x!;
  return { privateKey, x, jkt: createHash('sha256').update(ed25519ThumbprintInput(x)).digest('base64url') };
}

let jti = 0;
function ticket(jkt: string, claims: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1' })).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: HOST_ID,
      sub: 'acct_alice123',
      kind: 'client',
      sid: 'sess_alice123',
      jti: `jti_${String(++jti).padStart(8, '0')}`,
      iat: now,
      exp: now + 60,
      role: 'member',
      mid: 'mem_alice123',
      epoch: 1,
      cnf: { jkt },
      hkey: HKEY,
      ...claims,
    }),
  ).toString('base64url');
  const s = sign('sha256', Buffer.from(`${h}.${p}`), {
    key: issuerKey.privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return `${h}.${p}.${s.toString('base64url')}`;
}

/** Reads ctl messages in order. */
function ctlReader(ch: End) {
  const queue: CtlToClient[] = [];
  const waiters: ((m: CtlToClient) => void)[] = [];
  ch.onMessage((m) => {
    const msg = JSON.parse(m as string) as CtlToClient;
    const w = waiters.shift();
    if (w) w(msg);
    else queue.push(msg);
  });
  return () => new Promise<CtlToClient>((r) => (queue.length ? r(queue.shift()!) : waiters.push(r)));
}

async function prove(
  ctl: End,
  read: () => Promise<CtlToClient>,
  d: { privateKey: KeyObject; x: string; jkt: string },
  t = ticket(d.jkt),
  fps = { clientFingerprint: CLIENT_FP, serverFingerprint: SERVER_FP },
) {
  const challenge = await read();
  if (challenge.t !== 'challenge') throw new Error(`expected challenge, got ${challenge.t}`);
  const sig = sign(null, proofMessage({ ticket: t, ...fps, nonce: challenge.nonce }), d.privateKey).toString(
    'base64url',
  );
  const cnonce = randomBytes(16).toString('base64url');
  ctl.send(JSON.stringify({ t: 'auth', ticket: t, key: d.x, sig, cnonce, lang: 'tr-TR,tr;q=0.9' }));
  const answer = await read();
  // The browser trusts nothing until the server proved it holds the key the ticket names.
  if (answer.t === 'ok') {
    const proof = hostProofMessage({ ...fps, cnonce });
    if (!verify(null, proof, hostKey.publicKey, Buffer.from(answer.sig, 'base64url')))
      throw new Error('bad host proof');
  }
  return answer;
}

// ---- The app on the other side -------------------------------------------------------------

let app: FastifyInstance;
let io: IOServer;
let gateway: TunnelGateway;
let checker: TicketChecker;
const access = new Map<string, string>([['acct_alice123', 'user_alice']]);

beforeEach(async () => {
  app = Fastify();
  app.get('/api/who', async (req) => ({
    identity: tunnelIdentity(req.raw.socket) ?? null,
    headers: req.headers,
  }));
  app.post('/api/echo', async (req) => {
    const body = req.body as Buffer;
    return { length: body.length, sha: createHash('sha256').update(body).digest('hex') };
  });
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 },
    (_r, b, done) => done(null, b),
  );
  app.get('/api/big', async (req, reply) => {
    const n = Number((req.query as { n: string }).n);
    reply.header('set-cookie', 'leafbot_session=x');
    return reply.send(Buffer.alloc(n, 7));
  });
  await app.ready();
  io = new IOServer(app.server, {
    path: '/socket.io',
    allowRequest: (req, cb) => cb(null, Boolean(tunnelIdentity(req.socket))),
  });
  io.on('connection', (s) => {
    s.emit('hello', tunnelIdentity(s.request.socket)?.userId);
    s.emit('lang', s.handshake.headers['accept-language']);
    s.on('echo', (b: unknown, ack: (b: unknown) => void) => ack(b));
  });
  checker = new TicketChecker({ issuer: ISSUER, hostId: HOST_ID, fetchJwks: async () => ({ keys: [jwk] }) });
  gateway = new TunnelGateway({
    server: app.server,
    checker,
    host: 'myserver.servers.example',
    hostKey: hostKey.privateKey,
    resolve: async (c) => (access.has(c.sub) ? { userId: access.get(c.sub)! } : null),
  });
});

afterEach(async () => {
  gateway.close();
  await new Promise<void>((r) => io.close(() => r()));
  await app.close();
});

async function connected() {
  const peer = new FakePeer();
  gateway.accept(peer);
  const ctl = peer.open(CHANNEL.ctl);
  const read = ctlReader(ctl);
  const d = device();
  const ok = await prove(ctl, read, d);
  expect(ok).toMatchObject({ t: 'ok' });
  return { peer, ctl, read, d, ok };
}

// ---- A minimal browser-side HTTP client over the channel -------------------------------------

function httpClient(ch: End, opts: { ackDelayMs?: number } = {}) {
  let next = 1;
  const pending = new Map<
    number,
    {
      head?: { status: number; headers: Record<string, unknown> };
      chunks: Uint8Array[];
      done: (v: unknown) => void;
      fail: (e: Error) => void;
      maxUnacked: number;
      unacked: number;
    }
  >();
  ch.onMessage((m) => {
    const f = decodeFrame(m as Uint8Array);
    if (!f) return;
    const p = pending.get(f.stream);
    if (!p) return;
    if (f.type === FRAME.RESPONSE) p.head = JSON.parse(new TextDecoder().decode(f.payload));
    else if (f.type === FRAME.DATA) {
      p.chunks.push(f.payload);
      p.unacked += f.payload.byteLength;
      p.maxUnacked = Math.max(p.maxUnacked, p.unacked);
      const n = f.payload.byteLength;
      setTimeout(() => {
        p.unacked -= n;
        if (!ch.closed) ch.send(encodeFrame(FRAME.ACK, f.stream, encodeAck(n)));
      }, opts.ackDelayMs ?? 0);
    } else if (f.type === FRAME.END) {
      pending.delete(f.stream);
      p.done({ ...p.head, body: Buffer.concat(p.chunks), maxUnacked: p.maxUnacked });
    } else if (f.type === FRAME.RESET) {
      pending.delete(f.stream);
      p.fail(new Error('reset'));
    }
  });
  return (
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body?: Buffer,
  ): Promise<{ status: number; headers: Record<string, unknown>; body: Buffer; maxUnacked: number }> => {
    const id = next++;
    return new Promise((done, fail) => {
      pending.set(id, { chunks: [], done: done as never, fail, maxUnacked: 0, unacked: 0 });
      const head = { method, path, headers, ...(body && { length: body.length }) };
      ch.send(encodeFrame(FRAME.REQUEST, id, new TextEncoder().encode(JSON.stringify(head))));
      if (body)
        for (let i = 0; i < body.length; i += MAX_FRAME_PAYLOAD)
          ch.send(encodeFrame(FRAME.DATA, id, body.subarray(i, i + MAX_FRAME_PAYLOAD)));
      ch.send(encodeFrame(FRAME.END, id));
    });
  };
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

describe('TunnelGateway', () => {
  it('names its tunnel version and the parts of the app it offers once the proof is accepted', async () => {
    const { ok } = await connected();
    expect(ok).toMatchObject({ t: 'ok', v: TUNNEL_VERSION, features: [...SERVER_FEATURES] });
    gateway.close();
    gateway = new TunnelGateway({
      server: app.server,
      checker,
      host: 'myserver.servers.example',
      hostKey: hostKey.privateKey,
      resolve: async (c) => (access.has(c.sub) ? { userId: access.get(c.sub)! } : null),
      features: ['rooms'],
    });
    expect((await connected()).ok).toMatchObject({ features: ['rooms'] });
  });

  it('serves requests as the person the ticket names, whatever headers the page sends', async () => {
    const { peer } = await connected();
    const http = peer.open(CHANNEL.http);
    await tick();
    const fetch = httpClient(http);
    const res = await fetch('GET', '/api/who', {
      cookie: 'leafbot_session=stolen',
      authorization: 'Bearer stolen',
      'x-leafbot-proxy': 'secret',
      'x-forwarded-for': '10.0.0.1',
      host: 'evil.example',
      accept: 'application/json',
    });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body.toString()) as {
      identity: { userId: string };
      headers: Record<string, string>;
    };
    expect(body.identity).toMatchObject({
      userId: 'user_alice',
      accountUserId: 'acct_alice123',
      sessionId: 'sess_alice123',
    });
    expect(body.headers.host).toBe('myserver.servers.example');
    expect(body.headers.accept).toBe('application/json');
    for (const h of ['cookie', 'authorization', 'x-leafbot-proxy', 'x-forwarded-for'])
      expect(body.headers[h], h).toBeUndefined();
  });

  it('carries request bodies and holds large responses to the window', async () => {
    const { peer } = await connected();
    const http = peer.open(CHANNEL.http);
    await tick();
    const fetch = httpClient(http, { ackDelayMs: 2 });
    const upload = Buffer.alloc(3 * 1024 * 1024, 5);
    const echoed = await fetch('POST', '/api/echo', { 'content-type': 'application/octet-stream' }, upload);
    expect(JSON.parse(echoed.body.toString())).toEqual({
      length: upload.length,
      sha: createHash('sha256').update(upload).digest('hex'),
    });
    const big = await fetch('GET', '/api/big?n=4000000');
    expect(big.body.length).toBe(4_000_000);
    expect(big.headers['set-cookie']).toBeUndefined();
    // Never more than a window (plus the chunk that crossed it) waits unread at the browser.
    expect(big.maxUnacked).toBeLessThanOrEqual(STREAM_WINDOW + 64 * 1024);
  });

  it('refuses requests that try to reach another host or smuggle a line', async () => {
    const { peer } = await connected();
    const http = peer.open(CHANNEL.http);
    await tick();
    const fetch = httpClient(http);
    await expect(fetch('GET', '//evil.example/x')).rejects.toThrow('reset');
    await expect(fetch('GET', '/api/who', { 'x-a': 'b\r\nCookie: c' })).rejects.toThrow('reset');
  });

  /** Sends one request's frames as given and says whether the server reset the stream. */
  async function raw(http: End, id: number, head: object, body: Uint8Array[], end = true) {
    let reset = false;
    http.onMessage((m) => {
      const f = decodeFrame(m as Uint8Array);
      if (f?.stream === id && f.type === FRAME.RESET) reset = true;
    });
    http.send(encodeFrame(FRAME.REQUEST, id, new TextEncoder().encode(JSON.stringify(head))));
    for (const b of body) http.send(encodeFrame(FRAME.DATA, id, b));
    if (end) http.send(encodeFrame(FRAME.END, id));
    await tick(50);
    return reset;
  }

  it('holds a body to the length the page declared', async () => {
    const { peer } = await connected();
    const http = peer.open(CHANNEL.http);
    await tick();
    const head = {
      method: 'POST',
      path: '/api/echo',
      headers: { 'content-type': 'application/octet-stream' },
    };
    expect(await raw(http, 1, { ...head, length: 10 }, [new Uint8Array(20)])).toBe(true);
    expect(await raw(http, 2, { ...head, length: 10 }, [new Uint8Array(5)])).toBe(true);
    expect(await raw(http, 3, { method: 'GET', path: '/api/who' }, [new Uint8Array(5)])).toBe(true);
    expect(await raw(http, 4, { ...head, length: 10 }, [new Uint8Array(10)])).toBe(false);
  });

  it('stops sending while the channel’s own buffer is full', async () => {
    const { peer } = await connected();
    const http = peer.open(CHANNEL.http, 512);
    await tick();
    const fetch = httpClient(http);
    // Many streams at once fill the channel past what one stream's window could.
    const all = await Promise.all(Array.from({ length: 8 }, () => fetch('GET', '/api/big?n=1000000')));
    for (const r of all) expect(r.body.length).toBe(1_000_000);
    const server = peer.serverEnds.find((e) => e.label === CHANNEL.http)!;
    expect(server.maxBuffered).toBeGreaterThan(BUFFER_LOW);
    expect(server.maxBuffered).toBeLessThanOrEqual(BUFFER_HIGH + MAX_MESSAGE);
  });

  /** The browser's side of a Socket.IO channel, in whole WebSocket messages. */
  function realtime(rt: End) {
    const got: (string | Uint8Array)[] = [];
    const pieces = new RtAssembler();
    rt.onMessage((p) => {
      const m = pieces.push(p as Uint8Array);
      if (m !== null) got.push(m);
    });
    return { got, send: (m: string | Uint8Array) => encodeRt(m).forEach((p) => rt.send(p)) };
  }

  it('runs Socket.IO over a channel as the same person', async () => {
    const { peer } = await connected();
    const rt = realtime(peer.open(CHANNEL.rt));
    await tick(50);
    // The engine.io open packet arrives first, then the Socket.IO connect.
    expect(String(rt.got[0]).startsWith('0{')).toBe(true);
    rt.send('40');
    await tick(50);
    expect(rt.got.some((m) => typeof m === 'string' && m.startsWith('40{'))).toBe(true);
    expect(rt.got.some((m) => m === '42["hello","user_alice"]')).toBe(true);
    // Opened inside the server, the connection still carries the page's language.
    expect(rt.got).toContain('42["lang","tr-TR,tr;q=0.9"]');
  });

  it('carries Socket.IO messages larger than a channel message, both ways', async () => {
    const { peer } = await connected();
    const channel = peer.open(CHANNEL.rt);
    const rt = realtime(channel);
    await tick(50);
    rt.send('40');
    await tick(50);
    const long = 'x'.repeat(300_000);
    rt.send(`421["echo","${long}"]`);
    await tick(200);
    expect(rt.got).toContain(`431["${long}"]`);
    // Every piece on the channel stayed within the limit.
    expect(peer.serverEnds.every((e) => !e.closed)).toBe(true);
    expect(MAX_MESSAGE).toBe(16 * 1024);
  });

  it('serves nothing before the proof', async () => {
    const peer = new FakePeer();
    gateway.accept(peer);
    peer.open(CHANNEL.ctl);
    const http = peer.open(CHANNEL.http);
    await tick();
    expect(http.closed).toBe(true);
  });

  it('refuses a proof made for another connection', async () => {
    const peer = new FakePeer();
    gateway.accept(peer);
    const ctl = peer.open(CHANNEL.ctl);
    const read = ctlReader(ctl);
    const d = device();
    const res = await prove(ctl, read, d, undefined, {
      clientFingerprint: CLIENT_FP,
      serverFingerprint: 'sha-256 EE:EE',
    });
    expect(res).toEqual({ t: 'denied', code: 'proof' });
    expect(peer.closed).toBe(true);
  });

  it('refuses an account with no access to this server', async () => {
    const peer = new FakePeer();
    gateway.accept(peer);
    const ctl = peer.open(CHANNEL.ctl);
    const d = device();
    const res = await prove(ctl, ctlReader(ctl), d, ticket(d.jkt, { sub: 'acct_mallory1' }));
    expect(res).toEqual({ t: 'denied', code: 'access' });
  });

  it('keeps the connection on a fresh ticket but not on someone else’s', async () => {
    const { ctl, read, d } = await connected();
    expect(await prove(ctl, read, d)).toMatchObject({ t: 'ok' });
    access.set('acct_bob12345', 'user_bob');
    expect(await prove(ctl, read, d, ticket(d.jkt, { sub: 'acct_bob12345' }))).toEqual({
      t: 'denied',
      code: 'ticket',
    });
  });

  it('closes everything a connection opened when access is taken away', async () => {
    const { peer, ctl } = await connected();
    const rt = realtime(peer.open(CHANNEL.rt));
    const http = peer.open(CHANNEL.http);
    await tick(50);
    rt.send('40');
    await tick(50);
    expect(io.sockets.sockets.size).toBe(1);
    const said: string[] = [];
    ctl.onMessage((m) => said.push(m as string));
    gateway.revoke({ epoch: 2, userId: 'acct_alice123' });
    await tick(50);
    expect(said).toContain(JSON.stringify({ t: 'denied', code: 'revoked' }));
    expect(peer.closed).toBe(true);
    expect(http.closed).toBe(true);
    expect(io.sockets.sockets.size).toBe(0);
    expect(gateway.size).toBe(0);
    // Tickets signed before the change no longer work.
    expect(checker.epoch).toBe(2);
  });

  it('leaves other people connected when one person loses access', async () => {
    await connected();
    gateway.revoke({ epoch: 2, userId: 'acct_someone1' });
    expect(gateway.size).toBe(1);
  });
});
