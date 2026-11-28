import { BRAND_COLOR, isLocale } from '@leafbot/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, Plus } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useEffect, useState, type ReactNode } from 'react';
import { AppMascot } from '@/components/AppMascot';
import { Wallpaper } from '@/components/Wallpaper';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { toast } from 'sonner';
import { Toaster } from '@/components/ui/sonner';
import { AppsPage } from '@/features/Connections';
import { ComputerDialog } from '@/features/Computer';
import { Chat } from '@/features/Chat';
import { RoomDialog, RoomView } from '@/features/Rooms';
import { Login } from '@/features/Login';
import { RightPanel } from '@/features/RightPanel';
import { SearchDialog } from '@/features/SearchDialog';
import { ShortcutsDialog } from '@/features/ShortcutsDialog';
import { ActionCards } from '@/features/ActionCards';
import { GrokMoveOffer } from '@/features/GrokMoveOffer';
import { PageAppWindow } from '@/features/PageApps';
import { PageCallQuestion } from '@/features/PageBridge';
import { useOpenedRoutine } from '@/features/openedRoutine';
import { usePreview } from '@/features/previewStore';
import { Sidebar } from '@/features/Sidebar';
import { useLocale, useT } from '@/i18n';
import { api, setUnauthorizedHandler } from '@/lib/api';
import { pageAppWindowOf } from '@/lib/pageAppWindow';
import { isQuickView } from '@/lib/quick';
import { screenBotOf } from '@/lib/screen';
import { takeLinkedThread } from '@/lib/threadLink';
import { desktop } from '@/lib/desktop';
import { useLayout } from '@/lib/layout';
import { useBots, useRooms, useSession, useSettings } from '@/lib/queries';
import { connectRealtime } from '@/lib/realtime';
import { viaTunnel } from '@/lib/transport';
import { PANEL_WIDTH, useUi } from '@/lib/store';
import { useUnreadTracking } from '@/lib/unread';
import { useChatWidth, useFont } from '@/lib/density';
import { lazyScreen, preloadWhenIdle, useOpenedOnce } from '@/lib/lazyScreen';
import { cn } from '@/lib/utils';

// Screens most sessions never open load the first time they are shown; the first paint needs only
// the chat and the sidebar. Dialogs that listen for their own shortcut stay in the main bundle.
const AccountGate = lazyScreen(() => import('@/features/AccountGate').then((m) => m.AccountGate));
const BotFormPage = lazyScreen(() => import('@/features/BotFormPage').then((m) => m.BotFormPage));
const Onboarding = lazyScreen(() => import('@/features/onboarding/Onboarding').then((m) => m.Onboarding));
const PhoneScreen = lazyScreen(() => import('@/features/PhoneScreen').then((m) => m.PhoneScreen));
const QuickPanel = lazyScreen(() => import('@/features/QuickPanel').then((m) => m.QuickPanel));
const RoutinePage = lazyScreen(() => import('@/features/RoutinePage').then((m) => m.RoutinePage));
const FilePreview = lazyScreen(() => import('@/features/FilePreview').then((m) => m.FilePreview));
const SettingsPage = lazyScreen(() => import('@/features/SettingsPage').then((m) => m.SettingsPage));
const TodayDialog = lazyScreen(() => import('@/features/TodayDialog').then((m) => m.TodayDialog));
const BoardPage = lazyScreen(() => import('@/features/board/BoardPage').then((m) => m.BoardPage));
const DashboardsDialog = lazyScreen(() =>
  import('@/features/DashboardsDialog').then((m) => m.DashboardsDialog),
);
const LAZY_SCREENS = [
  SettingsPage,
  BotFormPage,
  TodayDialog,
  BoardPage,
  DashboardsDialog,
  Onboarding,
  AccountGate,
];

// The chosen chat width applies from the first paint.
useChatWidth.getState();
useFont.getState();

/** Opens the conversation a link names, with its bot or room, or says it is gone. */
function openLinkedThread(id: string, t: (key: 'chat.linkGone') => string) {
  api
    .thread(id)
    .then((th) => {
      if (th.kind === 'room') return useUi.getState().openRoom(th.id);
      useUi.getState().openChat(th.botId);
      useUi.getState().selectThread(th.id);
    })
    .catch(() => toast.error(t('chat.linkGone')));
}

