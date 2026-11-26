import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { deviceKey, newDeviceKeyPair, Tunnel, TunnelError, type Peer } from '@leafbot/client/tunnel';
import { hostProofMessage, SERVER_FEATURES, TUNNEL_VERSION } from '@leafbot/shared/tunnel';
import Fastify, { type FastifyInstance } from 'fastify';
import { Server as IOServer } from 'socket.io';
import { io as ioClient, WebSocket as WsTransport } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TunnelGateway, type TunnelChannel } from '../src/tunnel/gateway';
import { tunnelIdentity } from '../src/tunnel/identity';
import { TicketChecker } from '../src/tunnel/ticket';
import { CLIENT_FP, FakePeer, SERVER_FP } from './tunnel-fakes';

/**
 * The browser's side of the tunnel (`client/src/tunnel`) against the server's real gateway, over an
 * in-process channel pair: the proof both ways, requests with their windows, and Socket.IO. WebRTC
 * itself and the relay are not part of this.
 */

const ISSUER = 'https://accounts.example';
const HOST_ID = 'host_12345678';
const issuerKey = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const hostKey = generateKeyPairSync('ed25519');
const HKEY = hostKey.publicKey.export({ format: 'jwk' }).x!;
const jwk = { ...issuerKey.publicKey.export({ format: 'jwk' }), kid: 'k1' };

