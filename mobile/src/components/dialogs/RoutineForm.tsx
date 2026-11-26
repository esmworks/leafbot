import {
  describeSchedule,
  fillInputs,
  filterVars,
  parseCron,
  parseFields,
  ROUTINE_VAR_MAX,
  ROUTINE_VARS_MAX,
  SHORT_DAY_NAMES,
  type Routine,
  type RoutineRun,
  type Schedule,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import Feather from '@expo/vector-icons/Feather';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AreaBox, FormField, SaveButton, TextBox } from '@/components/dialogs/common';
import { Rehearsal } from '@/components/dialogs/Rehearsal';
import { RoutineHealthSection } from '@/components/dialogs/RoutineHealthSection';
import { isLoopback, runCommand, TIME, tomorrow } from '@/components/dialogs/model';
import { confirm, toast, toastError } from '@/components/overlay';
import { Empty, Loading, Note, PillButton, Page, Row, Section, SwitchRow, back } from '@/components/page';
import { Chip, ChipRow, ChoiceRow, Hint, Pad, Rows } from '@/components/settings/common/controls';
import { locale, t, type MessageKey } from '@/i18n';
import { formatters } from '@/lib/format';
import { nav } from '@/lib/nav';
import {
  useBots,
  useClaudeModels,
  useConnections,
  useInfo,
  useRoutines,
  useSettings,
  useSummaries,
} from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';
import { ordered } from '@/lib/bots';

const fmt = formatters(locale, t);

const TYPES = [
  'daily',
  'weekdays',
  'weekly',
  'monthly',
  'hourly',
  'interval',
  'cron',
  'once',
  'unscheduled',
] as const;
type Type = (typeof TYPES)[number];

interface Form {
  name: string;
  prompt: string;
  type: Type;
  expr: string;
  date: string;
  missed: 'run' | 'skip';
  carryReport: boolean;
  reportOnly: boolean;
  inMain: boolean;
  onStartup: boolean;
  webhookFilter: string;
  webhookPost: boolean;
  model: string;
  watchUrl: string;
  time: string;
  minute: string;
  days: number[];
  day: string;
  minutes: string;
  /** An interval routine kept to some days and hours. */
  limited: boolean;
  from: string;
  to: string;
  /** Its inputs as rows: a name its texts write as {{name}}, and the value a run takes by default. */
  inputs: InputRow[];
}

type InputRow = { name: string; value: string };

const INPUT_NAME = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;

const int = (s: string, min: number, max: number, fallback: number) => {
  const n = Math.round(Number(s));
  return Number.isFinite(n) && s.trim() ? Math.min(max, Math.max(min, n)) : fallback;
};

function toSchedule(f: Form): Schedule {
  switch (f.type) {
    case 'hourly':
      return { type: 'hourly', minute: int(f.minute, 0, 59, 0) };
    case 'daily':
    case 'weekdays':
      return { type: f.type, time: f.time };
    case 'weekly':
      return { type: 'weekly', days: f.days.length ? f.days : [1], time: f.time };
    case 'monthly':
      return { type: 'monthly', day: int(f.day, 1, 31, 1), time: f.time };
    case 'interval': {
      const minutes = int(f.minutes, 5, 10080, 60);
      if (!f.limited) return { type: 'interval', minutes };
      const days = f.days.length && f.days.length < 7 ? { days: [...f.days].sort() } : {};
      const hours = f.from < f.to ? { from: f.from, to: f.to } : {};
      return { type: 'interval', minutes, ...days, ...hours };
    }
    case 'cron':
      return { type: 'cron', expr: f.expr.trim() };
    case 'once':
      return { type: 'once', date: f.date, time: f.time };
    case 'unscheduled':
      return { type: 'unscheduled' };
  }
}

function fromRoutine(r?: Routine): Form {
  const s = r?.schedule;
  return {
    name: r?.name ?? '',
    prompt: r?.prompt ?? '',
    type: s?.type ?? 'weekdays',
    time: s && 'time' in s ? s.time : '09:00',
    minute: String(s?.type === 'hourly' ? s.minute : 0),
    days: s?.type === 'weekly' ? s.days : s?.type === 'interval' && s.days ? s.days : [1, 2, 3, 4, 5],
    day: String(s?.type === 'monthly' ? s.day : 1),
    minutes: String(s?.type === 'interval' ? s.minutes : 60),
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
    webhookFilter: r?.webhookFilter ?? '',
    webhookPost: r?.webhookPost ?? false,
    model: r?.model ?? '',
    inputs: Object.entries(r?.inputs ?? {}).map(([name, value]) => ({ name, value })),
  };
}

