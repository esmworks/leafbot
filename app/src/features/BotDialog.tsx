import {
  BRAND_COLOR,
  DEFAULT_AVATAR,
  EFFORTS,
  OBJECT_AVATARS,
  PERMISSION_MODES,
  shownMode,
  selectorLines,
  ToolSelection,
  type Bot,
  type Effort,
} from '@leafbot/shared';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Archive, ChevronDown, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useForm, useWatch } from 'react-hook-form';
import { toast } from 'sonner';
import { z } from 'zod';
import { BotAvatar, ObjectArt } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { useT } from '@/i18n';
import { TelegramPanel } from './TelegramPanel';
import { BotSharing } from './BotSharing';
import { api } from '@/lib/api';
import { useFormat } from '@/lib/format';
import { newBotEngine, splitPiModel, type BotEngine } from '@/lib/new-bot';
import {
  useBots,
  useClaudeModels,
  useGroups,
  useInfo,
  useProviderModelInfo,
  useProviders,
  useSettings,
} from '@/lib/queries';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { MODE_LABEL } from './RightPanel';
import { InstructionsDocStatus } from './InstructionsDoc';
import { availableStarters, starterBot, type StarterId } from './onboarding/profile';
import { MissingApps } from './MissingApps';
import { Field } from './RoutineDialog';
import { connectionName, ModelSearch, type ModelOption } from './ProviderConnect';

export const COLORS = [
  BRAND_COLOR,
  '#4f6bed',
  '#7c5cff',
  '#c026d3',
  '#e11d74',
  '#e5484d',
  '#f97316',
  '#d4a017',
  '#0d9488',
  '#0891b2',
  '#64748b',
];

const NO_GROUP = '__none__';

/** Tool names as cards name them; examples, the same in every language. */
const TOOLS_EXAMPLE = 'Read\nmcp__leafbot__memory_*\nmcp__gmail__search_threads';
const TOOLS_EXCLUDE_EXAMPLE = 'Bash\nmcp__leafbot__browser_*';
/** An instructions document address; an example, the same in every language. */
const DOC_EXAMPLE = 'https://github.com/…/BOT.md';

/** Validation messages are message keys; `Field` shows them in the current language. */
const Form = z
  .object({
    name: z.string().trim().min(1, 'bot.nameRequired').max(60),
    description: z.string().max(500),
    instructions: z.string().max(20_000),
    groupId: z.string(),
    newGroup: z.string().max(60),
    color: z.string(),
    avatar: z.string(),
    permissionMode: z.enum(PERMISSION_MODES),
    isManager: z.boolean(),
    memory: z.boolean(),
    effort: z.string(),
    toolsOnly: z.boolean(),
    toolsAllow: z.string().max(80_000),
    toolsExclude: z.string().max(80_000),
    internet: z.boolean(),
    projectDir: z.string().max(1000),
    instructionsUrl: z
      .string()
      .trim()
      .max(1000)
      .refine((v) => !v || /^https:\/\/\S+$/i.test(v), 'bot.instructionsUrlInvalid'),
    engine: z.enum(['claude', 'pi']),
    provider: z.string(),
    model: z.string().trim().max(100),
    dailyLimit: z.string().trim().refine(isLimit, 'bot.limitInvalid'),
    monthlyLimit: z.string().trim().refine(isLimit, 'bot.limitInvalid'),
  })
  .superRefine((f, ctx) => {
    if (f.engine === 'pi' && !f.model)
      ctx.addIssue({ code: 'custom', path: ['model'], message: 'bot.modelRequired' });
    for (const field of ['toolsAllow', 'toolsExclude'] as const) {
      if (!ToolSelection.shape.allow.safeParse(selectorLines(f[field])).success)
        ctx.addIssue({ code: 'custom', path: [field], message: 'bot.toolsInvalid' });
    }
  });
type Form = z.infer<typeof Form>;

