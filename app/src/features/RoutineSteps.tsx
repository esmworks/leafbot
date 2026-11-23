import {
  INTL_LOCALE,
  ROUTINE_APPROVAL_MAX_DAYS,
  ROUTINE_WAIT_MAX_MINUTES,
  type RoutineRun,
  type RoutineStepRun,
} from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Bot as BotIcon,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  CircleX,
  Hourglass,
  LoaderCircle,
  Plus,
  RotateCcw,
  Send,
  Trash2,
  UserCheck,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useLocale, useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { useApprovals } from '@/lib/queries';
import { cn } from '@/lib/utils';

/** A step as the routine's window edits it; text fields stay strings while typed. */
export type StepForm =
  | { id: string; kind: 'agent'; prompt: string; model: string }
  | { id: string; kind: 'approval'; question: string; timeoutDays: number }
  | { id: string; kind: 'notify'; text: string; withBefore: boolean }
  | {
      id: string;
      kind: 'wait';
      on: 'time' | 'webhook' | 'email';
      minutes: number;
      filter: string;
      timeoutDays: number;
    };

const WAIT_ON = ['time', 'webhook', 'email'] as const;

/** A whole number typed into a field, kept between `min` and `max`. */
const clamp = (raw: string, min: number, max: number) =>
  Math.min(max, Math.max(min, Math.round(Number(raw) || min)));