/**
 * The app once it can reach its server. `signedOut` replaces the sign-in page where signing in to
 * the server is not how one gets in: the web app on the website, whose people come from the account.
 */
export function App({ signedOut }: { signedOut?: ReactNode } = {}) {
  const authed = useUi((s) => s.authed);
  const setAuthed = useUi((s) => s.setAuthed);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthed(false));
    const check = async () => {
      if ((await api.session()).authenticated) return true;
      // In the desktop app the shell holds the key; log in without asking.
      const key = await desktop?.accessKey();
      if (!key) return false;
      await api.access(key);
      return true;
    };
    check()
      .then(setAuthed)
      .catch(() => setAuthed(false));
  }, [setAuthed]);

  return (
    <>
      {authed === null ? <Loading /> : authed ? <Authed /> : (signedOut ?? <Login />)}
      <Toaster position="bottom-center" />
    </>
  );
}

function Loading() {
  return (
    <div className="flex h-full items-center justify-center">
      <Loader2 className="size-6 animate-spin text-muted-foreground" />
    </div>
  );
}

/**
 * The first-run questions on a server that has no bots and says they were never answered;
 * otherwise the workspace. Decided once, so bots made during the questions do not cut them off.
 * A server older than the questions sends no `onboarded` and goes straight to the workspace.
 */
function Authed() {
  const qc = useQueryClient();
  const settings = useSettings();
  const bots = useBots();
  const [onboarding, setOnboarding] = useState<boolean | null>(null);
  // The owner signs in to their Leaf Bot account once, before anything else, on a server that is
  // not linked to one; the server links itself on the way. Decided by what the server has stored,
  // never by asking the account service, so the app opens without it once linked. Through the
  // account the person is already signed in; an older server without the route asks nothing.
  const session = useSession();
  const mayLink = session.data?.user?.role === 'owner' && !viaTunnel();
  const role = session.data?.user?.role;
  // Until the session says otherwise, the person is taken to look after the server, as with one account.
  const manages = !role || role === 'owner' || role === 'admin';
  const accountHost = useQuery({
    queryKey: ['account-host'],
    queryFn: api.accountHost,
    enabled: mayLink,
    retry: false,
    staleTime: 30_000,
  });
  // Decided once, like the first-run questions: unlinking in Settings does not swap the open app
  // for the sign-in; the next start asks again.
  const [askAccount, setAskAccount] = useState<boolean | null>(null);
  // The answer the sign-in page got before signing in says no one; it is asked again here. Still no
  // one then, the session has ended (signed out elsewhere): back to the sign-in page.
  const sessionStale = session.data?.authenticated === false;
  const refetchSession = session.refetch;
  const setAuthed = useUi((s) => s.setAuthed);
  useEffect(() => {
    if (!sessionStale) return;
    void refetchSession().then((r) => {
      if (r.data?.authenticated === false) setAuthed(false);
    });
  }, [sessionStale, refetchSession, setAuthed]);
  useLocaleSync();
  // The desktop app's quick window shows only what waits for the person.
  if (isQuickView()) return <QuickPanel />;
  // The phone app's web view shows only a bot's computer.
  const screenBot = screenBotOf();
  if (screenBot) return <PhoneScreen botId={screenBot} />;
  // The desktop app's window for one saved app shows only that app.
  const appWindow = pageAppWindowOf();
  if (appWindow) return <PageAppWindow id={appWindow} />;
  if (session.isPending || sessionStale) return <Loading />;
  if (askAccount === null) {
    const first =
      !mayLink || accountHost.isError ? false : accountHost.data ? !accountHost.data.linked : null;
    // Adjusting state while rendering: the choice is kept from the first answer on.
    if (first !== null) setAskAccount(first);
    return <Loading />;
  }
  if (askAccount) return <AccountGate onDone={() => setAskAccount(false)} />;
  if (onboarding === null) {
    const first =
      settings.isError || bots.isError
        ? false
        : settings.data && bots.data
          ? // Someone invited finds bots shared with them, and is welcomed to them once.
            settings.data.onboarded === false && (bots.data.length === 0 || !manages)
          : null;
    // Adjusting state while rendering: the choice is kept from the first answer on.
    if (first !== null) setOnboarding(first);
  }
  if (onboarding === null) return <Loading />;
  if (onboarding)
    return (
      <Onboarding
        onDone={() => {
          void Promise.all([
            qc.invalidateQueries({ queryKey: ['settings'] }),
            qc.invalidateQueries({ queryKey: ['bots'] }),
          ]).then(() => setOnboarding(false));
        }}
      />
    );
  return <Workspace />;
}

