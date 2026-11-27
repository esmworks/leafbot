import type { PageApp } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AppWindow,
  ChevronLeft,
  Download,
  ExternalLink,
  Loader2,
  MessageSquare,
  Monitor,
  MoreHorizontal,
  Pencil,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { LiveFrame } from '@/components/LiveFrame';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { desktop, type InstalledApp } from '@/lib/desktop';
import { useBots } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { useTransport } from '@/lib/transport';
import { cn } from '@/lib/utils';
import { PageCallQuestion, useAppTheme, usePageBridge } from './PageBridge';

/*
 * Pages a bot made, saved as apps: they open on their own, from the apps page or, in the desktop
 * app, in a window of their own and from a launcher installed on the computer. The page is read
 * from the bot's folder each time, so an app is always the page as the bot last wrote it.
 */

const APPS_KEY = ['page-apps'];
const INSTALLS_KEY = ['app-installs'];

/** The saved apps installed on this computer, by id; null where launchers cannot be made. */
function useInstalls(): Map<string, InstalledApp> | null {
  const { data } = useQuery({
    queryKey: INSTALLS_KEY,
    queryFn: async () => (await desktop?.appInstalls?.()) ?? null,
    enabled: !!desktop?.appInstalls,
  });
  return data ? new Map(data.map((a) => [a.id, a])) : null;
}

/** What can be done with a saved app, each saying how it went. */
function useAppActions() {
  const t = useT();
  const qc = useQueryClient();
  const fail = (e: unknown) => toast.error((e as Error).message);
  const refreshInstalls = () => qc.invalidateQueries({ queryKey: INSTALLS_KEY });
  const refreshApps = () =>
    Promise.all([
      qc.invalidateQueries({ queryKey: APPS_KEY }),
      qc.invalidateQueries({ queryKey: ['page-app'] }),
      qc.invalidateQueries({ queryKey: ['page-app-of'] }),
    ]);
  const install = useMutation({
    mutationFn: (app: PageApp) => desktop!.installApp!(app.id, app.name),
    onSuccess: (done, app) => {
      if (done) toast.success(t('pageApp.installedToast', { name: app.name }));
      void refreshInstalls();
    },
    onError: fail,
  });
  const uninstall = useMutation({
    mutationFn: (app: PageApp) => desktop!.uninstallApp!(app.id),
    onSuccess: () => void refreshInstalls(),
    onError: fail,
  });
  const onDesktop = useMutation({
    mutationFn: ({ app, on }: { app: PageApp; on: boolean }) => desktop!.appOnDesktop!(app.id, app.name, on),
    onSuccess: () => void refreshInstalls(),
    onError: fail,
  });
  const rename = useMutation({
    mutationFn: async ({ app, name, installed }: { app: PageApp; name: string; installed: boolean }) => {
      const renamed = await api.renamePageApp(app.id, name);
      // Its launchers take the new name too.
      if (installed) await desktop?.installApp?.(app.id, renamed.name);
      return renamed;
    },
    onSuccess: () => void Promise.all([refreshApps(), refreshInstalls()]),
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: async ({ app, installed }: { app: PageApp; installed: boolean }) => {
      if (installed) await desktop?.uninstallApp?.(app.id);
      await api.removePageApp(app.id);
    },
    onSuccess: (_r, { app }) => {
      const open = useUi.getState().apps;
      if (open?.pageAppId === app.id) useUi.getState().openApps({ botId: open.botId });
      void Promise.all([refreshApps(), refreshInstalls()]);
      toast(t('pageApp.removed', { name: app.name }), {
        action: {
          label: t('pageApp.undo'),
          // Saved again from the same page; the launchers removed with it are not put back.
          onClick: () =>
            void api
              .savePageApp(app.botId, {
                path: app.path,
                name: app.name,
                ...(app.threadId && { threadId: app.threadId }),
              })
              .then(refreshApps, fail),
        },
      });
    },
    onError: fail,
  });
  return { install, uninstall, onDesktop, rename, remove };
}

/** Opens the conversation the page was shown in, or says it is gone. */
function goToChat(app: PageApp, t: ReturnType<typeof useT>) {
  if (!app.threadId) {
    useUi.getState().openChat(app.botId);
    return;
  }
  api
    .thread(app.threadId)
    .then((th) => {
      useUi.getState().openChat(th.botId);
      useUi.getState().selectThread(th.id);
    })
    .catch(() => toast.error(t('pageApp.chatGone')));
}

