import {
  describeSchedule,
  PERMISSION_MODES,
  shownMode,
  type ShownMode,
  type Bot,
  type BotUpdate,
  type PermissionMode,
  type ReplayResult,
  type Routine,
  type Skill,
} from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  CircleAlert,
  Clock,
  Download,
  FileText,
  Globe,
  Pencil,
  Play,
  Plus,
  Search,
  Shield,
  Sparkles,
} from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useLocale, useT, type MessageKey } from '@/i18n';
import { api } from '@/lib/api';
import { useBotActivityById } from '@/lib/botActivity';
import { newClientId, useFormat } from '@/lib/format';
import {
  useBots,
  useConnections,
  useGroups,
  useLibrary,
  useManagesServer,
  useRoutines,
  useSession,
  useSkills,
  useSummaries,
} from '@/lib/queries';
import { isMine, isSpace, placesFor } from '@/lib/places';
import { moveWarning } from '@/features/botDrag';
import { useUi } from '@/lib/store';
import { cn } from '@/lib/utils';
import { ComputerCard, useBrowserAvailable } from './Computer';
import { canPreview, usePreview } from './FilePreview';
import { BotSuggestions } from './BotSteps';
import { BotTables } from './BotTables';
import { InstructionsDocNotice } from './InstructionsDoc';
import { AppLogo, openTo, useToggleBot } from './Connections';

const PANEL_TAB_KEY = 'leafbot.panelTab';

/** The panel opens on the tab last viewed on this device, whichever bot it shows. */
function readPanelTab(): string {
  try {
    return localStorage.getItem(PANEL_TAB_KEY) === 'library' ? 'library' : 'activity';
  } catch {
    return 'activity';
  }
}

function savePanelTab(tab: string) {
  try {
    localStorage.setItem(PANEL_TAB_KEY, tab);
  } catch {
    // Remembered for this page only.
  }
}

export const MODE_LABEL: Record<ShownMode, MessageKey> = {
  readonly: 'mode.readonly',
  ask: 'mode.ask',
  auto: 'mode.auto',
};

/** `beside`: in its own column next to the chat, rather than sliding over it. */
export function RightPanel({ bot, beside }: { bot: Bot; beside?: boolean }) {
  const t = useT();
  const openBotPage = useUi((s) => s.openBotPage);
  const browser = useBrowserAvailable();
  const activity = useBotActivityById(bot.id);
  return (
    <aside
      className={cn(
        'scroll-thin relative flex h-full shrink-0 flex-col overflow-y-auto px-5 py-6',
        beside ? 'wallpaper-glass w-[360px] border-s' : 'w-full',
      )}
    >
      <div className="window-drag absolute inset-x-0 top-0 h-6" />
      <div className="flex flex-col items-center gap-1 text-center">
        <button
          onClick={() => openBotPage({ mode: 'edit', botId: bot.id })}
          className="group relative rounded-full"
          aria-label={t('panel.editBot')}
        >
          <BotAvatar
            avatar={bot.avatar}
            material={bot.material}
            color={bot.color}
            seed={bot.id}
            size={96}
            activity={activity}
            motion="always"
          />
          <span className="absolute end-0 bottom-0 flex size-8 items-center justify-center rounded-full border bg-background opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100">
            <Pencil className="size-4" />
          </span>
        </button>
        <div>
          <div className="text-xl font-semibold">{bot.name}</div>
          {bot.description && <p className="mt-1 text-sm text-muted-foreground">{bot.description}</p>}
        </div>
      </div>
      <Tabs defaultValue={readPanelTab()} onValueChange={savePanelTab} className="mt-6 flex-1">
        <TabsList className="w-full rounded-full">
          <TabsTrigger value="activity" className="rounded-full">
            {t('panel.activity')}
          </TabsTrigger>
          <TabsTrigger value="library" className="rounded-full">
            {t('panel.library')}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="activity" className="mt-4 space-y-6">
          {/* A bot with the internet off gets no browser. */}
          {browser && bot.internet !== false && <ComputerCard bot={bot} />}
          <InstructionsDocNotice bot={bot} />
          <BotSuggestions bot={bot} />
          <Upcoming bot={bot} />
          <BotApps bot={bot} />
          <BotSkills bot={bot} />
          <BotTables bot={bot} />
          <BotFacts bot={bot} />
        </TabsContent>
        <TabsContent value="library" className="mt-4">
          <Library bot={bot} />
        </TabsContent>
      </Tabs>
    </aside>
  );
}

