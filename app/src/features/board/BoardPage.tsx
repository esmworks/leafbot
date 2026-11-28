import { TICKET_PRIORITIES, type Ticket, type TicketPriority, type TicketStatus } from '@leafbot/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, ListFilter, Plus, Search, X } from 'lucide-react';
import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useBots } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { NewTicketDialog } from './NewTicketDialog';
import { CLOSED, NOBODY, OPEN, PriorityIcon, StatusIcon, Unassigned } from './parts';
import { snippet, TicketCard } from './TicketCard';
import { TicketPanel } from './TicketPanel';
import { useTicketDrag } from './useTicketDrag';

/** The columns, left to right; tickets nobody will do are kept at the foot of the done column. */
const COLUMNS: TicketStatus[] = ['todo', 'in_progress', 'in_review', 'blocked', 'done'];

/** The order the person gave the tickets; newer first where two share a place. */
const byPosition = (a: Ticket, b: Ticket) => a.position - b.position || b.number - a.number;

/** Whether a move to `to` starts the assigned bot on the ticket, as the server decides it. */
function startsWork(ticket: Ticket, to: TicketStatus): boolean {
  if (!ticket.assigneeBotId || !OPEN.includes(to)) return false;
  return !OPEN.includes(ticket.status) || (to === 'in_progress' && ticket.status !== 'in_progress');
}

/** A move asked for and not yet made; one that starts a bot waits for the person's yes. */
interface Move {
  ticket: Ticket;
  status: TicketStatus;
  /** Left out, the server puts a ticket that changes column at its top. */
  position?: number;
}

/**
 * The board: tickets the person and the bots both work from, in columns by status. Assigning one
 * to a bot starts it on the work; what it reports comes back as a comment, and the ticket moves to
 * review for the person to close or send back with a comment. A ticket's details open beside the
 * columns, so the board stays in view while one is read.
 *
 * It fills the main area beside the sidebar rather than covering the window, since every ticket
 * belongs to a bot: the bots stay in reach, and opening one leaves the board for its chat. Kept
 * mounted once opened, so the filters and the ticket being read are there again on coming back.
 */
