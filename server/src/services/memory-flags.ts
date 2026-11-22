import { and, asc, count, eq, inArray, lt, notInArray, or, sql } from 'drizzle-orm';
import type { MemoryFlag } from '@leafbot/shared';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, newId, notFound } from '../util';
import { OWNER_ID } from '../users';
import type { MemoryReach } from './memory';
import { dice, wordsOf } from './routine-suggestions';
import type { Services } from './index';

/** Flags one turn may raise: a bot told to look for gaps finds some, not a list of everything. */
export const FLAGS_PER_TURN = 3;
/** Open flags one bot may have; past this it is told so, and the person has a list to work through. */
export const OPEN_FLAGS_PER_BOT = 50;
/** A flag raised once and left this long goes; one raised again stays, as a gap met more than once. */
export const FLAG_EXPIRE_MS = 60 * 86_400_000;
/** How alike two flags' words must be to be the same gap. */
const SAME_GAP = 0.6;
/** What of a flag goes into a conversation review's request, at most. */
export const FLAGS_PER_REVIEW = 10;

export type FlagRow = typeof schema.memoryFlags.$inferSelect;
type Db = Ctx['db'];

/** What a bot hands in when it raises a flag; the service fills in whose it is. */
export interface FlagInput {
  kind: 'missing' | 'wrong';
  about: string;
  seen: string | null;
  memoryId: string | null;
  skillId: string | null;
  sourceUrl: string | null;
  botId: string;
  userId: string;
  place: string | null;
  outside: FlagRow['outside'];
  threadId: string;
  turnId: string;
}

export type RaiseResult =
  | { status: 'raised'; id: string }
  | { status: 'again'; id: string }
  | { status: 'turnFull' }
  | { status: 'botFull' };

const OPEN = ['open', 'proposed'] as const;

/**
 * Flags whose note just changed or went: whoever changed it settled what the flag was about, or
 * took the note away. Called by the memory service for every change of a note's words.
 */
export async function settleNoteFlags(db: Db, memoryIds: string[]): Promise<void> {
  if (!memoryIds.length) return;
  const settled = await db
    .update(schema.memoryFlags)
    .set({ status: 'resolved', resolvedBy: 'note-changed', resolvedAt: new Date() })
    .where(
      and(inArray(schema.memoryFlags.memoryId, memoryIds), inArray(schema.memoryFlags.status, [...OPEN])),
    )
    .returning({ changeId: schema.memoryFlags.changeId });
  // A page's answer waiting for the person was read against the note's old words: taking it now
  // would undo the change just made.
  const stale = settled.flatMap((f) => (f.changeId ? [f.changeId] : []));
  if (stale.length) await db.delete(schema.memoryChanges).where(inArray(schema.memoryChanges.id, stale));
}

/**
 * A flag that waited on a memory change, once the person decided: settled when they took it, put
 * aside when they turned it down, so the same page is not offered again for the same gap.
 */
export async function settleChangeFlags(db: Db, changeId: string, accepted: boolean): Promise<void> {
  await db
    .update(schema.memoryFlags)
    .set(
      accepted
        ? { status: 'resolved', resolvedBy: 'source', resolvedAt: new Date() }
        : { status: 'dismissed', resolvedAt: new Date() },
    )
    .where(and(eq(schema.memoryFlags.changeId, changeId), eq(schema.memoryFlags.status, 'proposed')));
}

/** Whose a flag about nothing in particular is: the bot's, the person's or the place's, as its scope says. */
const flagReachable = (reach: MemoryReach) =>
  or(
    and(eq(schema.memoryFlags.scope, 'user'), eq(schema.memoryFlags.userId, reach.userId)),
    reach.botIds.length
      ? and(eq(schema.memoryFlags.scope, 'bot'), inArray(schema.memoryFlags.botId, reach.botIds))
      : sql`false`,
    reach.places.length
      ? and(eq(schema.memoryFlags.scope, 'room'), inArray(schema.memoryFlags.place, reach.places))
      : sql`false`,
  )!;

