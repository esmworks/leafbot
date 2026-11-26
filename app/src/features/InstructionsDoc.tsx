import { textDiff, type Bot } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CircleAlert, FileText, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';

function useDocActions(bot: Bot, onDone?: () => void) {
  const qc = useQueryClient();
  const saved = (b: Bot) => {
    qc.setQueryData<Bot[]>(['bots'], (old = []) => old.map((x) => (x.id === b.id ? b : x)));
    void qc.invalidateQueries({ queryKey: ['bots'] });
    onDone?.();
  };
  const onError = (e: Error) => toast.error(e.message);
  return {
    check: useMutation({ mutationFn: () => api.checkInstructionsDoc(bot.id), onSuccess: saved, onError }),
    accept: useMutation({
      mutationFn: (expected: string) => api.acceptInstructionsDoc(bot.id, expected),
      onSuccess: saved,
      onError,
    }),
    decline: useMutation({ mutationFn: () => api.declineInstructionsDoc(bot.id), onSuccess: saved, onError }),
  };
}

/**
 * The document's new text against the instructions the bot uses now. Nothing reaches the bot
 * until the person accepts; the text accepted is the one on the screen.
 */
export function InstructionsReview({
  bot,
  open,
  onOpenChange,
}: {
  bot: Bot;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { accept, decline } = useDocActions(bot, () => onOpenChange(false));
  const pending = bot.instructionsPending;
  const busy = accept.isPending || decline.isPending;
  return (
    <Dialog open={open && pending != null} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden rounded-3xl sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('instructionsDoc.reviewTitle', { name: bot.name })}</DialogTitle>
          <DialogDescription>{t('instructionsDoc.reviewHint')}</DialogDescription>
        </DialogHeader>
        {pending != null && (
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto rounded-xl bg-muted/40 px-2.5 py-2 text-sm break-words whitespace-pre-wrap">
            {textDiff(bot.instructions, pending).map((p, i) =>
              p.type === 'same' ? (
                <span key={i}>{p.text}</span>
              ) : p.type === 'removed' ? (
                <del key={i} className="bg-red-500/15 text-red-700 dark:text-red-300">
                  {p.text}
                </del>
              ) : (
                <ins
                  key={i}
                  className="bg-emerald-500/15 text-emerald-700 no-underline dark:text-emerald-300"
                >
                  {p.text}
                </ins>
              ),
            )}
          </div>
        )}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" className="rounded-full" disabled={busy} onClick={() => decline.mutate()}>
            {t('instructionsDoc.decline')}
          </Button>
          <Button
            className="rounded-full"
            disabled={busy || pending == null}
            onClick={() => accept.mutate(pending!)}
          >
            {t('instructionsDoc.accept')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Under the instructions of a linked bot: where they come from, when last read, and what waits. */
export function InstructionsDocStatus({ bot }: { bot: Bot }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const { check } = useDocActions(bot);
  const [reviewing, setReviewing] = useState(false);
  if (!bot.instructionsUrl) return null;
  return (
    <div className="space-y-2 rounded-2xl bg-secondary/60 px-4 py-3 text-xs">
      <div className="flex items-start gap-2">
        <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        <div className="min-w-0 flex-1 space-y-1">
          <p>{t('instructionsDoc.linked')}</p>
          <a
            href={bot.instructionsUrl}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-muted-foreground underline"
          >
            {bot.instructionsUrl}
          </a>
          <p className="text-muted-foreground">
            {bot.instructionsCheckedAt
              ? t('instructionsDoc.checkedAt', { when: dayLabel(bot.instructionsCheckedAt) })
              : t('instructionsDoc.notChecked')}
          </p>
          {bot.instructionsError && (
            <p className="flex items-center gap-1 text-destructive">
              <CircleAlert className="size-3.5 shrink-0" aria-hidden /> {bot.instructionsError}
            </p>
          )}
        </div>
      </div>
      <div className="flex flex-wrap gap-2">
        {bot.instructionsPending != null && (
          <Button type="button" size="sm" className="rounded-full" onClick={() => setReviewing(true)}>
            {t('instructionsDoc.review')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="rounded-full"
          disabled={check.isPending}
          onClick={() => check.mutate()}
        >
          <RefreshCw className={cn(check.isPending && 'animate-spin')} /> {t('instructionsDoc.checkNow')}
        </Button>
      </div>
      <InstructionsReview bot={bot} open={reviewing} onOpenChange={setReviewing} />
    </div>
  );
}

/** In the bot's panel, only while the document has a change that waits, or could not be read. */
export function InstructionsDocNotice({ bot }: { bot: Bot }) {
  const t = useT();
  const [reviewing, setReviewing] = useState(false);
  if (!bot.instructionsUrl || (bot.instructionsPending == null && !bot.instructionsError)) return null;
  return (
    <section className="space-y-2 rounded-2xl bg-secondary/60 px-4 py-3">
      <p className="flex items-start gap-2 text-sm">
        {bot.instructionsPending != null ? (
          <FileText className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
        ) : (
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden />
        )}
        <span>
          {bot.instructionsPending != null
            ? t('instructionsDoc.changed')
            : t('instructionsDoc.unreadable', { why: bot.instructionsError ?? '' })}
        </span>
      </p>
      {bot.instructionsPending != null && (
        <Button size="sm" className="rounded-full" onClick={() => setReviewing(true)}>
          {t('instructionsDoc.review')}
        </Button>
      )}
      <InstructionsReview bot={bot} open={reviewing} onOpenChange={setReviewing} />
    </section>
  );
}
