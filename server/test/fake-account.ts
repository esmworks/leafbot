// The account service as the sign-in tests stand it in: the app's sign-in and `leafbot login`.

export const ISSUER = 'https://accounts.example';
export const CODE = 'ABCDE-FGHJK-LMNPQ-RSTUV';

/** The account service's routes the app's sign-in uses, with what each was sent. */
export function fakeAccount(
  opts: { name?: string; mailDown?: boolean; down?: boolean; hostTaken?: boolean } = {},
) {
  const calls: { path: string; body: Record<string, unknown> | null; auth: string | null }[] = [];
  let name = opts.name ?? '';
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
        ? json(200, { user: user(), sessionId: 'sess_00000001', token: 'desk-token-0000000000000000' })
        : json(400, { error: 'invalid_code' });
    if (path === '/v1/servers/install-codes') return json(201, { code: CODE, expiresAt: 0 });
    if (path === '/v1/host/claim')
      return opts.hostTaken
        ? json(409, { error: 'host_taken' })
        : json(201, { hostId: body?.hostId, machineToken: 'mt_secret', credentialId: 'cred_1' });
    if (path === '/v1/me') {
      name = String(body?.name ?? '');
      return json(200, { user: user() });
    }
    if (path === '/v1/auth/signout') return json(204, null);
    return json(404, { error: 'not_found' });
  }) as typeof fetch;
  return { fetcher, calls };
}

/** A ticket's claims for the account that owns the server there. */
export function ownerClaims(sub: string) {
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