/** Whether `reach` may see and change the note a flag is about (see `MemoryService.canEdit`). */
const noteReachable = (reach: MemoryReach) =>
  or(
    and(eq(schema.memories.scope, 'user'), eq(schema.memories.userId, reach.userId)),
    reach.botIds.length
      ? and(eq(schema.memories.scope, 'bot'), inArray(schema.memories.botId, reach.botIds))
      : sql`false`,
    reach.places.length
      ? and(eq(schema.memories.scope, 'room'), inArray(schema.memories.place, reach.places))
      : sql`false`,
  )!;

/**
 * The SQL condition for the flags `reach` sees, for a query joined with the flag's note: a flag
 * about a note goes to those who may change that note, which a manager bot's flag on another
 * bot's note is not the manager's people's to see; any other flag goes by its own scope.
 */
const reachable = (reach: MemoryReach) =>
  or(
    and(sql`${schema.memories.id} is null`, flagReachable(reach)),
    and(sql`${schema.memories.id} is not null`, noteReachable(reach)),
  )!;

/** One bot's flags are raised one at a time, so the limits below hold when a turn calls the tool in parallel. */
const lanes = new Map<string, Promise<unknown>>();
function oneAtATime<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const next = (lanes.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn);
  lanes.set(key, next);
  void next
    .finally(() => {
      if (lanes.get(key) === next) lanes.delete(key);
    })
    .catch(() => undefined);
  return next;
}

/**
 * The gaps bots found in what they know and could not fill themselves: a fact their notes lack,
 * or a note or skill that disagrees with what they saw. A flag is seen by those who would see the
 * note it is about, and settled by whoever knows the answer: the person, a later conversation the
 * review reads, or the page the bot named.
 */
export class MemoryFlagService {
  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  /**
   * Keeps a flag, or counts it again when the bot already has an open one for the same gap: the
   * same note or skill and kind, or, for a gap about nothing in particular, words alike enough.
   */
  raise(input: FlagInput): Promise<RaiseResult> {
    return oneAtATime(input.botId, () => this.raiseNow(input));
  }

  private async raiseNow(input: FlagInput): Promise<RaiseResult> {
    const { db } = this.ctx;
    const [inTurn] = await db
      .select({ n: count() })
      .from(schema.memoryFlags)
      .where(eq(schema.memoryFlags.turnId, input.turnId));
    if ((inTurn?.n ?? 0) >= FLAGS_PER_TURN) return { status: 'turnFull' };

    const open = await db
      .select()
      .from(schema.memoryFlags)
      .where(and(eq(schema.memoryFlags.botId, input.botId), inArray(schema.memoryFlags.status, [...OPEN])));
    const words = wordsOf(input.about);
    const same = open.find(
      (f) =>
        f.kind === input.kind &&
        (input.memoryId || input.skillId
          ? f.memoryId === input.memoryId && f.skillId === input.skillId
          : !f.memoryId && !f.skillId && dice(wordsOf(f.about), words) >= SAME_GAP),
    );
    const now = this.clock();
    if (same) {
      // The same turn raising it twice met the gap once.
      if (same.turnId === input.turnId || same.againTurns.includes(input.turnId))
        return { status: 'again', id: same.id };
      await db
        .update(schema.memoryFlags)
        .set({
          count: sql`${schema.memoryFlags.count} + 1`,
          againTurns: [...same.againTurns, input.turnId],
          lastSeenAt: now,
          ...(input.seen && { seen: input.seen }),
          ...(input.sourceUrl && !same.sourceUrl && { sourceUrl: input.sourceUrl }),
        })
        .where(eq(schema.memoryFlags.id, same.id));
      this.ctx.bus.refresh({ scope: 'memory' });
      return { status: 'again', id: same.id };
    }
    if (open.length >= OPEN_FLAGS_PER_BOT) return { status: 'botFull' };

    // Whose the flag is: that of the note it is about, else the bot's.
    let scope: FlagRow['scope'] = 'bot';
    let userId: string | null = input.userId;
    let place: string | null = null;
    if (input.memoryId) {
      const note = await this.services.memory.get(input.memoryId);
      scope = note.scope;
      if (note.scope === 'user') userId = note.userId ?? OWNER_ID;
      if (note.scope === 'room') place = note.place ?? input.place;
      // A note from a page is read against the page again at the next tidy-up, ahead of the rest.
      if (note.sourceUrl)
        await db
          .update(schema.memories)
          .set({ sourceCheckedAt: null })
          .where(eq(schema.memories.id, note.id));
    }
    const id = newId();
    await db.insert(schema.memoryFlags).values({
      id,
      kind: input.kind,
      scope,
      botId: input.botId,
      userId,
      place,
      memoryId: input.memoryId,
      skillId: input.skillId,
      about: input.about,
      seen: input.seen,
      sourceUrl: input.sourceUrl,
      outside: input.outside,
      threadId: input.threadId,
      turnId: input.turnId,
      createdAt: now,
      lastSeenAt: now,
    });
    this.ctx.bus.refresh({ scope: 'memory' });
    return { status: 'raised', id };
  }

