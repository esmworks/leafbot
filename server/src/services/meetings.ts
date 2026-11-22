import {
  MAX_MINUTES_ITEMS,
  OPEN_MEETING,
  outsideIn,
  type Bot,
  type Meeting,
  type MeetingAnswer,
  type MeetingMinutes,
  type MeetingRecipient,
  type MeetingReminder,
  type MeetingSave,
  type MeetingStatus,
  type MeetingTask,
  type Message,
  type RoomMinutes,
  zonedTime,
} from '@leafbot/shared';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { Engine } from '../engine/types';
import { translator, type T } from '../i18n';
import type { Viewer } from './access';
import { atLeast } from './access';
import { redactSecrets } from './secrets';
import { HttpError, newId, notFound, truncate } from '../util';
import type { Services } from '.';

type MeetingRow = typeof schema.meetings.$inferSelect;

/** A talk that starts after this long a quiet spell in the room is asked about as a meeting. */
export const MEETING_GAP_MS = 2 * 60 * 60_000;
/** A meeting nobody wrote in for this long is over; a question nobody answered lapses. */
export const MEETING_IDLE_MS = 30 * 60_000;
/** How often meetings gone quiet are looked for. */
const SWEEP_MS = 60_000;
/** The most lines one meeting's minutes read, and what of each line. */
const MAX_LINES = 2000;
const LINE_CHARS = 1500;
/** What of the meeting goes into one request; a longer meeting is read in parts, then joined. */
const PART_CHARS = 40_000;
/** The most parts read; a meeting longer still is read from its newest end. */
const MAX_PARTS = 10;
/** The longest note a bot gets; the same limit as any memory note. */
const NOTE_CHARS = 2000;

/** The minutes as the model writes them: every field forgiving, anything unclear left empty. */
const Lines = z
  .array(z.unknown())
  .catch([])
  .transform((xs) =>
    xs
      .flatMap((x) => (typeof x === 'string' && x.trim() ? [truncate(x.trim(), 1000)] : []))
      .slice(0, MAX_MINUTES_ITEMS),
  );
const Written = z.object({
  title: z.string().catch('').default(''),
  summary: z.string().catch('').default(''),
  decisions: Lines.default([]),
  tasks: z
    .array(z.unknown())
    .catch([])
    .default([])
    .transform((xs) =>
      xs
        .flatMap((x) => {
          const task = z
            .object({
              text: z.string(),
              owner: z.string().catch('').default(''),
              due: z.string().nullable().catch(null).default(null),
            })
            .safeParse(x);
          return task.success && task.data.text.trim() ? [task.data] : [];
        })
        .slice(0, MAX_MINUTES_ITEMS),
    ),
  questions: Lines.default([]),
});

