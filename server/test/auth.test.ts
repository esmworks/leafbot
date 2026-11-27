import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME_EXTENSION_ORIGIN } from '@leafbot/shared';
import { checkHostOrigin, clientAddress, needsSignIn, routedPath, SESSION_IDLE_MS } from '../src/auth';
import { loadConfig, publicUrl } from '../src/config';
import { OWNER_ID } from '../src/users';
import { KEY, testServer, type TestServer } from './helpers';

describe('erişim', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
  });
  afterAll(() => t.dispose());

  const req = (opts: { url?: string; method?: string; headers?: Record<string, string>; payload?: object }) =>
    t.app.inject({
      method: (opts.method ?? 'GET') as 'GET',
      url: opts.url ?? '/api/bots',
      headers: { host: 'localhost', ...opts.headers },
      ...(opts.payload ? { payload: opts.payload } : {}),
    });

  it('anahtarsız /api isteğini reddeder', async () => {
    expect((await req({})).statusCode).toBe(401);
    expect((await req({ headers: { authorization: 'Bearer yanlis' } })).statusCode).toBe(401);
  });

  it('bearer anahtarı kabul eder, sağlık uç noktası açıktır', async () => {
    expect((await req({ headers: { authorization: `Bearer ${KEY}` } })).statusCode).toBe(200);
    expect((await req({ url: '/api/health' })).statusCode).toBe(200);
  });

  it('anahtar yalnızca sunucunun bilgisayarından geçer; şifre ve eşleştirme ile giriş yoktur', async () => {
    const away = { 'x-forwarded-for': '203.0.113.9' };
    expect((await req({ headers: { authorization: `Bearer ${KEY}`, ...away } })).statusCode).toBe(401);
    const access = await req({ method: 'POST', url: '/api/access', payload: { key: KEY }, headers: away });
    expect(access.statusCode).toBe(403);
    expect(access.headers['set-cookie']).toBeUndefined();
    const here = await req({ url: '/api/session' });
    expect(here.json()).toMatchObject({ authenticated: false, local: true });
    expect((await req({ url: '/api/session', headers: away })).json()).toMatchObject({ local: false });
    for (const url of ['/api/login', '/api/pair']) {
      const r = await req({
        method: 'POST',
        url,
        payload: { username: 'a', password: 'b', code: 'ABCD-2345' },
      });
      expect(r.statusCode).toBe(401);
      expect(r.headers['set-cookie']).toBeUndefined();
    }
    expect(
      (await req({ method: 'POST', url: '/api/pairing', headers: { authorization: `Bearer ${KEY}` } }))
        .statusCode,
    ).toBe(404);
    expect((await req({ url: '/api/account', headers: { authorization: `Bearer ${KEY}` } })).statusCode).toBe(
      404,
    );
  });

  it('anahtarı sorgu dizesinde kabul etmez', async () => {
    expect((await req({ url: `/api/bots?token=${KEY}` })).statusCode).toBe(401);
  });

  it('doğru anahtarla HttpOnly SameSite=Strict cookie verir', async () => {
    expect((await req({ method: 'POST', url: '/api/access', payload: { key: 'yanlis' } })).statusCode).toBe(
      401,
    );
    const ok = await req({ method: 'POST', url: '/api/access', payload: { key: KEY } });
    expect(ok.statusCode).toBe(200);
    const setCookie = String(ok.headers['set-cookie']);
    expect(setCookie).toMatch(/leafbot_session=/);
    expect(setCookie).toMatch(/HttpOnly/);
    expect(setCookie).toMatch(/SameSite=Strict/);
    const cookie = setCookie.split(';')[0]!;
    expect((await req({ headers: { cookie } })).statusCode).toBe(200);
    // Cookie writes need an Origin from our own host.
    const noOrigin = await req({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie },
      payload: { name: 'x' },
    });
    expect(noOrigin.statusCode).toBe(403);
    const sameOrigin = await req({
      method: 'POST',
      url: '/api/groups',
      headers: { cookie, origin: 'http://localhost' },
      payload: { name: 'x' },
    });
    expect(sameOrigin.statusCode).toBe(200);
    // Logout ends the session.
    await req({ method: 'POST', url: '/api/logout', headers: { cookie, origin: 'http://localhost' } });
    expect((await req({ headers: { cookie } })).statusCode).toBe(401);
  });

  it('oturum açık cihazları listeler; birini ya da diğerlerinin hepsini kapatır', async () => {
    const signIn = async (ua: string) => {
      const r = await req({
        method: 'POST',
        url: '/api/access',
        payload: { key: KEY },
        headers: { 'user-agent': ua },
      });
      return String(r.headers['set-cookie']).split(';')[0]!;
    };
    const mac = await signIn('Mac Chrome');
    const phone = await signIn('iPhone Safari');
    const tablet = await signIn('iPad Safari');
    const list = async (cookie: string) =>
      (await req({ url: '/api/sessions', headers: { cookie } })).json() as {
        id: string;
        userAgent: string;
        current: boolean;
      }[];
    const seen = await list(mac);
    expect(seen.find((x) => x.current)?.userAgent).toBe('Mac Chrome');
    const phoneId = seen.find((x) => x.userAgent === 'iPhone Safari')!.id;
    const del = (cookie: string, id: string) =>
      req({ method: 'DELETE', url: `/api/sessions/${id}`, headers: { cookie, origin: 'http://localhost' } });
    expect((await del(mac, phoneId)).json()).toEqual({ ended: 1 });
    expect((await req({ headers: { cookie: phone } })).statusCode).toBe(401);
    expect((await del(mac, 'others')).json()).toMatchObject({ ended: expect.any(Number) });
    expect((await req({ headers: { cookie: tablet } })).statusCode).toBe(401);
    expect((await req({ headers: { cookie: mac } })).statusCode).toBe(200);
  });

  it('uzun süre kullanılmayan oturum kapanır, kullanılan oturum uzar', async () => {
    const token = await t.auth.createSession(OWNER_ID, 'test');
    const later = new Date(Date.now() + SESSION_IDLE_MS - 60_000);
    expect(await t.auth.validSession(token, later)).not.toBeNull();
    const muchLater = new Date(later.getTime() + SESSION_IDLE_MS - 120_000);
    expect(await t.auth.validSession(token, muchLater)).not.toBeNull();
    const tooLate = new Date(muchLater.getTime() + SESSION_IDLE_MS + 120_000);
    expect(await t.auth.validSession(token, tooLate)).toBeNull();
    expect(await t.auth.validSession(token, tooLate)).toBeNull();
  });

  it('yabancı Host, yabancı Origin ve Origin: null reddedilir', async () => {
    const auth = { authorization: `Bearer ${KEY}` };
    expect((await req({ headers: { ...auth, host: 'evil.example' } })).statusCode).toBe(403);
    expect((await req({ headers: { ...auth, origin: 'https://evil.example' } })).statusCode).toBe(403);
    expect((await req({ headers: { ...auth, origin: 'null' } })).statusCode).toBe(403);
  });

  // The router undoes percent escapes before matching, so `/%61pi/bots` runs the /api/bots
  // handler; a check on the URL as written once let it through without a sign-in.
  it('yolun başka yazılışları /api uç noktalarına anahtarsız ulaşamaz', async () => {
    const auth = { authorization: `Bearer ${KEY}` };
    for (const url of [
      '/%61pi/bots',
      '/ap%69/bots',
      '/%61%70%69/bots',
      '/api/./bots',
      '//api/bots',
      '/api//bots',
      '/API/bots',
      '/Api/Bots',
      '/%2561pi/bots',
      '/%61pi/nope',
      '/api',
    ]) {
      expect((await req({ url })).statusCode, url).toBe(401);
    }
    expect((await req({ method: 'POST', url: '/ap%69/pairing' })).statusCode).toBe(401);
    expect((await req({ method: 'POST', url: '/%61pi/mcp', payload: {} })).statusCode).toBe(401);
    expect((await req({ url: '/%61pi/sessions' })).statusCode).toBe(401);
    // Signed in, the same spellings still reach the handler.
    expect((await req({ url: '/%61pi/bots', headers: auth })).statusCode).toBe(200);
  });

  it('açık uç noktalar her yazılışla açık kalır; webhook ve posta kendi sırrını ister', async () => {
    expect((await req({ url: '/api/health' })).statusCode).toBe(200);
    expect((await req({ url: '/%61pi/health' })).statusCode).toBe(200);
    expect((await req({ url: '/api/session' })).json()).toMatchObject({ authenticated: false });
    // No access key, but each checks its own secret.
    const hook = await req({ method: 'POST', url: '/api/hooks/routines/yok/yanlis', payload: { a: 1 } });
    expect(hook.statusCode).toBe(404);
    const mail = await t.app.inject({
      method: 'POST',
      url: '/api/email/inbound?to=a@b.c',
      headers: { host: 'localhost', 'content-type': 'message/rfc822' },
      payload: 'Subject: x\r\n\r\ny',
    });
    expect(mail.statusCode).toBe(401);
  });
});

