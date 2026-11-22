import type { Ticket, TicketStatus } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowUp, ExternalLink, MoreHorizontal, Pencil, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Markdown } from '@/components/Markdown';
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
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useBots } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import {
  AssigneeSelect,
  AuthorAvatar,
  CLOSED,
  PrioritySelect,
  StatusIcon,
  StatusSelect,
  useAuthor,
} from './parts';

/** A text box that grows with what is typed in it, up to the space the panel gives it. */
function useAutosize(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);
  return ref;
}

/**
 * A ticket's details beside the board: its title and description, edited in place, its
 * properties, and what the person and its bot wrote on it, newest last as in a conversation.
 */
export function TicketPanel({
  ticket,
  onStatus,
  onClose,
}: {
  ticket: Ticket;
  /** A new status, made by the board, which asks first when it would start the bot. */
  onStatus(status: TicketStatus): void;
  onClose(): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { dayLabel } = useFormat();
  const { data: bots = [] } = useBots();
  const author = useAuthor();
  const [confirming, setConfirming] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['tickets'] });
  const fail = (e: Error) => toast.error(e.message);
  const update = useMutation({
    mutationFn: (patch: Parameters<typeof api.updateTicket>[1]) => api.updateTicket(ticket.id, patch),
    onMutate: (patch) => {
      // The change shows at once; the server's answer replaces it.
      qc.setQueryData<Ticket[]>(['tickets'], (old) =>
        old?.map((k) => (k.id === ticket.id ? { ...k, ...patch } : k)),
      );
    },
    onSettled: () => void refresh(),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => api.removeTicket(ticket.id),
    onSuccess: () => {
      onClose();
      void refresh();
    },
    onError: fail,
  });
  const assignee = bots.find((b) => b.id === ticket.assigneeBotId);
  const opener = author(ticket.createdBy);
  const end = useRef<HTMLDivElement>(null);
  const count = ticket.comments.length;
  const seen = useRef(count);
  // A comment that arrives while the ticket is open (a bot's report, the person's own) comes into
  // view; opening a ticket starts at its title.
  useEffect(() => {
    if (count > seen.current) end.current?.scrollIntoView({ block: 'end', behavior: 'smooth' });
    seen.current = count;
  }, [count]);

  return (
    <aside
      aria-label={`#${ticket.number}`}
      className="absolute inset-y-0 end-0 z-20 flex w-[min(560px,100%)] flex-col border-l bg-background shadow-[-24px_0_48px_-24px_rgb(0_0_0/0.18)] duration-200 animate-in fade-in-0 slide-in-from-end-6"
    >
      <div className="flex h-14 shrink-0 items-center gap-1.5 border-b px-4">
        <StatusIcon status={ticket.status} />
        <span className="text-sm text-muted-foreground tabular-nums">#{ticket.number}</span>
        <span className="flex-1" />
        {assignee && ticket.threadId && (
          <Button
            variant="ghost"
            size="sm"
            className="rounded-xl text-muted-foreground"
            onClick={() => {
              const ui = useUi.getState();
              ui.openChat(assignee.id);
              ui.selectThread(ticket.threadId);
              ui.setBoardOpen(false);
            }}
          >
            <ExternalLink /> {t('board.openWork')}
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" className="rounded-xl" aria-label={t('board.more')}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem variant="destructive" onSelect={() => setConfirming(true)}>
              <Trash2 /> {t('board.delete')}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          size="icon-sm"
          className="rounded-xl"
          onClick={onClose}
          aria-label={t('board.closeTicket')}
        >
          <X />
        </Button>
      </div>

      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
        <div className="space-y-6 px-6 pt-5 pb-6 phone:px-4">
          <TitleField value={ticket.title} onSave={(title) => update.mutate({ title })} />

          <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-0.5 text-sm">
            <dt className="text-muted-foreground">{t('board.statusLabel')}</dt>
            <dd>
              <StatusSelect quiet value={ticket.status} onChange={onStatus} />
            </dd>
            <dt className="text-muted-foreground">{t('board.assignee')}</dt>
            <dd>
              <AssigneeSelect
                quiet
                value={ticket.assigneeBotId}
                onChange={(id) => update.mutate({ assigneeBotId: id })}
              />
            </dd>
            <dt className="text-muted-foreground">{t('board.priority')}</dt>
            <dd>
              <PrioritySelect
                quiet
                value={ticket.priority}
                onChange={(p) => update.mutate({ priority: p })}
              />
            </dd>
            <dt className="text-muted-foreground">{t('board.openedByLabel')}</dt>
            <dd className="flex h-8 min-w-0 items-center gap-2 px-2">
              <AuthorAvatar bot={opener.bot} size={18} />
              <span className="truncate">{opener.name}</span>
            </dd>
            <dt className="text-muted-foreground">{t('board.updated')}</dt>
            <dd className="flex h-8 items-center px-2 text-muted-foreground tabular-nums">
              {dayLabel(ticket.updatedAt)}
            </dd>
          </dl>
          {ticket.assigneeBotId && !CLOSED.includes(ticket.status) && ticket.status !== 'in_progress' && (
            <p className="-mt-3 text-xs text-muted-foreground">{t('board.startHint')}</p>
          )}

          <DescriptionField
            value={ticket.description}
            onSave={(description) => update.mutate({ description })}
          />

          <section className="space-y-4">
            <h3 className="text-xs font-medium text-muted-foreground">{t('board.activity')}</h3>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <AuthorAvatar bot={opener.bot} size={20} />
              <span>
                {t('board.openedEvent', { who: opener.name })} · {dayLabel(ticket.createdAt)}
              </span>
            </div>
            {ticket.comments.map((c) => {
              const who = author(c.author);
              return (
                <article key={c.id} className="flex gap-3">
                  <AuthorAvatar bot={who.bot} size={28} />
                  <div
                    className={cn(
                      'min-w-0 flex-1 rounded-2xl px-3.5 py-2.5',
                      who.bot ? 'border bg-card' : 'bg-secondary',
                    )}
                  >
                    <div className="mb-1 flex items-baseline gap-2 text-xs">
                      <span className="font-medium">{who.name}</span>
                      <span className="text-muted-foreground">{dayLabel(c.createdAt)}</span>
                    </div>
                    <Markdown
                      text={c.text}
                      breaks={!who.bot}
                      className="prose-chat text-sm leading-relaxed break-words"
                    />
                  </div>
                </article>
              );
            })}
            <div ref={end} />
          </section>
        </div>
      </div>

      <CommentBox ticket={ticket} />

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent className="rounded-2xl sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('board.deleteConfirm', { number: ticket.number })}</DialogTitle>
            <DialogDescription>{t('board.deleteBody')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" className="rounded-xl" onClick={() => setConfirming(false)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="destructive"
              className="rounded-xl"
              disabled={remove.isPending}
              onClick={() => {
                setConfirming(false);
                remove.mutate();
              }}
            >
              {t('common.delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </aside>
  );
}

function TitleField({ value, onSave }: { value: string; onSave(v: string): void }) {
  const t = useT();
  // Null while not being edited, so a change from elsewhere (a bot, another window) shows.
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const ref = useAutosize(shown);
  const commit = () => {
    const next = draft?.trim();
    setDraft(null);
    if (next && next !== value) onSave(next);
  };
  return (
    <textarea
      ref={ref}
      rows={1}
      value={shown}
      maxLength={200}
      aria-label={t('board.titleLabel')}
      data-own-escape={draft !== null ? '' : undefined}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value.replace(/\n/g, ' '))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === 'Escape') {
          // Put back as it was, then leave the box without saving.
          setDraft(value);
          requestAnimationFrame(() => ref.current?.blur());
        }
      }}
      className="-mx-2 block w-[calc(100%+1rem)] resize-none overflow-hidden rounded-lg bg-transparent px-2 py-1 text-xl leading-snug font-semibold outline-none [overflow-wrap:anywhere] hover:bg-accent/60 focus:bg-transparent focus:ring-[3px] focus:ring-ring/40"
    />
  );
}

