import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createGitRelay,
  GitGrants,
  RELAY_KEY,
  defaultBranch,
  parsePushCommands,
  parseRelayRequest,
  pkt,
  refusedPush,
  readUntilFlush,
  type UpstreamRequest,
  type UpstreamResponse,
} from '../src/git-relay';

const KEY = 'ab'.repeat(32);
const OTHER = 'cd'.repeat(32);
const Z = '0'.repeat(40);
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const FLUSH = Buffer.from('0000');

/** An upload-pack advertisement whose HEAD points at `branch`. */
const advert = (branch: string) =>
  Buffer.concat([
    pkt('# service=git-upload-pack\n'),
    FLUSH,
    pkt(`${A} HEAD\0multi_ack side-band-64k symref=HEAD:refs/heads/${branch} agent=git/github\n`),
    pkt(`${A} refs/heads/${branch}\n`),
    FLUSH,
  ]);

const pushBody = (refs: string[], pack = 'PACKdata') =>
  Buffer.concat([
    ...refs.map((r, i) =>
      pkt(`${A} ${B} ${r}${i === 0 ? '\0report-status side-band-64k agent=git/2' : ''}\n`),
    ),
    FLUSH,
    Buffer.from(pack),
  ]);

describe('parseRelayRequest', () => {
  it("accepts git's smart HTTP requests only", () => {
    expect(parseRelayRequest('GET', `/${KEY}/esm/web.git/info/refs?service=git-upload-pack`)).toEqual({
      key: KEY,
      owner: 'esm',
      repo: 'web',
      op: 'info/refs',
      service: 'git-upload-pack',
    });
    expect(parseRelayRequest('POST', `/${KEY}/esm/web/git-receive-pack`)).toMatchObject({
      repo: 'web',
      op: 'git-receive-pack',
    });
    for (const [method, path] of [
      ['GET', `/${KEY}/esm/web.git/info/refs`],
      ['GET', `/${KEY}/esm/web.git/info/refs?service=git-upload-pack&x=1`],
      ['GET', `/${KEY}/esm/web.git/HEAD`],
      ['GET', `/${KEY}/esm/web.git/objects/info/packs`],
      ['POST', `/${KEY}/esm/web.git/info/lfs/objects/batch`],
      ['GET', `/${KEY}/esm/web.git/git-upload-pack`],
      ['POST', `/short/esm/web.git/git-upload-pack`],
      ['POST', `/${KEY}/-esm/web.git/git-upload-pack`],
      ['POST', `/${KEY}/esm/../git-upload-pack`],
      ['POST', `/${KEY}/esm/web.git/git-upload-pack?x=1`],
    ] as const) {
      expect(parseRelayRequest(method, path), path).toBeNull();
    }
  });
});

describe('pkt-lines', () => {
  it('reads the ref updates of a push and the capabilities asked for', () => {
    const body = pushBody(['refs/heads/feature', 'refs/heads/main']);
    const r = parsePushCommands(body);
    expect(r).not.toBe('incomplete');
    if (r === 'incomplete') return;
    expect(r.updates.map((u) => u.ref)).toEqual(['refs/heads/feature', 'refs/heads/main']);
    expect(r.caps).toContain('side-band-64k');
    expect(body.subarray(r.end).toString()).toBe('PACKdata');
    expect(parsePushCommands(body.subarray(0, 30))).toBe('incomplete');
    expect(() => parsePushCommands(Buffer.from('zzzz'))).toThrow();
    expect(() => parsePushCommands(Buffer.concat([pkt('push-cert\0report-status\n'), FLUSH]))).toThrow();
  });

  it('finds the default branch in an advertisement; an empty repository has none', () => {
    expect(defaultBranch(advert('develop'))).toBe('refs/heads/develop');
    const empty = Buffer.concat([
      pkt('# service=git-upload-pack\n'),
      FLUSH,
      pkt(`${Z} capabilities^{}\0multi_ack agent=git/github\n`),
      FLUSH,
    ]);
    expect(defaultBranch(empty)).toBeNull();
    // Cut short or without the symref, it cannot tell, which is not the same as none.
    const full = advert('main');
    expect(defaultBranch(full.subarray(0, 60))).toBeUndefined();
    expect(defaultBranch(Buffer.concat([pkt(`${A} HEAD\0multi_ack\n`), FLUSH]))).toBeUndefined();
    expect(defaultBranch(Buffer.from('<html>'))).toBeUndefined();
  });

  it('answers a refused push as receive-pack does, inside the side band when asked', () => {
    const updates = [
      { old: A, new: B, ref: 'refs/heads/main' },
      { old: A, new: B, ref: 'refs/heads/x' },
    ];
    const reasons = new Map([['refs/heads/main', 'main is the default branch']]);
    const plain = refusedPush(updates, ['report-status'], reasons).toString();
    expect(plain).toContain('unpack ok\n');
    expect(plain).toContain('ng refs/heads/main main is the default branch\n');
    expect(plain).toContain('ng refs/heads/x another ref in this push was refused\n');

    const banded = refusedPush(updates, ['report-status', 'side-band-64k'], reasons);
    const outer = readUntilFlush(banded);
    if (outer === 'incomplete') throw new Error('incomplete');
    const bands = outer.lines.filter((l): l is Buffer => !!l);
    expect(bands[0]![0]).toBe(1);
    expect(bands.at(-1)![0]).toBe(2);
    const inner = Buffer.concat(bands.filter((b) => b[0] === 1).map((b) => b.subarray(1)));
    expect(inner.toString()).toBe(plain);
  });
});

