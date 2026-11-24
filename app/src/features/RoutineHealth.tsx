import {
  askText,
  duration,
  findingText,
  healthFix,
  needsAttention,
  type Routine,
  type RoutineHealthFinding,
  type RoutineHealthStatus,
} from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { useRoutineHealth } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';

export { duration, needsAttention };

/** A routine's standing as a coloured dot and its name. */
export function HealthStatus({ status, className }: { status: RoutineHealthStatus; className?: string }) {
  const t = useT();
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-xs text-muted-foreground', className)}>
      <span
        aria-hidden
        className={cn(
          'size-2 shrink-0 rounded-full',
          status === 'problem' && 'bg-destructive',
          status === 'improvable' && 'bg-amber-500',
          status === 'good' && 'bg-emerald-500',
          (status === 'unused' || status === 'unknown') && 'bg-muted-foreground/40',
        )}
      />
      {t(`health.status.${status}`)}
    </span>
  );
}

/**
 * Opens the bot's main conversation with the message in its text box, for the person to read and
 * send. Nothing is sent and nothing changes until they do, and the bot then changes the routine
 * only as its permissions allow.
 */
export async function askBot(botId: string, text: string): Promise<void> {
  const main = await api.mainThread(botId);
  const ui = useUi.getState();
  if (!ui.leavePage()) return;
  ui.openChat(botId);
  ui.selectThread(main.id);
  ui.draft({ threadId: main.id, text });
}

function Finding({
  routine,
  finding,
  locked,
}: {
  routine: Routine;
  finding: RoutineHealthFinding;
  /** The page has changes not saved: applying would put them out of step with the saved routine. */
  locked: boolean;
}) {
  const t = useT();
  const { usd } = useFormat();
  const qc = useQueryClient();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['routines'] });
    void qc.invalidateQueries({ queryKey: ['routine-health'] });
  };
  const fail = (e: unknown) => toast.error((e as Error).message);
  const fix = healthFix(routine, finding);
  const ask = askText(routine, finding, t);
  const apply = useMutation({
    mutationFn: async () => {
      if (!fix) return null;
      if (!confirm(t('health.applyConfirm', { step: fix.step, from: fix.from, to: fix.to }))) return null;
      const before = routine.steps ?? [];
      await api.updateRoutine(routine.id, { steps: fix.steps });
      return before;
    },
    onSuccess: (before) => {
      if (!before) return;
      refresh();
      toast.success(t('health.applied'), {
        // Long enough to see what changed on the page and take it back.
        duration: 10_000,
        action: {
          label: t('health.undo'),
          onClick: () =>
            void api
              .updateRoutine(routine.id, { steps: before })
              .then(() => {
                toast.success(t('health.undone'));
                refresh();
              })
              .catch(fail),
        },
      });
    },
    onError: fail,
  });
  const dismiss = useMutation({
    mutationFn: () => api.dismissRoutineHealth(routine.id, finding.id),
    onSuccess: refresh,
    onError: fail,
  });
  const asking = useMutation({ mutationFn: () => askBot(routine.botId, ask!), onError: fail });
  return (
    <li className="space-y-2 rounded-xl bg-secondary/60 px-3 py-2">
      <p>{findingText(finding, t, usd)}</p>
      <div className="flex flex-wrap gap-2">
        {fix && (
          <Button
            type="button"
            size="sm"
            className="rounded-full"
            disabled={locked || apply.isPending}
            title={locked ? t('health.saveFirst') : undefined}
            onClick={() => apply.mutate()}
          >
            {t('health.apply')}
          </Button>
        )}
        {ask && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="rounded-full"
            disabled={asking.isPending}
            onClick={() => asking.mutate()}
          >
            {t('health.ask')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="rounded-full"
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate()}
        >
          {t('health.dismiss')}
        </Button>
      </div>
    </li>
  );
}

/**
 * A routine's health on its page: how its runs of the last 30 days ended, what they cost, and what
 * in them is worth changing, each with what can be done about it.
 */
export function RoutineHealthBlock({ routine, locked }: { routine: Routine; locked: boolean }) {
  const t = useT();
  const { usd, dayLabel } = useFormat();
  const { data } = useRoutineHealth();
  const h = data?.find((x) => x.routineId === routine.id);
  if (!h) return null;
  const open = h.runs.total - h.runs.ok - h.runs.quiet - h.runs.failed;
  const facts = [
    t('health.runs', { total: h.runs.total, ok: h.runs.ok, quiet: h.runs.quiet, failed: h.runs.failed }),
    // Runs still going or held, stopped by a usage limit or the person, or from before outcomes were kept.
    ...(open > 0 ? [t('health.open', { count: open })] : []),
    ...(h.runs.skipped > 0 ? [t('health.skipped', { count: h.runs.skipped })] : []),
    t('health.cost', { cost: usd(h.costUsd) }) +
      (h.unpricedRuns ? ` (${t('health.unpriced', { count: h.unpricedRuns })})` : ''),
    ...(h.avgMs !== null ? [t('health.avg', { time: duration(h.avgMs, t) })] : []),
  ];
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <div className="text-sm font-medium">{t('health.title')}</div>
        <HealthStatus status={h.status} />
      </div>
      <div className="space-y-2 rounded-2xl border p-3 text-sm">
        <p className="text-xs text-muted-foreground">
          {t('health.window')} · {facts.join(' · ')}
        </p>
        <p className="text-xs text-muted-foreground">
          {h.since ? t('health.since', { when: dayLabel(h.since) }) : t('health.notMeasured')}
        </p>
        {h.findings.length > 0 && (
          <ul className="space-y-2">
            {h.findings.map((f) => (
              <Finding key={`${f.id}-${f.step ?? ''}`} routine={routine} finding={f} locked={locked} />
            ))}
          </ul>
        )}
        {h.hidden > 0 && (
          <p className="text-xs text-muted-foreground">{t('health.hidden', { count: h.hidden })}</p>
        )}
      </div>
    </div>
  );
}