function Upcoming({ bot }: { bot: Bot }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { dayLabel } = useFormat();
  const { data: routines = [] } = useRoutines();
  const mine = routines.filter((r) => r.botId === bot.id);
  const { data: summaries = [] } = useSummaries();
  // Servers older than the field send no ids.
  const failed = new Set(summaries.find((s) => s.botId === bot.id)?.failedRoutines ?? []);
  const openRoutine = useUi((s) => s.openRoutine);
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: (r: Routine) => api.updateRoutine(r.id, { enabled: !r.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routines'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const run = useMutation({
    mutationFn: (r: Routine) => api.runRoutine(r.id),
    onSuccess: (run) =>
      run?.status === 'skipped'
        ? toast.info(run.reason ?? t('panel.skipped'))
        : toast.success(t('panel.routineStarted')),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold">{t('panel.upcoming')}</h4>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full"
          onClick={() => openRoutine({ botId: bot.id, routineId: null })}
        >
          <Plus /> {t('panel.addRoutine')}
        </Button>
      </div>
      {mine.length === 0 && (
        <p className="rounded-2xl bg-secondary/60 px-4 py-3 text-sm text-muted-foreground">
          {t('panel.noRoutines')}
        </p>
      )}
      <div className="space-y-2">
        {mine.map((r) => (
          <div key={r.id} className="flex items-center gap-3 rounded-2xl bg-secondary/60 px-4 py-3">
            {failed.has(r.id) ? (
              <CircleAlert className="size-4 shrink-0 text-destructive" aria-hidden />
            ) : (
              <Clock className="size-4 shrink-0 text-muted-foreground" />
            )}
            <button
              className="min-w-0 flex-1 text-start"
              onClick={() => openRoutine({ botId: bot.id, routineId: r.id, showRuns: failed.has(r.id) })}
            >
              <div className="truncate text-sm font-medium">{r.name}</div>
              <div className="truncate text-[13px] text-muted-foreground">
                {r.pausedReason === 'failures' && !r.enabled ? (
                  <span className="text-destructive">{t('panel.switchedOffFailures')} · </span>
                ) : !r.enabled ? (
                  // Only the switch said it was off, which is easy to miss at a glance. A one-time
                  // routine turns itself off once it has run; that is not a pause.
                  <span>
                    {t(r.schedule.type === 'once' && r.lastRunAt ? 'panel.ranOnce' : 'pause.badge')} ·{' '}
                  </span>
                ) : r.signInWait ? (
                  <span className="text-destructive">{t('panel.signInWait')} · </span>
                ) : (
                  failed.has(r.id) && <span className="text-destructive">{t('panel.lastRunFailed')} · </span>
                )}
                {describeSchedule(r.schedule, locale)}
                {r.enabled && r.nextRunAt ? ` · ${t('panel.nextRun', { when: dayLabel(r.nextRunAt) })}` : ''}
              </div>
            </button>
            <Button
              size="icon"
              variant="ghost"
              className="size-7 rounded-full"
              onClick={() => run.mutate(r)}
              aria-label={t('panel.runNow')}
            >
              <Play className="size-3.5" />
            </Button>
            <Switch
              checked={r.enabled}
              onCheckedChange={() => toggle.mutate(r)}
              aria-label={t('panel.toggle')}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

/** How many logos the summary row stacks before it stops. */
const STACKED_LOGOS = 4;

/**
 * The connections this bot may use, as one row: how many are on, and a warning when one needs
 * attention. The row opens a window with each one's switch; adding one opens the apps page.
 */
function BotApps({ bot }: { bot: Bot }) {
  const t = useT();
  const { data: connections = [] } = useConnections();
  const openApps = useUi((s) => s.openApps);
  const [open, setOpen] = useState(false);
  const on = connections.filter((c) => openTo(c, bot.id));
  const troubled = connections.filter((c) => c.status !== 'connected').length;
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold">{t('panel.apps')}</h4>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full"
          onClick={() => openApps({ botId: bot.id })}
        >
          <Plus /> {t('panel.addApp')}
        </Button>
      </div>
      {connections.length === 0 ? (
        <button
          onClick={() => openApps({ botId: bot.id })}
          className="w-full rounded-2xl bg-secondary/60 px-4 py-3 text-start text-sm text-muted-foreground hover:bg-secondary"
        >
          {t('panel.noApps')}
        </button>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-3 rounded-2xl bg-secondary/60 px-3 py-2.5 text-start hover:bg-secondary"
        >
          <span className="flex shrink-0 -space-x-2">
            {(on.length ? on : connections).slice(0, STACKED_LOGOS).map((c) => (
              <span key={c.id} className="rounded-full ring-2 ring-background">
                <AppLogo id={c.catalogId} name={c.name} size={24} />
              </span>
            ))}
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {t('panel.appsOn', { on: on.length, total: connections.length })}
            </span>
            {troubled > 0 && (
              <span className="block truncate text-[13px] text-amber-600 dark:text-amber-400">
                {t('panel.appsTrouble', { count: troubled })}
              </span>
            )}
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
        </button>
      )}
      <BotAppsDialog bot={bot} open={open} onOpenChange={setOpen} />
    </section>
  );
}

/** Every connection with its switch for one bot, a search over them, and all on or off at once. */
function BotAppsDialog({
  bot,
  open,
  onOpenChange,
}: {
  bot: Bot;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: connections = [] } = useConnections();
  const { data: bots = [] } = useBots();
  const openApps = useUi((s) => s.openApps);
  const toggle = useToggleBot();
  const [query, setQuery] = useState('');
  const q = query.trim().toLocaleLowerCase();
  const shown = q ? connections.filter((c) => c.name.toLocaleLowerCase().includes(q)) : connections;
  const all = useMutation({
    // One request per connection that changes; a connection every bot has keeps it for the others.
    mutationFn: async (on: boolean) => {
      const everyone = bots.filter((b) => !b.archivedAt).map((b) => b.id);
      for (const c of connections) {
        if (openTo(c, bot.id) === on) continue;
        const current = c.allBots ? everyone : c.botIds;
        const botIds = on ? [...new Set([...current, bot.id])] : current.filter((id) => id !== bot.id);
        await api.setConnectionBots(c.id, { allBots: false, botIds });
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['connections'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const busy = toggle.isPending || all.isPending;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setQuery('');
        onOpenChange(o);
      }}
    >
      <DialogContent className="screen-edges flex h-[min(640px,85vh)] flex-col gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-md phone:h-dvh phone:max-h-none phone:max-w-full phone:rounded-none phone:border-0">
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle>{t('panel.appsTitle', { name: bot.name })}</DialogTitle>
          <DialogDescription>{t('panel.appsHint')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 px-6 pb-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('panel.appsSearch')}
              aria-label={t('panel.appsSearch')}
              className="rounded-xl ps-9"
            />
          </div>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => all.mutate(true)}>
            {t('panel.appsAllOn')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => all.mutate(false)}>
            {t('panel.appsAllOff')}
          </Button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-6 pb-4">
          {shown.length === 0 && (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">{t('panel.appsNoMatch')}</p>
          )}
          {shown.map((c) => (
            <div key={c.id} className="flex items-center gap-3 rounded-2xl bg-secondary/60 px-3 py-2.5">
              <AppLogo id={c.catalogId} name={c.name} size={28} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{c.name}</div>
                {c.status !== 'connected' && (
                  <div className="truncate text-[13px] text-amber-600 dark:text-amber-400">
                    {c.status === 'error' ? t('apps.status.error') : t('apps.status.signedOut')}
                  </div>
                )}
              </div>
              <Switch
                checked={openTo(c, bot.id)}
                disabled={busy}
                onCheckedChange={(on) => toggle.mutate({ c, botId: bot.id, on })}
                aria-label={c.name}
              />
            </div>
          ))}
        </div>
        <div className="border-t px-6 py-3">
          <Button
            variant="ghost"
            className="rounded-full"
            onClick={() => {
              onOpenChange(false);
              openApps({ botId: bot.id });
            }}
          >
            <Plus /> {t('panel.appsConnectNew')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * The skills this bot may use, as one row: how many are on. The row opens a window with each
 * skill's switch, so a long library does not stretch the panel.
 */
function BotSkills({ bot }: { bot: Bot }) {
  const t = useT();
  const { data: skills = [] } = useSkills();
  const openSettings = useUi((s) => s.openSettings);
  const [open, setOpen] = useState(false);
  const on = skills.filter((k) => k.botIds.includes(bot.id));
  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <h4 className="text-sm font-semibold">{t('panel.skills')}</h4>
        <Button size="sm" variant="ghost" className="rounded-full" onClick={() => openSettings('skills')}>
          {skills.length ? (
            t('panel.manageSkills')
          ) : (
            <>
              <Plus /> {t('skills.new')}
            </>
          )}
        </Button>
      </div>
      {skills.length === 0 ? (
        <button
          onClick={() => openSettings('skills')}
          className="w-full rounded-2xl bg-secondary/60 px-4 py-3 text-start text-sm text-muted-foreground hover:bg-secondary"
        >
          {t('panel.noSkills')}
        </button>
      ) : (
        <button
          onClick={() => setOpen(true)}
          className="flex w-full items-center gap-3 rounded-2xl bg-secondary/60 px-3 py-2.5 text-start hover:bg-secondary"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-background text-muted-foreground">
            <Sparkles className="size-3.5" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">
              {t('panel.skillsOn', { on: on.length, total: skills.length })}
            </span>
            {on.length > 0 && (
              <span className="block truncate font-mono text-[13px] text-muted-foreground">
                {on.map((k) => k.name).join(', ')}
              </span>
            )}
          </span>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
        </button>
      )}
      <BotSkillsDialog bot={bot} open={open} onOpenChange={setOpen} />
    </section>
  );
}

/** Every skill with its switch for one bot, a search over them, and all on or off at once. */
function BotSkillsDialog({
  bot,
  open,
  onOpenChange,
}: {
  bot: Bot;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: skills = [] } = useSkills();
  const openSettings = useUi((s) => s.openSettings);
  const [query, setQuery] = useState('');
  const q = query.trim().toLocaleLowerCase();
  const shown = q
    ? skills.filter(
        (k) => k.name.toLocaleLowerCase().includes(q) || k.description.toLocaleLowerCase().includes(q),
      )
    : skills;
  const toggle = useMutation({
    mutationFn: (v: { id: string; on: boolean }) => api.setSkillBot(v.id, bot.id, v.on),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skills'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const all = useMutation({
    // One request per skill that changes, so skills already in the wanted state are left alone.
    mutationFn: async (on: boolean) => {
      for (const k of skills) {
        if (k.botIds.includes(bot.id) === on) continue;
        await api.setSkillBot(k.id, bot.id, on);
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['skills'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  // A taught skill runs again in the bot's browser without the model; one that stops partway can
  // be handed to the bot to finish, in the chat the person is in.
  const replayable = useBrowserAvailable() && bot.internet !== false;
  const openThread = useUi((s) => s.threadId);
  const finish = async (skill: Skill, r: ReplayResult) => {
    const threadId = openThread ?? (await api.mainThread(bot.id)).id;
    await api.send(
      threadId,
      newClientId(),
      t('replay.askBot', { name: skill.name, step: r.failedAt!.step, reason: r.failedAt!.reason }),
    );
  };
  const replay = useMutation({
    mutationFn: (skill: Skill) => api.replaySkill(bot.id, skill.id),
    onMutate: (skill) => toast(t('replay.running', { name: skill.name })),
    onSuccess: (r, skill) => {
      void qc.invalidateQueries({ queryKey: ['skills'] });
      if (r.ok) {
        toast.success(t('replay.done', { name: skill.name, total: r.total }));
        return;
      }
      toast.error(t('replay.stopped', { step: r.failedAt!.step, total: r.total }), {
        description: r.failedAt!.reason,
        duration: 20_000,
        action: {
          label: t('replay.askBotButton', { bot: bot.name }),
          onClick: () => void finish(skill, r).catch((e: Error) => toast.error(e.message)),
        },
      });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const busy = toggle.isPending || all.isPending;
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setQuery('');
        onOpenChange(o);
      }}
    >
      <DialogContent className="screen-edges flex h-[min(640px,85vh)] flex-col gap-0 overflow-hidden rounded-3xl p-0 sm:max-w-md phone:h-dvh phone:max-h-none phone:max-w-full phone:rounded-none phone:border-0">
        <DialogHeader className="px-6 pt-6 pb-3">
          <DialogTitle>{t('panel.skillsTitle', { name: bot.name })}</DialogTitle>
          <DialogDescription>{t('panel.skillsHint')}</DialogDescription>
        </DialogHeader>
        <div className="flex items-center gap-2 px-6 pb-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t('panel.skillsSearch')}
              aria-label={t('panel.skillsSearch')}
              className="rounded-xl ps-9"
            />
          </div>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => all.mutate(true)}>
            {t('panel.appsAllOn')}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => all.mutate(false)}>
            {t('panel.appsAllOff')}
          </Button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain px-6 pb-4">
          {shown.length === 0 && (
            <p className="px-1 py-6 text-center text-sm text-muted-foreground">{t('panel.skillsNoMatch')}</p>
          )}
          {shown.map((k) => (
            <div key={k.id} className="flex items-center gap-3 rounded-2xl bg-secondary/60 px-3 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-sm">{k.name}</div>
                <div className="truncate text-[13px] text-muted-foreground" title={k.description}>
                  {k.description}
                </div>
              </div>
              {replayable && k.steps?.length && k.botIds.includes(bot.id) ? (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-8 shrink-0 rounded-full"
                  disabled={replay.isPending}
                  onClick={() => replay.mutate(k)}
                  title={t('replay.run')}
                  aria-label={t('replay.runNamed', { name: k.name })}
                >
                  <Play />
                </Button>
              ) : null}
              <Switch
                checked={k.botIds.includes(bot.id)}
                disabled={busy}
                onCheckedChange={(on) => toggle.mutate({ id: k.id, on })}
                aria-label={k.name}
              />
            </div>
          ))}
        </div>
        <div className="border-t px-6 py-3">
          <Button
            variant="ghost"
            className="rounded-full"
            onClick={() => {
              onOpenChange(false);
              openSettings('skills');
            }}
          >
            <Plus /> {t('panel.skillsNew')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function BotFacts({ bot }: { bot: Bot }) {
  const t = useT();
  const { data: groups = [] } = useGroups();
  const qc = useQueryClient();
  const update = useMutation({
    mutationFn: (patch: BotUpdate) => api.updateBot(bot.id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['bots'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  const group = groups.find((g) => g.id === bot.groupId);
  const me = useSession().data?.user?.id;
  const places = placesFor(bot, groups, me, useManagesServer());
  const offered = (places ?? []).filter((g) => !!g);
  // The bot's own place stays named when the person may not move it.
  const options = group && !offered.some((g) => g.id === group.id) ? [group, ...offered] : offered;
  const toPlace = (g: string) => {
    const groupId = g === NO_GROUP ? null : g;
    const warning = moveWarning(bot, groupId, groups, t);
    if (warning && !confirm(warning)) return;
    update.mutate({ groupId });
  };
  return (
    <section className="space-y-1">
      <h4 className="mb-2 text-sm font-semibold">{t('panel.bot')}</h4>
      <Row icon={<Shield />} label={t('panel.permissions')}>
        <Select
          value={shownMode(bot.permissionMode)}
          onValueChange={(v) => update.mutate({ permissionMode: v as PermissionMode })}
        >
          <SelectTrigger size="sm" className="h-8 rounded-full border-0 bg-secondary">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {PERMISSION_MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {t(MODE_LABEL[m])}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      {/* An older server has no switch to show. */}
      {typeof bot.internet === 'boolean' && (
        <Row icon={<Globe />} label={t('panel.internet')}>
          <Switch
            checked={bot.internet}
            disabled={update.isPending}
            onCheckedChange={(internet) => update.mutate({ internet })}
            aria-label={t('panel.internet')}
            title={t('bot.internetHint')}
          />
        </Row>
      )}
      <Row icon={<FileText />} label={t('panel.group')}>
        <Select value={group?.id ?? NO_GROUP} onValueChange={toPlace} disabled={!places}>
          <SelectTrigger size="sm" className="h-8 max-w-[180px] rounded-full border-0 bg-secondary">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {(isMine(bot, me) || !group) && (
              <SelectItem value={NO_GROUP}>
                {bot.isManager ? t('panel.manager') : t('sidebar.private')}
              </SelectItem>
            )}
            {[...options.filter((g) => !isSpace(g)), ...options.filter(isSpace)].map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
    </section>
  );
}

const NO_GROUP = '__none__';

function Row({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex h-11 items-center gap-3 rounded-xl px-1 [&>svg]:size-4 [&>svg]:text-muted-foreground">
      {icon}
      <span className="flex-1 text-sm">{label}</span>
      {children}
    </div>
  );
}

function Library({ bot }: { bot: Bot }) {
  const t = useT();
  const { dayLabel, fileSize } = useFormat();
  const { data: files = [], isLoading } = useLibrary(bot.id);
  const preview = usePreview((s) => s.open);
  if (isLoading) return <p className="text-sm text-muted-foreground">{t('common.loading')}</p>;
  if (!files.length) {
    return (
      <p className="rounded-2xl bg-secondary/60 px-4 py-3 text-sm text-muted-foreground">
        {t('panel.noFiles')}
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      {files.map((f) => {
        const info = (
          <>
            <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-secondary">
              <FileText className="size-4" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{f.name}</span>
              <span className="block text-[13px] text-muted-foreground">
                {fileSize(f.size)} · {dayLabel(f.modifiedAt)}
              </span>
            </span>
          </>
        );
        const download = api.fileUrl(bot.id, f.path);
        // A file the app can show opens in place; the arrow beside it still downloads.
        return canPreview(f.name) ? (
          <div key={f.path} className="flex items-center rounded-2xl transition-colors hover:bg-accent">
            <button
              type="button"
              onClick={() => preview({ botId: bot.id, path: f.path, name: f.name, size: f.size })}
              className="flex min-w-0 flex-1 items-center gap-3 py-2.5 ps-3 text-start"
              aria-label={t('preview.open', { name: f.name })}
            >
              {info}
            </button>
            <a
              href={download}
              download
              className="flex size-9 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
              aria-label={t('message.download', { name: f.name })}
              title={t('message.download', { name: f.name })}
            >
              <Download className="size-4" />
            </a>
          </div>
        ) : (
          <a
            key={f.path}
            href={download}
            className="flex items-center gap-3 rounded-2xl px-3 py-2.5 transition-colors hover:bg-accent"
            download
          >
            {info}
            <Download className="size-4 text-muted-foreground" />
          </a>
        );
      })}
    </div>
  );
}
