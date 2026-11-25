import type { PersonJobCard } from '@leafbot/shared';
import {
  MAC_JOB_MAX_MS,
  MAC_JOB_TAIL,
  MAC_JOBS_MAX,
  MacJobEvent,
  MacJobsSnapshot,
  stripAnsi,
} from '@leafbot/shared/mac';
import { and, eq, lt, notInArray, sql } from 'drizzle-orm';
import type { CommandComputer } from '../computer/bridge';
import type { Ctx } from '../context';
import { schema } from '../db';
import { translator } from '../i18n';
import { newId } from '../util';
import type { Services } from './index';

type Row = typeof schema.personJobs.$inferSelect;

/** How often a running job's card takes its newest lines, at most: each write refetches the chat. */
const CARD_EVERY_MS = 10_000;
/** How long past the computer's own limit a job may stay running here before it counts as lost. */
const LOST_AFTER_MS = MAC_JOB_MAX_MS + 10 * 60_000;
/** How long the answer to a run may take beyond the wait: the computer may first ask its person. */
const RUN_SLACK_MS = 60_000;
/**
 * What a computer answers when it did not start a command (`failed`: its handler threw before the
 * command was spawned). No answer at all may mean it did.
 */
const REFUSALS = new Set(['refused', 'tooMany', 'noFolder', 'commandsOff', 'badRequest', 'failed']);

/** What starting a command came to. */
export type JobStart =
  | { error: string }
  | { id: string; running: true; output: string; unsure?: boolean }
  | {
      id: string;
      running: false;
      exitCode: number | null;
      stopped: boolean;
      output: string;
      truncated: boolean;
    };

/**
 * Commands bots run on people's own computers, through their desktop apps. The computer runs them
 * and reports how they go; this keeps each one's row and card, and wakes the bot in the same
 * conversation when one it stopped waiting for ends.
 */
export class PersonJobService {
  /** When each running job's card last took new lines. */
  private written = new Map<string, number>();
  /**
   * The writes waiting for each job, in order: a card's progress written after its end would show
   * a finished job as running.
   */
  private queue = new Map<string, Promise<unknown>>();

  private serial<R>(id: string, fn: () => Promise<R>): Promise<R> {
    const next = (this.queue.get(id) ?? Promise.resolve()).catch(() => undefined).then(fn);
    const kept = next.finally(() => {
      if (this.queue.get(id) === kept) this.queue.delete(id);
    });
    this.queue.set(id, kept);
    return next;
  }

  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  card(r: Row): PersonJobCard {
    return {
      id: r.id,
      command: r.command,
      cwd: r.cwd,
      device: r.device,
      status: r.status,
      exitCode: r.exitCode,
      tail: r.tail,
      startedAt: r.startedAt.toISOString(),
      endedAt: r.endedAt?.toISOString() ?? null,
    };
  }

  async get(id: string, userId: string): Promise<Row | null> {
    const [r] = await this.ctx.db
      .select()
      .from(schema.personJobs)
      .where(and(eq(schema.personJobs.id, id), eq(schema.personJobs.userId, userId)))
      .limit(1);
    return r ?? null;
  }