  /** The flags `reach` sees that wait for an answer, the most often raised first. */
  async list(reach: MemoryReach): Promise<MemoryFlag[]> {
    const rows = await this.ctx.db
      .select({
        flag: schema.memoryFlags,
        note: schema.memories.content,
        skill: schema.skills.name,
      })
      .from(schema.memoryFlags)
      .leftJoin(schema.memories, eq(schema.memories.id, schema.memoryFlags.memoryId))
      .leftJoin(schema.skills, eq(schema.skills.id, schema.memoryFlags.skillId))
      .where(and(inArray(schema.memoryFlags.status, [...OPEN]), reachable(reach)))
      .orderBy(asc(schema.memoryFlags.createdAt));
    return rows
      .map(({ flag: f, note, skill }) => ({
        id: f.id,
        kind: f.kind,
        scope: f.scope,
        botId: f.botId,
        about: f.about,
        seen: f.seen,
        memoryId: f.memoryId,
        note: note ?? null,
        skill: skill ?? null,
        sourceUrl: f.sourceUrl,
        outside: !!f.outside,
        // The conversation is the person's own: others who see the flag see what it says, not where.
        threadId: f.userId === reach.userId ? f.threadId : null,
        count: f.count,
        status: f.status as MemoryFlag['status'],
        createdAt: f.createdAt.toISOString(),
        lastSeenAt: f.lastSeenAt.toISOString(),
      }))
      .sort((a, b) => b.count - a.count || a.createdAt.localeCompare(b.createdAt));
  }

  /** The flags `reach` sees that wait, those whose page's answer waits for them included, as `list` shows them. */
  async openCount(reach: MemoryReach): Promise<number> {
    const [row] = await this.ctx.db
      .select({ n: count() })
      .from(schema.memoryFlags)
      .leftJoin(schema.memories, eq(schema.memories.id, schema.memoryFlags.memoryId))
      .where(and(inArray(schema.memoryFlags.status, [...OPEN]), reachable(reach)));
    return row?.n ?? 0;
  }

  /** A flag `reach` sees and that still waits; anything else is not theirs to see. */
  private async waiting(id: string, reach: MemoryReach): Promise<FlagRow> {
    const [row] = await this.ctx.db
      .select({ flag: schema.memoryFlags })
      .from(schema.memoryFlags)
      .leftJoin(schema.memories, eq(schema.memories.id, schema.memoryFlags.memoryId))
      .where(
        and(eq(schema.memoryFlags.id, id), inArray(schema.memoryFlags.status, [...OPEN]), reachable(reach)),
      )
      .limit(1);
    if (!row) throw notFound('memoryFlag');
    return row.flag;
  }

