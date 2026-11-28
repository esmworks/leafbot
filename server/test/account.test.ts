import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addressGroup,
  FAILURE_WINDOW_MS,
  GLOBAL_FREE_FAILURES,
  GLOBAL_MAX_PAUSE_MS,
  GLOBAL_PAUSE_MS,
  GLOBAL_WINDOW_MS,
  LoginThrottle,
  MAX_FAILURES,
} from '../src/account';
import { KEY, testServer, type TestServer } from './helpers';

describe('LoginThrottle', () => {
  it('çok sayıda yanlış denemeden sonra pencere geçene kadar bekletir', () => {
    const c = { at: 0 };
    const throttle = new LoginThrottle(() => c.at);
    for (let i = 0; i < MAX_FAILURES; i++) expect(throttle.attempt('1.2.3.4')).not.toBeNull();
    expect(throttle.attempt('1.2.3.4')).toBeNull();
    expect(throttle.attempt('5.6.7.8')).not.toBeNull();
    c.at += FAILURE_WINDOW_MS + 1;
    // A right try hands its count back, and the address starts over.
    throttle.attempt('1.2.3.4')!.succeeded();
    for (let i = 0; i < MAX_FAILURES; i++) expect(throttle.attempt('1.2.3.4')).not.toBeNull();
    expect(throttle.attempt('1.2.3.4')).toBeNull();
  });

  it('bir IPv6 /64 ağındaki adresler tek adres sayılır', () => {
    expect(addressGroup('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:0db8:0001:0002:ffff:ffff:ffff:ffff')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:db8::5')).toBe('2001:db8:0:0::/64');
    expect(addressGroup('::1')).toBe('0:0:0:0::/64');
    expect(addressGroup('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(addressGroup('203.0.113.9')).toBe('203.0.113.9');
    const throttle = new LoginThrottle(() => 0);
    for (let i = 0; i < MAX_FAILURES; i++) expect(throttle.attempt(`2001:db8:1:2::${i + 1}`)).not.toBeNull();
    expect(throttle.attempt('2001:db8:1:2:dead:beef:0:1')).toBeNull();
    expect(throttle.attempt('2001:db8:1:3::1')).not.toBeNull();
  });

  // Each new address gets MAX_FAILURES tries of its own; without a ceiling across all of them, a
  // guesser with many addresses would get unlimited tries.
  it('adres değiştirmek sınırsız deneme kazandırmaz; tavan yalnızca yavaşlatır', () => {
    const c = { at: 0 };
    const throttle = new LoginThrottle(() => c.at);
    let n = 0;
    const fresh = () => `198.51.${Math.floor(n / 250)}.${(n++ % 250) + 1}`;
    for (let i = 0; i < GLOBAL_FREE_FAILURES; i++) expect(throttle.attempt(fresh())).not.toBeNull();
    // Past the ceiling the next try waits for the pause, and one goes through after it.
    expect(throttle.attempt(fresh())).toBeNull();
    c.at += GLOBAL_PAUSE_MS - 1;
    expect(throttle.attempt(fresh())).toBeNull();
    c.at += 1;
    expect(throttle.attempt(fresh())).not.toBeNull();
    expect(throttle.attempt(fresh())).toBeNull();
    // The pause grows as failures go on, up to its longest.
    for (let i = 0; i < 100; i++) {
      c.at += GLOBAL_MAX_PAUSE_MS;
      expect(throttle.attempt(fresh())).not.toBeNull();
    }
    const last = c.at;
    c.at += GLOBAL_MAX_PAUSE_MS - 1;
    expect(throttle.attempt(fresh())).toBeNull();
    // A check that is not counted across addresses (the access key) is not slowed by it.
    expect(throttle.attempt(fresh(), { shared: false })).not.toBeNull();
    // Once the failures leave the window, tries are free again.
    c.at = last + GLOBAL_WINDOW_MS + GLOBAL_MAX_PAUSE_MS * 3;
    expect(throttle.attempt(fresh())).not.toBeNull();
    expect(throttle.attempt(fresh())).not.toBeNull();
  });
});

describe('erişim anahtarı', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
  });
  afterAll(() => t.dispose());

  const access = (key: string, from: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/access',
      remoteAddress: from,
      headers: { host: 'localhost' },
      payload: { key },
    });
  const bearer = (key: string, from: string) =>
    t.app.inject({
      method: 'GET',
      url: '/api/bots',
      remoteAddress: from,
      headers: { host: 'localhost', authorization: `Bearer ${key}` },
    });

  it('başka bir adresten, doğru olsa da, geçmez', async () => {
    expect((await access(KEY, '192.0.2.20')).statusCode).toBe(403);
    expect((await bearer(KEY, '192.0.2.20')).statusCode).toBe(401);
    expect((await access(KEY, '::ffff:192.0.2.20')).statusCode).toBe(403);
    expect((await access(KEY, '::1')).statusCode).toBe(200);
    expect((await access(KEY, '::ffff:127.0.0.1')).statusCode).toBe(200);
  });

  it('erişim anahtarı ve Bearer denemeleri adres başına sınırlanır', async () => {
    for (let i = 0; i < MAX_FAILURES; i++)
      expect((await access('yanlis', '127.0.0.20')).statusCode).toBe(401);
    expect((await access(KEY, '127.0.0.20')).statusCode).toBe(429);
    expect((await access(KEY, '127.0.0.21')).statusCode).toBe(200);
    for (let i = 0; i < MAX_FAILURES; i++)
      expect((await bearer('yanlis', '127.0.0.30')).statusCode).toBe(401);
    expect((await bearer(KEY, '127.0.0.30')).statusCode).toBe(429);
    // A right key does not use up an address's tries.
    for (let i = 0; i < MAX_FAILURES * 2; i++) expect((await bearer(KEY, '127.0.0.31')).statusCode).toBe(200);
  });
});