describe('oturum gerektiren yollar', () => {
  const open = (route: string) => route === '/api/health' || route.startsWith('/api/hooks/routines/');
  it('yolu yönlendiricinin okuduğu gibi çözer', () => {
    expect(routedPath('/%61pi/bots?x=1')).toBe('/api/bots');
    expect(routedPath('//API/./x/../bots/')).toBe('/api/bots');
    expect(routedPath('/%2561pi/bots')).toBe('/api/bots');
    expect(routedPath('/ap%i/x')).toBe('/ap%i/x');
    expect(routedPath('/a\\..\\api\\bots')).toBe('/api/bots');
  });

  it('eşleşen rotaya göre karar verir; rotası olmayan /api isteği oturum ister', () => {
    expect(needsSignIn('/api/bots', '/%61pi/bots', open)).toBe(true);
    expect(needsSignIn('/api/health', '/%61pi/health', open)).toBe(false);
    expect(needsSignIn('/api/hooks/routines/:id/:token', '/api/hooks/routines/a/b', open)).toBe(false);
    expect(needsSignIn('/p/:token', '/p/abc', open)).toBe(false);
    expect(needsSignIn(undefined, '/%61pi/nope', open)).toBe(true);
    expect(needsSignIn(undefined, '/nope', open)).toBe(false);
    // A catch-all (the app's files) does not decide on its own.
    expect(needsSignIn('/*', '/API/bots', open)).toBe(true);
    expect(needsSignIn('/*', '/settings', open)).toBe(false);
  });
});