function DescriptionField({ value, onSave }: { value: string; onSave(v: string): void }) {
  const t = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const ref = useAutosize(editing ? draft : '');
  const start = () => {
    setDraft(value);
    setEditing(true);
    requestAnimationFrame(() => {
      const el = ref.current;
      el?.focus();
      el?.setSelectionRange(el.value.length, el.value.length);
    });
  };
  const save = () => {
    setEditing(false);
    if (draft !== value) onSave(draft.trim());
  };
  return (
    <section className="group/desc space-y-1.5">
      <div className="flex h-6 items-center gap-2">
        <h3 className="text-xs font-medium text-muted-foreground">{t('board.descriptionLabel')}</h3>
        {value && !editing && (
          <Button
            variant="ghost"
            size="icon-xs"
            className="rounded-lg text-muted-foreground opacity-0 group-hover/desc:opacity-100 focus-visible:opacity-100"
            onClick={start}
            aria-label={t('board.editDescription')}
            title={t('board.editDescription')}
          >
            <Pencil />
          </Button>
        )}
      </div>
      {editing ? (
        <div className="space-y-2" data-own-escape="">
          <Textarea
            ref={ref}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                save();
              } else if (e.key === 'Escape') setEditing(false);
            }}
            placeholder={t('board.descriptionPlaceholder')}
            className="min-h-28 resize-none rounded-xl text-sm"
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" className="rounded-xl" onClick={() => setEditing(false)}>
              {t('common.cancel')}
            </Button>
            <Button size="sm" className="rounded-xl" onClick={save}>
              {t('common.save')}
            </Button>
          </div>
        </div>
      ) : value ? (
        <Markdown text={value} breaks className="prose-chat text-sm leading-relaxed break-words" />
      ) : (
        <button
          type="button"
          onClick={start}
          className="-mx-2 w-[calc(100%+1rem)] rounded-lg px-2 py-1.5 text-start text-sm text-muted-foreground transition-colors hover:bg-accent/60"
        >
          {t('board.addDescription')}
        </button>
      )}
    </section>
  );
}