/** What each of the routine's steps writes, where `{{name}}` may stand. */
function stepTexts(s: NonNullable<Routine['steps']>[number]): string[] {
  switch (s.kind) {
    case 'agent':
      return [s.prompt];
    case 'approval':
      return [s.question];
    case 'notify':
      return [s.text];
    case 'wait':
      return [s.filter ?? ''];
    case 'fetch':
      return [s.url];
    default:
      return [];
  }
}

/**
 * The names the instruction and the steps write as `{{name}}` that nothing gives yet: neither an
 * input nor a step before that takes values from JSON. Offered for adding as inputs.
 */
function namesWanted(prompt: string, steps: Routine['steps'], inputs: readonly InputRow[]): string[] {
  const have = new Set(inputs.map((i) => i.name.trim()));
  const wanted: string[] = [];
  const add = (text: string) => {
    for (const n of filterVars(text)) if (!have.has(n) && !wanted.includes(n)) wanted.push(n);
  };
  add(prompt);
  for (const s of steps ?? []) {
    for (const text of stepTexts(s)) add(text);
    if (s.kind === 'extract') for (const f of parseFields(s.fields) ?? []) have.add(f.name);
  }
  return wanted;
}

/** The parts of a routine set in the app on the computer, which this page shows but does not change. */
function setElsewhere(r: Routine): string[] {
  const parts: string[] = [];
  if (r.steps?.length) parts.push(`${t('routine.steps')} (${r.steps.length})`);
  if (r.condition) parts.push(t('routine.condition'));
  if (r.emailTrigger) parts.push(t('routine.emailTrigger'));
  if (r.whatsappGroup) parts.push(t('routine.whatsappGroup'));
  if (r.whatsappPeople) parts.push(t('routine.whatsappPeople'));
  if (r.tableTrigger) parts.push(t('routine.tableTrigger'));
  if (r.slackChannel) parts.push(t('routine.slackChannel'));
  if (r.slackReaction) parts.push(t('routine.slackReaction'));
  return parts;
}

type Errors = Partial<Record<keyof Form, MessageKey>>;

function validate(f: Form): Errors {
  const e: Errors = {};
  if (!f.name.trim()) e.name = 'routine.nameRequired';
  if (!f.prompt.trim()) e.prompt = 'routine.promptRequired';
  const timed = ['daily', 'weekdays', 'weekly', 'monthly', 'once'].includes(f.type);
  if (timed && !TIME.test(f.time)) e.time = 'routine.timeFormat';
  if (f.type === 'cron' && parseCron(f.expr.trim()) === null) e.expr = 'routine.cronInvalid';
  if (f.type === 'once' && !/^\d{4}-\d{2}-\d{2}$/.test(f.date)) e.date = 'routine.dateFormat';
  if (f.type === 'interval' && f.limited) {
    if (!TIME.test(f.from)) e.from = 'routine.timeFormat';
    if (!TIME.test(f.to)) e.to = 'routine.timeFormat';
  }
  if (!/^(https:\/\/\S+)?$/.test(f.watchUrl.trim())) e.watchUrl = 'routine.watchUrlInvalid';
  if (inputProblems(f.inputs).some(Boolean)) e.inputs = 'routine.inputNameInvalid';
  return e;
}

/** What is wrong with each input row's name, by row. */
function inputProblems(rows: readonly InputRow[]): (MessageKey | undefined)[] {
  return rows.map((r, i) =>
    !INPUT_NAME.test(r.name.trim())
      ? 'routine.inputNameInvalid'
      : rows.findIndex((x) => x.name.trim() === r.name.trim()) !== i
        ? 'routine.inputNameTwice'
        : undefined,
  );
}

