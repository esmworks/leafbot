import { request } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectInProcess } from '../src/tunnel/identity';
import { AccountHost } from '../src/tunnel/host';
import { AccountLinks } from '../src/tunnel/links';
import { AccountSignIn, cleanName } from '../src/tunnel/signin';
import { OWNER_ID } from '../src/users';
import { testServer, type TestServer } from './helpers';

const ISSUER = 'https://accounts.example';
const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';

/** The account service's routes the app's sign-in uses, with what each was sent. */
function fakeAccount(opts: { name?: string; mailDown?: boolean; down?: boolean } = {}) {
  const calls: { path: string; body: Record<string, unknown> | null; auth: string | null }[] = [];
  let name = opts.name ?? '';
  let signIns = 0;
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    if (opts.down) throw new TypeError('fetch failed');
    const path = String(input).slice(ISSUER.length);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
    const auth = new Headers(init?.headers).get('authorization');
    calls.push({ path, body, auth });
    const json = (status: number, b: unknown) =>
      new Response(b === null ? null : JSON.stringify(b), {
        status,
        headers: b === null ? {} : { 'content-type': 'application/json' },
      });
    const user = () => ({ id: 'acct_ada00001', email: 'ada@example.com', name });
    if (path === '/v1/auth/email/start')
      return opts.mailDown ? json(503, { error: 'mail_unavailable' }) : json(204, null);
    if (path === '/v1/auth/email/verify')
      return body?.code === '123456' && body.client === 'desktop'
        ? json(200, {
            user: user(),
            sessionId: 'sess_00000001',
            token: `desk-token-${String(signIns++).padStart(16, '0')}`,
          })
        : json(400, { error: 'invalid_code' });
    if (path === '/v1/servers/install-codes') return json(201, { code: CODE, expiresAt: 0 });
    if (path === '/v1/host/claim')
      return json(201, { hostId: body?.hostId, machineToken: 'mt_secret', credentialId: 'cred_1' });
    if (path === '/v1/me') {
      name = String(body?.name ?? '');
      return json(200, { user: user() });
    }
    if (path === '/v1/auth/signout') return json(204, null);
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return { fetcher, calls };
}