/** The app's menu: open it elsewhere, put it on this computer, rename, find its chat, remove. */
function AppMenu({
  app,
  installs,
  standalone,
  onRename,
  className,
}: {
  app: PageApp;
  installs: Map<string, InstalledApp> | null;
  /** In the app's own window, which has no chat to go to and is the window already. */
  standalone?: boolean;
  onRename(): void;
  className?: string;
}) {
  const t = useT();
  const { install, uninstall, onDesktop, remove } = useAppActions();
  const installed = installs?.get(app.id);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={cn('shrink-0 rounded-full', className)}
          aria-label={t('pageApp.more')}
          title={t('pageApp.more')}
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        {!standalone && desktop?.openApp && (
          <DropdownMenuItem onSelect={() => void desktop?.openApp?.(app.id)}>
            <ExternalLink /> {t('pageApp.openWindow')}
          </DropdownMenuItem>
        )}
        {installs &&
          (installed ? (
            <>
              <DropdownMenuItem onSelect={() => onDesktop.mutate({ app, on: !installed.desktop })}>
                <Monitor /> {t(installed.desktop ? 'pageApp.removeDesktop' : 'pageApp.addDesktop')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => uninstall.mutate(app)}>
                <Download className="rotate-180" /> {t('pageApp.uninstall')}
              </DropdownMenuItem>
            </>
          ) : (
            <>
              <DropdownMenuItem onSelect={() => install.mutate(app)}>
                <Download /> {t('pageApp.install')}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onDesktop.mutate({ app, on: true })}>
                <Monitor /> {t('pageApp.addDesktop')}
              </DropdownMenuItem>
            </>
          ))}
        {(installs || (!standalone && desktop?.openApp)) && <DropdownMenuSeparator />}
        <DropdownMenuItem onSelect={onRename}>
          <Pencil /> {t('pageApp.rename')}
        </DropdownMenuItem>
        {!standalone && (
          <DropdownMenuItem onSelect={() => goToChat(app, t)}>
            <MessageSquare /> {t('pageApp.goToChat')}
          </DropdownMenuItem>
        )}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          className="text-destructive focus:text-destructive"
          onSelect={() => remove.mutate({ app, installed: !!installed })}
        >
          <Trash2 /> {t('pageApp.remove')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RenameDialog({
  app,
  installed,
  onClose,
}: {
  app: PageApp | null;
  installed: boolean;
  onClose(): void;
}) {
  const t = useT();
  return (
    <Dialog open={!!app} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-2xl sm:max-w-sm" aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{t('pageApp.renameTitle')}</DialogTitle>
        </DialogHeader>
        {app && <RenameForm key={app.id} app={app} installed={installed} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function RenameForm({ app, installed, onClose }: { app: PageApp; installed: boolean; onClose(): void }) {
  const t = useT();
  const { rename } = useAppActions();
  const [name, setName] = useState(app.name);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const next = name.trim();
        if (!next) return;
        if (next !== app.name) rename.mutate({ app, name: next, installed });
        onClose();
      }}
    >
      <Input
        autoFocus
        aria-label={t('pageApp.name')}
        value={name}
        maxLength={120}
        onChange={(e) => setName(e.target.value)}
        className="rounded-xl"
      />
      <DialogFooter className="mt-4">
        <Button type="button" variant="ghost" className="rounded-xl" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-xl" disabled={!name.trim()}>
          {t('common.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** The page card's button: saves the page as an app, then opens it. */
export function SaveAsApp({
  botId,
  path,
  name,
  threadId,
}: {
  botId: string;
  path: string;
  name: string;
  threadId?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const key = ['page-app-of', botId, path];
  const { data } = useQuery({ queryKey: key, queryFn: () => api.pageAppOf(botId, path) });
  const saved = data?.app ?? null;
  const save = useMutation({
    mutationFn: () => api.savePageApp(botId, { path, name, ...(threadId && { threadId }) }),
    onSuccess: (app) => {
      qc.setQueryData(key, { app });
      void qc.invalidateQueries({ queryKey: APPS_KEY });
      toast.success(t('pageApp.savedToast', { name: app.name }));
    },
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <button
      type="button"
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground disabled:opacity-60"
      title={saved ? undefined : t('pageApp.saveHint')}
      disabled={save.isPending}
      onClick={() => (saved ? useUi.getState().openApps({ botId, pageAppId: saved.id }) : save.mutate())}
    >
      <AppWindow className="size-3.5" /> {t(saved ? 'pageApp.saved' : 'pageApp.save')}
    </button>
  );
}

/** A square with the app's first letter, in its bot's colour. */
function AppMark({ name, color, className }: { name: string; color?: string; className?: string }) {
  const letter = [...name.trim()][0]?.toLocaleUpperCase() ?? '?';
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-2xl text-lg font-semibold text-white',
        className,
      )}
      style={{ background: color ?? 'var(--brand)' }}
    >
      {letter}
    </span>
  );
}

/** The person's saved apps, at the top of the apps page; nothing while there are none. */
export function SavedApps({ onOpen }: { onOpen(id: string): void }) {
  const t = useT();
  const { data: apps = [] } = useQuery({ queryKey: APPS_KEY, queryFn: api.pageApps });
  const { data: bots = [] } = useBots();
  const installs = useInstalls();
  const [renaming, setRenaming] = useState<PageApp | null>(null);
  if (!apps.length) return null;
  return (
    <section className="mb-6 space-y-3">
      <div className="px-1">
        <h2 className="text-sm font-medium">{t('pageApp.section')}</h2>
        <p className="text-xs text-muted-foreground">{t('pageApp.sectionHint')}</p>
      </div>
      <div className="grid grid-cols-1 gap-2 @lg:grid-cols-2 @3xl:grid-cols-3">
        {apps.map((app) => {
          const bot = bots.find((b) => b.id === app.botId);
          return (
            <div
              key={app.id}
              className="group flex items-center gap-3 rounded-2xl border bg-card/50 p-2 pe-1 transition-colors hover:bg-accent/60"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-start"
                onClick={() => onOpen(app.id)}
              >
                <AppMark name={app.name} color={bot?.color} className="size-11" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{app.name}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {bot ? t('pageApp.by', { bot: bot.name }) : ''}
                    {installs?.has(app.id) && (
                      <>
                        {bot ? ' · ' : ''}
                        {t('pageApp.installed')}
                      </>
                    )}
                  </span>
                </span>
              </button>
              <AppMenu app={app} installs={installs} onRename={() => setRenaming(app)} />
            </div>
          );
        })}
      </div>
      <RenameDialog
        app={renaming}
        installed={!!(renaming && installs?.has(renaming.id))}
        onClose={() => setRenaming(null)}
      />
    </section>
  );
}

/**
 * A saved app filling the main area, or its own window (`standalone`). Its page runs as in the
 * conversation: sandboxed, with an opaque origin, loading only the usual libraries.
 */
export function PageAppView({
  id,
  onBack,
  standalone,
}: {
  id: string;
  onBack?(): void;
  standalone?: boolean;
}) {
  const t = useT();
  const tunnel = useTransport((s) => s.tunnel);
  const installs = useInstalls();
  const { data: bots = [] } = useBots();
  const [renaming, setRenaming] = useState(false);
  const {
    data: app,
    isPending,
    isError,
  } = useQuery({
    queryKey: ['page-app', id],
    queryFn: () => api.pageApp(id),
    retry: false,
  });
  const bot = app && bots.find((b) => b.id === app.botId);
  useEffect(() => {
    if (standalone && app) document.title = app.name;
  }, [standalone, app]);
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="window-drag flex items-center gap-2 px-3 py-2.5 sm:px-4">
        {onBack && (
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0 rounded-full"
            onClick={onBack}
            aria-label={t('common.back')}
          >
            <ChevronLeft className="size-5 rtl:-scale-x-100" />
          </Button>
        )}
        {app && <AppMark name={app.name} color={bot?.color} className="size-7 rounded-lg text-sm" />}
        <h1 className="min-w-0 flex-1 truncate text-base font-semibold">{app?.name ?? ''}</h1>
        {app && (
          <AppMenu app={app} installs={installs} standalone={standalone} onRename={() => setRenaming(true)} />
        )}
      </div>
      {isPending ? (
        <div className="flex flex-1 items-center justify-center">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : isError || !app ? (
        <Notice text={t('pageApp.missing')} />
      ) : !app.available ? (
        <Notice text={t('pageApp.gone')} />
      ) : tunnel ? (
        // On the web app the page's scripts would run in the website's origin, so it is not shown there.
        <Notice text={t('bots.pageElsewhere')} />
      ) : (
        <AppFrame id={app.id} name={app.name} />
      )}
      <RenameDialog
        app={renaming ? (app ?? null) : null}
        installed={!!(app && installs?.has(app.id))}
        onClose={() => setRenaming(false)}
      />
    </section>
  );
}

/** The app's page filling the view, answering its `window.leafbot` calls. */
function AppFrame({ id, name }: { id: string; name: string }) {
  const theme = useAppTheme();
  const onRequest = usePageBridge({ kind: 'app', id }, name);
  return (
    <LiveFrame
      key={`${id}:${theme}`}
      title={name}
      src={api.pageAppUrl(id, theme)}
      onRequest={onRequest}
      fill
      className="min-h-0 w-full flex-1 border-0 border-t bg-background"
    />
  );
}

function Notice({ text }: { text: string }) {
  return (
    <div className="flex flex-1 items-center justify-center px-6">
      <p className="max-w-sm text-center text-sm text-muted-foreground">{text}</p>
    </div>
  );
}

/** The desktop app's window for one saved app (`?app=<id>`): the app alone, without the chat. */
export function PageAppWindow({ id }: { id: string }) {
  return (
    <div className="flex h-full bg-background">
      <PageAppView id={id} standalone />
      <PageCallQuestion />
    </div>
  );
}
