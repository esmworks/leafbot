import {
  TicketCreate,
  TicketUpdate,
  type Ticket,
  type TicketComment,
  type TicketCreate as CreateInput,
  type TicketStatus,
  type TicketUpdate as UpdateInput,
  type TurnState,
} from '@leafbot/shared';
import { asc, desc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import type { TurnOutcome } from '../engine/types';
import { schema } from '../db';
import type { TurnRow } from '../runtime/turns';
import { HttpError, newId, truncate } from '../util';
import type { Services } from './index';

type Row = typeof schema.tickets.$inferSelect;
type CommentRow = typeof schema.ticketComments.$inferSelect;

/** A report the bot writes back is kept to this length as a comment. */
const MAX_REPORT = 8000;
/** Statuses in which an assigned bot works on its ticket. */
const OPEN: TicketStatus[] = ['todo', 'in_progress'];

const toComment = (c: CommentRow): TicketComment => ({
  id: c.id,
  author: c.author,
  text: c.text,
  createdAt: c.createdAt.toISOString(),
});

/** A place above every ticket, so one that comes into a column stands at its top. */
const TOP = sql<number>`(select coalesce(min(${schema.tickets.position}), 0) - 1 from ${schema.tickets})`;

const toTicket = (r: Row, comments: CommentRow[], turnState: TurnState): Ticket => ({
  id: r.id,
  number: r.number,
  title: r.title,
  description: r.description,
  status: r.status,
  priority: r.priority,
  assigneeBotId: r.assigneeBotId,
  createdBy: r.createdBy,
  createdByUserId: r.createdByUserId,
  threadId: r.threadId,
  position: r.position,
  turnState,
  comments: comments.map(toComment),
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * The board: tickets the person and the bots both work from. Assigning a ticket to a bot starts it
 * on the work in a conversation of the ticket's own, out of the person's chats; when the turn
 * ends, its reply is left on the ticket as a comment and an open ticket moves to review. A comment
 * from the person on an assigned ticket sends the bot back to it.
 *
 * Work a bot hands to a bot through a ticket starts at once, but a ticket made during ticket work
 * waits for the person: tickets cannot keep starting each other.
 */
export class TicketService {
  constructor(
    private ctx: Ctx,
    private services: Services,
  ) {}

  private changed() {
    this.ctx.bus.refresh({ scope: 'tickets' });
  }

  private async withComments(rows: Row[]): Promise<Ticket[]> {
    if (!rows.length) return [];
    const comments = await this.ctx.db
      .select()
      .from(schema.ticketComments)
      .where(
        inArray(
          schema.ticketComments.ticketId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(schema.ticketComments.createdAt));
    const states = await this.services.threads.states(rows.flatMap((r) => (r.threadId ? [r.threadId] : [])));
    return rows.map((r) =>
      toTicket(
        r,
        comments.filter((c) => c.ticketId === r.id),
        (r.threadId && states.get(r.threadId)) || 'idle',
      ),
    );
  }

  async list(opts: { status?: TicketStatus[]; assigneeBotId?: string } = {}): Promise<Ticket[]> {
    const rows = await this.ctx.db.select().from(schema.tickets).orderBy(desc(schema.tickets.number));
    return this.withComments(
      rows.filter(
        (r) =>
          (!opts.status || opts.status.includes(r.status)) &&
          (!opts.assigneeBotId || r.assigneeBotId === opts.assigneeBotId),
      ),
    );
  }

  private async row(id: string): Promise<Row> {
    const [row] = await this.ctx.db.select().from(schema.tickets).where(eq(schema.tickets.id, id)).limit(1);
    if (!row) throw new HttpError(404, 'error.notFound.ticket');
    return row;
  }

  async get(id: string): Promise<Ticket> {
    return (await this.withComments([await this.row(id)]))[0]!;
  }

  /** A ticket by its number (`12` or `#12`) or id. */
  async find(ref: string | number): Promise<Ticket | null> {
    const n = typeof ref === 'number' ? ref : Number(String(ref).replace(/^#/, ''));
    const [row] = await this.ctx.db
      .select()
      .from(schema.tickets)
      .where(Number.isInteger(n) && n > 0 ? eq(schema.tickets.number, n) : eq(schema.tickets.id, String(ref)))
      .limit(1);
    return row ? this.get(row.id) : null;
  }

  /**
   * Adds a ticket. `by` is `user` or `bot:<id>`; `start` false keeps an assigned ticket waiting
   * for the person instead of starting its bot.
   */
  async create(raw: CreateInput, by = 'user', start = true, userId: string | null = null): Promise<Ticket> {
    const input = TicketCreate.parse(raw);
    if (input.assigneeBotId) await this.services.bots.get(input.assigneeBotId);
    const [row] = await this.ctx.db
      .insert(schema.tickets)
      .values({
        id: newId(),
        number: sql`(select coalesce(max(${schema.tickets.number}), 0) + 1 from ${schema.tickets})`,
        title: input.title,
        description: input.description,
        priority: input.priority,
        assigneeBotId: input.assigneeBotId,
        createdBy: by,
        createdByUserId: userId,
        position: TOP,
      })
      .returning();
    this.changed();
    if (row!.assigneeBotId && start) await this.start(row!, 'assigned');
    return this.get(row!.id);
  }

  async update(id: string, raw: UpdateInput, start = true): Promise<Ticket> {
    const patch = TicketUpdate.parse(raw);
    const before = await this.row(id);
    if (patch.assigneeBotId) await this.services.bots.get(patch.assigneeBotId);
    // A ticket moved to another column without a place of its own goes to the top of it.
    const moved = patch.status !== undefined && patch.status !== before.status;
    const position = patch.position ?? (moved ? TOP : undefined);
    const [row] = await this.ctx.db
      .update(schema.tickets)
      .set({ ...patch, ...(position !== undefined && { position }), updatedAt: new Date() })
      .where(eq(schema.tickets.id, id))
      .returning();
    this.changed();
    // A new assignee, or a ticket opened again for the one it has, starts the work.
    const reassigned = patch.assigneeBotId && patch.assigneeBotId !== before.assigneeBotId;
    const reopened = patch.status && OPEN.includes(patch.status) && !OPEN.includes(before.status);
    // A ticket waiting for the person (one a bot opened during ticket work) starts when moved on.
    const started = patch.status === 'in_progress' && before.status !== 'in_progress';
    if (start && row!.assigneeBotId && (reassigned || reopened || started) && OPEN.includes(row!.status)) {
      await this.start(row!, 'assigned');
    }
    return this.get(id);
  }

  async remove(id: string): Promise<void> {
    await this.row(id);
    await this.ctx.db.delete(schema.tickets).where(eq(schema.tickets.id, id));
    this.changed();
  }

  /**
   * Puts a deleted ticket back as it was, with its number, place and comments. False when its
   * number was given to a ticket opened since: two tickets cannot both be #12.
   */
  async reinsert(k: Ticket): Promise<boolean> {
    const [taken] = await this.ctx.db
      .select({ id: schema.tickets.id })
      .from(schema.tickets)
      .where(or(eq(schema.tickets.number, k.number), eq(schema.tickets.id, k.id)))
      .limit(1);
    if (taken) return false;
    // What it pointed to may have gone since; the ticket comes back without it.
    const exists = async (
      table: typeof schema.bots | typeof schema.threads | typeof schema.users,
      id: string | null | undefined,
    ) =>
      id
        ? (await this.ctx.db.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1)).length > 0
        : false;
    await this.ctx.db.transaction(async (tx) => {
      await tx.insert(schema.tickets).values({
        id: k.id,
        number: k.number,
        title: k.title,
        description: k.description,
        status: k.status,
        priority: k.priority,
        assigneeBotId: (await exists(schema.bots, k.assigneeBotId)) ? k.assigneeBotId : null,
        createdBy: k.createdBy,
        createdByUserId: (await exists(schema.users, k.createdByUserId)) ? k.createdByUserId! : null,
        threadId: (await exists(schema.threads, k.threadId)) ? k.threadId : null,
        position: k.position,
        createdAt: new Date(k.createdAt),
        updatedAt: new Date(k.updatedAt),
      });
      if (k.comments.length) {
        await tx.insert(schema.ticketComments).values(
          k.comments.map((c) => ({
            id: c.id,
            ticketId: k.id,
            author: c.author,
            text: c.text,
            createdAt: new Date(c.createdAt),
          })),
        );
      }
    });
    this.changed();
    return true;
  }

  /** A comment on a ticket; the person's comment on an assigned, unfinished one sends its bot back. */
  async comment(id: string, text: string, by = 'user'): Promise<Ticket> {
    const row = await this.row(id);
    await this.ctx.db.insert(schema.ticketComments).values({ id: newId(), ticketId: id, author: by, text });
    await this.ctx.db.update(schema.tickets).set({ updatedAt: new Date() }).where(eq(schema.tickets.id, id));
    this.changed();
    if (by === 'user' && row.assigneeBotId && !['done', 'wont_do'].includes(row.status)) {
      await this.start(row, 'comment', text);
    }
    return this.get(id);
  }

  /** The ticket a conversation works on, if it is a ticket's. */
  async forThread(threadId: string): Promise<Ticket | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.tickets)
      .where(eq(schema.tickets.threadId, threadId))
      .limit(1);
    return row ? this.get(row.id) : null;
  }

  /** Starts the assignee on the ticket, in the ticket's conversation, made the first time. */
  private async start(row: Row, why: 'assigned' | 'comment', comment?: string) {
    const bot = await this.services.bots.get(row.assigneeBotId!).catch(() => null);
    if (!bot || bot.archivedAt) return;
    const t = await this.services.settings.translator();
    let threadId = row.threadId;
    if (threadId) {
      const thread = await this.services.threads.row(threadId).catch(() => null);
      // Reassigned: the new bot works in a conversation of its own.
      if (!thread || thread.botId !== bot.id) threadId = null;
    }
    if (!threadId) {
      threadId = (
        await this.services.threads.create(bot.id, {
          title: `#${row.number} ${row.title}`.slice(0, 120),
          kind: 'ticket',
          userId: null,
        })
      ).id;
    }
    await this.ctx.db
      .update(schema.tickets)
      .set({
        threadId,
        status: 'in_progress',
        // Started from another column, it goes to the top of the work in progress.
        ...(row.status !== 'in_progress' && { position: TOP }),
        updatedAt: new Date(),
      })
      .where(eq(schema.tickets.id, row.id));
    const ticket = await this.get(row.id);
    const prompt =
      why === 'comment'
        ? t('ticket.commentPrompt', { number: row.number, comment: comment ?? '' })
        : t('ticket.prompt', {
            number: row.number,
            title: row.title,
            priority: t(`ticket.priority.${row.priority}`),
            description: row.description || t('ticket.noDescription'),
            comments: ticket.comments.length
              ? ticket.comments.map((c) => `- ${c.author}: ${truncate(c.text, 1000)}`).join('\n')
              : t('ticket.noComments'),
          });
    await this.services.threads.addMessage({
      threadId,
      role: 'user',
      author: `ticket:${row.id}`,
      text: prompt,
      props: { ticketNumber: row.number },
    });
    // The work is for whoever opened the ticket; a bot's own ticket works for the bot's owner.
    await this.services.turns.enqueue({
      threadId,
      botId: bot.id,
      source: 'ticket',
      prompt,
      ...(row.createdByUserId && { userId: row.createdByUserId }),
    });
    this.changed();
  }

  /**
   * After a turn in a ticket's conversation: its reply goes on the ticket as the bot's comment, and
   * a ticket still in progress moves to review (or to blocked when the turn failed). A bot that set
   * the status itself keeps it.
   */
  async onTurnFinished(turn: TurnRow, outcome: TurnOutcome) {
    if (turn.source !== 'ticket') return;
    const ticket = await this.forThread(turn.threadId);
    if (!ticket) return;
    const t = await this.services.settings.translator();
    const text = outcome.ok ? outcome.text.trim() : t('ticket.failed', { message: outcome.message });
    if (text) {
      await this.ctx.db.insert(schema.ticketComments).values({
        id: newId(),
        ticketId: ticket.id,
        author: `bot:${turn.botId}`,
        text: truncate(text, MAX_REPORT),
      });
    }
    const [now] = await this.ctx.db.select().from(schema.tickets).where(eq(schema.tickets.id, ticket.id));
    if (now?.status === 'in_progress') {
      await this.ctx.db
        .update(schema.tickets)
        .set({ status: outcome.ok ? 'in_review' : 'blocked', position: TOP, updatedAt: new Date() })
        .where(eq(schema.tickets.id, ticket.id));
    }
    this.changed();
  }
}
