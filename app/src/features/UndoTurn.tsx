import type { TurnChangeItem } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useT, type T } from '@/i18n';
import { api } from '@/lib/api';

/** One change, named by what it is and what taking the turn back does to it. */
function Line({ item, t, note }: { item: TurnChangeItem; t: T; note?: string }) {
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 text-sm">
      <span className="min-w-0 break-words">
        {t(`undo.kind.${item.kind}`)}: <span className="font-medium">{item.label}</span>
      </span>
      <span className="text-xs text-muted-foreground">{note ?? t(`undo.will.${item.op}`)}</span>
    </li>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-xs font-medium text-muted-foreground">{title}</h3>
      <ul className="space-y-1">{children}</ul>
    </section>
  );
}

/**
 * What taking a turn back would put back, and, apart, what no one can: the steps that reached
 * outside and the changes too large to keep. Confirming puts things back newest first; whatever
 * changed again since is left as it is, and the conversation says so.
 */
export function UndoTurnDialog({
  turnId,
  threadId,
  open,
  onOpenChange,
}: {
  turnId: string;
  threadId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: ['turn-changes', threadId, turnId],
    queryFn: () => api.turnChanges(turnId),
    enabled: open,
  });
  const undo = useMutation({
    mutationFn: () => api.undoTurn(turnId),
    onSuccess: (res) => {
      const done = res.items.filter((i) => i.outcome === 'restored').length;
      toast.success(t('undo.done', { done, total: res.items.length }));
      onOpenChange(false);
    },
    onError: (e) => toast.error((e as Error).message),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: ['messages', threadId] });
      void qc.invalidateQueries({ queryKey: ['turn-changes', threadId] });
    },
  });
  const items = data?.items ?? [];
  const will = items.filter((i) => !i.reason && !i.needsOwner);
  const owner = items.filter((i) => !i.reason && i.needsOwner);
  const kept = items.filter((i) => i.reason);
  const outside = data?.outside ?? [];
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-hidden rounded-3xl sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('undo.title')}</DialogTitle>
          <DialogDescription>
            {data?.running ? t('undo.running') : data?.undone ? t('undo.already') : t('undo.intro')}
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          {isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
          {will.length > 0 && (
            <Group title={t('undo.willTitle')}>
              {will.map((i) => (
                <Line key={i.id} item={i} t={t} />
              ))}
            </Group>
          )}
          {owner.length > 0 && (
            <Group title={t('undo.ownerTitle')}>
              {owner.map((i) => (
                <Line key={i.id} item={i} t={t} note={t('undo.ownerNote')} />
              ))}
            </Group>
          )}
          {(kept.length > 0 || outside.length > 0) && (
            <Group title={t('undo.cannotTitle')}>
              {kept.map((i) => (
                <Line
                  key={i.id}
                  item={i}
                  t={t}
                  note={t(i.reason === 'deleted' ? 'undo.deleted' : 'undo.tooBig')}
                />
              ))}
              {outside.map((o) => (
                <li key={`${o.at}${o.summary}`} className="text-sm break-words">
                  {o.summary}
                </li>
              ))}
            </Group>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" className="rounded-full" onClick={() => onOpenChange(false)}>
            {t('common.cancel')}
          </Button>
          <Button
            className="rounded-full"
            disabled={isPending || undo.isPending || !data || data.running || data.undone || !items.length}
            onClick={() => undo.mutate()}
          >
            {undo.isPending && <Loader2 className="size-4 animate-spin" />}
            {t('undo.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