describe('the relay', () => {
  let server: Server | null = null;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  /** A relay in front of a stand-in GitHub that records each request with its whole body. */
  async function relay(o: {
    token: string | null;
    head?: string;
    reply?: Partial<UpstreamResponse>;
    /** The answer to the relay's own look at the default branch. */
    check?: Pick<UpstreamResponse, 'status' | 'body'>;
  }) {
    const seen: (Omit<UpstreamRequest, 'body'> & { body: string })[] = [];
    const handler = createGitRelay({
      tokenFor: (k) => (k === KEY ? o.token : undefined),
      upstream: async (r) => {
        const chunks: Buffer[] = [];
        if (r.body) for await (const c of r.body) chunks.push(Buffer.from(c as Buffer));
        seen.push({
          method: r.method,
          path: r.path,
          headers: r.headers,
          body: Buffer.concat(chunks).toString(),
        });
        if (r.path.endsWith('info/refs?service=git-upload-pack') && o.check) {
          return { headers: {}, ...o.check };
        }
        if (r.path.endsWith('info/refs?service=git-upload-pack') && r.method === 'GET' && o.head) {
          return { status: 200, headers: { 'content-type': 'x' }, body: Readable.from([advert(o.head)]) };
        }
        return {
          status: 200,
          headers: { 'content-type': 'application/x-git-result' },
          body: Readable.from([Buffer.from('upstream answer')]),
          ...o.reply,
        };
      },
    });
    server = createServer(handler);
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    const call = (method: string, path: string, body?: Buffer, headers: Record<string, string> = {}) =>
      new Promise<{ status: number; headers: Record<string, unknown>; body: Buffer }>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () =>
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
          );
        });
        req.on('error', reject);
        req.end(body);
      });
    return { seen, call, port };
  }

  it("adds the session's key in place of git's own and passes GitHub's answer back", async () => {
    const r = await relay({ token: 'github_pat_secret' });
    const res = await r.call('GET', `/${KEY}/esm/web/info/refs?service=git-upload-pack`, undefined, {
      authorization: 'Basic Ym90OmZha2U=',
      'git-protocol': 'version=2',
      cookie: 'x=1',
    });
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('upstream answer');
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0]).toMatchObject({
      method: 'GET',
      path: '/esm/web.git/info/refs?service=git-upload-pack',
    });
    expect(r.seen[0]!.headers.authorization).toBe(
      `Basic ${Buffer.from('x-access-token:github_pat_secret').toString('base64')}`,
    );
    expect(r.seen[0]!.headers['git-protocol']).toBe('version=2');
    expect(r.seen[0]!.headers.cookie).toBeUndefined();
  });

  it('refuses addresses of no session, and requests that are not git', async () => {
    const r = await relay({ token: 'k' });
    expect((await r.call('GET', `/${OTHER}/esm/web/info/refs?service=git-upload-pack`)).status).toBe(403);
    expect((await r.call('GET', `/${KEY}/esm/web/raw/main/x`)).status).toBe(404);
    expect(r.seen).toEqual([]);
  });

  it('a session without a key reaches public repositories with no key at all', async () => {
    const r = await relay({ token: null });
    await r.call('GET', `/${KEY}/esm/web/info/refs?service=git-upload-pack`);
    expect(r.seen[0]!.headers.authorization).toBeUndefined();
  });

  it('passes a push to another branch through whole', async () => {
    const r = await relay({ token: 'k', head: 'main' });
    const body = pushBody(['refs/heads/feature'], 'P'.repeat(200_000));
    const res = await r.call('POST', `/${KEY}/esm/web.git/git-receive-pack`, body, {
      'content-type': 'application/x-git-receive-pack-request',
    });
    expect(res.status).toBe(200);
    const post = r.seen.find((s) => s.method === 'POST')!;
    expect(post.path).toBe('/esm/web.git/git-receive-pack');
    expect(post.body).toBe(body.toString());
  });

  it('refuses a push to the default branch before GitHub sees it', async () => {
    const r = await relay({ token: 'k', head: 'develop' });
    const res = await r.call(
      'POST',
      `/${KEY}/esm/web.git/git-receive-pack`,
      pushBody(['refs/heads/feature', 'refs/heads/develop']),
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-git-receive-pack-result');
    expect(res.body.toString()).toContain('ng refs/heads/develop develop is the default branch');
    expect(r.seen.filter((s) => s.method === 'POST')).toEqual([]);
  });

  it('refuses a push when the default branch cannot be read', async () => {
    for (const reply of [
      { status: 200, body: Readable.from([advert('main').subarray(0, 50)]) },
      { status: 404, body: Readable.from([Buffer.from('not found')]) },
    ]) {
      const r = await relay({ token: 'k', check: reply });
      const res = await r.call(
        'POST',
        `/${KEY}/esm/web.git/git-receive-pack`,
        pushBody(['refs/heads/feature']),
      );
      expect(res.body.toString()).toContain(
        'ng refs/heads/feature the relay could not check the default branch',
      );
      expect(r.seen.filter((s) => s.method === 'POST')).toEqual([]);
      await new Promise<void>((done) => server!.close(() => done()));
      server = null;
    }
  });

  it('refuses a compressed push and a push it cannot read', async () => {
    const r = await relay({ token: 'k', head: 'main' });
    const path = `/${KEY}/esm/web.git/git-receive-pack`;
    expect(
      (await r.call('POST', path, pushBody(['refs/heads/x']), { 'content-encoding': 'gzip' })).status,
    ).toBe(415);
    expect((await r.call('POST', path, Buffer.from('not a push'))).status).toBe(400);
    expect(r.seen).toEqual([]);
  });

  it('sends a moved repository back through the relay', async () => {
    const r = await relay({
      token: 'k',
      reply: {
        status: 301,
        headers: { location: 'https://github.com/esm/new.git/info/refs?service=git-upload-pack' },
      },
    });
    const res = await r.call('GET', `/${KEY}/esm/old/info/refs?service=git-upload-pack`);
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe(
      `http://127.0.0.1:${r.port}/${KEY}/esm/new.git/info/refs?service=git-upload-pack`,
    );
  });
});

