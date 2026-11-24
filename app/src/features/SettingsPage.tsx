import {
  botNoteGroups,
  CONNECTION_CATALOG,
  describeSchedule,
  INTL_LOCALE,
  LOCALE_NAMES,
  LOCALES,
  STALE_MEMORY_DAYS,
  type BotNoteGroup,
  type Locale,
  type Memory,
  type ServerInfo,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AudioLines,
  Brain,
  ChartColumn,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Cpu,
  ExternalLink,
  ImageIcon,
  FileInput,
  Folder,
  FolderOpen,
  Info,
  KeyRound,
  Link2,
  Loader2,
  LogOut,
  MessageCircle,
  Plug,
  Shield,
  Smartphone,
  Sparkles,
  Volume2,
  SlidersHorizontal,
  Trash2,
  UserRound,
  Users,
  X,
} from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useLocale, useT, type MessageKey } from '@/i18n';
import { SERVER_TABS } from '@/lib/commands';
import { api } from '@/lib/api';
import { deviceName } from '@/lib/device';
import { useFormat } from '@/lib/format';
import { noteExpired, noteMatches, pinnedFirst, placeLabel, placeNoteGroups } from '@/lib/memoryNotes';
import { PHONE, useMedia } from '@/lib/media';
import {
  useBots,
  useConnections,
  useGroups,
  useInfo,
  useMemory,
  useRooms,
  useStaleMemory,
  useRoutineHealth,
  useRoutines,
  useRules,
  usePeople,
  useManagesServer,
  useSession,
  useSettings,
} from '@/lib/queries';
import { desktop, useDesktopServer } from '@/lib/desktop';
import { useUi, type SettingsTab } from '@/lib/store';
import { NoteSource } from './NoteSource';
import { LearnSetting, MemoryHistory, NoteRow } from './MemoryNote';
import { MemoryMap } from './MemoryMap';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  allowNotifications,
  chime,
  NOTIFY_LEVELS,
  SOUND_KINDS,
  notificationsSupported,
  testNotification,
  useNotify,
  type NotifyLevel,
} from '@/lib/notify';
import {
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  SPEECH_RATE_STEP,
  speechSupported,
  useServerVoice,
  useSpeech,
} from '@/lib/speech';
import { Slider } from '@/components/ui/slider';
import { useSendKey, type SendKey } from '@/lib/sendKey';
import { TONES, useTheme, type ThemeChoice, type ToneChoice } from '@/lib/theme';
import { DIM_MAX, DIM_MIN, type OwnBubble, useWallpaper, WallpaperError } from '@/lib/wallpaper';
import {
  useChatWidth,
  useDensity,
  useFont,
  type ChatWidth,
  type Density,
  type FontChoice,
} from '@/lib/density';
import { ruleLabel } from '@/lib/ruleLabel';
import { appsHit, settingsMatch } from '@/lib/settingsMatch';
import { useZoom, ZOOMS } from '@/lib/zoom';
import { cn } from '@/lib/utils';
import { ChannelsTab, useChannelTitle } from './ChannelsTab';
import { AiServicesTab } from './AiServicesTab';
import { MemoryFlags } from './MemoryFlags';
import { PendingMemory } from './PendingMemory';
import { ImportTab } from './ImportTab';
import { ProfileTab } from './ProfileTab';
import { SkillsTab } from './SkillsTab';
import { UsageTab } from './UsageTab';
import { VaultTab } from './VaultTab';
import { PeopleTab, personName, personNameOf } from './PeopleTab';
import { AccountForm } from './AccountSetup';
import { ApnsCard } from './PhoneSettings';
import { TailscaleCard } from './TailscaleSettings';
import { DoctorCard } from './DoctorCard';
import { HealthStatus, needsAttention } from './RoutineHealth';
import { ProvidersTab, useProviderTitle } from './ProvidersTab';

/**
 * The settings sections in groups, so a long list reads as a few short ones: what is the person's
 * own, the AI the bots think with, what the bots do, who may reach what, and the server itself.
 * The first group has no heading; it is what most people come for.
 */
type TabGroup = 'own' | 'ai' | 'bots' | 'access' | 'server';
const TABS: { id: SettingsTab; icon: React.ReactNode; group: TabGroup }[] = [
  { id: 'profile', icon: <UserRound />, group: 'own' },
  { id: 'general', icon: <SlidersHorizontal />, group: 'own' },
  { id: 'providers', icon: <Cpu />, group: 'ai' },
  { id: 'services', icon: <AudioLines />, group: 'ai' },
  { id: 'memory', icon: <Brain />, group: 'ai' },
  { id: 'routines', icon: <Clock />, group: 'bots' },
  { id: 'skills', icon: <Sparkles />, group: 'bots' },
  { id: 'channels', icon: <MessageCircle />, group: 'bots' },
  { id: 'groups', icon: <Folder />, group: 'bots' },
  { id: 'people', icon: <Users />, group: 'access' },
  { id: 'permissions', icon: <Shield />, group: 'access' },
  { id: 'vault', icon: <KeyRound />, group: 'access' },
  { id: 'connection', icon: <Link2 />, group: 'server' },
  { id: 'import', icon: <FileInput />, group: 'server' },
  { id: 'usage', icon: <ChartColumn />, group: 'server' },
  { id: 'about', icon: <Info />, group: 'server' },
];

/** Every time zone the browser knows, for the searchable list. */
const ZONES: string[] = (() => {
  try {
    return [...Intl.supportedValuesOf('timeZone'), 'UTC'];
  } catch {
    return ['Europe/Istanbul', 'Europe/London', 'America/New_York', 'Asia/Tokyo', 'UTC'];
  }
})();

const deviceZone = (() => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return '';
  }
})();

/** The bots' time zone: typed with suggestions from the full list; the device's zone is offered. */
function TimeZoneField({ value, onChange }: { value: string; onChange(zone: string): void }) {
  const t = useT();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? value;
  const commit = () => {
    if (draft === null) return;
    const zone = ZONES.find((z) => z.toLowerCase() === draft.trim().toLowerCase());
    if (zone && zone !== value) onChange(zone);
    setDraft(null);
  };
  return (
    <div className="flex flex-col items-end gap-1">
      <Input
        list="time-zones"
        value={shown}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) commit();
          if (e.key === 'Escape') setDraft(null);
        }}
        aria-label={t('general.timezone')}
        className="w-56 rounded-full"
      />
      <datalist id="time-zones">
        {ZONES.map((z) => (
          <option key={z} value={z} />
        ))}
      </datalist>
      {deviceZone && deviceZone !== value && ZONES.includes(deviceZone) && (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground hover:underline"
          onClick={() => onChange(deviceZone)}
        >
          {t('general.useDeviceZone', { zone: deviceZone })}
        </button>
      )}
    </div>
  );
}

/** A dialog, menu or open list over the settings: Escape is theirs to close, not the settings'. */
const OVER_SETTINGS =
  '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-radix-popper-content-wrapper]';

/**
 * The settings, as a page over the whole window rather than a box over the chat: fifteen
 * sections, several of them long lists of cards, need the room. What lies under stays mounted,
 * so leaving the settings comes back to the same conversation, scrolled where it was.
 */
