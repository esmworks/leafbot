import {
  findMentions,
  lastResetIndex,
  outsideIn,
  type Bot,
  type Message,
  type OutsideTrigger,
  type Room,
  type RoomCreate,
  type RoomPeopleChange,
  type RoomSend,
  type RoomUpdate,
} from '@leafbot/shared';
import { and, asc, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { isSilentReply, SILENT_REPLY, type TurnOutcome } from '../engine/types';
import type { T } from '../i18n';
import { HANDOFF_CHARS, HANDOFF_MESSAGE_CHARS } from '../runtime/prompt';
import type { TurnRow } from '../runtime/turns';
import { cappedMode, STRICTNESS } from './approvals';
import { HttpError, newId, notFound, truncate } from '../util';
import type { Services } from '.';

type RoomRow = typeof schema.rooms.$inferSelect;
type MemberRow = typeof schema.roomMembers.$inferSelect;

/** Room lines a member is shown when it starts a new session there. */
export const ROOM_WINDOW = 30;
/** Turns bots may start for one another beyond the rounds, per message of the person. */
const MENTION_TURNS = 4;
/** Hard cap on the turns bots start for one another per message of the person. */
const MAX_BOT_TURNS = 40;

/**
 * Rooms: one thread where the person and several bots talk. Every member's turn runs in that one
 * thread, so only one speaks at a time and stopping the room stops them all. A message of the
 * person is answered by the members it names (or every member, as the room is set); a bot's
 * answer that names another member gives that one a turn; and the room may go on for a few rounds
 * of the bots talking among themselves. Each message of the person sets a fresh budget for that.
 */
export class RoomService {
  /** Where each running turn's prompt ended, saved as the member's place once the turn succeeds. */
  private cursors = new Map<string, Date>();

  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  private async roomRow(id: string): Promise<RoomRow | null> {
    const [row] = await this.ctx.db.select().from(schema.rooms).where(eq(schema.rooms.id, id)).limit(1);
    return row ?? null;
  }

  private async members(roomId: string): Promise<MemberRow[]> {
    return this.ctx.db
      .select()
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.roomId, roomId))
      .orderBy(asc(schema.roomMembers.position));
  }

  /** Members that can speak now, in speaking order. */
  private async activeBots(roomId: string): Promise<Bot[]> {
    const ids = (await this.members(roomId)).map((m) => m.botId);
    const bots = await this.services.bots.list();
    return ids.map((id) => bots.find((b) => b.id === id)).filter((b): b is Bot => !!b);
  }

  async isRoom(threadId: string): Promise<boolean> {
    return !!(await this.roomRow(threadId));
  }

  /** One person's rooms, those they opened and those they were put in; every room without `userId`. */
  async list(userId?: string): Promise<Room[]> {
    const putIn = this.ctx.db
      .select({ id: schema.roomPeople.roomId })
      .from(schema.roomPeople)
      .where(eq(schema.roomPeople.userId, userId ?? ''));
    const rows = await this.ctx.db
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(
        and(
          eq(schema.threads.kind, 'room'),
          userId ? or(eq(schema.threads.userId, userId), inArray(schema.threads.id, putIn)) : undefined,
        ),
      )
      .orderBy(desc(schema.threads.updatedAt));
    return Promise.all(rows.map((r) => this.get(r.id)));
  }

  async get(id: string): Promise<Room> {
    const room = await this.roomRow(id);
    if (!room) throw notFound('room');
    const thread = await this.services.threads.get(id);
    const members = await this.members(id);
    const owner = await this.services.threads.row(id);
    const putIn = await this.ctx.db
      .select({ userId: schema.roomPeople.userId, addedBy: schema.roomPeople.addedBy })
      .from(schema.roomPeople)
      .where(eq(schema.roomPeople.roomId, id))
      .orderBy(asc(schema.roomPeople.createdAt));
    const people = putIn.map((p) => p.userId);
    const faces = members.length
      ? await this.ctx.db
          .select({
            id: schema.bots.id,
            name: schema.bots.name,
            color: schema.bots.color,
            avatar: schema.bots.avatar,
            material: schema.bots.material,
          })
          .from(schema.bots)
          .where(
            and(
              inArray(
                schema.bots.id,
                members.map((m) => m.botId),
              ),
              isNull(schema.bots.archivedAt),
            ),
          )
      : [];
    const [speaking] = await this.ctx.db
      .select({ botId: schema.turns.botId })
      .from(schema.turns)
      .where(and(eq(schema.turns.threadId, id), eq(schema.turns.status, 'running')))
      .limit(1);
    // A room started fresh lists as empty until something new is said in it.
    const [last] = await this.services.threads.messages(id, { limit: 1 });
    return {
      id,
      title: thread.title,
      goal: thread.goal ?? '',
      members: members.map((m) => m.botId),
      responders: room.responders,
      rounds: room.rounds,
      minutes: room.minutes,
      meeting: await this.services.meetings.open(id),
      state: thread.state,
      speakerId: speaking?.botId ?? null,
      preview: last?.props.kind === 'contextReset' ? null : thread.preview,
      ...(owner.userId && { ownerId: owner.userId }),
      people,
      addedBy: Object.fromEntries(putIn.map((p) => [p.userId, p.addedBy])),
      faces,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
    };
  }

  /** The bots exactly as given, checked: each exists, is not archived, and comes once. */
  private async checkedBots(ids: string[]): Promise<string[]> {
    const unique = [...new Set(ids)];
    const bots = await this.services.bots.list();
    if (!unique.every((id) => bots.some((b) => b.id === id))) throw new HttpError(400, 'error.roomBots');
    return unique;
  }

  /** A room of `userId`'s, with bots they may talk with (the caller checks that). */
  async create(input: RoomCreate, userId: string): Promise<Room> {
    const botIds = await this.checkedBots(input.botIds);
    const id = newId();
    await this.ctx.db.insert(schema.threads).values({
      id,
      botId: botIds[0]!,
      userId,
      kind: 'room',
      title: input.title,
      goal: input.goal ?? '',
    });
    await this.ctx.db.insert(schema.rooms).values({
      id,
      responders: input.responders ?? 'everyone',
      rounds: input.rounds ?? 0,
      minutes: input.minutes ?? 'ask',
    });
    await this.ctx.db
      .insert(schema.roomMembers)
      .values(botIds.map((botId, position) => ({ roomId: id, botId, position })));
    this.ctx.bus.refresh({ scope: 'rooms' });
    return this.get(id);
  }

  async update(id: string, patch: RoomUpdate): Promise<Room> {
    if (!(await this.roomRow(id))) throw notFound('room');
    if (patch.title !== undefined || patch.goal !== undefined) {
      await this.ctx.db
        .update(schema.threads)
        .set({
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.goal !== undefined && { goal: patch.goal }),
        })
        .where(eq(schema.threads.id, id));
    }
    if (patch.responders !== undefined || patch.rounds !== undefined || patch.minutes !== undefined) {
      await this.ctx.db
        .update(schema.rooms)
        .set({
          ...(patch.responders !== undefined && { responders: patch.responders }),
          ...(patch.rounds !== undefined && { rounds: patch.rounds }),
          ...(patch.minutes !== undefined && { minutes: patch.minutes }),
        })
        .where(eq(schema.rooms.id, id));
    }
    if (patch.botIds) await this.setMembers(id, await this.checkedBots(patch.botIds));
    this.ctx.bus.refresh({ scope: 'rooms' });
    return this.get(id);
  }

  /** New membership in this order; members that stay keep their session and place. */
  private async setMembers(id: string, botIds: string[]) {
    const now = await this.members(id);
    const gone = now.filter((m) => !botIds.includes(m.botId)).map((m) => m.botId);
    if (gone.length) {
      await this.ctx.db
        .delete(schema.roomMembers)
        .where(and(eq(schema.roomMembers.roomId, id), inArray(schema.roomMembers.botId, gone)));
    }
    for (const [position, botId] of botIds.entries()) {
      if (now.some((m) => m.botId === botId)) {
        await this.ctx.db
          .update(schema.roomMembers)
          .set({ position })
          .where(and(eq(schema.roomMembers.roomId, id), eq(schema.roomMembers.botId, botId)));
      } else {
        await this.ctx.db.insert(schema.roomMembers).values({ roomId: id, botId, position });
      }
    }
    await this.ctx.db.update(schema.threads).set({ botId: botIds[0]! }).where(eq(schema.threads.id, id));
  }

  /**
   * Puts people in the room, or takes them out; returns those newly put in. The owner is in it
   * already, and someone who may no longer sign in is not put in.
   */
  async setPeople(id: string, change: RoomPeopleChange, by: string): Promise<string[]> {
    if (!(await this.roomRow(id))) throw notFound('room');
    const owner = (await this.services.threads.row(id)).userId;
    const before = new Set(await this.services.access.roomPeople(id));
    const wanted = [...new Set(change.add ?? [])].filter((u) => u !== owner && !before.has(u));
    const able = wanted.length
      ? (
          await this.ctx.db
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(and(inArray(schema.users.id, wanted), isNull(schema.users.disabledAt)))
        ).map((r) => r.id)
      : [];
    if (able.length !== wanted.length) throw notFound('person');
    // The first person put in: the bots start afresh, since their sessions may hold what the owner's
    // own notes or connections gave them, which the others are not to read. The room's lines stay.
    // Not while one of them works: its turn would keep the old session when it ends.
    if (able.length && !before.size) {
      if ((await this.services.threads.state(id)) !== 'idle') throw new HttpError(409, 'error.roomBusy');
      await this.ctx.db
        .update(schema.roomMembers)
        .set({ engineSessionId: null, engineSessionCostUsd: null, seenAt: null })
        .where(eq(schema.roomMembers.roomId, id));
    }
    if (able.length) {
      await this.ctx.db
        .insert(schema.roomPeople)
        .values(able.map((userId) => ({ roomId: id, userId, addedBy: by })));
    }
    if (change.remove?.length) {
      await this.ctx.db
        .delete(schema.roomPeople)
        .where(and(eq(schema.roomPeople.roomId, id), inArray(schema.roomPeople.userId, change.remove)));
    }
    this.services.access.forget();
    this.ctx.bus.refresh({ scope: 'rooms' });
    return able;
  }

  /**
   * The rooms a person opened pass on before they are removed: to the earliest admin in the room,
   * else to the earliest one put in it. A room with nobody else goes with them.
   */
  async passOn(userId: string): Promise<void> {
    const owned = await this.ctx.db
      .select({ id: schema.threads.id })
      .from(schema.threads)
      .where(and(eq(schema.threads.kind, 'room'), eq(schema.threads.userId, userId)));
    for (const { id } of owned) {
      const people = await this.ctx.db
        .select({ userId: schema.roomPeople.userId, role: schema.users.role })
        .from(schema.roomPeople)
        .innerJoin(schema.users, eq(schema.users.id, schema.roomPeople.userId))
        .where(and(eq(schema.roomPeople.roomId, id), isNull(schema.users.disabledAt)))
        .orderBy(asc(schema.roomPeople.createdAt));
      const heir = people.find((p) => p.role === 'owner' || p.role === 'admin') ?? people[0];
      if (!heir) continue;
      await this.ctx.db.update(schema.threads).set({ userId: heir.userId }).where(eq(schema.threads.id, id));
      await this.ctx.db
        .delete(schema.roomPeople)
        .where(and(eq(schema.roomPeople.roomId, id), eq(schema.roomPeople.userId, heir.userId)));
    }
    this.services.access.forget();
    this.ctx.bus.refresh({ scope: 'rooms' });
  }

  /**
   * Marks the lines a person wrote in rooms before they are removed. Their id goes from the lines
   * with them, and a line with no person would otherwise read as the room's opener's.
   */
  async markWriterGone(userId: string): Promise<void> {
    await this.ctx.db
      .update(schema.messages)
      .set({ props: sql`${schema.messages.props} || '{"writerGone": true}'::jsonb` })
      .where(
        and(
          eq(schema.messages.userId, userId),
          inArray(schema.messages.threadId, this.ctx.db.select({ id: schema.rooms.id }).from(schema.rooms)),
        ),
      );
  }

  /** What each person in the room is called to its bots: their own name, else their username. */
  private async names(roomId: string, t: T): Promise<Map<string, string>> {
    const owner = (await this.services.threads.row(roomId)).userId;
    const ids = [...(owner ? [owner] : []), ...(await this.services.access.roomPeople(roomId))];
    const rows = ids.length
      ? await this.ctx.db
          .select({
            id: schema.users.id,
            displayName: schema.users.displayName,
            username: schema.users.username,
          })
          .from(schema.users)
          .where(inArray(schema.users.id, ids))
      : [];
    const names = new Map<string, string>();
    for (const id of ids) {
      const row = rows.find((r) => r.id === id);
      const own = (await this.services.settings.all(id)).userName;
      names.set(id, own || row?.displayName || row?.username || t('room.person'));
    }
    return names;
  }

  async remove(id: string) {
    if (!(await this.roomRow(id))) throw notFound('room');
    await this.stop(id);
    await this.ctx.db.delete(schema.threads).where(eq(schema.threads.id, id));
    // The room's own notes are for that room only; with it gone nobody reaches them.
    await this.services.memory.removePlace(`room:${id}`);
    this.ctx.bus.refresh({ scope: 'rooms' });
  }

  /**
   * A bot about to be removed for good leaves its rooms first. The room's thread points at one
   * member, so it is moved to another; a room left with no one goes with the bot.
   */
  async removeBot(botId: string) {
    const rows = await this.ctx.db
      .select({ roomId: schema.roomMembers.roomId })
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.botId, botId));
    for (const { roomId } of rows) {
      const rest = (await this.members(roomId)).filter((m) => m.botId !== botId).map((m) => m.botId);
      if (rest.length) await this.setMembers(roomId, rest);
    }
    if (rows.length) this.ctx.bus.refresh({ scope: 'rooms' });
  }

  /**
   * Stops whoever speaks, drops who waits, ends the discussion under way, and stops the work its
   * members gave other bots.
   */
  async stop(id: string): Promise<boolean> {
    await this.ctx.db
      .update(schema.rooms)
      .set({ roundsLeft: 0, botTurnsLeft: 0 })
      .where(eq(schema.rooms.id, id));
    const stopped = await this.services.turns.interrupt(id);
    // The work its members handed to other bots stops with it.
    const teammates = await this.services.jobs.stopFrom(id);
    return stopped || teammates > 0;
  }

  /**
   * The room starts afresh: its lines stay, but every member's session ends and its next one reads
   * only what is said after the line marking the reset. Refused while a member speaks or waits,
   * so no turn under way carries the old talk past it.
   */
  async reset(id: string, t: T) {
    if (!(await this.roomRow(id))) throw notFound('room');
    if ((await this.services.threads.state(id)) !== 'idle') throw new HttpError(409, 'error.roomBusy');
    await this.ctx.db
      .update(schema.roomMembers)
      .set({ engineSessionId: null, engineSessionCostUsd: null, seenAt: null })
      .where(eq(schema.roomMembers.roomId, id));
    await this.ctx.db
      .update(schema.rooms)
      .set({ roundsLeft: 0, roundSpoke: false, botTurnsLeft: 0 })
      .where(eq(schema.rooms.id, id));
    await this.services.threads.resetContext(id, t, 'room.contextReset');
    this.ctx.bus.refresh({ scope: 'rooms' });
  }

  /** The member's engine session in the room, and what it had cost by its last run. */
  async session(roomId: string, botId: string): Promise<{ id: string | null; costUsd: number | null }> {
    const [m] = await this.ctx.db
      .select({ id: schema.roomMembers.engineSessionId, costUsd: schema.roomMembers.engineSessionCostUsd })
      .from(schema.roomMembers)
      .where(and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.botId, botId)))
      .limit(1);
    return { id: m?.id ?? null, costUsd: m?.costUsd ?? null };
  }

  async setSessionCost(roomId: string, botId: string, costUsd: number) {
    await this.ctx.db
      .update(schema.roomMembers)
      .set({ engineSessionCostUsd: costUsd })
      .where(and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.botId, botId)));
  }

  async setSession(roomId: string, botId: string, sessionId: string | null) {
    await this.ctx.db
      .update(schema.roomMembers)
      .set({ engineSessionId: sessionId, ...(sessionId === null && { engineSessionCostUsd: null }) })
      .where(and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.botId, botId)));
  }

  /**
   * What the system prompt says about the room to one of its members. With several people in it,
   * they are all named, since each line says who wrote it.
   */
  async context(roomId: string, bot: Bot, user: string, t: T) {
    const thread = await this.services.threads.row(roomId);
    const others = (await this.activeBots(roomId)).filter((b) => b.id !== bot.id);
    const people = (await this.services.access.sharedRoom(roomId))
      ? [...(await this.names(roomId, t)).values()].join(', ')
      : user || t('room.person');
    return { title: thread.title, user: people, members: others };
  }

  /** The person writes in the room; the members it names (or as the room is set) answer in turn. */
  async post(
    roomId: string,
    body: RoomSend,
    userId: string | null = null,
  ): Promise<{ message: Message; created: boolean }> {
    const room = await this.roomRow(roomId);
    if (!room) throw notFound('room');
    const { threads, turns } = this.services;
    const answered = body.replyTo ? await threads.message(body.replyTo) : undefined;
    if (answered && answered.threadId !== roomId) throw new HttpError(404, 'error.notFound.message');
    const result = await threads.addMessage({
      threadId: roomId,
      role: 'user',
      author: 'user',
      userId,
      text: body.text,
      clientId: body.clientId,
      props: answered ? { replyTo: { id: answered.id, text: truncate(answered.text, 300) } } : {},
    });
    if (!result.created) return result;
    // A talk after a quiet spell may be a meeting: the room asks, or keeps its minutes, as it is set.
    await this.services.meetings
      .onPersonSpoke(roomId, result.message)
      .catch((err) => console.warn('meetings', err));
    // The person speaking takes the floor: whoever still waits is dropped, and answers what is said
    // now instead, with everything since it last spoke in its prompt.
    await turns.dropQueued(roomId);
    const bots = await this.activeBots(roomId);
    const named = findMentions(body.text, bots);
    // A reply to a bot's message counts as naming that bot.
    const repliedTo = answered?.author.startsWith('bot:') ? answered.author.slice(4) : null;
    const ids = named.everyone
      ? bots.map((b) => b.id)
      : named.ids.length || repliedTo
        ? [...new Set([...named.ids, ...(repliedTo ? [repliedTo] : [])])]
        : room.responders === 'everyone'
          ? bots.map((b) => b.id)
          : [];
    const answering = ids.filter((id) => bots.some((b) => b.id === id));
    await this.ctx.db
      .update(schema.rooms)
      .set({
        roundsLeft: room.rounds,
        roundSpoke: false,
        botTurnsLeft: Math.min(MAX_BOT_TURNS, bots.length * room.rounds + MENTION_TURNS),
      })
      .where(eq(schema.rooms.id, roomId));
    for (const botId of answering) {
      await turns.enqueue({ threadId: roomId, botId, source: 'user', prompt: body.text, userId });
    }
    this.ctx.bus.refresh({ scope: 'rooms' });
    return result;
  }

  /**
   * A member's prompt, built as its turn starts so it holds what the members before it said: the
   * room lines since it last spoke, or with a new session the latest stretch of the room. The
   * place it reaches is kept for when the turn succeeds.
   */
  async prompt(o: {
    roomId: string;
    bot: Bot;
    turn: TurnRow;
    fresh: boolean;
    t: T;
    /** Told of the outside text the room's recent lines carry, which the member reads or has read. */
    note?: (x: OutsideTrigger | undefined) => void;
  }): Promise<string> {
    const { roomId, bot, turn, fresh, t } = o;
    const [member] = await this.ctx.db
      .select()
      .from(schema.roomMembers)
      .where(and(eq(schema.roomMembers.roomId, roomId), eq(schema.roomMembers.botId, bot.id)))
      .limit(1);
    // Each person's line carries their name; one no longer in the room keeps the plain word.
    const people = await this.names(roomId, t);
    const room = await this.services.threads.row(roomId);
    const bots = await this.services.bots.list({ includeArchived: true });
    // A line whose writer was removed is marked so: it is nobody's here, not the opener's.
    const name = (m: Message) =>
      m.author === 'user'
        ? m.props.writerGone === true
          ? t('room.person')
          : (people.get(m.userId ?? room.userId ?? '') ?? t('room.person'))
        : m.author === `bot:${bot.id}`
          ? t('room.you', { name: bot.name })
          : (bots.find((b) => `bot:${b.id}` === m.author)?.name ?? m.author);
    const recent = await this.services.threads.messages(roomId, { limit: 200 });
    // A reset room is read from its last reset on; what came before is no longer the members' talk.
    const talk = recent
      .slice(lastResetIndex(recent) + 1)
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim());
    // The member's session has read the room's recent stretch, its own lines included.
    for (const m of talk.slice(-ROOM_WINDOW)) o.note?.(outsideIn(m.props));
    const seen = member?.seenAt ?? null;
    const shown = fresh
      ? talk.slice(-ROOM_WINDOW)
      : talk.filter((m) => (!seen || new Date(m.createdAt) > seen) && m.author !== `bot:${bot.id}`);
    const lines: string[] = [];
    let size = 0;
    for (const m of [...shown].reverse()) {
      const text =
        m.text.length > HANDOFF_MESSAGE_CHARS ? `${m.text.slice(0, HANDOFF_MESSAGE_CHARS)}…` : m.text;
      const line = `${name(m)}: ${text}`;
      if (size + line.length > HANDOFF_CHARS) break;
      lines.unshift(line);
      size += line.length;
    }
    const last = talk.at(-1);
    if (last) this.cursors.set(turn.id, new Date(last.createdAt));
    const parts = [
      lines.length
        ? t(fresh ? 'room.promptFresh' : 'room.prompt', { lines: lines.join('\n\n') })
        : t('room.promptNone'),
    ];
    // Why a bot's own turn came: it was named, a new round began, or another bot answered it.
    if (turn.source !== 'user') parts.push(turn.prompt);
    parts.push(t('room.answer', { name: bot.name, silent: SILENT_REPLY }));
    return parts.join('\n\n');
  }

  /** Turn hook: saves the member's place, and lets the bots go on as the room allows. */
  async onTurnFinished(turn: TurnRow, outcome: TurnOutcome) {
    const cursor = this.cursors.get(turn.id);
    this.cursors.delete(turn.id);
    const room = await this.roomRow(turn.threadId);
    if (!room) return;
    // A turn stopped or failed hands nothing on: the person decides what comes next.
    if (!outcome.ok) return;
    if (cursor) {
      await this.ctx.db
        .update(schema.roomMembers)
        .set({ seenAt: cursor })
        .where(and(eq(schema.roomMembers.roomId, room.id), eq(schema.roomMembers.botId, turn.botId)));
    }
    const t = await this.services.settings.translator();
    const bots = await this.activeBots(room.id);
    const self = bots.find((b) => b.id === turn.botId);
    const spoke = !!outcome.text.trim() && !isSilentReply(outcome.text);
    if (spoke) {
      await this.ctx.db.update(schema.rooms).set({ roundSpoke: true }).where(eq(schema.rooms.id, room.id));
      const others = bots.filter((b) => b.id !== turn.botId);
      const named = findMentions(outcome.text, others);
      const ids = named.everyone ? others.map((b) => b.id) : named.ids;
      // A bot named in another's answer acts at most as freely as the one that named it, as with
      // a request sent to it, and starts with what that one had read.
      const [ran] = await this.ctx.db
        .select({ outside: schema.turns.outside })
        .from(schema.turns)
        .where(eq(schema.turns.id, turn.id));
      const level = self ? cappedMode(self.permissionMode, turn.modeCap) : 'readonly';
      for (const botId of ids) {
        if (await this.waiting(room.id, botId)) continue;
        const target = others.find((b) => b.id === botId)!;
        await this.followUp(room.id, botId, t('room.mentionedBy', { by: self?.name ?? '' }), {
          outside: ran?.outside ?? null,
          modeCap: STRICTNESS[target.permissionMode] > STRICTNESS[level] ? level : null,
        });
      }
    }
    // The round is over once no one is left to speak in it; another begins while the room allows
    // and the last one was not silent.
    const [busy] = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.threadId, room.id),
          inArray(schema.turns.status, ['queued', 'running']),
          ne(schema.turns.id, turn.id),
        ),
      )
      .limit(1);
    if (busy) return;
    const [now] = await this.ctx.db.select().from(schema.rooms).where(eq(schema.rooms.id, room.id));
    if (!now || now.roundsLeft <= 0 || !now.roundSpoke) return;
    const [next] = await this.ctx.db
      .update(schema.rooms)
      .set({ roundsLeft: now.roundsLeft - 1, roundSpoke: false })
      .where(and(eq(schema.rooms.id, room.id), eq(schema.rooms.roundsLeft, now.roundsLeft)))
      .returning();
    if (!next) return;
    const n = now.rounds - next.roundsLeft;
    for (const b of bots) {
      await this.followUp(room.id, b.id, t('room.round', { n, total: now.rounds }));
    }
  }

  private async waiting(roomId: string, botId: string): Promise<boolean> {
    const [row] = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.threadId, roomId),
          eq(schema.turns.botId, botId),
          eq(schema.turns.status, 'queued'),
        ),
      )
      .limit(1);
    return !!row;
  }

  /** A turn a bot starts for another, if the exchange's budget has one left. */
  private async followUp(
    roomId: string,
    botId: string,
    why: string,
    carry: { outside?: OutsideTrigger | null; modeCap?: Bot['permissionMode'] | null } = {},
  ): Promise<boolean> {
    const [room] = await this.ctx.db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId));
    if (!room || room.botTurnsLeft <= 0) return false;
    const [taken] = await this.ctx.db
      .update(schema.rooms)
      .set({ botTurnsLeft: room.botTurnsLeft - 1 })
      .where(and(eq(schema.rooms.id, roomId), eq(schema.rooms.botTurnsLeft, room.botTurnsLeft)))
      .returning();
    if (!taken) return false;
    await this.services.turns.enqueue({ threadId: roomId, botId, source: 'bot', prompt: why, ...carry });
    return true;
  }
}