/** Creates a routine for `botId` (a bot is asked for when none is given), or edits `routineId`. */
export function RoutineEditor({
  botId,
  routineId,
  showRuns = false,
}: {
  botId?: string;
  routineId?: string;
  /** Opens at its latest runs, for a routine opened to see why a run failed. */
  showRuns?: boolean;
}) {
  const routines = useRoutines();
  const bots = useBots();
  if (routines.isLoading || bots.isLoading) {
    return (
      <Page title={t('routine.new')}>
        <Loading />
      </Page>
    );
  }
  const routine = routineId ? routines.data?.find((r) => r.id === routineId) : undefined;
  if (routineId && !routine) {
    return (
      <Page title={t('routine.edit')}>
        <Empty icon="alert-circle" text={t('dialogs.routineNotFound')} />
      </Page>
    );
  }
  return (
    <RoutinePage
      key={routine?.id ?? 'new'}
      routine={routine}
      initialBotId={routine?.botId ?? botId}
      showRuns={showRuns}
    />
  );
}

function RoutinePage({
  routine,
  initialBotId,
  showRuns,
}: {
  routine?: Routine;
  initialBotId?: string;
  showRuns: boolean;
}) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data: bots = [] } = useBots();
  const [botId, setBotId] = useState(initialBotId ?? '');
  const claude = bots.find((b) => b.id === botId)?.engine !== 'pi';
  const { data: claudeModels = [] } = useClaudeModels(claude);
  const start = useMemo(() => fromRoutine(routine), [routine]);
  const [v, setV] = useState<Form>(start);
  const [enabled, setEnabled] = useState(routine?.enabled ?? true);
  const [tried, setTried] = useState(false);
  // Opening a routine whose latest run failed is seeing it: the bot's mark for it goes out until
  // a run fails again.
  const { data: summaries = [] } = useSummaries();
  const routineId = routine?.id;
  const failed = !!routineId && summaries.some((s) => s.failedRoutines?.includes(routineId));
  useEffect(() => {
    if (failed && routineId) void api.routineFailureSeen(routineId).catch(() => undefined);
  }, [api, failed, routineId]);
  const set = <K extends keyof Form>(k: K, val: Form[K]) => setV((f) => ({ ...f, [k]: val }));
  const errors = validate(v);
  const err = (k: keyof Form) => (tried ? errors[k] : undefined);
  const dirty =
    JSON.stringify(v) !== JSON.stringify(start) ||
    enabled !== (routine?.enabled ?? true) ||
    botId !== (initialBotId ?? '');
  const timezone = settings?.timezone ?? 'Europe/Istanbul';
  const type = v.type;

  const invalidate = () => qc.invalidateQueries({ queryKey: ['routines', origin] });
  const save = useMutation({
    mutationFn: () => {
      const body = {
        name: v.name.trim(),
        prompt: v.prompt.trim(),
        schedule: toSchedule(v),
        enabled,
        missed: v.missed,
        carryReport: v.carryReport,
        reportOnly: v.reportOnly,
        inMain: v.inMain,
        onStartup: v.onStartup,
        watchUrl: v.watchUrl.trim() || null,
        webhookFilter: v.webhookFilter.trim(),
        webhookPost: v.webhookPost,
        model: v.model.trim(),
        // An older server has no inputs; it is sent them only once the person gives some.
        ...(routine?.inputs || v.inputs.length
          ? { inputs: Object.fromEntries(v.inputs.map((i) => [i.name.trim(), i.value])) }
          : {}),
      };
      return routine ? api.updateRoutine(routine.id, body) : api.createRoutine({ ...body, botId, timezone });
    },
    onSuccess: () => {
      void invalidate();
      back();
    },
    onError: toastError,
  });
  const remove = useMutation({
    mutationFn: () => api.removeRoutine(routine!.id),
    onSuccess: () => {
      void invalidate();
      back();
    },
    onError: toastError,
  });
  // A routine with inputs asks for this run's values first, with its usual ones filled in.
  const [asking, setAsking] = useState<Record<string, string> | null>(null);
  const runNow = useMutation({
    mutationFn: (inputs?: Record<string, string>) => api.runRoutine(routine!.id, inputs),
    onSuccess: (done) => {
      setAsking(null);
      toast(done?.status === 'skipped' ? (done.reason ?? t('panel.skipped')) : t('panel.routineStarted'));
      void invalidate();
      void qc.invalidateQueries({ queryKey: ['routine-runs', origin, routine!.id] });
    },
    onError: toastError,
  });

  const submit = () => {
    setTried(true);
    if (!botId) return toast(t('dialogs.routineBotRequired'), { tone: 'error' });
    if (Object.keys(errors).length) return;
    save.mutate();
  };
  const leave = async () => {
    if (
      dirty &&
      !(await confirm({
        title: t('bot.discardConfirm'),
        confirmLabel: t('dialogs.discard'),
        destructive: true,
      }))
    )
      return;
    back();
  };
  const del = async () => {
    if (
      await confirm({
        title: t('dialogs.routineDeleteConfirm'),
        confirmLabel: t('common.delete'),
        destructive: true,
      })
    )
      remove.mutate();
  };

  let preview = '';
  try {
    preview = describeSchedule(toSchedule(v), locale);
  } catch {
    preview = '';
  }

  return (
    <Page
      title={routine ? t('routine.edit') : t('routine.new')}
      onBack={() => void leave()}
      right={<SaveButton label={t('common.save')} onPress={submit} busy={save.isPending} />}
    >
      {/* Opened to see why a run failed: its runs come first. */}
      {routine && showRuns ? <RecentRuns routineId={routine.id} botId={routine.botId} /> : null}
      {!initialBotId ? (
        <Section>
          <ChoiceRow
            label={t('panel.bot')}
            value={botId}
            placeholder={t('dialogs.routineBotRequired')}
            options={ordered(bots).map((b) => ({ value: b.id, label: b.name }))}
            onChange={setBotId}
          />
        </Section>
      ) : null}

      <FormField label={t('routine.name')} error={err('name')}>
        <TextBox
          value={v.name}
          onChangeText={(x) => set('name', x)}
          maxLength={80}
          placeholder={t('routine.namePlaceholder')}
          invalid={!!err('name')}
        />
      </FormField>
      <FormField label={t('routine.prompt')} error={err('prompt')}>
        <AreaBox
          value={v.prompt}
          onChangeText={(x) => set('prompt', x)}
          maxLength={20_000}
          placeholder={t('routine.promptPlaceholder')}
          invalid={!!err('prompt')}
        />
      </FormField>

      {routine && setElsewhere(routine).length ? (
        <Note>{t('routine.setElsewhere', { parts: setElsewhere(routine).join(', ') })}</Note>
      ) : null}

      <InputsSection
        rows={v.inputs}
        onChange={(next) => set('inputs', next)}
        wanted={namesWanted(v.prompt, routine?.steps, v.inputs)}
        problems={tried ? inputProblems(v.inputs) : []}
      />

      {/* A rehearsal reads the instruction as a run would, with the inputs' usual values. */}
      {routine ? (
        <Rehearsal
          routine={routine}
          prompt={fillInputs(v.prompt, Object.fromEntries(v.inputs.map((i) => [i.name.trim(), i.value])))}
        />
      ) : null}

      <Section>
        <Rows>
          <ChoiceRow
            label={t('routine.when')}
            value={type}
            options={TYPES.map((x) => ({ value: x, label: t(`routine.type.${x}`) }))}
            onChange={(x) => set('type', x)}
          />
          {type === 'once' ? (
            <Pad>
              <FormField label={t('routine.date')} error={err('date')} hint={t('dialogs.dateHint')}>
                <TextBox
                  value={v.date}
                  onChangeText={(x) => set('date', x.trim())}
                  maxLength={10}
                  keyboardType="numbers-and-punctuation"
                  invalid={!!err('date')}
                />
              </FormField>
            </Pad>
          ) : null}
          {['daily', 'weekdays', 'weekly', 'monthly', 'once'].includes(type) ? (
            <Pad>
              <FormField label={t('routine.time')} error={err('time')} hint={t('dialogs.timeHint')}>
                <TextBox
                  value={v.time}
                  onChangeText={(x) => set('time', x.trim())}
                  maxLength={5}
                  keyboardType="numbers-and-punctuation"
                  invalid={!!err('time')}
                />
              </FormField>
            </Pad>
          ) : null}
          {type === 'hourly' ? (
            <Pad>
              <FormField label={t('routine.minute')}>
                <TextBox
                  value={v.minute}
                  onChangeText={(x) => set('minute', x.replace(/\D/g, ''))}
                  maxLength={2}
                  keyboardType="number-pad"
                />
              </FormField>
            </Pad>
          ) : null}
          {type === 'interval' ? (
            <Pad>
              <FormField label={t('routine.everyMinutes')}>
                <TextBox
                  value={v.minutes}
                  onChangeText={(x) => set('minutes', x.replace(/\D/g, ''))}
                  maxLength={5}
                  keyboardType="number-pad"
                />
              </FormField>
            </Pad>
          ) : null}
          {type === 'cron' ? (
            <Pad>
              <FormField label={t('routine.cronExpr')} error={err('expr')} hint={t('routine.cronHint')}>
                <TextBox
                  value={v.expr}
                  onChangeText={(x) => set('expr', x)}
                  autoCapitalize="none"
                  autoCorrect={false}
                  spellCheck={false}
                  invalid={!!err('expr')}
                />
              </FormField>
            </Pad>
          ) : null}
          {type === 'interval' ? (
            <SwitchRow label={t('routine.limited')} value={v.limited} onChange={(on) => set('limited', on)} />
          ) : null}
          {type === 'interval' && v.limited ? (
            <Pad>
              <FormField label={t('routine.from')} error={err('from')}>
                <TextBox
                  value={v.from}
                  onChangeText={(x) => set('from', x.trim())}
                  maxLength={5}
                  keyboardType="numbers-and-punctuation"
                  invalid={!!err('from')}
                />
              </FormField>
              <FormField label={t('routine.to')} error={err('to')}>
                <TextBox
                  value={v.to}
                  onChangeText={(x) => set('to', x.trim())}
                  maxLength={5}
                  keyboardType="numbers-and-punctuation"
                  invalid={!!err('to')}
                />
              </FormField>
            </Pad>
          ) : null}
          {type === 'weekly' || (type === 'interval' && v.limited) ? (
            <Pad>
              <ChipRow>
                {SHORT_DAY_NAMES[locale].map((d, i) => (
                  <Chip
                    key={d}
                    on={v.days.includes(i)}
                    label={d}
                    onPress={() =>
                      set('days', v.days.includes(i) ? v.days.filter((x) => x !== i) : [...v.days, i])
                    }
                  />
                ))}
              </ChipRow>
            </Pad>
          ) : null}
          {type === 'monthly' ? (
            <Pad>
              <FormField label={t('routine.dayOfMonth')}>
                <TextBox
                  value={v.day}
                  onChangeText={(x) => set('day', x.replace(/\D/g, ''))}
                  maxLength={2}
                  keyboardType="number-pad"
                />
              </FormField>
            </Pad>
          ) : null}
          <Pad>
            <Hint>{`${preview} · ${timezone}`}</Hint>
          </Pad>
          {type !== 'interval' ? (
            <ChoiceRow
              label={t('routine.missed')}
              value={v.missed}
              options={[
                { value: 'run', label: t('routine.missed.run') },
                { value: 'skip', label: t('routine.missed.skip') },
              ]}
              onChange={(m) => set('missed', m)}
            />
          ) : null}
        </Rows>
      </Section>

      <Section>
        <Rows>
          {routine ? (
            <SwitchRow
              label={t('dialogs.routineEnabled')}
              detail={t('dialogs.routineEnabledHint')}
              value={enabled}
              onChange={setEnabled}
            />
          ) : null}
          <SwitchRow
            label={t('routine.reportOnly')}
            detail={t('routine.reportOnlyHint')}
            value={v.reportOnly}
            onChange={(on) => set('reportOnly', on)}
          />
          <SwitchRow
            label={t('routine.carryReport')}
            detail={t('routine.carryReportHint')}
            value={v.carryReport}
            onChange={(on) => set('carryReport', on)}
          />
          <SwitchRow
            label={t('routine.inMain')}
            detail={t('routine.inMainHint')}
            value={v.inMain}
            onChange={(on) => set('inMain', on)}
          />
          <SwitchRow
            label={t('routine.onStartup')}
            detail={t('routine.onStartupHint')}
            value={v.onStartup}
            onChange={(on) => set('onStartup', on)}
          />
        </Rows>
      </Section>

      <FormField label={t('routine.model')} hint={t('routine.modelHint')}>
        <TextBox
          value={v.model}
          onChangeText={(x) => set('model', x)}
          maxLength={200}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t(claude ? 'routine.modelPlaceholder.claude' : 'routine.modelPlaceholder.pi')}
        />
        {claude && claudeModels.some((m) => m.value !== 'default') ? (
          <ChipRow>
            {claudeModels
              .filter((m) => m.value !== 'default')
              .map((m) => (
                <Chip
                  key={m.value}
                  on={v.model === m.value}
                  label={m.value}
                  onPress={() => set('model', m.value)}
                />
              ))}
          </ChipRow>
        ) : null}
      </FormField>

      <FormField label={t('routine.watchUrl')} error={err('watchUrl')} hint={t('routine.watchUrlHint')}>
        <TextBox
          value={v.watchUrl}
          onChangeText={(x) => set('watchUrl', x)}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          placeholder={t('routine.watchUrlPlaceholder')}
          invalid={!!err('watchUrl')}
        />
      </FormField>

      {routine ? <Check routine={routine} /> : null}
      {routine ? <Webhook routine={routine} /> : null}
      {routine?.webhookToken ? (
        <>
          <FormField label={t('routine.webhookFilter')} hint={t('routine.webhookFilterHint')}>
            <AreaBox
              value={v.webhookFilter}
              onChangeText={(x) => set('webhookFilter', x)}
              maxLength={2000}
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              placeholder={t('routine.webhookFilterPlaceholder')}
            />
          </FormField>
          <Section>
            <SwitchRow
              label={t('routine.webhookPost')}
              detail={t('routine.webhookPostHint')}
              value={v.webhookPost}
              onChange={(on) => set('webhookPost', on)}
            />
          </Section>
        </>
      ) : null}

      {routine ? (
        <Section footer={t('routine.runCommandHint')}>
          <Rows>
            <Row
              icon="play"
              label={t('panel.runNow')}
              onPress={() =>
                Object.keys(routine.inputs ?? {}).length
                  ? setAsking({ ...routine.inputs })
                  : runNow.mutate(undefined)
              }
              busy={runNow.isPending && !asking}
              chevron={false}
            />
            {asking ? (
              <Pad>
                <Hint>{`${t('routine.runWith')}. ${t('routine.runWithHint')}`}</Hint>
                {Object.keys(asking).map((name) => (
                  <FormField key={name} label={name}>
                    <TextBox
                      value={asking[name] ?? ''}
                      maxLength={ROUTINE_VAR_MAX}
                      onChangeText={(x) => setAsking({ ...asking, [name]: x })}
                    />
                  </FormField>
                ))}
                <View style={styles.buttons}>
                  <PillButton label={t('common.cancel')} variant="ghost" onPress={() => setAsking(null)} />
                  <PillButton
                    icon="play"
                    label={t('panel.runNow')}
                    variant="primary"
                    busy={runNow.isPending}
                    onPress={() => runNow.mutate(asking)}
                  />
                </View>
              </Pad>
            ) : null}
            <Row
              icon="terminal"
              label={t('routine.copyRunCommand')}
              chevron={false}
              onPress={() => {
                void Clipboard.setStringAsync(runCommand(origin ?? '', routine.id)).then(
                  () => toast(t('routine.runCommandCopied')),
                  () => toast(t('message.copyFailed'), { tone: 'error' }),
                );
              }}
            />
          </Rows>
        </Section>
      ) : null}

      {routine ? <RoutineHealthSection routine={routine} locked={dirty} /> : null}
      {routine && !showRuns ? <RecentRuns routineId={routine.id} botId={routine.botId} /> : null}

      {routine ? (
        <Section>
          <Row
            icon="trash-2"
            label={t('common.delete')}
            destructive
            chevron={false}
            busy={remove.isPending}
            onPress={() => void del()}
          />
        </Section>
      ) : null}
    </Page>
  );
}

