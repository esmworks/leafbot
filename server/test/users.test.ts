import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { io as connect } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/account';
import { canAdminister, requireAdmin } from '../src/auth';
import { schema, type Db } from '../src/db';
import { adoptLegacyAccount, OWNER_ID, Users } from '../src/users';
import { KEY, testServer, type TestServer } from './helpers';

const MIGRATIONS = resolve(import.meta.dirname, '../drizzle');

/** The migrations folder as it was before people came in: every migration up to `users`. */
const migrationDirs: string[] = [];
afterAll(() => {
  for (const d of migrationDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function migrationsBeforeUsers(): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const upTo = journal.entries.findIndex((e) => e.tag.endsWith('_users'));
  expect(upTo).toBeGreaterThan(0);
  const dir = mkdtempSync(join(tmpdir(), 'leafbot-migrations-'));
  migrationDirs.push(dir);
  mkdirSync(join(dir, 'meta'));
  const entries = journal.entries.slice(0, upTo);
  for (const e of entries) copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return dir;
}

describe('tek hesaptan kişilere geçiş', () => {
  it('eski veritabanının hesabı owner olur, açık oturumu owner’a bağlanır', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema }) as unknown as Db;
    try {
      await migrate(db as never, { migrationsFolder: migrationsBeforeUsers() });
      const password = await hashPassword('eski-sifre');
      await db.execute(
        sql`insert into kv (key, value) values ('account', ${JSON.stringify({ username: 'Erhan', ...password })}::jsonb)`,
      );
      await db.execute(sql`insert into sessions (id) values ('eski-oturum')`);

      await migrate(db as never, { migrationsFolder: MIGRATIONS });
      const [session] = await db.select().from(schema.sessions);
      expect(session).toMatchObject({ id: 'eski-oturum', userId: OWNER_ID });

      await adoptLegacyAccount(db);
      const users = new Users(db);
      expect(await users.check('erhan', 'eski-sifre')).toMatchObject({ id: OWNER_ID, username: 'Erhan' });
      expect(await db.select().from(schema.kv).where(eq(schema.kv.key, 'account'))).toEqual([]);
      // Run again, as every startup does, it changes nothing.
      await adoptLegacyAccount(db);
      expect(await users.check('erhan', 'eski-sifre')).not.toBeNull();
    } finally {
      await client.close();
    }
  });

  it('hesapsız kurulumda owner kullanıcı adı olmadan durur; anahtarla girilir', async () => {
    const t = await testServer();
    try {
      const owner = await t.auth.users.owner();
      expect(owner).toMatchObject({ id: OWNER_ID, username: null, role: 'owner' });
      const session = await t.app.inject({
        method: 'GET',
        url: '/api/session',
        headers: { host: 'localhost', authorization: `Bearer ${KEY}` },
      });
      expect(session.json()).toEqual({
        authenticated: true,
        account: false,
        user: { id: OWNER_ID, username: null, role: 'owner' },
      });
    } finally {
      await t.dispose();
    }
  });
});

