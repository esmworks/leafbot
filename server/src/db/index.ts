import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import { lockFolder, type FolderLock } from './lock';
import * as schema from './schema';

export type Db = PgDatabase<PgQueryResultHKT, typeof schema>;
export { schema };

export interface DbHandle {
  db: Db;
  kind: 'pglite' | 'postgres';
  close(): Promise<void>;
}

// Source runs from src/db, the bundle from dist; migrations sit next to either.
const migrationsFolder =
  [
    process.env.LEAFBOT_MIGRATIONS_DIR,
    resolve(import.meta.dirname, 'drizzle'),
    resolve(import.meta.dirname, '../../drizzle'),
  ].find((p): p is string => !!p && existsSync(resolve(p, 'meta/_journal.json'))) ??
  resolve(import.meta.dirname, '../../drizzle');

/** How many migrations the database has been through: a backup records it, a restore compares. */
export function schemaVersion(): number {
  const journal = JSON.parse(readFileSync(resolve(migrationsFolder, 'meta/_journal.json'), 'utf8')) as {
    entries: unknown[];
  };
  return journal.entries.length;
}

export async function openDb(opts: {
  url: string | null;
  dataDir: string;
  memory: boolean;
  /**
   * How long to wait for another process to let go of the embedded database: a server waits for
   * one still shutting down; `leafbot login` waits for nothing.
   */
  lockWaitMs?: number;
}): Promise<DbHandle> {
  if (opts.url) {
    const { default: postgres } = await import('postgres');
    const { drizzle } = await import('drizzle-orm/postgres-js');
    const { migrate } = await import('drizzle-orm/postgres-js/migrator');
    const client = postgres(opts.url, { max: 10, onnotice: () => {} });
    const db = drizzle(client, { schema });
    await migrate(db, { migrationsFolder });
    return { db: db as unknown as Db, kind: 'postgres', close: () => client.end() };
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { drizzle } = await import('drizzle-orm/pglite');
  const { migrate } = await import('drizzle-orm/pglite/migrator');
  let client;
  let lock: FolderLock | null = null;
  if (opts.memory) {
    client = new PGlite();
  } else {
    const dir = join(opts.dataDir, 'db');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // Only one process may open these files; a second one writing them corrupts the database.
    lock = await lockFolder(join(opts.dataDir, 'db.lock'), { waitMs: opts.lockWaitMs ?? 40_000 });
    client = new PGlite(dir);
  }
  try {
    const db = drizzle(client, { schema, logger: process.env.VITEST ? rawDateGuard : undefined });
    await migrate(db, { migrationsFolder });
    return {
      db: db as unknown as Db,
      kind: 'pglite',
      close: async () => {
        try {
          await client.close();
        } finally {
          lock?.release();
        }
      },
    };
  } catch (e) {
    await client.close().catch(() => {});
    lock?.release();
    throw e;
  }
}

/**
 * Tests run on PGlite, which takes a Date anywhere; on PostgreSQL drizzle hands a Date it did not
 * map through a column straight to the driver, and the query fails there. Refusing it under test
 * makes such a query fail where it is written instead of on the server.
 */
const rawDateGuard = {
  logQuery(query: string, params: unknown[]) {
    if (params.some((p) => p instanceof Date))
      throw new Error(`A Date was passed into raw SQL; pass it as text with ::timestamptz.\n${query}`);
  },
};