export function BoardPage() {
  const t = useT();
  const qc = useQueryClient();
  const open = useUi((s) => s.boardOpen);
  const setOpen = useUi((s) => s.setBoardOpen);
  const { data: tickets = [], isPending } = useQuery({
    queryKey: ['tickets'],
    queryFn: api.tickets,
    enabled: open,
  });
  const { data: bots = [] } = useBots();
  const [openId, setOpenId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<string[]>([]);
  const [priorities, setPriorities] = useState<TicketPriority[]>([]);
  const [showWontDo, setShowWontDo] = useState(false);
  const [asking, setAsking] = useState<Move | null>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLElement>(null);
  const current = tickets.find((k) => k.id === openId) ?? null;

  const commit = ({ ticket, status, position }: Move) => {
    const starts = startsWork(ticket, status);
    const top = Math.min(0, ...tickets.map((k) => k.position)) - 1;
    // Shown at once; the server may move it on (a bot starting puts it at the top of the work).
    qc.setQueryData<Ticket[]>(['tickets'], (old) =>
      old?.map((k) =>
        k.id === ticket.id
          ? {
              ...k,
              status: starts ? 'in_progress' : status,
              position: starts ? top : (position ?? (status === k.status ? k.position : top)),
            }
          : k,
      ),
    );
    const patch = {
      ...(status !== ticket.status && { status }),
      ...(position !== undefined && { position }),
    };
    api.updateTicket(ticket.id, patch).then(
      () => {
        const bot = bots.find((b) => b.id === ticket.assigneeBotId);
        if (starts && bot) toast(t('board.started', { name: bot.name, number: ticket.number }));
        void qc.invalidateQueries({ queryKey: ['tickets'] });
      },
      (e: Error) => {
        toast.error(e.message);
        void qc.invalidateQueries({ queryKey: ['tickets'] });
      },
    );
  };
  /** A move from the board or the details; one that would start the bot asks first. */
  const move = (m: Move) => {
    if (m.status === m.ticket.status && m.position === undefined) return;
    if (startsWork(m.ticket, m.status)) setAsking(m);
    else commit(m);
  };
  /** A card dropped in a column, before the card `beforeId` or, when null, at the end. */
  const drop = (ticket: Ticket, status: TicketStatus, beforeId: string | null) => {
    const all = tickets.filter((k) => k.status === status).sort(byPosition);
    const at = (list: Ticket[], id: string | null) => (id ? list.findIndex((k) => k.id === id) : list.length);
    const rest = all.filter((k) => k.id !== ticket.id);
    const i = at(rest, beforeId);
    const prev = rest[i - 1];
    const next = rest[i];
    if (status === ticket.status) {
      // Dropped where it already stood.
      const j = all.findIndex((k) => k.id === ticket.id);
      if (all[j - 1]?.id === prev?.id && all[j + 1]?.id === next?.id) return;
    }
    const position =
      prev && next
        ? (prev.position + next.position) / 2
        : next
          ? next.position - 1
          : prev
            ? prev.position + 1
            : ticket.position;
    move({ ticket, status, position });
  };
  const { drag, grab, wasMoved } = useTicketDrag(scroller, drop);
  const openTicket = (id: string) => {
    if (!wasMoved()) setOpenId(id);
  };
  const askedBot = bots.find((b) => b.id === asking?.ticket.assigneeBotId);

  const shown = useMemo(() => {
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return tickets
      .filter((k) => {
        if (people.length && !people.includes(k.assigneeBotId ?? NOBODY)) return false;
        if (priorities.length && !priorities.includes(k.priority)) return false;
        if (!words.length) return true;
        const hay = `#${k.number} ${k.title} ${snippet(k.description)}`.toLocaleLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .sort(byPosition);
  }, [tickets, query, people, priorities]);
  const filtering = !!query.trim() || people.length > 0 || priorities.length > 0;
  const clearFilters = () => {
    setQuery('');
    setPeople([]);
    setPriorities([]);
  };

  // Bots with a ticket first, as the ones to filter by; then the rest of the team.
  const assignees = useMemo(() => {
    const used = new Set(tickets.map((k) => k.assigneeBotId));
    return bots.filter((b) => used.has(b.id) || (!b.archivedAt && people.includes(b.id)));
  }, [bots, tickets, people]);
  const hasUnassigned = tickets.some((k) => !k.assigneeBotId);
  const togglePerson = (id: string) =>
    setPeople((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));

  const openCount = tickets.filter((k) => !CLOSED.includes(k.status)).length;
  const reviewCount = tickets.filter((k) => k.status === 'in_review').length;

  const close = () => {
    setOpen(false);
    setOpenId(null);
    setAdding(false);
  };

  /** Escape steps back one level: out of a ticket, then off the board. */
  const stepBack = () => {
    if (openId) setOpenId(null);
    else close();
  };
  // The keys below answer only while focus is on the board, so it takes the focus when it opens.
  useEffect(() => {
    if (open) root.current?.focus({ preventScroll: true });
  }, [open]);
  // A click on a bare part of the window leaves the focus nowhere; Escape still steps back then,
  // as it did when the board was a dialog that kept the focus.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      e.preventDefault();
      if (openId) return setOpenId(null);
      setOpen(false);
      setAdding(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, openId, setOpen]);

  return (
    <section
      ref={root}
      tabIndex={-1}
      aria-labelledby="board-title"
      aria-describedby="board-description"
      onKeyDown={(e) => {
        const el = e.target as HTMLElement;
        // Keys from a menu or dialog opened over the board bubble here through React too.
        if (e.defaultPrevented || !e.currentTarget.contains(el)) return;
        if (e.key === 'Escape') {
          // Escape steps back one level: out of an edit, then out of a ticket, then off the board.
          if (el.closest('[data-own-escape]')) return;
          e.preventDefault();
          stepBack();
          return;
        }
        if (
          e.metaKey ||
          e.ctrlKey ||
          e.altKey ||
          el.closest('input, textarea, [role="combobox"], [role="menu"]')
        )
          return;
        if (e.key === 'c' || e.key === 'n') {
          e.preventDefault();
          setAdding(true);
        } else if (e.key === '/') {
          e.preventDefault();
          search.current?.focus();
        }
      }}
      className={cn('flex min-h-0 min-w-0 flex-1 flex-col outline-none', !open && 'hidden')}
    >
      <p id="board-description" className="sr-only">
        {t('board.description')}
      </p>
      <header className="window-drag flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-5 py-3.5 phone:px-4">
        <div className="flex min-w-0 items-baseline gap-2.5 phone:flex-1">
          <h1 id="board-title" className="text-lg font-semibold">
            {t('board.title')}
          </h1>
          {tickets.length > 0 && (
            <span className="truncate text-sm text-muted-foreground tabular-nums">
              {t('board.openCount', { count: openCount })}
              {reviewCount > 0 && ` · ${t('board.reviewCount', { count: reviewCount })}`}
            </span>
          )}
        </div>
        {(assignees.length > 0 || hasUnassigned) && (
          <div
            className="flex items-center gap-1 phone:order-last phone:w-full phone:overflow-x-auto"
            role="group"
            aria-label={t('board.filterAssignee')}
          >
            {assignees.map((b) => (
              <FaceButton
                key={b.id}
                label={b.name}
                active={people.includes(b.id)}
                dimmed={people.length > 0 && !people.includes(b.id)}
                onClick={() => togglePerson(b.id)}
              >
                <BotAvatar avatar={b.avatar} material={b.material} color={b.color} seed={b.id} size={26} />
              </FaceButton>
            ))}
            {hasUnassigned && (
              <FaceButton
                label={t('board.nobody')}
                active={people.includes(NOBODY)}
                dimmed={people.length > 0 && !people.includes(NOBODY)}
                onClick={() => togglePerson(NOBODY)}
              >
                <Unassigned size={26} />
              </FaceButton>
            )}
          </div>
        )}
        <span className="flex-1 phone:hidden" />
        {filtering && (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-xl text-muted-foreground phone:order-5"
            onClick={clearFilters}
          >
            <X /> {t('board.clearFilters')}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className={cn('rounded-xl phone:order-4', priorities.length && 'bg-accent text-foreground')}
              aria-label={t('board.filterPriority')}
              title={t('board.filterPriority')}
            >
              <ListFilter />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t('board.priority')}
            </DropdownMenuLabel>
            {[...TICKET_PRIORITIES].reverse().map((p) => (
              <DropdownMenuCheckboxItem
                key={p}
                checked={priorities.includes(p)}
                onSelect={(e) => e.preventDefault()}
                onCheckedChange={(on) =>
                  setPriorities((all) => (on ? [...all, p] : all.filter((x) => x !== p)))
                }
              >
                <PriorityIcon priority={p} />
                {t(`board.priority.${p}`)}
              </DropdownMenuCheckboxItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <label className="relative flex items-center phone:order-3 phone:min-w-0 phone:flex-1 phone:basis-48">
          <Search className="pointer-events-none absolute start-2.5 size-4 text-muted-foreground" />
          <input
            ref={search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && query) {
                e.stopPropagation();
                setQuery('');
              }
            }}
            data-own-escape={query ? '' : undefined}
            placeholder={t('board.search')}
            aria-label={t('board.search')}
            className="h-8 w-56 rounded-xl border bg-transparent pe-3 ps-8 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 phone:w-full"
          />
        </label>
        <Button size="sm" className="rounded-xl phone:order-1" onClick={() => setAdding(true)}>
          <Plus /> {t('board.new')}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-xl phone:order-2"
          aria-label={t('common.close')}
          onClick={close}
        >
          <X />
        </Button>
      </header>

      <div className="relative min-h-0 flex-1">
        {!isPending && !tickets.length ? (
          <EmptyBoard onAdd={() => setAdding(true)} />
        ) : (
          <div
            ref={scroller}
            className="scroll-thin flex h-full gap-2.5 overflow-x-auto p-4 phone:flex-col phone:overflow-x-hidden phone:overflow-y-auto phone:p-3"
          >
            {COLUMNS.map((status) => (
              <Column
                key={status}
                status={status}
                tickets={shown.filter((k) => k.status === status)}
                wontDo={status === 'done' ? shown.filter((k) => k.status === 'wont_do') : undefined}
                showWontDo={showWontDo}
                onToggleWontDo={() => setShowWontDo((v) => !v)}
                dragging={drag}
                selectedId={openId}
                filtering={filtering}
                onOpen={openTicket}
                onGrab={grab}
                onAdd={status === 'todo' ? () => setAdding(true) : undefined}
              />
            ))}
          </div>
        )}
        {current && (
          <TicketPanel
            key={current.id}
            ticket={current}
            onStatus={(status) => move({ ticket: current, status })}
            onClose={() => setOpenId(null)}
          />
        )}
      </div>

      <NewTicketDialog
        open={adding}
        onOpenChange={setAdding}
        assignee={people.length === 1 && people[0] !== NOBODY ? people[0]! : null}
        onCreated={(id) => setOpenId(id)}
      />
      <Dialog open={!!asking} onOpenChange={(o) => !o && setAsking(null)}>
        <DialogContent className="rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('board.startTitle', { name: askedBot?.name ?? '' })}</DialogTitle>
            <DialogDescription>
              {asking &&
                t('board.startBody', {
                  number: asking.ticket.number,
                  name: askedBot?.name ?? '',
                })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" className="rounded-xl" onClick={() => setAsking(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              autoFocus
              className="rounded-xl"
              onClick={() => {
                if (asking) commit(asking);
                setAsking(null);
              }}
            >
              {t('board.startConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      {drag &&
        createPortal(
          <div
            className="pointer-events-none fixed top-0 start-0 z-[100]"
            style={{
              width: drag.width,
              transform: `translate(${drag.x - drag.dx}px, ${drag.y - drag.dy}px)`,
            }}
          >
            <TicketCard ticket={drag.ticket} lifted />
          </div>,
          document.body,
        )}
    </section>
  );
}

function FaceButton({
  label,
  active,
  dimmed,
  onClick,
  children,
}: {
  label: string;
  active: boolean;
  dimmed: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={cn(
        'rounded-full p-0.5 ring-2 ring-transparent transition-[opacity,box-shadow] outline-none hover:opacity-100 focus-visible:ring-ring/60',
        active && 'ring-foreground/70',
        dimmed && 'opacity-40',
      )}
    >
      {children}
    </button>
  );
}

function Column({
  status,
  tickets,
  wontDo,
  showWontDo,
  onToggleWontDo,
  dragging,
  selectedId,
  filtering,
  onOpen,
  onGrab,
  onAdd,
}: {
  status: TicketStatus;
  tickets: Ticket[];
  /** Tickets nobody will do, kept folded at the foot of the done column. */
  wontDo?: Ticket[];
  showWontDo: boolean;
  onToggleWontDo(): void;
  dragging: ReturnType<typeof useTicketDrag>['drag'];
  selectedId: string | null;
  filtering: boolean;
  onOpen(id: string): void;
  onGrab(e: React.PointerEvent, ticket: Ticket): void;
  onAdd?: () => void;
}) {
  const t = useT();
  const over = dragging?.over === status && dragging.ticket.status !== status;
  const card = (k: Ticket) => (
    <TicketCard
      key={k.id}
      ticket={k}
      selected={k.id === selectedId}
      ghost={dragging?.ticket.id === k.id}
      onOpen={onOpen}
      onGrab={onGrab}
    />
  );
  const overWontDo = dragging?.over === 'wont_do' && dragging.ticket.status !== 'wont_do';
  /** The cards of one list, with a line where a carried card would land. */
  const list = (items: Ticket[], at: TicketStatus) => {
    const here = dragging?.over === at ? dragging : null;
    // Before which card the line goes (null: after the last); none where the card already stands.
    let mark: string | null | undefined;
    if (here) {
      const i = items.findIndex((k) => k.id === here.ticket.id);
      mark = i >= 0 && here.beforeId === (items[i + 1]?.id ?? null) ? undefined : here.beforeId;
    }
    return (
      <>
        {items.map((k) => (
          <Fragment key={k.id}>
            {mark === k.id && <DropLine />}
            {card(k)}
          </Fragment>
        ))}
        {mark === null && items.length > 0 && <DropLine />}
      </>
    );
  };
  return (
    <section
      data-board-status={status}
      aria-label={t(`board.status.${status}`)}
      className={cn(
        'flex min-h-0 min-w-[176px] flex-1 basis-0 flex-col rounded-2xl bg-secondary/60 transition-[background-color,box-shadow] dark:bg-secondary/40 phone:min-h-fit phone:flex-none',
        over && 'bg-blue-500/10 ring-2 ring-blue-500/50 ring-inset',
      )}
    >
      <h3 className="flex h-11 shrink-0 items-center gap-2 pe-1.5 ps-3 text-sm font-medium">
        <StatusIcon status={status} />
        <span className="truncate">{t(`board.status.${status}`)}</span>
        <span className="text-xs font-normal text-muted-foreground tabular-nums">{tickets.length}</span>
        <span className="flex-1" />
        {onAdd && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-lg text-muted-foreground"
            onClick={onAdd}
            aria-label={t('board.new')}
            title={t('board.new')}
          >
            <Plus />
          </Button>
        )}
      </h3>
      <div className="scroll-thin flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-2 pb-2 phone:overflow-visible">
        {list(tickets, status)}
        {!tickets.length && (
          <div
            className={cn(
              'flex h-20 shrink-0 items-center justify-center rounded-xl border border-dashed px-3 text-center text-xs text-muted-foreground transition-colors',
              over && 'border-blue-500/50 text-blue-600 dark:text-blue-400',
            )}
          >
            {over
              ? t('board.dropHere')
              : filtering
                ? t('board.columnNoMatch')
                : t(`board.columnEmpty.${status}`)}
          </div>
        )}
        {wontDo && (wontDo.length > 0 || dragging) && (
          <div
            data-board-status="wont_do"
            className={cn(
              'mt-1 rounded-xl transition-colors',
              dragging && 'border border-dashed p-1.5',
              overWontDo && 'border-blue-500/50 bg-blue-500/10',
            )}
          >
            <button
              type="button"
              onClick={onToggleWontDo}
              aria-expanded={showWontDo}
              className="flex w-full items-center gap-1.5 rounded-lg px-1.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <ChevronRight className={cn('size-3.5 transition-transform', showWontDo && 'rotate-90')} />
              <StatusIcon status="wont_do" className="size-3.5" />
              <span className="truncate">{t('board.status.wont_do')}</span>
              <span className="tabular-nums">{wontDo.length}</span>
            </button>
            {showWontDo && wontDo.length > 0 && (
              <div className="mt-1.5 flex flex-col gap-2">{list(wontDo, 'wont_do')}</div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/** Where a carried card will land; it takes no room, so the cards do not shift under the pointer. */
function DropLine() {
  return <div className="-my-[5px] h-0.5 shrink-0 rounded-full bg-blue-500" aria-hidden />;
}

function EmptyBoard({ onAdd }: { onAdd(): void }) {
  const t = useT();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex items-center gap-1.5 opacity-80" aria-hidden>
        {COLUMNS.map((s) => (
          <StatusIcon key={s} status={s} className="size-5" />
        ))}
      </div>
      <div className="max-w-sm space-y-1.5">
        <p className="font-medium">{t('board.emptyTitle')}</p>
        <p className="text-sm text-muted-foreground">{t('board.empty')}</p>
      </div>
      <Button className="rounded-xl" onClick={onAdd}>
        <Plus /> {t('board.new')}
      </Button>
    </div>
  );
}