/** A routine's inputs: rows of a name and its usual value, and the names its texts want but lack. */
function InputsSection({
  rows,
  onChange,
  wanted,
  problems,
}: {
  rows: InputRow[];
  onChange: (next: InputRow[]) => void;
  wanted: string[];
  problems: (MessageKey | undefined)[];
}) {
  const c = useColors();
  const full = rows.length >= ROUTINE_VARS_MAX;
  const setRow = (i: number, next: Partial<InputRow>) =>
    onChange(rows.map((r, j) => (j === i ? { ...r, ...next } : r)));
  return (
    <Section title={t('routine.inputs')} footer={t('routine.inputsHint')}>
      <Rows>
        <Pad>
          {rows.map((r, i) => (
            <View key={i} style={styles.input}>
              <View style={styles.inputLine}>
                <View style={styles.inputName}>
                  <TextBox
                    value={r.name}
                    onChangeText={(x) => setRow(i, { name: x })}
                    autoCapitalize="none"
                    autoCorrect={false}
                    placeholder={t('routine.inputName')}
                    accessibilityLabel={t('routine.inputName')}
                    invalid={!!problems[i]}
                  />
                </View>
                <View style={styles.inputValue}>
                  <TextBox
                    value={r.value}
                    maxLength={ROUTINE_VAR_MAX}
                    onChangeText={(x) => setRow(i, { value: x })}
                    placeholder={t('routine.inputValuePlaceholder')}
                    accessibilityLabel={t('routine.inputValue', { name: r.name || '…' })}
                  />
                </View>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('routine.inputRemove', { name: r.name || '…' })}
                  hitSlop={8}
                  onPress={() => onChange(rows.filter((_, j) => j !== i))}
                  style={styles.inputRemove}
                >
                  <Feather name="x" size={20} color={c.mutedForeground} />
                </Pressable>
              </View>
              {problems[i] ? (
                <Text style={[styles.inputError, { color: c.destructive }]}>{t(problems[i])}</Text>
              ) : null}
            </View>
          ))}
          <ChipRow>
            {/* A name the texts already use is one tap away. */}
            {!full
              ? wanted.map((name) => (
                  <Chip
                    key={name}
                    on={false}
                    icon="plus"
                    label={name}
                    onPress={() => onChange([...rows, { name, value: '' }])}
                  />
                ))
              : null}
            {!full ? (
              <Chip
                on={false}
                icon="plus"
                label={t('routine.inputAdd')}
                onPress={() => onChange([...rows, { name: '', value: '' }])}
              />
            ) : null}
          </ChipRow>
        </Pad>
      </Rows>
    </Section>
  );
}