  /**
   * The person's answer to a flag. For a note, the note takes their words; for a skill, the
   * answer is added to it, or waits for the skill's owner as a change; otherwise it becomes a
   * note of the person's own, with the flag's scope. Either way the words are the person's, so
   * the tidy-up leaves them alone.
   */
  async answer(id: string, text: string, reach: MemoryReach): Promise<void> {
    const flag = await this.waiting(id, reach);
    const { memory, skills } = this.services;
    const actor = `user:${reach.userId}`;
    const words = text.trim();
    if (!words) throw new HttpError(400, 'error.flagAnswerEmpty');

    if (flag.skillId) {
      // A skill reaches every bot that has it: someone who may not change it leaves the answer for
      // its owner, as a bot's change to a skill does.
      const skill = await skills.get(flag.skillId);
      const body = `${skill.body.trimEnd()}\n\n${words}\n`;
      if (await skills.mayChange(skill.id, await skills.reachOf(reach.userId))) {
        await skills.update(skill.id, { body });
      } else {
        await skills.propose({
          skillId: skill.id,
          description: skill.description,
          body,
          reason: flag.about,
          proposedBy: flag.botId,
          userId: reach.userId,
          threadId: flag.threadId,
        });
      }
    } else {
      const note = flag.memoryId ? await memory.get(flag.memoryId).catch(() => null) : null;
      if (note) await memory.update(note.id, { content: words, sourceUrl: null }, actor);
      else
        await memory.create({
          scope: flag.scope,
          botId: flag.scope === 'bot' ? flag.botId : null,
          userId: flag.scope === 'user' ? (flag.userId ?? reach.userId) : null,
          place: flag.scope === 'room' ? flag.place : null,
          content: words,
          source: 'user',
          actor,
        });
    }
    // Set after the note's change, which settles the note's flags as changed by someone else.
    await this.ctx.db
      .update(schema.memoryFlags)
      .set({ status: 'resolved', resolution: words, resolvedBy: actor, resolvedAt: this.clock() })
      .where(eq(schema.memoryFlags.id, flag.id));
    this.ctx.bus.refresh({ scope: 'memory' });
  }

  async dismiss(id: string, reach: MemoryReach): Promise<void> {
    const flag = await this.waiting(id, reach);
    await this.ctx.db
      .update(schema.memoryFlags)
      .set({ status: 'dismissed', resolvedBy: `user:${reach.userId}`, resolvedAt: this.clock() })
      .where(eq(schema.memoryFlags.id, flag.id));
    this.ctx.bus.refresh({ scope: 'memory' });
  }

