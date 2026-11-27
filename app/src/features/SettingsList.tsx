import { ChevronRight, Server } from 'lucide-react';
import type { ReactNode } from 'react';
import { useT } from '@/i18n';
import { cn } from '@/lib/utils';

/**
 * Pieces shared by the settings sections that list things with a page of their own (providers,
 * chat apps): one line per thing with its mark, name, state and a few words, opening its page.
 */

/** A thing's mark: the first letter of its name, or a server for the person's own endpoints. */
export function Mark({
  name,
  endpoint = false,
  large = false,
}: {
  name: string;
  endpoint?: boolean;
  large?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-xl border bg-secondary font-semibold text-muted-foreground',
        large ? 'size-12 text-lg' : 'size-9 text-sm',
      )}
    >
      {endpoint ? <Server className={large ? 'size-5' : 'size-4'} /> : name.trim().charAt(0).toUpperCase()}
    </span>
  );
}

/** `off`: not set up. `pending`: on its way, such as a link waiting for its code to be scanned. */
export type Health = 'ok' | 'unknown' | 'off' | 'pending' | 'error';

/** Whether a thing works: a coloured dot and a word. */
export function Status({ health }: { health: Health }) {
  const t = useT();
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-xs',
        health === 'ok'
          ? 'text-emerald-600 dark:text-emerald-400'
          : health === 'error'
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-muted-foreground',
      )}
    >
      <span className="size-1.5 rounded-full bg-current" />
      {t(`settings.status.${health}`)}
    </span>
  );
}

/** A small label for what a thing is used for. */
export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground">
      {children}
    </span>
  );
}

/**
 * A heading over a group of rows, with room for something on its right. It reads like a settings
 * card's title: the title, then what the group is for.
 */
export function Heading({ title, hint, children }: { title: string; hint?: string; children?: ReactNode }) {
  return (
    <div className="mb-2 flex min-h-8 flex-wrap items-center justify-between gap-2 px-1">
      <div className="min-w-0 flex-1 space-y-1">
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </div>
  );
}

export const rowClass =
  'flex w-full items-center gap-3 px-4 py-3 text-start transition-colors first:rounded-t-2xl last:rounded-b-2xl';

/** One thing in a list, opening its page. */
export function ListRow({
  name,
  mark,
  status,
  tags,
  detail,
  onOpen,
}: {
  name: string;
  mark: ReactNode;
  status?: ReactNode;
  tags?: ReactNode;
  /** A few words under the name; parts left empty are skipped. */
  detail: (string | null | undefined | false)[];
  onOpen(): void;
}) {
  return (
    <button type="button" onClick={onOpen} className={cn(rowClass, 'hover:bg-accent/60')}>
      {mark}
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{name}</span>
          {status}
          {tags}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {detail.filter(Boolean).join(' · ')}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
    </button>
  );
}

/** The top of a thing's own page: its mark, name, state and a line about it, with room for an action. */
export function PageHead({
  name,
  mark,
  status,
  tags,
  line,
  children,
}: {
  name: string;
  mark: ReactNode;
  status?: ReactNode;
  tags?: ReactNode;
  line?: string | null;
  children?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-center gap-4">
      {mark}
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="text-lg font-semibold">{name}</span>
          {status}
          {tags}
        </div>
        {line && <div className="truncate text-sm text-muted-foreground">{line}</div>}
      </div>
      {children}
    </div>
  );
}
