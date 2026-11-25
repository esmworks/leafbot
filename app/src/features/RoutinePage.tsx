import {
  APP_EVENT_SOURCES,
  appEventFilter,
  appEventOf,
  appMakesSecret,
  describeSchedule,
  nextRun,
  parseCron,
  parseFields,
  ROUTINE_APPROVAL_MAX_DAYS,
  ROUTINE_FETCH_URL,
  ROUTINE_STEP_END,
  ROUTINE_VARS_MAX,
  ROUTINE_WAIT_MAX_MINUTES,
  SHORT_DAY_NAMES,
  stepRoutes,
  type FlowLayout,
  type FlowNote,
  type Routine,
  type RoutineRevision,
  type RoutineCondition,
  type Schedule,
} from '@leafbot/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, List, Pencil, Terminal, Webhook as WebhookIcon, Workflow } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch, type UseFormRegisterReturn, type UseFormReturn } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { useLocale, useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { useFormat } from '@/lib/format';
import {
  useBots,
  useClaudeModels,
  useConnections,
  useInfo,
  useRoutines,
  useSettings,
  useSummaries,
} from '@/lib/queries';
import { askBeforeLeavingPage, useUi } from '@/lib/store';
import { keepLayout } from '@/lib/routineFlow';
import { cn } from '@/lib/utils';
import { ConditionFields } from './RoutineCondition';
import { MissingApps } from './MissingApps';
import { PromptHistory } from './PromptHistory';
import { RoutineFlow } from './RoutineFlow';
import { RoutineHealthBlock } from './RoutineHealth';
import { RoutineRehearsal } from './RoutineRehearsal';
import { RunSteps, StepsEditor, TemplatePicker, type StepForm } from './RoutineSteps';

/**
 * The routine the store has open, in place of its bot's chat: a saved one while it still exists,
 * or a new one. A routine deleted meanwhile closes.
 */
export function useOpenedRoutine(): { botId: string; routine?: Routine; showRuns: boolean } | null {
  const opened = useUi((s) => s.routine);
  const { data: routines, isFetching } = useRoutines();
  const routine = opened?.routineId ? routines?.find((r) => r.id === opened.routineId) : undefined;
  const gone = !!opened?.routineId && !!routines && !isFetching && !routine;
  useEffect(() => {
    if (gone) useUi.getState().closePage();
  }, [gone]);
  if (!opened || (opened.routineId && !routine)) return null;
  return { botId: opened.botId, routine, showRuns: !!opened.showRuns };
}

/** Validation messages are message keys; `Field` shows them in the current language. */
/** What must hold for a step to run; the window always fills every field, so none has a default here. */
const stepWhen = z
  .object({
    contains: z.string().max(500),
    filter: z.string().max(2000),
    absent: z.boolean(),
    otherwise: z.enum(['skip', 'end', 'goto']),
    goto: z.string().optional(),
  })
  .nullable()
  .optional();
/** Where the run goes after the step: empty, the step after it; `end`, or another step's id. */
const stepNext = z.string().optional();

export const Form = z.object({
  name: z.string().trim().min(1, 'routine.nameRequired').max(80),
  prompt: z.string().trim().min(1, 'routine.promptRequired').max(20_000),
  /** What it does after its instruction, in order. */
  steps: z
    .array(
      z.discriminatedUnion('kind', [
        z.object({
          id: z.string(),
          kind: z.literal('agent'),
          prompt: z.string().trim().min(1, 'routine.stepPromptRequired').max(20_000),
          model: z.string().max(200),
          bot: z.string().optional(),
          when: stepWhen,
          next: stepNext,
          onError: z.string().optional(),
        }),
        z.object({
          id: z.string(),
          kind: z.literal('approval'),
          question: z.string().trim().min(1, 'routine.stepQuestionRequired').max(2000),
          timeoutDays: z.number().int().min(1).max(ROUTINE_APPROVAL_MAX_DAYS),
          when: stepWhen,
          next: stepNext,
          onReject: z.string().optional(),
        }),
        z.object({
          id: z.string(),
          kind: z.literal('notify'),
          text: z.string().max(4000),
          withBefore: z.boolean(),
          when: stepWhen,
          next: stepNext,
        }),
        z.object({
          id: z.string(),
          kind: z.literal('wait'),
          on: z.enum(['time', 'webhook', 'email', 'chat']),
          minutes: z.number().int().min(1).max(ROUTINE_WAIT_MAX_MINUTES),
          filter: z.string().max(2000),
          timeoutDays: z.number().int().min(1).max(ROUTINE_APPROVAL_MAX_DAYS),
          when: stepWhen,
          next: stepNext,
        }),
        z.object({
          id: z.string(),
          kind: z.literal('fetch'),
          url: z.string().trim().max(2000).regex(ROUTINE_FETCH_URL, 'routine.fetchUrlInvalid'),
          when: stepWhen,
          next: stepNext,
          onError: z.string().optional(),
        }),
        z.object({
          id: z.string(),
          kind: z.literal('extract'),
          fields: z
            .string()
            .max(2000)
            .refine((v) => {
              const f = parseFields(v);
              return !!f && f.length >= 1 && f.length <= ROUTINE_VARS_MAX;
            }, 'routine.extractFieldsInvalid'),
          when: stepWhen,
          next: stepNext,
          onError: z.string().optional(),
        }),
      ]),
    )
    // A way to a step the routine no longer has (taken out) is shown on that step.
    .superRefine((steps, ctx) => {
      for (const r of stepRoutes(steps)) {
        if (r.field === 'next' && r.to === ROUTINE_STEP_END) continue;
        const at = steps.findIndex((x) => x.id === r.to);
        if (at >= 0 && at !== r.from) continue;
        ctx.addIssue({
          code: 'custom',
          path: [r.from, r.field === 'otherwise' ? 'when' : r.field],
          message: 'routine.stepWayInvalid',
        });
      }
    }),
  type: z.enum(['hourly', 'daily', 'weekdays', 'weekly', 'monthly', 'interval', 'cron', 'once']),
  expr: z
    .string()
    .trim()
    .refine((e) => parseCron(e) !== null, 'routine.cronInvalid'),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'routine.dateFormat'),
  missed: z.enum(['run', 'skip']),
  carryReport: z.boolean(),
  reportOnly: z.boolean(),
  inMain: z.boolean(),
  onStartup: z.boolean(),
  webhookFilter: z.string().max(2000),
  webhookPost: z.boolean(),
  emailTrigger: z.boolean(),
  emailFilter: z.string().max(2000),
  /** The followed WhatsApp group's address; empty for none. */
  whatsappGroup: z.string(),
  whatsappPeople: z.boolean(),
  /** The id of the bot's table whose rows start it; empty for none. */
  tableTrigger: z.string(),
  tableFilter: z.string().max(2000),
  /** What must hold before a scheduled run, as the routine has it; null for nothing. */
  condition: z.custom<RoutineCondition | null>(),
  model: z.string().max(200),
  slackChannel: z
    .string()
    .trim()
    .regex(/^([CG][A-Z0-9]{6,20})?$/, 'routine.slackChannelInvalid'),
  slackReaction: z
    .string()
    .trim()
    .regex(/^:?[a-zA-Z0-9_+'-]{0,80}:?$/, 'routine.slackReactionInvalid'),
  watchUrl: z
    .string()
    .trim()
    .regex(/^(https:\/\/\S+)?$/, 'routine.watchUrlInvalid'),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'routine.timeFormat'),
  minute: z.number().int().min(0).max(59),
  days: z.array(z.number()),
  day: z.number().int().min(1).max(31),
  minutes: z.number().int().min(5).max(10080),
  /** An interval routine kept to some days and hours. */
  limited: z.boolean(),
  from: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'routine.timeFormat'),
  to: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'routine.timeFormat'),
});
type Form = z.infer<typeof Form>;

