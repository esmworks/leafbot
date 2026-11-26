import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { D1Database, D1Statement } from '../src/d1-store';

/** D1's statement API over node:sqlite, with the service's real schema, so the SQL itself is tested. */
export function sqliteD1(): D1Database {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  const statement = (sql: string, values: unknown[]): D1Statement => {
    const s = db.prepare(sql);
    const args = values as (string | number | null)[];
    return {
      bind: (...v) => statement(sql, v),
      first: async <T>() => (s.get(...args) as T | undefined) ?? null,
      run: async () => s.run(...args),
      all: async <T>() => ({ results: s.all(...args) as T[] }),
    };
  };
  return { prepare: (sql) => statement(sql, []) };
}

export interface FakeRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied: boolean;
}

/** Cloudflare's DNS records API for one zone, kept in memory. */
export function fakeCloudflare(zoneId = 'zone1', token = 'cf-token') {
  const records = new Map<string, FakeRecord>();
  let next = 1;
  const state = { failWith: null as null | { status: number; code: number; message: string } };
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get('authorization');
    if (auth !== `Bearer ${token}`)
      return reply(403, { success: false, errors: [{ code: 10000, message: 'auth' }] });
    if (state.failWith) {
      const f = state.failWith;
      state.failWith = null;
      return reply(f.status, { success: false, errors: [{ code: f.code, message: f.message }] });
    }
    const m = new RegExp(`^/client/v4/zones/${zoneId}/dns_records(?:/([^/]+))?$`).exec(url.pathname);
    if (!m) return reply(404, { success: false, errors: [{ code: 7003, message: 'no route' }] });
    const id = m[1];
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const method = init?.method ?? 'GET';
    if (method === 'POST' && !id) {
      const rec: FakeRecord = {
        id: `rec${next++}`,
        type: String(body.type),
        name: String(body.name),
        content: String(body.content),
        proxied: Boolean(body.proxied),
      };
      records.set(rec.id, rec);
      return reply(200, { success: true, result: rec });
    }
    const rec = id ? records.get(id) : undefined;
    if (!rec)
      return reply(404, { success: false, errors: [{ code: 81044, message: 'Record does not exist.' }] });
    if (method === 'PATCH') {
      rec.content = String(body.content);
      return reply(200, { success: true, result: rec });
    }
    if (method === 'DELETE') {
      records.delete(rec.id);
      return reply(200, { success: true, result: { id: rec.id } });
    }
    return reply(405, { success: false, errors: [{ code: 10000, message: 'method' }] });
  }) as typeof fetch;
  return { fetcher, records, state, zoneId, token };
}
