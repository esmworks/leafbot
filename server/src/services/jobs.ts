import type { Bot, Message, OutsideTrigger } from '@leafbot/shared';
import { and, asc, desc, eq, exists, inArray, isNotNull, isNull, notExists, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { TurnOutcome } from '../engine/types';
import type { TurnRow } from '../runtime/turns';
import { HttpError, newId, notFound, truncate } from '../util';
import type { Services } from '.';
import { handFiles, type HandedFiles } from '../tools/files';
import type { T } from '../i18n';
import { basename } from 'node:path';
import { toMessage } from './mappers';
import { serverTranslator } from './settings';

type JobRow = typeof schema.jobs.$inferSelect;

/** How recent a request left by a restart must be for its sender to be told of it. */
const RECOVER_WAKE_MS = 24 * 60 * 60 * 1000;

/**
 * Bot-to-bot requests. Sending never blocks the sender: the target gets a turn in its
 * thread for that peer, and the reply comes back to the sender as a new turn.
 */
export class JobService {
  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  async get(id: string): Promise<JobRow> {
    const [row] = await this.ctx.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1);
    if (!row) throw notFound('job');
    return row;
  }

  /**
   * Whether the request chain `jobId` belongs to began with `userId`'s own message in their own
   * conversation, with no turn along it having read outside text (a mail, a page, a webhook, a
   * forwarded message). Work handed on that way is the person's as much as a command they typed,
   * so it may use what only their own work uses, such as their own GitHub. A routine, a ticket, a
   * WhatsApp chat answered for them or a team conversation at the start breaks the chain, as does
   * outside text read before the request left: its words could be someone else's.
   */
  async startedByPerson(jobId: string, userId: string): Promise<boolean> {
    let id: string | null = jobId;
    for (let hop = 0; id && hop <= this.ctx.config.maxJobDepth; hop++) {
      const at: string = id;
      const [row] = await this.ctx.db
        .select({ turn: schema.turns, thread: schema.threads })
        .from(schema.jobs)
        .innerJoin(schema.turns, eq(schema.turns.id, schema.jobs.fromTurnId))
        .innerJoin(schema.threads, eq(schema.threads.id, schema.turns.threadId))
        .where(eq(schema.jobs.id, at))
        .limit(1);
      if (!row) return false;
      const { turn, thread } = row;
      if (turn.outside || turn.guest || turn.userId !== userId) return false;
      if (turn.source === 'user') {
        return (
          thread.kind === 'user' &&
          thread.userId === userId &&
          !(await this.services.whatsapp.contactOf(thread.id))
        );
      }
      if (turn.source !== 'bot') return false;
      const next: string | null = turn.jobId;
      id = next;
    }
    return false;
  }

  async send(opts: {
    from: Bot;
    fromThreadId: string;
    /** The sender's turn, so that replies to one turn come back in one. */
    fromTurnId?: string | null;
    /** The turn making the request; its job (if any) is the parent in the chain. */
    parentJobId: string | null;
    to: Bot;
    text: string;
    kind: 'send' | 'ask' | 'notify';
    approvalId?: string | null;
    /**
     * Outside text the sender's run had read: its request may carry those words, so the target's
     * turn counts as having read them too.
     */
    outside?: OutsideTrigger | null;
    /** Hands files to the target's conversation once it is known; they go with the request. */
    attach?: (toThreadId: string) => Promise<HandedFiles>;
  }): Promise<JobRow> {
    const { from, to } = opts;
    if (!this.services.bots.canMessage(from, to)) {
      throw new HttpError(403, 'error.cannotMessage', { from: from.name, to: to.name });
    }
    const parent = opts.parentJobId ? await this.get(opts.parentJobId).catch(() => null) : null;
    const depth = parent ? parent.depth + 1 : 1;
    const rootId = parent ? parent.rootId : newId();
    if (depth > this.ctx.config.maxJobDepth) {
      throw new HttpError(429, 'error.chainTooDeep', { depth });
    }
    const [{ n } = { n: 0 }] = await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.jobs)
      .where(eq(schema.jobs.rootId, rootId));
    if (Number(n) >= this.ctx.config.maxJobsPerChain) {
      throw new HttpError(429, 'error.chainBudget');
    }
    const t = await serverTranslator(this.ctx);
    let approvalNote = '';
    if (opts.approvalId) {
      const approval = await this.services.approvals.verifiedApproval(opts.approvalId);
      if (!approval) throw new HttpError(400, 'error.approvalNotVerified');
      const answer = approval.answer
        ? t('job.approvalAnswer', { answer: truncate(approval.answer, 200) })
        : '';
      approvalNote = `\n\n${t('job.approvalNote', { id: approval.id, summary: truncate(approval.summary, 160), answer })}`;
    }
    // The exchange is the requesting person's: who the asking turn works for.
    const [fromTurn] = opts.fromTurnId
      ? await this.ctx.db
          .select({ userId: schema.turns.userId })
          .from(schema.turns)
          .where(eq(schema.turns.id, opts.fromTurnId))
          .limit(1)
      : [];
    const person = fromTurn?.userId ?? (await this.services.access.botOwner(from.id));
    const toThread = await this.services.threads.peerThread(to.id, from.id, person);
    // Copied before anything is recorded: a file that cannot go stops the request, not half of it.
    const handed = opts.attach ? await opts.attach(toThread.id) : null;
    const job: JobRow = {
      id: newId(),
      rootId,
      depth,
      kind: opts.kind,
      fromBotId: from.id,
      toBotId: to.id,
      fromThreadId: opts.fromThreadId,
      fromTurnId: opts.fromTurnId ?? null,
      toThreadId: toThread.id,
      approvalId: opts.approvalId ?? null,
      request: opts.text,
      reply: null,
      status: 'pending',
      createdAt: new Date(),
      finishedAt: null,
      deliveredAt: null,
      replyFiles: [],
    };
    await this.ctx.db.insert(schema.jobs).values(job);
    await this.services.threads.addMessage({
      threadId: toThread.id,
      role: 'user',
      author: `bot:${from.id}`,
      text: opts.text,
      props: {
        jobId: job.id,
        ...(opts.outside && { outside: opts.outside }),
        ...(handed?.files.length && { files: handed.files }),
      },
    });
    // One-line marker in the sender's thread; expands to the bot conversation.
    await this.services.threads.addMessage({
      threadId: opts.fromThreadId,
      role: 'marker',
      author: `bot:${from.id}`,
      text: t('job.marker', { to: to.name }),
      props: { jobId: job.id, peerBotId: to.id, peerThreadId: toThread.id, count: 1, direction: 'out' },
    });
    const filesNote = handed?.shown.length
      ? `\n\n${t('job.files', { files: handed.shown.map((f) => `- ${f}`).join('\n') })}`
      : '';
    const prompt = t(opts.kind === 'notify' ? 'job.notice' : 'job.request', {
      from: from.name,
      text: opts.text,
      note: approvalNote + filesNote,
    });
    await this.services.turns.enqueue({
      threadId: toThread.id,
      botId: to.id,
      source: 'bot',
      prompt,
      jobId: job.id,
      outside: opts.outside ?? null,
    });
    return job;
  }

  /**
   * Hands files back with the answer to a request the bot is working on: copies land in the
   * sender's conversation folder, and the sender reads where with the answer.
   */
  async replyFiles(jobId: string, by: Bot, byThreadId: string, paths: string[], t: T): Promise<string[]> {
    const job = await this.get(jobId);
    if (job.toBotId !== by.id || job.toThreadId !== byThreadId || job.kind === 'notify') {
      throw new HttpError(409, 'error.notAnswering');
    }
    if (job.status !== 'pending') throw new HttpError(409, 'error.jobAnswered');
    const from = await this.services.bots.get(job.fromBotId);
    const handed = await handFiles({
      dataDir: this.ctx.config.dataDir,
      from: by,
      fromThreadId: byThreadId,
      to: from,
      toThreadId: job.fromThreadId,
      paths,
      t,
    });
    await this.ctx.db
      .update(schema.jobs)
      .set({ replyFiles: sql`${schema.jobs.replyFiles} || ${JSON.stringify(handed.shown)}::jsonb` })
      .where(eq(schema.jobs.id, job.id));
    return handed.shown.map((f) => basename(f));
  }

  /** Turn hook: when a job's target turn ends, deliver the reply to the sender. */
  async onTurnFinished(turn: TurnRow, outcome: TurnOutcome) {
    if (!turn.jobId || turn.source !== 'bot') return;
    const job = await this.get(turn.jobId).catch(() => null);
    if (job && job.fromThreadId === turn.threadId) await this.recountAnswered(job);
    if (!job || job.toThreadId !== turn.threadId || job.status !== 'pending') return;
    const t = await serverTranslator(this.ctx);
    const reply =
      outcome.text.trim() ||
      (outcome.ok ? t('job.emptyReply') : t('job.failedReply', { message: outcome.message }));
    const status = outcome.ok ? 'done' : outcome.kind === 'interrupted' ? 'stopped' : 'error';
    await this.ctx.db
      .update(schema.jobs)
      .set({ reply, status, finishedAt: new Date() })
      .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, 'pending')));
    const from = await this.services.bots.get(job.fromBotId).catch(() => null);
    if (!from || from.archivedAt) {
      // The routine run that asked would wait for this answer forever.
      if (job.fromTurnId) await this.services.routines.abandonAsked(job.fromTurnId);
      return;
    }
    await this.markReplied(job);
    if (job.kind === 'notify') return;
    await this.deliver(job);
  }

  /**
   * Ends requests left waiting with no turn to answer them: the server stopped between recording
   * the request and queueing its turn, or between the turn's end and passing its answer on. Their
   * sender hears so, or gets that answer, and the answers to requests it made in the same turn are
   * no longer held back for them. Call after the turns' own recovery.
   */
  async recover() {
    const orphaned = await this.ctx.db
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.status, 'pending'),
          notExists(
            this.ctx.db
              .select({ id: schema.turns.id })
              .from(schema.turns)
              .where(
                and(
                  eq(schema.turns.jobId, schema.jobs.id),
                  eq(schema.turns.threadId, schema.jobs.toThreadId),
                  inArray(schema.turns.status, ['queued', 'running']),
                ),
              ),
          ),
        ),
      );
    if (!orphaned.length) return;
    const t = await serverTranslator(this.ctx);
    // A sender that has waited longer than this has moved on: the request just closes.
    const fresh = Date.now() - RECOVER_WAKE_MS;
    for (const job of orphaned) {
      try {
        const answer = await this.finishedAnswer(job);
        const [ended] = await this.ctx.db
          .update(schema.jobs)
          .set({
            reply: answer?.reply ?? t('job.failedReply', { message: t('turn.serverRestarted') }),
            status: answer?.status ?? 'error',
            finishedAt: new Date(),
            ...(job.createdAt.getTime() < fresh && { deliveredAt: new Date() }),
          })
          .where(and(eq(schema.jobs.id, job.id), eq(schema.jobs.status, 'pending')))
          .returning();
        if (!ended) continue;
        const from = await this.services.bots.get(ended.fromBotId).catch(() => null);
        if (!from || from.archivedAt) {
          if (ended.fromTurnId) await this.services.routines.abandonAsked(ended.fromTurnId);
          continue;
        }
        await this.markReplied(ended);
        if (ended.kind !== 'notify' && !ended.deliveredAt) await this.deliver(ended);
      } catch (err) {
        // The sender's conversation may be gone; one request does not hold up the start.
        console.warn(`Could not close a request left by the restart: ${String(err)}`);
      }
    }
  }

  /**
   * What the target's turn for a request answered, when it ended but the server stopped before the
   * answer was passed on; null when no turn of it ended.
   */
  private async finishedAnswer(job: JobRow): Promise<{ reply: string; status: JobRow['status'] } | null> {
    const [turn] = await this.ctx.db
      .select({ id: schema.turns.id, status: schema.turns.status, error: schema.turns.error })
      .from(schema.turns)
      .where(and(eq(schema.turns.jobId, job.id), eq(schema.turns.threadId, job.toThreadId)))
      .orderBy(desc(schema.turns.createdAt))
      .limit(1);
    if (!turn || turn.status === 'queued' || turn.status === 'running') return null;
    const [said] = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(and(eq(schema.messages.turnId, turn.id), eq(schema.messages.role, 'assistant')))
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    const t = await serverTranslator(this.ctx);
    const text = said ? toMessage(said).text.trim() : '';
    if (turn.status === 'done') return { reply: text || t('job.emptyReply'), status: 'done' };
    return {
      reply: text || t('job.failedReply', { message: turn.error ?? t('turn.serverRestarted') }),
      status: turn.status === 'interrupted' ? 'stopped' : 'error',
    };
  }

  /**
   * Hands replies to the sender as one new turn. Requests made in the same turn wait for each
   * other, so a bot that asked several bots reads all their answers at once instead of answering
   * the person again after each.
   */
  private async deliver(job: JobRow) {
    const siblings = await this.ctx.db
      .select()
      .from(schema.jobs)
      .where(
        job.fromTurnId
          ? and(eq(schema.jobs.fromTurnId, job.fromTurnId), sql`${schema.jobs.kind} <> 'notify'`)
          : eq(schema.jobs.id, job.id),
      );
    if (siblings.some((j) => j.status === 'pending')) return;
    // Claimed in one statement: of two replies finishing at once, only one turn hands them over.
    const claimed = await this.ctx.db
      .update(schema.jobs)
      .set({ deliveredAt: new Date() })
      .where(
        and(
          inArray(
            schema.jobs.id,
            siblings.map((j) => j.id),
          ),
          isNull(schema.jobs.deliveredAt),
        ),
      )
      .returning();
    if (!claimed.length) return;
    claimed.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    // An answer written in a run that had read outside text carries those words back.
    const [read] = await this.ctx.db
      .select({ outside: schema.turns.outside })
      .from(schema.turns)
      .where(
        and(
          inArray(
            schema.turns.jobId,
            claimed.map((j) => j.id),
          ),
          isNotNull(schema.turns.outside),
        ),
      )
      .limit(1);
    const t = await serverTranslator(this.ctx);
    const parts: string[] = [];
    for (const j of claimed) {
      const to = await this.services.bots.get(j.toBotId).catch(() => null);
      const files = j.replyFiles.length
        ? `\n\n${t('job.replyFiles', { files: j.replyFiles.map((f) => `- ${f}`).join('\n') })}`
        : '';
      parts.push(
        t('job.reply', {
          to: to?.name ?? '?',
          status: t(j.status === 'done' ? 'job.done' : 'job.failed'),
          reply: (j.reply ?? '') + files,
        }),
      );
    }
    await this.services.turns.enqueue({
      threadId: job.fromThreadId,
      botId: job.fromBotId,
      source: 'bot',
      prompt: parts.join('\n\n---\n\n'),
      jobId: claimed.at(-1)!.id,
      outside: read?.outside ?? null,
      routineRunId: await this.routineRunOf(job.fromTurnId),
    });
  }

  /**
   * The routine run a request was made in. A run that delegates ends in the turn that reads the
   * answers, not in the turn that asked, so that turn belongs to the run too. A run the person
   * stopped or that failed is over: its late answers are just a bot's turn.
   */
  private async routineRunOf(turnId: string | null): Promise<string | null> {
    if (!turnId) return null;
    const [row] = await this.ctx.db
      .select({ id: schema.routineRuns.id })
      .from(schema.turns)
      .innerJoin(schema.routineRuns, eq(schema.routineRuns.id, schema.turns.routineRunId))
      .where(
        and(eq(schema.turns.id, turnId), inArray(schema.routineRuns.status, ['running', 'waiting', 'done'])),
      )
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * The messages of one request and the work it started: the request itself and what the target
   * bot wrote in the turns it ran for it, including the turns that read the answers of bots it
   * asked in turn. The thread of a pair of bots holds every request they ever exchanged; a marker
   * opens only to its own.
   */
  async exchange(job: JobRow): Promise<Message[]> {
    const thread = job.toThreadId;
    const { turns } = await this.work(job);
    const rows = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, thread),
          or(
            turns.size ? inArray(schema.messages.turnId, [...turns]) : undefined,
            sql`${schema.messages.props}->>'jobId' = ${job.id}`,
          ),
        ),
      )
      .orderBy(asc(schema.messages.createdAt), asc(schema.messages.id));
    return rows.map(toMessage);
  }

  /**
   * The turns the target ran for a request in its thread with the sender, including the turns that
   * read the answers of bots it asked in turn, and the requests it made of those bots.
   */
  private async work(job: JobRow): Promise<{ turns: Set<string>; asked: JobRow[] }> {
    const thread = job.toThreadId;
    const turns = new Set(
      (
        await this.ctx.db
          .select({ id: schema.turns.id })
          .from(schema.turns)
          .where(and(eq(schema.turns.jobId, job.id), eq(schema.turns.threadId, thread)))
      ).map((r) => r.id),
    );
    const all: JobRow[] = [];
    // Answers to what those turns asked other bots come back as further turns here.
    let asking = [...turns];
    for (let i = 0; asking.length && i <= this.ctx.config.maxJobDepth; i++) {
      const asked = await this.ctx.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.fromThreadId, thread), inArray(schema.jobs.fromTurnId, asking)));
      all.push(...asked);
      const answered = asked.length
        ? await this.ctx.db
            .select({ id: schema.turns.id })
            .from(schema.turns)
            .where(
              and(
                eq(schema.turns.threadId, thread),
                inArray(
                  schema.turns.jobId,
                  asked.map((j) => j.id),
                ),
              ),
            )
        : [];
      asking = answered.map((r) => r.id).filter((id) => !turns.has(id));
      for (const id of asking) turns.add(id);
    }
    return { turns, asked: all };
  }

  private async markReplied(job: JobRow) {
    await this.recount(job, { replied: true });
  }

  /**
   * A turn that read answers of bots asked for a request belongs to that request's exchange, so
   * the markers of the requests this thread was working on count it too.
   */
  private async recountAnswered(answer: JobRow) {
    const asked = await this.ctx.db
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.rootId, answer.rootId),
          eq(schema.jobs.toThreadId, answer.fromThreadId),
          sql`${schema.jobs.status} <> 'pending'`,
        ),
      );
    for (const job of asked) await this.recount(job);
  }

  /** Writes on the job's marker how many messages the open marker shows. */
  private async recount(job: JobRow, extra: Record<string, unknown> = {}, opts: { quiet?: boolean } = {}) {
    const rows = await this.ctx.db
      .select()
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, job.fromThreadId),
          eq(schema.messages.role, 'marker'),
          sql`${schema.messages.props}->>'jobId' = ${job.id}`,
        ),
      );
    const marker = rows[0];
    if (!marker) return;
    const count = Math.max(
      (await this.exchange(job)).filter((m) => m.role === 'user' || m.role === 'assistant').length,
      1,
    );
    const props = marker.props as Record<string, unknown>;
    if (props.count === count && Object.entries(extra).every(([k, v]) => props[k] === v)) return;
    const next = { ...props, ...extra, count };
    if (opts.quiet) {
      await this.ctx.db.update(schema.messages).set({ props: next }).where(eq(schema.messages.id, marker.id));
    } else {
      await this.services.threads.updateMessage(marker.id, { props: next });
    }
  }

  /**
   * Markers written before a marker opened to its own request counted every message the two bots
   * ever exchanged, so a closed line showed more than it opened to. Counted again once.
   */
  async recountMarkers() {
    const KEY = 'jobs.markerCounts';
    const [done] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, KEY)).limit(1);
    if (done) return;
    const markers = await this.ctx.db
      .select({ jobId: sql<string>`${schema.messages.props}->>'jobId'` })
      .from(schema.messages)
      .where(and(eq(schema.messages.role, 'marker'), sql`${schema.messages.props}->>'jobId' is not null`));
    for (const { jobId } of markers) {
      const job = await this.get(jobId).catch(() => null);
      if (!job || job.status === 'pending') continue;
      await this.recount(job, {}, { quiet: true });
    }
    await this.ctx.db.insert(schema.kv).values({ key: KEY, value: true }).onConflictDoNothing();
  }

  async status(botId: string) {
    const threads = await this.services.threads.list(botId);
    const running = threads.filter((t) => t.state !== 'idle');
    const pending = await this.ctx.db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.toBotId, botId), eq(schema.jobs.status, 'pending')));
    return {
      busy: running.length > 0,
      threads: running.map((t) => ({ id: t.id, state: t.state })),
      pendingJobs: pending.length,
    };
  }

  /**
   * The requests one bot sent to others: the ones still open first, then the most recent. Only
   * its own (`fromBotId`), so no bot reads what another asked.
   */
  async requestsFrom(botId: string, limit = 15) {
    return this.ctx.db
      .select({
        id: schema.jobs.id,
        toBotName: schema.bots.name,
        kind: schema.jobs.kind,
        status: schema.jobs.status,
        request: schema.jobs.request,
        reply: schema.jobs.reply,
        createdAt: schema.jobs.createdAt,
      })
      .from(schema.jobs)
      .leftJoin(schema.bots, eq(schema.bots.id, schema.jobs.toBotId))
      .where(eq(schema.jobs.fromBotId, botId))
      .orderBy(sql`(${schema.jobs.status} = 'pending') desc`, desc(schema.jobs.createdAt))
      .limit(limit);
  }

  /**
   * When the person stops a conversation, the work its bot gave other bots stops too, and so on
   * down the chain. No reply comes back to wake the stopped bot. Returns how many bots stopped.
   */
  async stopFrom(threadId: string): Promise<number> {
    await this.silence(await this.liveFrom(threadId));
    // A request the stopped turn was making as the stop came is on record once it has ended.
    await this.services.turns.settle(threadId);
    const live = await this.liveFrom(threadId);
    if (!live.length) return 0;
    await this.silence(live);
    let stopped = 0;
    for (const job of live) stopped += await this.halt(job);
    return stopped;
  }

  /**
   * The requests a conversation made whose work goes on. A request is done once its target's first
   * turn ends, while the bots that target asked go on working for it: so every request of a chain
   * still at work counts, and so does an answer held back for an open request of the same turn.
   */
  private async liveFrom(threadId: string): Promise<JobRow[]> {
    const other = alias(schema.jobs, 'other');
    return this.ctx.db
      .select()
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.fromThreadId, threadId),
          or(
            eq(schema.jobs.status, 'pending'),
            and(isNull(schema.jobs.deliveredAt), sql`${schema.jobs.kind} <> 'notify'`),
            exists(
              this.ctx.db
                .select({ id: other.id })
                .from(other)
                .where(and(eq(other.rootId, schema.jobs.rootId), eq(other.status, 'pending'))),
            ),
          ),
        ),
      );
  }

  /**
   * Requests whose answers are no longer to wake their sender, which was stopped: the open ones,
   * and those answered already but held back for an open one of the same turn.
   */
  private async silence(jobs: JobRow[]) {
    const waiting = jobs.filter((j) => !j.deliveredAt);
    if (!waiting.length) return;
    await this.ctx.db
      .update(schema.jobs)
      .set({ deliveredAt: new Date() })
      .where(
        and(
          inArray(
            schema.jobs.id,
            waiting.map((j) => j.id),
          ),
          isNull(schema.jobs.deliveredAt),
        ),
      );
  }

  /**
   * Stops one request's work at its target, and what the target handed on to other bots for it;
   * other requests between the same two bots go on. Returns how many bots stopped.
   */
  private async halt(job: JobRow, depth = 0): Promise<number> {
    let stopped = (await this.services.turns.stopJob(job.id, job.toThreadId)) ? 1 : 0;
    // Answers already handed back are being read in the target's thread: that is this work too.
    const stopAnswers = async (asked: JobRow[]) => {
      await this.silence(asked);
      for (const child of asked) await this.services.turns.stopJob(child.id, job.toThreadId);
    };
    await stopAnswers((await this.work(job)).asked);
    // A request the target was making as it stopped is looked for once its turns have ended.
    await this.services.turns.settle(job.toThreadId);
    const { asked } = await this.work(job);
    await stopAnswers(asked);
    if (depth >= this.ctx.config.maxJobDepth) return stopped;
    for (const child of asked) stopped += await this.halt(child, depth + 1);
    return stopped;
  }

  /** Stops a request the bot sent, with what it started; the sender hears that it stopped. */
  async stop(jobId: string, requester: Bot) {
    const job = await this.get(jobId);
    if (job.fromBotId !== requester.id && !requester.isManager) {
      throw new HttpError(403, 'error.jobStopForbidden');
    }
    await this.halt(job);
    return job;
  }
}