/** A run still under way, whose boxes change as it goes. */
const GOING = new Set(['running', 'waiting', 'queued']);

function toSchedule(f: Form): Schedule {
  switch (f.type) {
    case 'hourly':
      return { type: 'hourly', minute: f.minute };
    case 'daily':
    case 'weekdays':
      return { type: f.type, time: f.time };
    case 'weekly':
      return { type: 'weekly', days: f.days.length ? f.days : [1], time: f.time };
    case 'monthly':
      return { type: 'monthly', day: f.day, time: f.time };
    case 'interval': {
      if (!f.limited) return { type: 'interval', minutes: f.minutes };
      const days = f.days.length && f.days.length < 7 ? { days: [...f.days].sort() } : {};
      const hours = f.from < f.to ? { from: f.from, to: f.to } : {};
      return { type: 'interval', minutes: f.minutes, ...days, ...hours };
    }
    case 'cron':
      return { type: 'cron', expr: f.expr.trim() };
    case 'once':
      return { type: 'once', date: f.date, time: f.time };
  }
}

/** Tomorrow on the local calendar, as YYYY-MM-DD: where a one-time date starts. */
function tomorrow(): string {
  const d = new Date(Date.now() + 86_400_000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function fromRoutine(r?: Routine): Form {
  const s = r?.schedule;
  return {
    name: r?.name ?? '',
    prompt: r?.prompt ?? '',
    steps: (r?.steps ?? []).map((x): StepForm =>
      x.kind === 'agent'
        ? {
            id: x.id,
            kind: x.kind,
            prompt: x.prompt,
            model: x.model ?? '',
            bot: x.bot ?? '',
            when: x.when ?? null,
            next: x.next ?? '',
            onError: x.onError ?? '',
          }
        : x.kind === 'approval'
          ? {
              id: x.id,
              kind: x.kind,
              question: x.question,
              timeoutDays: x.timeoutDays,
              when: x.when ?? null,
              next: x.next ?? '',
              onReject: x.onReject ?? '',
            }
          : { ...x, next: x.next ?? '' },
    ),
    type: s?.type ?? 'weekdays',
    time: s && 'time' in s ? s.time : '09:00',
    minute: s?.type === 'hourly' ? s.minute : 0,
    days: s?.type === 'weekly' ? s.days : s?.type === 'interval' && s.days ? s.days : [1, 2, 3, 4, 5],
    day: s?.type === 'monthly' ? s.day : 1,
    minutes: s?.type === 'interval' ? s.minutes : 60,
    expr: s?.type === 'cron' ? s.expr : '0 9 * * 1-5',
    limited: s?.type === 'interval' && (!!s.days || !!s.from),
    from: s?.type === 'interval' && s.from ? s.from : '09:00',
    to: s?.type === 'interval' && s.to ? s.to : '18:00',
    date: s?.type === 'once' ? s.date : tomorrow(),
    missed: r?.missed ?? 'run',
    carryReport: r?.carryReport ?? false,
    reportOnly: r?.reportOnly ?? false,
    inMain: r?.inMain ?? true,
    onStartup: r?.onStartup ?? false,
    watchUrl: r?.watchUrl ?? '',
    slackChannel: r?.slackChannel ?? '',
    slackReaction: r?.slackReaction ?? '',
    webhookFilter: r?.webhookFilter ?? '',
    webhookPost: r?.webhookPost ?? false,
    emailTrigger: r?.emailTrigger ?? false,
    emailFilter: r?.emailFilter ?? '',
    whatsappGroup: r?.whatsappGroup ?? '',
    whatsappPeople: r?.whatsappPeople ?? false,
    tableTrigger: r?.tableTrigger ?? '',
    tableFilter: r?.tableFilter ?? '',
    condition: r?.condition ?? null,
    model: r?.model ?? '',
  };
}

/**
 * A routine to change, or a new one, as a page in place of the bot's chat: the flow gets the
 * width of the window, and changes not saved are asked about before anything replaces the page.
 */
export function RoutinePage({
  botId,
  routine,
  showRuns = false,
}: {
  botId: string;
  routine?: Routine;
  /** Scrolls to the latest runs, for a routine opened to see why a run failed. */
  showRuns?: boolean;
}) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data: bots = [] } = useBots();
  const claude = bots.find((b) => b.id === botId)?.engine !== 'pi';
  const { data: claudeModels = [] } = useClaudeModels(claude);
  const form = useForm<Form>({ resolver: zodResolver(Form), values: fromRoutine(routine) });
  const values = useWatch({ control: form.control }) as Form;
  // The steps as a list or drawn as a flow; both edit the same steps.
  const [view, setView] = useState<'list' | 'flow'>('flow');
  // Where the flow's boxes sit; saved with the routine. The page is drawn anew for each routine,
  // so it starts from that routine's saved places.
  const [layout, setLayout] = useState<FlowLayout | null>(routine?.flowLayout ?? null);
  // The notes written on the flow; saved with the routine as well.
  const [notes, setNotes] = useState<FlowNote[]>(routine?.flowNotes ?? []);
  const notesChanged = useRef(false);
  const writeNotes = (next: FlowNote[]) => {
    notesChanged.current = true;
    setNotes(next);
  };
  // Leaving with changes not saved, from this page or by opening something in its place, asks first.
  // Read while drawing, so the form keeps track of it in either view; the question below reads it
  // again when asked, to see the changes made by then.
  const dirty = form.formState.isDirty;
  useEffect(() => {
    askBeforeLeavingPage(
      () => !(form.formState.isDirty || notesChanged.current) || confirm(t('routine.leaveConfirm')),
    );
    return () => askBeforeLeavingPage(null);
  }, [t, form]);
  // What a box's "Try" hands the rehearsal: its own instruction, and whether it is a step's.
  const [tried, setTried] = useState<{ prompt: string; step: boolean } | null>(null);
  const [trying, setTrying] = useState(false);
  // The rehearsal sits under the canvas: a box's "Try" brings it into sight.
  const rehearsal = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (trying) rehearsal.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [trying, tried]);
  // The Slack field is offered once the server has a Slack app.
  const { data: slack } = useQuery({ queryKey: ['slack-link'], queryFn: api.slackLink });
  // Opening a routine whose latest run failed is seeing it: the bot's mark for it goes out until
  // a run fails again.
  const { data: summaries = [] } = useSummaries();
  const routineId = routine?.id;
  const failed = !!routineId && summaries.some((s) => s.failedRoutines?.includes(routineId));
  useEffect(() => {
    if (failed && routineId) void api.routineFailureSeen(routineId).catch(() => undefined);
  }, [failed, routineId]);
  // The latest run, shown on the flow's boxes; asked again while it goes.
  const { data: runs = [] } = useQuery({
    queryKey: ['routine-runs', routineId],
    queryFn: () => api.routineRuns(routineId!),
    enabled: !!routineId && view === 'flow',
    refetchInterval: (q) => (q.state.data?.[0] && GOING.has(q.state.data[0].status) ? 2000 : false),
  });
  const latestRun = runs[0] ?? null;
  const runNow = useMutation({
    mutationFn: () => api.runRoutine(routine!.id),
    onSuccess: () => {
      toast.success(t('flow.started'));
      void qc.invalidateQueries({ queryKey: ['routine-runs', routine!.id] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const save = useMutation({
    mutationFn: (f: Form) => {
      const body = {
        name: f.name,
        prompt: f.prompt,
        steps: f.steps.map((x) =>
          x.kind === 'agent'
            ? { ...x, prompt: x.prompt.trim(), model: x.model.trim(), bot: x.bot || undefined }
            : x.kind === 'approval'
              ? { ...x, question: x.question.trim() }
              : x.kind === 'notify'
                ? { ...x, text: x.text.trim() }
                : x.kind === 'fetch'
                  ? { ...x, url: x.url.trim() }
                  : x.kind === 'extract'
                    ? x
                    : { ...x, filter: x.filter.trim() },
        ),
        schedule: toSchedule(f),
        missed: f.missed,
        carryReport: f.carryReport,
        reportOnly: f.reportOnly,
        inMain: f.inMain,
        onStartup: f.onStartup,
        watchUrl: f.watchUrl.trim() || null,
        slackChannel: f.slackChannel.trim() || null,
        slackReaction: f.slackReaction.trim(),
        webhookFilter: f.webhookFilter.trim(),
        webhookPost: f.webhookPost,
        emailTrigger: f.emailTrigger,
        emailFilter: f.emailFilter.trim(),
        whatsappGroup: f.whatsappGroup || null,
        whatsappPeople: f.whatsappPeople,
        tableTrigger: f.tableTrigger || null,
        tableFilter: f.tableFilter.trim(),
        condition: f.condition?.checks.length ? f.condition : null,
        model: f.model.trim(),
        flowLayout: layout && keepLayout(layout, ['start', 'prompt', ...f.steps.map((x) => x.id)]),
        flowNotes: notes,
      };
      return routine
        ? api.updateRoutine(routine.id, body)
        : api.createRoutine({ ...body, botId, timezone: settings?.timezone ?? 'Europe/Istanbul' });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['routines'] });
      if (routine) void qc.invalidateQueries({ queryKey: ['routine-revisions', routine.id] });
      useUi.getState().closePage();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: () => api.removeRoutine(routine!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['routines'] });
      useUi.getState().closePage();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const err = form.formState.errors;
  const type = values.type;
  const setSteps = (next: StepForm[]) =>
    form.setValue('steps', next, { shouldDirty: true, shouldValidate: form.formState.isSubmitted });
  /** Puts a version from the history in the form, to be saved as the newest. */
  const restoreVersion = (rev: RoutineRevision) => {
    const how = { shouldDirty: true, shouldValidate: true };
    form.setValue('prompt', rev.prompt, how);
    // A version kept with the instruction alone leaves the rest as the form has it.
    if (rev.full === false || !routine) return;
    const back = fromRoutine({
      ...routine,
      steps: rev.steps ?? [],
      model: rev.model ?? '',
      condition: rev.condition ?? null,
    });
    form.setValue('steps', back.steps, how);
    form.setValue('model', back.model, how);
    form.setValue('condition', back.condition, how);
  };
  /** What else starts the routine, besides its schedule, as the flow's first box says it. */
  const triggers = [
    ...(values.onStartup ? [t('flow.onStartup')] : []),
    ...(routine?.webhookToken ? [t('flow.webhook')] : []),
    ...(values.emailTrigger ? [t('flow.email')] : []),
    ...(values.whatsappGroup || values.whatsappPeople ? [t('flow.whatsapp')] : []),
    ...(values.tableTrigger ? [t('flow.table')] : []),
    ...(values.slackReaction?.trim() ? [t('flow.slackReaction')] : []),
    ...(values.watchUrl?.trim() ? [t('flow.watch')] : []),
    ...(values.condition ? [t('flow.condition')] : []),
  ];
  /** How often it runs, in words, for the flow's first box; nothing while the form cannot say. */
  const scheduleSummary = (() => {
    try {
      return describeSchedule(toSchedule({ ...fromRoutine(), ...values }), locale);
    } catch {
      return undefined;
    }
  })();
  /** When it runs next: worked out from the schedule as it is in the form. */
  const when = (() => {
    if (routine && !routine.enabled)
      return t(routine.pausedReason === 'failures' ? 'flow.switchedOffFailures' : 'flow.paused');
    let next: Date | null = null;
    try {
      next = nextRun(
        toSchedule({ ...fromRoutine(), ...values }),
        routine?.timezone ?? settings?.timezone ?? 'Europe/Istanbul',
        new Date(),
        routine?.lastRunAt ? new Date(routine.lastRunAt) : null,
      );
    } catch {
      next = null;
    }
    return next ? t('flow.nextRun', { when: dayLabel(next.toISOString()) }) : t('flow.noNextRun');
  })();
  const stepErrors = (values.steps ?? []).map((_, i) => {
    const e = err.steps?.[i] as
      | {
          prompt?: { message?: string };
          question?: { message?: string };
          url?: { message?: string };
          fields?: { message?: string };
          when?: { message?: string };
          next?: { message?: string };
          onError?: { message?: string };
          onReject?: { message?: string };
        }
      | undefined;
    return (
      e?.prompt?.message ??
      e?.question?.message ??
      e?.url?.message ??
      e?.fields?.message ??
      e?.when?.message ??
      e?.next?.message ??
      e?.onError?.message ??
      e?.onReject?.message
    );
  });

  /**
   * What else starts the routine and how it runs: under the steps in the list, in a window over the
   * canvas in the flow, so either view sets all of it.
   */
  const settingsFields = (
    <>
      {type !== 'interval' && (
        <Field label={t('routine.missed')}>
          <Select value={values.missed} onValueChange={(v) => form.setValue('missed', v as Form['missed'])}>
            <SelectTrigger className="w-full rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="run">{t('routine.missed.run')}</SelectItem>
              <SelectItem value="skip">{t('routine.missed.skip')}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      )}
      <label className="flex items-start gap-3 rounded-2xl bg-secondary/60 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('routine.reportOnly')}</span>
          <span className="block text-xs text-muted-foreground">{t('routine.reportOnlyHint')}</span>
        </span>
        <Switch
          checked={values.reportOnly}
          onCheckedChange={(v) => form.setValue('reportOnly', v, { shouldDirty: true })}
        />
      </label>
      <label className="flex items-start gap-3 rounded-2xl bg-secondary/60 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('routine.carryReport')}</span>
          <span className="block text-xs text-muted-foreground">{t('routine.carryReportHint')}</span>
        </span>
        <Switch
          checked={values.carryReport}
          onCheckedChange={(v) => form.setValue('carryReport', v, { shouldDirty: true })}
        />
      </label>
      <label className="flex items-start gap-3 rounded-2xl bg-secondary/60 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('routine.inMain')}</span>
          <span className="block text-xs text-muted-foreground">{t('routine.inMainHint')}</span>
        </span>
        <Switch
          checked={values.inMain}
          onCheckedChange={(v) => form.setValue('inMain', v, { shouldDirty: true })}
        />
      </label>
      <label className="flex items-start gap-3 rounded-2xl bg-secondary/60 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('routine.onStartup')}</span>
          <span className="block text-xs text-muted-foreground">{t('routine.onStartupHint')}</span>
        </span>
        <Switch
          checked={values.onStartup}
          onCheckedChange={(v) => form.setValue('onStartup', v, { shouldDirty: true })}
        />
      </label>
      <Field label={t('routine.model')}>
        <Input
          {...form.register('model')}
          list="routine-model-options"
          placeholder={t(claude ? 'routine.modelPlaceholder.claude' : 'routine.modelPlaceholder.pi')}
          className="rounded-xl"
        />
        <datalist id="routine-model-options">
          {claudeModels
            .filter((m) => m.value !== 'default')
            .map((m) => (
              <option key={m.value} value={m.value} label={m.name || undefined} />
            ))}
        </datalist>
        <p className="mt-1 text-xs text-muted-foreground">{t('routine.modelHint')}</p>
      </Field>
      {(slack?.available || !!values.slackChannel) && (
        <Field label={t('routine.slackChannel')} error={err.slackChannel?.message}>
          <Input {...form.register('slackChannel')} placeholder="C0123456789" className="rounded-xl" />
          <p className="mt-1 text-xs text-muted-foreground">{t('routine.slackChannelHint')}</p>
        </Field>
      )}
      {(slack?.available || !!values.slackReaction) && (
        <Field label={t('routine.slackReaction')} error={err.slackReaction?.message}>
          <Input
            {...form.register('slackReaction')}
            placeholder={t('routine.slackReactionPlaceholder')}
            className="rounded-xl"
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('routine.slackReactionHint')}</p>
          {!!values.slackReaction?.trim() && slack?.optionalMissing.includes('reactions:read') && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
              {t('routine.slackReactionNoPermission')}
            </p>
          )}
        </Field>
      )}
      <Field label={t('routine.watchUrl')} error={err.watchUrl?.message}>
        <Input
          {...form.register('watchUrl')}
          placeholder={t('routine.watchUrlPlaceholder')}
          inputMode="url"
          className="rounded-xl"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t('routine.watchUrlHint')}</p>
      </Field>
      <label className="flex items-start gap-3 rounded-2xl bg-secondary/60 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('routine.emailTrigger')}</span>
          <span className="block text-xs text-muted-foreground">{t('routine.emailTriggerHint')}</span>
        </span>
        <Switch
          checked={values.emailTrigger}
          onCheckedChange={(v) => form.setValue('emailTrigger', v, { shouldDirty: true })}
        />
      </label>
      {values.emailTrigger && (
        <Field label={t('routine.emailFilter')}>
          <Textarea
            {...form.register('emailFilter')}
            rows={2}
            placeholder={t('routine.emailFilterPlaceholder')}
            className="rounded-xl font-mono text-xs"
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('routine.emailFilterHint')}</p>
        </Field>
      )}
      <TableFields
        botId={botId}
        table={values.tableTrigger}
        onTable={(v) => form.setValue('tableTrigger', v, { shouldDirty: true })}
        filter={form.register('tableFilter')}
      />
      <WhatsAppFields
        group={values.whatsappGroup}
        people={values.whatsappPeople}
        onGroup={(v) => form.setValue('whatsappGroup', v, { shouldDirty: true })}
        onPeople={(v) => form.setValue('whatsappPeople', v, { shouldDirty: true })}
      />
      <ConditionFields
        botId={botId}
        value={values.condition ?? null}
        onChange={(v) => form.setValue('condition', v, { shouldDirty: true })}
      />
      {routine && <Check routine={routine} />}
      {routine && <Webhook routine={routine} />}
      {routine?.webhookToken && (
        <AppEvents
          routine={routine}
          filter={values.webhookFilter ?? ''}
          onFilter={(v) => form.setValue('webhookFilter', v, { shouldDirty: true })}
        />
      )}
      {routine?.webhookToken && (
        <Field label={t('routine.webhookFilter')}>
          <Textarea
            {...form.register('webhookFilter')}
            rows={2}
            placeholder={t('routine.webhookFilterPlaceholder')}
            className="rounded-xl font-mono text-xs"
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('routine.webhookFilterHint')}</p>
        </Field>
      )}
      {routine?.webhookToken && (
        <label className="flex items-start gap-3 rounded-2xl bg-secondary/60 px-3 py-2">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t('routine.webhookPost')}</span>
            <span className="block text-xs text-muted-foreground">{t('routine.webhookPostHint')}</span>
          </span>
          <Switch
            checked={values.webhookPost}
            onCheckedChange={(v) => form.setValue('webhookPost', v, { shouldDirty: true })}
          />
        </label>
      )}
      {routine && (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1">{t('routine.runCommandHint')}</span>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="rounded-full"
            onClick={async () => {
              const ok = await copyText(runCommand(window.location.origin, routine.id));
              if (ok) toast.success(t('routine.runCommandCopied'));
              else toast.error(t('message.copyFailed'));
            }}
          >
            <Terminal /> {t('routine.copyRunCommand')}
          </Button>
        </div>
      )}
      {routine && <RecentRuns routineId={routine.id} botId={botId} reveal={showRuns} />}
    </>
  );

  return (
    // The bar with the title and buttons stays put; only the form under it scrolls.
    <form
      onSubmit={form.handleSubmit((f) => save.mutate(f))}
      className="flex min-w-0 flex-1 flex-col"
      aria-label={routine ? t('routine.edit') : t('routine.new')}
    >
      <header className="window-drag flex items-center gap-2 border-b px-3 py-3 sm:px-4">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="shrink-0 rounded-full"
          onClick={() => useUi.getState().leavePage()}
          aria-label={t('common.back')}
        >
          <ChevronLeft className="size-5 rtl:-scale-x-100" />
        </Button>
        <RoutineName form={form} name={values.name} />
        <div
          role="group"
          aria-label={t('routine.view')}
          className="inline-flex shrink-0 rounded-xl border p-0.5"
        >
          {(['list', 'flow'] as const).map((v) => (
            <Button
              key={v}
              type="button"
              size="sm"
              variant={view === v ? 'secondary' : 'ghost'}
              className="h-7 rounded-lg px-2.5 text-xs"
              aria-pressed={view === v}
              aria-label={t(`routine.view.${v}`)}
              onClick={() => setView(v)}
            >
              {v === 'list' ? <List className="size-3.5" /> : <Workflow className="size-3.5" />}
              <span className="phone:hidden">{t(`routine.view.${v}`)}</span>
            </Button>
          ))}
        </div>
        {routine && (
          <Button
            type="button"
            variant="ghost"
            className="rounded-full text-destructive"
            onClick={() => remove.mutate()}
          >
            {t('common.delete')}
          </Button>
        )}
        <Button type="submit" className="rounded-full" disabled={save.isPending}>
          {t('common.save')}
        </Button>
      </header>
      {/* Positioned, so the hidden inputs of switches and lists stay inside what scrolls instead of
          stretching the window, which then scrolled the whole app out of place. */}
      <div className="scroll-thin relative min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {/* A list reads best as a narrow column; the flow takes the whole width and the height left. */}
        <div
          className={cn(
            'mx-auto space-y-4 px-4 py-6 sm:px-6',
            view === 'list' ? 'max-w-2xl' : 'flex min-h-full flex-col',
          )}
        >
          {/* No room beside the name on a phone, so its message comes first under the bar. */}
          {err.name?.message && (
            <p role="alert" className="hidden text-sm text-destructive phone:block">
              {t(err.name.message as MessageKey)}
            </p>
          )}
          {!routine && (
            <TemplatePicker
              onPick={(tpl) => {
                const opts = { shouldDirty: true } as const;
                form.setValue('name', tpl.name, opts);
                form.setValue('prompt', tpl.prompt, opts);
                form.setValue('steps', tpl.steps, opts);
                if (tpl.weekly) form.setValue('type', 'weekly', opts);
              }}
            />
          )}
          {view === 'list' ? (
            <>
              <Field label={t('routine.prompt')} error={err.prompt?.message}>
                <Textarea
                  {...form.register('prompt')}
                  rows={4}
                  placeholder={t('routine.promptPlaceholder')}
                  className="scroll-thin max-h-72 overflow-y-auto rounded-xl"
                />
                <MissingApps text={values.prompt ?? ''} botId={botId} />
                {routine && (
                  <PromptHistory
                    routineId={routine.id}
                    current={values.prompt ?? ''}
                    onRestore={restoreVersion}
                  />
                )}
                {routine && <RoutineRehearsal routine={routine} prompt={values.prompt ?? ''} />}
              </Field>
              <StepsEditor
                steps={values.steps ?? []}
                onChange={setSteps}
                errors={stepErrors}
                modelListId="routine-model-options"
                modelPlaceholder={t('routine.stepModelPlaceholder')}
                botId={botId}
              />
              <ScheduleFields form={form} values={values} />
              {settingsFields}
              {routine && <RoutineHealthBlock routine={routine} locked={dirty} />}
            </>
          ) : (
            <>
              <RoutineFlow
                triggers={triggers}
                schedule={<ScheduleFields form={form} values={values} />}
                scheduleSummary={scheduleSummary}
                when={when}
                run={latestRun}
                onRunNow={routine ? () => runNow.mutate() : undefined}
                runBlocked={dirty ? t('flow.saveFirst') : undefined}
                onTry={
                  routine
                    ? (text, step) => {
                        setTried({ prompt: text, step });
                        setTrying(true);
                      }
                    : undefined
                }
                prompt={values.prompt ?? ''}
                onPrompt={(next) =>
                  form.setValue('prompt', next, {
                    shouldDirty: true,
                    shouldValidate: form.formState.isSubmitted,
                  })
                }
                promptError={err.prompt?.message}
                steps={values.steps ?? []}
                onSteps={setSteps}
                errors={stepErrors}
                modelListId="routine-model-options"
                modelPlaceholder={t('routine.stepModelPlaceholder')}
                botId={botId}
                layout={layout}
                onLayout={setLayout}
                notes={notes}
                onNotes={writeNotes}
                promptExtra={<MissingApps text={values.prompt ?? ''} botId={botId} />}
                settings={
                  <>
                    {routine && (
                      <PromptHistory
                        routineId={routine.id}
                        current={values.prompt ?? ''}
                        onRestore={restoreVersion}
                      />
                    )}
                    {settingsFields}
                  </>
                }
                settingsAtStart={showRuns}
                fullScreenBar={
                  <>
                    <h2 className="min-w-0 flex-1 truncate text-base font-semibold">
                      {values.name?.trim() || (routine ? t('routine.edit') : t('routine.new'))}
                    </h2>
                    <Button type="submit" className="rounded-full" disabled={save.isPending}>
                      {t('common.save')}
                    </Button>
                  </>
                }
              />
              {/* Under the canvas, not in its settings: what is wrong with a routine should be in sight. */}
              {routine && <RoutineHealthBlock routine={routine} locked={dirty} />}
              {routine && (
                <div ref={rehearsal}>
                  <RoutineRehearsal
                    routine={routine}
                    prompt={tried?.prompt ?? values.prompt ?? ''}
                    open={trying}
                    onOpenChange={(v) => {
                      setTrying(v);
                      if (!v) setTried(null);
                    }}
                    note={tried?.step ? t('flow.tryStep') : undefined}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </form>
  );
}

/** When the routine runs: the kind of schedule and its times and days, with what that comes to. */
function ScheduleFields({ form, values }: { form: UseFormReturn<Form>; values: Form }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { data: settings } = useSettings();
  const err = form.formState.errors;
  const type = values.type;
  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('routine.when')}>
          <Select value={type} onValueChange={(v) => form.setValue('type', v as Form['type'])}>
            <SelectTrigger className="w-full rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(
                ['daily', 'weekdays', 'weekly', 'monthly', 'hourly', 'interval', 'cron', 'once'] as const
              ).map((v) => (
                <SelectItem key={v} value={v}>
                  {t(`routine.type.${v}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {type === 'once' && (
          <Field label={t('routine.date')} error={err.date?.message}>
            <Input type="date" {...form.register('date')} className="rounded-xl" />
          </Field>
        )}
        {(type === 'daily' ||
          type === 'weekdays' ||
          type === 'weekly' ||
          type === 'monthly' ||
          type === 'once') && (
          <Field label={t('routine.time')} error={err.time?.message}>
            <Input type="time" {...form.register('time')} className="rounded-xl" />
          </Field>
        )}
        {type === 'hourly' && (
          <Field label={t('routine.minute')}>
            <Input
              type="number"
              min={0}
              max={59}
              {...form.register('minute', { valueAsNumber: true })}
              className="rounded-xl"
            />
          </Field>
        )}
        {type === 'interval' && (
          <Field label={t('routine.everyMinutes')} error={err.minutes?.message}>
            <Input
              type="number"
              min={5}
              {...form.register('minutes', { valueAsNumber: true })}
              className="rounded-xl"
            />
          </Field>
        )}
      </div>
      {type === 'cron' && (
        <Field label={t('routine.cronExpr')} error={err.expr?.message}>
          <Input {...form.register('expr')} className="rounded-xl font-mono" spellCheck={false} />
          <p className="mt-1 text-xs text-muted-foreground">{t('routine.cronHint')}</p>
        </Field>
      )}
      {type === 'interval' && (
        <label className="flex items-center gap-3 rounded-2xl bg-secondary/60 px-3 py-2">
          <span className="min-w-0 flex-1 text-sm">{t('routine.limited')}</span>
          <Switch checked={values.limited} onCheckedChange={(v) => form.setValue('limited', v)} />
        </label>
      )}
      {type === 'interval' && values.limited && (
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('routine.from')} error={err.from?.message}>
            <Input type="time" {...form.register('from')} className="rounded-xl" />
          </Field>
          <Field label={t('routine.to')} error={err.to?.message}>
            <Input type="time" {...form.register('to')} className="rounded-xl" />
          </Field>
        </div>
      )}
      {(type === 'weekly' || (type === 'interval' && values.limited)) && (
        <div className="flex gap-1.5">
          {SHORT_DAY_NAMES[locale].map((d, i) => {
            const on = values.days?.includes(i);
            return (
              <button
                type="button"
                key={d}
                onClick={() =>
                  form.setValue('days', on ? values.days.filter((x) => x !== i) : [...(values.days ?? []), i])
                }
                className={cn(
                  'h-9 flex-1 rounded-full text-sm transition-colors',
                  on ? 'bg-primary text-primary-foreground' : 'bg-secondary hover:bg-accent',
                )}
              >
                {d}
              </button>
            );
          })}
        </div>
      )}
      {type === 'monthly' && (
        <Field label={t('routine.dayOfMonth')}>
          <Input
            type="number"
            min={1}
            max={31}
            {...form.register('day', { valueAsNumber: true })}
            className="rounded-xl"
          />
        </Field>
      )}
      <p className="text-sm text-muted-foreground">
        {describeSchedule(toSchedule({ ...fromRoutine(), ...values }), locale)} ·{' '}
        {settings?.timezone ?? 'Europe/Istanbul'}
      </p>
    </>
  );
}

/** The routine's latest runs: when, how each went and why one failed; a run opens its conversation. */
function RecentRuns({ routineId, botId, reveal }: { routineId: string; botId: string; reveal: boolean }) {
  const t = useT();
  const { dayLabel } = useFormat();
  const { data: runs = [] } = useQuery({
    queryKey: ['routine-runs', routineId],
    queryFn: () => api.routineRuns(routineId),
  });
  const ref = useRef<HTMLDivElement>(null);
  const loaded = runs.length > 0;
  useEffect(() => {
    if (reveal && loaded) ref.current?.scrollIntoView({ block: 'nearest' });
  }, [reveal, loaded]);
  if (!runs.length) return null;
  return (
    <div ref={ref} className="space-y-1.5">
      <div className="text-sm font-medium">{t('routine.runs')}</div>
      <ul className="max-h-72 space-y-1 overflow-y-auto rounded-2xl border p-2 text-sm">
        {runs.slice(0, 10).map((r) => (
          <li key={r.id}>
            <button
              type="button"
              disabled={!r.threadId}
              onClick={() => {
                if (!r.threadId) return;
                // Asked once here: the chat and the conversation then open with nothing left to ask.
                const ui = useUi.getState();
                if (!ui.leavePage()) return;
                ui.openChat(botId);
                ui.selectThread(r.threadId);
              }}
              className="flex w-full items-start gap-2 rounded-xl px-2 py-1 text-start enabled:hover:bg-accent"
            >
              <span
                className={cn(
                  'mt-1.5 size-2 shrink-0 rounded-full',
                  r.status === 'done' && 'bg-emerald-500',
                  r.status === 'error' && 'bg-destructive',
                  (r.status === 'running' || r.status === 'waiting') && 'bg-amber-500',
                  (r.status === 'skipped' || r.status === 'queued' || r.status === 'stopped') &&
                    'bg-muted-foreground/40',
                )}
              />
              <span className="min-w-0 flex-1">
                <span className="block">
                  {dayLabel(r.startedAt)} · {t(`routine.run.${r.status}`)}
                </span>
                {r.reason && <span className="block truncate text-xs text-muted-foreground">{r.reason}</span>}
                {/* While the pre-check only watches, the runs it would have skipped say so. */}
                {r.gate?.decision === 'skip' && r.status !== 'skipped' && (
                  <span className="block truncate text-xs text-muted-foreground">
                    {r.gate.reason
                      ? t('routine.gateWouldSkip', { reason: r.gate.reason })
                      : t('routine.gateWouldSkipNoReason')}
                  </span>
                )}
              </span>
            </button>
            <RunSteps run={r} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The routine's name as the page title, changed in place with the pencil beside it, so the form
 * below starts with what the routine does. A new routine opens with the name ready to type.
 */
function RoutineName({ form, name }: { form: UseFormReturn<Form>; name?: string }) {
  const t = useT();
  const error = form.formState.errors.name?.message;
  const [editing, setEditing] = useState(!name?.trim());
  const field = form.register('name');
  const done = () => {
    if (form.getValues('name')?.trim()) setEditing(false);
  };

  // A save turned down for a missing name keeps the box open to type it.
  if (!editing && !error) {
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <h1 className="min-w-0 truncate text-base font-semibold" onDoubleClick={() => setEditing(true)}>
          {name}
        </h1>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-8 shrink-0 rounded-full text-muted-foreground"
          onClick={() => setEditing(true)}
          aria-label={t('routine.rename')}
        >
          <Pencil className="size-3.5" />
        </Button>
      </div>
    );
  }
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2">
      <Input
        {...field}
        autoFocus
        aria-label={t('routine.name')}
        aria-invalid={!!error}
        placeholder={t('routine.namePlaceholder')}
        className="h-9 max-w-md min-w-32 flex-1 rounded-xl text-base font-semibold"
        onBlur={(e) => {
          void field.onBlur(e);
          done();
        }}
        onKeyDown={(e) => {
          // Enter keeps the name instead of saving the whole routine; Escape takes back the typing.
          if (e.key === 'Enter') {
            e.preventDefault();
            done();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            form.resetField('name');
            done();
          }
        }}
      />
      {error && (
        <p role="alert" className="min-w-0 truncate text-sm text-destructive phone:hidden">
          {t(error as MessageKey)}
        </p>
      )}
    </div>
  );
}

export function Field({
  label,
  error,
  children,
}: {
  label: string;
  /** A message key from the form schema, or text as it came. */
  error?: string;
  children: React.ReactNode;
}) {
  const t = useT();
  return (
    <div className="space-y-1.5">
      <Label className="text-sm text-muted-foreground">{label}</Label>
      {children}
      {error && <p className="text-sm text-destructive">{t(error as MessageKey)}</p>}
    </div>
  );
}

/**
 * A command that runs the routine from a script or another service, with some text for the bot.
 * The access key is read from the environment, never written into the command.
 */
export function runCommand(origin: string, routineId: string): string {
  return [
    `curl -X POST '${origin}/api/routines/${routineId}/run'`,
    `  -H "Authorization: Bearer $LEAFBOT_ACCESS_KEY"`,
    `  -H 'Content-Type: application/json'`,
    `  -d '{"payload":"..."}'`,
  ].join(' \\\n');
}

/** No group: a value the select can hold, since an empty one means "nothing chosen" to it. */
const NO_GROUP = 'none';

/**
 * The bot's table whose rows start the routine, and which rows. Only offered once the bot keeps a
 * table; a routine already pointing at one keeps showing it.
 */
function TableFields({
  botId,
  table,
  onTable,
  filter,
}: {
  botId: string;
  table: string;
  onTable(v: string): void;
  filter: UseFormRegisterReturn<'tableFilter'>;
}) {
  const t = useT();
  const { data: tables = [] } = useQuery({
    queryKey: ['tables', botId],
    queryFn: () => api.botTables(botId),
  });
  if (!tables.length && !table) return null;
  return (
    <>
      <Field label={t('routine.tableTrigger')}>
        <Select value={table || NO_TABLE} onValueChange={(v) => onTable(v === NO_TABLE ? '' : v)}>
          <SelectTrigger className="w-full rounded-xl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_TABLE}>{t('routine.tableTriggerNone')}</SelectItem>
            {tables.map((x) => (
              <SelectItem key={x.id} value={x.id}>
                {x.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1 text-xs text-muted-foreground">{t('routine.tableTriggerHint')}</p>
      </Field>
      {table && (
        <Field label={t('routine.tableFilter')}>
          <Textarea
            {...filter}
            rows={2}
            placeholder={t('routine.tableFilterPlaceholder')}
            className="rounded-xl font-mono text-xs"
            spellCheck={false}
          />
          <p className="mt-1 text-xs text-muted-foreground">{t('routine.tableFilterHint')}</p>
        </Field>
      )}
    </>
  );
}

/** The select's value for "no table": a select item cannot have an empty value. */
const NO_TABLE = 'none';

/**
 * What on WhatsApp also starts the routine: people writing to the account, and one group. Offered
 * when WhatsApp is connected, or when the routine already reads it; only the person who linked
 * WhatsApp gets its list of groups.
 */
function WhatsAppFields({
  group: value,
  people,
  onGroup: onChange,
  onPeople,
}: {
  group: string;
  people: boolean;
  onGroup(v: string): void;
  onPeople(v: boolean): void;
}) {
  const t = useT();
  const { data: wa } = useQuery({ queryKey: ['whatsapp'], queryFn: api.whatsapp });
  const connected = wa?.state === 'connected';
  const groups = useQuery({
    queryKey: ['whatsapp-groups'],
    queryFn: api.whatsappGroups,
    enabled: connected,
    retry: false,
  });
  if (!connected && !value && !people) return null;
  const list = groups.data ?? [];
  // A followed group the list does not show (WhatsApp is off, or the account left it) keeps its place.
  const known = !value || list.some((g) => g.id === value);
  return (
    <>
      <label className="flex items-start gap-3 rounded-2xl bg-secondary/60 px-3 py-2">
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium">{t('routine.whatsappPeople')}</span>
          <span className="block text-xs text-muted-foreground">{t('routine.whatsappPeopleHint')}</span>
        </span>
        <Switch checked={people} onCheckedChange={onPeople} />
      </label>
      <Field label={t('routine.whatsappGroup')}>
        <Select value={value || NO_GROUP} onValueChange={(v) => onChange(v === NO_GROUP ? '' : v)}>
          <SelectTrigger className="w-full rounded-xl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_GROUP}>{t('routine.whatsappGroupNone')}</SelectItem>
            {!known && <SelectItem value={value}>{t('routine.whatsappGroupUnknown')}</SelectItem>}
            {list.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="mt-1 text-xs text-muted-foreground">
          {groups.error ? (groups.error as Error).message : t('routine.whatsappGroupHint')}
        </p>
      </Field>
    </>
  );
}

/**
 * The app tool a routine calls before each run (bots set it up when asked to act on an app event);
 * here the person sees which, with what, and can remove it.
 */
function Check({ routine: given }: { routine: Routine }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: routines } = useRoutines();
  const routine = routines?.find((r) => r.id === given.id) ?? given;
  const { data: connections = [] } = useConnections();
  const remove = useMutation({
    mutationFn: () => api.updateRoutine(routine.id, { check: null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routines'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const check = routine.check;
  if (!check) {
    return <p className="px-1 text-xs text-muted-foreground">{t('routine.checkHint')}</p>;
  }
  const app = connections.find((c) => c.id === check.connectionId)?.name ?? check.connectionId;
  const args = Object.keys(check.args).length ? JSON.stringify(check.args) : null;
  return (
    <div className="space-y-1 rounded-2xl bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">{t('routine.checkOn', { app, tool: check.tool })}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="rounded-full"
          disabled={remove.isPending}
          onClick={() => remove.mutate()}
        >
          {t('routine.checkRemove')}
        </Button>
      </div>
      {args && <code className="block break-all font-mono text-[11px]">{args}</code>}
    </div>
  );
}

/** The routine's secret address for other services, with buttons to make, copy, renew or remove it. */
function Webhook({ routine: given }: { routine: Routine }) {
  const t = useT();
  const qc = useQueryClient();
  // The dialog holds the routine as it was opened; the address comes from the latest list.
  const { data: routines } = useRoutines();
  const routine = routines?.find((r) => r.id === given.id) ?? given;
  const set = useMutation({
    mutationFn: (on: boolean) => (on ? api.enableWebhook(routine.id) : api.disableWebhook(routine.id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routines'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const { data: info } = useInfo();
  const base = info?.publicUrl ?? window.location.origin;
  const url = routine.webhookToken
    ? `${base}/api/hooks/routines/${routine.id}/${routine.webhookToken}`
    : null;
  // An address on this computer only (the desktop app, a server not put online) cannot be reached
  // by a service on the internet; the person is told rather than left to find out.
  const localOnly = !!url && isLoopback(new URL(base).hostname);
  return (
    <div className="space-y-2 rounded-2xl bg-secondary/60 px-3 py-2 text-xs text-muted-foreground">
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1">{t(url ? 'routine.webhookOn' : 'routine.webhookHint')}</span>
        {url ? (
          <>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => set.mutate(true)}
            >
              {t('routine.webhookRenew')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="rounded-full"
              onClick={() => set.mutate(false)}
            >
              {t('common.remove')}
            </Button>
          </>
        ) : (
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="rounded-full"
            onClick={() => set.mutate(true)}
          >
            <WebhookIcon /> {t('routine.webhookCreate')}
          </Button>
        )}
      </div>
      {url && (
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg bg-background px-2 py-1 font-mono text-[11px]">
            {url}
          </code>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="rounded-full"
            onClick={async () => {
              if (await copyText(url)) toast.success(t('routine.webhookCopied'));
              else toast.error(t('message.copyFailed'));
            }}
          >
            {t('message.copy')}
          </Button>
        </div>
      )}
      {localOnly && <p>{t('routine.webhookLocalOnly')}</p>}
      {url && routine.webhookToken && (
        <details className="rounded-xl bg-background px-2 py-1">
          <summary className="cursor-pointer select-none">{t('routine.github')}</summary>
          <ol className="mt-1 list-decimal space-y-1 ps-5">
            <li>{t('routine.githubStep1')}</li>
            <li>{t('routine.githubStep2')}</li>
            <li>
              {t('routine.githubStep3')}{' '}
              <button
                type="button"
                className="underline"
                onClick={async () => {
                  if (await copyText(routine.webhookToken!)) toast.success(t('routine.githubSecretCopied'));
                  else toast.error(t('message.copyFailed'));
                }}
              >
                {t('routine.githubCopySecret')}
              </button>
            </li>
            <li>{t('routine.githubStep4')}</li>
          </ol>
        </details>
      )}
    </div>
  );
}

/**
 * Picks an app and one of its events, which writes the webhook filter for that event, with what to
 * set in the app, and the signing secret for apps that make their own.
 */
export function AppEvents({
  routine: given,
  filter,
  onFilter,
}: {
  routine: Routine;
  filter: string;
  onFilter: (filter: string) => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: routines } = useRoutines();
  const routine = routines?.find((r) => r.id === given.id) ?? given;
  const picked = appEventOf(filter);
  const source = APP_EVENT_SOURCES.find((s) => s.app === picked?.app);
  const [secret, setSecret] = useState('');
  const save = useMutation({
    mutationFn: (value: string | null) => api.setWebhookSecret(routine.id, value),
    onSuccess: (_r, value) => {
      setSecret('');
      toast.success(t(value ? 'routine.appSecretSaved' : 'routine.appSecretRemoved'));
      return qc.invalidateQueries({ queryKey: ['routines'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const pickApp = (app: string) => {
    if (app === 'any') return onFilter('');
    const first = APP_EVENT_SOURCES.find((s) => s.app === app)?.events[0];
    if (first) onFilter(appEventFilter(app, first.id) ?? '');
  };
  const showSecret = (!!source && appMakesSecret(source.app)) || !!routine.webhookSecretSet;
  return (
    <div className="space-y-2 rounded-2xl bg-secondary/60 px-3 py-2">
      <span className="block text-sm font-medium">{t('routine.appEvent')}</span>
      <div className="grid gap-2 sm:grid-cols-2">
        <Select value={picked?.app ?? (filter.trim() ? 'own' : 'any')} onValueChange={pickApp}>
          <SelectTrigger className="w-full rounded-xl" aria-label={t('routine.appEventApp')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">{t('routine.appEventAny')}</SelectItem>
            {!picked && filter.trim() && <SelectItem value="own">{t('routine.appEventOwn')}</SelectItem>}
            {APP_EVENT_SOURCES.map((s) => (
              <SelectItem key={s.app} value={s.app}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {source && picked && (
          <Select value={picked.event} onValueChange={(e) => onFilter(appEventFilter(source.app, e) ?? '')}>
            <SelectTrigger className="w-full rounded-xl" aria-label={t('routine.appEventEvent')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {source.events.map((e) => (
                <SelectItem key={e.id} value={e.id}>
                  {t(`appEvent.${source.app}.${e.id}` as MessageKey)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('routine.appEventHint')}</p>
      {source && source.app !== 'github' && (
        <p className="text-xs text-muted-foreground">
          {t(`routine.appSetup.${source.app}` as MessageKey)}
          {!appMakesSecret(source.app) && (
            <>
              {' '}
              <button
                type="button"
                className="underline"
                onClick={async () => {
                  if (routine.webhookToken && (await copyText(routine.webhookToken)))
                    toast.success(t('routine.githubSecretCopied'));
                  else toast.error(t('message.copyFailed'));
                }}
              >
                {t('routine.githubCopySecret')}
              </button>
            </>
          )}
        </p>
      )}
      {showSecret && (
        <div className="space-y-1">
          <Label className="text-xs">
            {source ? t('routine.appSecret', { app: source.name }) : t('routine.appSecretAny')}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={t('routine.appSecretPlaceholder')}
              className="rounded-xl font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="secondary"
              className="rounded-full"
              disabled={secret.trim().length < 8 || save.isPending}
              onClick={() => save.mutate(secret.trim())}
            >
              {t('common.save')}
            </Button>
            {routine.webhookSecretSet && (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="rounded-full"
                disabled={save.isPending}
                onClick={() => save.mutate(null)}
              >
                {t('common.remove')}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t(routine.webhookSecretSet ? 'routine.appSecretSet' : 'routine.appSecretUnset')}
          </p>
        </div>
      )}
    </div>
  );
}

/** A name that only this computer answers to. */
export function isLoopback(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
}
