import { CloudflareDns } from './cloudflare-dns';
import { D1NameStore, type D1Database } from './d1-store';
import { DEFAULT_LIMITS, NameFailure, NameService, type NameLimits } from './service';

/**
 * The names service as a Cloudflare Worker (see README.md for how it is deployed):
 *
 *   POST   /v1/names          a new name pointing at the caller's address → { name, token }
 *   PUT    /v1/names/:label   Authorization: Bearer <token>; still here, maybe from a new address
 *   DELETE /v1/names/:label   Authorization: Bearer <token>; give the name up
 *   GET    /<IPv4 address>    a redirect to the server's name there, for an install made from user data
 *
 * Once a day it removes the names of servers that have not been heard from.
 */
export interface Env {
  DB: D1Database;
  /** Zone → DNS → Edit on the names zone only; set with `wrangler secret put CF_API_TOKEN`. */
  CF_API_TOKEN: string;
  ZONE_ID: string;
  /** The zone names are made under, such as `leafbot.cloud`. */
  DOMAIN: string;
  PER_IP_PER_DAY?: string;
  PER_WEEK?: string;
  TOTAL?: string;
  STALE_DAYS?: string;
}

function limits(env: Env): NameLimits {
  const num = (v: string | undefined, fallback: number) => {
    const n = Number(v);
    return v && Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    perIpPerDay: num(env.PER_IP_PER_DAY, DEFAULT_LIMITS.perIpPerDay),
    perWeek: num(env.PER_WEEK, DEFAULT_LIMITS.perWeek),
    total: num(env.TOTAL, DEFAULT_LIMITS.total),
    staleDays: num(env.STALE_DAYS, DEFAULT_LIMITS.staleDays),
  };
}

export function service(env: Env, fetcher: typeof fetch = fetch, now?: () => number): NameService {
  return new NameService({
    store: new D1NameStore(env.DB),
    dns: new CloudflareDns(env.ZONE_ID, env.CF_API_TOKEN, fetcher),
    domain: env.DOMAIN,
    limits: limits(env),
    ...(now ? { now } : {}),
  });
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

function bearer(req: Request): string | null {
  const m = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(req.headers.get('authorization') ?? '');
  return m?.[1] ?? null;
}

export async function handle(req: Request, names: NameService): Promise<Response> {
  const url = new URL(req.url);
  // Cloudflare sets this to the address the connection came from; a client cannot choose it.
  const ip = req.headers.get('cf-connecting-ip') ?? '';
  try {
    if (url.pathname === '/v1/names' && req.method === 'POST') {
      return json(await names.claim(ip), 201);
    }
    const m = /^\/v1\/names\/([^/]+)$/.exec(url.pathname);
    if (m && (req.method === 'PUT' || req.method === 'DELETE')) {
      const token = bearer(req);
      if (!token) throw new NameFailure('unknown', 404);
      // Labels are lower-case letters and digits, so the path needs no decoding.
      const label = m[1] ?? '';
      if (req.method === 'PUT') return json(await names.refresh(label, token, ip));
      await names.release(label, token);
      return new Response(null, { status: 204 });
    }
    const byIp = /^\/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(url.pathname);
    if (byIp && req.method === 'GET') {
      const name = await names.nameFor(byIp[1] ?? '');
      if (name) return new Response(null, { status: 302, headers: { location: `https://${name}/` } });
      return new Response(
        'No Leaf Bot server has a name at this address yet. The installer may still be running.\n',
        {
          status: 404,
          headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' },
        },
      );
    }
    if (url.pathname === '/' && req.method === 'GET') {
      return new Response('Leaf Bot server names\n', { headers: { 'content-type': 'text/plain' } });
    }
    throw new NameFailure('not_found', 404);
  } catch (e) {
    if (e instanceof NameFailure) return json({ error: e.code }, e.status);
    console.error(e);
    return json({ error: 'internal' }, 500);
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, service(env));
  },
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const removed = await service(env).sweep();
    if (removed) console.log(`removed ${removed} names not heard from`);
  },
};