/** The minutes in the model's answer, or null when it gave none. */
export function parseMinutes(text: string): z.infer<typeof Written> | null {
  const json = text.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return null;
  try {
    const parsed = Written.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Keeps the data from closing or opening a tag of its own inside the request. */
const data = (s: string) => s.replace(/</g, '\\u003c');

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The day a moment falls on where the person lives, as `YYYY-MM-DD`. */
export const dayIn = (at: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(
    at,
  );

/** Minutes that cannot be written, with the reason the person reads. */
class MinutesError extends Error {
  constructor(readonly key: 'meeting.failedNoEngine' | 'meeting.failedAnswer' | 'meeting.failedLimit') {
    super(key);
  }
}

/**
 * The room's minute taker. It is no member and no turn: it reads the room's lines, asks whether a
 * talk is a meeting, and once the meeting is over writes its minutes with one answer of a member's
 * engine without tools (`Engine.complete`). The person reads and changes them, then chooses which
 * bots are to know them: each gets a note of the decisions and of what it took on, so the bot
 * knows them in every conversation, not only in the room.
 */
export class MeetingService {
  private queue: Promise<void> = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** The request under way, and the meeting it writes. */
  private current: { meetingId: string; controller: AbortController } | null = null;
  private stopped = false;

  constructor(
    private ctx: Ctx,
    private services: Services,
    private engineFor: (bot: Bot) => Engine,
    private clock: () => Date = () => new Date(),
  ) {}

  /** Looks for quiet meetings from now on, and writes the minutes a restart left unwritten. */
  async start() {
    const writing = await this.ctx.db
      .select({ id: schema.meetings.id, roomId: schema.meetings.roomId, toAt: schema.meetings.toAt })
      .from(schema.meetings)
      .where(eq(schema.meetings.status, 'writing'));
    for (const m of writing) {
      if (m.toAt) this.enqueue(m.roomId, m.id);
      else await this.settle(m.roomId);
    }
    this.timer = setInterval(() => void this.sweep().catch((err) => console.warn('meetings', err)), SWEEP_MS);
    this.timer.unref();
  }

  async shutdown() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.current?.controller.abort();
    await this.queue.catch(() => {});
  }

  /** Wait until no minutes are being written (tests). */
  async idle(): Promise<void> {
    for (;;) {
      const tail = this.queue;
      await tail;
      if (tail === this.queue) return;
    }
  }

  private async row(roomId: string, id: string): Promise<MeetingRow> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.meetings)
      .where(and(eq(schema.meetings.id, id), eq(schema.meetings.roomId, roomId)))
      .limit(1);
    if (!row) throw notFound('meeting');
    return row;
  }

  private toMeeting(row: MeetingRow): Meeting {
    return {
      id: row.id,
      roomId: row.roomId,
      status: row.status,
      startedAt: row.fromAt.toISOString(),
      endedAt: row.toAt?.toISOString() ?? null,
      minutes: (row.minutes as MeetingMinutes | null) ?? null,
      error: row.error,
      sentTo: row.sentTo,
      reminders: (row.reminders as MeetingReminder[] | null) ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async list(roomId: string): Promise<Meeting[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.meetings)
      .where(and(eq(schema.meetings.roomId, roomId), ne(schema.meetings.status, 'declined')))
      .orderBy(desc(schema.meetings.createdAt));
    return rows.map((r) => this.toMeeting(r));
  }

  async get(roomId: string, id: string): Promise<Meeting> {
    return this.toMeeting(await this.row(roomId, id));
  }

  /** The room's latest meeting still under way or waiting for the person, as its list entry shows it. */
  async open(roomId: string): Promise<{ id: string; status: MeetingStatus } | null> {
    const [row] = await this.ctx.db
      .select({ id: schema.meetings.id, status: schema.meetings.status })
      .from(schema.meetings)
      .where(and(eq(schema.meetings.roomId, roomId), inArray(schema.meetings.status, OPEN_MEETING)))
      // A question shows as its card; minutes under way or waiting for the person come first.
      .orderBy(sql`${schema.meetings.status} = 'asked'`, desc(schema.meetings.createdAt))
      .limit(1);
    return row ?? null;
  }

  /** The meeting that is asked about or goes on now, if any. */
  private async live(roomId: string): Promise<MeetingRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.meetings)
      .where(and(eq(schema.meetings.roomId, roomId), inArray(schema.meetings.status, ['asked', 'active'])))
      .orderBy(desc(schema.meetings.createdAt))
      .limit(1);
    return row ?? null;
  }

  private async translatorFor(roomId: string): Promise<{ t: T; userId: string | null }> {
    const thread = await this.services.threads.row(roomId);
    const locale =
      (await this.services.settings.all(thread.userId ?? undefined)).language ??
      (await this.services.settings.locale());
    return { t: translator(locale), userId: thread.userId };
  }

  private async changed(roomId: string) {
    const thread = await this.services.threads.row(roomId).catch(() => null);
    // The room's own people hear of it; its list entry shows the meeting under way.
    if (thread) this.ctx.bus.refresh({ scope: 'thread', threadId: roomId, botId: thread.botId });
  }

  /** A line of the room's own about a meeting: the app draws it as the meeting's card. */
  private async card(roomId: string, meetingId: string, stage: 'start' | 'end', text: string) {
    await this.services.threads.addMessage({
      threadId: roomId,
      role: 'system',
      author: 'meeting',
      text,
      props: { meeting: { id: meetingId, stage } },
    });
  }

  /**
   * The person wrote in the room. A talk after a quiet spell (or the room's first) may be a
   * meeting: the room asks, or keeps its minutes straight away, as it is set.
   */
  async onPersonSpoke(roomId: string, message: Message): Promise<void> {
    const [room] = await this.ctx.db.select().from(schema.rooms).where(eq(schema.rooms.id, roomId));
    if (!room || room.minutes === 'never') return;
    if (await this.live(roomId)) return;
    const [before] = await this.ctx.db
      .select({ at: schema.messages.createdAt })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, roomId),
          inArray(schema.messages.role, ['user', 'assistant']),
          ne(schema.messages.id, message.id),
          lt(schema.messages.createdAt, sql`(select created_at from messages where id = ${message.id})`),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    // A talk is lines without a quiet spell between them as long as the one that ends a meeting. A
    // room that keeps every talk starts one after such a pause; one that asks waits for a longer
    // pause, so it does not ask often, unless the line before closed a meeting: that one is over.
    const pause = before ? new Date(message.createdAt).getTime() - before.at.getTime() : Infinity;
    if (pause < MEETING_IDLE_MS) return;
    if (pause < MEETING_GAP_MS && room.minutes !== 'always') {
      const [ended] = await this.ctx.db
        .select({ toAt: schema.meetings.toAt })
        .from(schema.meetings)
        .where(and(eq(schema.meetings.roomId, roomId), isNotNull(schema.meetings.toAt)))
        .orderBy(desc(schema.meetings.toAt))
        .limit(1);
      if (!ended?.toAt || !before || ended.toAt < before.at) return;
    }
    const { t } = await this.translatorFor(roomId);
    const status = room.minutes === 'always' ? 'active' : 'asked';
    const id = newId();
    await this.ctx.db.insert(schema.meetings).values({
      id,
      roomId,
      status,
      // The message that opened the talk is the meeting's first line.
      fromAt: sql`(select created_at from messages where id = ${message.id})`,
    });
    await this.card(
      roomId,
      id,
      'start',
      status === 'active' ? t('meeting.startedLine') : t('meeting.askLine'),
    );
    await this.changed(roomId);
  }

  /** The person starts a meeting by hand: its lines are what is written from now on. */
  async begin(roomId: string): Promise<Meeting> {
    if (!(await this.services.rooms.isRoom(roomId))) throw notFound('room');
    const live = await this.live(roomId);
    if (live?.status === 'active') return this.toMeeting(live);
    const { t } = await this.translatorFor(roomId);
    let id = live?.id;
    if (live) {
      // Asked, and answered by starting it: the line asked about stays its first.
      await this.ctx.db
        .update(schema.meetings)
        .set({ status: 'active', updatedAt: new Date() })
        .where(eq(schema.meetings.id, live.id));
    } else {
      id = newId();
      await this.ctx.db
        .insert(schema.meetings)
        .values({ id, roomId, status: 'active', fromAt: sql`clock_timestamp()` });
      await this.card(roomId, id, 'start', t('meeting.startedLine'));
    }
    await this.changed(roomId);
    return this.get(roomId, id!);
  }

  /** The person's answer to whether the talk is a meeting; `always` and `never` also set the room. */
  async answer(roomId: string, id: string, { answer }: MeetingAnswer): Promise<Meeting> {
    const row = await this.row(roomId, id);
    if (row.status !== 'asked') throw new HttpError(409, 'error.meetingState');
    const yes = answer === 'yes' || answer === 'always';
    await this.ctx.db
      .update(schema.meetings)
      .set({ status: yes ? 'active' : 'declined', updatedAt: new Date() })
      .where(and(eq(schema.meetings.id, id), eq(schema.meetings.status, 'asked')));
    if (answer === 'always' || answer === 'never') await this.setRoom(roomId, answer);
    await this.changed(roomId);
    return this.get(roomId, id);
  }

  private async setRoom(roomId: string, minutes: RoomMinutes) {
    await this.ctx.db.update(schema.rooms).set({ minutes }).where(eq(schema.rooms.id, roomId));
    this.ctx.bus.refresh({ scope: 'rooms' });
  }

  /**
   * The meeting is over. The answers the bots are still writing belong to it: its lines end with
   * the last one written once the room is quiet, and then its minutes are written.
   */
  async end(roomId: string, id: string): Promise<Meeting> {
    const row = await this.row(roomId, id);
    if (row.status !== 'active') throw new HttpError(409, 'error.meetingState');
    await this.close(row);
    return this.get(roomId, id);
  }

  private async close(row: MeetingRow) {
    const [ended] = await this.ctx.db
      .update(schema.meetings)
      .set({ status: 'writing', toAt: null, updatedAt: new Date() })
      .where(and(eq(schema.meetings.id, row.id), eq(schema.meetings.status, 'active')))
      .returning({ id: schema.meetings.id });
    if (!ended) return;
    const { t } = await this.translatorFor(row.roomId);
    await this.card(row.roomId, row.id, 'end', t('meeting.endedLine'));
    await this.changed(row.roomId);
    await this.settle(row.roomId);
  }

  /** Whether a bot is answering in the room, or waits to; `except` is a turn that is ending. */
  private async busy(roomId: string, except?: string): Promise<boolean> {
    const [turn] = await this.ctx.db
      .select({ id: schema.turns.id })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.threadId, roomId),
          inArray(schema.turns.status, ['queued', 'running']),
          except ? ne(schema.turns.id, except) : undefined,
        ),
      )
      .limit(1);
    return !!turn;
  }

  /**
   * Meetings of the room that ended while its bots were answering get their last line once the
   * room is quiet, the last line written then, and their minutes are written.
   */
  private async settle(roomId: string, except?: string) {
    const ended = await this.ctx.db
      .select({ id: schema.meetings.id })
      .from(schema.meetings)
      .where(
        and(
          eq(schema.meetings.roomId, roomId),
          eq(schema.meetings.status, 'writing'),
          isNull(schema.meetings.toAt),
        ),
      );
    if (!ended.length || (await this.busy(roomId, except))) return;
    for (const m of ended) {
      const [set] = await this.ctx.db
        .update(schema.meetings)
        .set({
          toAt: sql`greatest(${schema.meetings.fromAt}, coalesce((select max(created_at) from messages where thread_id = ${roomId} and role in ('user', 'assistant')), ${schema.meetings.fromAt}))`,
        })
        .where(and(eq(schema.meetings.id, m.id), isNull(schema.meetings.toAt)))
        .returning({ id: schema.meetings.id });
      if (set) this.enqueue(roomId, m.id);
    }
  }

  /** A turn ended: a meeting of its room that ended while the bots answered may now be written. */
  async onTurnFinished(turn: { id: string; threadId: string }) {
    await this.settle(turn.threadId, turn.id);
  }

  /** The meeting goes on after all: the draft is dropped and later lines are kept too. */
  async resume(roomId: string, id: string): Promise<Meeting> {
    const row = await this.row(roomId, id);
    if (row.status !== 'draft' && row.status !== 'failed') throw new HttpError(409, 'error.meetingState');
    const live = await this.live(roomId);
    if (live && live.id !== id) throw new HttpError(409, 'error.meetingOther');
    await this.ctx.db
      .update(schema.meetings)
      .set({ status: 'active', toAt: null, minutes: null, error: null, updatedAt: new Date() })
      .where(eq(schema.meetings.id, id));
    await this.changed(roomId);
    return this.get(roomId, id);
  }

  /** Minutes that could not be written are tried again. */
  async retry(roomId: string, id: string): Promise<Meeting> {
    const row = await this.row(roomId, id);
    if (row.status !== 'failed') throw new HttpError(409, 'error.meetingState');
    await this.ctx.db
      .update(schema.meetings)
      .set({ status: 'writing', error: null, updatedAt: new Date() })
      .where(eq(schema.meetings.id, id));
    await this.changed(roomId);
    this.enqueue(roomId, id);
    return this.get(roomId, id);
  }

  /** A meeting and its minutes are forgotten; the notes the bots already got stay theirs. */
  async remove(roomId: string, id: string) {
    // The meeting must be this room's.
    await this.row(roomId, id);
    // Only the request for this meeting stops; another room's minutes go on being written.
    if (this.current?.meetingId === id) this.current.controller.abort();
    await this.ctx.db.delete(schema.meetings).where(eq(schema.meetings.id, id));
    await this.changed(roomId);
  }

  /**
   * Meetings gone quiet: one nobody wrote in for a while is over, and a question nobody answered
   * lapses. A room whose bots are still talking is not quiet.
   */
  async sweep(): Promise<void> {
    if (this.stopped) return;
    const rows = await this.ctx.db
      .select()
      .from(schema.meetings)
      .where(inArray(schema.meetings.status, ['asked', 'active', 'writing']));
    const quietSince = new Date(this.clock().getTime() - MEETING_IDLE_MS);
    for (const row of rows) {
      // A meeting ended while the bots answered, whose last turn's hook did not settle it.
      if (row.status === 'writing') {
        if (!row.toAt) await this.settle(row.roomId);
        continue;
      }
      if (await this.busy(row.roomId)) continue;
      const [last] = await this.ctx.db
        .select({ at: schema.messages.createdAt })
        .from(schema.messages)
        .where(
          and(eq(schema.messages.threadId, row.roomId), inArray(schema.messages.role, ['user', 'assistant'])),
        )
        .orderBy(desc(schema.messages.createdAt))
        .limit(1);
      // Quiet counts from the last line, or from when the meeting was taken up again (accepted,
      // started or resumed), whichever is later.
      const lastAt = new Date(
        Math.max(last?.at.getTime() ?? 0, row.fromAt.getTime(), row.updatedAt.getTime()),
      );
      if (lastAt > quietSince) continue;
      if (row.status === 'asked') {
        await this.ctx.db
          .update(schema.meetings)
          .set({ status: 'declined', updatedAt: new Date() })
          .where(and(eq(schema.meetings.id, row.id), eq(schema.meetings.status, 'asked')));
        await this.changed(row.roomId);
        continue;
      }
      // Its lines end with the last one written, not with the quiet after it.
      await this.close(row);
    }
  }

  private enqueue(roomId: string, id: string) {
    this.queue = this.queue
      .then(() => (this.stopped ? undefined : this.write(roomId, id)))
      .catch((err) => console.warn('meeting minutes', err));
  }

  /** Writes the minutes of an ended meeting; a failure is kept for the person to try again. */
  private async write(roomId: string, id: string): Promise<void> {
    const row = await this.row(roomId, id).catch(() => null);
    if (!row || row.status !== 'writing' || !row.toAt) return;
    const { t, userId } = await this.translatorFor(roomId);
    const fail = async (error: string) => {
      await this.ctx.db
        .update(schema.meetings)
        .set({ status: 'failed', error, updatedAt: new Date() })
        .where(and(eq(schema.meetings.id, id), eq(schema.meetings.status, 'writing')));
      await this.changed(roomId);
    };
    try {
      const minutes = await this.compose(row, t, userId);
      if (!minutes) return void (await fail(t('meeting.failedEmpty')));
      await this.ctx.db
        .update(schema.meetings)
        .set({ status: 'draft', minutes, error: null, updatedAt: new Date() })
        .where(and(eq(schema.meetings.id, id), eq(schema.meetings.status, 'writing')));
      await this.changed(roomId);
    } catch (err) {
      if (this.stopped) return;
      console.warn(`Meeting minutes of ${id} failed: ${(err as Error).message}`);
      await fail(err instanceof MinutesError ? t(err.key) : t('meeting.failed'));
    }
  }

  /** The member bots, in speaking order, with bots that spoke in the room and left since. */
  private async bots(roomId: string): Promise<{ members: Bot[]; all: Bot[] }> {
    const ids = (
      await this.ctx.db
        .select({ botId: schema.roomMembers.botId })
        .from(schema.roomMembers)
        .where(eq(schema.roomMembers.roomId, roomId))
        .orderBy(asc(schema.roomMembers.position))
    ).map((m) => m.botId);
    const all = await this.services.bots.list({ includeArchived: true });
    const members = ids.flatMap((id) => all.filter((b) => b.id === id && !b.archivedAt));
    return { members, all };
  }

  /** The meeting's lines, as `Name: text`, the newest last. */
  private async lines(row: MeetingRow, t: T, userId: string | null, all: Bot[]): Promise<string[]> {
    const settings = await this.services.settings.all(userId ?? undefined);
    const person = settings.userName || t('room.person');
    const rows = await this.ctx.db
      .select({
        role: schema.messages.role,
        author: schema.messages.author,
        text: schema.messages.text,
        props: schema.messages.props,
      })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, row.roomId),
          inArray(schema.messages.role, ['user', 'assistant']),
          gte(schema.messages.createdAt, sql`(select from_at from meetings where id = ${row.id})`),
          lte(schema.messages.createdAt, sql`(select to_at from meetings where id = ${row.id})`),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(MAX_LINES);
    return rows.reverse().flatMap((m) => {
      if (!m.text.trim()) return [];
      const name =
        m.author === 'user' ? person : (all.find((b) => `bot:${b.id}` === m.author)?.name ?? m.author);
      const outside = outsideIn((m.props ?? {}) as Record<string, unknown>) ? ' outside="true"' : '';
      return [
        `<m from="${data(name).replace(/"/g, "'")}"${outside}>${data(truncate(m.text, LINE_CHARS))}</m>`,
      ];
    });
  }

  /** The minutes, read in one request, or in parts joined by one more. Null when the meeting said nothing. */
  private async compose(row: MeetingRow, t: T, userId: string | null): Promise<MeetingMinutes | null> {
    const { members, all } = await this.bots(row.roomId);
    const lines = await this.lines(row, t, userId, all);
    if (!lines.length) return null;
    const writer = members.find((b) => this.engineFor(b).complete);
    if (!writer) throw new MinutesError('meeting.failedNoEngine');
    // The minutes are spent from the writer's account: a spent limit stops them as it stops turns.
    if (await this.services.usage.reached(writer)) throw new MinutesError('meeting.failedLimit');
    const engine = this.engineFor(writer);
    const settings = await this.services.settings.all(userId ?? undefined);
    const model =
      writer.model ||
      (writer.engine === 'claude' ? (await this.services.settings.all()).defaultModel : '') ||
      this.ctx.config.claudeModel;
    const locale = settings.language ?? (await this.services.settings.locale());
    const thread = await this.services.threads.row(row.roomId);
    const person = settings.userName || t('room.person');
    const who = [person, ...members.map((b) => b.name)].map((n) => `- ${data(n)}`).join('\n');
    const today = dayIn(this.clock(), settings.timezone);
    const system = t('meeting.system', { today });
    const head = `<room>${data(thread.title)}</room>\n<people>\n${who}\n</people>`;

    // Parts of the meeting, oldest first; a meeting longer than the parts allowed loses its start.
    const parts: string[][] = [];
    let part: string[] = [];
    let size = 0;
    for (const line of lines) {
      if (size + line.length > PART_CHARS && part.length) {
        parts.push(part);
        part = [];
        size = 0;
      }
      part.push(line);
      size += line.length;
    }
    if (part.length) parts.push(part);
    const kept = parts.slice(-MAX_PARTS);

    const ask = async (system: string, user: string) => {
      const controller = new AbortController();
      this.current = { meetingId: row.id, controller };
      try {
        const { text, costUsd } = await engine.complete!({
          model,
          system,
          user,
          signal: controller.signal,
          locale,
        });
        await this.services.usage.background(writer.id, 'minutes', costUsd);
        if (controller.signal.aborted) throw new Error('stopped');
        return text;
      } finally {
        this.current = null;
      }
    };

    let written: z.infer<typeof Written> | null;
    if (kept.length === 1) {
      written = parseMinutes(await ask(system, `${head}\n<meeting>\n${kept[0]!.join('\n')}\n</meeting>`));
    } else {
      const drafts: z.infer<typeof Written>[] = [];
      for (const [i, p] of kept.entries()) {
        const one = parseMinutes(
          await ask(
            `${system}\n\n${t('meeting.partNote', { n: i + 1, total: kept.length })}`,
            `${head}\n<meeting>\n${p.join('\n')}\n</meeting>`,
          ),
        );
        if (one) drafts.push(one);
      }
      if (!drafts.length) return null;
      written = parseMinutes(
        await ask(
          t('meeting.joinSystem', { today }),
          `${head}\n<parts>\n${drafts.map((d) => data(JSON.stringify(d))).join('\n')}\n</parts>`,
        ),
      );
    }
    if (!written) throw new MinutesError('meeting.failedAnswer');
    return this.tidy(written, members, t);
  }

  /** The model's minutes made valid: names of member bots become the bots, odd days are dropped. */
  private tidy(w: z.infer<typeof Written>, members: Bot[], t: T): MeetingMinutes {
    const byName = (name: string) => {
      const key = name.trim().replace(/^@/, '').toLocaleLowerCase();
      return members.find((b) => b.name.toLocaleLowerCase() === key) ?? null;
    };
    const tasks: MeetingTask[] = w.tasks.map((task) => {
      const bot = task.owner ? byName(task.owner) : null;
      return {
        text: truncate(task.text.trim(), 1000),
        owner: truncate((bot?.name ?? task.owner).trim(), 120),
        botId: bot?.id ?? null,
        due: task.due && DAY.test(task.due.trim()) ? task.due.trim() : null,
      };
    });
    return {
      title: truncate(w.title.trim(), 200) || t('meeting.untitled'),
      summary: truncate(w.summary.trim(), 6000),
      decisions: w.decisions,
      tasks,
      questions: w.questions,
    };
  }

  /**
   * The person approved the minutes: they are kept as approved, and each bot chosen gets a note of
   * them, with what it took on first, at once.
   */
  async save(roomId: string, id: string, body: MeetingSave, viewer: Viewer): Promise<Meeting> {
    const row = await this.row(roomId, id);
    if (row.status !== 'draft') throw new HttpError(409, 'error.meetingState');
    const minutes = body.minutes;
    const [claimed] = await this.ctx.db
      .update(schema.meetings)
      .set({ status: 'saved', minutes, updatedAt: new Date() })
      .where(and(eq(schema.meetings.id, id), eq(schema.meetings.status, 'draft')))
      .returning({ id: schema.meetings.id });
    if (!claimed) throw new HttpError(409, 'error.meetingState');

    const { t } = await this.translatorFor(roomId);
    const thread = await this.services.threads.row(roomId);
    const all = await this.services.bots.list();
    const timezone = (await this.services.settings.all(thread.userId ?? undefined)).timezone;
    const day = dayIn(row.fromAt, timezone);
    const sentTo: MeetingRecipient[] = [];
    for (const botId of [...new Set(body.botIds)]) {
      const bot = all.find((b) => b.id === botId);
      // A bot without memory keeps no notes; the app does not offer it.
      if (!bot?.memory) continue;
      const level = await this.services.access.level(viewer, botId);
      if (!atLeast(level, 'chat')) continue;
      const content = redactSecrets(
        meetingNote(minutes, bot, { t, day, room: thread.title }),
        t('memory.redacted'),
      ).text;
      const note = { scope: 'bot' as const, botId, userId: null, content, site: null };
      // One bot that cannot take the note leaves the others theirs.
      try {
        if (!(await this.services.memory.findSame(note))) {
          await this.services.memory.create({
            ...note,
            // Someone who may change the bot writes its notes as their own. A note from someone who
            // may only talk with it is kept at once too, as the bot's own: nobody is asked to judge
            // minutes of a meeting they were not in, and the note shows in the memory screen.
            source: atLeast(level, 'edit') ? 'user' : `bot:${botId}`,
            actor: `user:${viewer.userId}`,
            threadId: roomId,
          });
        }
        sentTo.push({ botId, waiting: false });
      } catch (err) {
        console.warn(`Meeting note for bot ${botId} failed: ${(err as Error).message}`);
      }
    }
    const reminders = await this.remind(roomId, minutes, body, viewer, {
      t,
      day,
      room: thread.title,
      timezone,
    });
    await this.ctx.db
      .update(schema.meetings)
      .set({ sentTo, reminders, updatedAt: new Date() })
      .where(eq(schema.meetings.id, id));
    if (sentTo.some((s) => !s.waiting)) this.ctx.bus.refresh({ scope: 'memory' });
    await this.changed(roomId);
    return this.get(roomId, id);
  }

  /**
   * Reminders for the tasks the person picked: a follow-up on the task's day, in the bot's main
   * conversation with the person. The bot that took the task on looks at where it stands; a
   * person's task is brought up by the first bot of the room. A follow-up changes nothing about the
   * bot, so any member the person may talk with keeps one. A task with no day, or a day already
   * past, gets none.
   */
  private async remind(
    roomId: string,
    minutes: MeetingMinutes,
    body: MeetingSave,
    viewer: Viewer,
    o: { t: T; day: string; room: string; timezone: string },
  ): Promise<MeetingReminder[]> {
    const picked = [...new Set(body.reminders)].flatMap((i) => {
      const task = minutes.tasks[i];
      return task?.due ? [task] : [];
    });
    if (!picked.length) return [];
    const { members } = await this.bots(roomId);
    const usable: Bot[] = [];
    for (const b of members) {
      if (atLeast(await this.services.access.level(viewer, b.id), 'chat')) usable.push(b);
    }
    const pruned = new Set<string>();
    const made: MeetingReminder[] = [];
    for (const task of picked) {
      const own = usable.find((b) => b.id === task.botId);
      const bot = own ?? usable[0];
      if (!bot) break;
      const prompt = own
        ? o.t('meeting.reminderOwn', { title: minutes.title, day: o.day, room: o.room, task: task.text })
        : o.t('meeting.reminderOther', {
            title: minutes.title,
            day: o.day,
            room: o.room,
            task: task.text,
            owner: task.owner || o.t('meeting.reminderNobody'),
          });
      try {
        if (!pruned.has(bot.id)) {
          pruned.add(bot.id);
          await this.pruneReminders(bot.id);
        }
        const dueAt = zonedTime(task.due!, body.remindAt, o.timezone);
        // A day already gone gets none.
        if (dueAt.getTime() <= this.clock().getTime()) continue;
        // A follow-up in the conversation where the person talks with the bot, so they see it
        // there; the bot keeping track, not a routine in its list.
        const followUp = await this.services.followUps.add({
          bot,
          userId: viewer.userId,
          threadId: roomId,
          text: prompt,
          context: o.t('meeting.reminderName', { task: task.text }),
          eventAt: zonedTime(task.due!, '00:00', o.timezone),
          dueAt,
          kind: 'meeting',
          t: o.t,
        });
        if (!followUp) continue;
        made.push({
          followUpId: followUp.id,
          botId: bot.id,
          task: task.text,
          date: task.due!,
          time: body.remindAt,
        });
      } catch (err) {
        // A bot that keeps as many follow-ups as it may: that task gets none.
        console.warn(`Meeting reminder for bot ${bot.id} not set: ${(err as Error).message}`);
      }
    }
    return made;
  }

  /**
   * Reminders of earlier meetings that already ran stay as routines turned off; they are removed
   * before a new one is set, so they do not fill the bot's routines.
   */
  private async pruneReminders(botId: string) {
    const rows = await this.ctx.db.select({ reminders: schema.meetings.reminders }).from(schema.meetings);
    const ids = rows.flatMap((r) =>
      ((r.reminders as MeetingReminder[] | null) ?? [])
        .filter((x) => x.botId === botId)
        .flatMap((x) => (x.routineId ? [x.routineId] : [])),
    );
    if (!ids.length) return;
    const spent = await this.ctx.db
      .select({ id: schema.routines.id })
      .from(schema.routines)
      .where(
        and(
          inArray(schema.routines.id, ids),
          eq(schema.routines.botId, botId),
          eq(schema.routines.enabled, false),
          isNotNull(schema.routines.lastRunAt),
        ),
      );
    for (const r of spent) await this.services.routines.remove(r.id);
  }
}