describe('uygulama dosyaları sunulurken', () => {
  let t: TestServer;
  beforeAll(async () => {
    const appDir = mkdtempSync(join(tmpdir(), 'leafbot-app-'));
    writeFileSync(join(appDir, 'index.html'), '<!doctype html><title>app</title><div id="root"></div>');
    t = await testServer({ appDir });
  });
  afterAll(() => t.dispose());

  const get = (url: string, headers: Record<string, string> = {}) =>
    t.app.inject({ method: 'GET', url, headers: { host: 'localhost', ...headers } });

  it('API yolunun hiçbir yazılışı sayfaya ya da anahtarsız yanıta düşmez', async () => {
    expect((await get('/settings')).statusCode).toBe(200);
    expect((await get('/settings')).body).toContain('<title>app</title>');
    for (const url of ['/%61pi/bots', '/API/bots', '//api/bots', '/api/nope', '/%61pi/nope']) {
      expect((await get(url)).statusCode, url).toBe(401);
    }
    // Signed in, an unknown API path is a 404, not the app's page.
    const missing = await get('/%61pi/nope', { authorization: `Bearer ${KEY}` });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain('<title>app</title>');
  });
});

describe('checkHostOrigin', () => {
  const config = loadConfig(
    {},
    { allowedHosts: ['leafbot.example.com'], allowedOrigins: ['https://app.example.com'] },
  );
  const check = (host: string | undefined, origin?: string) =>
    checkHostOrigin({ host, origin, method: 'GET' }, config);
  it('loopback ve izinli adlar', () => {
    expect(check('localhost:4319')).toBeNull();
    expect(check('127.0.0.1:4319')).toBeNull();
    expect(check('[::1]:4319')).toBeNull();
    expect(check('leafbot.example.com')).toBeNull();
    expect(check('leafbot.example.com', 'https://leafbot.example.com')).toBeNull();
    expect(check('leafbot.example.com', 'https://app.example.com')).toBeNull();
  });
  it('rebinding ve yabancı kaynaklar', () => {
    expect(check(undefined)).not.toBeNull();
    expect(check('attacker.com')).not.toBeNull();
    expect(check('localhost', 'https://attacker.com')).not.toBeNull();
    expect(check('localhost', 'null')).not.toBeNull();
  });
  it('uzantı sunucuya adresinden değil tünelden ulaşır', () => {
    expect(check('localhost:4319', CHROME_EXTENSION_ORIGIN)).not.toBeNull();
    expect(check('localhost:4319', 'chrome-extension://abcdefghijklmnopabcdefghijklmnop')).not.toBeNull();
  });
});

