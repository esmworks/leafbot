import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  accountClient,
  AccountError,
  codeOfConnectLink,
  connectPageUrl,
  isConnectLink,
  newPkce,
} from './account';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

const BASE = 'https://accounts.example';

/** Stands in for the account service: keeps what it was sent, answers from `reply`. */
function service(reply: (c: Call) => { status?: number; body: unknown }) {
  const calls: Call[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(c);
    const r = reply(c);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe('hesap hizmeti', () => {
  it('sunucuları uygulamanın kendi oturumuyla, bearer token ile listeler', async () => {
    const { calls, fetchFn } = service(() => ({
      body: { servers: [{ id: 's1', name: 'Ofis', role: 'owner', publicKey: 'k', seenAt: 1 }] },
    }));
    const api = accountClient({ base: BASE, fetch: fetchFn, token: () => 'tok' });
    expect((await api.servers()).map((s) => s.id)).toEqual(['s1']);
    expect(calls[0]!.url).toBe(`${BASE}/v1/servers`);
    expect(calls[0]!.headers.authorization).toBe('Bearer tok');
    expect(calls[0]!.headers.cookie).toBeUndefined();
  });

  it('bileti sunucu kimliğini kaçışlayarak ve cihaz parmak iziyle ister', async () => {
    const { calls, fetchFn } = service(() => ({ body: { ticket: 't', publicKey: 'k', expiresAt: 9 } }));
    const api = accountClient({ base: BASE, fetch: fetchFn, token: () => 'tok' });
    expect((await api.ticket('s 1', 'jkt1')).ticket).toBe('t');
    expect(`${calls[0]!.method} ${calls[0]!.url}`).toBe(`POST ${BASE}/v1/servers/s%201/ticket`);
    expect(calls[0]!.body).toEqual({ jkt: 'jkt1' });
  });

  it('kodu doğrulayıcıyla ve oturumsuz harcar', async () => {
    const { calls, fetchFn } = service(() => ({ body: { user: { id: 'u' }, sessionId: 's', token: 'new' } }));
    const api = accountClient({ base: BASE, fetch: fetchFn, token: () => null });
    expect((await api.redeem('ABCDE-FGHJK', 'ver')).token).toBe('new');
    expect(calls[0]!.url).toBe(`${BASE}/v1/connect-codes/redeem`);
    expect(calls[0]!.body).toEqual({ code: 'ABCDE-FGHJK', verifier: 'ver' });
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it('oturum yoksa istek göndermeden 401 verir', async () => {
    const { calls, fetchFn } = service(() => ({ body: {} }));
    const api = accountClient({ base: BASE, fetch: fetchFn, token: () => null });
    await expect(api.servers()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(calls).toHaveLength(0);
  });

  it('hizmetin hata kodunu ve ağ hatasını ayırır', async () => {
    const down = accountClient({
      base: BASE,
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      token: () => 'tok',
    });
    await expect(down.servers()).rejects.toMatchObject({ status: 0, code: 'unreachable' });
    const { fetchFn } = service(() => ({ status: 403, body: { error: 'forbidden' } }));
    const refused = accountClient({ base: BASE, fetch: fetchFn, token: () => 'tok' });
    const err = await refused.servers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden' });
  });
});

describe('tarayıcıda giriş', () => {
  it('PKCE challenge doğrulayıcının SHA-256 özetidir', () => {
    const { verifier, challenge } = newPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash('sha256').update(verifier).digest('base64url'));
    expect(newPkce().verifier).not.toBe(verifier);
  });

  it('giriş sayfası dile göre açılır', () => {
    expect(connectPageUrl('tr', 'a+b', 'https://w.example')).toBe(
      'https://w.example/tr/connect?challenge=a%2Bb',
    );
    expect(connectPageUrl('en', 'c', 'https://w.example')).toBe('https://w.example/connect?challenge=c');
  });

  it('dönüş bağlantısından kodu alır, başka bağlantıyı almaz', () => {
    expect(codeOfConnectLink('leafbot://connect?code=abcde-fghjk')).toBe('ABCDE-FGHJK');
    expect(codeOfConnectLink('leafbot://connect/?code=ABCDEFGHJK')).toBe('ABCDE-FGHJK');
    expect(codeOfConnectLink('leafbot://connect?code=nope')).toBeNull();
    expect(codeOfConnectLink('leafbot://thread/x?code=ABCDEFGHJK')).toBeNull();
    expect(codeOfConnectLink('https://connect?code=ABCDEFGHJK')).toBeNull();
    expect(isConnectLink('leafbot://connect?code=x')).toBe(true);
    expect(isConnectLink('leafbot://thread/1')).toBe(false);
  });
});
