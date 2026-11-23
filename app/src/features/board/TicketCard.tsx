import type { Ticket } from '@leafbot/shared';
import { MessageSquare } from 'lucide-react';
import { BotAvatar } from '@/components/BotAvatar';
import { useT } from '@/i18n';
import { useThreadActivity, type BotActivity } from '@/lib/botActivity';
import { useFormat } from '@/lib/format';
import { useBots } from '@/lib/queries';
import { cn } from '@/lib/utils';
import { PriorityIcon, Unassigned } from './parts';

/** A description as one plain line for the card: markdown marks and line breaks would only add noise. */
export function snippet(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** What the assigned bot is doing on the ticket right now, worded for the card; null when nothing. */
function liveLabel(activity: BotActivity): 'working' | 'queued' | 'waiting' | null {
  if (activity === 'thinking' || activity === 'writing' || activity === 'browsing') return 'working';
  if (activity === 'queued' || activity === 'waiting') return activity;
  return null;
}

export function TicketCard({
  ticket,
  selected,
  lifted,
  ghost,
  onOpen,
  onGrab,
}: {
  ticket: Ticket;
  /** Its details are open beside the board. */
  selected?: boolean;
  /** The copy that follows the pointer while the card is moved. */
  lifted?: boolean;
  /** The card left in place while its copy is moved. */
  ghost?: boolean;
  onOpen?(id: string): void;
  onGrab?(e: React.PointerEvent, ticket: Ticket): void;
}) {
  const t = useT();
  const { shortTime } = useFormat();
  const { data: bots = [] } = useBots();
  const bot = bots.find((b) => b.id === ticket.assigneeBotId) ?? null;
  // The state the board was loaded with, until a live event says otherwise.
  const activity = useThreadActivity(bot?.id ?? '', bot ? ticket.threadId : null, ticket.turnState);
  const live = ticket.status === 'in_progress' ? liveLabel(activity) : null;
  const summary = snippet(ticket.description);
  const closed = ticket.status === 'done' || ticket.status === 'wont_do';
  return (
    <div
      role="button"
      tabIndex={lifted ? -1 : 0}
      data-ticket-id={ticket.id}
      data-ticket-status={ticket.status}
      data-lifted={lifted || undefined}
      aria-current={selected || undefined}
      onPointerDown={onGrab ? (e) => onGrab(e, ticket) : undefined}
      onClick={() => onOpen?.(ticket.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen?.(ticket.id);
        }
      }}
      className={cn(
        'group/card @container relative flex cursor-default flex-col gap-1.5 rounded-xl border bg-card p-3 text-start shadow-xs transition-[box-shadow,border-color,opacity] outline-none select-none',
        'hover:border-foreground/15 hover:shadow-sm focus-visible:ring-[3px] focus-visible:ring-ring/50',
        selected && 'border-foreground/30 ring-1 ring-foreground/15 hover:border-foreground/30',
        lifted && 'rotate-[1.5deg] cursor-grabbing border-foreground/15 shadow-xl',
        ghost && 'opacity-40',
      )}
    >
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="tabular-nums">#{ticket.number}</span>
        {live && (
          <span
            className={cn(
              'flex min-w-0 items-center gap-1 font-medium',
              live === 'waiting' ? 'text-amber-600 dark:text-amber-400' : 'text-blue-600 dark:text-blue-400',
            )}
          >
            <span className="relative flex size-1.5 shrink-0">
              {live === 'working' && (
                <span className="absolute inset-0 animate-ping rounded-full bg-current opacity-60" />
              )}
              <span className="relative size-1.5 rounded-full bg-current" />
            </span>
            <span className="truncate">{t(`board.live.${live}`)}</span>
          </span>
        )}
        <span className="flex-1" />
        <span title={t(`board.priority.${ticket.priority}`)} className="flex">
          <PriorityIcon priority={ticket.priority} className="size-3.5" />
          <span className="sr-only">{t(`board.priority.${ticket.priority}`)}</span>
        </span>
      </div>
      <p
        className={cn(
          'line-clamp-3 text-sm leading-snug font-medium [overflow-wrap:anywhere]',
          ticket.status === 'wont_do' && 'text-muted-foreground line-through',
          ticket.status === 'done' && 'text-muted-foreground',
        )}
      >
        {ticket.title}
      </p>
      {summary && !closed && (
        <p className="line-clamp-2 text-xs leading-relaxed text-muted-foreground [overflow-wrap:anywhere]">
          {summary}
        </p>
      )}
      <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
        {bot ? (
          <>
            <BotAvatar
              avatar={bot.avatar}
              color={bot.color}
              seed={bot.id}
              size={20}
              activity={live ? activity : undefined}
            />
            <span className="min-w-0 truncate">{bot.name}</span>
          </>
        ) : (
          <>
            <Unassigned size={20} />
            <span className="min-w-0 truncate">{t('board.nobody')}</span>
          </>
        )}
        <span className="flex-1" />
        {ticket.comments.length > 0 && (
          <span className="flex shrink-0 items-center gap-0.5 tabular-nums">
            <MessageSquare className="size-3" />
            {ticket.comments.length}
          </span>
        )}
        <span className="shrink-0 tabular-nums @max-[13rem]:hidden">{shortTime(ticket.updatedAt)}</span>
      </div>
    </div>
  );
}
