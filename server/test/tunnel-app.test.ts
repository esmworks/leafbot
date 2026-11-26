import { request } from 'node:http';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectInProcess, type TunnelIdentity } from '../src/tunnel/identity';
import { testServer, type TestServer } from './helpers';

/** The app as the tunnel reaches it: requests on in-process sockets tagged with a person. */
describe('requests that came over the tunnel', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
    // Requests reach the server directly, not through inject, which would get it ready first.
    await t.app.ready();
  });
  afterAll(async () => {
    await t.dispose();
  });

  const as = (userId: string): TunnelIdentity => ({
    userId,
    accountUserId: `acct_${userId}`,
    sessionId: `sess_${userId}`,
    connection: `conn_${userId}`,
  });

  function call(
    who: TunnelIdentity,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: unknown; headers: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const req = request(
        {
          method,
          path,
          // The gateway writes these; no Origin, and a Host the server was never told about.
          headers: {
            host: 'myserver.servers.example',
            ...(payload && {
              'content-type': 'application/json',
              'content-length': String(Buffer.byteLength(payload)),
            }),
            ...headers,
          },
          createConnection: () => connectInProcess(t.app.server, who),
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({
              status: res.statusCode ?? 0,
              body: text ? (JSON.parse(text) as unknown) : null,
              headers: res.headers,
            });
          });
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  it('is the person the tunnel proved, without a cookie or Origin', async () => {
    await t.person('ayse', 'member');
    const session = await call(as('ayse'), 'GET', '/api/session');
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ authenticated: true, user: { id: 'ayse', role: 'member' } });
    // No HSTS or cookie is set for a page the server never served itself.
    expect(session.headers['strict-transport-security']).toBeUndefined();
    expect(session.headers['set-cookie']).toBeUndefined();
    // A write needs no Origin: only the page holding the tunnel can send one.
    const bots = await call(as('ayse'), 'GET', '/api/bots');
    expect(bots.status).toBe(200);
  });

  it('ignores a session cookie sent along', async () => {
    const other = await t.person('mehmet', 'admin');
    const res = await call(as('ayse'), 'GET', '/api/session', undefined, { cookie: other.cookie });
    expect(res.body).toMatchObject({ user: { id: 'ayse' } });
  });

  it('does not start a session of the server’s own', async () => {
    for (const path of ['/api/login', '/api/access', '/api/pair']) {
      const res = await call(as('ayse'), 'POST', path, {});
      expect(res.status, path).toBe(403);
    }
  });

  it('stops working once the person is disabled or gone', async () => {
    await t.person('zeynep', 'member');
    expect((await call(as('zeynep'), 'GET', '/api/bots')).status).toBe(200);
    await t.auth.users.change('zeynep', { disabled: true });
    // What the people routes do after every change: forget what was remembered about them.
    await t.auth.forgetPerson('zeynep', false);
    expect((await call(as('zeynep'), 'GET', '/api/bots')).status).toBe(401);
    expect((await call(as('nobody'), 'GET', '/api/bots')).status).toBe(401);
    expect((await call(as('nobody'), 'GET', '/api/session')).body).toMatchObject({ authenticated: false });
  });

  it('opens Socket.IO as the person, and refuses one that is not there', async () => {
    const open = (userId: string) =>
      new WebSocket('ws://myserver.servers.example/socket.io/?EIO=4&transport=websocket', {
        createConnection: (() => connectInProcess(t.app.server, as(userId))) as never,
      });
    const ok = open('ayse');
    const said: string[] = [];
    ok.on('message', (m: Buffer) => said.push(m.toString()));
    await new Promise((r) => ok.once('open', r));
    await new Promise((r) => setTimeout(r, 50));
    ok.send('40');
    await new Promise((r) => setTimeout(r, 100));
    expect(said.some((m) => m.startsWith('42["hello"'))).toBe(true);
    ok.close();
    const refused = open('nobody');
    refused.on('error', () => {});
    const status = await new Promise<number>((resolve) =>
      refused.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0)),
    );
    expect(status).toBeGreaterThanOrEqual(400);
    refused.terminate();
  });
});