export function SettingsPage() {
  const t = useT();
  const tab = useUi((s) => s.settingsTab);
  const open = useUi((s) => s.openSettings);
  const close = () => open(null);
  const manages = useManagesServer();
  // Until the session is known, every section shows, as it did with a single account.
  const known = !!useSession().data?.user;
  const tabs = TABS.filter((tb) => !known || manages || !SERVER_TABS.has(tb.id));
  const current = tabs.find((t) => t.id === tab) ?? tabs[0]!;
  // A provider's or a chat app's own page puts its name after the section's in the title.
  const view = useUi((s) => s.settingsView);
  const providerName = useProviderTitle(current.id === 'providers' ? view : null);
  const channelName = useChannelTitle(current.id === 'channels' ? view : null);
  const viewTitle =
    current.id === 'providers' ? providerName : current.id === 'channels' ? channelName : null;
  const toSection = () => useUi.setState({ settingsView: null });
  // A phone shows one of two screens: the list of sections, or the section picked from it.
  const phone = useMedia(PHONE);
  const listing = useUi((s) => s.settingsList) && phone;
  const toList = () => useUi.setState({ settingsList: true });
  // The list narrows to the sections whose name or contents match what is typed.
  const [find, setFind] = useState('');
  const shownTabs = tabs.filter((tb) =>
    settingsMatch(find, `${t(`settings.tab.${tb.id}`)} ${t(`settings.keywords.${tb.id}`)}`),
  );
  // MCP servers and apps live in their own window; a search that names them leads there.
  const { data: connections = [] } = useConnections();
  const appsFound = appsHit(
    find,
    t('settings.keywords.apps'),
    CONNECTION_CATALOG,
    connections.map((c) => c.name),
  );
  const openAppsFound = () => {
    if (!appsFound) return;
    close();
    useUi.getState().openApps({ botId: null, catalogId: appsFound.catalogId ?? undefined });
  };
  // ⌘, / Ctrl+, opens the settings, as in most desktop apps; again closes them.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        open(useUi.getState().settingsTab ? null : 'general');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  const isOpen = !!tab;
  // Escape leaves the settings, unless something open over them takes it first.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
      if (document.querySelector(OVER_SETTINGS)) return;
      if ((e.target as HTMLElement | null)?.getAttribute('aria-expanded') === 'true') return;
      open(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, open]);
  // Opening starts at the search box (a phone waits for a tap, or its keyboard would cover the
  // list); closing gives the focus back to where it was, as a dialog would.
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!isOpen) return;
    const before = document.activeElement as HTMLElement | null;
    if (!phone) searchRef.current?.focus();
    return () => before?.focus?.();
    // Only on opening and closing; a phone turning sideways does not move the focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);
  if (!isOpen) return null;
  return (
    <div
      role="region"
      aria-label={t('settings.title')}
      className="screen-edges sidebar-top fixed inset-0 z-40 flex animate-in bg-background duration-150 fade-in-0 phone:flex-col"
    >
      {(!phone || listing) && (
        <nav className="scroll-thin flex shrink-0 flex-col gap-1 overflow-y-auto bg-sidebar px-3 pb-3 phone:min-h-0 phone:flex-1 roomy:w-64 roomy:border-e">
          {/* Room for the window buttons; empty in a browser. */}
          <div className="window-drag h-12 shrink-0 phone:hidden" />
          {/* The title goes back as well as the arrow: it is the larger mark, and where a hand reaches for. */}
          <h1 className="flex shrink-0 pb-3 phone:pt-1">
            <Button
              variant="ghost"
              onClick={close}
              title={t('settings.close')}
              className="h-9 gap-1 ps-2 pe-3 text-base font-semibold phone:text-lg"
            >
              <ChevronLeft className="size-5 rtl:-scale-x-100" />
              {t('settings.title')}
            </Button>
          </h1>
          <Input
            ref={searchRef}
            value={find}
            onChange={(e) => setFind(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
              if (shownTabs[0]) open(shownTabs[0].id);
              else openAppsFound();
            }}
            placeholder={t('settings.search')}
            aria-label={t('settings.search')}
            className="mb-2 h-8 shrink-0 rounded-full text-sm phone:h-10 phone:text-base"
          />
          {shownTabs.map((tb, i) => (
            <Fragment key={tb.id}>
              {tb.group !== 'own' && tb.group !== shownTabs[i - 1]?.group && (
                <h2 className="shrink-0 px-3 pt-4 pb-1 text-xs font-medium text-muted-foreground phone:text-sm">
                  {t(`settings.group.${tb.group}`)}
                </h2>
              )}
              <button
                onClick={() => open(tb.id)}
                aria-current={!phone && current.id === tb.id ? 'page' : undefined}
                className={cn(
                  'flex shrink-0 items-center gap-3 rounded-xl px-3 py-2 text-sm whitespace-nowrap transition-colors hover:bg-accent [&>svg]:size-4 phone:py-3 phone:text-base',
                  !phone && current.id === tb.id && 'bg-accent font-medium',
                )}
              >
                {tb.icon}
                <span className="flex-1 text-start">{t(`settings.tab.${tb.id}`)}</span>
                {phone && <ChevronRight className="text-muted-foreground rtl:-scale-x-100" />}
              </button>
            </Fragment>
          ))}
          {appsFound && (
            <button
              onClick={openAppsFound}
              className="flex shrink-0 items-center gap-3 rounded-xl px-3 py-2 text-sm whitespace-nowrap transition-colors hover:bg-accent [&>svg]:size-4 phone:py-3 phone:text-base"
            >
              <Plug />
              <span className="flex-1 truncate text-start">
                {appsFound.name
                  ? t('settings.appsResultFor', { name: appsFound.name })
                  : t('settings.appsResult')}
              </span>
              <ExternalLink className="text-muted-foreground" />
            </button>
          )}
        </nav>
      )}
      {!listing && (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {phone ? (
            // The section's own title bar, with the way back to the list.
            <div className="flex h-14 shrink-0 items-center border-b bg-sidebar px-1">
              <h1 className="flex min-w-0">
                <Button
                  variant="ghost"
                  onClick={viewTitle ? toSection : toList}
                  title={viewTitle ? t(`settings.tab.${current.id}`) : t('settings.back')}
                  className="h-10 min-w-0 gap-1 ps-2 pe-3 text-lg font-semibold"
                >
                  <ChevronLeft className="size-5 rtl:-scale-x-100" />
                  <span className="truncate">{viewTitle ?? t(`settings.tab.${current.id}`)}</span>
                </Button>
              </h1>
            </div>
          ) : (
            <div className="window-drag h-12 shrink-0" />
          )}
          {/* Keyed by the section, so another section starts at its top. */}
          <div
            key={current.id}
            className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4 roomy:px-8 roomy:pt-2 roomy:pb-12"
          >
            <div className="mx-auto w-full max-w-3xl">
              <h2 className="mb-6 flex min-w-0 items-center gap-2 text-2xl font-semibold phone:hidden">
                {viewTitle ? (
                  <>
                    <button
                      type="button"
                      onClick={toSection}
                      className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {t(`settings.tab.${current.id}`)}
                    </button>
                    <ChevronRight className="size-5 shrink-0 text-muted-foreground rtl:-scale-x-100" />
                    <span className="truncate">{viewTitle}</span>
                  </>
                ) : (
                  t(`settings.tab.${current.id}`)
                )}
              </h2>
              {current.id === 'profile' && <ProfileTab />}
              {current.id === 'people' && <PeopleTab />}
              {current.id === 'general' && <General />}
              {current.id === 'providers' && <ProvidersTab />}
              {current.id === 'connection' && <Connection />}
              {current.id === 'channels' && <ChannelsTab />}
              {current.id === 'permissions' && <Permissions />}
              {current.id === 'vault' && <VaultTab />}
              {current.id === 'memory' && <MemoryTab />}
              {current.id === 'services' && <AiServicesTab />}
              {current.id === 'routines' && <RoutinesTab />}
              {current.id === 'skills' && <SkillsTab />}
              {current.id === 'groups' && <GroupsTab />}
              {current.id === 'import' && <ImportTab />}
              {current.id === 'usage' && <UsageTab />}
              {current.id === 'about' && <About />}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/** What this device shows as notifications while the person looks elsewhere. */
function Notifications() {
  const t = useT();
  const level = useNotify((s) => s.level);
  const setLevel = useNotify((s) => s.setLevel);
  const sound = useNotify((s) => s.sound);
  const setSound = useNotify((s) => s.setSound);
  const [permission, setPermission] = useState(() =>
    notificationsSupported() ? Notification.permission : 'denied',
  );
  const choose = async (next: NotifyLevel) => {
    setLevel(next);
    if (next !== 'off') {
      await allowNotifications();
      setPermission(Notification.permission);
    }
  };
  const hint = !notificationsSupported()
    ? t('notify.unsupported')
    : permission === 'denied'
      ? t('notify.blocked')
      : t('notify.hint');
  return (
    <Card title={t('notify.title')}>
      <Row label={t('notify.level')} hint={hint}>
        <Select value={level} onValueChange={(v) => void choose(v as NotifyLevel)}>
          <SelectTrigger className="w-56 rounded-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {NOTIFY_LEVELS.map((l) => (
              <SelectItem key={l} value={l}>
                {t(`notify.level.${l}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Row>
      <Row label={t('notify.sound')} hint={t('notify.soundHint')}>
        <Switch
          checked={sound}
          onCheckedChange={(on) => {
            setSound(on);
            if (on) chime();
          }}
          aria-label={t('notify.sound')}
        />
      </Row>
      {sound && (
        <Row label={t('notify.soundListen')}>
          <div className="flex flex-wrap justify-end gap-1">
            {SOUND_KINDS.map((k) => (
              <Button key={k} variant="ghost" size="sm" className="rounded-full" onClick={() => chime(k)}>
                <Volume2 /> {t(`notify.soundKind.${k}`)}
              </Button>
            ))}
          </div>
        </Row>
      )}
      {notificationsSupported() && (
        <Row label={t('notify.test')}>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            onClick={async () => {
              if (await allowNotifications()) testNotification();
              setPermission(Notification.permission);
            }}
          >
            {t('notify.testButton')}
          </Button>
        </Row>
      )}
    </Card>
  );
}

export function Card({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      {title && <h3 className="mb-2 px-1 text-sm font-medium text-muted-foreground">{title}</h3>}
      <div className="divide-y rounded-2xl border bg-card/50">{children}</div>
    </section>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children?: React.ReactNode }) {
  return (
    <div className="flex min-h-14 flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
      <div className="min-w-40 flex-1">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: api.updateSettings,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
    onError: (e) => toast.error((e as Error).message),
  });
}

/** In the desktop app: whether it opens, and the server with it, when the person logs in. */
function OpenAtLogin() {
  const t = useT();
  const [on, setOn] = useState<boolean | null>(null);
  useEffect(() => {
    void desktop
      ?.openAtLogin?.()
      .then(setOn)
      .catch(() => setOn(null));
  }, []);
  if (!desktop?.openAtLogin || on === null) return null;
  return (
    <Card title={t('general.desktop')}>
      <Row label={t('general.openAtLogin')} hint={t('general.openAtLoginHint')}>
        <Switch
          checked={on}
          onCheckedChange={(v) =>
            void desktop
              ?.openAtLogin?.(v)
              .then(setOn)
              .catch((e: Error) => toast.error(e.message))
          }
        />
      </Row>
    </Card>
  );
}

/** A picture of the person's own behind the sidebar and the chat, and how much it is dimmed. */
function WallpaperRows() {
  const t = useT();
  const url = useWallpaper((s) => s.url);
  const dim = useWallpaper((s) => s.dim);
  const blur = useWallpaper((s) => s.blur);
  const ownBubble = useWallpaper((s) => s.ownBubble);
  const { choose, remove, setDim, setBlur, setOwnBubble } = useWallpaper.getState();
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const pick = async (picked: File) => {
    setBusy(true);
    try {
      await choose(picked);
    } catch (e) {
      toast.error(
        e instanceof WallpaperError && e.reason === 'tooLarge'
          ? t('general.wallpaper.tooLarge')
          : t('general.wallpaper.unreadable'),
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Row label={t('general.wallpaper')} hint={t('general.wallpaperHint')}>
        <input
          ref={file}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const picked = e.target.files?.[0];
            e.target.value = '';
            if (picked) void pick(picked);
          }}
        />
        <div className="flex items-center gap-2">
          {url && <img src={url} alt="" className="h-9 w-14 rounded-md border object-cover" />}
          <Button
            type="button"
            variant="secondary"
            className="rounded-full"
            disabled={busy}
            onClick={() => file.current?.click()}
          >
            {busy ? <Loader2 className="animate-spin" /> : <ImageIcon />}
            {url ? t('general.wallpaper.change') : t('general.wallpaper.choose')}
          </Button>
          {url && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="rounded-full"
              aria-label={t('general.wallpaper.remove')}
              title={t('general.wallpaper.remove')}
              onClick={() => void remove()}
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </Row>
      {url && (
        <Row label={t('general.wallpaperDim')} hint={t('general.wallpaperDimHint')}>
          <div className="flex w-56 items-center gap-3">
            <Slider
              min={DIM_MIN}
              max={DIM_MAX}
              step={5}
              value={[dim]}
              onValueChange={([v]) => setDim(v ?? dim)}
              aria-label={t('general.wallpaperDim')}
            />
            <span className="w-12 shrink-0 text-end text-sm tabular-nums text-muted-foreground">{`${dim}%`}</span>
          </div>
        </Row>
      )}
      {url && (
        <Row label={t('general.wallpaperBlur')} hint={t('general.wallpaperBlurHint')}>
          <Switch checked={blur} onCheckedChange={setBlur} aria-label={t('general.wallpaperBlur')} />
        </Row>
      )}
      {url && (
        <Row label={t('general.wallpaperOwnBubble')} hint={t('general.wallpaperOwnBubbleHint')}>
          <Select value={ownBubble} onValueChange={(v) => setOwnBubble(v as OwnBubble)}>
            <SelectTrigger className="w-44 rounded-full" aria-label={t('general.wallpaperOwnBubble')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="glass">{t('general.wallpaperOwnBubble.glass')}</SelectItem>
              <SelectItem value="solid">{t('general.wallpaperOwnBubble.solid')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      )}
    </>
  );
}

function General() {
  const t = useT();
  const manages = useManagesServer();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const theme = useTheme();
  const locale = useLocale((s) => s.locale);
  const setLocale = useLocale((s) => s.setLocale);
  const missing = useLocale((s) => s.missing);
  const font = useFont((s) => s.font);
  const setFont = useFont((s) => s.set);
  const chatWidth = useChatWidth((s) => s.width);
  const setChatWidth = useChatWidth((s) => s.set);
  const density = useDensity((s) => s.density);
  const setDensity = useDensity((s) => s.set);
  const zoom = useZoom((s) => s.zoom);
  const setZoom = useZoom((s) => s.setZoom);
  const sendKey = useSendKey((s) => s.key);
  const setSendKey = useSendKey((s) => s.set);
  const speechRate = useSpeech((s) => s.rate);
  const setSpeechRate = useSpeech((s) => s.setRate);
  const serverVoice = useServerVoice();
  const changeLanguage = (language: Locale) => {
    setLocale(language, { unsaved: true });
    save.mutate({ language }, { onSuccess: () => useLocale.setState({ unsaved: false }) });
  };
  return (
    <>
      <OpenAtLogin />
      <Card title={t('general.appearance')}>
        <Row label={t('general.theme')}>
          <Select value={theme.choice} onValueChange={(v) => theme.setChoice(v as ThemeChoice)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="system">{t('general.theme.system')}</SelectItem>
              <SelectItem value="light">{t('general.theme.light')}</SelectItem>
              <SelectItem value="dark">{t('general.theme.dark')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('general.tone')}>
          <Select value={theme.tone} onValueChange={(v) => theme.setTone(v as ToneChoice)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TONES.map((tone) => (
                <SelectItem key={tone} value={tone}>
                  {t(`general.tone.${tone}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <WallpaperRows />
        <Row label={t('general.font')}>
          <Select value={font} onValueChange={(v) => setFont(v as FontChoice)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="default">{t('general.font.default')}</SelectItem>
              <SelectItem value="system">{t('general.font.system')}</SelectItem>
              <SelectItem value="serif">{t('general.font.serif')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('general.chatWidth')} hint={t('general.chatWidthHint')}>
          <Select value={chatWidth} onValueChange={(v) => setChatWidth(v as ChatWidth)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="normal">{t('general.chatWidth.normal')}</SelectItem>
              <SelectItem value="wide">{t('general.chatWidth.wide')}</SelectItem>
              <SelectItem value="full">{t('general.chatWidth.full')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('general.density')} hint={t('general.densityHint')}>
          <Select value={density} onValueChange={(v) => setDensity(v as Density)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="comfortable">{t('general.density.comfortable')}</SelectItem>
              <SelectItem value="compact">{t('general.density.compact')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('general.zoom')} hint={t('general.zoomHint')}>
          <Select value={String(zoom)} onValueChange={(v) => setZoom(Number(v))}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ZOOMS.map((z) => (
                <SelectItem key={z} value={String(z)}>
                  {Math.round(z * 100)}%
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label={t('common.language')} hint={t('general.languageHint')}>
          <Select value={locale} onValueChange={(v) => changeLanguage(v as Locale)}>
            <SelectTrigger className="w-44 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LOCALES.map((l) => (
                <SelectItem key={l} value={l} lang={l}>
                  {LOCALE_NAMES[l]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        {missing ? (
          <p className="px-4 pb-3 text-xs leading-relaxed text-muted-foreground">
            {t('settings.partialLanguage')}
          </p>
        ) : null}
      </Card>
      <Card title={t('general.behavior')}>
        <Row label={t('general.sendKey')} hint={t('general.sendKeyHint')}>
          <Select value={sendKey} onValueChange={(v) => setSendKey(v as SendKey)}>
            <SelectTrigger className="w-56 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="enter">{t('general.sendKey.enter')}</SelectItem>
              <SelectItem value="mod">{t('general.sendKey.mod')}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
        {(serverVoice || speechSupported()) && (
          <Row label={t('general.speechRate')} hint={t('general.speechRateHint')}>
            <div className="flex w-56 items-center gap-3">
              <Slider
                min={SPEECH_RATE_MIN}
                max={SPEECH_RATE_MAX}
                step={SPEECH_RATE_STEP}
                value={[speechRate]}
                onValueChange={([v]) => setSpeechRate(v ?? 1)}
                aria-label={t('general.speechRate')}
              />
              <button
                type="button"
                onClick={() => setSpeechRate(1)}
                title={t('general.speechRateReset')}
                className="w-12 shrink-0 text-end text-sm tabular-nums text-muted-foreground hover:text-foreground"
              >
                {`${speechRate.toLocaleString(INTL_LOCALE[locale], { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`}
              </button>
            </div>
          </Row>
        )}
      </Card>
      <Notifications />
      {manages && (
        <Card title={t('general.bots')}>
          <Row label={t('general.timezone')} hint={t('general.timezoneHint')}>
            <TimeZoneField
              value={settings?.timezone ?? 'Europe/Istanbul'}
              onChange={(timezone) => save.mutate({ timezone })}
            />
          </Row>
          {settings?.modelTitles !== undefined && (
            <Row label={t('general.modelTitles')} hint={t('general.modelTitlesHint')}>
              <Switch
                checked={settings.modelTitles}
                onCheckedChange={(v) => save.mutate({ modelTitles: v })}
                aria-label={t('general.modelTitles')}
              />
            </Row>
          )}
          {settings?.workOffers !== undefined && (
            <Row label={t('general.workOffers')} hint={t('general.workOffersHint')}>
              <Switch
                checked={settings.workOffers}
                onCheckedChange={(v) => save.mutate({ workOffers: v })}
                aria-label={t('general.workOffers')}
              />
            </Row>
          )}
        </Card>
      )}
    </>
  );
}

function Connection() {
  const t = useT();
  const { data: info } = useInfo();
  const setAuthed = useUi((s) => s.setAuthed);
  const logout = useMutation({ mutationFn: api.logout, onSettled: () => setAuthed(false) });
  // Everyone keeps their own account, devices and sign-out here; the server's environment is for
  // those who look after the server. The AI providers have their own section.
  const manages = useManagesServer();
  return (
    <>
      {manages && (
        <Card title={t('connection.environment')}>
          <ShellSandboxRow sandbox={info?.shellSandbox} />
          <BrowserRow browser={info?.browser} />
          <EgressRow egress={info?.egress} />
        </Card>
      )}
      <Card title={t('connection.server')}>
        <Row label={t('connection.address')} hint={window.location.origin} />
        <DesktopServerRow />
        <Row label={t('connection.version')} hint={info?.version ?? '…'} />
        <AccountRow />
        <Row label={t('connection.logoutHere')}>
          <Button variant="secondary" size="sm" className="rounded-full" onClick={() => logout.mutate()}>
            <LogOut /> {t('connection.logout')}
          </Button>
        </Row>
      </Card>
      <PairDevice />
      <Devices />
      <TailscaleCard />
      {manages && <ApnsCard />}
    </>
  );
}

/**
 * A one-time code for signing in a phone or another computer, typed there instead of the password.
 * It works once, within five minutes; the address is the one the other device reaches this
 * server at.
 */
function PairDevice() {
  const t = useT();
  const qc = useQueryClient();
  const [pairing, setPairing] = useState<{ code: string; expiresAt: string; url: string | null } | null>(
    null,
  );
  const [now, setNow] = useState(() => Date.now());
  const make = useMutation({
    mutationFn: api.pairingCode,
    onSuccess: (p) => {
      setPairing(p);
      setNow(Date.now());
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const left = pairing ? Math.max(0, Math.round((Date.parse(pairing.expiresAt) - now) / 1000)) : 0;
  useEffect(() => {
    if (!pairing || left <= 0) return;
    const timer = setTimeout(() => {
      setNow(Date.now());
      // A device that used the code shows up in the list below.
      void qc.invalidateQueries({ queryKey: ['sessions'] });
    }, 1000);
    return () => clearTimeout(timer);
  }, [pairing, left, qc]);
  const address = pairing?.url ?? window.location.origin;
  return (
    <Card title={t('pair.title')}>
      <Row label={t('pair.label')} hint={t('pair.hint')}>
        <Button
          variant="secondary"
          size="sm"
          className="rounded-full"
          onClick={() => make.mutate()}
          disabled={make.isPending}
        >
          {make.isPending ? <Loader2 className="animate-spin" /> : <Smartphone />}
          {pairing && left > 0 ? t('pair.again') : t('pair.make')}
        </Button>
      </Row>
      {pairing && left > 0 && (
        <div className="space-y-2 px-4 pb-4">
          <div className="flex flex-wrap items-center gap-3">
            <code className="rounded-xl bg-secondary px-4 py-2 font-mono text-2xl tracking-widest">
              {pairing.code}
            </code>
            <span className="text-xs text-muted-foreground">
              {t('pair.left', {
                minutes: String(Math.floor(left / 60)),
                seconds: String(left % 60).padStart(2, '0'),
              })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t('pair.where', { address })}</p>
        </div>
      )}
    </Card>
  );
}

/** The username and password browsers sign in with; hidden on servers older than accounts. */
function AccountRow() {
  const t = useT();
  const { data, isError } = useQuery({ queryKey: ['account'], queryFn: api.account, retry: false });
  const [open, setOpen] = useState(false);
  if (isError || !data) return null;
  return (
    <div>
      <Row label={t('account.title')} hint={data.username ?? t('account.none')}>
        <Button variant="secondary" size="sm" className="rounded-full" onClick={() => setOpen((v) => !v)}>
          {data.username ? t('account.change') : t('account.create')}
        </Button>
      </Row>
      {open && (
        <div className="max-w-sm px-4 pb-4">
          <AccountForm
            username={data.username ?? ''}
            change={data.username !== null}
            onDone={() => {
              setOpen(false);
              toast.success(t('account.saved'));
            }}
          />
        </div>
      )}
    </div>
  );
}

/** The browsers and apps signed in to this server, each of which can be signed out from here. */
function Devices() {
  const t = useT();
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const { data: sessions } = useQuery({ queryKey: ['sessions'], queryFn: api.sessions });
  const end = useMutation({
    mutationFn: api.endSession,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!sessions?.length) return null;
  const others = sessions.filter((s) => !s.current).length;
  return (
    <Card title={t('devices.title')}>
      {sessions.map((s) => {
        const { app, os } = deviceName(s.userAgent);
        const name = app && os ? t('devices.appOnOs', { app, os }) : (app ?? os ?? t('devices.unknown'));
        return (
          <Row key={s.id} label={name} hint={t('devices.lastSeen', { when: dayLabel(s.lastSeenAt) })}>
            {s.current ? (
              <span className="text-xs text-muted-foreground">{t('devices.this')}</span>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="rounded-full"
                disabled={end.isPending}
                onClick={() => end.mutate(s.id)}
              >
                {t('devices.signOut')}
              </Button>
            )}
          </Row>
        );
      })}
      <Row label={t('devices.othersHint')}>
        {others > 1 && (
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={end.isPending}
            onClick={() => end.mutate('others')}
          >
            {t('devices.signOutOthers')}
          </Button>
        )}
      </Row>
    </Card>
  );
}

/** In the desktop app: switch this window to another server, or back to the one on this computer. */
function DesktopServerRow() {
  const t = useT();
  const server = useDesktopServer();
  if (!desktop?.openConnect || !server) return null;
  return (
    <Row
      label={t('connection.connectedTo')}
      hint={server.mode === 'local' ? t('connection.thisComputer') : (server.url ?? '')}
    >
      <Button
        variant="secondary"
        size="sm"
        className="rounded-full"
        onClick={() => void desktop!.openConnect?.()}
      >
        {t('connection.connectOther')}
      </Button>
      {server.mode === 'remote' && (
        <Button
          variant="secondary"
          size="sm"
          className="rounded-full"
          onClick={() => void desktop!.useLocal()}
        >
          {t('connection.useLocal')}
        </Button>
      )}
    </Row>
  );
}

function Permissions() {
  const t = useT();
  const f = useFormat();
  const { data: rules = [] } = useRules();
  const { data: connections = [] } = useConnections();
  const { data: bots = [] } = useBots();
  const apps = new Map(connections.map((c) => [c.slug, c.name]));
  const botNames = new Map(bots.map((b) => [b.id, b.name]));
  const qc = useQueryClient();
  const [pattern, setPattern] = useState('');
  const [list, setList] = useState<'ask' | 'allow' | 'block'>('ask');
  // An amount limit is optional; both parts or neither go with the rule.
  const [field, setField] = useState('');
  const [limit, setLimit] = useState('');
  const limitNumber = limit.trim() ? Number(limit.trim().replace(',', '.')) : null;
  const limitBad = !!limit.trim() && (!Number.isFinite(limitNumber) || (limitNumber ?? 0) < 0);
  const limited = !!field.trim() && limitNumber !== null && !limitBad;
  // The bot a rule is for ('all': every bot), and whether its step needs a second person's yes.
  const [forBot, setForBot] = useState('all');
  const [second, setSecond] = useState(false);
  const [secondUser, setSecondUser] = useState('anyone');
  const { data: people = [] } = usePeople();
  // Offered only when at least one other person could give that yes.
  const { data: approvers = [] } = useQuery({
    queryKey: ['approvers', forBot],
    queryFn: () => api.approvers(forBot === 'all' ? null : forBot),
    enabled: list === 'ask',
    retry: false,
  });
  const secondOffered = list === 'ask' && approvers.length >= 2;
  const needsSecond = secondOffered && second;
  const add = useMutation({
    mutationFn: () =>
      api.addRule({
        list,
        pattern,
        ...(forBot !== 'all' && { botId: forBot }),
        ...(limited && { field: field.trim(), limit: limitNumber! }),
        ...(needsSecond && {
          secondPerson: true,
          ...(secondUser !== 'anyone' && { secondUserId: secondUser }),
        }),
      }),
    onSuccess: () => {
      setPattern('');
      setField('');
      setLimit('');
      setSecond(false);
      setSecondUser('anyone');
      void qc.invalidateQueries({ queryKey: ['rules'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // Half a limit would be dropped without a word; the rule waits until both parts are there.
  const limitIncomplete = !!field.trim() !== !!limit.trim() || limitBad;
  const remove = useMutation({
    mutationFn: api.removeRule,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['rules'] }),
  });
  const section = (l: 'ask' | 'allow' | 'block', title: MessageKey, hint: MessageKey) => (
    <Card title={t(title)}>
      <div className="px-4 py-3 text-xs text-muted-foreground">{t(hint)}</div>
      {rules
        .filter((r) => r.list === l)
        .map((r) => {
          // The readable name on top, the rule as it is matched under it, and the one bot it is for.
          const label = ruleLabel(r.pattern, t, apps);
          const forBotLabel = r.botId ? t('rules.forBot', { bot: botNames.get(r.botId) ?? r.botId }) : '';
          const bound =
            r.field && typeof r.limit === 'number'
              ? t(r.list === 'allow' ? 'rules.limitAllow' : 'rules.limitOver', {
                  field: r.field,
                  limit: f.number(r.limit),
                })
              : '';
          const twoKeys = r.secondPerson
            ? r.secondUserId
              ? t('rules.secondNamed', {
                  name: personNameOf(people, r.secondUserId, t('people.owner'), t('common.someone')),
                })
              : t('rules.secondOn')
            : '';
          const hint = [label ? r.pattern : '', bound, twoKeys, forBotLabel].filter(Boolean).join(' · ');
          return (
            <Row key={r.id} label={label ?? r.pattern} hint={hint || undefined}>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                onClick={() => remove.mutate(r.id)}
                aria-label={t('common.remove')}
              >
                <Trash2 className="size-4" />
              </Button>
            </Row>
          );
        })}
    </Card>
  );
  return (
    <>
      <form
        className="mb-6 space-y-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (pattern.trim() && !limitIncomplete) add.mutate();
        }}
      >
        <div className="flex gap-2">
          <Select value={list} onValueChange={(v) => setList(v as 'ask' | 'allow' | 'block')}>
            <SelectTrigger className="w-48 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">{t('rules.ask')}</SelectItem>
              <SelectItem value="allow">{t('rules.allow')}</SelectItem>
              <SelectItem value="block">{t('rules.block')}</SelectItem>
            </SelectContent>
          </Select>
          <Input
            value={pattern}
            onChange={(e) => setPattern(e.target.value)}
            placeholder={t('rules.placeholder')}
            className="flex-1 rounded-full"
          />
          <Button className="rounded-full" disabled={!pattern.trim() || limitIncomplete}>
            {t('common.add')}
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('rules.limit')}</span>
          <Input
            value={field}
            onChange={(e) => setField(e.target.value)}
            placeholder={t('rules.limitField')}
            aria-label={t('rules.limitField')}
            className="h-8 w-40 rounded-full"
          />
          <Input
            value={limit}
            onChange={(e) => setLimit(e.target.value)}
            inputMode="decimal"
            placeholder={t('rules.limitValue')}
            aria-label={t('rules.limitValue')}
            aria-invalid={limitBad || undefined}
            className="h-8 w-28 rounded-full"
          />
        </div>
        <p className={cn('text-xs', limitBad ? 'text-destructive' : 'text-muted-foreground')}>
          {t(limitBad ? 'rules.limitInvalid' : 'rules.limitHint')}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">{t('rules.forBotLabel')}</span>
          <Select
            value={forBot}
            onValueChange={(v) => {
              setForBot(v);
              setSecondUser('anyone');
            }}
          >
            <SelectTrigger className="h-8 w-48 rounded-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('rules.allBots')}</SelectItem>
              {bots.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {secondOffered && (
          <div className="space-y-1.5">
            <label className="flex items-center gap-2 text-sm">
              <Switch checked={second} onCheckedChange={setSecond} />
              {t('rules.second')}
            </label>
            {second && (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">{t('rules.secondWho')}</span>
                <Select value={secondUser} onValueChange={setSecondUser}>
                  <SelectTrigger className="h-8 w-56 rounded-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="anyone">{t('rules.secondAnyone')}</SelectItem>
                    {approvers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {personName({ displayName: p.name, username: null }, t('people.owner'))}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t('rules.secondHint')}</p>
          </div>
        )}
      </form>
      {section('ask', 'rules.ask', 'rules.askHint')}
      {section('allow', 'rules.allow', 'rules.allowHint')}
      {section('block', 'rules.block', 'rules.blockHint')}
    </>
  );
}

function MemoryTab() {
  const t = useT();
  const { dayLabel } = useFormat();
  const { data: memory = [] } = useMemory();
  const { data: bots = [] } = useBots();
  // Notes of an archived bot stay until deleted; its name tells them apart.
  const { data: archived = [] } = useQuery({ queryKey: ['bots', 'archived'], queryFn: api.archivedBots });
  const qc = useQueryClient();
  const { data: rooms = [] } = useRooms();
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  // The notes as lists, or as a map of how they hang together.
  const [view, setView] = useState<'list' | 'map'>('list');
  const refresh = () => qc.invalidateQueries({ queryKey: ['memory'] });
  // The server refuses a save over a note that changed meanwhile; the list is fetched again then.
  const save = useMutation({
    mutationFn: ({ m, patch }: { m: Memory; patch: { content?: string; validUntil?: string | null } }) =>
      api.updateMemory(m.id, { ...patch, ...(patch.content !== undefined && { updatedAt: m.updatedAt }) }),
    onSuccess: refresh,
    onError: (e) => {
      toast.error((e as Error).message);
      void refresh();
    },
  });
  const pin = useMutation({
    mutationFn: (m: Memory) => api.updateMemory(m.id, { pinned: !m.pinned }),
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const onSave = (m: Memory, patch: { content?: string; validUntil?: string | null }) =>
    save.mutateAsync({ m, patch });
  const clearBot = useMutation({
    mutationFn: api.removeBotMemory,
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const add = useMutation({
    mutationFn: () => api.addMemory({ scope: 'user', content: text }),
    onSuccess: () => {
      setText('');
      void refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // A deleted memory can be brought back for a moment, in case the wrong one went.
  const forget = useMutation({
    mutationFn: async (m: Memory) => {
      await api.removeMemory(m.id);
      return m;
    },
    onSuccess: (m) => {
      void refresh();
      // A place's note is written by the bots there, so it cannot be put back from here.
      const { scope } = m;
      if (scope === 'room') return;
      toast(t('memory.deleted'), {
        action: {
          label: t('memory.undo'),
          onClick: () =>
            void api
              .addMemory({
                scope,
                botId: m.botId,
                content: m.content,
                site: m.site,
                validUntil: m.validUntil,
              })
              // A pinned note comes back pinned, as it was.
              .then((back) => (m.pinned ? api.updateMemory(back.id, { pinned: true }) : back))
              .then(refresh)
              .catch((e: Error) => toast.error(e.message)),
        },
      });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const { data: stale = [] } = useStaleMemory();
  const clearStale = useMutation({
    mutationFn: () => api.removeStaleMemory(stale.map((m) => m.id)),
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const searching = query.trim() !== '';
  const hit = (m: Memory) => noteMatches(m, query);
  // A note past its "true until" date waits in its own list, not among the notes bots read.
  const now = new Date();
  const current = memory.filter((m) => !noteExpired(m, now));
  const expiredHits = memory.filter((m) => noteExpired(m, now) && hit(m));
  const user = pinnedFirst(current.filter((m) => m.scope === 'user' && hit(m)));
  const groups = botNoteGroups(current.filter(hit), bots, archived).map((g) => ({
    ...g,
    notes: pinnedFirst(g.notes),
  }));
  const roomGroups = placeNoteGroups(current.filter(hit), t, rooms);
  const staleHits = stale.filter(hit);
  const noteProps = {
    onSave,
    onPin: (m: Memory) => pin.mutate(m),
    onForget: (m: Memory) => forget.mutate(m),
  };
  const botName = (id: string | null) =>
    [...bots, ...archived].find((b) => b.id === id)?.name ?? t('common.bot');
  const name = (g: BotNoteGroup) => g.name ?? t('common.bot');
  // Each bot's notes stay folded until opened, so a long list reads as one line per bot.
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  return (
    <>
      <form
        className="mb-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) add.mutate();
        }}
      >
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={t('memory.placeholder')}
          className="flex-1 rounded-full"
        />
        <Button className="rounded-full" disabled={!text.trim()}>
          {t('common.add')}
        </Button>
      </form>
      <div className="mb-2">
        <Input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('memory.search')}
          aria-label={t('memory.search')}
          className="rounded-full"
        />
      </div>
      <p className="mb-6 px-1 text-xs text-muted-foreground">{t('memory.pinHint')}</p>
      <Tabs value={view} onValueChange={(v) => setView(v === 'map' ? 'map' : 'list')} className="mb-4">
        <TabsList>
          <TabsTrigger value="list">{t('memory.viewList')}</TabsTrigger>
          <TabsTrigger value="map">{t('memory.viewMap')}</TabsTrigger>
        </TabsList>
      </Tabs>
      <PendingMemory bots={[...bots, ...archived]} />
      <MemoryFlags bots={[...bots, ...archived]} />
      {expiredHits.length > 0 && (
        <Card title={t('memory.expired')}>
          <p className="px-4 py-3 text-xs text-muted-foreground">{t('memory.expiredHint')}</p>
          {expiredHits.map((m) => (
            <NoteRow
              key={m.id}
              m={m}
              hint={
                m.scope === 'user'
                  ? t('memory.staleShared')
                  : m.scope === 'room'
                    ? placeLabel(m.place, t, rooms)
                    : botName(m.botId)
              }
              {...noteProps}
            />
          ))}
        </Card>
      )}
      {staleHits.length > 0 && (
        <Card title={t('memory.stale')}>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
            <p className="min-w-40 flex-1 text-xs text-muted-foreground">
              {t('memory.staleHint', { days: STALE_MEMORY_DAYS })}
            </p>
            {stale.length > 1 && (
              <Button
                size="sm"
                variant="ghost"
                className="rounded-full"
                disabled={clearStale.isPending}
                onClick={() =>
                  confirm(t('memory.staleDeleteAllConfirm', { count: stale.length })) && clearStale.mutate()
                }
              >
                {t('memory.deleteAll')}
              </Button>
            )}
          </div>
          {staleHits.map((m) => (
            <Row
              key={m.id}
              label={m.site ? `${m.site} · ${m.content}` : m.content}
              hint={`${
                m.scope === 'user'
                  ? t('memory.staleShared')
                  : m.scope === 'room'
                    ? placeLabel(m.place, t, rooms)
                    : botName(m.botId)
              } · ${
                m.lastUsedAt
                  ? t('memory.lastUsed', { when: dayLabel(m.lastUsedAt) })
                  : t('memory.neverUsed', { when: dayLabel(m.updatedAt) })
              }`}
            >
              <NoteSource m={m} />
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                onClick={() => forget.mutate(m)}
                aria-label={t('common.delete')}
              >
                <Trash2 className="size-4" />
              </Button>
            </Row>
          ))}
        </Card>
      )}
      {view === 'map' ? (
        <MemoryMap
          notes={current.filter(hit)}
          bots={[...bots, ...archived]}
          rooms={rooms}
          noteProps={noteProps}
        />
      ) : (
        <>
          <Card title={t('memory.user')}>
            {user.length === 0 && (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                {t(searching ? 'memory.searchEmpty' : 'memory.empty')}
              </div>
            )}
            {user.map((m) => (
              <NoteRow key={m.id} m={m} {...noteProps} />
            ))}
          </Card>
          <Card title={t('memory.bots')}>
            {groups.length === 0 && (
              <div className="px-4 py-3 text-sm text-muted-foreground">
                {t(searching ? 'memory.searchEmpty' : 'memory.empty')}
              </div>
            )}
            {groups.map((g) => {
              // A search opens the bots with hits, so the notes found are in sight.
              const isOpen = searching || open.has(g.botId);
              return (
                <div key={g.botId}>
                  <div className="flex min-h-14 items-center gap-2 px-4 py-2">
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => toggle(g.botId)}
                      className="flex min-w-0 flex-1 items-center gap-3 text-start"
                    >
                      <ChevronRight
                        className={cn(
                          'size-4 shrink-0 text-muted-foreground transition-transform',
                          isOpen && 'rotate-90',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">
                          {g.archived ? t('memory.archivedBot', { name: name(g) }) : name(g)}
                        </span>
                        <span className="block text-xs text-muted-foreground">
                          {t('memory.noteCount', { count: g.notes.length })}
                        </span>
                      </span>
                    </button>
                    {isOpen && !searching && g.notes.length > 1 && (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="rounded-full"
                        disabled={clearBot.isPending}
                        onClick={() =>
                          confirm(t('memory.deleteAllConfirm', { name: name(g), count: g.notes.length })) &&
                          clearBot.mutate(g.botId)
                        }
                      >
                        {t('memory.deleteAll')}
                      </Button>
                    )}
                  </div>
                  {isOpen && (
                    <div className="divide-y border-t">
                      {g.notes.map((m) => (
                        <NoteRow key={m.id} m={m} {...noteProps} />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
          {roomGroups.length > 0 && (
            <Card title={t('memory.rooms')}>
              {!searching && (
                <p className="px-4 py-3 text-xs text-muted-foreground">{t('memory.roomsHint')}</p>
              )}
              {roomGroups.map((g) => {
                const isOpen = searching || open.has(g.place);
                return (
                  <div key={g.place}>
                    <button
                      type="button"
                      aria-expanded={isOpen}
                      onClick={() => toggle(g.place)}
                      className="flex min-h-14 w-full items-center gap-3 px-4 py-2 text-start"
                    >
                      <ChevronRight
                        className={cn(
                          'size-4 shrink-0 text-muted-foreground transition-transform',
                          isOpen && 'rotate-90',
                        )}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium">{g.label}</span>
                        <span className="block text-xs text-muted-foreground">
                          {t('memory.noteCount', { count: g.notes.length })}
                        </span>
                      </span>
                    </button>
                    {isOpen && (
                      <div className="divide-y border-t">
                        {g.notes.map((m) => (
                          <NoteRow key={m.id} m={m} {...noteProps} />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
            </Card>
          )}
        </>
      )}
      <LearnSetting />
      <MemoryHistory />
    </>
  );
}

function RoutinesTab() {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { dayLabel } = useFormat();
  const { data: routines = [] } = useRoutines();
  const { data: health = [] } = useRoutineHealth();
  const { data: bots = [] } = useBots();
  const qc = useQueryClient();
  // Only those that want a look, for someone with many routines.
  const [attention, setAttention] = useState(false);
  const toggle = useMutation({
    mutationFn: (r: { id: string; enabled: boolean }) => api.updateRoutine(r.id, { enabled: !r.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['routines'] }),
  });
  if (!routines.length) {
    return <p className="text-sm text-muted-foreground">{t('routines.empty')}</p>;
  }
  const healthOf = new Map(health.map((h) => [h.routineId, h]));
  const shown = attention ? routines.filter((r) => needsAttention(healthOf.get(r.id))) : routines;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Select
          value={attention ? 'attention' : 'all'}
          onValueChange={(v) => setAttention(v === 'attention')}
        >
          <SelectTrigger className="w-auto rounded-full" aria-label={t('health.title')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t('routines.filterAll')}</SelectItem>
            <SelectItem value="attention">{t('routines.filterAttention')}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {!shown.length ? (
        <p className="text-sm text-muted-foreground">{t('routines.filterNone')}</p>
      ) : (
        <Card>
          {shown.map((r) => {
            const bot = bots.find((b) => b.id === r.botId);
            const h = healthOf.get(r.id);
            return (
              <div key={r.id} className="flex items-center gap-3 px-4 py-3">
                {bot && (
                  <BotAvatar
                    avatar={bot.avatar}
                    material={bot.material}
                    color={bot.color}
                    seed={bot.id}
                    size={28}
                  />
                )}
                {/* Opening it shows its health and what can be done about it. */}
                <button
                  type="button"
                  className="min-w-0 flex-1 text-start"
                  onClick={() => {
                    const ui = useUi.getState();
                    ui.openSettings(null);
                    ui.openRoutine({ botId: r.botId, routineId: r.id });
                  }}
                >
                  <div className="truncate text-sm font-medium">{r.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {bot?.name} · {describeSchedule(r.schedule, locale)}
                    {r.lastRunAt ? ` · ${t('routines.lastRun', { when: dayLabel(r.lastRunAt) })}` : ''}
                  </div>
                  {h && <HealthStatus status={h.status} className="mt-0.5" />}
                </button>
                <Switch checked={r.enabled} onCheckedChange={() => toggle.mutate(r)} />
              </div>
            );
          })}
        </Card>
      )}
    </>
  );
}

function GroupsTab() {
  const t = useT();
  const { data: groups = [] } = useGroups();
  const { data: bots = [] } = useBots();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const refresh = () => qc.invalidateQueries({ queryKey: ['groups'] });
  const add = useMutation({
    mutationFn: () => api.createGroup(name),
    onSuccess: () => {
      setName('');
      void refresh();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: api.deleteGroup,
    onSuccess: () => {
      void refresh();
      void qc.invalidateQueries({ queryKey: ['bots'] });
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <>
      <p className="mb-4 text-sm text-muted-foreground">{t('groups.hint')}</p>
      <form
        className="mb-6 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) add.mutate();
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t('groups.placeholder')}
          className="flex-1 rounded-full"
        />
        <Button className="rounded-full" disabled={!name.trim()}>
          {t('common.add')}
        </Button>
      </form>
      <Card>
        {groups.length === 0 && (
          <div className="px-4 py-3 text-sm text-muted-foreground">{t('groups.empty')}</div>
        )}
        {groups.map((g) => {
          const count = bots.filter((b) => b.groupId === g.id).length;
          return (
            <Row key={g.id} label={g.name} hint={t('groups.count', { count })}>
              <Button
                variant="ghost"
                size="icon"
                className="size-8 rounded-full"
                onClick={() =>
                  (count === 0 || confirm(t('sidebarMenu.deleteGroupConfirm', { name: g.name }))) &&
                  remove.mutate(g.id)
                }
                aria-label={t('common.delete')}
              >
                <Trash2 className="size-4" />
              </Button>
            </Row>
          );
        })}
      </Card>
      <ArchivedBots />
    </>
  );
}

/** Bots put away from the sidebar: each can come back, or go for good with all it holds. */
function ArchivedBots() {
  const t = useT();
  const { dayLabel } = useFormat();
  const qc = useQueryClient();
  const { data: archived = [] } = useQuery({ queryKey: ['bots', 'archived'], queryFn: api.archivedBots });
  const refresh = () => qc.invalidateQueries({ queryKey: ['bots'] });
  const restore = useMutation({
    mutationFn: api.restoreBot,
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  const remove = useMutation({
    mutationFn: api.deleteBot,
    onSuccess: refresh,
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Card title={t('archive.title')}>
      {archived.length === 0 && (
        <div className="px-4 py-3 text-sm text-muted-foreground">{t('archive.empty')}</div>
      )}
      {archived.map((b) => (
        <Row key={b.id} label={b.name} hint={t('archive.since', { when: dayLabel(b.archivedAt!) })}>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-full"
            disabled={restore.isPending}
            onClick={() => restore.mutate(b.id)}
          >
            {t('archive.restore')}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="size-8 rounded-full text-destructive"
            disabled={remove.isPending}
            onClick={() => confirm(t('archive.deleteConfirm', { name: b.name })) && remove.mutate(b.id)}
            aria-label={t('archive.delete')}
            title={t('archive.delete')}
          >
            <Trash2 className="size-4" />
          </Button>
        </Row>
      ))}
    </Card>
  );
}

const REPO_URL = 'https://github.com/esmworks/leafbot';

/** A new issue with the version and the device filled in, so a report starts with what it needs. */
function issueUrl(version: string | undefined): string {
  const body = [`Version: ${version ?? '?'}`, `Browser: ${navigator.userAgent}`, '', ''].join('\n');
  return `${REPO_URL}/issues/new?body=${encodeURIComponent(body)}`;
}

/**
 * Copyright, license and source links. The license requires that everyone who gets a copy also
 * gets its terms and the NOTICE file's "Required Notice:" lines, so both stay reachable from here.
 */
function About() {
  const t = useT();
  const { data: info } = useInfo();
  const managesServer = useManagesServer();
  const link = (href: string, label: string, hint = href.replace('https://', '')) => (
    <Row label={label} hint={hint}>
      <Button asChild variant="secondary" size="sm" className="rounded-full">
        <a href={href} target="_blank" rel="noopener noreferrer">
          <ExternalLink /> {t('about.open')}
        </a>
      </Button>
    </Row>
  );
  return (
    <>
      <div className="mb-6 flex items-center gap-4 px-1">
        <img src="/logo.png" alt="" className="size-14 rounded-2xl" />
        <div>
          <div className="text-lg font-semibold">Leaf Bot</div>
          <div className="text-sm text-muted-foreground">
            {t('about.version', { version: info?.version ?? '…' })}
          </div>
        </div>
      </div>
      <Card title={t('about.license')}>
        <div className="space-y-2 px-4 py-3 text-sm">
          <p>Copyright © 2026 esmworks (Erhan Erbaş)</p>
          <p className="text-muted-foreground">{t('about.licenseText')}</p>
          <p className="text-muted-foreground">{t('about.warranty')}</p>
        </div>
      </Card>
      <Card title={t('about.links')}>
        {link(REPO_URL, t('about.source'))}
        {link(`${REPO_URL}/blob/main/LICENSE`, t('about.licenseLink'))}
        {link(`${REPO_URL}/blob/main/NOTICE`, t('about.notice'))}
        {link(issueUrl(info?.version), t('about.report'), t('about.reportHint'))}
      </Card>
      {managesServer && <DoctorCard />}
      {desktop?.showLogs && (
        <Card title={t('about.logs')}>
          <Row label={t('about.logsHint')}>
            <Button
              variant="secondary"
              size="sm"
              className="rounded-full"
              onClick={() => void desktop?.showLogs?.()}
            >
              <FolderOpen /> {t('about.showLogs')}
            </Button>
          </Row>
        </Card>
      )}
    </>
  );
}

function ShellSandboxRow({ sandbox }: { sandbox: ServerInfo['shellSandbox'] | undefined }) {
  const t = useT();
  const status = sandbox?.status ?? 'unknown';
  // The bwrap error itself is useful; the other reasons say all there is.
  const reason = sandbox?.reason ? t(`sandbox.reason.${sandbox.reason}`) : null;
  const detail =
    sandbox?.reason === 'bwrap-failed' && sandbox.detail
      ? `${reason} (${sandbox.detail})`
      : (reason ?? sandbox?.detail ?? '');
  return (
    <Row
      label={t('sandbox.label')}
      hint={status === 'unavailable' ? t('sandbox.unavailableHint', { detail }) : t('sandbox.okHint')}
    >
      <span
        className={cn(
          'flex items-center gap-1.5 text-sm',
          status === 'ok'
            ? 'text-emerald-500'
            : status === 'unknown'
              ? 'text-muted-foreground'
              : 'text-amber-500',
        )}
      >
        {status === 'ok' ? (
          <Check className="size-4" />
        ) : status === 'unknown' ? null : (
          <X className="size-4" />
        )}
        {t(`sandbox.status.${status}`)}
      </span>
    </Row>
  );
}

/**
 * The bots' browsers reach the web through the person's own computer, so sites see its connection
 * instead of the server's. Offered only when the server runs elsewhere.
 */
function EgressRow({ egress }: { egress: ServerInfo['egress'] | undefined }) {
  const t = useT();
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  if (!egress || settings?.browserViaComputer === undefined) return null;
  const on = settings.browserViaComputer;
  const now = egress.connected
    ? egress.device
      ? t('egress.connected', { device: egress.device })
      : t('egress.connectedUnnamed')
    : t('egress.waiting');
  return (
    <Row label={t('egress.label')} hint={on ? `${t('egress.hint')} ${now}` : t('egress.hint')}>
      <Switch checked={on} onCheckedChange={(v) => save.mutate({ browserViaComputer: v })} />
    </Row>
  );
}

function BrowserRow({ browser }: { browser: ServerInfo['browser'] | undefined }) {
  const t = useT();
  if (!browser) return null;
  const ok = browser.status === 'ok';
  return (
    <Row
      label={t('browserInfo.label')}
      hint={ok ? t('browserInfo.okHint', { path: browser.detail ?? '' }) : t('browserInfo.missingHint')}
    >
      <span className={cn('flex items-center gap-1.5 text-sm', ok ? 'text-emerald-500' : 'text-amber-500')}>
        {ok ? <Check className="size-4" /> : <X className="size-4" />}
        {ok ? t('browserInfo.ok') : t('browserInfo.missing')}
      </span>
    </Row>
  );
}