/** The routine's latest runs: when, how each went and why one failed; a run opens its conversation. */
function RecentRuns({ routineId, botId }: { routineId: string; botId: string }) {
  const c = useColors();
  const api = useApi();
  const { origin } = useServer();
  const { data: runs, isLoading } = useQuery({
    queryKey: ['routine-runs', origin, routineId],
    queryFn: () => api.routineRuns(routineId),
  });
  const dot = (s: RoutineRun['status']) =>
    s === 'done'
      ? c.success
      : s === 'error'
        ? c.destructive
        : s === 'running' || s === 'waiting'
          ? c.amber
          : c.mutedForeground;
  return (
    <Section title={t('routine.runs')}>
      {isLoading ? (
        <Loading />
      ) : !runs?.length ? (
        <Pad>
          <Hint>{t('dialogs.routineNoRuns')}</Hint>
        </Pad>
      ) : (
        <Rows>
          {runs.slice(0, 10).map((r) => (
            <Pressable
              key={r.id}
              disabled={!r.threadId}
              accessibilityRole="button"
              onPress={() => r.threadId && nav.chat(botId, { threadId: r.threadId })}
              style={({ pressed }) => [styles.run, pressed && { backgroundColor: c.accent }]}
            >
              <View style={[styles.dot, { backgroundColor: dot(r.status) }]} />
              <View style={styles.runText}>
                <Text style={[styles.runTitle, { color: c.foreground }]}>
                  {fmt.dayLabel(r.startedAt)} · {t(`routine.run.${r.status}`)}
                </Text>
                {r.reason ? (
                  <Text style={[styles.runReason, { color: c.mutedForeground }]} numberOfLines={2}>
                    {r.reason}
                  </Text>
                ) : null}
                {/* While the pre-check only watches, the runs it would have skipped say so. */}
                {r.gate?.decision === 'skip' && r.status !== 'skipped' ? (
                  <Text style={[styles.runReason, { color: c.mutedForeground }]} numberOfLines={2}>
                    {r.gate.reason
                      ? t('routine.gateWouldSkip', { reason: r.gate.reason })
                      : t('routine.gateWouldSkipNoReason')}
                  </Text>
                ) : null}
              </View>
            </Pressable>
          ))}
        </Rows>
      )}
    </Section>
  );
}

