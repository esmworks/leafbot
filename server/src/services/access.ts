import type { Bot, BotAccess, BotLevel, Group, Role } from '@leafbot/shared';
import { and, desc, eq, exists, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { OWNER_ID } from '../users';
import type { SummaryScope, ThreadScope } from './threads';
import { HttpError, notFound } from '../util';
import { privateHost } from './skill-link';

/** Who is asking: a signed-in person, or the access key standing for the owner. */
export interface Viewer {
  userId: string;
  role: Role;
}

const RANK: Record<BotLevel, number> = { none: 0, chat: 1, edit: 2 };

/** Whether a level reaches the one wanted. */
export const atLeast = (level: BotLevel, wanted: BotLevel) => RANK[level] >= RANK[wanted];

/** Whether a role looks after the whole server: its owner and the admins. */
export const managesServer = (role: Role) => role === 'owner' || role === 'admin';

/**
 * Whether an address someone keeps must stay on the public internet: a person's own, unless they
 * look after the server. The server sends those requests itself, so an address on this machine,
 * its private network or a cloud's metadata service would let anyone with an account read what is
 * there. What the team keeps (null) only those who look after the server set, and they may point
 * it at a service next to the server.
 */
export async function keptPublic(ctx: Ctx, owner: string | null): Promise<boolean> {
  if (!owner || owner === OWNER_ID) return false;
  const [person] = await ctx.db
    .select({ role: schema.users.role, disabledAt: schema.users.disabledAt })
    .from(schema.users)
    .where(eq(schema.users.id, owner))
    .limit(1);
  return !person || !!person.disabledAt || !managesServer(person.role);
}

/** Refuses an address on this machine or a private network that `owner` may not give. */
export async function refusePrivate(ctx: Ctx, url: string, owner: string | null): Promise<void> {
  if ((await keptPublic(ctx, owner)) && (await privateHost(new URL(url).hostname))) {
    throw new HttpError(400, 'error.addressPrivate');
  }
}

/**
 * What a person may do with a bot. Its owner may change it, and so may those who look after the
 * server while it is in a team space (`inSpace`); a bot in someone's Private is theirs alone, the
 * server's owner and admins included. Anyone else gets the highest of what everyone gets, what
 * they were given and what the bot's team space gives its members (`space`, none when not in it).
 */
export function botLevel(
  viewer: Viewer,
  bot: { ownerUserId: string; access: BotAccess; inSpace?: boolean },
  space: BotLevel = 'none',
): BotLevel {
  if (bot.ownerUserId === viewer.userId) return 'edit';
  if (bot.inSpace && managesServer(viewer.role)) return 'edit';
  let level = bot.access.everyone;
  for (const l of [bot.access.people[viewer.userId], space]) if (l && RANK[l] > RANK[level]) level = l;
  return level;
}

/** What being in a team space gives: talking with its bots, or changing them too when it says so. */
const spaceLevel = (membersEdit: boolean): BotLevel => (membersEdit ? 'edit' : 'chat');

/**
 * The place a bot is in: whether it is a team space, and its members with what it gives each of
 * them. A Private folder, or none, is no space and has no members.
 */
export async function spaceOf(
  ctx: Ctx,
  groupId: string | null,
): Promise<{ inSpace: boolean; members: Map<string, BotLevel> }> {
  if (!groupId) return { inSpace: false, members: new Map() };
  const [group] = await ctx.db
    .select({ ownerUserId: schema.groups.ownerUserId, membersEdit: schema.groups.membersEdit })
    .from(schema.groups)
    .where(eq(schema.groups.id, groupId))
    .limit(1);
  if (!group || group.ownerUserId) return { inSpace: false, members: new Map() };
  const rows = await ctx.db
    .select({ userId: schema.groupMembers.userId })
    .from(schema.groupMembers)
    .where(eq(schema.groupMembers.groupId, groupId));
  const level = spaceLevel(group.membersEdit);
  return { inSpace: true, members: new Map(rows.map((r) => [r.userId, level])) };
}

/** The team spaces one person is in, with what each gives them. */
async function spacesOf(ctx: Ctx, userId: string): Promise<Map<string, BotLevel>> {
  const rows = await ctx.db
    .select({ groupId: schema.groupMembers.groupId, membersEdit: schema.groups.membersEdit })
    .from(schema.groupMembers)
    .innerJoin(schema.groups, eq(schema.groups.id, schema.groupMembers.groupId))
    .where(eq(schema.groupMembers.userId, userId));
  return new Map(rows.map((r) => [r.groupId, spaceLevel(r.membersEdit)]));
}

/**
 * Whether a person sees a group: their own Private folder, a team space everyone sees, or a secret
 * one they are in. Those who look after the server see every space, never another's folder.
 */
export function seesGroup(viewer: Viewer, group: Group): boolean {
  if (group.ownerUserId) return group.ownerUserId === viewer.userId;
  if (group.kind !== 'secret') return true;
  return managesServer(viewer.role) || !!group.memberIds?.includes(viewer.userId);
}

/** The columns of a bot its level is worked out from, with its group's owner (a folder's). */
const LEVEL_COLUMNS = {
  id: schema.bots.id,
  ownerUserId: schema.bots.ownerUserId,
  access: schema.bots.access,
  groupId: schema.bots.groupId,
  folderOwner: schema.groups.ownerUserId,
};
type LevelRow = { groupId: string | null; folderOwner: string | null };
/** Whether a bot is in a team space: in a group that is nobody's folder. */
const inSpace = (b: LevelRow) => !!b.groupId && !b.folderOwner;

type ThreadRow = typeof schema.threads.$inferSelect;

/** How long the people a conversation's live events go to are remembered. */
const AUDIENCE_MS = 10_000;

/**
 * Who may see and use what: bots by level, conversations by whose they are. A bot a person may
 * not use is answered with "not found", so nobody learns of bots they are not shown.
 */
export class AccessService {
  private audiences = new Map<string, { users: string[]; at: number }>();

  constructor(private ctx: Ctx) {}

  /** Forgets who the live events go to; whenever a bot's sharing, a team space's members or the people change. */
  forget() {
    this.audiences.clear();
  }

  private async bot(botId: string) {
    const [row] = await this.ctx.db
      .select(LEVEL_COLUMNS)
      .from(schema.bots)
      .leftJoin(schema.groups, eq(schema.groups.id, schema.bots.groupId))
      .where(eq(schema.bots.id, botId))
      .limit(1);
    return row ? { ...row, inSpace: inSpace(row) } : null;
  }

  async level(viewer: Viewer, botId: string): Promise<BotLevel> {
    const bot = await this.bot(botId);
    if (!bot) return 'none';
    const space = (await spaceOf(this.ctx, bot.groupId)).members.get(viewer.userId);
    return botLevel(viewer, bot, space);
  }

  /** Every bot's level for one person, in one read. */
  async levels(viewer: Viewer): Promise<Map<string, BotLevel>> {
    const [rows, spaces] = await Promise.all([
      this.ctx.db
        .select(LEVEL_COLUMNS)
        .from(schema.bots)
        .leftJoin(schema.groups, eq(schema.groups.id, schema.bots.groupId)),
      spacesOf(this.ctx, viewer.userId),
    ]);
    return new Map(
      rows.map((b) => [
        b.id,
        botLevel(viewer, { ...b, inSpace: inSpace(b) }, b.groupId ? spaces.get(b.groupId) : undefined),
      ]),
    );
  }

  /** The bots a person reaches at least at `wanted`. */
  async botIds(viewer: Viewer, wanted: BotLevel = 'chat'): Promise<string[]> {
    return [...(await this.levels(viewer))].filter(([, l]) => atLeast(l, wanted)).map(([id]) => id);
  }

  /** Refuses a bot a person may not use as asked: unseen ones as not found, the rest as forbidden. */
  async requireBot(viewer: Viewer, botId: string, wanted: BotLevel): Promise<BotLevel> {
    const level = await this.level(viewer, botId);
    if (level === 'none') throw notFound('bot');
    if (!atLeast(level, wanted)) throw new HttpError(403, 'error.botEditOnly');
    return level;
  }

  /**
   * Whether a person sees a conversation: their own, a team conversation of a bot they may talk
   * with, or the bot's own work when they may change the bot. Nobody sees another person's
   * conversations, the server's owner and admins included.
   */
  async seesThread(viewer: Viewer, row: Pick<ThreadRow, 'userId' | 'botId' | 'kind'>): Promise<boolean> {
    if (row.userId) return row.userId === viewer.userId;
    return atLeast(await this.level(viewer, row.botId), row.kind === 'team' ? 'chat' : 'edit');
  }

  /**
   * A conversation a person may see, or not found. To write in it they must still be able to talk
   * with its bot (in a room, with every bot in it): a bot no longer shared with them keeps their
   * conversations readable, not writable.
   */
  async requireThread(viewer: Viewer, threadId: string, write: boolean, manage = false): Promise<ThreadRow> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId))
      .limit(1);
    if (!row || !(await this.seesThread(viewer, row))) throw notFound('thread');
    // A team conversation is everyone's: only those who may change its bot rename, empty or delete it.
    if (manage && row.kind === 'team' && !atLeast(await this.level(viewer, row.botId), 'edit')) {
      throw new HttpError(403, 'error.teamThreadManage');
    }
    if (write) {
      const botIds =
        row.kind === 'room'
          ? (
              await this.ctx.db
                .select({ botId: schema.roomMembers.botId })
                .from(schema.roomMembers)
                .where(eq(schema.roomMembers.roomId, row.id))
            ).map((m) => m.botId)
          : [row.botId];
      for (const botId of botIds) {
        if (!atLeast(await this.level(viewer, botId), 'chat')) throw new HttpError(403, 'error.botNotShared');
      }
    }
    return row;
  }

  /** A person as a viewer; someone no longer here counts as a member, reaching only what is shared with everyone. */
  async viewerOf(userId: string): Promise<Viewer> {
    const [row] = await this.ctx.db
      .select({ role: schema.users.role, disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    return { userId, role: row && !row.disabledAt ? row.role : 'member' };
  }

  /**
   * A bot one bot reaches for a person while it works: the bot itself, or another the person
   * reaches at least at `wanted`. A bot works for someone, so it reaches no further than they do.
   */
  async reach(person: string, from: { id: string }, target: Bot, wanted: BotLevel): Promise<Bot> {
    // Talking with itself needs nothing; changing itself needs what changing any bot needs.
    if (target.id === from.id && wanted === 'chat') return target;
    if (!atLeast(await this.level(await this.viewerOf(person), target.id), wanted)) throw notFound('bot');
    return target;
  }

  /**
   * Whether anyone besides its owner reaches a bot: shared with everyone or with someone, or in a
   * team space with people in it. What a bot nobody else reaches does is its owner's alone.
   */
  async sharedWithAnyone(bot: { access?: BotAccess; groupId: string | null }): Promise<boolean> {
    const access = bot.access ?? { everyone: 'none', people: {} };
    if (access.everyone !== 'none' || Object.keys(access.people).length) return true;
    return (await spaceOf(this.ctx, bot.groupId)).members.size > 0;
  }

  /**
   * Refuses a place a person may not put a bot in. A new bot goes only to its owner's Private:
   * none, or a folder of theirs. A folder holds only its owner's bots, put there by them. A bot
   * goes into a team space by its owner, who must be in the space, or by those who look after the
   * server; its notes and the space's shared folder then reach the space's people.
   */
  async checkPlace(
    viewer: Viewer,
    groupId: string | null | undefined,
    ownerUserId: string | undefined,
    creating = false,
  ) {
    if (!groupId) return;
    const owner = ownerUserId ?? OWNER_ID;
    const [group] = await this.ctx.db
      .select({ ownerUserId: schema.groups.ownerUserId })
      .from(schema.groups)
      .where(eq(schema.groups.id, groupId))
      .limit(1);
    if (!group) throw notFound('group');
    if (group.ownerUserId) {
      if (group.ownerUserId !== viewer.userId || owner !== viewer.userId) {
        throw new HttpError(403, 'error.folderNotYours');
      }
      return;
    }
    if (creating) throw new HttpError(400, 'error.newBotPrivate');
    if (managesServer(viewer.role)) return;
    if (owner !== viewer.userId || !(await spaceOf(this.ctx, groupId)).members.has(viewer.userId)) {
      throw new HttpError(403, 'error.spaceNotYours');
    }
  }

  /** The person who owns a bot; the server's owner when the bot is gone. */
  async botOwner(botId: string): Promise<string> {
    return (await this.bot(botId))?.ownerUserId ?? OWNER_ID;
  }

  /**
   * The person a conversation stands for: whose it is, or for the bot's own work, the bot's owner.
   * What the bot hands over from such work goes to them.
   */
  async personOf(row: { userId?: string | null; botId: string }): Promise<string> {
    return row.userId ?? (await this.botOwner(row.botId));
  }

  /** What a bot reads of its other conversations while it works in one: that person's, and its own work. */
  seenFrom(person: string): SQL {
    // A rehearsal's conversation is not one of its other conversations.
    return and(
      or(eq(schema.threads.userId, person), isNull(schema.threads.userId)),
      ne(schema.threads.kind, 'rehearsal'),
    )!;
  }

  private async people(): Promise<Viewer[]> {
    return this.ctx.db
      .select({ userId: schema.users.id, role: schema.users.role })
      .from(schema.users)
      .where(isNull(schema.users.disabledAt));
  }

  /** Which of a bot's conversations a person's list holds. */
  async listScope(viewer: Viewer, botId: string): Promise<ThreadScope> {
    const level = await this.level(viewer, botId);
    return { userId: viewer.userId, botWork: atLeast(level, 'edit'), team: atLeast(level, 'chat') };
  }

  /** One person's sidebar: the bots they reach and the conversations they see. */
  async summaryScope(viewer: Viewer): Promise<SummaryScope> {
    const levels = [...(await this.levels(viewer))];
    const editable = levels.filter(([, l]) => atLeast(l, 'edit')).map(([id]) => id);
    const botIds = levels.filter(([, l]) => atLeast(l, 'chat')).map(([id]) => id);
    return {
      botIds,
      editable,
      seen: this.threadsSeenBy(viewer, editable, botIds),
      answerable: this.cardsAnswerableBy(viewer, editable),
    };
  }

  /**
   * The cards a person may answer, as a condition on approvals joined with their conversation: in a
   * team conversation only the one whose request asked and those who may change the bot answer, so
   * the others are not listed a card they would be refused.
   */
  private cardsAnswerableBy(viewer: Viewer, editable: string[]): SQL {
    return or(
      ne(schema.threads.kind, 'team'),
      editable.length ? inArray(schema.threads.botId, editable) : undefined,
      exists(
        this.ctx.db
          .select({ id: schema.turns.id })
          .from(schema.turns)
          .where(and(eq(schema.turns.id, schema.approvals.turnId), eq(schema.turns.userId, viewer.userId))),
      ),
    )!;
  }

  /** The people who reach a bot at least at `wanted`; remembered a few seconds, like audiences. */
  async botPeople(botId: string, wanted: BotLevel): Promise<string[]> {
    const key = `bot:${botId}:${wanted}`;
    const now = Date.now();
    const kept = this.audiences.get(key);
    if (kept && now - kept.at < AUDIENCE_MS) return kept.users;
    const bot = await this.bot(botId);
    const { members } = await spaceOf(this.ctx, bot?.groupId ?? null);
    const users = bot
      ? (await this.people())
          .filter((p) => atLeast(botLevel(p, bot, members.get(p.userId)), wanted))
          .map((p) => p.userId)
      : [];
    this.audiences.set(key, { users, at: now });
    return users;
  }

  /**
   * The people a conversation's live events go to: its person; for a team conversation, everyone
   * who may talk with its bot; otherwise those who may change its bot.
   */
  async threadAudience(threadId: string): Promise<string[]> {
    const now = Date.now();
    const kept = this.audiences.get(`thread:${threadId}`);
    if (kept && now - kept.at < AUDIENCE_MS) return kept.users;
    const [row] = await this.ctx.db
      .select({ userId: schema.threads.userId, botId: schema.threads.botId, kind: schema.threads.kind })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId))
      .limit(1);
    const users = !row
      ? []
      : row.userId
        ? [row.userId]
        : await this.botPeople(row.botId, row.kind === 'team' ? 'chat' : 'edit');
    this.audiences.set(`thread:${threadId}`, { users, at: now });
    return users;
  }

  /**
   * Who is told a conversation needs them or answered: its people, but in a team conversation only
   * the one whose request runs there and those who may change the bot. The others still see it,
   * yet only these may answer its cards, so a notice would call them to something they cannot do.
   */
  async noticeAudience(threadId: string): Promise<string[]> {
    const [row] = await this.ctx.db
      .select({ botId: schema.threads.botId, kind: schema.threads.kind })
      .from(schema.threads)
      .where(eq(schema.threads.id, threadId))
      .limit(1);
    if (row?.kind !== 'team') return this.threadAudience(threadId);
    // The running turn is the one a card waits on; a line someone else wrote meanwhile only queues
    // one. With none running, the last that ran is the one a reply or error is about.
    const [last] = await this.ctx.db
      .select({ userId: schema.turns.userId })
      .from(schema.turns)
      .where(and(eq(schema.turns.threadId, threadId), ne(schema.turns.status, 'queued')))
      .orderBy(sql`(${schema.turns.status} = 'running') desc`, desc(schema.turns.createdAt))
      .limit(1);
    const editors = await this.botPeople(row.botId, 'edit');
    return last?.userId && !editors.includes(last.userId) ? [...editors, last.userId] : editors;
  }

  /** The conversations of one bot a person sees, by id, among `threadIds`. */
  async visibleThreads(viewer: Viewer, threadIds: string[]): Promise<Set<string>> {
    if (!threadIds.length) return new Set();
    const rows = await this.ctx.db
      .select({
        id: schema.threads.id,
        userId: schema.threads.userId,
        botId: schema.threads.botId,
        kind: schema.threads.kind,
      })
      .from(schema.threads)
      .where(inArray(schema.threads.id, threadIds));
    const levels = await this.levels(viewer);
    return new Set(
      rows
        .filter((r) =>
          r.userId
            ? r.userId === viewer.userId
            : atLeast(levels.get(r.botId) ?? 'none', r.kind === 'team' ? 'chat' : 'edit'),
        )
        .map((r) => r.id),
    );
  }

  /**
   * The SQL condition for the conversations a person sees, given the bots they may change and
   * those they may talk with (whose team conversations they see).
   */
  threadsSeenBy(viewer: Viewer, editableBotIds: string[], chatBotIds: string[] = editableBotIds): SQL {
    const own = eq(schema.threads.userId, viewer.userId);
    const work = editableBotIds.length
      ? and(isNull(schema.threads.userId), inArray(schema.threads.botId, editableBotIds))
      : undefined;
    const team = chatBotIds.length
      ? and(
          eq(schema.threads.kind, 'team'),
          isNull(schema.threads.userId),
          inArray(schema.threads.botId, chatBotIds),
        )
      : undefined;
    return or(own, work, team)!;
  }
}