/**
 * Keeps the app's language and the server's `language` setting the same. The server's choice
 * wins, so every browser shows the same language; a server without one takes the app's, as
 * does a choice made on the login page before the setting could be saved.
 */
function useLocaleSync() {
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const server = settings ? (settings.language ?? null) : undefined;
  useEffect(() => {
    if (server === undefined) return;
    const { locale, unsaved, setLocale } = useLocale.getState();
    if (isLocale(server) && !unsaved) {
      if (server !== locale) setLocale(server);
      return;
    }
    if (server === locale) {
      if (unsaved) useLocale.setState({ unsaved: false });
      return;
    }
    void api.updateSettings({ language: locale }).then(() => {
      useLocale.setState({ unsaved: false });
      return qc.invalidateQueries({ queryKey: ['settings'] });
    });
  }, [server, qc]);
}

function Workspace() {
  const t = useT();
  const qc = useQueryClient();
  const { data: bots, isLoading } = useBots();
  const botId = useUi((s) => s.botId);
  const selectBot = useUi((s) => s.selectBot);
  const panelOpen = useUi((s) => s.panelOpen);
  const openBotPage = useUi((s) => s.openBotPage);
  const panelSheet = useUi((s) => s.panelSheet);
  const togglePanelSheet = useUi((s) => s.togglePanelSheet);
  const phonePane = useUi((s) => s.phonePane);
  // The settings cover the whole window; what lies under them stays as it was, out of reach.
  const settingsOpen = useUi((s) => !!s.settingsTab);
  const { phone, panelBeside } = useLayout();

  useEffect(() => connectRealtime(qc), [qc]);
  useUnreadTracking();
  // Once the first screen is up, a page served from afar fetches the rest while idle.
  useEffect(() => preloadWhenIdle(LAZY_SCREENS), []);
  // ⌘, opens the settings; their own page takes over once it is loaded, and until then this does.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (SettingsPage.loaded()) return;
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key === ',') {
        e.preventDefault();
        const { settingsTab, openSettings } = useUi.getState();
        openSettings(settingsTab ? null : 'general');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Mounted from the first opening on, so closing still plays its animation.
  const settingsMounted = useOpenedOnce(settingsOpen);
  const todayMounted = useOpenedOnce(useUi((s) => s.todayOpen));
  const board = useUi((s) => s.boardOpen);
  const boardMounted = useOpenedOnce(board);
  const dashboardsMounted = useOpenedOnce(useUi((s) => s.dashboardsOpen));
  const previewMounted = useOpenedOnce(usePreview((s) => s.file !== null));
  // The desktop app's menu bar holds Settings (⌘,) too.
  useEffect(() => desktop?.onOpenSettings?.(() => useUi.getState().openSettings('general', true)), []);

  const bot = bots?.find((b) => b.id === botId);
  useEffect(() => {
    if (bots && !bot && bots[0]) selectBot(bots[0].id);
  }, [bots, bot, selectBot]);
  // A room open in place of the bot's chat, while it still exists.
  const roomId = useUi((s) => s.roomId);
  const { data: rooms, isFetching: roomsFetching } = useRooms();
  const room = roomId ? rooms?.find((r) => r.id === roomId) : undefined;
  useEffect(() => {
    if (roomId && rooms && !roomsFetching && !rooms.some((r) => r.id === roomId))
      useUi.getState().openRoom(null);
  }, [roomId, rooms, roomsFetching]);
  // A routine open in place of the bot's chat: its flow needs the room the chat and panel take.
  const routine = useOpenedRoutine();
  const botPage = useUi((s) => s.botPage);
  const apps = useUi((s) => s.apps);
  // A link to one conversation (…?thread=<id>) opens it, once the person is signed in.
  useEffect(() => {
    const linked = takeLinkedThread();
    if (linked) openLinkedThread(linked, t);
  }, [t]);
  // In the desktop app, a `leafbot://` link opened from outside: now, and whenever one arrives.
  useEffect(() => {
    const take = () =>
      void desktop
        ?.takeLink?.()
        .then((link) => {
          if (!link) return;
          if (link.kind === 'thread') return openLinkedThread(link.id, t);
          if (link.kind === 'room') return useUi.getState().openRoom(link.id);
          if (link.kind === 'app') return useUi.getState().openApps({ botId: null, pageAppId: link.id });
          useUi.getState().openChat(link.id);
        })
        .catch(() => {});
    take();
    return desktop?.onOpenLink?.(take);
  }, [t]);
  useEffect(() => {
    document.documentElement.style.setProperty('--brand', bot?.color ?? BRAND_COLOR);
  }, [bot?.color]);

  // A phone shows the list or the chat, never both; the chat needs a bot to show.
  const pane = phone ? (bot || room || routine || botPage || apps || board ? phonePane : 'list') : null;
  const seeThrough = !apps && !board && !botPage && !routine && !!(room || bot);

  return (
    <>
      <Wallpaper />
      <div className="workspace flex h-full overflow-hidden" inert={settingsOpen}>
        {pane !== 'chat' && <Sidebar />}
        <main
          className={cn(
            'safe-pane min-w-0 flex-1 bg-background',
            pane === 'list' ? 'hidden' : 'flex',
            // The picture behind the window shows through a chat or a room; forms and pages keep their fill.
            seeThrough && 'wallpaper-clear',
          )}
        >
          {/* The apps page covers the rest, which stays as it was (typed changes too) under it. */}
          {apps && <AppsPage />}
          {/* The board likewise, kept once opened so its filters wait for the next visit. */}
          {boardMounted && <BoardPage />}
          <div className={cn('flex min-w-0 flex-1', (apps || board) && 'hidden')}>
            {botPage ? (
              <BotFormPage key={botPage.mode === 'edit' ? botPage.botId : 'new'} page={botPage} />
            ) : routine ? (
              <RoutinePage
                key={`${routine.botId}:${routine.routine?.id ?? 'new'}`}
                botId={routine.botId}
                routine={routine.routine}
                showRuns={routine.showRuns}
              />
            ) : room ? (
              <RoomView key={room.id} room={room} />
            ) : bot ? (
              <>
                <Chat key={bot.id} bot={bot} />
                {panelBeside ? (
                  <AnimatePresence initial={false}>
                    {panelOpen && (
                      <motion.div
                        key="panel"
                        initial={{ width: 0, opacity: 0 }}
                        animate={{ width: PANEL_WIDTH, opacity: 1 }}
                        exit={{ width: 0, opacity: 0 }}
                        transition={{ duration: 0.2 }}
                        className="overflow-hidden"
                      >
                        <RightPanel bot={bot} beside />
                      </motion.div>
                    )}
                  </AnimatePresence>
                ) : (
                  <Sheet open={panelSheet} onOpenChange={togglePanelSheet}>
                    <SheetContent aria-describedby={undefined}>
                      <SheetTitle className="sr-only">{bot.name}</SheetTitle>
                      <RightPanel bot={bot} />
                    </SheetContent>
                  </Sheet>
                )}
              </>
            ) : (
              !isLoading && (
                <div className="flex flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
                  <div className="size-20">
                    <AppMascot />
                  </div>
                  <h1 className="text-2xl font-semibold">{t('welcome.title')}</h1>
                  <p className="max-w-sm text-sm text-muted-foreground">{t('welcome.body')}</p>
                  <Button className="rounded-full" onClick={() => openBotPage({ mode: 'create' })}>
                    <Plus /> {t('welcome.create')}
                  </Button>
                </div>
              )
            )}
          </div>
        </main>
        <RoomDialog />
        <ComputerDialog />
        {previewMounted && <FilePreview />}
        <SearchDialog />
        <ShortcutsDialog />
        {todayMounted && <TodayDialog />}
        <ActionCards />
        {dashboardsMounted && <DashboardsDialog />}
        <PageCallQuestion />
        <GrokMoveOffer />
      </div>
      {settingsMounted && <SettingsPage />}
    </>
  );
}
