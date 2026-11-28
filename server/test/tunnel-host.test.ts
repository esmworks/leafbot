import { createPublicKey, verify } from 'node:crypto';
import { request } from 'node:http';
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { WebSocketServer } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { AccountHost, claimMessage } from '../src/tunnel/host';
import type { RtcConnection } from '../src/tunnel/signal';
import { connectInProcess } from '../src/tunnel/identity';
import { testServer, type TestServer } from './helpers';

const ISSUER = 'https://accounts.example';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';

/** The account service's two host routes, as far as linking and host tickets use them. */
function fakeAccount(opts: { taken?: boolean; inviteError?: [number, string] } = {}) {
  const claims: { hostId: string; publicKey: string; name: string }[] = [];
  const tickets: string[] = [];
  const invites: { auth: string; body: Record<string, unknown>; id: string }[] = [];
  const members: { method: string; userId: string; body: unknown }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url === `${ISSUER}/v1/host/claim`) {
      const b = JSON.parse(String(init?.body)) as Record<string, string>;
      if (opts.taken) return json(409, { error: 'host_taken' });
      const key = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: b.publicKey! }, format: 'jwk' });
      const ok = verify(null, claimMessage(b.hostId!, b.code!), key, Buffer.from(b.signature!, 'base64url'));
      if (!ok || b.code!.replace(/-/g, '') !== CODE.replace(/-/g, ''))
        return json(400, { error: 'invalid_code' });
      claims.push({ hostId: b.hostId!, publicKey: b.publicKey!, name: b.name! });
      return json(201, {
        hostId: b.hostId,
        machineToken: `mt_${claims.length}_secret`,
        credentialId: `cred_${claims.length}`,
      });
    }
    if (url === `${ISSUER}/v1/host/invites` && init?.method === 'POST') {
      if (opts.inviteError) return json(opts.inviteError[0], { error: opts.inviteError[1] });
      const id = `inv_${invites.length + 1}_abcdefgh`;
      invites.push({
        auth: new Headers(init.headers).get('authorization') ?? '',
        body: JSON.parse(String(init.body)) as Record<string, unknown>,
        id,
      });
      return json(201, { id, expiresAt: 1234 });
    }
    if (url === `${ISSUER}/v1/host/invites`) {
      return json(200, {
        invites: invites.map((i) => ({
          id: i.id,
          role: i.body.role,
          email: i.body.email,
          person: i.body.person ?? null,
          createdAt: 1,
          expiresAt: 1234,
          undelivered: false,
        })),
      });
    }
    const revoke = /\/v1\/host\/invites\/(.+)$/.exec(url);
    if (revoke && init?.method === 'DELETE') {
      const at = invites.findIndex((i) => i.id === revoke[1]);
      if (at < 0) return json(404, { error: 'not_found' });
      invites.splice(at, 1);
      return new Response(null, { status: 204 });
    }
    const member = /\/v1\/host\/members\/(.+)$/.exec(url);
    if (member) {
      members.push({
        method: init?.method ?? 'GET',
        userId: decodeURIComponent(member[1]!),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (member[1] === 'acct_gone_0001') return json(404, { error: 'not_found' });
      return new Response(null, { status: 204 });
    }
    if (url === `${ISSUER}/v1/host/connect-codes` && init?.method === 'POST') {
      return json(201, { code: 'ABCDE-FGHJK', expiresAt: 99, url: 'leafbot://connect?code=ABCDE-FGHJK' });
    }
    if (url === `${ISSUER}/v1/host/ticket`) {
      tickets.push(new Headers(init?.headers).get('authorization') ?? '');
      return json(200, { ticket: `host-ticket-${tickets.length}`, expiresAt: 0, epoch: 1 });
    }
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return { fetcher, claims, tickets, invites, members };
}

describe('linking the server to an account', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
    await t.app.ready();
  });
  afterAll(async () => {
    await t.dispose();
  });

  const host = (account: ReturnType<typeof fakeAccount>, extra: { relayUrl?: string; rtc?: boolean } = {}) =>
    new AccountHost({
      db: t.services.ctx.db,
      vault: t.services.vault,
      server: t.app.server,
      config: {
        issuer: ISSUER,
        relayUrl: extra.relayUrl ?? 'ws://127.0.0.1:9/v1/signal',
        webHost: 'www.leafbot.app',
      },
      rtc: extra.rtc ? () => ({}) as RtcConnection : null,
      fetcher: account.fetcher,
    });

  it('redeems an install code with a key it proves it holds, and keeps the token sealed', async () => {
    const account = fakeAccount();
    const h = host(account);
    const state = await h.link(CODE, 'Office');
    expect(state).toMatchObject({ linked: true, name: 'Office', running: false, noWebRtc: true });
    expect(account.claims).toHaveLength(1);
    const [row] = await t.services.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, 'account-host'));
    const stored = JSON.stringify(row?.value);
    expect(stored).not.toContain('mt_1_secret');
    expect(stored).not.toContain('PRIVATE KEY');
    expect(stored).toContain(account.claims[0]!.hostId);
  });

  it('keeps its id when linked again, and forgets the token when unlinked', async () => {
    const account = fakeAccount();
    const h = host(account);
    const first = (await h.state()).hostId;
    await h.link(CODE.replace(/-/g, ''), 'Office');
    expect(account.claims[0]!.hostId).toBe(first);
    const unlinked = await h.unlink();
    expect(unlinked).toMatchObject({ linked: false, hostId: null });
    const [row] = await t.services.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, 'account-host'));
    expect(row?.value).toEqual({ hostId: first, linked: false });
    await h.link(CODE, 'Office');
    expect(account.claims[1]!.hostId).toBe(first);
  });

  it('says why a code did not work', async () => {
    await expect(host(fakeAccount()).link('not-a-code', 'x')).rejects.toMatchObject({ status: 400 });
    await expect(host(fakeAccount()).link('ZZZZZ-ZZZZZ-ZZZZZ-ZZZZZ', 'x')).rejects.toMatchObject({
      status: 400,
    });
    await expect(host(fakeAccount({ taken: true })).link(CODE, 'x')).rejects.toMatchObject({ status: 409 });
  });

  it('once linked, goes to the relay with a host ticket bought with its machine token', async () => {
    const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await new Promise((r) => relay.once('listening', r));
    const hello = new Promise<unknown>((r) =>
      relay.on('connection', (ws) => ws.once('message', (m) => r(JSON.parse(String(m))))),
    );
    const account = fakeAccount();
    const port = (relay.address() as AddressInfo).port;
    const h = host(account, { relayUrl: `ws://127.0.0.1:${port}/v1/signal`, rtc: true });
    await h.link(CODE, 'Office');
    expect(await hello).toEqual({ type: 'hello', role: 'host', ticket: 'host-ticket-1' });
    expect(account.tickets).toEqual(['Bearer mt_1_secret']);
    expect((await h.state()).running).toBe(true);
    h.stop();
    expect((await h.state()).running).toBe(false);
    await new Promise<void>((r) => relay.close(() => r()));
  });

  it('invites through the account with its machine token, and only once linked', async () => {
    const account = fakeAccount();
    const h = host(account);
    await h.unlink();
    await expect(h.invite({ email: 'ann@example.com', role: 'member', lang: 'en' })).rejects.toMatchObject({
      status: 409,
      key: 'error.serverNotLinked',
    });
    expect(await h.invites()).toEqual([]);
    await h.link(CODE, 'Office');
    const made = await h.invite({
      email: 'ann@example.com',
      role: 'member',
      person: 'person-0001',
      lang: 'tr',
    });
    expect(made).toEqual({ id: 'inv_1_abcdefgh', expiresAt: 1234 });
    expect(account.invites[0]).toMatchObject({
      auth: expect.stringMatching(/^Bearer mt_\d+_secret$/),
      body: { email: 'ann@example.com', role: 'member', person: 'person-0001', lang: 'tr' },
    });
    expect(await h.invites()).toEqual([
      expect.objectContaining({ id: 'inv_1_abcdefgh', email: 'ann@example.com', person: 'person-0001' }),
    ]);
    await h.revokeInvite('inv_1_abcdefgh');
    await expect(h.revokeInvite('inv_1_abcdefgh')).rejects.toMatchObject({ key: 'error.inviteGone' });
  });

  it('keeps the account in step with roles and removals here, and makes the owner’s phone code', async () => {
    const account = fakeAccount();
    const h = host(account);
    await h.unlink();
    // Not linked: no tickets come to undo anything, so there is nothing to tell.
    await h.setMemberRole('acct_member_01', 'admin');
    await h.removeMember('acct_member_01');
    expect(account.members).toEqual([]);
    await expect(h.phoneCode()).rejects.toMatchObject({ key: 'error.serverNotLinked' });
    await h.link(CODE, 'Office');
    await h.setMemberRole('acct_member_01', 'admin');
    await h.removeMember('acct_member_01');
    // Someone the account no longer lists needs nothing.
    await h.removeMember('acct_gone_0001');
    expect(account.members).toEqual([
      { method: 'PATCH', userId: 'acct_member_01', body: { role: 'admin' } },
      { method: 'DELETE', userId: 'acct_member_01', body: null },
      { method: 'DELETE', userId: 'acct_gone_0001', body: null },
    ]);
    expect(await h.phoneCode()).toEqual({
      code: 'ABCDE-FGHJK',
      expiresAt: 99,
      url: 'leafbot://connect?code=ABCDE-FGHJK',
    });
  });

  it('says why the account would not send an invite', async () => {
    const tried = async (error: [number, string]) => {
      const h = host(fakeAccount({ inviteError: error }));
      await h.link(CODE, 'Office');
      return h.invite({ email: 'ann@example.com', role: 'member', lang: 'en' }).catch((e: unknown) => e);
    };
    expect(await tried([409, 'already_member'])).toMatchObject({ key: 'error.personAlreadyLinked' });
    expect(await tried([503, 'mail_unavailable'])).toMatchObject({ key: 'error.inviteMailUnavailable' });
    expect(await tried([400, 'bad_request'])).toMatchObject({ key: 'error.accountEmailInvalid' });
    expect(await tried([429, 'rate_limited'])).toMatchObject({ key: 'error.accountTooManyTries' });
    expect(await tried([500, 'internal'])).toMatchObject({ key: 'error.accountUnreachable' });
  });

  it('lets only the owner link it, and never over the tunnel', async () => {
    const member = await t.person('mira', 'member');
    expect((await member.api('GET', '/api/account-host')).status).toBe(403);
    const owner = await t.api('GET', '/api/account-host');
    expect(owner.status).toBe(200);
    const bad = await t.api<{ error: string }>('POST', '/api/account-host', { code: 'nope' });
    expect(bad.status).toBe(400);
    // The owner, reaching the server through their account, still cannot link or unlink it.
    const res = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          method: 'DELETE',
          path: '/api/account-host',
          headers: { host: 'www.leafbot.app' },
          createConnection: () =>
            connectInProcess(t.app.server, {
              userId: 'owner',
              accountUserId: 'acct_owner',
              sessionId: 'sess_owner',
              connection: 'conn_owner',
            }),
        },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(res).toBe(403);
  });
});
