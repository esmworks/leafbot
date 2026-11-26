import { describe, expect, it } from 'vitest';
import { LABEL, NameFailure, isPublicIpv4, randomLabel } from '../src/service';
import { handle, service, type Env } from '../src/worker';
import { fakeCloudflare, sqliteD1 } from './fakes';

const DAY = 24 * 60 * 60 * 1000;
const IP = '93.184.216.34';
const OTHER_IP = '93.184.216.35';

function setup(vars: Partial<Env> = {}) {
  const cf = fakeCloudflare();
  const clock = { now: Date.UTC(2026, 10, 26) };
  const env: Env = {
    DB: sqliteD1(),
    CF_API_TOKEN: cf.token,
    ZONE_ID: cf.zoneId,
    DOMAIN: 'leafbot.cloud',
    ...vars,
  };
  const names = service(env, cf.fetcher, () => clock.now);
  const call = (method: string, path: string, ip = IP, token?: string) =>
    handle(
      new Request(`https://names.leafbot.app${path}`, {
        method,
        headers: { 'cf-connecting-ip': ip, ...(token ? { authorization: `Bearer ${token}` } : {}) },
      }),
      names,
    );
  return { cf, clock, env, names, call };
}

async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof NameFailure) return e.code;
    throw e;
  }
  throw new Error('expected a failure');
}

describe('names service', () => {
  it('hands out a name under the zone that points at the caller, over DNS only', async () => {
    const { cf, call } = setup();
    const res = await call('POST', '/v1/names');
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string; token: string };
    expect(body.name).toMatch(/^[a-z][a-z0-9]{7}\.leafbot\.cloud$/);
    expect(body.token.length).toBeGreaterThanOrEqual(40);
    expect([...cf.records.values()]).toEqual([
      expect.objectContaining({ type: 'A', name: body.name, content: IP, proxied: false }),
    ]);
  });

  it('gives names only to public IPv4 addresses', async () => {
    const { names } = setup();
    for (const ip of ['10.0.0.5', '192.168.1.2', '127.0.0.1', '100.64.0.1', '2001:db8::1', '', 'x']) {
      expect(await failure(names.claim(ip))).toBe('ipv4_only');
    }
  });

  it('keeps one name per address: a second claim replaces the first', async () => {
    const { cf, names } = setup();
    const first = await names.claim(IP);
    const second = await names.claim(IP);
    expect(second.name).not.toBe(first.name);
    expect([...cf.records.values()].map((r) => r.name)).toEqual([second.name]);
    expect(await failure(names.refresh(first.name.split('.')[0]!, first.token, IP))).toBe('unknown');
  });

  it('limits new names per address per day, and across all servers per week', async () => {
    const { clock, names } = setup({ PER_IP_PER_DAY: '2', PER_WEEK: '3' });
    await names.claim(IP);
    await names.claim(IP);
    expect(await failure(names.claim(IP))).toBe('too_many');
    clock.now += DAY + 1;
    await names.claim(IP);
    // The week holds three claims now, replaced names included: their certificates still counted.
    expect(await failure(names.claim(OTHER_IP))).toBe('busy');
    clock.now += 7 * DAY;
    await names.claim(OTHER_IP);
  });

  it('stops at the zone total, but an address that has a name may still replace it', async () => {
    const { names } = setup({ TOTAL: '1' });
    await names.claim(IP);
    expect(await failure(names.claim(OTHER_IP))).toBe('full');
    await names.claim(IP);
  });

  it('answers full when Cloudflare refuses a record over the zone quota, and dns for other errors', async () => {
    const { cf, names } = setup();
    cf.state.failWith = { status: 400, code: 81045, message: 'Record quota exceeded.' };
    expect(await failure(names.claim(IP))).toBe('full');
    cf.state.failWith = { status: 500, code: 10000, message: 'Internal error' };
    expect(await failure(names.claim(OTHER_IP))).toBe('dns');
  });

  it('moves a name to the server’s new address, and only with its token', async () => {
    const { cf, call, names } = setup();
    const { name, token } = await names.claim(IP);
    const label = name.split('.')[0]!;

    expect((await call('PUT', `/v1/names/${label}`, OTHER_IP)).status).toBe(404);
    expect((await call('PUT', `/v1/names/${label}`, OTHER_IP, 'x'.repeat(43))).status).toBe(404);
    expect([...cf.records.values()][0]!.content).toBe(IP);

    const res = await call('PUT', `/v1/names/${label}`, OTHER_IP, token);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name, ip: OTHER_IP });
    expect([...cf.records.values()][0]!.content).toBe(OTHER_IP);
  });

  it('drops a name left on an address another server moves to', async () => {
    const { cf, names } = setup();
    const a = await names.claim(IP);
    const b = await names.claim(OTHER_IP);
    await names.refresh(a.name.split('.')[0]!, a.token, OTHER_IP);
    expect([...cf.records.values()].map((r) => [r.name, r.content])).toEqual([[a.name, OTHER_IP]]);
    expect(await failure(names.refresh(b.name.split('.')[0]!, b.token, OTHER_IP))).toBe('unknown');
  });

  it('gives a name up with its token', async () => {
    const { cf, call, names } = setup();
    const { name, token } = await names.claim(IP);
    const res = await call('DELETE', `/v1/names/${name.split('.')[0]}`, IP, token);
    expect(res.status).toBe(204);
    expect(cf.records.size).toBe(0);
  });

  it('removes names not heard from in 30 days; a refresh keeps a name', async () => {
    const { cf, clock, names } = setup();
    const kept = await names.claim(IP);
    await names.claim(OTHER_IP);
    clock.now += 20 * DAY;
    await names.refresh(kept.name.split('.')[0]!, kept.token, IP);
    clock.now += 11 * DAY;
    expect(await names.sweep()).toBe(1);
    expect([...cf.records.values()].map((r) => r.name)).toEqual([kept.name]);
  });

  it('sends someone who knows only the server’s address on to its name', async () => {
    const { call, names } = setup();
    expect((await call('GET', `/${IP}`, OTHER_IP)).status).toBe(404);
    const { name } = await names.claim(IP);
    const res = await call('GET', `/${IP}`, OTHER_IP);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe(`https://${name}/`);
    expect((await call('GET', '/10.0.0.1')).status).toBe(404);
  });

  it('answers unknown paths and methods with 404 and a reason', async () => {
    const { call } = setup();
    const res = await call('GET', '/v1/names');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found' });
    expect((await call('GET', '/')).status).toBe(200);
  });
});

describe('addresses and labels', () => {
  it('tells public IPv4 addresses from private, reserved and malformed ones', () => {
    expect(['1.2.3.4', '93.184.216.34', '172.32.0.1', '100.128.0.1'].every(isPublicIpv4)).toBe(true);
    const notPublic = ['0.1.2.3', '172.16.0.1', '169.254.1.1', '192.0.2.10', '198.18.0.1', '203.0.113.7'];
    expect(notPublic.concat(['224.0.0.1', '256.1.1.1', '01.2.3.4', '1.2.3']).some(isPublicIpv4)).toBe(false);
  });

  it('makes eight-character labels that start with a letter', () => {
    const labels = Array.from({ length: 200 }, randomLabel);
    expect(labels.every((l) => LABEL.test(l))).toBe(true);
    expect(new Set(labels).size).toBe(200);
  });
});