/** The routine's secret address for other services, with buttons to make, copy, renew or remove it. */
/** The app tool the routine calls before each run, set up by its bot; the person can remove it. */
function Check({ routine: given }: { routine: Routine }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const { data: routines } = useRoutines();
  const routine = routines?.find((r) => r.id === given.id) ?? given;
  const { data: connections = [] } = useConnections();
  const remove = useMutation({
    mutationFn: () => api.updateRoutine(routine.id, { check: null }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routines', origin] }),
    onError: toastError,
  });
  const check = routine.check;
  if (!check) {
    return (
      <Section>
        <Rows>
          <Pad>
            <Hint>{t('routine.checkHint')}</Hint>
          </Pad>
        </Rows>
      </Section>
    );
  }
  const app = connections.find((c) => c.id === check.connectionId)?.name ?? check.connectionId;
  const args = Object.keys(check.args).length ? JSON.stringify(check.args) : null;
  return (
    <Section>
      <Rows>
        <Pad>
          <Hint>{t('routine.checkOn', { app, tool: check.tool })}</Hint>
          {args ? (
            <Text selectable style={styles.url} numberOfLines={3}>
              {args}
            </Text>
          ) : null}
          <View style={styles.buttons}>
            <PillButton
              label={t('routine.checkRemove')}
              variant="ghost"
              busy={remove.isPending}
              onPress={() => remove.mutate()}
            />
          </View>
        </Pad>
      </Rows>
    </Section>
  );
}

function Webhook({ routine: given }: { routine: Routine }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  // The page holds the routine as it was opened; the address comes from the latest list.
  const { data: routines } = useRoutines();
  const routine = routines?.find((r) => r.id === given.id) ?? given;
  const { data: info } = useInfo();
  const set = useMutation({
    mutationFn: (on: boolean) => (on ? api.enableWebhook(routine.id) : api.disableWebhook(routine.id)),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routines', origin] }),
    onError: toastError,
  });
  const base = info?.publicUrl ?? origin ?? '';
  const url = routine.webhookToken
    ? `${base}/api/hooks/routines/${routine.id}/${routine.webhookToken}`
    : null;
  // An address on this computer only cannot be reached by a service on the internet; say so.
  let localOnly = false;
  try {
    localOnly = !!url && isLoopback(new URL(base).hostname);
  } catch {
    localOnly = false;
  }
  return (
    <Section footer={localOnly ? t('routine.webhookLocalOnly') : undefined}>
      <Rows>
        <Pad>
          <Hint>{t(url ? 'routine.webhookOn' : 'routine.webhookHint')}</Hint>
          {url ? (
            <Text selectable style={styles.url} numberOfLines={2}>
              {url}
            </Text>
          ) : null}
          <View style={styles.buttons}>
            {url ? (
              <>
                <PillButton
                  label={t('routine.webhookRenew')}
                  variant="ghost"
                  onPress={() => set.mutate(true)}
                />
                <PillButton label={t('common.remove')} variant="ghost" onPress={() => set.mutate(false)} />
                <PillButton
                  label={t('message.copy')}
                  onPress={() => {
                    void Clipboard.setStringAsync(url).then(
                      () => toast(t('routine.webhookCopied')),
                      () => toast(t('message.copyFailed'), { tone: 'error' }),
                    );
                  }}
                />
              </>
            ) : (
              <PillButton
                icon="link"
                label={t('routine.webhookCreate')}
                busy={set.isPending}
                onPress={() => set.mutate(true)}
              />
            )}
          </View>
        </Pad>
      </Rows>
    </Section>
  );
}

const styles = StyleSheet.create({
  run: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  dot: { width: 8, height: 8, borderRadius: 4, marginTop: 6 },
  runText: { flex: 1, gap: 2 },
  runTitle: { fontSize: 17 },
  runReason: { fontSize: 15, lineHeight: 20 },
  url: { fontSize: 13, fontFamily: 'Menlo' },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, justifyContent: 'flex-end' },
  input: { gap: 4 },
  inputLine: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  inputName: { width: 120 },
  inputValue: { flex: 1, minWidth: 0 },
  inputRemove: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center' },
  inputError: { fontSize: 13 },
});