describe('birden çok kişi', () => {
  let t: TestServer;
  beforeAll(async () => {
    t = await testServer();
    await t.auth.users.setCredentials(OWNER_ID, 'erhan', 'owner-sifresi');
    await t.services.ctx.db.insert(schema.users).values({
      id: 'ayse',
      username: 'Ayşe',
      usernameKey: 'ayşe',
      role: 'member',
      password: await hashPassword('ayse-sifresi'),
    });
  });
  afterAll(() => t.dispose());

  const send = (method: string, url: string, opts: { cookie?: string; payload?: object } = {}) =>
    t.app.inject({
      method: method as 'GET',
      url,
      headers: {
        host: 'localhost',
        ...(opts.cookie && { cookie: opts.cookie }),
        ...(method !== 'GET' && { origin: 'http://localhost' }),
      },
      ...(opts.payload && { payload: opts.payload }),
    });
  const signIn = async (username: string, password: string) => {
    const r = await send('POST', '/api/login', { payload: { username, password } });
    expect(r.statusCode).toBe(200);
    return String(r.headers['set-cookie']).split(';')[0]!;
  };

  it('her kişi kendi şifresiyle kendisi olarak girer', async () => {
    const ayse = await signIn('AYŞE ', 'ayse-sifresi');
    expect((await send('GET', '/api/session', { cookie: ayse })).json()).toMatchObject({
      authenticated: true,
      user: { id: 'ayse', username: 'Ayşe', role: 'member' },
    });
    expect((await send('GET', '/api/account', { cookie: ayse })).json()).toEqual({ username: 'Ayşe' });
    // Another person's password is not a way in.
    expect(
      (await send('POST', '/api/login', { payload: { username: 'ayşe', password: 'owner-sifresi' } }))
        .statusCode,
    ).toBe(401);
  });

  it('cihaz listesi ve oturum kapatma yalnızca kişinin kendi cihazlarına dokunur', async () => {
    const owner = await signIn('erhan', 'owner-sifresi');
    const ayse1 = await signIn('ayşe', 'ayse-sifresi');
    await signIn('ayşe', 'ayse-sifresi');

    const ownerDevices = (await send('GET', '/api/sessions', { cookie: owner })).json() as unknown[];
    const ayseDevices = (await send('GET', '/api/sessions', { cookie: ayse1 })).json() as { id: string }[];
    expect(ayseDevices.length).toBeGreaterThanOrEqual(2);
    const ownerIds = new Set((ownerDevices as { id: string }[]).map((d) => d.id));
    expect(ayseDevices.some((d) => ownerIds.has(d.id))).toBe(false);

    // Ayşe signs out her other devices; the owner stays signed in.
    await send('DELETE', '/api/sessions/others', { cookie: ayse1 });
    expect((await send('GET', '/api/sessions', { cookie: ayse1 })).json()).toHaveLength(1);
    expect((await send('GET', '/api/session', { cookie: owner })).json()).toMatchObject({
      authenticated: true,
    });
    // Naming one of the owner's devices from Ayşe's session ends nothing.
    const [ownerDevice] = ownerDevices as { id: string }[];
    expect((await send('DELETE', `/api/sessions/${ownerDevice!.id}`, { cookie: ayse1 })).json()).toEqual({
      ended: 0,
    });
  });

  it('eşleme kodu yeni cihazı kodu yapan kişi olarak sokar', async () => {
    const ayse = await signIn('ayşe', 'ayse-sifresi');
    const { code } = (await send('POST', '/api/pairing', { cookie: ayse })).json() as { code: string };
    const paired = await send('POST', '/api/pair', { payload: { code } });
    const cookie = String(paired.headers['set-cookie']).split(';')[0]!;
    expect((await send('GET', '/api/session', { cookie })).json()).toMatchObject({ user: { id: 'ayse' } });
  });

  it('başka birinin kullanıcı adı alınamaz; erişim anahtarı yalnızca owner’ın şifresini değiştirir', async () => {
    const ayse = await signIn('ayşe', 'ayse-sifresi');
    const taken = await send('PUT', '/api/account', {
      cookie: ayse,
      payload: { username: 'ERHAN', password: 'yeni-sifre-1', current: 'ayse-sifresi' },
    });
    expect(taken.statusCode).toBe(409);
    const withKey = await send('PUT', '/api/account', {
      cookie: ayse,
      payload: { username: 'ayşe', password: 'yeni-sifre-1', current: KEY },
    });
    expect(withKey.statusCode).toBe(403);
  });

  it('devre dışı bırakılan kişi giremez, açık oturumu da çalışmaz', async () => {
    await t.services.ctx.db.insert(schema.users).values({
      id: 'mehmet',
      username: 'mehmet',
      usernameKey: 'mehmet',
      role: 'member',
      password: await hashPassword('mehmet-sifresi'),
    });
    const cookie = await signIn('mehmet', 'mehmet-sifresi');
    await t.services.ctx.db
      .update(schema.users)
      .set({ disabledAt: new Date() })
      .where(eq(schema.users.id, 'mehmet'));
    // Past the minute a checked session is remembered for.
    const later = new Date(Date.now() + 2 * 60_000);
    expect(await t.auth.validSession(cookie.split('=')[1], later)).toBeNull();
    expect(
      (await send('POST', '/api/login', { payload: { username: 'mehmet', password: 'mehmet-sifresi' } }))
        .statusCode,
    ).toBe(401);
  });

  it('soket bağlantısı kimin girdiğini bilir', async () => {
    const url = await t.listen();
    const ayse = await signIn('ayşe', 'ayse-sifresi');
    const principalOf = async (extraHeaders: Record<string, string>) => {
      const s = connect(url, { transports: ['websocket'], reconnection: false, extraHeaders });
      try {
        await new Promise((resolve, reject) => {
          s.on('hello', resolve);
          s.on('connect_error', reject);
        });
        const [server] = (await t.io.fetchSockets()).filter((x) => x.id === s.id);
        return server?.data.principal;
      } finally {
        s.close();
      }
    };
    expect(await principalOf({ cookie: ayse, origin: url })).toMatchObject({
      userId: 'ayse',
      role: 'member',
    });
    expect(await principalOf({ authorization: `Bearer ${KEY}` })).toMatchObject({
      userId: OWNER_ID,
      role: 'owner',
      via: 'key',
    });
  });
});

describe('sunucuyu yönetme yetkisi', () => {
  it('owner ve admin yönetir, üye yönetemez', () => {
    expect(canAdminister('owner')).toBe(true);
    expect(canAdminister('admin')).toBe(true);
    expect(canAdminister('member')).toBe(false);
    expect(requireAdmin({ userId: 'a', role: 'admin', via: 'session' }).userId).toBe('a');
    expect(() => requireAdmin({ userId: 'b', role: 'member', via: 'session' })).toThrow();
    expect(() => requireAdmin(null)).toThrow();
  });
});
