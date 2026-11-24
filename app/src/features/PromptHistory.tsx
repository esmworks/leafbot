import {
  textDiff,
  versionChanges,
  VERSION_FEW_RUNS,
  type RoutineRevision,
  type RoutineVersionStats,
} from '@leafbot/shared';
import { useQuery } from '@tanstack/react-query';
import { History, RotateCcw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { cn } from '@/lib/utils';
import { duration } from './RoutineHealth';

type T = ReturnType<typeof useT>;

/**
 * The versions a routine has had, each with what changed in it and how its runs went. Choosing one
 * shows how the instruction in the form differs from it, and bringing it back puts the whole
 * version in the form; saving then writes it as the newest.
 */
export function PromptHistory({
  routineId,
  current,
  onRestore,
}: {
  routineId: string;
  /** The instruction as the form holds it now, saved or not. */
  current: string;
  onRestore(revision: RoutineRevision): void;
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
  const { data: report } = useQuery({
    queryKey: ['routine-versions', routineId],
    queryFn: () => api.routineVersions(routineId),
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
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                          {f.dayLabel(r.createdAt)}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{r.prompt}</span>
                        {i === 0 && (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {t('routine.historyNow')}
                          </span>
                        )}
                      </span>
                      <span className="truncate text-xs text-muted-foreground">
                        {[changeText(r, revisions[i + 1], t), statsText(report?.versions[r.id], t, f.usd)]
                          .filter(Boolean)
                          .join(' · ')}
                      </span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {older && report?.untracked && (
            <p className="px-2 text-xs text-muted-foreground">
              {t('routine.historyUntracked')} · {statsText(report.untracked, t, f.usd)}
            </p>
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
  onRestore(revision: RoutineRevision): void;
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
      <p className="px-1 text-xs text-muted-foreground">
        {revision.full === false ? t('routine.historyRestorePrompt') : t('routine.historyRestoreFull')}
      </p>
      {(!same || revision.full !== false) && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="rounded-full"
          onClick={() => onRestore(revision)}
        >
          <RotateCcw className="size-3.5" /> {t('routine.historyRestore')}
        </Button>
      )}
    </div>
  );
}

/** What changed in a version since the one before it. */
function changeText(r: RoutineRevision, before: RoutineRevision | undefined, t: T): string {
  if (!before) return '';
  const parts = versionChanges(r, before);
  if (parts.length)
    return t('routine.historyChanged', { parts: parts.map((p) => t(`routine.historyPart.${p}`)).join(', ') });
  // Same instruction, kept again with its other parts once they started to be kept.
  return r.full !== false && before.full === false ? t('routine.historyTracked') : '';
}

/** How a version's runs went, as the routine's health says it; few runs are marked as such. */
function statsText(s: RoutineVersionStats | undefined, t: T, usd: (n: number) => string): string {
  if (!s || !s.total)
    return s?.skipped ? t('health.skipped', { count: s.skipped }) : t('routine.historyNoRuns');
  const measured = s.ok + s.quiet + s.failed;
  return [
    t('health.runs', { total: s.total, ok: s.ok, quiet: s.quiet, failed: s.failed }),
    t('health.cost', { cost: usd(s.costUsd) }) +
      (s.unpricedRuns ? ` (${t('health.unpriced', { count: s.unpricedRuns })})` : ''),
    ...(s.avgMs !== null ? [t('health.avg', { time: duration(s.avgMs, t) })] : []),
    ...(measured < VERSION_FEW_RUNS ? [t('routine.historyFew')] : []),
  ].join(' · ');
}
