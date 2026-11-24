import type { TurnLogEntry } from '@leafbot/shared';
import { useQuery } from '@tanstack/react-query';
import { Loader2, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT, type T } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { UndoTurnDialog } from './UndoTurn';

/** A list of lines under a small heading, in the colour of what can still be done about them. */
function Lines({ title, tone, lines }: { title: string; tone: 'can' | 'done' | 'cannot'; lines: string[] }) {
  if (!lines.length) return null;
  return (
    <div className="space-y-1">
      <div
        className={
          tone === 'cannot'
            ? 'text-xs font-medium text-amber-600 dark:text-amber-400'
            : 'text-xs font-medium text-muted-foreground'
        }
      >
        {title}
      </div>
      <ul className="space-y-0.5">
        {lines.map((l, i) => (
          <li
            key={i}
            className={
              tone === 'done'
                ? 'text-sm break-words text-muted-foreground line-through'
                : 'text-sm break-words'
            }
          >
            {l}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** One turn: what was asked, what it changed, and what of that can still be taken back. */
function Entry({ e, t, onUndo }: { e: TurnLogEntry; t: T; onUndo(): void }) {
  const f = useFormat();
  const name = (i: TurnLogEntry['items'][number]) => `${t(`undo.kind.${i.kind}`)}: ${i.label}`;
  const can = e.items.filter((i) => !i.reason && !i.outcome).map(name);
  const done = e.items.flatMap((i) =>
    i.outcome ? [`${name(i)} (${t(`actionLog.outcome.${i.outcome}`)})`] : [],
  );
  const cannot = [
    ...e.items.filter((i) => i.reason && !i.outcome).map(name),
    ...e.outside.map((o) => o.summary),
  ];
  return (
    <li className="space-y-2 rounded-2xl bg-secondary/60 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs text-muted-foreground">{f.dayLabel(e.at)}</div>
          <div className="line-clamp-2 text-sm font-medium break-words">{e.request}</div>
        </div>
        {can.length > 0 && !e.running && (
          <Button
            size="sm"
            variant="secondary"
            className="h-7 shrink-0 rounded-full px-3 text-xs"
            onClick={onUndo}
          >
            <Undo2 className="size-3.5" /> {t('actionLog.undo')}
          </Button>
        )}
      </div>
      <Lines title={t('actionLog.can')} tone="can" lines={can} />
      <Lines title={t('actionLog.done')} tone="done" lines={done} />
      <Lines title={t('actionLog.cannot')} tone="cannot" lines={cannot} />
    </li>
  );
}

/**
 * The action log of a conversation: the person's turns that changed or sent something, newest
 * first, each saying what can still be taken back, what was, and what no one can take back (a mail
 * that went, a call to another service). Taking a turn back opens the usual dialog.
 */
export function ActionLogDialog({
  threadId,
  open,
  onOpenChange,
}: {
  threadId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const t = useT();
  const [undoing, setUndoing] = useState<string | null>(null);
  const { data = [], isPending } = useQuery({
    queryKey: ['turn-changes', threadId, 'log'],
    queryFn: () => api.actionLog(threadId),
    enabled: open,
  });
  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-hidden rounded-3xl sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t('actionLog.title')}</DialogTitle>
            <DialogDescription>{t('actionLog.intro')}</DialogDescription>
          </DialogHeader>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
            {!isPending && !data.length && (
              <p className="text-sm text-muted-foreground">{t('actionLog.empty')}</p>
            )}
            <ul className="space-y-3">
              {data.map((e) => (
                <Entry key={e.turnId} e={e} t={t} onUndo={() => setUndoing(e.turnId)} />
              ))}
            </ul>
          </div>
        </DialogContent>
      </Dialog>
      {undoing && (
        <UndoTurnDialog
          turnId={undoing}
          threadId={threadId}
          open
          onOpenChange={(o) => !o && setUndoing(null)}
        />
      )}
    </>
  );
}