function CommentBox({ ticket }: { ticket: Ticket }) {
  const t = useT();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const ref = useAutosize(text);
  const send = useMutation({
    mutationFn: () => api.commentTicket(ticket.id, text),
    onSuccess: (saved) => {
      setText('');
      qc.setQueryData<Ticket[]>(['tickets'], (old) => old?.map((k) => (k.id === saved.id ? saved : k)));
      void qc.invalidateQueries({ queryKey: ['tickets'] });
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const sendsBot = !!ticket.assigneeBotId && !CLOSED.includes(ticket.status);
  const submit = () => {
    if (text.trim() && !send.isPending) send.mutate();
  };
  return (
    <form
      className="shrink-0 border-t bg-background p-3"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <div className="flex items-end gap-2 rounded-2xl border bg-card px-3 py-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
        <textarea
          ref={ref}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder={t(sendsBot ? 'board.commentToBot' : 'board.commentPlaceholder')}
          aria-label={t('board.commentPlaceholder')}
          className="scroll-thin max-h-40 min-h-7 flex-1 resize-none bg-transparent py-1 text-sm outline-none placeholder:text-muted-foreground"
        />
        <Button
          type="submit"
          size="icon-sm"
          className="shrink-0 rounded-full"
          disabled={send.isPending || !text.trim()}
          aria-label={t('board.send')}
          title={t('board.send')}
        >
          <ArrowUp />
        </Button>
      </div>
    </form>
  );
}
