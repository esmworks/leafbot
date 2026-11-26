import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type {
  PasswordManager,
  PasswordManagerCreate,
  PasswordManagerProblem,
  PasswordManagerUpdate,
} from '@leafbot/shared';
import {
  PasswordManagerCreate as CreateSchema,
  PasswordManagerUpdate as UpdateSchema,
} from '@leafbot/shared';
import { asc, eq, isNull, or } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { totpSecret } from '../totp';
import { refusePrivate } from './access';
import { HttpError, isUniqueViolation, newId, notFound } from '../util';
import {
  defaultDrivers,
  ManagerError,
  type DriverFactory,
  type ManagerDriver,
  type ManagerEntry,
  type ManagerSecret,
} from './password-manager-drivers';
import {
  MANAGER_ID_PREFIX,
  registrableSite,
  siteMatches,
  siteOf,
  type Credential,
  type VaultService,
} from './vault';

type Row = typeof schema.passwordManagers.$inferSelect;

/** The folder of the data folder that keeps each manager's sign-in state, one folder per manager. */
export const MANAGERS_DIR = 'password-managers';

/** How long a manager's list of sign-ins is used before it is read again. */
const LIST_TTL_MS = 10 * 60_000;

/**
 * What a manager's sealed secret is bound to: its row, its kind and its server. Moved to another
 * row, or left behind when the row is pointed at another server in the database, it does not open.
 */
const secretBinding = (r: Pick<Row, 'id' | 'kind' | 'server'>) => [
  'password_managers.secret',
  r.id,
  r.kind,
  r.server ?? '',
];

const usableBy = (userId: string | null) =>
  userId
    ? or(isNull(schema.passwordManagers.userId), eq(schema.passwordManagers.userId, userId))!
    : isNull(schema.passwordManagers.userId);

const toManager = (r: Row): PasswordManager => ({
  id: r.id,
  kind: r.kind as PasswordManager['kind'],
  scope: r.scope,
  server: r.server,
  botIds: r.botIds ?? null,
  userId: r.userId,
  problem: (r.problem as PasswordManagerProblem | null) ?? null,
  count: r.count,
  readAt: r.readAt?.toISOString() ?? null,
  createdAt: r.createdAt.toISOString(),
});

/** The site an address of a manager's sign-in is for, or null when it is not an https page. */
function siteOfUrl(raw: string, exact: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw.includes('://') ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  // Over plain http a password is not typed, as for the vault's own sign-ins.
  if (url.protocol !== 'https:' || !url.hostname) return null;
  return exact ? siteOf(url.hostname) : registrableSite(url.hostname);
}

/**
 * Password managers the vault reads sign-ins from, so a person does not copy every password in.
 * What each is connected with is sealed like the vault's passwords. A manager's list (which
 * sign-ins, for which sites) is kept in memory for a while; a password is read from the manager
 * only when a page of its site asks for one, and never kept.
 */
export class PasswordManagerService {
  private drivers = new Map<string, { key: string; driver: ManagerDriver }>();
  private lists = new Map<string, { at: number; entries: Promise<ManagerEntry[]> }>();

  constructor(
    private ctx: Ctx,
    private vault: VaultService,
    private makeDriver: DriverFactory = defaultDrivers,
  ) {}

  /** Tests put fake managers in place of the real programs. */
  useDrivers(make: DriverFactory) {
    this.makeDriver = make;
    this.drivers.clear();
    this.lists.clear();
  }

  private stateDir(id: string) {
    const dir = join(this.ctx.config.dataDir, MANAGERS_DIR, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  private forget(id: string) {
    this.drivers.delete(id);
    this.lists.delete(id);
  }

  private driver(r: Row): ManagerDriver {
    // A changed row (another vault or folder) gets a driver of its own.
    const key = `${r.updatedAt.getTime()}:${r.scope}`;
    const had = this.drivers.get(r.id);
    if (had?.key === key) return had.driver;
    const secret = JSON.parse(this.vault.open(r.secret, secretBinding(r))) as ManagerSecret;
    const driver = this.makeDriver({
      kind: r.kind as PasswordManager['kind'],
      secret,
      scope: r.scope,
      server: r.server,
      stateDir: this.stateDir(r.id),
    });
    this.drivers.set(r.id, { key, driver });
    this.lists.delete(r.id);
    return driver;
  }

  private entries(r: Row, fresh = false): Promise<ManagerEntry[]> {
    const driver = this.driver(r);
    const had = this.lists.get(r.id);
    if (had && !fresh && Date.now() - had.at < LIST_TTL_MS) return had.entries;
    const entries = driver.entries();
    this.lists.set(r.id, { at: Date.now(), entries });
    entries.then(
      (list) => this.note(r.id, null, list.length),
      (err: unknown) => {
        this.lists.delete(r.id);
        this.note(r.id, err instanceof ManagerError ? err.problem : 'failed', null);
      },
    );
    return entries;
  }

  /** Keeps how the last read went on the row, for its owner to see. */
  private note(id: string, problem: PasswordManagerProblem | null, count: number | null) {
    void this.ctx.db
      .update(schema.passwordManagers)
      .set({ problem, ...(count !== null && { count }), readAt: new Date() })
      .where(eq(schema.passwordManagers.id, id))
      .then(() => this.ctx.bus.refresh({ scope: 'vault' }))
      .catch(() => {});
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.passwordManagers)
      .where(eq(schema.passwordManagers.id, id))
      .limit(1);
    if (!row) throw notFound('vault');
    return row;
  }

  /** The team's managers and, with `userId`, that person's own. */
  async list(userId?: string): Promise<PasswordManager[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.passwordManagers)
      .where(userId ? usableBy(userId) : undefined)
      .orderBy(asc(schema.passwordManagers.kind), asc(schema.passwordManagers.createdAt));
    return rows.map(toManager);
  }

