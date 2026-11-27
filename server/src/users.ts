import type { PersonInfo, Role } from '@leafbot/shared';
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm';
import { hashPassword, verifyPassword } from './account';
import { schema, type Db } from './db';
import type { PasswordHash } from './db/schema';
import { HttpError, isUniqueViolation, newId, notFound } from './util';

/** The owner's fixed id: whoever installed this server, and whom the access key signs in as. */
export const OWNER_ID = 'owner';

/** Where the single account was kept before there were people: a username and a password hash. */
const LEGACY_ACCOUNT = 'account';

/** A username folded the way sign-in compares it, in code rather than SQL so every database agrees. */
export const usernameKey = (username: string) => username.trim().toLowerCase();

export interface User {
  id: string;
  username: string | null;
  role: Role;
  disabledAt: Date | null;
}

type Row = typeof schema.users.$inferSelect;

const userOf = (r: Row): User => ({
  id: r.id,
  username: r.username,
  role: r.role,
  disabledAt: r.disabledAt,
});

const personOf = (r: Row): PersonInfo => ({
  id: r.id,
  username: r.username,
  displayName: r.displayName,
  role: r.role,
  disabled: !!r.disabledAt,
  createdAt: r.createdAt.toISOString(),
});

/**
 * Makes sure the owner exists and carries the username and password of the single account that
 * came before people did. Safe to run any number of times: at startup, and after a restore that
 * brought back a backup from before.
 */
export async function adoptLegacyAccount(db: Db): Promise<void> {
  await db.insert(schema.users).values({ id: OWNER_ID, role: 'owner' }).onConflictDoNothing();
  await adoptLegacyProfile(db);
  const [row] = await db.select().from(schema.kv).where(eq(schema.kv.key, LEGACY_ACCOUNT)).limit(1);
  if (!row) return;
  const v = row.value as Partial<PasswordHash & { username: string }>;
  if (v.username && v.salt && v.hash && v.N && v.r && v.p) {
    const password: PasswordHash = { salt: v.salt, hash: v.hash, N: v.N, r: v.r, p: v.p };
    await db
      .update(schema.users)
      .set({ username: v.username.trim(), usernameKey: usernameKey(v.username), password })
      .where(eq(schema.users.id, OWNER_ID));
  }
  await db.delete(schema.kv).where(eq(schema.kv.key, LEGACY_ACCOUNT));
}

/** Settings that became each person's own; before people came in they were the server's. */
const LEGACY_PROFILE = ['userName', 'addressAs', 'occupation', 'focus', 'helpWith', 'aboutMe', 'onboarded'];

/**
 * What the single account told about themselves was kept with the server's settings: an owner
 * with nothing of their own yet takes it. The server's copy stays, for an older version to read.
 */
async function adoptLegacyProfile(db: Db): Promise<void> {
  const [owner] = await db
    .select({ profile: schema.users.profile })
    .from(schema.users)
    .where(eq(schema.users.id, OWNER_ID))
    .limit(1);
  if (!owner || Object.keys(owner.profile).length) return;
  const rows = await db
    .select()
    .from(schema.kv)
    .where(
      inArray(
        schema.kv.key,
        LEGACY_PROFILE.map((k) => `setting.${k}`),
      ),
    );
  if (!rows.length) return;
  const profile = Object.fromEntries(rows.map((r) => [r.key.slice('setting.'.length), r.value]));
  await db.update(schema.users).set({ profile }).where(eq(schema.users.id, OWNER_ID));
}

/** A username another person took while this one was being saved reads as taken. */
const usernameTaken = (err: unknown): never => {
  if (isUniqueViolation(err)) throw new HttpError(409, 'error.usernameTaken');
  throw err;
};

/** The people who sign in to this server, and their usernames and passwords. */
export class Users {
  constructor(private db: Db) {}

