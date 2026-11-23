import type { TicketPriority } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useBots } from '@/lib/queries';
import { AssigneeSelect, PrioritySelect } from './parts';

/** Writing a new ticket, over the board; `assignee` is who it goes to unless changed. */
export function NewTicketDialog({
  open,
  onOpenChange,
  assignee,
  onCreated,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  assignee: string | null;
  onCreated(id: string): void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-xl">
        {/* Mounted with each opening, so it starts empty and goes to the bot the board is filtered to. */}
        <NewTicketForm preset={assignee} onClose={() => onOpenChange(false)} onCreated={onCreated} />
      </DialogContent>
    </Dialog>
  );
}

function NewTicketForm({
  preset,
  onClose,
  onCreated,
}: {
  preset: string | null;
  onClose(): void;
  onCreated(id: string): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: bots = [] } = useBots();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TicketPriority>('normal');
  const [assignee, setAssignee] = useState<string | null>(preset);
  const save = useMutation({
    mutationFn: () => api.createTicket({ title, description, priority, assigneeBotId: assignee }),
    onSuccess: (ticket) => {
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      onClose();
      onCreated(ticket.id);
    },
    onError: (e: Error) => toast.error(e.message),
  });
  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (title.trim() && !save.isPending) save.mutate();
  };
  const bot = bots.find((b) => b.id === assignee);
  return (
    <form
      onSubmit={submit}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(e);
      }}
    >
      <div className="space-y-1 px-5 pt-5">
        <DialogTitle className="text-sm font-medium text-muted-foreground">{t('board.new')}</DialogTitle>
        <DialogDescription className="sr-only">{t('board.newDescription')}</DialogDescription>
        <input
          autoFocus
          value={title}
          maxLength={200}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={t('board.titlePlaceholder')}
          aria-label={t('board.titleLabel')}
          className="w-full bg-transparent py-1 text-lg font-semibold outline-none placeholder:text-muted-foreground/70"
        />
        <textarea
          dir="auto"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t('board.descriptionPlaceholder')}
          aria-label={t('board.descriptionLabel')}
          rows={5}
          className="scroll-thin w-full resize-none bg-transparent py-1 text-sm leading-relaxed outline-none placeholder:text-muted-foreground/70"
        />
      </div>
      <div className="flex flex-wrap items-center gap-2 px-5 pb-4">
        <AssigneeSelect value={assignee} onChange={setAssignee} />
        <PrioritySelect value={priority} onChange={setPriority} />
      </div>
      <div className="flex items-center gap-2 border-t bg-secondary/40 px-5 py-3">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          {bot ? t('board.startsHint', { name: bot.name }) : t('board.unassignedHint')}
        </p>
        <Button type="button" variant="ghost" className="rounded-xl" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-xl" disabled={save.isPending || !title.trim()}>
          {t('board.create')}
        </Button>
      </div>
    </form>
  );
}