describe('tek komutluk anahtarlar', () => {
  it('komut sürerken ve masaüstü aynıyken çalışır; sonra çalışmaz', () => {
    const grants = new GitGrants();
    let alive = new Set(['oturum-a', 'oturum-b']);
    const isAlive = (s: string) => alive.has(s);
    const a = grants.give('oturum-a', 'ghp_ayse');
    const b = grants.give('oturum-b', 'ghp_mert');
    expect(a).toMatch(RELAY_KEY);
    expect(a).not.toBe(b);
    expect(grants.tokenFor(a, isAlive)).toBe('ghp_ayse');
    expect(grants.tokenFor(b, isAlive)).toBe('ghp_mert');
    expect(grants.tokenFor('f'.repeat(64), isAlive)).toBeUndefined();

    // The command ended: its address is gone, the other one's stays.
    grants.end(a);
    expect(grants.tokenFor(a, isAlive)).toBeUndefined();
    expect(grants.tokenFor(b, isAlive)).toBe('ghp_mert');

    // The desktop restarted under another session: an address of the old one no longer works.
    alive = new Set(['oturum-c']);
    expect(grants.tokenFor(b, isAlive)).toBeUndefined();
    expect(grants.size).toBe(0);

    const c = grants.give('oturum-c', 'ghp_x');
    grants.endSession('oturum-c');
    expect(grants.tokenFor(c, () => true)).toBeUndefined();
  });
});
