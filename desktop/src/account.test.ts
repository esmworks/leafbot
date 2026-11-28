import { describe, expect, it } from 'vitest';
import { accountClient, accountUrl, AccountError, WEBSITE } from './account';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

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

const COOKIE = '__Host-leafbot_session=abc';

describe('hesap hizmeti', () => {
  it('oturum çerezi ve site adresiyle sunucuları listeler', async () => {
    const { calls, fetchFn } = service(() => ({
      body: { servers: [{ id: 's1', name: 'Ofis', role: 'owner', publicKey: 'k', seenAt: 1 }] },
    }));
    const api = accountClient({ fetch: fetchFn, cookie: async () => COOKIE });
    const servers = await api.servers();
    expect(servers.map((s) => s.id)).toEqual(['s1']);
    expect(calls[0]!.url).toBe(`${WEBSITE}/api/v1/servers`);
    expect(calls[0]!.headers.cookie).toBe(COOKIE);
  });

  it('bilet isterken önce CSRF jetonunu alır, sonra çerez, jeton ve origin ile yazar', async () => {
    const { calls, fetchFn } = service((c) =>
      c.url.endsWith('/session')
        ? { body: { user: { id: 'u' }, csrf: 'tok' } }
        : { body: { ticket: 't', publicKey: 'k', expiresAt: 9 } },
    );
    const api = accountClient({ fetch: fetchFn, cookie: async () => COOKIE });
    expect((await api.ticket('s 1', 'jkt1')).ticket).toBe('t');
    expect(calls.map((c) => `${c.method} ${c.url.replace(WEBSITE, '')}`)).toEqual([
      'GET /api/v1/session',
      'POST /api/v1/servers/s%201/ticket',
    ]);
    const post = calls[1]!;
    expect(post.headers).toMatchObject({ cookie: COOKIE, 'x-leafbot-csrf': 'tok', origin: WEBSITE });
    expect(post.body).toEqual({ jkt: 'jkt1' });
    // The token follows from the cookie: a second ticket does not ask for it again.
    await api.ticket('s 1', 'jkt1');
    expect(calls).toHaveLength(3);
  });

  it('çerez değişince jeton yeniden alınır', async () => {
    const { calls, fetchFn } = service((c) =>
      c.url.endsWith('/session')
        ? { body: { csrf: `tok-${c.headers.cookie}` } }
        : { body: { ticket: 't', publicKey: 'k', expiresAt: 9 } },
    );
    let cookie = 'a=1';
    const api = accountClient({ fetch: fetchFn, cookie: async () => cookie });
    await api.ticket('s', 'j');
    cookie = 'a=2';
    await api.ticket('s', 'j');
    expect(calls.filter((c) => c.url.endsWith('/session'))).toHaveLength(2);
    expect(calls[3]!.headers['x-leafbot-csrf']).toBe('tok-a=2');
  });

  it('çıkış yapılmışsa istek göndermeden 401 verir', async () => {
    const { calls, fetchFn } = service(() => ({ body: {} }));
    const api = accountClient({ fetch: fetchFn, cookie: async () => null });
    await expect(api.servers()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });
    expect(calls).toHaveLength(0);
  });

  it('hizmetin hata kodunu ve ağ hatasını ayırır', async () => {
    const down = accountClient({
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof fetch,
      cookie: async () => COOKIE,
    });
    await expect(down.servers()).rejects.toMatchObject({ status: 0, code: 'unreachable' });
    const { fetchFn } = service(() => ({ status: 403, body: { error: 'forbidden' } }));
    const refused = accountClient({ fetch: fetchFn, cookie: async () => COOKIE });
    const err = await refused.servers().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AccountError);
    expect(err).toMatchObject({ status: 403, code: 'forbidden' });
  });

  it('pencere adresi seçilen sunucuyu söyler', () => {
    expect(accountUrl(null)).toBe('https://www.leafbot.app/bots/');
    expect(accountUrl('s&1')).toBe('https://www.leafbot.app/bots/?server=s%261');
  });
});