  async get(id: string): Promise<PasswordManager> {
    return toManager(await this.row(id));
  }

  /**
   * Connects a manager for `owner`, or the team when null. It is read once first: a token that is
   * refused, or a vault or folder that is not there, is said at once and nothing is saved.
   */
  async create(raw: PasswordManagerCreate, owner: string | null): Promise<PasswordManager> {
    const v = CreateSchema.parse(raw);
    const id = newId();
    const server = v.kind === 'bitwarden' ? (v.server ?? null) : null;
    // The server signs in there itself: a person's own manager is not pointed into its network.
    if (server) await refusePrivate(this.ctx, server, owner);
    const secret: ManagerSecret =
      v.kind === 'bitwarden'
        ? { clientId: v.clientId, clientSecret: v.clientSecret, password: v.password }
        : { token: v.token };
    const stateDir = this.stateDir(id);
    let count: number;
    try {
      count = (await this.makeDriver({ kind: v.kind, secret, scope: v.scope, server, stateDir }).entries())
        .length;
    } catch (err) {
      rmSync(stateDir, { recursive: true, force: true });
      const problem = err instanceof ManagerError ? err.problem : 'failed';
      throw new HttpError(400, `error.passwordManager.${problem}`);
    }
    try {
      const [row] = await this.ctx.db
        .insert(schema.passwordManagers)
        .values({
          id,
          userId: owner,
          kind: v.kind,
          scope: v.scope,
          server,
          secret: this.vault.seal(JSON.stringify(secret), secretBinding({ id, kind: v.kind, server })),
          botIds: v.botIds ?? null,
          count,
          readAt: new Date(),
        })
        .returning();
      this.ctx.bus.refresh({ scope: 'vault' });
      return toManager(row!);
    } catch (err) {
      rmSync(stateDir, { recursive: true, force: true });
      if (isUniqueViolation(err)) throw new HttpError(409, 'error.passwordManagerExists');
      throw err;
    }
  }

  /** Changes which vault or folder is read and which bots may use it; `owner` moves it. */
  async update(id: string, raw: PasswordManagerUpdate, owner?: string | null): Promise<PasswordManager> {
    const v = UpdateSchema.parse(raw);
    const old = await this.row(id);
    if (v.scope !== undefined && old.kind === 'bitwarden' && !v.scope) {
      throw new HttpError(400, 'error.passwordManager.scope');
    }
    try {
      const [row] = await this.ctx.db
        .update(schema.passwordManagers)
        .set({
          ...(v.scope !== undefined && { scope: v.scope }),
          ...(v.botIds !== undefined && { botIds: v.botIds }),
          ...(owner !== undefined && { userId: owner }),
          updatedAt: new Date(),
        })
        .where(eq(schema.passwordManagers.id, id))
        .returning();
      this.forget(id);
      this.ctx.bus.refresh({ scope: 'vault' });
      return toManager(row!);
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'error.passwordManagerExists');
      throw err;
    }
  }

  /** Disconnects a manager and removes its sign-in state from the data folder. */
  async remove(id: string) {
    await this.ctx.db.delete(schema.passwordManagers).where(eq(schema.passwordManagers.id, id));
    this.forget(id);
    rmSync(join(this.ctx.config.dataDir, MANAGERS_DIR, id), { recursive: true, force: true });
    this.ctx.bus.refresh({ scope: 'vault' });
  }

  /** Reads a manager's list again now, rather than when the kept one runs out. */
  async refresh(id: string): Promise<PasswordManager> {
    const r = await this.row(id);
    try {
      const list = await this.entries(r, true);
      await this.ctx.db
        .update(schema.passwordManagers)
        .set({ problem: null, count: list.length, readAt: new Date() })
        .where(eq(schema.passwordManagers.id, id));
    } catch (err) {
      await this.ctx.db
        .update(schema.passwordManagers)
        .set({ problem: err instanceof ManagerError ? err.problem : 'failed', readAt: new Date() })
        .where(eq(schema.passwordManagers.id, id));
    }
    return this.get(id);
  }

  /**
   * Sign-ins the managers usable here hold for a page's host, with their passwords, read from the
   * manager now. Server-side only, like the vault's. A manager that cannot be read is left out and
   * its problem kept on its row; the page then falls back to what else there is.
   */
  async forHost(host: string, botId: string | undefined, userId: string | null): Promise<Credential[]> {
    const rows = (await this.ctx.db.select().from(schema.passwordManagers).where(usableBy(userId))).filter(
      (r) => !r.botIds || (botId !== undefined && r.botIds.includes(botId)),
    );
    // A person's own manager comes before the team's.
    rows.sort((a, b) => Number(!a.userId) - Number(!b.userId));
    const out: Credential[] = [];
    for (const r of rows) {
      let list: ManagerEntry[];
      try {
        list = await this.entries(r);
      } catch {
        continue;
      }
      const page = siteOf(host);
      for (const e of list) {
        const site = e.urls
          .map((u) => ({ site: siteOfUrl(u.url, u.exact), exact: u.exact }))
          .find((u) => u.site && (u.exact ? page === u.site : siteMatches(host, u.site)))?.site;
        if (!site) continue;
        try {
          const l = await this.driver(r).login(e.ref);
          if (!l.password) continue;
          out.push({
            id: `${MANAGER_ID_PREFIX}${r.id}:${e.ref}`,
            site,
            username: l.username,
            password: l.password,
            totp: l.totp ? totpSecret(l.totp) : null,
          });
        } catch {
          // One sign-in that cannot be read does not keep the others back.
        }
      }
    }
    return out;
  }
}
