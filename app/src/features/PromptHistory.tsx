import { textDiff, type RoutineRevision } from '@leafbot/shared';
import { useQuery } from '@tanstack/react-query';
import { History, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';

/**
 * The instructions a routine has had. Choosing one shows how the text in the form differs from it,
 * and bringing it back puts it in the form; saving then writes it as the newest.
 */
export function PromptHistory({
  routineId,
  current,
  onRestore,
}: {
  routineId: string;
  /** The instruction as the form holds it now, saved or not. */
  current: string;
  onRestore(prompt: string): void;
}) {
  const t = useT();
  const f = useFormat();
  const [open, setOpen] = useState(false);
  const [chosen, setChosen] = useState<string | null>(null);
  const { data: revisions = [] } = useQuery({
    queryKey: ['routine-revisions', routineId],
    queryFn: () => api.routineRevisions(routineId),
    enabled: open,
  });
  const picked = revisions.find((r) => r.id === chosen) ?? null;
  // Only one version so far: nothing to go back to.
  const older = revisions.length > 1;

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 rounded-full px-2 text-xs text-muted-foreground"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <History className="size-3.5" /> {t('routine.history')}
      </Button>
      {open && (
        <div className="space-y-2 rounded-2xl border p-2">
          {!older && revisions.length > 0 && (
            <p className="px-1 text-sm text-muted-foreground">{t('routine.historyNone')}</p>
          )}
          {older && (
            <ul className="scroll-thin max-h-40 space-y-0.5 overflow-y-auto">
              {revisions.map((r, i) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setChosen(r.id === chosen ? null : r.id)}
                    className={cn(
                      'flex w-full items-center gap-2 rounded-xl px-2 py-1 text-start text-sm hover:bg-accent',
                      r.id === chosen && 'bg-accent',
                    )}
                  >
                    <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {f.dayLabel(r.createdAt)}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{r.prompt}</span>
                    {i === 0 && (
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {t('routine.historyNow')}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {picked && <Compare revision={picked} current={current} onRestore={onRestore} />}
        </div>
      )}
    </div>
  );
}

function Compare({
  revision,
  current,
  onRestore,
}: {
  revision: RoutineRevision;
  current: string;
  onRestore(prompt: string): void;
}) {
  const t = useT();
  const parts = useMemo(() => textDiff(revision.prompt, current), [revision.prompt, current]);
  const same = parts.every((p) => p.type === 'same');
  return (
    <div className="space-y-2 border-t pt-2">
      <p className="px-1 text-xs text-muted-foreground">
        {same ? t('routine.historySame') : t('routine.historyDiff')}
      </p>
      {!same && (
        <div className="scroll-thin max-h-48 overflow-y-auto rounded-xl bg-muted/40 px-2.5 py-2 text-sm break-words whitespace-pre-wrap">
          {parts.map((p, i) =>
            p.type === 'same' ? (
              <span key={i}>{p.text}</span>
            ) : p.type === 'removed' ? (
              <del key={i} className="bg-red-500/15 text-red-700 dark:text-red-300">
                {p.text}
              </del>
            ) : (
              <ins key={i} className="bg-emerald-500/15 text-emerald-700 no-underline dark:text-emerald-300">
                {p.text}
              </ins>
            ),
          )}
        </div>
      )}
      {!same && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="rounded-full"
          onClick={() => onRestore(revision.prompt)}
        >
          <RotateCcw className="size-3.5" /> {t('routine.historyRestore')}
        </Button>
      )}
    </div>
  );
}