function initial(bot?: Bot, start: BotEngine = { engine: 'claude', model: '' }): Form {
  return {
    name: bot?.name ?? '',
    description: bot?.description ?? '',
    instructions: bot?.instructions ?? '',
    groupId: bot?.groupId ?? NO_GROUP,
    newGroup: '',
    color: bot?.color ?? COLORS[0]!,
    avatar: bot?.avatar ?? DEFAULT_AVATAR,
    permissionMode: bot ? shownMode(bot.permissionMode) : 'auto',
    isManager: bot?.isManager ?? false,
    memory: bot?.memory ?? true,
    effort: bot?.effort ?? '',
    toolsOnly: bot?.toolSelection.only ?? false,
    toolsAllow: bot?.toolSelection.allow.join('\n') ?? '',
    toolsExclude: bot?.toolSelection.exclude.join('\n') ?? '',
    internet: bot?.internet ?? true,
    projectDir: bot?.projectDir ?? '',
    instructionsUrl: bot?.instructionsUrl ?? '',
    engine: bot?.engine ?? start.engine,
    ...modelFields(bot ?? start),
    dailyLimit: bot?.dailyLimitUsd ? String(bot.dailyLimitUsd) : '',
    monthlyLimit: bot?.monthlyLimitUsd ? String(bot.monthlyLimitUsd) : '',
  };
}

/** A spending limit as typed: empty for none, else dollars, with a comma or a point. */
const limitUsd = (v: string) => (v.trim() ? Math.round(Number(v.trim().replace(',', '.')) * 100) / 100 : 0);
function isLimit(v: string) {
  const n = limitUsd(v);
  return Number.isFinite(n) && n >= 0 && n <= 1_000_000;
}

function modelFields({ engine, model }: BotEngine): { provider: string; model: string } {
  if (engine !== 'pi') return { provider: 'openai', model };
  const parts = splitPiModel(model);
  return { provider: parts.provider || 'openai', model: parts.model };
}

/** The select's value for "as set for all bots"; efforts never take this form. */
const DEFAULT_EFFORT = '*';

/** Offered when the server cannot list Claude models (an older server). */
const CLAUDE_MODELS = ['sonnet', 'opus', 'haiku'].map((value) => ({ value, name: '' }));
/** The CLI's own "default" row means "no model named", which an empty field already says. */
const CLI_DEFAULT = 'default';
/** The connection select's value for Claude; no provider id takes this form. */
const CLAUDE = '__claude__';

