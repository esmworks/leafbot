import { describe, expect, it } from 'vitest';
import { AccountError, accountClient, pickServer, type ServerEntry } from './account';

interface Seen {
  url: string;
  init: RequestInit;
}

/** A client over a fake service that answers every call with this status and body. */
function client(status: number, body: unknown, token: string | null = 'tok') {
  const seen: Seen[] = [];
  const fake = (async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    // A 204 has no body at all.
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    return new Response(status === 204 ? null : text, { status });
  }) as unknown as typeof fetch;
  return { seen, api: accountClient({ fetch: fake, token: () => token, base: 'https://acct.test' }) };
}

const server = (id: string): ServerEntry => ({
  id,
  name: id,
  role: 'owner',
  publicKey: 'k',
  seenAt: 0,
});

describe('accountClient', () => {
  it('spends a code without a token and gives the session back', async () => {
    const out = { user: { id: 'u', email: 'a@b.c', name: null }, sessionId: 's', token: 'secret' };
    const { seen, api } = client(200, out, null);
    expect(await api.redeem('ABCDE-FGHJK')).toEqual(out);
    expect(seen[0]!.url).toBe('https://acct.test/v1/connect-codes/redeem');
    expect(seen[0]!.init.body).toBe('{"code":"ABCDE-FGHJK"}');
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBeUndefined();
  });

  it('sends the verifier with a code the phone asked for through the website', async () => {
    const out = { user: { id: 'u', email: 'a@b.c', name: null }, sessionId: 's', token: 'secret' };
    const { seen, api } = client(200, out, null);
    await api.redeem('ABCDE-FGHJK', 'v'.repeat(43));
    expect(seen[0]!.init.body).toBe(`{"code":"ABCDE-FGHJK","verifier":"${'v'.repeat(43)}"}`);
  });

  it('lists servers with the bearer token', async () => {
    const { seen, api } = client(200, { servers: [server('a')] });
    expect(await api.servers()).toEqual([server('a')]);
    expect((seen[0]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('asks for a ticket bound to the device key', async () => {
    const { seen, api } = client(200, { ticket: 't', publicKey: 'k', expiresAt: 1 });
    await api.ticket('a/b', 'jkt1');
    expect(seen[0]!.url).toBe('https://acct.test/v1/servers/a%2Fb/ticket');
    expect(seen[0]!.init.body).toBe('{"jkt":"jkt1"}');
  });

  it('signs out on a no-content answer', async () => {
    const { seen, api } = client(204, '');
    await expect(api.signOut()).resolves.toBeUndefined();
    expect(seen[0]!.url).toBe('https://acct.test/v1/auth/signout');
  });

  it("keeps the service's own code on a refusal", async () => {
    const { api } = client(400, { error: 'invalid_code' }, null);
    await expect(api.redeem('ABCDE-FGHJK')).rejects.toMatchObject({ status: 400, code: 'invalid_code' });
  });

  it('does not call when signed out, and says unreachable when no answer comes', async () => {
    const { seen, api } = client(200, {}, null);
    await expect(api.servers()).rejects.toMatchObject({ status: 401 });
    expect(seen).toHaveLength(0);
    const down = accountClient({
      fetch: (() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch,
      token: () => 'tok',
    });
    const err = await down.servers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ status: 0, code: 'unreachable' });
  });
});

describe('pickServer', () => {
  it('keeps the chosen one, takes the only one, and leaves several to the person', () => {
    expect(pickServer([server('a'), server('b')], 'b')?.id).toBe('b');
    expect(pickServer([server('a')], null)?.id).toBe('a');
    expect(pickServer([server('a')], 'gone')?.id).toBe('a');
    expect(pickServer([server('a'), server('b')], 'gone')).toBeNull();
    expect(pickServer([], null)).toBeNull();
  });
});
