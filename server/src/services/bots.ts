import { homedir } from 'node:os';
import {
  leavesForEngine,
  type Bot,
  type BotAccess,
  type BotCreate,
  type BotEngineChoice,
  type BotMove,
  type BotUpdate,
  type Group,
  type GroupMove,
  type SpaceKind,
  type SpaceRequest,
} from '@leafbot/shared';
import { and, asc, eq, inArray, isNotNull, isNull, max, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, newId, notFound } from '../util';
import { projectDirProblem } from '../workspace';
import { OWNER_ID } from '../users';
import { toBot, toGroup } from './mappers';

type Tx = Parameters<Parameters<Ctx['db']['transaction']>[0]>[0];

export class BotService {
  constructor(private ctx: Ctx) {}

  async list(opts: { includeArchived?: boolean } = {}): Promise<Bot[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.bots)
      .where(opts.includeArchived ? undefined : isNull(schema.bots.archivedAt))
      .orderBy(asc(schema.bots.position), asc(schema.bots.createdAt));
    return rows.map(toBot);
  }

  async get(id: string): Promise<Bot> {
    const [row] = await this.ctx.db.select().from(schema.bots).where(eq(schema.bots.id, id)).limit(1);
    if (!row) throw notFound('bot');
    return toBot(row);
  }

  /** Find by id or (case-insensitive) name, for tools where the model names a bot. */
  /**
   * A bot by id or name. When several bots share the name, the one in the same sidebar group as
   * `near` (the bot asking) wins, since that is the one its person most likely means.
   */
  async resolve(ref: string, near?: Pick<Bot, 'id' | 'groupId'>): Promise<Bot> {
    const bots = await this.list();
    const byId = bots.find((b) => b.id === ref);
    if (byId) return byId;
    const lower = ref.trim().toLowerCase();
    const named = bots.filter((b) => b.name.toLowerCase() === lower && b.id !== near?.id);
    const bot =
      (near && named.find((b) => b.groupId === near.groupId)) ??
      named[0] ??
      bots.find((b) => b.name.toLowerCase() === lower);
    if (!bot) throw new HttpError(404, 'error.noBotNamed', { ref });
    return bot;
  }

  /** Refuses a project folder that would hand the bot far more than a project. */
  private checkProjectDir(dir: string | null | undefined) {
    if (!dir) return;
    const problem = projectDirProblem(dir, { home: homedir(), dataDir: this.ctx.config.dataDir });
    if (problem) throw new HttpError(400, problem);
  }

  /** A new bot of `ownerUserId`'s, shared with nobody else yet. */
  async create(input: BotCreate, ownerUserId: string = OWNER_ID): Promise<Bot> {
    if (input.groupId) await this.getGroup(input.groupId);
    this.checkProjectDir(input.projectDir);
    const [last] = await this.ctx.db.select({ n: max(schema.bots.position) }).from(schema.bots);
    // A new bot goes to the end of its section; managers start out pinned.
    const [row] = await this.ctx.db
      .insert(schema.bots)
      .values({ id: newId(), ...input, ownerUserId, pinned: input.isManager, position: (last?.n ?? -1) + 1 })
      .returning();
    this.ctx.bus.refresh({ scope: 'bots' });
    return toBot(row!);
  }

  async update(id: string, patch: BotUpdate): Promise<Bot> {
    const before = await this.get(id);
    // A bot whose instructions are kept in a document takes them from there, after the person
    // accepts them; a form opened before an accepted change must not write the old ones back.
    const linked = patch.instructionsUrl !== undefined ? patch.instructionsUrl : before.instructionsUrl;
    if (linked) delete patch.instructions;
    // Another document, or none: what waited from the old one goes.
    const relinked =
      patch.instructionsUrl !== undefined &&
      (patch.instructionsUrl ?? null) !== (before.instructionsUrl ?? null);
    if (patch.groupId) await this.getGroup(patch.groupId);
    if (patch.projectDir !== undefined && patch.projectDir !== before.projectDir)
      this.checkProjectDir(patch.projectDir);
    const leaves = !!patch.engine && patch.engine !== before.engine;
    const row = await this.ctx.db.transaction(async (tx) => {
      if (leaves) await this.leaveEngine(tx, id);
      const [saved] = await tx
        .update(schema.bots)
        .set({
          ...patch,
          ...(relinked && {
            instructionsPending: null,
            instructionsDocHash: null,
            instructionsCheckedAt: null,
            instructionsError: null,
          }),
          updatedAt: new Date(),
        })
        .where(eq(schema.bots.id, id))
        .returning();
      return saved;
    });
    this.ctx.bus.refresh({ scope: 'bots' });
    if (leaves) this.ctx.bus.refresh({ scope: 'routines' });
    return toBot(row!);
  }

  /**
   * Moves every active bot to `target`, what new bots start with, in one write; returns how
   * many changed. Archived bots stay as they are.
   */
  async moveAllTo(target: BotEngineChoice): Promise<number> {
    const moving = (await this.list()).filter((b) => leavesForEngine(b, target));
    if (!moving.length) return 0;
    await this.ctx.db.transaction(async (tx) => {
      for (const bot of moving) {
        if (bot.engine !== target.engine) await this.leaveEngine(tx, bot.id);
        // Only bots on another provider move to Claude, so none of them keeps a model there.
        await tx
          .update(schema.bots)
          .set({ engine: target.engine, model: target.model, updatedAt: new Date() })
          .where(eq(schema.bots.id, bot.id));
      }
    });
    this.ctx.bus.refresh({ scope: 'bots' });
    this.ctx.bus.refresh({ scope: 'routines' });
    return moving.length;
  }

  /** What a bot leaves behind when it moves to the other engine. */
  private async leaveEngine(tx: Tx, botId: string) {
    // A session belongs to the engine that made it; the other engine cannot resume it, so the
    // next turn starts a new one with the recent exchange. A room member keeps its own session.
    await tx
      .update(schema.threads)
      .set({ engineSessionId: null, engineSessionCostUsd: null })
      .where(eq(schema.threads.botId, botId));
    await tx
      .update(schema.roomMembers)
      .set({ engineSessionId: null, engineSessionCostUsd: null })
      .where(eq(schema.roomMembers.botId, botId));
    // A routine's own model names one of the old engine's models; its runs take the bot's model.
    await tx.update(schema.routines).set({ model: '' }).where(eq(schema.routines.botId, botId));
  }

  /** Moves a bot to another place in the sidebar and renumbers the section it lands in. */
  /** Who else may talk with the bot or change it. */
  async setAccess(id: string, access: BotAccess): Promise<Bot> {
    const { ownerUserId } = await this.get(id);
    // The bot's own owner needs no share of it.
    const people = Object.fromEntries(Object.entries(access.people).filter(([p]) => p !== ownerUserId));
    const [row] = await this.ctx.db
      .update(schema.bots)
      .set({ access: { everyone: access.everyone, people }, updatedAt: new Date() })
      .where(eq(schema.bots.id, id))
      .returning();
    this.ctx.bus.refresh({ scope: 'bots' });
    return toBot(row!);
  }

  /** A person leaves: the bots they made pass to `heir`, and no bot is shared with them any more. */
  async leftBy(userId: string, heir: string) {
    const rows = await this.ctx.db
      .select({ id: schema.bots.id, access: schema.bots.access, ownerUserId: schema.bots.ownerUserId })
      .from(schema.bots);
    for (const r of rows) {
      const shared = userId in r.access.people;
      if (!shared && r.ownerUserId !== userId) continue;
      const people = Object.fromEntries(
        Object.entries(r.access.people).filter(([p]) => p !== userId && p !== heir),
      );
      await this.ctx.db
        .update(schema.bots)
        .set({
          access: { everyone: r.access.everyone, people },
          ...(r.ownerUserId === userId && { ownerUserId: heir }),
        })
        .where(eq(schema.bots.id, r.id));
    }
    this.ctx.bus.refresh({ scope: 'bots' });
  }

  async move(id: string, to: BotMove): Promise<Bot> {
    const bot = await this.get(id);
    if (!to.pinned && to.groupId) await this.getGroup(to.groupId);
    const groupId = to.pinned ? bot.groupId : to.groupId;
    const section = (await this.list()).filter(
      (b) => b.id !== id && b.pinned === to.pinned && (to.pinned || b.groupId === groupId),
    );
    const at = to.beforeId ? section.findIndex((b) => b.id === to.beforeId) : -1;
    const ordered = section.map((b) => b.id);
    ordered.splice(at < 0 ? ordered.length : at, 0, id);
    await this.ctx.db.transaction(async (tx) => {
      for (const [position, botId] of ordered.entries()) {
        const fields = botId === id ? { position, pinned: to.pinned, groupId } : { position };
        await tx.update(schema.bots).set(fields).where(eq(schema.bots.id, botId));
      }
    });
    this.ctx.bus.refresh({ scope: 'bots' });
    return this.get(id);
  }

  async archive(id: string): Promise<Bot> {
    await this.get(id);
    const [row] = await this.ctx.db
      .update(schema.bots)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.bots.id, id))
      .returning();
    this.ctx.bus.refresh({ scope: 'bots' });
    return toBot(row!);
  }

  async restore(id: string): Promise<Bot> {
    const [row] = await this.ctx.db
      .update(schema.bots)
      .set({ archivedAt: null, updatedAt: new Date() })
      .where(eq(schema.bots.id, id))
      .returning();
    if (!row) throw notFound('bot');
    this.ctx.bus.refresh({ scope: 'bots' });
    return toBot(row);
  }

  /**
   * Removes an archived bot for good, with its conversations, memory and routines. Only an
   * archived bot can go, so a bot is never lost to one wrong click.
   */
  async purge(id: string): Promise<void> {
    const bot = await this.get(id);
    if (!bot.archivedAt) throw new HttpError(409, 'error.botNotArchived');
    // Purging is meant to leave nothing of the bot, and the history of its notes holds their words.
    await this.ctx.db
      .delete(schema.auditLog)
      .where(and(eq(schema.auditLog.targetType, 'memory'), eq(schema.auditLog.owner, `bot:${id}`)));
    // Notes of the bot that another bot's turn changed (a manager's) are in that turn's journal too.
    await this.ctx.db
      .delete(schema.turnChanges)
      .where(and(eq(schema.turnChanges.kind, 'memory'), eq(schema.turnChanges.scopeBotId, id)));
    await this.ctx.db.delete(schema.bots).where(eq(schema.bots.id, id));
    // Saved sign-ins, keys and APIs kept for some bots name them by id: a bot that is gone leaves
    // those lists, and one kept for it alone is then open to none.
    for (const table of [
      schema.vaultLogins,
      schema.apiCredentials,
      schema.apiSources,
      schema.passwordManagers,
      schema.paymentCards,
      schema.contactDetails,
    ]) {
      await this.ctx.db
        .update(table)
        .set({ botIds: sql`${table.botIds} - ${id}::text` })
        .where(sql`${table.botIds} @> jsonb_build_array(${id}::text)`);
    }
    this.ctx.bus.refresh({ scope: 'bots' });
    this.ctx.bus.refresh({ scope: 'vault' });
    this.ctx.bus.refresh({ scope: 'info' });
  }

  /** Pauses the bot, or lets it work again. Its running work is stopped by the caller. */
  async setPaused(id: string, paused: boolean): Promise<Bot> {
    await this.get(id);
    const [row] = await this.ctx.db
      .update(schema.bots)
      .set({ pausedAt: paused ? new Date() : null, updatedAt: new Date() })
      .where(eq(schema.bots.id, id))
      .returning();
    this.ctx.bus.refresh({ scope: 'bots' });
    return toBot(row!);
  }

  /** Pauses every bot of a group, or lets them work again; the bots keep their own pause. */
  async setGroupPaused(id: string, paused: boolean): Promise<Group> {
    const [row] = await this.ctx.db
      .update(schema.groups)
      .set({ pausedAt: paused ? new Date() : null })
      .where(eq(schema.groups.id, id))
      .returning();
    if (!row) throw notFound('group');
    this.ctx.bus.refresh({ scope: 'groups' });
    this.ctx.bus.refresh({ scope: 'bots' });
    return toGroup(row);
  }

  /**
   * Pauses every active bot, or lets every bot work again: on resume the groups' pauses are
   * cleared too, so nothing stays held. Returns the bots it paused or let go.
   */
  async setAllPaused(paused: boolean): Promise<string[]> {
    const now = new Date();
    const rows = await this.ctx.db
      .update(schema.bots)
      .set({ pausedAt: paused ? now : null, updatedAt: now })
      .where(
        paused
          ? and(isNull(schema.bots.archivedAt), isNull(schema.bots.pausedAt))
          : isNotNull(schema.bots.pausedAt),
      )
      .returning({ id: schema.bots.id });
    if (!paused) await this.ctx.db.update(schema.groups).set({ pausedAt: null });
    this.ctx.bus.refresh({ scope: 'bots' });
    this.ctx.bus.refresh({ scope: 'groups' });
    return rows.map((r) => r.id);
  }

  /** The bots that start no work now: paused themselves, or in a paused group. */
  async pausedIds(): Promise<Set<string>> {
    const rows = await this.ctx.db
      .select({ id: schema.bots.id })
      .from(schema.bots)
      .leftJoin(schema.groups, eq(schema.groups.id, schema.bots.groupId))
      .where(or(isNotNull(schema.bots.pausedAt), isNotNull(schema.groups.pausedAt)));
    return new Set(rows.map((r) => r.id));
  }

  /** Whether the bot starts no work now, paused itself or with its group. */
  async isPaused(bot: Pick<Bot, 'id' | 'pausedAt' | 'groupId'>): Promise<boolean> {
    if (bot.pausedAt) return true;
    if (!bot.groupId) return false;
    const [group] = await this.ctx.db
      .select({ pausedAt: schema.groups.pausedAt })
      .from(schema.groups)
      .where(eq(schema.groups.id, bot.groupId))
      .limit(1);
    return !!group?.pausedAt;
  }

  /** The active bots of a group. */
  async groupBotIds(id: string): Promise<string[]> {
    const rows = await this.ctx.db
      .select({ id: schema.bots.id })
      .from(schema.bots)
      .where(and(eq(schema.bots.groupId, id), isNull(schema.bots.archivedAt)));
    return rows.map((r) => r.id);
  }

  /** A person's active bots in their Private: owned by them and in no team space. */
  async privateBotIds(userId: string): Promise<string[]> {
    const rows = await this.ctx.db
      .select({ id: schema.bots.id, groupId: schema.bots.groupId, folderOwner: schema.groups.ownerUserId })
      .from(schema.bots)
      .leftJoin(schema.groups, eq(schema.groups.id, schema.bots.groupId))
      .where(and(eq(schema.bots.ownerUserId, userId), isNull(schema.bots.archivedAt)));
    return rows.filter((r) => !r.groupId || r.folderOwner).map((r) => r.id);
  }

  /** Who may message whom: any bot any other active bot. Groups only share a folder. */
  canMessage(from: Bot, to: Bot): boolean {
    return from.id !== to.id && !to.archivedAt;
  }

  /** Every group with the people in it: team spaces and everyone's Private folders. */
  async listGroups(): Promise<Group[]> {
    const [rows, members] = await Promise.all([
      this.ctx.db
        .select()
        .from(schema.groups)
        .orderBy(asc(schema.groups.position), asc(schema.groups.createdAt)),
      this.ctx.db
        .select({ groupId: schema.groupMembers.groupId, userId: schema.groupMembers.userId })
        .from(schema.groupMembers)
        .orderBy(asc(schema.groupMembers.createdAt)),
    ]);
    const of = new Map<string, string[]>();
    for (const m of members) of.set(m.groupId, [...(of.get(m.groupId) ?? []), m.userId]);
    return rows.map((r) => toGroup(r, of.get(r.id)));
  }

  async getGroup(id: string): Promise<Group> {
    const [row] = await this.ctx.db.select().from(schema.groups).where(eq(schema.groups.id, id)).limit(1);
    if (!row) throw notFound('group');
    const members = await this.ctx.db
      .select({ userId: schema.groupMembers.userId })
      .from(schema.groupMembers)
      .where(eq(schema.groupMembers.groupId, id))
      .orderBy(asc(schema.groupMembers.createdAt));
    return toGroup(
      row,
      members.map((m) => m.userId),
    );
  }

  /** A team space, or with `ownerUserId` a folder in that person's Private. */
  async createGroup(
    name: string,
    opts: { ownerUserId?: string | null; kind?: SpaceKind; membersEdit?: boolean } = {},
  ): Promise<Group> {
    const [last] = await this.ctx.db.select({ n: max(schema.groups.position) }).from(schema.groups);
    const [row] = await this.ctx.db
      .insert(schema.groups)
      .values({
        id: newId(),
        name,
        position: (last?.n ?? -1) + 1,
        ownerUserId: opts.ownerUserId ?? null,
        ...(opts.kind && { kind: opts.kind }),
        ...(opts.membersEdit !== undefined && { membersEdit: opts.membersEdit }),
      })
      .returning();
    this.ctx.bus.refresh({ scope: 'groups' });
    return toGroup(row!);
  }

  /** Changes who sees a team space and what its members may do with its bots. */
  async setSpace(id: string, patch: { kind?: SpaceKind; membersEdit?: boolean }): Promise<Group> {
    const group = await this.getGroup(id);
    if (group.ownerUserId) throw new HttpError(400, 'error.notASpace');
    if (patch.kind !== undefined || patch.membersEdit !== undefined) {
      await this.ctx.db
        .update(schema.groups)
        .set({
          ...(patch.kind !== undefined && { kind: patch.kind }),
          ...(patch.membersEdit !== undefined && { membersEdit: patch.membersEdit }),
        })
        .where(eq(schema.groups.id, id));
      this.ctx.bus.refresh({ scope: 'groups' });
      this.ctx.bus.refresh({ scope: 'bots' });
    }
    return this.getGroup(id);
  }

  /** Puts people in a team space or takes them out; a Private folder has no members. */
  async setSpaceMembers(id: string, change: { add?: string[]; remove?: string[] }): Promise<Group> {
    const group = await this.getGroup(id);
    if (group.ownerUserId) throw new HttpError(400, 'error.notASpace');
    const add = [...new Set(change.add ?? [])];
    if (add.length) {
      const known = await this.ctx.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(inArray(schema.users.id, add));
      if (known.length !== add.length) throw notFound('person');
    }
    await this.ctx.db.transaction(async (tx) => {
      for (const userId of change.add ?? []) {
        await tx.insert(schema.groupMembers).values({ groupId: id, userId }).onConflictDoNothing();
      }
      // Someone put in the space no longer waits to join it.
      if (change.add?.length) {
        await tx
          .delete(schema.spaceRequests)
          .where(and(eq(schema.spaceRequests.groupId, id), inArray(schema.spaceRequests.userId, change.add)));
      }
      if (change.remove?.length) {
        await tx
          .delete(schema.groupMembers)
          .where(
            and(eq(schema.groupMembers.groupId, id), inArray(schema.groupMembers.userId, change.remove)),
          );
      }
    });
    this.ctx.bus.refresh({ scope: 'groups' });
    this.ctx.bus.refresh({ scope: 'bots' });
    return this.getGroup(id);
  }

  /**
   * Asks to join a closed space for `userId`; true when the request is new, false when they had
   * already asked.
   */
  async requestSpace(groupId: string, userId: string): Promise<boolean> {
    const made = await this.ctx.db
      .insert(schema.spaceRequests)
      .values({ id: newId(), groupId, userId })
      .onConflictDoNothing()
      .returning({ id: schema.spaceRequests.id });
    if (made.length) this.ctx.bus.refresh({ scope: 'groups' });
    return made.length > 0;
  }

  /** Takes back the person's request to join a space, if they had one. */
  async dropSpaceRequest(groupId: string, userId: string): Promise<void> {
    const gone = await this.ctx.db
      .delete(schema.spaceRequests)
      .where(and(eq(schema.spaceRequests.groupId, groupId), eq(schema.spaceRequests.userId, userId)))
      .returning({ id: schema.spaceRequests.id });
    if (gone.length) this.ctx.bus.refresh({ scope: 'groups' });
  }

  /** The spaces the person asked to join and waits for. */
  async requestedSpaces(userId: string): Promise<string[]> {
    const rows = await this.ctx.db
      .select({ groupId: schema.spaceRequests.groupId })
      .from(schema.spaceRequests)
      .where(eq(schema.spaceRequests.userId, userId));
    return rows.map((r) => r.groupId);
  }

  /** Every request waiting to be answered, oldest first; a disabled person's wait unseen. */
  async spaceRequests(): Promise<SpaceRequest[]> {
    const rows = await this.ctx.db
      .select({
        id: schema.spaceRequests.id,
        groupId: schema.spaceRequests.groupId,
        userId: schema.spaceRequests.userId,
        createdAt: schema.spaceRequests.createdAt,
      })
      .from(schema.spaceRequests)
      .innerJoin(schema.users, eq(schema.users.id, schema.spaceRequests.userId))
      .where(isNull(schema.users.disabledAt))
      .orderBy(asc(schema.spaceRequests.createdAt));
    return rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() }));
  }

  /** Lets the person in (`allow`) or not; either way the request is answered and goes. */
  async answerSpaceRequest(id: string, allow: boolean): Promise<void> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.spaceRequests)
      .where(eq(schema.spaceRequests.id, id))
      .limit(1);
    if (!row) throw notFound('spaceRequest');
    if (allow) await this.setSpaceMembers(row.groupId, { add: [row.userId] });
    else await this.dropSpaceRequest(row.groupId, row.userId);
  }

  async renameGroup(id: string, name: string): Promise<Group> {
    const [row] = await this.ctx.db
      .update(schema.groups)
      .set({ name })
      .where(eq(schema.groups.id, id))
      .returning();
    if (!row) throw notFound('group');
    this.ctx.bus.refresh({ scope: 'groups' });
    return toGroup(row);
  }

  /** Moves a group to another place in the sidebar and renumbers the groups. */
  async moveGroup(id: string, to: GroupMove): Promise<Group> {
    const group = await this.getGroup(id);
    const ordered = (await this.listGroups()).filter((g) => g.id !== id).map((g) => g.id);
    const at = to.beforeId ? ordered.indexOf(to.beforeId) : -1;
    ordered.splice(at < 0 ? ordered.length : at, 0, id);
    await this.ctx.db.transaction(async (tx) => {
      for (const [position, groupId] of ordered.entries()) {
        await tx.update(schema.groups).set({ position }).where(eq(schema.groups.id, groupId));
      }
    });
    this.ctx.bus.refresh({ scope: 'groups' });
    return group;
  }

  /**
   * Deletes a group. Its bots stay where they are on the pinned row, or go to the end of the
   * ungrouped bots; they lose the group's shared folder, which is left on disk.
   */
  async deleteGroup(id: string) {
    await this.getGroup(id);
    const bots = await this.list();
    const members = bots.filter((b) => b.groupId === id && !b.pinned);
    const ungrouped = bots.filter((b) => !b.pinned && !b.groupId);
    await this.ctx.db.transaction(async (tx) => {
      for (const [i, bot] of members.entries()) {
        await tx
          .update(schema.bots)
          .set({ position: ungrouped.length + i })
          .where(eq(schema.bots.id, bot.id));
      }
      // Archived and pinned bots let go of the group too.
      await tx.update(schema.bots).set({ groupId: null }).where(eq(schema.bots.groupId, id));
      await tx.delete(schema.groups).where(eq(schema.groups.id, id));
    });
    this.ctx.bus.refresh({ scope: 'bots' });
    this.ctx.bus.refresh({ scope: 'groups' });
  }
}

/** Lower case without accents, with Turkish letters folded to their plain Latin ones. */
function plain(text: string): string {
  return text.trim().toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/\p{M}/gu, '');
}

function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * The names closest to what a bot wrote for a teammate, for a "did you mean" hint: names it starts
 * or is part of, then names a few typos away. At most `limit`, nearest first; the caller passes
 * only names the asker may see, so no hint reveals a bot it cannot reach.
 */
export function closestNames(ref: string, names: string[], limit = 3): string[] {
  const wanted = plain(ref);
  if (!wanted) return [];
  const allowed = Math.max(1, Math.floor(wanted.length / 3));
  const scored: { name: string; score: number }[] = [];
  for (const name of new Set(names)) {
    const p = plain(name);
    if (!p) continue;
    // A very short name inside a longer word says nothing about what was meant.
    const part = p.length >= 3 && wanted.includes(p);
    let score: number;
    if (p.startsWith(wanted) || (part && wanted.startsWith(p))) score = 0;
    else if (p.includes(wanted) || part) score = 1;
    else {
      const d = editDistance(wanted, p);
      if (d > allowed) continue;
      score = 1 + d;
    }
    scored.push({ name, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((s) => s.name);
}
