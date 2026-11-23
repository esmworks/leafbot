import {
  TICKET_PRIORITIES,
  TICKET_STATUSES,
  type Bot,
  type TicketPriority,
  type TicketStatus,
} from '@leafbot/shared';
import { UserRound } from 'lucide-react';
import { BotAvatar } from '@/components/BotAvatar';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useLocale, useT } from '@/i18n';
import { initials } from '@/lib/format';
import { useBots, useSettings } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** Statuses a bot does not work in; an assigned ticket moved out of them starts its bot again. */
export const CLOSED: TicketStatus[] = ['done', 'wont_do'];
/** Statuses in which an assigned bot works on its ticket; the server starts it on entering them. */
export const OPEN: TicketStatus[] = ['todo', 'in_progress'];

export const STATUS_TINT: Record<TicketStatus, string> = {
  todo: 'text-muted-foreground',
  in_progress: 'text-blue-600 dark:text-blue-400',
  in_review: 'text-violet-600 dark:text-violet-400',
  blocked: 'text-red-600 dark:text-red-400',
  done: 'text-emerald-600 dark:text-emerald-400',
  wont_do: 'text-muted-foreground',
};

/**
 * A status as a ring that fills as the work goes on, so the columns read at a glance without
 * leaning on colour alone.
 */
export function StatusIcon({ status, className }: { status: TicketStatus; className?: string }) {
  const cls = cn('size-4 shrink-0', STATUS_TINT[status], className);
  const ring = <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />;
  switch (status) {
    case 'todo':
      return (
        <svg viewBox="0 0 16 16" className={cls} aria-hidden>
          {ring}
        </svg>
      );
    case 'in_progress':
      return (
        <svg viewBox="0 0 16 16" className={cls} aria-hidden>
          {ring}
          <path d="M8 4a4 4 0 0 1 0 8z" fill="currentColor" />
        </svg>
      );
    case 'in_review':
      return (
        <svg viewBox="0 0 16 16" className={cls} aria-hidden>
          {ring}
          <path d="M8 4a4 4 0 1 1 -4 4h4z" fill="currentColor" />
        </svg>
      );
    case 'blocked':
      return (
        <svg viewBox="0 0 16 16" className={cls} aria-hidden>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <rect x="7.1" y="3.8" width="1.8" height="5.2" rx="0.9" className="fill-background" />
          <circle cx="8" cy="11.4" r="1" className="fill-background" />
        </svg>
      );
    case 'done':
      return (
        <svg viewBox="0 0 16 16" className={cls} aria-hidden>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5 8.2l2 2 4-4.2"
            fill="none"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="stroke-background"
          />
        </svg>
      );
    case 'wont_do':
      return (
        <svg viewBox="0 0 16 16" className={cls} aria-hidden>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          <path
            d="M5.6 5.6l4.8 4.8M10.4 5.6l-4.8 4.8"
            strokeWidth="1.6"
            strokeLinecap="round"
            className="stroke-background"
          />
        </svg>
      );
  }
}

/** A priority as signal bars; urgent is a filled mark that stands out from the rest. */
export function PriorityIcon({ priority, className }: { priority: TicketPriority; className?: string }) {
  if (priority === 'urgent') {
    return (
      <svg
        viewBox="0 0 16 16"
        className={cn('size-4 shrink-0 text-red-600 dark:text-red-400', className)}
        aria-hidden
      >
        <rect x="1.5" y="1.5" width="13" height="13" rx="3.5" fill="currentColor" />
        <rect x="7.1" y="4" width="1.8" height="5" rx="0.9" className="fill-background" />
        <circle cx="8" cy="11.3" r="1" className="fill-background" />
      </svg>
    );
  }
  const lit = { low: 1, normal: 2, high: 3 }[priority];
  return (
    <svg
      viewBox="0 0 16 16"
      className={cn(
        'size-4 shrink-0',
        priority === 'high' ? 'text-foreground' : 'text-muted-foreground',
        className,
      )}
      aria-hidden
    >
      {[0, 1, 2].map((i) => (
        <rect
          key={i}
          x={2 + i * 4.5}
          y={10 - i * 3.5}
          width="3"
          height={4 + i * 3.5}
          rx="1"
          fill="currentColor"
          opacity={i < lit ? 1 : 0.25}
        />
      ))}
    </svg>
  );
}