let jti = 0;
let issued = 0;
function ticket(jkt: string, claims: Record<string, unknown> = {}) {
  issued++;
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'ES256', kid: 'k1' })).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({
      iss: ISSUER,
      aud: HOST_ID,
      sub: 'acct_alice123',
      kind: 'client',
      sid: 'sess_alice123',
      jti: `jti_b${String(++jti).padStart(8, '0')}`,
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

/** The browser's view of a FakePeer: it opens channels, the gateway gets the other ends. */
function browserSide(peer: FakePeer): Peer {
  return {
    localFingerprint: CLIENT_FP,
    remoteFingerprint: SERVER_FP,
    open: async (label) => peer.open(label),
    onClose: (cb) => peer.onClose(cb),
    close: () => peer.close(),
  };
}

let app: FastifyInstance;
let io: IOServer;
let gateway: TunnelGateway;
const access = new Map<string, string>([['acct_alice123', 'user_alice']]);

async function startGateway(opts: { refreshS?: number } = {}) {
  gateway?.close();
  gateway = new TunnelGateway({
    server: app.server,
    checker: new TicketChecker({ issuer: ISSUER, hostId: HOST_ID, fetchJwks: async () => ({ keys: [jwk] }) }),
    host: 'myserver.servers.example',
    hostKey: hostKey.privateKey,
    resolve: async (c) => (access.has(c.sub) ? { userId: access.get(c.sub)! } : null),
    ...opts,
  });
}

beforeEach(async () => {
  app = Fastify();
  app.get('/api/who', async (req) => ({
    userId: tunnelIdentity(req.raw.socket)?.userId ?? null,
    cookie: req.headers.cookie ?? null,
    lang: req.headers['accept-language'] ?? null,
  }));
  app.addContentTypeParser(
    'application/octet-stream',
    { parseAs: 'buffer', bodyLimit: 64 * 1024 * 1024 },
    (_r, b, done) => done(null, b),
  );
  app.post('/api/echo', async (req) => {
    const body = req.body as Buffer;
    return { length: body.length, sha: createHash('sha256').update(body).digest('hex') };
  });
  app.get('/api/big', async (req, reply) => {
    const n = Number((req.query as { n: string }).n);
    const buf = Buffer.alloc(n);
    for (let i = 0; i < n; i++) buf[i] = i % 251;
    return reply.type('application/octet-stream').send(buf);
  });
  app.get('/api/empty', async (_req, reply) => reply.code(204).send());
  await app.ready();
  io = new IOServer(app.server, {
    path: '/socket.io',
    allowRequest: (req, cb) => cb(null, Boolean(tunnelIdentity(req.socket))),
  });
  io.on('connection', (s) => {
    s.emit('hello', tunnelIdentity(s.request.socket)?.userId);
    s.on('echo', (b: unknown, ack: (b: unknown) => void) => ack(b));
  });
  await startGateway();
});

afterEach(async () => {
  gateway.close();
  await new Promise<void>((r) => io.close(() => r()));
  await app.close();
});

async function open(opts: { hostKey?: string; sub?: string; refreshAnswerMs?: number } = {}) {
  const peer = new FakePeer();
  gateway.accept(peer);
  const device = await deviceKey(await newDeviceKeyPair());
  const ended: string[] = [];
  const tunnel = await Tunnel.open({
    peer: browserSide(peer),
    device,
    ticket: async () => ticket(device.jkt, opts.sub ? { sub: opts.sub } : {}),
    hostKey: opts.hostKey ?? HKEY,
    language: 'tr-TR,tr;q=0.9',
    onEnd: (code) => ended.push(code),
  });
  return { tunnel, peer, ended };
}

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const code = (p: Promise<unknown>) =>
  p.then(
    () => 'opened',
    (e: unknown) => (e instanceof TunnelError ? e.code : String(e)),
  );

describe('the browser side of the tunnel', () => {
  it('proves both ends, learns the server’s version and features, and asks as that person', async () => {
    const { tunnel } = await open();
    expect(tunnel.version).toBe(TUNNEL_VERSION);
    expect([...tunnel.features]).toEqual([...SERVER_FEATURES]);
    const res = await tunnel.fetch('/api/who', { headers: { 'x-leafbot-user': 'someone-else' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ userId: 'user_alice', cookie: null, lang: null });
    tunnel.close();
  });

  it('refuses a server that cannot prove it holds the key the ticket names', async () => {
    const other = generateKeyPairSync('ed25519').publicKey.export({ format: 'jwk' }).x!;
    expect(await code(open({ hostKey: other }))).toBe('host-proof');
  });

  it('reports the server’s refusal for an account without access', async () => {
    expect(await code(open({ sub: 'acct_stranger1' }))).toBe('access');
  });

  it('refuses a server below the tunnel version it needs, after checking its proof', async () => {
    const peer = new FakePeer();
    peer.onChannel((ch: TunnelChannel) => {
      ch.send(JSON.stringify({ t: 'challenge', nonce: 'n'.repeat(32) }));
      ch.onMessage((raw) => {
        const auth = JSON.parse(raw as string) as { cnonce: string };
        const proof = hostProofMessage({
          clientFingerprint: CLIENT_FP,
          serverFingerprint: SERVER_FP,
          cnonce: auth.cnonce,
        });
        // A server from before versions: no `v`, no features.
        ch.send(
          JSON.stringify({
            t: 'ok',
            refreshIn: 600,
            sig: sign(null, proof, hostKey.privateKey).toString('base64url'),
          }),
        );
        ch.send(JSON.stringify({ t: 'challenge', nonce: 'm'.repeat(32) }));
      });
    });
    const device = await deviceKey(await newDeviceKeyPair());
    const opened = Tunnel.open({
      peer: browserSide(peer),
      device,
      ticket: async () => ticket(device.jkt),
      hostKey: HKEY,
    });
    expect(await code(opened)).toBe('outdated');
    expect(peer.closed).toBe(true);
  });

  it('proves itself again with fresh tickets and keeps serving', async () => {
    await startGateway({ refreshS: 1 });
    const before = issued;
    const { tunnel, ended } = await open();
    await new Promise((r) => setTimeout(r, 2600));
    expect(issued - before).toBeGreaterThanOrEqual(3);
    expect(ended).toEqual([]);
    expect((await tunnel.fetch('/api/who')).status).toBe(200);
    tunnel.close();
    expect(ended).toEqual(['closed']);
  });

  it('downloads a body larger than the window, intact', async () => {
    const { tunnel } = await open();
    const n = 3 * 1024 * 1024 + 17;
    const res = await tunnel.fetch(`/api/big?n=${n}`);
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body.byteLength).toBe(n);
    const want = Buffer.alloc(n);
    for (let i = 0; i < n; i++) want[i] = i % 251;
    expect(sha(body)).toBe(sha(want));
    tunnel.close();
  });

  it('uploads a body larger than the window, and sends a 204 with no body', async () => {
    const { tunnel } = await open();
    const data = new Uint8Array(1024 * 1024 + 3).map((_, i) => (i * 7) % 256);
    const res = await tunnel.fetch('/api/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Blob([data]),
    });
    expect(await res.json()).toEqual({ length: data.byteLength, sha: sha(data) });
    const empty = await tunnel.fetch('/api/empty');
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe('');
    tunnel.close();
  });

  it('stops a request the page called off, and keeps the connection for the next', async () => {
    const { tunnel } = await open();
    const ctl = new AbortController();
    const res = await tunnel.fetch('/api/big?n=8000000', { signal: ctl.signal });
    const reader = res.body!.getReader();
    await reader.read();
    ctl.abort();
    await expect(reader.read()).rejects.toThrow();
    expect((await tunnel.fetch('/api/who')).status).toBe(200);
    tunnel.close();
  });

  it('refuses a full address, so a request cannot leave the server', async () => {
    const { tunnel } = await open();
    await expect(tunnel.fetch('https://elsewhere.example/api/who')).rejects.toThrow(TypeError);
    await expect(tunnel.fetch('//elsewhere.example/api/who')).rejects.toThrow(TypeError);
    tunnel.close();
  });

  it('runs Socket.IO over its own channel as the same person, with large messages', async () => {
    const { tunnel } = await open();
    class TunnelTransport extends WsTransport {
      override createSocket() {
        return tunnel.realtime() as unknown as WebSocket;
      }
    }
    const s = ioClient('http://tunnel.invalid', {
      path: '/socket.io',
      transports: [TunnelTransport],
      reconnection: false,
    });
    const hello = await new Promise<unknown>((r) => s.once('hello', r));
    expect(hello).toBe('user_alice');
    const big = 'x'.repeat(100_000);
    expect(await s.timeout(5000).emitWithAck('echo', big)).toBe(big);
    s.close();
    tunnel.close();
  });

  it('ends when the server closes the connection', async () => {
    const { tunnel, ended } = await open();
    gateway.close();
    await new Promise((r) => setTimeout(r, 20));
    expect(tunnel.closed).toBe(true);
    expect(ended.length).toBe(1);
    await expect(tunnel.fetch('/api/who')).rejects.toBeInstanceOf(TunnelError);
  });
});