/**
 * The note one bot gets of a meeting: what it took on comes first, so a note cut to the memory
 * limit loses the least of what concerns it.
 */
export function meetingNote(
  m: MeetingMinutes,
  bot: Pick<Bot, 'id' | 'name'>,
  o: { t: T; day: string; room: string },
): string {
  const { t } = o;
  const task = (x: MeetingTask, withOwner: boolean) =>
    `- ${withOwner && x.owner ? `${x.owner}: ` : ''}${x.text}${x.due ? ` ${t('meeting.noteDue', { due: x.due })}` : ''}`;
  const own = m.tasks.filter((x) => x.botId === bot.id);
  const others = m.tasks.filter((x) => x.botId !== bot.id);
  const sections = [
    t('meeting.noteHead', { title: m.title, day: o.day, room: o.room }),
    own.length ? `${t('meeting.noteYours')}\n${own.map((x) => task(x, false)).join('\n')}` : '',
    m.decisions.length ? `${t('meeting.noteDecisions')}\n${m.decisions.map((d) => `- ${d}`).join('\n')}` : '',
    m.summary ? `${t('meeting.noteSummary')} ${m.summary}` : '',
    others.length ? `${t('meeting.noteOthers')}\n${others.map((x) => task(x, true)).join('\n')}` : '',
    m.questions.length ? `${t('meeting.noteQuestions')}\n${m.questions.map((q) => `- ${q}`).join('\n')}` : '',
  ].filter(Boolean);
  return truncate(sections.join('\n\n'), NOTE_CHARS);
}
