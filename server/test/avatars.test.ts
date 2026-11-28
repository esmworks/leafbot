import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import type { Bot } from '@leafbot/shared';
import { asc, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/pglite';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema, type Db } from '../src/db';
import { testServer, type TestServer } from './helpers';

const MIGRATIONS = resolve(import.meta.dirname, '../drizzle');

/** The migrations folder as it was while bots could still take a plush shape. */
const migrationDirs: string[] = [];
afterAll(() => {
  for (const d of migrationDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function migrationsBeforeRoundAvatars(): string {
  const journal = JSON.parse(readFileSync(join(MIGRATIONS, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const upTo = journal.entries.findIndex((e) => e.tag.endsWith('_round_avatars'));
  expect(upTo).toBeGreaterThan(0);
  const dir = mkdtempSync(join(tmpdir(), 'leafbot-migrations-'));
  migrationDirs.push(dir);
  mkdirSync(join(dir, 'meta'));
  const entries = journal.entries.slice(0, upTo);
  for (const e of entries) copyFileSync(join(MIGRATIONS, `${e.tag}.sql`), join(dir, `${e.tag}.sql`));
  writeFileSync(join(dir, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  return dir;
}

describe('şekil avatarlarından yuvarlak nesneye geçiş', () => {
  it('eski veritabanındaki şekil avatarları yuvarlak nesne olur, nesne ve resim avatarları kalır', async () => {
    const client = new PGlite();
    const db = drizzle(client, { schema }) as unknown as Db;
    const picture = 'data:image/png;base64,iVBORw0KGgo=';
    try {
      await migrate(db as never, { migrationsFolder: migrationsBeforeRoundAvatars() });
      await db.execute(sql`insert into bots (id, name, avatar) values
        ('a', 'Yumak', 'shape:pebble'), ('b', 'Kupa', 'object:mug'), ('c', 'Resim', ${picture})`);
      await db.execute(sql`insert into bots (id, name) values ('d', 'Varsayılan')`);

      await migrate(db as never, { migrationsFolder: MIGRATIONS });
      await db.execute(sql`insert into bots (id, name) values ('e', 'Yeni')`);
      const rows = await db
        .select({ id: schema.bots.id, avatar: schema.bots.avatar })
        .from(schema.bots)
        .orderBy(asc(schema.bots.id));
      expect(rows).toEqual([
        { id: 'a', avatar: 'object:circle' },
        { id: 'b', avatar: 'object:mug' },
        { id: 'c', avatar: picture },
        { id: 'd', avatar: 'object:circle' },
        { id: 'e', avatar: 'object:circle' },
      ]);
    } finally {
      await client.close();
    }
  });
});

describe('şekil gönderen eski uygulamalar', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('oluştururken ya da değiştirirken gönderilen şekil yuvarlak nesne olarak kaydedilir', async () => {
    const created = (await t.api<Bot>('POST', '/api/bots', { name: 'Telefon', avatar: 'shape:pebble' })).body;
    expect(created.avatar).toBe('object:circle');
    await t.api('PATCH', `/api/bots/${created.id}`, { avatar: 'object:mug' });
    const changed = (await t.api<Bot>('PATCH', `/api/bots/${created.id}`, { avatar: 'shape:cloud' })).body;
    expect(changed.avatar).toBe('object:circle');
    expect((await t.api<Bot>('POST', '/api/bots', { name: 'Boş' })).body.avatar).toBe('object:circle');
  });
});