  private async running(userId: string): Promise<number> {
    const [r] = await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.personJobs)
      .where(and(eq(schema.personJobs.userId, userId), eq(schema.personJobs.status, 'running')));
    return r?.n ?? 0;
  }

  /** Runs `command` on the person's computer, its card in the conversation, waiting up to `waitMs`. */
  async start(o: {
    computer: CommandComputer;
    userId: string;
    bot: { id: string; name: string };
    threadId: string;
    turnId: string | null;
    command: string;
    cwd: string;
    waitMs: number;
  }): Promise<JobStart> {
    if ((await this.running(o.userId)) >= MAC_JOBS_MAX) return { error: 'tooMany' };
    const id = newId();
    const now = this.clock();
    const [row] = await this.ctx.db
      .insert(schema.personJobs)
      .values({
        id,
        userId: o.userId,
        botId: o.bot.id,
        threadId: o.threadId,
        device: o.computer.device,
        command: o.command,
        cwd: o.cwd,
        startedAt: now,
      })
      .returning();
    const { message } = await this.services.threads.addMessage({
      threadId: o.threadId,
      role: 'system',
      author: `bot:${o.bot.id}`,
      text: '',
      props: { personJob: this.card(row!) },
      turnId: o.turnId,
    });
    await this.ctx.db
      .update(schema.personJobs)
      .set({ messageId: message.id })
      .where(eq(schema.personJobs.id, id));
    const r = await o.computer.ask(
      { op: 'run', id, command: o.command, cwd: o.cwd, bot: o.bot.name, waitMs: o.waitMs },
      o.waitMs + RUN_SLACK_MS,
    );
    const error = typeof r.error === 'string' ? r.error : 'failed';
    if (r.ok !== true && !REFUSALS.has(error)) {
      // No answer: the computer may well be running it. The card stays and the bot is woken when
      // the computer, back again, tells how it ended or that it has no such job.
      const [waiting] = await this.ctx.db
        .update(schema.personJobs)
        .set({ wake: true })
        .where(and(eq(schema.personJobs.id, id), eq(schema.personJobs.status, 'running')))
        .returning({ id: schema.personJobs.id });
      if (waiting) return { id, running: true, output: '', unsure: true };
      return this.ended(id, o.userId, '');
    }
    if (r.ok !== true) {
      // The computer said no: it never started, the card says so and nothing wakes for it.
      await this.serial(id, () => this.end(id, o.userId, { status: 'refused', exitCode: null, tail: '' }));
      return { error };
    }
    const output = typeof r.output === 'string' ? stripAnsi(r.output) : '';
    if (r.running !== true) {
      const exitCode = typeof r.exitCode === 'number' ? r.exitCode : null;
      const stopped = r.stopped === true;
      await this.serial(id, () =>
        this.end(id, o.userId, {
          status: stopped ? 'stopped' : 'done',
          exitCode,
          tail: output.slice(-MAC_JOB_TAIL),
        }),
      );
      return { id, running: false, exitCode, stopped, output, truncated: r.truncated === true };
    }
    // Going on after the wait: its end wakes the bot. Unless it ended in between, told by an event.
    const [waking] = await this.ctx.db
      .update(schema.personJobs)
      .set({ wake: true })
      .where(and(eq(schema.personJobs.id, id), eq(schema.personJobs.status, 'running')))
      .returning({ id: schema.personJobs.id });
    if (!waking) return this.ended(id, o.userId, output);
    return { id, running: true, output };
  }

  /** A job that ended while its start waited for an answer, told by an event. */
  private async ended(id: string, userId: string, output: string): Promise<JobStart> {
    const row = await this.get(id, userId);
    return {
      id,
      running: false,
      exitCode: row?.exitCode ?? null,
      stopped: row?.status === 'stopped',
      output: row?.tail || output,
      truncated: true,
    };
  }

  /**
   * Ends a running job once: whoever comes first (the run's answer, an event, the computer's list,
   * the sweep) ends it, and only that one updates the card and wakes the bot.
   */
  private async end(
    id: string,
    userId: string,
    e: { status: 'done' | 'stopped' | 'lost' | 'refused'; exitCode: number | null; tail: string },
  ): Promise<void> {
    const [row] = await this.ctx.db
      .update(schema.personJobs)
      .set({ status: e.status, exitCode: e.exitCode, tail: e.tail, endedAt: this.clock() })
      .where(
        and(
          eq(schema.personJobs.id, id),
          eq(schema.personJobs.userId, userId),
          eq(schema.personJobs.status, 'running'),
        ),
      )
      .returning();
    if (!row) return;
    this.written.delete(id);
    await this.showCard(row);
    if (row.wake) await this.wake(row);
  }

  private async showCard(row: Row) {
    if (!row.messageId) return;
    await this.services.threads
      .mergeProps(row.messageId, { personJob: this.card(row) })
      .catch((err: unknown) => console.warn(`job card: ${String(err)}`));
  }

  /** The bot hears in the same conversation how the command it left running ended. */
  private async wake(row: Row) {
    const settings = await this.services.settings.all(row.userId);
    const t = translator(settings.language ?? (await this.services.settings.locale()));
    await this.services.turns.enqueue({
      threadId: row.threadId,
      botId: row.botId,
      source: 'followup',
      prompt: t('personJob.endedPrompt', {
        id: row.id,
        command: row.command.slice(0, 500),
        cwd: row.cwd,
        how:
          row.status === 'done'
            ? t('personJob.exited', { code: String(row.exitCode ?? '?') })
            : t(`personJob.status.${row.status}`),
        tail: row.tail || t('personJob.noOutput'),
      }),
      // What a command prints can be anything: a page it fetched, a file someone else wrote.
      outside: 'web',
      userId: row.userId,
    });
  }

  /** A job's progress or end from a computer signed in as `userId`; others' jobs are not its to tell. */
  async onEvent(userId: string, raw: unknown) {
    const parsed = MacJobEvent.safeParse(raw);
    if (!parsed.success) return;
    await this.serial(parsed.data.id, () => this.told(userId, parsed.data));
  }

  private async told(userId: string, e: MacJobEvent) {
    const tail = stripAnsi(e.tail).slice(-MAC_JOB_TAIL);
    if (!e.running) {
      await this.end(e.id, userId, {
        status: e.stopped ? 'stopped' : 'done',
        exitCode: e.exitCode,
        tail,
      });
      return;
    }
    const now = this.clock().getTime();
    if (now - (this.written.get(e.id) ?? 0) < CARD_EVERY_MS) return;
    const [row] = await this.ctx.db
      .update(schema.personJobs)
      .set({ tail })
      .where(
        and(
          eq(schema.personJobs.id, e.id),
          eq(schema.personJobs.userId, userId),
          eq(schema.personJobs.status, 'running'),
        ),
      )
      .returning();
    if (!row) return;
    this.written.set(e.id, now);
    await this.showCard(row);
  }

  /**
   * The jobs a computer still runs, sent as it connects: a running one of this person's on that
   * computer that is not among them ended while nobody heard, and counts as lost.
   */
  async onSnapshot(userId: string, device: string, raw: unknown) {
    const parsed = MacJobsSnapshot.safeParse(raw);
    if (!parsed.success) return;
    const rows = await this.ctx.db
      .select({ id: schema.personJobs.id })
      .from(schema.personJobs)
      .where(
        and(
          eq(schema.personJobs.userId, userId),
          eq(schema.personJobs.device, device.slice(0, 100)),
          eq(schema.personJobs.status, 'running'),
          ...(parsed.data.running.length ? [notInArray(schema.personJobs.id, parsed.data.running)] : []),
        ),
      );
    for (const r of rows)
      await this.serial(r.id, () => this.end(r.id, userId, { status: 'lost', exitCode: null, tail: '' }));
  }

  /** Jobs past the computer's own time limit that never said how they ended: the computer went away. */
  async sweep() {
    const rows = await this.ctx.db
      .select({ id: schema.personJobs.id, userId: schema.personJobs.userId, tail: schema.personJobs.tail })
      .from(schema.personJobs)
      .where(
        and(
          eq(schema.personJobs.status, 'running'),
          lt(schema.personJobs.startedAt, new Date(this.clock().getTime() - LOST_AFTER_MS)),
        ),
      );
    for (const r of rows)
      await this.serial(r.id, () =>
        this.end(r.id, r.userId, { status: 'lost', exitCode: null, tail: r.tail }),
      );
  }

  /** Asks the person's computers to stop a job of theirs; false when it is not running. */
  async stop(id: string, userId: string): Promise<boolean> {
    const row = await this.get(id, userId);
    if (row?.status !== 'running') return false;
    const answers = await this.ctx.macs?.toAll(userId, { op: 'stop', id });
    // No computer of theirs has it to stop: it cannot be heard of again. One that does tells its
    // end as usual.
    if (!answers?.some((a) => a.ok === true && a.stopped === true))
      await this.serial(id, () => this.end(id, userId, { status: 'lost', exitCode: null, tail: row.tail }));
    return true;
  }
}