describe('genel adres', () => {
  it('LEAFBOT_PUBLIC_URL köke indirgenir, geçersizi yok sayılır', () => {
    expect(publicUrl('https://leafbot.example.com/')).toBe('https://leafbot.example.com');
    expect(publicUrl(' https://ornek.com:8443/leafbot/ ')).toBe('https://ornek.com:8443/leafbot');
    expect(publicUrl('')).toBeNull();
    expect(publicUrl('ftp://ornek.com')).toBeNull();
    expect(publicUrl('ornek.com')).toBeNull();
  });
  it('genel adresin ana bilgisayar adı izinli sayılır', () => {
    const config = loadConfig({ LEAFBOT_PUBLIC_URL: 'https://leafbot.example.com' });
    expect(
      checkHostOrigin({ host: 'leafbot.example.com', origin: undefined, method: 'GET' }, config),
    ).toBeNull();
    expect(
      checkHostOrigin({ host: 'baska.example.com', origin: undefined, method: 'GET' }, config),
    ).not.toBeNull();
  });
});

describe('ters vekil arkasında', () => {
  const config = { proxySecret: 'vekil-sirri-0123456789' };
  it('X-Forwarded-For yalnızca vekilin sırrıyla gelen istekte okunur', () => {
    const forwarded = { 'x-forwarded-for': '198.51.100.7, 203.0.113.1' };
    expect(clientAddress({ ...forwarded, 'x-leafbot-proxy': config.proxySecret }, '172.18.0.1', config)).toBe(
      '203.0.113.1',
    );
    expect(clientAddress(forwarded, '172.18.0.1', config)).toBe('172.18.0.1');
    expect(clientAddress({ ...forwarded, 'x-leafbot-proxy': 'yanlis' }, '172.18.0.1', config)).toBe(
      '172.18.0.1',
    );
    expect(
      clientAddress({ ...forwarded, 'x-leafbot-proxy': config.proxySecret }, '172.18.0.1', {
        proxySecret: null,
      }),
    ).toBe('172.18.0.1');
    expect(clientAddress({ 'x-leafbot-proxy': config.proxySecret }, '172.18.0.1', config)).toBe('172.18.0.1');
  });

  it('yeniden adlandırmadan önce kurulmuş vekilin başlığını da okur', () => {
    const forwarded = { 'x-forwarded-for': '198.51.100.7' };
    expect(
      clientAddress({ ...forwarded, 'x-yumakbot-proxy': config.proxySecret }, '172.18.0.1', config),
    ).toBe('198.51.100.7');
  });

  // Behind Caddy every request arrives from this computer; only the proxy's word tells where it came
  // from, and the key works only for one that came from here.
  it('vekilin arkasında anahtar yalnızca bu bilgisayardan gelen isteğe geçer', async () => {
    const t = await testServer(config);
    try {
      const through = (from: string) =>
        t.app.inject({
          method: 'GET',
          url: '/api/bots',
          headers: {
            host: 'localhost',
            authorization: `Bearer ${KEY}`,
            'x-forwarded-for': from,
            'x-leafbot-proxy': config.proxySecret,
          },
        });
      expect((await through('203.0.113.1')).statusCode).toBe(401);
      expect((await through('127.0.0.1')).statusCode).toBe(200);
    } finally {
      await t.dispose();
    }
  });
});