export function BotDialog() {
  const t = useT();
  const dialog = useUi((s) => s.botDialog);
  const close = useUi((s) => s.openBotDialog);
  const { data: bots = [] } = useBots();
  const bot = dialog?.mode === 'edit' ? bots.find((b) => b.id === dialog.botId) : undefined;
  // A stray click beside the window, Escape or Cancel must not throw away typed instructions.
  const dirty = useRef(false);
  const leave = () => {
    if (dirty.current && !window.confirm(t('bot.discardConfirm'))) return;
    dirty.current = false;
    close(null);
  };
  return (
    <Dialog open={!!dialog} onOpenChange={(o) => !o && leave()}>
      {/* Title and buttons stay put; only the form between them scrolls. */}
      <DialogContent className="screen-edges flex max-h-[min(880px,90vh)] flex-col gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-2xl phone:h-dvh phone:max-h-none phone:max-w-full phone:rounded-none phone:border-0">
        <DialogHeader className="px-6 pt-6 pb-4">
          <DialogTitle>{bot ? t('bot.settingsTitle', { name: bot.name }) : t('bot.new')}</DialogTitle>
        </DialogHeader>
        {dialog && (
          <BotForm
            key={bot?.id ?? 'new'}
            bot={bot}
            preset={dialog.mode === 'create' ? dialog.preset : undefined}
            onDone={() => {
              dirty.current = false;
              close(null);
            }}
            onCancel={leave}
            onDirty={(d) => {
              dirty.current = d;
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function BotForm({
  bot,
  preset,
  onDone,
  onCancel,
  onDirty,
}: {
  bot?: Bot;
  /** What a new bot starts with besides the defaults. */
  preset?: { name: string; projectDir: string };
  onDone(): void;
  onCancel(): void;
  /** Whether the form holds changes not saved yet, each time that changes. */
  onDirty(dirty: boolean): void;
}) {
  const t = useT();
  // Shared for talking only: the settings show, but only those who may change the bot save them.
  const readOnly = bot?.yourLevel === 'chat';
  const qc = useQueryClient();
  const { data: groups = [] } = useGroups();
  const selectBot = useUi((s) => s.selectBot);
  const openChat = useUi((s) => s.openChat);
  const { data: settings } = useSettings();
  // A new bot starts on the AI picked in the settings; Claude when none was picked.
  const form = useForm<Form>({
    resolver: zodResolver(Form),
    defaultValues: { ...initial(bot, newBotEngine(settings)), ...preset },
  });
  const v = useWatch({ control: form.control }) as Form;
  const efforts = useModelEfforts(v);
  const effortOptions: readonly Effort[] = efforts ?? EFFORTS;
  const { isDirty } = form.formState;
  // Instructions taken from the document while the form is open replace the ones it opened with,
  // so unlinking later does not write the old text back.
  const savedInstructions = bot?.instructions;
  useEffect(() => {
    if (savedInstructions === undefined || form.getFieldState('instructions').isDirty) return;
    form.resetField('instructions', { defaultValue: savedInstructions });
  }, [savedInstructions, form]);
  useEffect(() => {
    onDirty(isDirty);
  }, [isDirty, onDirty]);
  const err = form.formState.errors;
  // A bot made for a folder shows where the folder is set.
  const [advanced, setAdvanced] = useState(!!preset?.projectDir);
  const { data: bots = [] } = useBots();
  // Offered once, when the dialog opens: a bot made meanwhile does not reshuffle the choices.
  const [starters] = useState(() =>
    bot
      ? []
      : availableStarters(
          t,
          bots.map((b) => b.name),
        ),
  );
  const starterOn = (id: StarterId) => {
    const s = starterBot(id, t);
    return (
      v.name === s.name &&
      v.description === s.description &&
      v.instructions === s.instructions &&
      v.avatar === s.avatar &&
      v.color === s.color
    );
  };
  /** Fills the form from a starter; choosing the chosen one again empties it. */
  const pickStarter = (id: StarterId) => {
    const fill = starterOn(id) ? initial() : starterBot(id, t);
    for (const k of ['name', 'description', 'instructions', 'avatar', 'color'] as const) {
      form.setValue(k, fill[k], { shouldDirty: true, shouldValidate: !!err[k] });
    }
  };

  const save = useMutation({
    mutationFn: async (f: Form) => {
      let groupId: string | null = f.groupId === NO_GROUP ? null : f.groupId;
      if (f.newGroup.trim()) groupId = (await api.createGroup(f.newGroup.trim())).id;
      const instructionsUrl = f.instructionsUrl.trim() || null;
      const body = {
        name: f.name,
        description: f.description,
        // Instructions kept in a document come from there, once the person accepts them.
        ...(!instructionsUrl && { instructions: f.instructions }),
        // An older server does not know the field; it goes only when there is something to say.
        ...((instructionsUrl || bot?.instructionsUrl) && { instructionsUrl }),
        groupId,
        color: f.color,
        avatar: f.avatar,
        permissionMode: f.permissionMode,
        isManager: f.isManager,
        memory: f.memory,
        // A level the model does not take would be changed by the engine; the model's own is kept.
        effort: (efforts && f.effort && !efforts.includes(f.effort as Effort) ? '' : f.effort) as Effort | '',
        toolSelection: {
          only: f.toolsOnly,
          allow: selectorLines(f.toolsAllow),
          exclude: selectorLines(f.toolsExclude),
        },
        internet: f.internet,
        projectDir: f.projectDir.trim() || null,
        engine: f.engine,
        model: f.engine === 'pi' ? `${f.provider}/${f.model}` : f.model,
        dailyLimitUsd: limitUsd(f.dailyLimit),
        monthlyLimitUsd: limitUsd(f.monthlyLimit),
      };
      return bot ? api.updateBot(bot.id, body) : api.createBot(body);
    },
    onSuccess: (saved) => {
      // Put the bot in the cache first so selecting it does not fall back to another bot.
      qc.setQueryData<Bot[]>(['bots'], (old = []) => [...old.filter((b) => b.id !== saved.id), saved]);
      void qc.invalidateQueries({ queryKey: ['bots'] });
      void qc.invalidateQueries({ queryKey: ['groups'] });
      if (!bot) openChat(saved.id);
      onDone();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const archive = useMutation({
    mutationFn: () => api.archiveBot(bot!.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['bots'] });
      selectBot(null);
      onDone();
      toast.success(t('bot.archived'));
    },
    onError: (e) => toast.error((e as Error).message),
  });

  return (
    <form onSubmit={form.handleSubmit((f) => save.mutate(f))} className="flex min-h-0 flex-1 flex-col">
      <div className="scroll-thin min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain px-6 pt-1 pb-6">
        {readOnly && <p className="rounded-2xl bg-secondary/60 px-4 py-3 text-sm">{t('share.readOnly')}</p>}
        {starters.length > 0 && (
          <section aria-labelledby="bot-starters">
            <h3 id="bot-starters" className="mb-2 text-sm font-medium">
              {t('bot.starters')}
            </h3>
            <div className="flex flex-wrap gap-2">
              {starters.map((id) => {
                const s = starterBot(id, t);
                const on = starterOn(id);
                return (
                  <button
                    key={id}
                    type="button"
                    aria-pressed={on}
                    title={s.description}
                    onClick={() => pickStarter(id)}
                    className={cn(
                      'inline-flex items-center gap-2 rounded-xl border py-1.5 pr-3 pl-1.5 text-sm transition-colors hover:bg-accent',
                      on && 'border-[var(--brand)]/60 bg-[var(--brand)]/10 hover:bg-[var(--brand)]/15',
                    )}
                  >
                    <BotAvatar avatar={s.avatar} color={s.color} seed={id} size={24} />
                    {s.name}
                  </button>
                );
              })}
            </div>
          </section>
        )}
        <AvatarEditor
          avatar={v.avatar}
          color={v.color}
          onAvatar={(a) => form.setValue('avatar', a, { shouldDirty: true })}
          onColor={(c) => form.setValue('color', c, { shouldDirty: true })}
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t('bot.name')} error={err.name?.message}>
            <Input
              {...form.register('name')}
              autoFocus={!bot}
              className="rounded-xl"
              placeholder={t('bot.namePlaceholder')}
            />
          </Field>
          <Field label={t('bot.group')}>
            <Select value={v.groupId} onValueChange={(g) => form.setValue('groupId', g)}>
              <SelectTrigger className="w-full rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_GROUP}>{t('bot.noGroup')}</SelectItem>
                {groups.map((g) => (
                  <SelectItem key={g.id} value={g.id}>
                    {g.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              {...form.register('newGroup')}
              className="mt-2 rounded-xl"
              placeholder={t('bot.newGroup')}
            />
          </Field>
        </div>
        <Field label={t('bot.description')}>
          <Input
            {...form.register('description')}
            className="rounded-xl"
            placeholder={t('bot.descriptionPlaceholder')}
          />
        </Field>
        <Field label={t('bot.instructions')}>
          <Textarea
            {...form.register('instructions')}
            rows={5}
            readOnly={!!v.instructionsUrl?.trim()}
            className={cn('rounded-xl', v.instructionsUrl?.trim() && 'text-muted-foreground')}
            placeholder={t('bot.instructionsPlaceholder')}
          />
          {v.instructionsUrl?.trim() && !bot?.instructionsUrl && (
            <p className="text-xs text-muted-foreground">{t('bot.instructionsFromDoc')}</p>
          )}
          {bot && <InstructionsDocStatus bot={bot} />}
          <MissingApps text={v.instructions ?? ''} botId={bot?.id ?? null} />
        </Field>
        <ModelPicker
          value={v}
          error={err.model?.message}
          onChange={(patch) => {
            for (const [k, val] of Object.entries(patch)) {
              form.setValue(k as 'engine' | 'provider' | 'model', val as string, { shouldDirty: true });
            }
          }}
        />
        {(v.engine === 'claude' || v.engine === 'pi') && efforts?.length !== 0 && (
          <Field label={t('model.effort')}>
            <Select
              value={v.effort && effortOptions.includes(v.effort as Effort) ? v.effort : DEFAULT_EFFORT}
              onValueChange={(e) =>
                form.setValue('effort', e === DEFAULT_EFFORT ? '' : e, { shouldDirty: true })
              }
            >
              <SelectTrigger className="w-full rounded-xl">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DEFAULT_EFFORT}>
                  {t(v.engine === 'claude' ? 'bot.effortDefault' : 'bot.effortModelDefault')}
                </SelectItem>
                {effortOptions.map((e) => (
                  <SelectItem key={e} value={e}>
                    {t(`effort.${e}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
        {bot && <BotSharing bot={bot} />}
        {bot && <TelegramPanel botId={bot.id} />}
        <button
          type="button"
          onClick={() => setAdvanced((a) => !a)}
          aria-expanded={advanced}
          className="flex w-full items-center gap-3 rounded-2xl px-1 py-1 text-left"
        >
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{t('bot.advanced')}</span>
            <span className="block text-xs text-muted-foreground">{t('bot.advancedHint')}</span>
          </span>
          <ChevronDown
            className={cn('size-4 text-muted-foreground transition-transform', advanced && 'rotate-180')}
          />
        </button>
        {advanced && (
          <div className="space-y-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t('bot.permissionMode')}>
                <Select
                  value={v.permissionMode}
                  onValueChange={(m) => form.setValue('permissionMode', m as Form['permissionMode'])}
                >
                  <SelectTrigger className="w-full rounded-xl">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PERMISSION_MODES.map((m) => (
                      <SelectItem key={m} value={m}>
                        {t(MODE_LABEL[m])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t(`bot.modeHint.${v.permissionMode}`)}</p>
              </Field>
              <Field label={t('bot.instructionsUrl')} error={err.instructionsUrl?.message}>
                <Input
                  {...form.register('instructionsUrl')}
                  className="rounded-xl"
                  inputMode="url"
                  placeholder={DOC_EXAMPLE}
                />
                <p className="text-xs text-muted-foreground">{t('bot.instructionsUrlHint')}</p>
              </Field>
              <Field label={t('bot.projectDir')}>
                <Input
                  {...form.register('projectDir')}
                  className="rounded-xl"
                  placeholder={t('bot.projectDirPlaceholder')}
                />
                <p className="text-xs text-muted-foreground">{t('bot.projectDirHint')}</p>
              </Field>
            </div>
            <label className="flex items-center justify-between gap-4 rounded-2xl bg-secondary/60 px-4 py-3">
              <span>
                <span className="block text-sm font-medium">{t('bot.internet')}</span>
                <span className="block text-xs text-muted-foreground">{t('bot.internetHint')}</span>
              </span>
              <Switch
                checked={v.internet}
                onCheckedChange={(c) => form.setValue('internet', c, { shouldDirty: true })}
              />
            </label>
            <label className="flex items-center justify-between gap-4 rounded-2xl bg-secondary/60 px-4 py-3">
              <span>
                <span className="block text-sm font-medium">{t('bot.manager')}</span>
                <span className="block text-xs text-muted-foreground">{t('bot.managerHint')}</span>
              </span>
              <Switch checked={v.isManager} onCheckedChange={(c) => form.setValue('isManager', c)} />
            </label>
            <label className="flex items-center justify-between gap-4 rounded-2xl bg-secondary/60 px-4 py-3">
              <span>
                <span className="block text-sm font-medium">{t('bot.memory')}</span>
                <span className="block text-xs text-muted-foreground">{t('bot.memoryHint')}</span>
              </span>
              <Switch
                checked={v.memory}
                onCheckedChange={(c) => form.setValue('memory', c, { shouldDirty: true })}
              />
            </label>
            <div className="space-y-3 rounded-2xl bg-secondary/60 px-4 py-3">
              <span className="block">
                <span className="block text-sm font-medium">{t('bot.spendLimits')}</span>
                <span className="block text-xs text-muted-foreground">{t('bot.spendLimitsHint')}</span>
              </span>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label={t('bot.dailyLimit')} error={err.dailyLimit?.message}>
                  <Input
                    {...form.register('dailyLimit')}
                    inputMode="decimal"
                    placeholder="0"
                    className="rounded-xl tabular-nums"
                  />
                </Field>
                <Field label={t('bot.monthlyLimit')} error={err.monthlyLimit?.message}>
                  <Input
                    {...form.register('monthlyLimit')}
                    inputMode="decimal"
                    placeholder="0"
                    className="rounded-xl tabular-nums"
                  />
                </Field>
              </div>
              {bot && <BotSpent botId={bot.id} />}
            </div>
            <div className="space-y-3 rounded-2xl bg-secondary/60 px-4 py-3">
              <label className="flex items-center justify-between gap-4">
                <span>
                  <span className="block text-sm font-medium">{t('bot.toolsOnly')}</span>
                  <span className="block text-xs text-muted-foreground">{t('bot.toolsHint')}</span>
                </span>
                <Switch
                  checked={v.toolsOnly}
                  onCheckedChange={(c) => form.setValue('toolsOnly', c, { shouldDirty: true })}
                />
              </label>
              {v.toolsOnly && (
                <Field label={t('bot.toolsAllow')} error={err.toolsAllow?.message}>
                  <Textarea
                    {...form.register('toolsAllow')}
                    rows={4}
                    spellCheck={false}
                    placeholder={TOOLS_EXAMPLE}
                    className="rounded-xl font-mono text-xs"
                  />
                </Field>
              )}
              <Field label={t('bot.toolsExclude')} error={err.toolsExclude?.message}>
                <Textarea
                  {...form.register('toolsExclude')}
                  rows={2}
                  spellCheck={false}
                  placeholder={TOOLS_EXCLUDE_EXAMPLE}
                  className="rounded-xl font-mono text-xs"
                />
              </Field>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t px-6 py-4">
        {bot && (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto rounded-full text-muted-foreground"
            onClick={() => archive.mutate()}
            disabled={archive.isPending || readOnly}
          >
            <Archive /> {t('bot.archive')}
          </Button>
        )}
        <div className="flex-1" />
        <Button type="button" variant="ghost" className="rounded-full" onClick={onCancel}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={save.isPending || readOnly}>
          {bot ? t('common.save') : t('bot.create')}
        </Button>
      </div>
    </form>
  );
}

/** What the bot spent today and this month, under its limits. */
function BotSpent({ botId }: { botId: string }) {
  const t = useT();
  const f = useFormat();
  const { data } = useQuery({ queryKey: ['bot-spend', botId], queryFn: () => api.botSpend(botId) });
  if (!data) return null;
  return (
    <p className="text-xs text-muted-foreground tabular-nums">
      {t('bot.spent', { day: f.usd(data.dayUsd), month: f.usd(data.monthUsd) })}
    </p>
  );
}

/**
 * The thinking levels the bot's model takes: Claude's from its model list, another provider's from
 * the server's. Null while unknown (an older server, a model off the list): every level is offered.
 */
function useModelEfforts(v: Pick<Form, 'engine' | 'provider' | 'model'>): Effort[] | null {
  const pi = v.engine === 'pi';
  const { data: claudeModels = [] } = useClaudeModels(!pi);
  const { data: models = [] } = useProviderModelInfo(pi ? v.provider : null);
  if (pi) return models.find((m) => m.id === v.model)?.efforts ?? null;
  return claudeModels.find((m) => m.value === (v.model || CLI_DEFAULT))?.efforts ?? null;
}

/**
 * Where the bot's model comes from, then which model: Claude, or any provider connected under
 * Settings → Connection, each with its own models by name.
 */
function ModelPicker({
  value,
  error,
  onChange,
}: {
  value: Pick<Form, 'engine' | 'provider' | 'model'>;
  error?: string;
  onChange(patch: Partial<Pick<Form, 'engine' | 'provider' | 'model'>>): void;
}) {
  const t = useT();
  const { data: providers = [], isSuccess: providersLoaded } = useProviders();
  const pi = value.engine === 'pi';
  const { data: models = [] } = useProviderModelInfo(pi ? value.provider : null);
  const { data: claudeModels = [] } = useClaudeModels(!pi);
  const { data: info } = useInfo();
  // The bot's own provider stays listed after its key is gone, with the warning below.
  const connections = providers.filter((p) => p.configured || (pi && p.id === value.provider));
  const keyMissing =
    pi && providers.length > 0 && !providers.find((p) => p.id === value.provider)?.configured;
  // Only a definite "not signed in"; an unchecked or failing connection is not worth a warning here.
  const claudeLoggedOut = !pi && info?.claude.status === 'logged-out';
  const named = claudeModels.filter((m) => m.value !== CLI_DEFAULT);
  const options: ModelOption[] = pi
    ? models.map((m) => ({ value: m.id, name: m.name }))
    : (named.length ? named : CLAUDE_MODELS).map((m) => ({ value: m.value, name: m.name || undefined }));
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field label={t('bot.connection')}>
        <Select
          value={pi ? value.provider : CLAUDE}
          onValueChange={(c) =>
            onChange(
              c === CLAUDE ? { engine: 'claude', model: '' } : { engine: 'pi', provider: c, model: '' },
            )
          }
        >
          <SelectTrigger className="w-full rounded-xl">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            <SelectItem value={CLAUDE}>{t('bot.engine.claude')}</SelectItem>
            {connections.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {connectionName(p)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">
          {pi ? t('bot.engineHint.pi') : t('bot.engineHint.claude')}
        </p>
        {providersLoaded && connections.length === 0 && (
          <p className="text-xs text-muted-foreground">{t('bot.connectionHint')}</p>
        )}
      </Field>
      <Field label={t('bot.model')} error={error}>
        <ModelSearch
          value={value.model}
          models={options}
          onChange={(m) => onChange({ model: m })}
          placeholder={pi ? t('bot.modelPlaceholder.pi') : t('bot.modelPlaceholder.claude')}
          className="rounded-xl"
        />
        {keyMissing && <p className="text-xs text-amber-500">{t('bot.keyMissing')}</p>}
        {claudeLoggedOut && <p className="text-xs text-amber-500">{t('bot.claudeLoggedOut')}</p>}
      </Field>
    </div>
  );
}

function AvatarEditor({
  avatar,
  color,
  onAvatar,
  onColor,
}: {
  avatar: string;
  color: string;
  onAvatar(a: string): void;
  onColor(c: string): void;
}) {
  const t = useT();
  const file = useRef<HTMLInputElement>(null);
  const upload = async (f: File) => {
    if (!/^image\/(png|jpeg|webp)$/.test(f.type)) return toast.error(t('bot.imageType'));
    try {
      onAvatar(await downscale(f, 256));
    } catch {
      toast.error(t('bot.imageUnreadable'));
    }
  };
  return (
    <div className="flex flex-col gap-4 rounded-3xl bg-secondary/50 p-4 sm:flex-row">
      <div className="flex shrink-0 items-center justify-center sm:w-36">
        <BotAvatar avatar={avatar} color={color} size={96} activity="idle" motion="always" />
      </div>
      <Tabs defaultValue={avatar.startsWith('data:') ? 'upload' : 'object'} className="flex-1">
        <TabsList className="rounded-full">
          <TabsTrigger value="object" className="rounded-full">
            {t('bot.object')}
          </TabsTrigger>
          <TabsTrigger value="upload" className="rounded-full">
            {t('bot.upload')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="object" className="space-y-3">
          <div className="grid grid-cols-7 gap-1.5">
            {OBJECT_AVATARS.map((o) => (
              <button
                type="button"
                key={o}
                onClick={() => onAvatar(`object:${o}`)}
                className={cn(
                  'aspect-square rounded-xl p-1.5 transition-colors hover:bg-accent',
                  avatar === `object:${o}` && 'bg-accent ring-2 ring-ring/40',
                )}
                aria-label={t(`bot.object.${o}`)}
                title={t(`bot.object.${o}`)}
              >
                <ObjectArt id={o} color={color} motion="always" />
              </button>
            ))}
          </div>
          <ColorRow color={color} onColor={onColor} />
        </TabsContent>
        <TabsContent value="upload" className="space-y-3">
          <input
            ref={file}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="hidden"
            onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])}
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="secondary"
              className="rounded-full"
              onClick={() => file.current?.click()}
            >
              <Upload /> {t('bot.chooseImage')}
            </Button>
            {avatar.startsWith('data:') && (
              <Button
                type="button"
                variant="ghost"
                className="rounded-full"
                onClick={() => onAvatar(DEFAULT_AVATAR)}
              >
                {t('bot.reset')}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">{t('bot.imageHint')}</p>
          <ColorRow color={color} onColor={onColor} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function ColorRow({ color, onColor }: { color: string; onColor(c: string): void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {COLORS.map((c) => (
        <button
          type="button"
          key={c}
          onClick={() => onColor(c)}
          className={cn(
            'size-7 rounded-full ring-offset-2 ring-offset-secondary transition-transform hover:scale-110',
            c === color && 'ring-2 ring-foreground/70',
          )}
          style={{ background: c }}
          aria-label={c}
        />
      ))}
    </div>
  );
}

async function downscale(f: File, size: number): Promise<string> {
  const bitmap = await createImageBitmap(f);
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const s = Math.min(bitmap.width, bitmap.height);
  ctx.drawImage(bitmap, (bitmap.width - s) / 2, (bitmap.height - s) / 2, s, s, 0, 0, size, size);
  return canvas.toDataURL('image/webp', 0.9);
}
