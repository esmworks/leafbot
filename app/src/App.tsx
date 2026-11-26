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
import { CreateAccount } from '@/features/AccountSetup';
import { BotFormPage } from '@/features/BotFormPage';
import { AppsPage } from '@/features/Connections';
import { ComputerDialog } from '@/features/Computer';
import { FilePreview } from '@/features/FilePreview';
import { Chat } from '@/features/Chat';
import { RoomDialog, RoomView } from '@/features/Rooms';
import { Login } from '@/features/Login';
import { Onboarding } from '@/features/onboarding/Onboarding';
import { PhoneScreen } from '@/features/PhoneScreen';
import { RightPanel } from '@/features/RightPanel';
import { SearchDialog } from '@/features/SearchDialog';
import { SettingsPage } from '@/features/SettingsPage';
import { ShortcutsDialog } from '@/features/ShortcutsDialog';
import { TodayDialog } from '@/features/TodayDialog';
import { BoardDialog } from '@/features/board/BoardDialog';
import { DashboardsDialog } from '@/features/DashboardsDialog';
import { RoutinePage, useOpenedRoutine } from '@/features/RoutinePage';
import { QuickPanel } from '@/features/QuickPanel';
import { Sidebar } from '@/features/Sidebar';
import { useLocale, useT } from '@/i18n';
import { api, setUnauthorizedHandler } from '@/lib/api';
import { isQuickView } from '@/lib/quick';
import { screenBotOf } from '@/lib/screen';
import { takeLinkedThread } from '@/lib/threadLink';
import { desktop } from '@/lib/desktop';
import { useLayout } from '@/lib/layout';
import { useBots, useRooms, useSettings } from '@/lib/queries';
import { connectRealtime } from '@/lib/realtime';
import { viaTunnel } from '@/lib/transport';
import { PANEL_WIDTH, useUi } from '@/lib/store';
import { useUnreadTracking } from '@/lib/unread';
import { useChatWidth, useFont } from '@/lib/density';
import { cn } from '@/lib/utils';

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
  // In a browser, a server without an account asks for one right after the key: from then on the
  // username and password sign in. The desktop app signs in by itself and does not ask.
  // Reached through the account, the person is already known and never makes a server account.
  const local = !desktop && !viaTunnel();
  const account = useQuery({ queryKey: ['account'], queryFn: api.account, enabled: local, retry: false });
  const [accountDone, setAccountDone] = useState(false);
  useLocaleSync();
  // The desktop app's quick window shows only what waits for the person.
  if (isQuickView()) return <QuickPanel />;
  // The phone app's web view shows only a bot's computer.
  const screenBot = screenBotOf();
  if (screenBot) return <PhoneScreen botId={screenBot} />;
  if (local && !accountDone) {
    if (account.isPending) return <Loading />;
    if (account.data?.username === null) return <CreateAccount onDone={() => setAccountDone(true)} />;
  }
  if (onboarding === null) {
    const first =
      settings.isError || bots.isError
        ? false
        : settings.data && bots.data
          ? settings.data.onboarded === false && bots.data.length === 0
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
  const pane = phone ? (bot || room || routine || botPage || apps ? phonePane : 'list') : null;
  const seeThrough = !apps && !botPage && !routine && !!(room || bot);

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
          <div className={cn('flex min-w-0 flex-1', apps && 'hidden')}>
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
        <FilePreview />
        <SearchDialog />
        <ShortcutsDialog />
        <TodayDialog />
        <BoardDialog />
        <DashboardsDialog />
      </div>
      <SettingsPage />
    </>
  );
}