  async get(id: string): Promise<User | null> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return row ? userOf(row) : null;
  }

  /** The owner; there is always one, made by the migration that brought people in. */
  async owner(): Promise<User> {
    const owner = await this.get(OWNER_ID);
    if (!owner) throw new Error('users: the owner is missing');
    return owner;
  }

  /** Everyone on the server, the owner first, then by when they came. */
  async list(): Promise<PersonInfo[]> {
    const rows = await this.db.select().from(schema.users).orderBy(asc(schema.users.createdAt));
    // Who signs in with an account: the list offers an invite to the others.
    const linked = new Set(
      (await this.db.select({ userId: schema.accountLinks.userId }).from(schema.accountLinks)).map(
        (l) => l.userId,
      ),
    );
    return rows
      .map((r) => ({ ...personOf(r), linked: linked.has(r.id) }))
      .sort((a, b) => Number(b.role === 'owner') - Number(a.role === 'owner'));
  }

  /**
   * Members who came since team spaces and wait for theirs to be chosen, the earliest first. Those
   * who look after the server reach every space's bots already, so none of them waits.
   */
  async newcomers(): Promise<PersonInfo[]> {
    const rows = await this.db
      .select()
      .from(schema.users)
      .where(
        and(isNull(schema.users.placedAt), eq(schema.users.role, 'member'), isNull(schema.users.disabledAt)),
      )
      .orderBy(asc(schema.users.createdAt));
    return rows.map(personOf);
  }

  /** The person's team spaces are chosen: they wait no longer. */
  async place(id: string): Promise<void> {
    const [row] = await this.db
      .update(schema.users)
      .set({ placedAt: new Date() })
      .where(eq(schema.users.id, id))
      .returning({ id: schema.users.id });
    if (!row) throw notFound('person');
  }

  /** Whether the person signs in with a Leaf Bot account already. */
  async linked(id: string): Promise<boolean> {
    const [row] = await this.db
      .select({ userId: schema.accountLinks.userId })
      .from(schema.accountLinks)
      .where(eq(schema.accountLinks.userId, id))
      .limit(1);
    return !!row;
  }

  async person(id: string): Promise<PersonInfo | null> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.id, id)).limit(1);
    return row ? personOf(row) : null;
  }

  /** A new person who signs in with their own username and password. */
  async create(input: {
    username: string;
    password: string;
    displayName?: string;
    role: 'admin' | 'member';
  }): Promise<PersonInfo> {
    const key = usernameKey(input.username);
    const [taken] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.usernameKey, key))
      .limit(1);
    if (taken) throw new HttpError(409, 'error.usernameTaken');
    const password = await hashPassword(input.password);
    // Two added at once with one username: the index keeps one, the other is told it is taken.
    const [row] = await this.db
      .insert(schema.users)
      .values({
        id: newId(),
        username: input.username.trim(),
        usernameKey: key,
        displayName: input.displayName?.trim() || null,
        role: input.role,
        password,
      })
      .returning()
      .catch(usernameTaken);
    return personOf(row!);
  }

  /** Changes a person other than the owner: name, role, whether they may sign in, password. */
  async change(
    id: string,
    patch: { displayName?: string | null; role?: 'admin' | 'member'; disabled?: boolean; password?: string },
  ): Promise<PersonInfo> {
    const [row] = await this.db
      .update(schema.users)
      .set({
        ...(patch.displayName !== undefined && { displayName: patch.displayName?.trim() || null }),
        ...(patch.role && { role: patch.role }),
        ...(patch.disabled !== undefined && { disabledAt: patch.disabled ? new Date() : null }),
        ...(patch.password !== undefined && { password: await hashPassword(patch.password) }),
      })
      .where(and(eq(schema.users.id, id), ne(schema.users.role, 'owner')))
      .returning();
    if (!row) throw new HttpError(404, 'error.notFound.person');
    return personOf(row);
  }

  async remove(id: string) {
    await this.db.delete(schema.users).where(and(eq(schema.users.id, id), ne(schema.users.role, 'owner')));
  }

  /** Whether anyone can sign in with a username and password yet, rather than only the access key. */
  async anyPassword(): Promise<boolean> {
    const rows = await this.db.select({ password: schema.users.password }).from(schema.users);
    return rows.some((r) => r.password !== null);
  }

  /**
   * The person a username and password belong to, or null. A hash made at an older, lower cost is
   * made again at today's once the password is known right. A disabled person cannot sign in.
   */
  async check(username: string, password: string): Promise<User | null> {
    const [row] = await this.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.usernameKey, usernameKey(username)))
      .limit(1);
    return this.verify(row ?? null, password);
  }

  /** Whether the password is this person's own, as asked before they change it. */
  async checkFor(userId: string, password: string): Promise<boolean> {
    const [row] = await this.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1);
    return (await this.verify(row ?? null, password)) !== null;
  }

  private async verify(row: Row | null, password: string): Promise<User | null> {
    // The hash is worked out whoever asks, so the time a reply takes tells nothing.
    const { ok, stale } = await verifyPassword(password, row?.password ?? null);
    if (!row || !ok || row.disabledAt) return null;
    // The sign-in stands even if the new hash cannot be written; it is tried again next time.
    if (stale) await this.setPassword(row.id, password).catch(() => {});
    return userOf(row);
  }

  /** Sets a person's username and password; a username another person has is refused. */
  async setCredentials(userId: string, username: string, password: string): Promise<User> {
    const key = usernameKey(username);
    const [taken] = await this.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.usernameKey, key), ne(schema.users.id, userId)))
      .limit(1);
    if (taken) throw new HttpError(409, 'error.usernameTaken');
    const hash = await hashPassword(password);
    const [row] = await this.db
      .update(schema.users)
      .set({ username: username.trim(), usernameKey: key, password: hash })
      .where(eq(schema.users.id, userId))
      .returning()
      .catch(usernameTaken);
    if (!row) throw new HttpError(404, 'error.notFound');
    return userOf(row);
  }

  private async setPassword(userId: string, password: string) {
    await this.db
      .update(schema.users)
      .set({ password: await hashPassword(password) })
      .where(eq(schema.users.id, userId));
  }
}