/** The person, shown where a bot would show its avatar. */
export function PersonBadge({ size = 24 }: { size?: number }) {
  const { data: settings } = useSettings();
  const intl = useLocale((s) => s.intl);
  const t = useT();
  const name = settings?.userName || t('sidebar.defaultUser');
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full bg-secondary font-semibold text-secondary-foreground"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4) }}
    >
      {initials(name, intl)}
    </span>
  );
}

/** Who wrote something on the board: the person or a bot (`bot:<id>`). */
export function useAuthor() {
  const t = useT();
  const { data: bots = [] } = useBots();
  const { data: settings } = useSettings();
  return (author: string): { name: string; bot: Bot | null } => {
    if (author === 'user') return { name: settings?.userName || t('board.you'), bot: null };
    const bot = bots.find((b) => `bot:${b.id}` === author) ?? null;
    return { name: bot?.name ?? t('board.someone'), bot };
  };
}

export function AuthorAvatar({ bot, size = 24 }: { bot: Bot | null; size?: number }) {
  return bot ? (
    <BotAvatar avatar={bot.avatar} color={bot.color} seed={bot.id} size={size} />
  ) : (
    <PersonBadge size={size} />
  );
}

export const NOBODY = '__nobody__';

/** A property control that reads as plain text until pointed at, as in the ticket's side panel. */
const QUIET =
  'h-8 w-full justify-start gap-2 rounded-lg border-transparent bg-transparent px-2 shadow-none hover:bg-accent dark:bg-transparent dark:hover:bg-accent [&>svg:last-child]:ms-auto [&>svg:last-child]:opacity-0 hover:[&>svg:last-child]:opacity-50';

export function StatusSelect({
  value,
  onChange,
  quiet,
}: {
  value: TicketStatus;
  onChange(s: TicketStatus): void;
  quiet?: boolean;
}) {
  const t = useT();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TicketStatus)}>
      <SelectTrigger className={cn(quiet ? QUIET : 'w-44 rounded-xl')} aria-label={t('board.statusLabel')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {TICKET_STATUSES.map((s) => (
          <SelectItem key={s} value={s}>
            <StatusIcon status={s} />
            {t(`board.status.${s}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function PrioritySelect({
  value,
  onChange,
  quiet,
}: {
  value: TicketPriority;
  onChange(p: TicketPriority): void;
  quiet?: boolean;
}) {
  const t = useT();
  return (
    <Select value={value} onValueChange={(v) => onChange(v as TicketPriority)}>
      <SelectTrigger className={cn(quiet ? QUIET : 'w-auto rounded-xl')} aria-label={t('board.priority')}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {[...TICKET_PRIORITIES].reverse().map((p) => (
          <SelectItem key={p} value={p}>
            <PriorityIcon priority={p} />
            {t(`board.priority.${p}`)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function AssigneeSelect({
  value,
  onChange,
  quiet,
}: {
  value: string | null;
  onChange(id: string | null): void;
  quiet?: boolean;
}) {
  const t = useT();
  const { data: bots = [] } = useBots();
  // A ticket may still name a bot that was archived since; it stays listed so the value shows.
  const listed = bots.filter((b) => !b.archivedAt || b.id === value);
  return (
    <Select value={value ?? NOBODY} onValueChange={(v) => onChange(v === NOBODY ? null : v)}>
      <SelectTrigger
        className={cn(quiet ? QUIET : 'w-auto max-w-56 rounded-xl')}
        aria-label={t('board.assignee')}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={NOBODY}>
          <Unassigned />
          {t('board.nobody')}
        </SelectItem>
        {listed.map((b) => (
          <SelectItem key={b.id} value={b.id}>
            <BotAvatar avatar={b.avatar} color={b.color} seed={b.id} size={18} />
            <span className="truncate">{b.name}</span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The empty place of an assignee. */
export function Unassigned({ size = 18 }: { size?: number }) {
  return (
    <span
      className="flex shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/50 text-muted-foreground"
      style={{ width: size, height: size }}
    >
      <UserRound style={{ width: size * 0.6, height: size * 0.6 }} />
    </span>
  );
}