describe('signing the owner in to their account from the app', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
    await t.app.ready();
  });
  afterAll(async () => {
    await t.dispose();
  });

  const signIn = (account: ReturnType<typeof fakeAccount>, now?: () => number) => {
    const host = new AccountHost({
      db: t.services.ctx.db,
      vault: t.services.vault,
      server: t.app.server,
      config: { issuer: ISSUER, relayUrl: 'ws://127.0.0.1:9/v1/signal', webHost: 'www.leafbot.app' },
      rtc: null,
      fetcher: account.fetcher,
    });
    const links = new AccountLinks(t.services.ctx.db);
    return {
      host,
      links,
      signIn: new AccountSignIn({ issuer: ISSUER, host, links, fetcher: account.fetcher, now }),
    };
  };

  it('mails the code in the app’s language and says why it could not', async () => {
    const account = fakeAccount();
    await signIn(account).signIn.start('ada@example.com', 'tr');
    expect(account.calls[0]).toMatchObject({
      path: '/v1/auth/email/start',
      body: { email: 'ada@example.com' },
    });
    await expect(
      signIn(fakeAccount({ mailDown: true })).signIn.start('ada@example.com', 'en'),
    ).rejects.toThrow(/sent right now|gönderilemiyor/);
    await expect(
      signIn(fakeAccount({ down: true })).signIn.start('ada@example.com', 'en'),
    ).rejects.toMatchObject({
      status: 502,
      key: 'error.accountUnreachable',
    });
  });

  it('refuses a wrong code without linking anything', async () => {
    const account = fakeAccount();
    const s = signIn(account);
    await expect(s.signIn.verify('ada@example.com', '000000')).rejects.toMatchObject({ status: 400 });
    expect(account.calls.map((c) => c.path)).toEqual(['/v1/auth/email/verify']);
  });

  it('links the server with an install code, makes the account its owner and takes its name', async () => {
    const account = fakeAccount({ name: 'Ada Lovelace' });
    const s = signIn(account);
    await t.services.settings.update({ userName: '' }, OWNER_ID);
    const done = await s.signIn.verify('ada@example.com', '123456');
    expect(done).toMatchObject({ email: 'ada@example.com', name: 'Ada Lovelace', needsName: false });
    expect(done.host.linked).toBe(true);
    expect(account.calls.map((c) => c.path)).toEqual([
      '/v1/auth/email/verify',
      '/v1/servers/install-codes',
      '/v1/host/claim',
      '/v1/auth/signout',
    ]);
    expect(account.calls[1]?.auth).toBe('Bearer desk-token-0000000000000000');
    expect(await s.links.resolve(ownerClaims('acct_ada00001'))).toEqual({ userId: OWNER_ID });
    expect((await t.services.settings.all(OWNER_ID)).userName).toBe('Ada Lovelace');
  });

  it('keeps the sign-in until the name is given, then saves it to the account and here', async () => {
    const account = fakeAccount();
    const s = signIn(account);
    const done = await s.signIn.verify('ada@example.com', '123456');
    expect(done.needsName).toBe(true);
    expect(account.calls.some((c) => c.path === '/v1/auth/signout')).toBe(false);
    const saved = await s.signIn.setName('  Ada   Byron ');
    expect(saved).toEqual({ name: 'Ada Byron', savedToAccount: true });
    expect(account.calls.slice(-2)).toEqual([
      { path: '/v1/me', body: { name: 'Ada Byron' }, auth: 'Bearer desk-token-0000000000000000' },
      { path: '/v1/auth/signout', body: null, auth: 'Bearer desk-token-0000000000000000' },
    ]);
    expect((await t.services.settings.all(OWNER_ID)).userName).toBe('Ada Byron');
  });

  it('keeps a name here only when no sign-in waits for it, and refuses an unusable one', async () => {
    const s = signIn(fakeAccount());
    expect(await s.signIn.setName('Ada')).toEqual({ name: 'Ada', savedToAccount: false });
    await expect(s.signIn.setName('   ')).rejects.toMatchObject({ status: 400 });
    expect(cleanName('A​da\n Lovelace')).toBe('Ada Lovelace');
    // A space on each side of a removed character leaves one, not two.
    expect(cleanName('Ada \u200b Lovelace')).toBe('Ada Lovelace');
    expect(cleanName('x'.repeat(81))).toBeNull();
    // The joiners Persian and Hindi names need stay.
    expect(cleanName('می\u200cخواهم')).toBe('می\u200cخواهم');
  });

  it('ends a sign-in that waited too long for the name, or that a newer one replaced', async () => {
    let now = 1_000_000;
    const account = fakeAccount();
    const s = signIn(account, () => now);
    await s.signIn.verify('ada@example.com', '123456');
    await s.signIn.verify('ada@example.com', '123456');
    const signouts = () => account.calls.filter((c) => c.path === '/v1/auth/signout').map((c) => c.auth);
    expect(signouts()).toEqual(['Bearer desk-token-0000000000000000']);
    now += 31 * 60_000;
    expect(await s.signIn.setName('Ada')).toEqual({ name: 'Ada', savedToAccount: false });
    expect(account.calls.some((c) => c.path === '/v1/me')).toBe(false);
    expect(signouts()).toEqual(['Bearer desk-token-0000000000000000', 'Bearer desk-token-0000000000000001']);
  });

  it('lets the server go again and ends the sign-in when the owner cannot be linked here', async () => {
    const account = fakeAccount({ name: 'Ada Lovelace' });
    const s = signIn(account);
    s.links.linkOwner = async () => {
      throw new Error('disk full');
    };
    await expect(s.signIn.verify('ada@example.com', '123456')).rejects.toThrow('disk full');
    expect(account.calls.at(-1)).toMatchObject({ path: '/v1/auth/signout' });
    expect((await s.host.state()).linked).toBe(false);
  });

  it('lets only the owner sign the server in', async () => {
    const member = await t.person('mira2', 'member');
    for (const path of ['/api/account-host/email', '/api/account-host/verify', '/api/account-host/name'])
      expect((await member.api('POST', path, {})).status).toBe(403);
  });

  it('refuses the sign-in over the tunnel, even to the owner', async () => {
    for (const path of ['/api/account-host/email', '/api/account-host/verify', '/api/account-host/name']) {
      const res = await new Promise<{ status: number; body: string }>((resolve, reject) => {
        const req = request(
          {
            method: 'POST',
            path,
            headers: { host: 'www.leafbot.app', 'content-type': 'application/json', 'accept-language': 'en' },
            createConnection: () =>
              connectInProcess(t.app.server, {
                userId: 'owner',
                accountUserId: 'acct_owner',
                sessionId: 'sess_owner',
                connection: 'conn_owner',
              }),
          },
          (r) => {
            let body = '';
            r.setEncoding('utf8');
            r.on('data', (c: string) => (body += c));
            r.on('end', () => resolve({ status: r.statusCode ?? 0, body }));
          },
        );
        req.on('error', reject);
        req.end('{}');
      });
      // Refused as a sign-in that has no place over the tunnel, not for a missing header.
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body)).toEqual({
        error: 'This way of signing in is not used while connected through your account',
      });
    }
  });
});

function ownerClaims(sub: string) {
  return {
    iss: ISSUER,
    aud: 'host_12345678',
    sub,
    kind: 'client' as const,
    sid: 'sess_12345678',
    jti: 'jti_12345678',
    iat: 0,
    exp: 60,
    role: 'owner' as const,
    mid: 'mem_12345678',
    epoch: 0,
  };
}
