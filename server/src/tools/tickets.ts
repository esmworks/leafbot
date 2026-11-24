import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Bot,
  type Ticket,
  type TicketStatus,
} from '@leafbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { TurnRow } from '../runtime/turns';
import type { Services } from '../services';
import { truncate } from '../util';
import { pickFields, sig, ticketShape, type ChangeNote } from '../services/turn-changes';
import type { Define } from './index';

/** Tickets whose work is over; only these may a bot delete. */
const CLOSED: TicketStatus[] = ['done', 'wont_do'];

/**
 * The board, for bots: list tickets, open new ones (for itself, another bot or the person) and
 * update them with a status and a comment, and delete finished ones. A ticket a bot opens while working on a ticket waits
 * for the person instead of starting its assignee, so tickets cannot keep starting each other.
 * The prompt says when to use them (`prompt.boardHow`).
 */
export function ticketTools(opts: {
  def: Define;
  services: Services;
  bot: Bot;
  turn: TurnRow;
  t: T;
  /** A bot the turn's person may talk with, by name or id. */
  reach: (ref: string) => Promise<Bot>;
  /** Puts a change into the journal that takes the turn back. */
  note: (c: ChangeNote) => Promise<void>;
}): AppTool[] {
  const { def, services: s, bot, turn, t, note } = opts;
  const by = `bot:${bot.id}`;
  const start = turn.source !== 'ticket';
  const names = async () => new Map((await s.bots.list()).map((b) => [b.id, b.name]));
  const line = (k: Ticket, who: Map<string, string>) =>
    `- #${k.number} [${t(`ticket.status.${k.status}`)}] ${k.title} · ${t(`ticket.priority.${k.priority}`)}${k.assigneeBotId ? ` · ${who.get(k.assigneeBotId) ?? '?'}` : ''}`;
  const assignee = async (ref: string | undefined) => {
    if (ref === undefined) return undefined;
    if (!ref.trim()) return null;
    return (await opts.reach(ref)).id;
  };
  const tools = [
    def(
      'tickets_list',
      { status: z.array(z.enum(TICKET_STATUSES)).optional(), mine: z.boolean().optional() },
      async ({ status, mine }) => {
        const list = await s.tickets.list({ status, assigneeBotId: mine ? bot.id : undefined });
        if (!list.length) return t('tool.ticketsNone');
        const who = await names();
        return list
          .slice(0, 50)
          .map((k) => line(k, who))
          .join('\n');
      },
      'read',
    ),
    def(
      'ticket_read',
      { ticket: z.union([z.string(), z.number()]) },
      async ({ ticket }) => {
        const k = await s.tickets.find(ticket);
        if (!k) return t('tool.ticketMissing', { ticket: String(ticket) });
        const who = await names();
        const author = (a: string) => (a === 'user' ? t('ticket.you') : (who.get(a.slice(4)) ?? a));
        return [
          line(k, who),
          '',
          k.description || t('ticket.noDescription'),
          ...(k.comments.length
            ? ['', ...k.comments.map((c) => `> ${author(c.author)}: ${truncate(c.text, 2000)}`)]
            : []),
        ].join('\n');
      },
      'read',
    ),
    def(
      'ticket_create',
      {
        title: z.string().trim().min(1).max(200),
        description: z.string().max(20_000).optional(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        assign_to: z.string().max(200).optional(),
      },
      async (a) => {
        const k = await s.tickets.create(
          {
            title: a.title,
            description: a.description ?? '',
            priority: a.priority ?? 'normal',
            assigneeBotId: (await assignee(a.assign_to)) ?? null,
          },
          by,
          start,
          // Opened for the person the turn works for.
          turn.userId,
        );
        await note({
          kind: 'ticket',
          op: 'create',
          targetId: k.id,
          label: `#${k.number} ${k.title}`,
          after: { sig: sig(ticketShape(k)) },
        });
        return t(start || !k.assigneeBotId ? 'tool.ticketCreated' : 'tool.ticketCreatedWaiting', {
          number: k.number,
        });
      },
      'internal',
    ),
    def(
      'ticket_update',
      {
        ticket: z.union([z.string(), z.number()]),
        status: z.enum(TICKET_STATUSES).optional(),
        comment: z.string().max(20_000).optional(),
        assign_to: z.string().max(200).optional(),
        priority: z.enum(TICKET_PRIORITIES).optional(),
        title: z.string().trim().min(1).max(200).optional(),
        description: z.string().max(20_000).optional(),
      },
      async (a) => {
        const k = await s.tickets.find(a.ticket);
        if (!k) return t('tool.ticketMissing', { ticket: String(a.ticket) });
        const assigneeBotId = await assignee(a.assign_to);
        const patch = {
          ...(a.status && { status: a.status }),
          ...(a.priority && { priority: a.priority }),
          ...(a.title && { title: a.title }),
          ...(a.description !== undefined && { description: a.description }),
          ...(assigneeBotId !== undefined && { assigneeBotId }),
        };
        const updated = await s.tickets.update(k.id, patch, start);
        if (Object.keys(patch).length) {
          await note({
            kind: 'ticket',
            op: 'update',
            targetId: k.id,
            label: `#${k.number} ${updated.title}`,
            before: { patch: pickFields(k, Object.keys(patch)) },
            after: { sig: sig(ticketShape(updated)) },
          });
        }
        if (a.comment?.trim()) await s.tickets.comment(k.id, a.comment.trim(), by);
        return t('tool.ticketUpdated', { number: k.number });
      },
      'internal',
    ),
    def(
      'ticket_delete',
      {
        tickets: z
          .array(z.union([z.string(), z.number()]))
          .min(1)
          .max(50),
      },
      async (a) => {
        const out: string[] = [];
        const deleted: string[] = [];
        for (const ref of a.tickets) {
          const k = await s.tickets.find(ref);
          if (!k) {
            out.push(t('tool.ticketMissing', { ticket: String(ref) }));
            continue;
          }
          // Open work may still be going on; the bot drops it by setting it to wont_do first.
          if (!CLOSED.includes(k.status)) {
            out.push(t('tool.ticketNotClosed', { number: k.number, status: t(`ticket.status.${k.status}`) }));
            continue;
          }
          if (k.threadId && k.threadId === turn.threadId) {
            out.push(t('tool.ticketDeleteSelf', { number: k.number }));
            continue;
          }
          await s.tickets.remove(k.id);
          // The whole ticket is kept, so taking the turn back puts it back with its comments.
          await note({
            kind: 'ticket',
            op: 'delete',
            targetId: k.id,
            label: `#${k.number} ${k.title}`,
            before: { ticket: k as unknown as Record<string, unknown> },
          });
          deleted.push(`#${k.number}`);
        }
        if (deleted.length) out.unshift(t('tool.ticketsDeleted', { list: deleted.join(', ') }));
        return out.join('\n');
      },
      // Deleting goes by the bot's level, as deleting a routine does; the turn can be taken back.
    ),
  ];
  // Among a hundred tools the model would see the board's only by name behind a tool search, and
  // has no reason to look them up.
  for (const x of tools) x.alwaysLoad = true;
  return tools;
}
