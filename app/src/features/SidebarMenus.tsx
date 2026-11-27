import type { Bot, Group } from '@leafbot/shared';
import { useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Bell,
  BellOff,
  Check,
  CircleDot,
  FolderInput,
  FolderPlus,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Settings2,
  Trash2,
  MessageSquarePlus,
  MessagesSquare,
  MailOpen,
  Pause,
  Play,
  Users,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { isMuted, muteUntil, useNotify } from '@/lib/notify';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useMoveBot } from '@/features/botDrag';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { moveTo, PINNED, UNGROUPED } from '@/lib/botLayout';
import { usePauseActions } from '@/lib/paused';
import { isMine, isSpace, placesFor } from '@/lib/places';
import { useBots, useGroups, useManagesServer, useSession, useSummaries } from '@/lib/queries';
import { useUi } from '@/lib/store';
import { isUnread, useSeen } from '@/lib/unread';

type Naming = { title: string; initial: string; save(name: string): Promise<unknown> } | null;

/**
 * The menu a right-click (or a long press) on a bot opens in the sidebar. `children` is the
 * element it opens on; it must take a ref and props.
 */
export function BotMenu({ bot, children }: { bot: Bot; children: React.ReactElement }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: groups = [] } = useGroups();
  const me = useSession().data?.user?.id;
  const manages = useManagesServer();
  const moveBot = useMoveBot();
  const openBotPage = useUi((s) => s.openBotPage);
  const selectBot = useUi((s) => s.selectBot);
  const muted = useNotify((s) => isMuted(s.mutes, bot.id));
  const mute = useNotify((s) => s.mute);
  const unmute = useNotify((s) => s.unmute);
  const { data: summaries } = useSummaries();
  const repliedAt = summaries?.find((x) => x.botId === bot.id)?.repliedAt ?? null;
  const unread = useSeen((s) => isUnread({ botId: bot.id, repliedAt }, s.seen));
  const [naming, setNaming] = useState<Naming>(null);
  const dialogNext = useRef(false);
  const refreshBots = () => qc.invalidateQueries({ queryKey: ['bots'] });
  const fail = (e: Error) => toast.error(e.message);
  const newThread = () =>
    void api
      .newThread(bot.id)
      .then((created) => {
        void qc.invalidateQueries({ queryKey: ['threads', bot.id] });
        useUi.getState().openChat(bot.id);
        useUi.getState().selectThread(created.id);
      })
      .catch(fail);

  const clearThreads = () => {
    if (!confirm(t('sidebarMenu.clearThreadsConfirm', { name: bot.name }))) return;
    void api
      .clearThreads(bot.id)
      .then(({ deleted }) => {
        if (useUi.getState().botId === bot.id) useUi.getState().selectThread(null);
        void qc.invalidateQueries({ queryKey: ['threads', bot.id] });
        void qc.invalidateQueries({ queryKey: ['summaries'] });
        toast.success(t('sidebarMenu.threadsCleared', { count: deleted }));
      })
      .catch(fail);
  };

  const openNaming = (n: NonNullable<Naming>) => {
    dialogNext.current = true;
    setNaming(n);
  };
  const rename = () =>
    openNaming({
      title: t('sidebarMenu.renameBot'),
      initial: bot.name,
      save: (name) =>
        api.updateBot(bot.id, { name }).then((saved) => {
          qc.setQueryData<Bot[]>(['bots'], (old) => old?.map((b) => (b.id === saved.id ? saved : b)));
          void refreshBots();
        }),
    });
  const toNewFolder = () =>
    openNaming({
      title: t('sidebarMenu.newFolder'),
      initial: '',
      save: async (name) => {
        const group = await api.createGroup(name);
        await qc.invalidateQueries({ queryKey: ['groups'] });
        await api.moveBot(bot.id, moveTo(group.id, null));
        await refreshBots();
      },
    });
  const archive = () =>
    api.archiveBot(bot.id).then(() => {
      void refreshBots();
      if (useUi.getState().botId === bot.id) selectBot(null);
      toast.success(t('sidebarMenu.archived', { name: bot.name }), {
        // Long enough to notice the wrong bot went and take it back.
        duration: 10_000,
        action: {
          label: t('sidebarMenu.undo'),
          onClick: () => void api.restoreBot(bot.id).then(refreshBots, fail),
        },
      });
    }, fail);

  const pause = usePauseActions();
  const togglePause = () => {
    const paused = !bot.pausedAt;
    pause.bot(bot.id, paused).then(
      () =>
        toast.success(t(paused ? 'pause.botPaused' : 'pause.botResumed', { name: bot.name }), {
          description: paused ? t('pause.botPausedHint') : undefined,
        }),
      fail,
    );
  };

  const current = bot.pinned ? PINNED : (bot.groupId ?? UNGROUPED);
  const places = placesFor(bot, groups, me, manages);
  const sections = (places ?? []).map((g) => ({
    key: g?.id ?? UNGROUPED,
    name: g?.name ?? t('sidebar.private'),
    space: !!g && isSpace(g),
  }));

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent
          className="w-60"
          // Focus goes to the dialog an item opened, not back to the bot.
          onCloseAutoFocus={(e) => dialogNext.current && (e.preventDefault(), (dialogNext.current = false))}
        >
          <ContextMenuItem
            onSelect={() => moveBot(bot.id, moveTo(bot.pinned ? (bot.groupId ?? UNGROUPED) : PINNED, null))}
          >
            {bot.pinned ? <PinOff /> : <Pin />}
            {bot.pinned ? t('sidebarMenu.unpin') : t('sidebarMenu.pin')}
          </ContextMenuItem>
          {places && (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <FolderInput /> {t('sidebarMenu.moveTo')}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent className="w-56">
                {sections.map((s) => (
                  <ContextMenuItem
                    key={s.key}
                    disabled={s.key === current}
                    onSelect={() => moveBot(bot.id, moveTo(s.key, null))}
                  >
                    {s.space && <Users />}
                    <span className="min-w-0 flex-1 truncate">{s.name}</span>
                    {s.key === current && <Check className="ms-auto" />}
                  </ContextMenuItem>
                ))}
                {isMine(bot, me) && (
                  <>
                    <ContextMenuSeparator />
                    <ContextMenuItem onSelect={toNewFolder}>
                      <FolderPlus /> {t('sidebarMenu.newFolderItem')}
                    </ContextMenuItem>
                  </>
                )}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={newThread}>
            <MessageSquarePlus /> {t('chat.newThread')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={rename}>
            <Pencil /> {t('sidebarMenu.renameBot')}
          </ContextMenuItem>
          <ContextMenuItem onSelect={clearThreads}>
            <MessagesSquare /> {t('sidebarMenu.clearThreads')}
          </ContextMenuItem>
          {unread && repliedAt ? (
            <ContextMenuItem onSelect={() => useSeen.getState().markSeen(bot.id, repliedAt)}>
              <MailOpen /> {t('sidebarMenu.markRead')}
            </ContextMenuItem>
          ) : (
            repliedAt && (
              <ContextMenuItem onSelect={() => useSeen.getState().markUnread(bot.id)}>
                <CircleDot /> {t('sidebarMenu.markUnread')}
              </ContextMenuItem>
            )
          )}
          {muted ? (
            <ContextMenuItem onSelect={() => unmute(bot.id)}>
              <Bell /> {t('sidebarMenu.unmute')}
            </ContextMenuItem>
          ) : (
            <ContextMenuSub>
              <ContextMenuSubTrigger>
                <BellOff /> {t('sidebarMenu.mute')}
              </ContextMenuSubTrigger>
              <ContextMenuSubContent>
                {(['hour', 'morning', 'always'] as const).map((choice) => (
                  <ContextMenuItem key={choice} onSelect={() => mute(bot.id, muteUntil(choice))}>
                    {t(`sidebarMenu.mute.${choice}`)}
                  </ContextMenuItem>
                ))}
              </ContextMenuSubContent>
            </ContextMenuSub>
          )}
          <ContextMenuItem
            onSelect={() => {
              dialogNext.current = true;
              openBotPage({ mode: 'edit', botId: bot.id });
            }}
          >
            <Settings2 /> {t('sidebarMenu.settings')}
          </ContextMenuItem>
          {bot.yourLevel !== 'chat' && (
            <ContextMenuItem onSelect={togglePause}>
              {bot.pausedAt ? <Play /> : <Pause />}
              {bot.pausedAt ? t('pause.resume') : t('pause.pause')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={archive}>
            <Archive /> {t('bot.archive')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
      <NameDialog naming={naming} onClose={() => setNaming(null)} />
    </>
  );
}

/**
 * The menu a right-click on a group's heading opens. `prevId` and `nextId` are the groups shown
 * above and below it; empty groups are hidden, so moving goes past them.
 */
export function GroupMenu({
  group,
  prevId,
  nextId,
  children,
}: {
  group: Group;
  prevId: string | null;
  nextId: string | null;
  children: React.ReactElement;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { data: groups = [] } = useGroups();
  const { data: allBots = [] } = useBots();
  const { data: summaries = [] } = useSummaries();
  const members = new Set(allBots.filter((b) => b.groupId === group.id).map((b) => b.id));
  const groupSummaries = summaries.filter((s) => members.has(s.botId));
  const anyUnread = useSeen((s) => groupSummaries.some((x) => isUnread(x, s.seen)));
  const [naming, setNaming] = useState<Naming>(null);
  const dialogNext = useRef(false);
  const refresh = () => qc.invalidateQueries({ queryKey: ['groups'] });
  const fail = (e: Error) => {
    toast.error(e.message);
    void refresh();
  };

  const manages = useManagesServer();
  const openSettings = useUi((s) => s.openSettings);
  const pause = usePauseActions();
  const togglePause = () => {
    const paused = !group.pausedAt;
    pause
      .group(group.id, paused)
      .then(
        () => toast.success(t(paused ? 'pause.groupPaused' : 'pause.groupResumed', { name: group.name })),
        fail,
      );
  };

  const after = (id: string) => groups[groups.findIndex((g) => g.id === id) + 1]?.id ?? null;

  /** Puts the group before `beforeId` (or last), on screen first, then on the server. */
  const move = (beforeId: string | null) => {
    qc.setQueryData<Group[]>(['groups'], (old) => {
      if (!old) return old;
      const rest = old.filter((g) => g.id !== group.id);
      const i = beforeId ? rest.findIndex((g) => g.id === beforeId) : -1;
      rest.splice(i < 0 ? rest.length : i, 0, group);
      return rest;
    });
    api.moveGroup(group.id, { beforeId }).then(refresh, fail);
  };
  const space = isSpace(group);
  // A space is looked after by those who look after the server; a folder by its owner, who alone sees it.
  const own = !space || manages;
  const remove = () => {
    const ask = space ? 'sidebarMenu.deleteSpaceConfirm' : 'sidebarMenu.deleteFolderConfirm';
    if (!confirm(t(ask, { name: group.name }))) return;
    api.deleteGroup(group.id).then(() => {
      void refresh();
      void qc.invalidateQueries({ queryKey: ['bots'] });
    }, fail);
  };

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent
          className="w-52"
          onCloseAutoFocus={(e) => dialogNext.current && (e.preventDefault(), (dialogNext.current = false))}
        >
          {own && (
            <ContextMenuItem
              onSelect={() => {
                dialogNext.current = true;
                setNaming({
                  title: t('sidebarMenu.renameGroup'),
                  initial: group.name,
                  save: (name) => api.renameGroup(group.id, name).then(refresh),
                });
              }}
            >
              <Pencil /> {t('sidebarMenu.rename')}
            </ContextMenuItem>
          )}
          <ContextMenuItem
            disabled={!anyUnread}
            onSelect={() => useSeen.getState().markAllSeen(groupSummaries)}
          >
            <MailOpen /> {t('sidebarMenu.markGroupRead')}
          </ContextMenuItem>
          {own && (
            <>
              <ContextMenuItem disabled={!prevId} onSelect={() => prevId && move(prevId)}>
                <ArrowUp /> {t('sidebarMenu.moveUp')}
              </ContextMenuItem>
              <ContextMenuItem disabled={!nextId} onSelect={() => nextId && move(after(nextId))}>
                <ArrowDown /> {t('sidebarMenu.moveDown')}
              </ContextMenuItem>
            </>
          )}
          {space && manages && (
            <ContextMenuItem
              onSelect={() => {
                dialogNext.current = true;
                openSettings('groups');
              }}
            >
              <Settings2 /> {t('spaces.settingsItem')}
            </ContextMenuItem>
          )}
          {manages && (
            <ContextMenuItem onSelect={togglePause}>
              {group.pausedAt ? <Play /> : <Pause />}
              {group.pausedAt ? t('pause.resumeGroup') : t('pause.pauseGroup')}
            </ContextMenuItem>
          )}
          {own && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem variant="destructive" onSelect={remove}>
                <Trash2 /> {t('common.delete')}
              </ContextMenuItem>
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <NameDialog naming={naming} onClose={() => setNaming(null)} />
    </>
  );
}

/** The menu a right-click on the sidebar's empty space opens: a new bot or a new group. */
export function SidebarMenu({ children }: { children: React.ReactElement }) {
  const t = useT();
  const qc = useQueryClient();
  const { data: summaries = [] } = useSummaries();
  const anyUnread = useSeen((s) => summaries.some((x) => isUnread(x, s.seen)));
  const openBotPage = useUi((s) => s.openBotPage);
  const [naming, setNaming] = useState<Naming>(null);
  const dialogNext = useRef(false);
  const manages = useManagesServer();
  const pause = usePauseActions();
  const { data: bots = [] } = useBots();
  const { data: groups = [] } = useGroups();
  const anyPaused = bots.some((b) => b.pausedAt) || groups.some((g) => g.pausedAt);
  const pauseAll = (paused: boolean) => {
    if (paused && !confirm(t('pause.allConfirm'))) return;
    pause.all(paused).then(
      ({ count }) => toast.success(t(paused ? 'pause.allPaused' : 'pause.allResumed', { count })),
      (e: Error) => toast.error(e.message),
    );
  };
  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
        <ContextMenuContent
          className="w-56"
          onCloseAutoFocus={(e) => dialogNext.current && (e.preventDefault(), (dialogNext.current = false))}
        >
          <ContextMenuItem
            onSelect={() => {
              dialogNext.current = true;
              openBotPage({ mode: 'create' });
            }}
          >
            <Plus /> {t('sidebar.newBot')}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              dialogNext.current = true;
              setNaming({
                title: t('sidebarMenu.newFolder'),
                initial: '',
                save: (name) =>
                  api.createGroup(name).then(() => qc.invalidateQueries({ queryKey: ['groups'] })),
              });
            }}
          >
            <FolderPlus /> {t('sidebarMenu.newFolder')}
          </ContextMenuItem>
          {manages && (
            <ContextMenuItem
              onSelect={() => {
                dialogNext.current = true;
                setNaming({
                  title: t('sidebarMenu.newSpace'),
                  initial: '',
                  save: (name) =>
                    api
                      .createGroup(name, { space: true })
                      .then(() => qc.invalidateQueries({ queryKey: ['groups'] })),
                });
              }}
            >
              <Users /> {t('sidebarMenu.newSpace')}
            </ContextMenuItem>
          )}
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!anyUnread} onSelect={() => useSeen.getState().markAllSeen(summaries)}>
            <MailOpen /> {t('sidebarMenu.markAllRead')}
          </ContextMenuItem>
          {manages && (
            <>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => pauseAll(true)}>
                <Pause /> {t('pause.all')}
              </ContextMenuItem>
              {anyPaused && (
                <ContextMenuItem onSelect={() => pauseAll(false)}>
                  <Play /> {t('pause.resumeAll')}
                </ContextMenuItem>
              )}
            </>
          )}
        </ContextMenuContent>
      </ContextMenu>
      <NameDialog naming={naming} onClose={() => setNaming(null)} />
    </>
  );
}

/** Asks for a name: a bot's or a group's new name, or a new group's. */
function NameDialog({ naming, onClose }: { naming: Naming; onClose(): void }) {
  return (
    <Dialog open={!!naming} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="rounded-3xl sm:max-w-sm">
        {naming && <NameForm naming={naming} onClose={onClose} />}
      </DialogContent>
    </Dialog>
  );
}

function NameForm({ naming, onClose }: { naming: NonNullable<Naming>; onClose(): void }) {
  const t = useT();
  const [name, setName] = useState(naming.initial);
  const [busy, setBusy] = useState(false);
  const value = name.trim();
  const valid = value.length > 0 && value.length <= 60;
  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid || busy) return;
        if (value === naming.initial) return onClose();
        setBusy(true);
        naming.save(value).then(onClose, (err: Error) => {
          setBusy(false);
          toast.error(err.message);
        });
      }}
    >
      <DialogHeader>
        <DialogTitle>{naming.title}</DialogTitle>
      </DialogHeader>
      <Input
        autoFocus
        value={name}
        maxLength={60}
        aria-label={naming.title}
        onChange={(e) => setName(e.target.value)}
        onFocus={(e) => e.currentTarget.select()}
        className="rounded-xl"
      />
      <DialogFooter>
        <Button type="button" variant="ghost" className="rounded-full" onClick={onClose}>
          {t('common.cancel')}
        </Button>
        <Button type="submit" className="rounded-full" disabled={!valid || busy}>
          {t('common.save')}
        </Button>
      </DialogFooter>
    </form>
  );
}