/** A new step's id: short, unique within the routine, and of the letters the server takes. */
function newStepId(): string {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

export function newAgentStep(): StepForm {
  return { id: newStepId(), kind: 'agent', prompt: '', model: '' };
}

function newApprovalStep(): StepForm {
  return { id: newStepId(), kind: 'approval', question: '', timeoutDays: 7 };
}

function newNotifyStep(): StepForm {
  return { id: newStepId(), kind: 'notify', text: '', withBefore: true };
}

function newWaitStep(): StepForm {
  return { id: newStepId(), kind: 'wait', on: 'time', minutes: 60, filter: '', timeoutDays: 7 };
}

/** The kinds of step, in the order they are offered. */
export const STEP_KINDS = ['agent', 'approval', 'wait', 'notify'] as const;

/** A new, empty step of each kind. */
export const NEW_STEP: Record<StepForm['kind'], () => StepForm> = {
  agent: newAgentStep,
  approval: newApprovalStep,
  wait: newWaitStep,
  notify: newNotifyStep,
};

/** The icon of a step's kind. */
export function StepIcon({ kind }: { kind: StepForm['kind'] }) {
  const Icon =
    kind === 'approval' ? UserCheck : kind === 'wait' ? Hourglass : kind === 'notify' ? Send : BotIcon;
  return <Icon className="size-3.5" aria-hidden />;
}

/**
 * The steps after the routine's own instruction, each a card in the order they run: what it does,
 * the model it runs on, and buttons to move or remove it.
 */
export function StepsEditor({
  steps,
  onChange,
  errors,
  modelListId,
  modelPlaceholder,
}: {
  steps: StepForm[];
  onChange(next: StepForm[]): void;
  /** Message keys of the steps' prompts that did not pass, by position. */
  errors?: (string | undefined)[];
  /** The datalist of models the model fields offer. */
  modelListId: string;
  modelPlaceholder: string;
}) {
  const t = useT();
  const set = (i: number, next: StepForm) => onChange(steps.map((s, j) => (j === i ? next : s)));
  const move = (i: number, by: -1 | 1) => {
    const next = [...steps];
    const [s] = next.splice(i, 1);
    next.splice(i + by, 0, s!);
    onChange(next);
  };
  return (
    <div className="space-y-2">
      <div className="space-y-0.5">
        <div className="text-sm text-muted-foreground">{t('routine.steps')}</div>
        <p className="text-xs text-muted-foreground">{t('routine.stepsHint')}</p>
      </div>
      {steps.map((s, i) => (
        <div key={s.id} className="space-y-2 rounded-2xl border px-3 py-2.5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <StepIcon kind={s.kind} />
            <span className="min-w-0 flex-1">{t(`routine.step.${s.kind}`)}</span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 rounded-full"
              disabled={i === 0}
              onClick={() => move(i, -1)}
              aria-label={t('routine.stepUp')}
            >
              <ArrowUp className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 rounded-full"
              disabled={i === steps.length - 1}
              onClick={() => move(i, 1)}
              aria-label={t('routine.stepDown')}
            >
              <ArrowDown className="size-3.5" />
            </Button>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-7 rounded-full"
              onClick={() => onChange(steps.filter((_, j) => j !== i))}
              aria-label={t('routine.stepRemove')}
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
          <StepFields
            step={s}
            onChange={(next) => set(i, next)}
            error={errors?.[i]}
            modelListId={modelListId}
            modelPlaceholder={modelPlaceholder}
          />
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="rounded-full"
          onClick={() => onChange([...steps, newAgentStep()])}
        >
          <Plus /> {t('routine.addAgentStep')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="rounded-full"
          onClick={() => onChange([...steps, newApprovalStep()])}
        >
          <UserCheck /> {t('routine.addApprovalStep')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="rounded-full"
          onClick={() => onChange([...steps, newWaitStep()])}
        >
          <Hourglass /> {t('routine.addWaitStep')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="rounded-full"
          onClick={() => onChange([...steps, newNotifyStep()])}
        >
          <Send /> {t('routine.addNotifyStep')}
        </Button>
      </div>
    </div>
  );
}

/** What one step does, as the list and the flow both edit it. */
export function StepFields({
  step: s,
  onChange,
  error,
  modelListId,
  modelPlaceholder,
}: {
  step: StepForm;
  onChange(next: StepForm): void;
  /** The message key of the step's text that did not pass. */
  error?: string;
  modelListId: string;
  modelPlaceholder: string;
}) {
  const t = useT();
  return (
    <>
      {s.kind === 'agent' ? (
        <>
          <Textarea
            value={s.prompt}
            onChange={(e) => onChange({ ...s, prompt: e.target.value })}
            rows={3}
            placeholder={t('routine.stepPromptPlaceholder')}
            className="scroll-thin max-h-60 overflow-y-auto rounded-xl"
            aria-label={t('routine.step.agent')}
          />
          {error && <p className="text-sm text-destructive">{t(error as MessageKey)}</p>}
          <Input
            value={s.model}
            onChange={(e) => onChange({ ...s, model: e.target.value })}
            list={modelListId}
            placeholder={modelPlaceholder}
            className="h-8 rounded-xl text-sm"
            aria-label={t('routine.stepModel')}
          />
        </>
      ) : s.kind === 'wait' ? (
        <WaitFields step={s} onChange={onChange} />
      ) : s.kind === 'notify' ? (
        <>
          <Textarea
            value={s.text}
            onChange={(e) => onChange({ ...s, text: e.target.value })}
            rows={2}
            placeholder={t('routine.notifyPlaceholder')}
            className="scroll-thin max-h-40 overflow-y-auto rounded-xl"
            aria-label={t('routine.step.notify')}
          />
          <label className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
            <span>{t('routine.notifyWithBefore')}</span>
            <Switch checked={s.withBefore} onCheckedChange={(v) => onChange({ ...s, withBefore: v })} />
          </label>
          <p className="text-xs text-muted-foreground">{t('routine.notifyHint')}</p>
        </>
      ) : (
        <>
          <Textarea
            value={s.question}
            onChange={(e) => onChange({ ...s, question: e.target.value })}
            rows={2}
            placeholder={t('routine.stepQuestionPlaceholder')}
            className="scroll-thin max-h-40 overflow-y-auto rounded-xl"
            aria-label={t('routine.step.approval')}
          />
          {error && <p className="text-sm text-destructive">{t(error as MessageKey)}</p>}
          <p className="text-xs text-muted-foreground">{t('routine.stepApprovalHint')}</p>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Hourglass className="size-3.5" aria-hidden />
            <span className="flex-1">{t('routine.stepTimeoutDays')}</span>
            <Input
              type="number"
              min={1}
              max={ROUTINE_APPROVAL_MAX_DAYS}
              value={s.timeoutDays}
              onChange={(e) =>
                onChange({ ...s, timeoutDays: clamp(e.target.value, 1, ROUTINE_APPROVAL_MAX_DAYS) })
              }
              className="h-8 w-20 rounded-xl text-sm"
            />
          </label>
        </>
      )}
    </>
  );
}

/**
 * The buttons of a run's approval step, under it in the routine's list: the same card the run's
 * conversation shows, answered from here.
 */
export function ApprovalAnswer({ approvalId, routineId }: { approvalId: string; routineId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const card = useApprovals().data?.find((a) => a.id === approvalId);
  const [revising, setRevising] = useState(false);
  const [text, setText] = useState('');
  const send = useMutation({
    mutationFn: (answer: string) => api.answer(approvalId, { decision: 'allow', answer }),
    onSuccess: () => {
      setRevising(false);
      setText('');
      void qc.invalidateQueries({ queryKey: ['approvals'] });
      void qc.invalidateQueries({ queryKey: ['routine-runs', routineId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (card?.status !== 'pending') return null;
  const [approve, reject] = card.options;
  const small = 'h-7 rounded-full px-3 text-xs';
  return (
    <span className="mt-1 block space-y-1.5">
      <span className="flex flex-wrap gap-1.5">
        {approve && (
          <Button
            type="button"
            size="sm"
            className={small}
            disabled={send.isPending}
            onClick={() => send.mutate(approve)}
          >
            {t('routine.approve')}
          </Button>
        )}
        {reject && (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className={small}
            disabled={send.isPending}
            onClick={() => send.mutate(reject)}
          >
            {t('routine.reject')}
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className={small}
          disabled={send.isPending}
          onClick={() => setRevising((v) => !v)}
        >
          {t('routine.revise')}
        </Button>
      </span>
      {revising && (
        <span className="flex gap-1.5">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={t('routine.revisePlaceholder')}
            className="h-7 rounded-xl text-xs"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing && text.trim()) {
                e.preventDefault();
                send.mutate(text.trim());
              }
            }}
          />
          <Button
            type="button"
            size="sm"
            className={small}
            disabled={!text.trim() || send.isPending}
            onClick={() => send.mutate(text.trim())}
          >
            {t('routine.reviseSend')}
          </Button>
        </span>
      )}
    </span>
  );
}

/** What a wait step waits for: a time, or a call to the routine's webhook or a mail that passes its filter. */
function WaitFields({
  step,
  onChange,
}: {
  step: Extract<StepForm, { kind: 'wait' }>;
  onChange(next: StepForm): void;
}) {
  const t = useT();
  return (
    <>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('routine.waitOn')}>
        {WAIT_ON.map((on) => (
          <Button
            key={on}
            type="button"
            size="sm"
            role="radio"
            aria-checked={step.on === on}
            variant={step.on === on ? 'default' : 'secondary'}
            className="h-7 rounded-full px-3 text-xs"
            onClick={() => onChange({ ...step, on })}
          >
            {t(`routine.waitOn.${on}`)}
          </Button>
        ))}
      </div>
      {step.on === 'time' ? (
        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="flex-1">{t('routine.waitMinutes')}</span>
          <Input
            type="number"
            min={1}
            max={ROUTINE_WAIT_MAX_MINUTES}
            value={step.minutes}
            onChange={(e) =>
              onChange({ ...step, minutes: clamp(e.target.value, 1, ROUTINE_WAIT_MAX_MINUTES) })
            }
            className="h-8 w-24 rounded-xl text-sm"
          />
        </label>
      ) : (
        <>
          <Textarea
            value={step.filter}
            onChange={(e) => onChange({ ...step, filter: e.target.value })}
            rows={2}
            placeholder={t(step.on === 'webhook' ? 'routine.waitFilterHook' : 'routine.waitFilterMail')}
            className="scroll-thin max-h-40 overflow-y-auto rounded-xl text-sm"
            aria-label={t('routine.waitFilter')}
          />
          <p className="text-xs text-muted-foreground">
            {t(step.on === 'webhook' ? 'routine.waitHookHint' : 'routine.waitMailHint')}
          </p>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="flex-1">{t('routine.stepTimeoutDays')}</span>
            <Input
              type="number"
              min={1}
              max={ROUTINE_APPROVAL_MAX_DAYS}
              value={step.timeoutDays}
              onChange={(e) =>
                onChange({ ...step, timeoutDays: clamp(e.target.value, 1, ROUTINE_APPROVAL_MAX_DAYS) })
              }
              className="h-8 w-20 rounded-xl text-sm"
            />
          </label>
        </>
      )}
    </>
  );
}

/** Ends a run's wait now; the run goes on as if its time had come. */
export function EndWait({ run }: { run: RoutineRun }) {
  const t = useT();
  const qc = useQueryClient();
  const end = useMutation({
    mutationFn: () => api.endRoutineWait(run.routineId, run.id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['routine-runs', run.routineId] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      className="mt-1 h-7 rounded-full px-3 text-xs"
      disabled={end.isPending}
      onClick={() => end.mutate()}
    >
      {t('routine.endWait')}
    </Button>
  );
}

/** A routine to start from: what it is called, its instruction and its steps, ready to change. */
export interface RoutineTemplate {
  key: 'reply' | 'issue' | 'weekly';
  name: string;
  prompt: string;
  steps: StepForm[];
  weekly?: boolean;
}

/** Workflows people often build, each a few steps a routine can do as they are. */
export function routineTemplates(t: ReturnType<typeof useT>): RoutineTemplate[] {
  return [
    {
      key: 'reply',
      name: t('routine.template.reply.name'),
      prompt: t('routine.template.reply.prompt'),
      steps: [
        { id: 'onay', kind: 'approval', question: t('routine.template.reply.ask'), timeoutDays: 3 },
        { id: 'gonder', kind: 'agent', prompt: t('routine.template.reply.send'), model: '' },
      ],
    },
    {
      key: 'issue',
      name: t('routine.template.issue.name'),
      prompt: t('routine.template.issue.prompt'),
      steps: [
        {
          id: 'kapanis',
          kind: 'wait',
          on: 'webhook',
          minutes: 60,
          filter: 'event=issues\naction=closed\nissue.number={{issue}}',
          timeoutDays: 30,
        },
        { id: 'taslak', kind: 'agent', prompt: t('routine.template.issue.draft'), model: '' },
        { id: 'onay', kind: 'approval', question: t('routine.template.issue.ask'), timeoutDays: 7 },
        { id: 'gonder', kind: 'agent', prompt: t('routine.template.issue.send'), model: '' },
      ],
    },
    {
      key: 'weekly',
      name: t('routine.template.weekly.name'),
      prompt: t('routine.template.weekly.prompt'),
      steps: [{ id: 'bildir', kind: 'notify', text: t('routine.template.weekly.notify'), withBefore: true }],
      weekly: true,
    },
  ];
}

/** Buttons that fill a new routine from one of the templates. */
export function TemplatePicker({ onPick }: { onPick(template: RoutineTemplate): void }) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <div className="text-sm text-muted-foreground">{t('routine.templates')}</div>
      <div className="flex flex-wrap gap-1.5">
        {routineTemplates(t).map((tpl) => (
          <Button
            key={tpl.key}
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 rounded-full px-3 text-xs"
            onClick={() => onPick(tpl)}
          >
            {tpl.name}
          </Button>
        ))}
      </div>
    </div>
  );
}

const STEP_ICON: Record<RoutineStepRun['status'], typeof CircleCheck> = {
  pending: CircleDashed,
  running: LoaderCircle,
  waiting: Hourglass,
  done: CircleCheck,
  error: CircleX,
  stopped: CircleSlash,
  skipped: CircleDashed,
};

/** The name a step of a run goes by in its list. */
function stepLabel(s: RoutineStepRun, t: ReturnType<typeof useT>): string {
  if (s.kind === 'prompt') return t('routine.step.prompt');
  return t(`routine.step.${s.kind}` as MessageKey);
}

/**
 * How each step of a run went, under the run in the routine's list. A run that failed or was
 * stopped part way can go on from that step.
 */
export function RunSteps({ run }: { run: RoutineRun }) {
  const t = useT();
  const locale = useLocale((x) => x.locale);
  const qc = useQueryClient();
  const retry = useMutation({
    mutationFn: () => api.retryRoutineRun(run.routineId, run.id),
    onSuccess: () => {
      toast.success(t('routine.retried'));
      void qc.invalidateQueries({ queryKey: ['routine-runs', run.routineId] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  if (!run.steps?.length) return null;
  const halted = run.status === 'error' || run.status === 'stopped';
  return (
    <div className="mt-1 ms-4 space-y-1 border-s ps-3">
      {run.steps.map((s) => {
        const Icon = STEP_ICON[s.status] ?? CircleDashed;
        return (
          <div key={s.position} className="flex items-start gap-2 text-xs">
            <Icon
              className={cn(
                'mt-0.5 size-3.5 shrink-0',
                s.status === 'done' && 'text-emerald-500',
                (s.status === 'error' || s.status === 'stopped') && 'text-destructive',
                s.status === 'running' && 'animate-spin text-amber-500',
                s.status === 'waiting' && 'text-amber-500',
                (s.status === 'pending' || s.status === 'skipped') && 'text-muted-foreground/60',
              )}
              aria-hidden
            />
            <span className="min-w-0 flex-1">
              <span
                className={cn(
                  'block',
                  (s.status === 'pending' || s.status === 'skipped') && 'text-muted-foreground',
                )}
              >
                {stepLabel(s, t)} · {t(`routine.stepStatus.${s.status}`)}
              </span>
              {(s.reason || s.output) && (
                <span className="block truncate text-muted-foreground">{s.reason ?? s.output}</span>
              )}
              {s.status === 'waiting' && s.approvalId && (
                <ApprovalAnswer approvalId={s.approvalId} routineId={run.routineId} />
              )}
              {s.status === 'waiting' && s.kind === 'wait' && (
                <>
                  {s.waitUntil && (
                    <span className="block text-muted-foreground">
                      {t('routine.waitUntil', {
                        at: new Date(s.waitUntil).toLocaleString(INTL_LOCALE[locale], {
                          dateStyle: 'medium',
                          timeStyle: 'short',
                        }),
                      })}
                    </span>
                  )}
                  <EndWait run={run} />
                </>
              )}
            </span>
          </div>
        );
      })}
      {halted && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="h-7 rounded-full px-3 text-xs"
          disabled={retry.isPending}
          onClick={() => retry.mutate()}
        >
          <RotateCcw className="size-3.5" /> {t('routine.retryRun')}
        </Button>
      )}
    </div>
  );
}
