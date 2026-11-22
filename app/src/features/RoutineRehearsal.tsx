import type { Rehearsal, ReplayableRun, Routine } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FlaskConical } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { clock, rehearsalSeconds, startedBySomething, triggerKey } from '@/lib/rehearsal';
import { cn } from '@/lib/utils';

const NONE = 'none';

/**
 * Tries a routine once without doing anything, with the instruction as it is typed in the form and,
 * for a routine something else starts, with what started one of its last runs. The result lists
 * what the bot would have done and what it really did (only reading).
 */
export function RoutineRehearsal({
  routine,
  prompt,
  open: given,
  onOpenChange,
  note,
}: {
  routine: Routine;
  prompt: string;
  /** Opened from outside (the flow's boxes), instead of by its own button only. */
  open?: boolean;
  onOpenChange?(open: boolean): void;
  /** A line on what is tried, when it is not the routine's own instruction. */
  note?: string;
}) {
  const t = useT();
  const f = useFormat();
  const qc = useQueryClient();
  const [own, setOwn] = useState(false);
  const open = given ?? own;
  const setOpen = (v: boolean) => {
    setOwn(v);
    onOpenChange?.(v);
  };
  const [chosen, setChosen] = useState<string | null>(null);
  const [replay, setReplay] = useState<string | null>(null);
  const { data: rehearsals = [] } = useQuery({
    queryKey: ['routine-rehearsals', routine.id],
    queryFn: () => api.routineRehearsals(routine.id),
    enabled: open,
    refetchInterval: (q) => (q.state.data?.some((r) => r.status === 'running') ? 2000 : false),
  });
  const offersReplay = startedBySomething(routine);
  const { data: runs = [] } = useQuery({
    queryKey: ['routine-replayable', routine.id],
    queryFn: () => api.routineReplayable(routine.id),
    enabled: open && offersReplay,
  });
  const replayable = runs.filter((r) => r.replayable);
  // The latest run that kept its input is the default.
  const picked = replay ?? replayable[0]?.runId ?? NONE;
  const shown = rehearsals.find((r) => r.id === chosen) ?? rehearsals[0] ?? null;
  const running = rehearsals.some((r) => r.status === 'running');
  const typed = prompt.trim();
  const draft = typed !== routine.prompt;

  const start = useMutation({
    mutationFn: () =>
      api.rehearseRoutine(routine.id, {
        ...(typed ? { prompt: typed } : {}),
        ...(picked !== NONE ? { replayRunId: picked } : {}),
      }),
    onSuccess: (r) => {
      setChosen(r.id);
      void qc.invalidateQueries({ queryKey: ['routine-rehearsals', routine.id] });
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <div className="space-y-2">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-7 rounded-full px-2 text-xs text-muted-foreground"
        onClick={() => {
          setOpen(!open);
          // Opened again, the latest run that kept its input is the default again.
          setReplay(null);
        }}
        aria-expanded={open}
      >
        <FlaskConical className="size-3.5" /> {t('rehearsal.title')}
      </Button>
      {open && (
        <div className="space-y-3 rounded-2xl border p-3">
          <p className="text-sm text-muted-foreground">{t('rehearsal.hint')}</p>
          {/* A step's own instruction is neither the saved one nor a draft of it: the note says what it is. */}
          <p className="text-xs text-muted-foreground">
            {note ?? (draft ? t('rehearsal.draftNote') : t('rehearsal.savedNote'))}
          </p>
          {offersReplay && (
            <div className="space-y-1.5">
              <div className="text-sm text-muted-foreground">{t('rehearsal.replay')}</div>
              <Select value={picked} onValueChange={setReplay}>
                <SelectTrigger className="w-full rounded-xl">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>{t('rehearsal.replayNone')}</SelectItem>
                  {replayable.map((r: ReplayableRun) => (
                    <SelectItem key={r.runId} value={r.runId}>
                      {t('rehearsal.replayRun', {
                        when: f.dayLabel(r.startedAt),
                        trigger: t(triggerKey(r.trigger)),
                      })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {runs.some((r) => !r.replayable) && (
                <p className="text-xs text-muted-foreground">{t('rehearsal.replayOlder')}</p>
              )}
              {!runs.length && <p className="text-xs text-muted-foreground">{t('rehearsal.replayNoRuns')}</p>}
            </div>
          )}
          <Button
            type="button"
            size="sm"
            className="rounded-full"
            disabled={!typed || start.isPending || running}
            onClick={() => start.mutate()}
          >
            <FlaskConical className="size-3.5" /> {running ? t('rehearsal.running') : t('rehearsal.run')}
          </Button>
          {rehearsals.length > 1 && (
            <ul className="flex flex-wrap gap-1.5" aria-label={t('rehearsal.earlier')}>
              {rehearsals.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setChosen(r.id)}
                    className={cn(
                      'rounded-full border px-2.5 py-0.5 text-xs hover:bg-accent',
                      r.id === shown?.id && 'bg-accent',
                    )}
                  >
                    {f.dayLabel(r.startedAt)}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {shown && <Result rehearsal={shown} />}
          <p className="text-xs text-muted-foreground">{t('rehearsal.kept')}</p>
        </div>
      )}
    </div>
  );
}

function Result({ rehearsal: r }: { rehearsal: Rehearsal }) {
  const t = useT();
  const f = useFormat();
  const took = rehearsalSeconds(r);
  const would = r.steps.filter((s) => s.kind === 'would');
  const ran = r.steps.filter((s) => s.kind === 'ran');
  return (
    <div className="space-y-3 border-t pt-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="font-medium text-foreground">{t(`rehearsal.status.${r.status}` as MessageKey)}</span>
        {r.draft && <span>{t('rehearsal.draftTag')}</span>}
        {took !== null && <span>{t('rehearsal.duration', { time: clock(took) })}</span>}
        {r.costUsd !== null && <span>{t('rehearsal.cost', { cost: f.usd(r.costUsd) })}</span>}
      </div>
      {r.error && <p className="text-sm text-destructive">{t('rehearsal.error', { message: r.error })}</p>}
      <div className={cn('grid gap-3', r.replay && 'sm:grid-cols-2')}>
        <Report title={t('rehearsal.report')} text={r.report} empty={t('rehearsal.noReport')} />
        {r.replay && (
          <Report
            title={t('rehearsal.actual', { when: f.dayLabel(r.replay.startedAt) })}
            text={r.replay.report ?? ''}
            empty={t('rehearsal.noActual')}
          />
        )}
      </div>
      <Steps title={t('rehearsal.would')} steps={would} empty={t('rehearsal.wouldNone')} numbered />
      <Steps title={t('rehearsal.ran')} steps={ran} empty={t('rehearsal.ranNone')} />
    </div>
  );
}

function Report({ title, text, empty }: { title: string; text: string; empty: string }) {
  return (
    <div className="min-w-0 space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      <div className="scroll-thin max-h-56 overflow-y-auto rounded-xl bg-muted/40 px-2.5 py-2 text-sm break-words whitespace-pre-wrap">
        {text.trim() ? text : <span className="text-muted-foreground">{empty}</span>}
      </div>
    </div>
  );
}

function Steps({
  title,
  steps,
  empty,
  numbered,
}: {
  title: string;
  steps: Rehearsal['steps'];
  empty: string;
  numbered?: boolean;
}) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{title}</div>
      {steps.length ? (
        <ol className="space-y-1 text-sm">
          {steps.map((s, i) => (
            <li key={`${s.at}-${i}`} className="flex gap-2">
              {numbered && <span className="shrink-0 text-muted-foreground tabular-nums">{i + 1}.</span>}
              <span className="min-w-0 break-words whitespace-pre-wrap">{s.summary}</span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="text-sm text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}