  /**
   * The open flags a conversation review may settle: those of the bot, of the person's own notes
   * and of the place, never one raised after outside text (its words are not the person's).
   */
  async forReview(botId: string, person: string | null, place: string | null): Promise<FlagRow[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.memoryFlags)
      .where(
        and(
          eq(schema.memoryFlags.status, 'open'),
          sql`${schema.memoryFlags.outside} is null`,
          // A skill is settled by whoever may change it, not by a note the review writes.
          sql`${schema.memoryFlags.skillId} is null`,
          eq(schema.memoryFlags.botId, botId),
          or(
            eq(schema.memoryFlags.scope, 'bot'),
            person
              ? and(eq(schema.memoryFlags.scope, 'user'), eq(schema.memoryFlags.userId, person))
              : sql`false`,
            place
              ? and(eq(schema.memoryFlags.scope, 'room'), eq(schema.memoryFlags.place, place))
              : sql`false`,
          ),
        ),
      )
      .orderBy(asc(schema.memoryFlags.createdAt))
      .limit(FLAGS_PER_REVIEW);
    return rows;
  }

  /** Marks a flag settled by someone other than a person: the review, or a page. */
  async settle(id: string, by: 'review' | 'source', resolution: string): Promise<void> {
    await this.ctx.db
      .update(schema.memoryFlags)
      .set({ status: 'resolved', resolution, resolvedBy: by, resolvedAt: this.clock() })
      .where(
        and(
          eq(schema.memoryFlags.id, id),
          // The note's own change, made a moment ago on the way, settled it already as "changed".
          or(eq(schema.memoryFlags.status, 'open'), eq(schema.memoryFlags.resolvedBy, 'note-changed')),
        ),
      );
    this.ctx.bus.refresh({ scope: 'memory' });
  }

  /** A flag whose page's answer now waits as a memory change for the person. */
  async proposed(id: string, changeId: string): Promise<void> {
    await this.ctx.db
      .update(schema.memoryFlags)
      .set({ status: 'proposed', changeId, checkedAt: this.clock() })
      .where(eq(schema.memoryFlags.id, id));
  }

  /** A flag whose page was read without an answer: it is not read again. */
  async checked(id: string): Promise<void> {
    await this.ctx.db
      .update(schema.memoryFlags)
      .set({ checkedAt: this.clock() })
      .where(eq(schema.memoryFlags.id, id));
  }

  /**
   * Open flags with a page not read yet, the oldest first, for the tidy-up to read, leaving out
   * those of `skipBots`: bots whose pages cannot be read now.
   */
  async withUnreadPage(limit: number, skipBots: string[] = []): Promise<FlagRow[]> {
    return this.ctx.db
      .select()
      .from(schema.memoryFlags)
      .where(
        and(
          eq(schema.memoryFlags.status, 'open'),
          sql`${schema.memoryFlags.sourceUrl} is not null`,
          sql`${schema.memoryFlags.checkedAt} is null`,
          sql`${schema.memoryFlags.outside} is null`,
          skipBots.length ? notInArray(schema.memoryFlags.botId, skipBots) : undefined,
        ),
      )
      .orderBy(asc(schema.memoryFlags.createdAt))
      .limit(limit);
  }

  /**
   * What a stopped or undone turn said about gaps goes with it: what it saw is no longer trusted.
   * A flag it raised and nothing else met goes; one it met again counts it once less. A flag
   * already settled stays, with how it was settled.
   */
  async dropForTurn(turnId: string): Promise<void> {
    const { db } = this.ctx;
    await db
      .delete(schema.memoryFlags)
      .where(
        and(
          eq(schema.memoryFlags.turnId, turnId),
          eq(schema.memoryFlags.count, 1),
          inArray(schema.memoryFlags.status, [...OPEN]),
        ),
      );
    await db
      .update(schema.memoryFlags)
      .set({ count: sql`${schema.memoryFlags.count} - 1` })
      .where(and(eq(schema.memoryFlags.turnId, turnId), sql`${schema.memoryFlags.count} > 1`));
    await db
      .update(schema.memoryFlags)
      .set({
        count: sql`greatest(${schema.memoryFlags.count} - 1, 1)`,
        againTurns: sql`${schema.memoryFlags.againTurns} - ${turnId}::text`,
      })
      .where(sql`${schema.memoryFlags.againTurns} @> ${JSON.stringify([turnId])}::jsonb`);
    this.ctx.bus.refresh({ scope: 'memory' });
  }

  /** Lets flags raised once and left for `FLAG_EXPIRE_MS` go. */
  async expire(): Promise<number> {
    const cutoff = new Date(this.clock().getTime() - FLAG_EXPIRE_MS);
    const gone = await this.ctx.db
      .update(schema.memoryFlags)
      .set({ status: 'expired', resolvedAt: this.clock() })
      .where(
        and(
          eq(schema.memoryFlags.status, 'open'),
          eq(schema.memoryFlags.count, 1),
          lt(schema.memoryFlags.lastSeenAt, cutoff),
        ),
      )
      .returning({ id: schema.memoryFlags.id });
    if (gone.length) this.ctx.bus.refresh({ scope: 'memory' });
    return gone.length;
  }
}
