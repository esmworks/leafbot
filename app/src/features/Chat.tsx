import { hasSecretShape, quoteExcerpt, type Bot, type Message, type Thread } from '@leafbot/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Archive,
  ArrowDown,
  ArrowUp,
  Bot as BotIcon,
  Loader2,
  Mic,
  ChevronDown,
  ChevronLeft,
  Clock,
  Download,
  MessageSquareText,
  MessageSquarePlus,
  PanelRight,
  Paperclip,
  Pause,
  Pencil,
  Play,
  AlarmClock,
  Link2,
  Pin,
  Quote,
  Reply,
  Search,
  ShieldAlert,
  Sparkles,
  Square,
  Target,
  RotateCcw,
  Trash2,
  Webhook,
  KanbanSquare,
  UsersRound,
  X,
  SmilePlus,
  Phone,
  PhoneOff,
} from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BotAvatar } from '@/components/BotAvatar';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { snoozeTimes, useMinuteClock } from '@/lib/snooze';
import { threadLink } from '@/lib/threadLink';
import { copyText } from '@/lib/clipboard';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { useBotActivityById, useThreadActivity } from '@/lib/botActivity';
import { useLocale, useT } from '@/i18n';
import { useDictation } from '@/lib/dictation';
import { useServerVoice } from '@/lib/speech';
import { useVoiceCall } from '@/lib/voiceCall';
import { useLiveCards } from '@/lib/liveCards';
import { newClientId, useFormat } from '@/lib/format';

/** Mirrors the server's page of messages: a full page means there may be older ones. */
const MESSAGE_PAGE = 500;
import { conversationMarkdown, exportFileName } from '@/lib/exportChat';
import {
  useApprovals,
  useBots,
  useMainThread,
  useManagesServer,
  useMessages,
  useRooms,
  useSettings,
  useSkills,
  useSummaries,
  useThreads,
} from '@/lib/queries';
import { useLayout } from '@/lib/layout';
import { usePaused, usePauseActions } from '@/lib/paused';
import { PHONE } from '@/lib/media';
import { useUi } from '@/lib/store';
import { replyElsewhere, useSeen, useThreadSeen } from '@/lib/unread';
import { FileLinks } from '@/lib/fileLink';
import { continueList } from '@/lib/listContinue';
import { keyAction, useSendKey } from '@/lib/sendKey';
import { pickSkill, skillQuery } from '@/lib/skillTag';
import { goalCommand, slashMatches, slashQuery, type SlashCommand } from '@/lib/slash';
import { editAsTyped } from '@/lib/undoableEdit';
import { useHoldReload } from '@/lib/update';
import { holdsFor, isOffline, retryOutbox, useOutbox } from '@/lib/outbox';
import { markedName } from '@/lib/markup';
import { ComputerButton } from './Computer';
import { EmojiButton } from '@/components/EmojiPicker';
import { PlanMeter } from './PlanMeter';
import { cn } from '@/lib/utils';
import { useFitHeight } from '@/lib/fitHeight';
import {
  AttachmentChips,
  filesFrom,
  useAnyAttachments,
  useAttachments,
  type StagedFile,
} from './Attachments';
import { FindBar } from './FindBar';
import { AssistantCard, CardDock, MessageItem, replyExcerpt, Working } from './MessageItem';

export function Chat({ bot }: { bot: Bot }) {
  const selectedThread = useUi((s) => s.threadId);
  const main = useMainThread(bot.id);
  const threadId = selectedThread ?? main.data?.id ?? null;
  const { data: threads = [] } = useThreads(bot.id);
  const thread =
    threads.find((t) => t.id === threadId) ?? (main.data?.id === threadId ? main.data : undefined);
  const waiting = useWaitingCards(bot.id);
  // A conversation remembered from an earlier visit that is gone since: back to the main one.
  const listed = useThreads(bot.id);
  useEffect(() => {
    if (!selectedThread || !listed.data || main.data?.id === selectedThread) return;
    if (!listed.data.some((th) => th.id === selectedThread)) useUi.getState().selectThread(null);
  }, [selectedThread, listed.data, main.data?.id]);
  // What the person had read of this bot when its chat opened: the line above the first reply
  // after it marks where the new ones start. Taken once, before opening marks them read.
  const [readUntil] = useState(() => useSeen.getState().seen?.[bot.id] ?? null);

  return (
    <div className="relative flex min-w-0 flex-1 flex-col">
      <Header bot={bot} thread={thread} threads={threads} mainId={main.data?.id} waiting={waiting} />
      {threadId ? (
        <Conversation
          key={threadId}
          bot={bot}
          threadId={threadId}
          thread={thread}
          readUntil={readUntil}
          elsewhere={
            <>
              <WaitingElsewhere threadId={threadId} threads={threads} waiting={waiting} />
              <ReplyElsewhere
                bot={bot}
                open={thread ?? { id: threadId }}
                threads={threads}
                mainId={main.data?.id}
              />
            </>
          }
        />
      ) : (
        <div className="flex-1" />
      )}
    </div>
  );
}

/**
 * The bot's cards still waiting for an answer, counted per conversation. The sidebar counts them
 * all, wherever they are, so every conversation they are in needs to be findable from here.
 */
function useWaitingCards(botId: string): Map<string, number> {
  const { data: approvals } = useApprovals();
  return useMemo(() => {
    const byThread = new Map<string, number>();
    for (const a of approvals ?? []) {
      if (a.botId === botId && a.status === 'pending')
        byThread.set(a.threadId, (byThread.get(a.threadId) ?? 0) + 1);
    }
    return byThread;
  }, [approvals, botId]);
}

/**
 * Saves a conversation as a Markdown file: every message, also those not loaded on screen, under
 * its author and time.
 */
function useExportConversation(bot: Bot) {
  const t = useT();
  const { dayLabel } = useFormat();
  const { data: bots = [] } = useBots();
  const { data: settings } = useSettings();
  const { data: threads = [] } = useThreads(bot.id);
  const main = useMainThread(bot.id);
  const name = useThreadName(main.data?.id);
  return async (threadId: string) => {
    try {
      const all: Message[] = [];
      for (let before: string | undefined; ;) {
        const page = await api.messages(threadId, before);
        all.unshift(...page);
        if (page.length < MESSAGE_PAGE || !page[0]) break;
        before = page[0].id;
      }
      const thread = threads.find((th) => th.id === threadId) ?? main.data;
      const title = `${bot.name} · ${thread ? name(thread) : t('chat.mainThread')}`;
      const author = (m: Message) => {
        if (m.author === 'user') return settings?.userName || t('export.you');
        const id = m.author.startsWith('bot:') ? m.author.slice(4) : null;
        if (id) return bots.find((b) => b.id === id)?.name ?? t('common.bot');
        return m.author.startsWith('routine:') ? t('export.routine') : m.author;
      };
      const md = conversationMarkdown(title, all, { author, time: (iso) => dayLabel(iso) });
      const url = URL.createObjectURL(new Blob([md], { type: 'text/markdown;charset=utf-8' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = exportFileName(title, new Date().toISOString().slice(0, 10));
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
}

/** Emoji a person can mark a conversation with, to find it again at a glance. */
const THREAD_ICONS = ['📌', '💼', '🏠', '💡', '📊', '🧾', '✈️', '🛒', '📚', '🔧', '❤️', '⭐'];

/** A conversation's name in lists: a bot conversation without a title is named after the other bot. */
function useThreadName(mainId?: string) {
  const t = useT();
  const { data: bots = [] } = useBots();
  return (th: Thread) => {
    if (th.id === mainId) return t('chat.mainThread');
    if (th.title) return th.title;
    const peer = th.peerBotId ? bots.find((b) => b.id === th.peerBotId) : undefined;
    return peer ? t('chat.withBot', { bot: peer.name }) : t('chat.newThread');
  };
}

/**
 * Cards of this bot waiting in its other conversations (one another bot opened, a routine's),
 * which the person would not see from here otherwise.
 */
function WaitingElsewhere({
  threadId,
  threads,
  waiting,
}: {
  threadId: string;
  threads: Thread[];
  waiting: Map<string, number>;
}) {
  const t = useT();
  const selectThread = useUi((s) => s.selectThread);
  const openRoom = useUi((s) => s.openRoom);
  const { data: rooms = [] } = useRooms();
  const name = useThreadName();
  const { data: bots = [] } = useBots();
  const others = [...waiting].filter(([id]) => id !== threadId);
  if (!others.length) return null;
  const count = others.reduce((n, [, c]) => n + c, 0);
  const [firstId] = others[0]!;
  const first = threads.find((th) => th.id === firstId);
  // An untitled bot conversation reads better named by the other bot than quoted.
  const peer =
    first && !first.title && first.peerBotId ? bots.find((b) => b.id === first.peerBotId) : undefined;
  return (
    <div className="mx-auto w-full max-w-(--chat-width) px-3 pb-2 sm:px-6">
      <div className="flex items-center gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/5 py-2 pr-2 pl-4 text-sm">
        <ShieldAlert className="size-4 shrink-0 text-amber-500" />
        <span className="min-w-0 flex-1">
          {others.length !== 1 || !first
            ? t('chat.waitingElsewhere', { count })
            : peer
              ? t('chat.waitingWithBot', { count, bot: peer.name })
              : t('chat.waitingIn', { count, place: name(first) })}
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="rounded-full"
          // A card waiting in a room is answered there.
          onClick={() => (rooms.some((r) => r.id === firstId) ? openRoom(firstId) : selectThread(firstId))}
        >
          {t('chat.showWaiting')}
        </Button>
      </div>
    </div>
  );
}

/**
 * The bot's latest reply when it landed in another of its conversations (a routine's, say): the
 * sidebar shows it, so the chat has to lead to it.
 */
function ReplyElsewhere({
  bot,
  open,
  threads,
  mainId,
}: {
  bot: Bot;
  open: { id: string; updatedAt?: string };
  threads: Thread[];
  mainId?: string;
}) {
  const t = useT();
  const selectThread = useUi((s) => s.selectThread);
  const name = useThreadName(mainId);
  const { data: summaries } = useSummaries();
  const summary = summaries?.find((x) => x.botId === bot.id);
  const seenIn = useThreadSeen((s) => s.seenIn);
  // Having the conversation open is having seen its replies.
  useEffect(() => {
    if (summary?.repliedAt && summary.repliedThreadId === open.id)
      useThreadSeen.getState().mark(open.id, summary.repliedAt);
  }, [summary?.repliedAt, summary?.repliedThreadId, open.id]);
  const where = replyElsewhere(summary, open, seenIn);
  const target = where ? threads.find((th) => th.id === where) : undefined;
  if (!target) return null;
  return (
    <div className="mx-auto w-full max-w-(--chat-width) px-3 pb-2 sm:px-6">
      <div className="flex items-center gap-3 rounded-2xl border bg-muted/40 py-2 pr-2 pl-4 text-sm">
        <MessageSquareText className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate">
          {t('chat.replyElsewhere', { bot: bot.name, place: name(target) })}
        </span>
        <Button
          size="sm"
          variant="secondary"
          className="rounded-full"
          onClick={() => selectThread(target.id)}
        >
          {t('chat.showReply')}
        </Button>
      </div>
    </div>
  );
}

function Header({
  bot,
  thread,
  threads,
  mainId,
  waiting,
}: {
  bot: Bot;
  thread?: Thread;
  threads: Thread[];
  mainId?: string;
  waiting: Map<string, number>;
}) {
  const t = useT();
  const selectThread = useUi((s) => s.selectThread);
  const { panelBeside } = useLayout();
  const togglePanel = useUi((s) => s.togglePanel);
  const togglePanelSheet = useUi((s) => s.togglePanelSheet);
  // Beside the chat the panel stays open as chosen; over it, it opens only on request.
  const panelOpen = useUi((s) => (panelBeside ? s.panelOpen : s.panelSheet));
  const showList = useUi((s) => s.showList);
  const findOpen = useUi((s) => s.findOpen);
  const setFindOpen = useUi((s) => s.setFindOpen);
  const qc = useQueryClient();
  const create = useMutation({
    mutationFn: () => api.newThread(bot.id),
    onSuccess: (created) => {
      void qc.invalidateQueries({ queryKey: ['threads', bot.id] });
      selectThread(created.id);
    },
    onError: (e) => toast.error((e as Error).message),
  });
  // Archived and snoozed conversations are listed apart, unless a card waits in one.
  const now = useMinuteClock();
  const snoozedNow = (th: Thread) => !!th.snoozedUntil && new Date(th.snoozedUntil).getTime() > now;
  const away = (th: Thread) => !waiting.has(th.id) && (!!th.archivedAt || snoozedNow(th));
  const listed = threads.filter((th) => !away(th));
  const archived = threads.filter((th) => th.archivedAt && away(th));
  const snoozed = threads.filter((th) => !th.archivedAt && away(th));
  const userThreads = listed.filter((th) => th.kind === 'user');
  const botThreads = listed.filter((th) => th.kind === 'bot');
  // A routine's reports reach the main conversation; its own is listed only while it needs the
  // person (a card waiting) or they pinned it. Each run opens from its report and from the routine.
  const routineThreads = listed.filter(
    (th) => th.kind === 'routine' && (waiting.has(th.id) || !!th.pinnedAt),
  );
  // A ticket's work is followed on the board; its conversation is listed only while it needs the person.
  const ticketThreads = listed.filter((th) => th.kind === 'ticket' && (waiting.has(th.id) || !!th.pinnedAt));
  const apiThreads = listed.filter((th) => th.kind === 'api');
  // The team's conversations with the bot, from a Slack or Discord channel: everyone who may talk
  // with it sees them.
  const teamThreads = listed.filter((th) => th.kind === 'team');
  const refresh = () => qc.invalidateQueries({ queryKey: ['threads', bot.id] });
  const fail = (e: Error) => toast.error(e.message);
  const renameThread = (th: Thread) => {
    const next = window.prompt(t('chat.renamePrompt'), th.title || name(th));
    if (next === null || !next.trim()) return;
    void api.updateThread(th.id, { title: next.trim().slice(0, 120) }).then(refresh, fail);
  };
  const archiveThread = (th: Thread, on: boolean) =>
    void api
      .updateThread(th.id, { archived: on })
      .then(() => {
        if (on) selectThread(null);
        void qc.invalidateQueries({ queryKey: ['main-thread', bot.id] });
        return refresh();
      })
      .catch(fail);
  const resetThread = (th: Thread) => {
    if (!window.confirm(t('chat.resetConfirm'))) return;
    void api
      .resetThread(th.id)
      .then(() => refresh())
      .catch(fail);
  };
  const patchThread = (th: Thread, patch: Parameters<typeof api.updateThread>[1], leave = false) =>
    void api
      .updateThread(th.id, patch)
      .then(() => {
        if (leave) selectThread(null);
        void qc.invalidateQueries({ queryKey: ['main-thread', bot.id] });
        return refresh();
      })
      .catch(fail);
  const deleteThread = (th: Thread) => {
    if (!window.confirm(t('chat.deleteConfirm', { name: name(th) }))) return;
    void api
      .deleteThread(th.id)
      .then(() => {
        selectThread(null);
        void qc.invalidateQueries({ queryKey: ['main-thread', bot.id] });
        return refresh();
      })
      .catch(fail);
  };
  const name = useThreadName(mainId);
  const title = thread && thread.id !== mainId ? name(thread) : null;
  const activity = useBotActivityById(bot.id);
  const exportConversation = useExportConversation(bot);

  return (
    <div className="@container/chathead pointer-events-none absolute inset-x-0 top-0 z-10 bg-gradient-to-b from-background via-background/80 to-transparent pb-6">
      {/* Equal side columns keep the bot's name in the middle. */}
      <div className="window-drag grid grid-cols-[1fr_minmax(0,auto)_1fr] items-center gap-2 px-3 pt-3 sm:px-4">
        <div className="flex items-center">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="pointer-events-auto rounded-full roomy:hidden"
                onClick={showList}
                aria-label={t('chat.backToList')}
              >
                <ChevronLeft className="size-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('chat.backToList')}</TooltipContent>
          </Tooltip>
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button className="pointer-events-auto flex max-w-full min-w-0 items-center gap-2 rounded-full border bg-background/80 py-1.5 pr-3 pl-1.5 shadow-sm backdrop-blur transition-colors hover:bg-accent">
              <BotAvatar
                avatar={bot.avatar}
                color={bot.color}
                seed={bot.id}
                size={28}
                activity={activity}
                motion="always"
              />
              <span className="truncate text-[15px] font-semibold">{bot.name}</span>
              {title && (
                <span className="truncate text-[15px] text-muted-foreground">
                  · {thread?.icon ? `${thread.icon} ` : ''}
                  {title}
                </span>
              )}
              <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="center" className="w-72 max-w-[calc(100vw-2rem)] rounded-2xl">
            <DropdownMenuItem onClick={() => create.mutate()}>
              <MessageSquarePlus /> {t('chat.newThread')}
            </DropdownMenuItem>
            {thread && (
              <DropdownMenuItem onClick={() => void exportConversation(thread.id)}>
                <Download /> {t('export.action')}
              </DropdownMenuItem>
            )}
            {thread && (
              <DropdownMenuItem
                onClick={async () => {
                  if (await copyText(threadLink(thread.id))) toast.success(t('chat.linkCopied'));
                  else toast.error(t('message.copyFailed'));
                }}
              >
                <Link2 /> {t('chat.copyLink')}
              </DropdownMenuItem>
            )}
            {thread && (
              <DropdownMenuItem onClick={() => renameThread(thread)}>
                <Pencil /> {t('chat.renameThread')}
              </DropdownMenuItem>
            )}
            {thread && (
              <DropdownMenuItem onClick={() => resetThread(thread)}>
                <RotateCcw /> {t('chat.resetThread')}
              </DropdownMenuItem>
            )}
            {thread && (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>
                  <SmilePlus /> {t('chat.threadIcon')}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="rounded-2xl">
                  <div className="grid grid-cols-6 gap-1 p-1">
                    {THREAD_ICONS.map((icon) => (
                      <DropdownMenuItem
                        key={icon}
                        className="justify-center text-lg"
                        onClick={() => patchThread(thread, { icon })}
                      >
                        {icon}
                      </DropdownMenuItem>
                    ))}
                  </div>
                  {thread.icon && (
                    <DropdownMenuItem onClick={() => patchThread(thread, { icon: '' })}>
                      {t('chat.threadIconNone')}
                    </DropdownMenuItem>
                  )}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            )}
            {thread && (
              <DropdownMenuItem onClick={() => patchThread(thread, { pinned: !thread.pinnedAt })}>
                <Pin /> {thread.pinnedAt ? t('chat.unpinThread') : t('chat.pinThread')}
              </DropdownMenuItem>
            )}
            {thread &&
              (thread.snoozedUntil && new Date(thread.snoozedUntil).getTime() > now ? (
                <DropdownMenuItem onClick={() => patchThread(thread, { snoozedUntil: null })}>
                  <AlarmClock /> {t('chat.unsnoozeThread')}
                </DropdownMenuItem>
              ) : (
                <DropdownMenuSub>
                  <DropdownMenuSubTrigger>
                    <AlarmClock /> {t('chat.snoozeThread')}
                  </DropdownMenuSubTrigger>
                  <DropdownMenuSubContent className="rounded-2xl">
                    {snoozeTimes(new Date(now)).map((o) => (
                      <DropdownMenuItem
                        key={o.key}
                        onClick={() => patchThread(thread, { snoozedUntil: o.at.toISOString() }, true)}
                      >
                        {t(`chat.snooze.${o.key}`)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuSubContent>
                </DropdownMenuSub>
              ))}
            {thread && (
              <DropdownMenuItem onClick={() => archiveThread(thread, !thread.archivedAt)}>
                <Archive /> {thread.archivedAt ? t('chat.unarchiveThread') : t('chat.archiveThread')}
              </DropdownMenuItem>
            )}
            {thread && (
              <DropdownMenuItem variant="destructive" onClick={() => deleteThread(thread)}>
                <Trash2 /> {t('chat.deleteThread')}
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <ThreadGroup
              label={t('chat.threads')}
              items={userThreads}
              name={name}
              waiting={waiting}
              onPick={selectThread}
            />
            <ThreadGroup
              label={t('chat.teamThreads')}
              items={teamThreads}
              name={name}
              waiting={waiting}
              onPick={selectThread}
              icon={<UsersRound />}
            />
            <ThreadGroup
              label={t('chat.botThreads')}
              items={botThreads}
              name={name}
              waiting={waiting}
              onPick={selectThread}
              icon={<BotIcon />}
            />
            <ThreadGroup
              label={t('chat.routineThreads')}
              items={routineThreads}
              name={name}
              waiting={waiting}
              onPick={selectThread}
              icon={<Clock />}
            />
            <ThreadGroup
              label={t('chat.ticketThreads')}
              items={ticketThreads}
              name={name}
              waiting={waiting}
              onPick={selectThread}
              icon={<KanbanSquare />}
            />
            <ThreadGroup
              label={t('chat.apiThreads')}
              items={apiThreads}
              name={name}
              waiting={waiting}
              onPick={selectThread}
              icon={<Webhook />}
            />
            <ThreadGroup
              label={t('chat.snoozedThreads')}
              items={snoozed}
              name={name}
              waiting={waiting}
              onPick={selectThread}
              icon={<AlarmClock />}
            />
            <ThreadGroup
              label={t('chat.archivedThreads')}
              items={archived}
              name={name}
              waiting={waiting}
              onPick={selectThread}
              icon={<Archive />}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="pointer-events-auto flex items-center justify-end gap-1">
          {bot.engine === 'claude' && <PlanMeter />}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn('rounded-full max-sm:hidden', findOpen && 'bg-accent')}
                onClick={() => setFindOpen(!findOpen)}
                aria-label={t('find.open')}
              >
                <Search className="size-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('find.open')}</TooltipContent>
          </Tooltip>
          <ComputerButton bot={bot} />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn('rounded-full', panelOpen && 'bg-accent')}
                onClick={() => (panelBeside ? togglePanel() : togglePanelSheet())}
                aria-label={t('chat.togglePanel')}
              >
                <PanelRight className="size-5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{panelOpen ? t('chat.closePanel') : t('chat.openPanel')}</TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}

function ThreadGroup({
  label,
  items,
  name,
  waiting,
  onPick,
  icon,
}: {
  label: string;
  items: Thread[];
  name(th: Thread): string;
  waiting: Map<string, number>;
  onPick(id: string): void;
  icon?: React.ReactNode;
}) {
  const t = useT();
  const { shortTime } = useFormat();
  if (!items.length) return null;
  // A conversation with a card waiting comes first and stays in the list however old it is; the
  // ones the person pinned come next, then the rest by date.
  const rank = (th: Thread) => (waiting.has(th.id) ? 2 : th.pinnedAt ? 1 : 0);
  const shown = items.filter((th, i) => i < 12 || rank(th) > 0).sort((a, b) => rank(b) - rank(a));
  return (
    <>
      <DropdownMenuLabel className="text-xs text-muted-foreground">{label}</DropdownMenuLabel>
      {shown.map((th) => {
        const cards = waiting.get(th.id);
        return (
          <DropdownMenuItem key={th.id} onClick={() => onPick(th.id)} className="gap-2">
            {icon}
            {th.pinnedAt && !icon && (
              <Pin className="size-3.5 shrink-0 text-muted-foreground" aria-label={t('chat.pinnedThread')} />
            )}
            {th.icon && <span className="shrink-0 text-base leading-none">{th.icon}</span>}
            <span className="flex-1 truncate">{name(th)}</span>
            {cards ? (
              <span
                className="flex size-4 shrink-0 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-black"
                aria-label={t('chat.waitingCards', { count: cards })}
              >
                {cards}
              </span>
            ) : (
              <span className="text-xs text-muted-foreground">{shortTime(th.updatedAt)}</span>
            )}
          </DropdownMenuItem>
        );
      })}
    </>
  );
}

function Conversation({
  bot,
  threadId,
  thread,
  readUntil,
  elsewhere,
}: {
  bot: Bot;
  threadId: string;
  thread?: Thread;
  /** The time of the bot's latest reply the person had seen when the chat opened. */
  readUntil: string | null;
  elsewhere?: React.ReactNode;
}) {
  const t = useT();
  const qc = useQueryClient();
  const { dayLabel } = useFormat();
  const { data: recent = [], isLoading } = useMessages(threadId);
  // Messages before the latest page, loaded on request and kept while the conversation is open.
  const [older, setOlder] = useState<Message[]>([]);
  const [olderDone, setOlderDone] = useState(false);
  const messages = useMemo(() => {
    if (!older.length) return recent;
    const ids = new Set(recent.map((m) => m.id));
    return [...older.filter((m) => !ids.has(m.id)), ...recent];
  }, [older, recent]);
  const { data: bots = [] } = useBots();
  const botMap = useMemo(() => new Map(bots.map((b) => [b.id, b])), [bots]);
  const stream = useUi((s) => s.streams[threadId]);
  const liveState = useUi((s) => s.states[threadId]);
  const state = liveState ?? thread?.state ?? 'idle';
  const [pending, setPending] = useState<Message[]>([]);
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const loadOlder = useMutation({
    mutationFn: () => api.messages(threadId, messages[0]!.id),
    onSuccess: (page) => {
      const box = scroller.current;
      const from = box ? box.scrollHeight - box.scrollTop : 0;
      stick.current = false;
      setOlder((o) => [...page, ...o]);
      if (page.length < MESSAGE_PAGE) setOlderDone(true);
      // Keep the message the person was looking at in place as the older ones go in above.
      requestAnimationFrame(() => {
        if (box) box.scrollTop = box.scrollHeight - from;
      });
    },
    onError: (e) => {
      toast.error((e as Error).message);
      useUi.getState().focusMessage(null);
    },
  });
  const hasOlder = !olderDone && (older.length > 0 || recent.length >= MESSAGE_PAGE);
  // Scrolling up to the top brings in the page before by itself; the button stays for keyboards.
  const olderEdge = useRef<HTMLDivElement>(null);
  const loadingOlder = loadOlder.isPending;
  const fetchOlder = loadOlder.mutate;
  useEffect(() => {
    const edge = olderEdge.current;
    const box = scroller.current;
    if (!edge || !box || !hasOlder) return;
    const watch = new IntersectionObserver(
      ([entry]) => {
        // Only once the person has scrolled: a short conversation shows the edge from the start.
        if (entry?.isIntersecting && !loadingOlder && !stick.current) fetchOlder();
      },
      { root: box, rootMargin: '200px 0px 0px 0px' },
    );
    watch.observe(edge);
    return () => watch.disconnect();
  }, [hasOlder, loadingOlder, fetchOlder]);
  // How many messages there were when the person scrolled up; null while at the bottom.
  const [awayAt, setAwayAt] = useState<number | null>(null);
  const attachments = useAttachments(threadId);
  const firstNew = useMemo(
    () =>
      readUntil === null
        ? null
        : (messages.find((m, i) => i > 0 && m.role === 'assistant' && m.createdAt > readUntil)?.id ?? null),
    [messages, readUntil],
  );
  const [dragging, setDragging] = useState(false);
  // Quick replies are not messages to read: the latest set shows as buttons at the end, and only
  // while nothing was said after it. An error whose request was run again has its answer, or a
  // new error, after it.
  const listed = useMemo(
    () =>
      messages.filter(
        (m) => !Array.isArray(m.props.quickReplies) && !(m.role === 'error' && m.props.retried),
      ),
    [messages],
  );
  const replies = useMemo(() => {
    const at = messages.findLastIndex((m) => Array.isArray(m.props.quickReplies));
    if (at < 0 || messages.slice(at + 1).some((m) => m.role === 'user')) return null;
    return (messages[at]!.props.quickReplies as unknown[]).filter((x): x is string => typeof x === 'string');
  }, [messages]);
  const sendText = (text: string) => {
    const clientId = newClientId();
    stick.current = true;
    const m: Message = {
      id: clientId,
      threadId,
      role: 'user',
      author: 'user',
      text,
      props: {},
      clientId,
      turnId: null,
      createdAt: new Date().toISOString(),
    };
    // Behind messages still waiting here, so the conversation keeps the order they were written in.
    if (holdsFor(threadId)) return hold(m, [], undefined);
    setPending((p) => [...p, m]);
    api
      .send(threadId, clientId, text)
      .then(() => qc.invalidateQueries({ queryKey: ['messages', threadId] }))
      .catch((e: Error) => {
        if (isOffline(e)) return hold(m, [], undefined);
        setPending((p) => p.filter((x) => x.clientId !== clientId));
        toast.error(e.message);
      });
  };
  // A message the server could not be reached for stays where it was written, marked as waiting
  // for the connection, and goes out on its own when it is back.
  const allHeld = useOutbox((s) => s.items);
  const held = useMemo(() => allHeld.filter((h) => h.threadId === threadId), [allHeld, threadId]);
  useHoldReload(allHeld.length > 0);
  const hold = (m: Message, files: string[], replyTo: string | undefined) => {
    stick.current = true;
    setPending((p) => p.filter((x) => x.clientId !== m.clientId));
    useOutbox.getState().hold({
      threadId,
      clientId: m.clientId!,
      text: m.text,
      files,
      replyTo,
      message: { ...m, props: { ...m.props, heldOffline: true } },
    });
    retryOutbox();
  };
  const [replyTo, setReplyTo] = useState<Message | null>(null);

  // Pending (optimistic) messages disappear once the server copy arrives.
  const shown = [...held.map((h) => h.message), ...pending].filter(
    (p) => !messages.some((m) => m.clientId === p.clientId),
  );
  // A sent message stays one row, keyed by its clientId, from the moment it is sent until the
  // server's copy replaces it, so it neither redraws nor moves when that copy arrives.
  const all = shown.length ? [...listed, ...shown] : listed;
  const waiting = new Set(shown.map((m) => m.clientId));
  const streamDone = stream && messages.some((m) => m.turnId === stream.turnId && m.role === 'assistant');
  // A card asked while the reply streams in goes inside it, where it was asked.
  const { rows, parts } = useLiveCards(all, stream, !!streamDone);
  const [dock, setDock] = useState<HTMLDivElement | null>(null);
  const busy = state === 'running' || state === 'queued';
  const activity = useThreadActivity(bot.id, threadId, state);

  useLayoutEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, shown.length, stream?.text, busy]);

  // A message picked in the search: brought into view once it is here, and lit for a moment.
  const focusTarget = useUi((s) => s.focusedMessage);
  const focused = focusTarget?.threadId === threadId ? focusTarget.id : null;
  const focusLoaded = !!focused && messages.some((m) => m.id === focused);
  // A message further back than the pages on screen: older pages come in until it is there.
  useEffect(() => {
    if (!focused || focusLoaded || isLoading || loadOlder.isPending) return;
    if (hasOlder) loadOlder.mutate();
    else useUi.getState().focusMessage(null);
  }, [focused, focusLoaded, hasOlder, isLoading, loadOlder]);
  useEffect(() => {
    if (!focused || !focusLoaded) return;
    const box = scroller.current;
    const el = box?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(focused)}"]`);
    if (!box || !el) return;
    stick.current = false;
    // Only the conversation scrolls; scrollIntoView would move the whole page too.
    const at = el.getBoundingClientRect();
    const view = box.getBoundingClientRect();
    box.scrollTop += at.top - view.top - (view.height - Math.min(at.height, view.height)) / 2;
    el.classList.add('message-found');
    const id = setTimeout(() => el.classList.remove('message-found'), 2000);
    useUi.getState().focusMessage(null);
    return () => clearTimeout(id);
  }, [focused, focusLoaded]);

  const findOpen = useUi((s) => s.findOpen);
  // ⌘F / Ctrl+F finds in this conversation rather than in the page around it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        useUi.getState().setFindOpen(true);
      }
      // ⌘⇧N / Ctrl+Shift+N: a new conversation with this bot (a browser may keep the key for itself).
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void api
          .newThread(bot.id)
          .then((created) => {
            void qc.invalidateQueries({ queryKey: ['threads', bot.id] });
            useUi.getState().selectThread(created.id);
          })
          .catch((err: Error) => toast.error(err.message));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bot.id, qc]);

  // The reply is revealed letter by letter, so its height grows without any prop changing here.
  useEffect(() => {
    const el = scroller.current;
    const content = el?.firstElementChild;
    if (!el || !content) return;
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // Links in the conversation name files relative to its folder.
  const fileLinks = useMemo(
    () => ({ botId: bot.id, base: `bots/${bot.id}/threads/${threadId}` }),
    [bot.id, threadId],
  );
  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes('Files');
  return (
    // Files dropped anywhere on the conversation are attached to the next message.
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      onDragOver={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
      }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDragging(false);
        attachments.add(filesFrom(e.dataTransfer));
      }}
    >
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-20 flex items-center justify-center rounded-3xl border-2 border-dashed border-primary/50 bg-background/80 text-base font-medium backdrop-blur-sm">
          {t('chat.dropFiles')}
        </div>
      )}
      <div
        ref={scroller}
        // On a touch screen a tap on the conversation puts the keyboard away, as messaging apps do;
        // a tap on a link, button or field does what it always does.
        onPointerDown={(e) => {
          const typing = document.activeElement;
          if (
            e.pointerType === 'touch' &&
            typing instanceof HTMLTextAreaElement &&
            !(e.target as Element).closest('a, button, input, textarea, select, [role="button"]')
          )
            typing.blur();
        }}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
          if (stick.current) {
            if (awayAt !== null) setAwayAt(null);
          } else if (awayAt === null) setAwayAt(messages.length);
        }}
        className="scroll-thin flex-1 overflow-y-auto"
      >
        <FileLinks.Provider value={fileLinks}>
          <CardDock.Provider value={dock}>
            <div className="mx-auto flex max-w-(--chat-width) flex-col gap-4 px-3 pt-20 pb-6 sm:px-6">
              {(thread?.goal || thread?.pinned) && (
                <div className="sticky top-16 z-[5] flex flex-col gap-1.5">
                  {thread.goal && <GoalBar threadId={threadId} botId={bot.id} goal={thread.goal} />}
                  {thread.pinned && <PinnedBar threadId={threadId} botId={bot.id} pinned={thread.pinned} />}
                </div>
              )}
              {!isLoading && messages.length === 0 && shown.length === 0 && <Empty bot={bot} />}
              {hasOlder && (
                <div ref={olderEdge} className="flex justify-center">
                  <Button
                    variant="secondary"
                    size="sm"
                    className="rounded-full"
                    disabled={loadOlder.isPending}
                    onClick={() => loadOlder.mutate()}
                  >
                    {t('chat.loadOlder')}
                  </Button>
                </div>
              )}
              {rows.map((m, i) => (
                <Fragment key={m.clientId ?? m.id}>
                  {needsDivider(rows[i - 1], m) && (
                    <div className="py-2 text-center text-xs text-muted-foreground">
                      {dayLabel(m.createdAt)}
                    </div>
                  )}
                  {m.id === firstNew && (
                    <div
                      className="flex items-center gap-3 text-xs font-medium text-sky-600 dark:text-sky-400"
                      role="separator"
                    >
                      <span className="h-px flex-1 bg-sky-500/40" />
                      {t('chat.newSince')}
                      <span className="h-px flex-1 bg-sky-500/40" />
                    </div>
                  )}
                  <ErrorBoundary fallback={<BrokenMessage />}>
                    <MessageItem
                      m={m}
                      bots={botMap}
                      tint={bot.color}
                      botId={bot.id}
                      onReply={setReplyTo}
                      canRetry={i === rows.length - 1 && activity === 'idle' && !shown.length}
                      pending={waiting.has(m.clientId)}
                    />
                  </ErrorBoundary>
                </Fragment>
              ))}
              {parts.map((p) =>
                p.kind === 'text' ? (
                  <AssistantCard
                    key={`text-${p.from}`}
                    text={p.text}
                    turnId={p.live ? stream?.turnId : undefined}
                    streaming={p.live}
                  />
                ) : (
                  <ErrorBoundary key={p.card.id} fallback={<BrokenMessage />}>
                    <MessageItem
                      m={p.card}
                      bots={botMap}
                      tint={bot.color}
                      botId={bot.id}
                      onReply={setReplyTo}
                    />
                  </ErrorBoundary>
                ),
              )}
              {/* Cards waiting in an exchange between bots, out of sight where it began. */}
              <div ref={setDock} className="flex flex-col gap-4 empty:hidden" />
              {activity !== 'idle' && !streamDone && (
                <Working bot={bot} activity={activity} threadId={threadId ?? undefined} />
              )}
              {replies && activity === 'idle' && !shown.length && (
                <QuickReplies options={replies} onPick={sendText} />
              )}
            </div>
          </CardDock.Provider>
        </FileLinks.Provider>
      </div>
      <ReplyAnnouncer messages={messages} bots={botMap} />
      {findOpen && <FindBar threadId={threadId} scroller={scroller} />}
      <QuoteSelection scroller={scroller} />
      {awayAt !== null && (
        <ToBottom
          unread={messages.slice(awayAt).filter((m) => m.author !== 'user').length}
          onClick={() => {
            const el = scroller.current;
            if (!el) return;
            stick.current = true;
            setAwayAt(null);
            el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
          }}
        />
      )}
      {elsewhere}
      <PausedBar bot={bot} />
      <Composer
        key={threadId}
        bot={bot}
        threadId={threadId}
        attachments={attachments}
        busy={busy || state === 'waiting'}
        replyTo={replyTo}
        onReplyChange={setReplyTo}
        onPending={(m) => {
          stick.current = true;
          setPending((p) => [...p, m]);
        }}
        onFailed={(clientId) => setPending((p) => p.filter((x) => x.clientId !== clientId))}
        onHeld={hold}
      />
    </div>
  );
}

/**
 * A button over text selected in a message: it quotes the text at the top of the draft, so the
 * answer can be about that part only.
 */
function QuoteSelection({ scroller }: { scroller: React.RefObject<HTMLDivElement | null> }) {
  const t = useT();
  const [at, setAt] = useState<{ x: number; y: number; text: string } | null>(null);
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const update = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      const node = sel?.anchorNode;
      const inMessage =
        !!node &&
        box.contains(node) &&
        !!(node instanceof Element ? node : node.parentElement)?.closest('[data-message-id]');
      if (!sel || sel.isCollapsed || !text || !inMessage) return setAt(null);
      const r = sel.getRangeAt(0).getBoundingClientRect();
      const view = box.parentElement!.getBoundingClientRect();
      setAt({ x: r.left + r.width / 2 - view.left, y: r.top - view.top, text });
    };
    const onUp = () => requestAnimationFrame(update);
    const onChange = () => {
      if (window.getSelection()?.isCollapsed) setAt(null);
    };
    box.addEventListener('mouseup', onUp);
    box.addEventListener('keyup', onUp);
    box.addEventListener('scroll', onChange);
    document.addEventListener('selectionchange', onChange);
    return () => {
      box.removeEventListener('mouseup', onUp);
      box.removeEventListener('keyup', onUp);
      box.removeEventListener('scroll', onChange);
      document.removeEventListener('selectionchange', onChange);
    };
  }, [scroller]);
  if (!at) return null;
  return (
    <button
      type="button"
      // Pressing must not clear the selection before the click lands.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => {
        useUi.getState().quote(at.text);
        window.getSelection()?.removeAllRanges();
        setAt(null);
      }}
      style={{ left: at.x, top: Math.max(at.y - 40, 4) }}
      className="absolute z-20 flex -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background px-3 py-1.5 text-sm shadow-md hover:bg-accent"
    >
      <Quote className="size-3.5" /> {t('chat.quote')}
    </button>
  );
}

/** A paste longer than this many characters is attached as a text file instead. */
const LONG_PASTE = 4000;

/** Back to the latest message; counts what arrived while the person read further up. */
function ToBottom({ unread, onClick }: { unread: number; onClick(): void }) {
  const t = useT();
  const label = unread > 0 ? t('chat.newMessages', { count: unread }) : t('chat.toBottom');
  return (
    <div className="pointer-events-none relative z-10 h-0">
      <button
        type="button"
        onClick={onClick}
        aria-label={label}
        title={label}
        className="pointer-events-auto absolute bottom-2 left-1/2 flex h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border bg-background/95 px-3 text-sm shadow-md backdrop-blur hover:bg-accent"
      >
        <ArrowDown className="size-4" />
        {unread > 0 && <span className="tabular-nums">{t('chat.newMessages', { count: unread })}</span>}
      </button>
    </div>
  );
}

function needsDivider(prev: Message | undefined, m: Message) {
  if (!prev) return true;
  return new Date(m.createdAt).getTime() - new Date(prev.createdAt).getTime() > 60 * 60 * 1000;
}

function Empty({ bot }: { bot: Bot }) {
  const t = useT();
  return (
    <div className="flex flex-col items-center gap-3 pt-[12vh] text-center">
      <BotAvatar
        avatar={bot.avatar}
        color={bot.color}
        seed={bot.id}
        size={72}
        activity="idle"
        motion="always"
      />
      <div className="text-xl font-semibold">{bot.name}</div>
      <p className="max-w-md text-sm text-muted-foreground">{bot.description || t('chat.emptyHint')}</p>
    </div>
  );
}

function Composer({
  bot,
  threadId,
  attachments,
  busy,
  replyTo,
  onReplyChange,
  onPending,
  onFailed,
  onHeld,
}: {
  bot: Bot;
  threadId: string;
  attachments: ReturnType<typeof useAttachments>;
  busy: boolean;
  /** The bot message being answered, quoted above the text box until sent or cancelled. */
  replyTo: Message | null;
  onReplyChange(m: Message | null): void;
  onPending(m: Message): void;
  onFailed(clientId: string): void;
  /** The server could not be reached: the message waits for the connection instead of failing. */
  onHeld(m: Message, files: string[], replyTo: string | undefined): void;
}) {
  const t = useT();
  const [text, setText] = useState(() => readDraft(threadId));
  // The unsent text stays with its conversation: switching away and back, or a reload, keeps it.
  // It is written once typing pauses, and at once when the conversation changes or closes.
  const latest = useRef(text);
  useEffect(() => {
    latest.current = text;
    const timer = setTimeout(() => writeDraft(threadId, text), DRAFT_PAUSE_MS);
    return () => clearTimeout(timer);
  }, [threadId, text]);
  useEffect(() => () => writeDraft(threadId, latest.current), [threadId]);
  const ref = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const qc = useQueryClient();
  const locale = useLocale((s) => s.locale);
  // Spoken text joins what is already typed, with a space between.
  const dictation = useDictation({
    locale,
    onText: (spoken) => setText((now) => (now && !/\s$/.test(now) ? `${now} ${spoken}` : `${now}${spoken}`)),
    onError: (error) =>
      toast.error(t('chat.dictationFailed', { message: error.key ? t(error.key) : error.message })),
  });

  // Typing `$` lists the bot's skills; the picked one is named in the message for the bot to read.
  const { data: allSkills = [] } = useSkills();
  const [caret, setCaret] = useState<number | null>(null);
  const [skillPick, setSkillPick] = useState(0);
  const [skillsClosed, setSkillsClosed] = useState(false);
  const tag = caret === null ? null : skillQuery(text, caret);
  const skillOptions = useMemo(() => {
    if (!tag) return [];
    const q = tag.query.toLocaleLowerCase();
    return (
      allSkills
        // The name, or the words of what the skill is for.
        .filter(
          (k) =>
            k.botIds.includes(bot.id) &&
            (k.name.toLocaleLowerCase().includes(q) || k.description.toLocaleLowerCase('tr').includes(q)),
        )
        .sort(
          (a, b) =>
            Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || a.name.localeCompare(b.name),
        )
        .slice(0, 8)
    );
  }, [tag, allSkills, bot.id]);
  const skillMenu = !skillsClosed && skillOptions.length > 0;

  // A text of just `/` and letters lists what the box can do itself, without asking the bot.
  const { panelBeside } = useLayout();
  const exportConversation = useExportConversation(bot);
  const slash = slashQuery(text);
  // The bot's skills come after the commands: picking one names it in the message, as `$` does.
  const slashOptions = useMemo((): SlashOption[] => {
    if (slash === null) return [];
    const commands = slashMatches(
      slash,
      (c) => t(`slash.${c}`),
      (c) => c !== 'stop' || busy,
    ).map((id) => ({ kind: 'command' as const, id }));
    const skills = allSkills
      .filter((k) => k.botIds.includes(bot.id) && k.name.includes(slash))
      .slice(0, 5)
      .map((k) => ({ kind: 'skill' as const, name: k.name, description: k.description }));
    return [...commands, ...skills];
  }, [slash, t, busy, allSkills, bot.id]);
  const runOption = (o: SlashOption) => {
    if (o.kind === 'command') return runCommand(o.id);
    const el = ref.current;
    const next = '$' + o.name + ' ';
    if (el) editAsTyped(el, next, next.length);
    else setText(next);
  };
  const slashMenu = !skillsClosed && slashOptions.length > 0;
  const runCommand = (c: SlashCommand) => {
    setText('');
    const ui = useUi.getState();
    if (c === 'new')
      void api
        .newThread(bot.id)
        .then((created) => {
          void qc.invalidateQueries({ queryKey: ['threads', bot.id] });
          ui.selectThread(created.id);
        })
        .catch((e: Error) => toast.error(e.message));
    else if (c === 'find') ui.setFindOpen(true);
    else if (c === 'stop') stop.mutate();
    else if (c === 'routine') useUi.getState().openRoutine({ botId: bot.id, routineId: null });
    else if (c === 'memory') ui.openSettings('memory');
    else if (c === 'export') void exportConversation(threadId);
    else if (c === 'shortcuts') ui.setShortcutsOpen(true);
    else if (c === 'today') ui.setTodayOpen(true);
    else if (c === 'goal') {
      // The goal itself is typed after the command, then sent with Enter.
      const el = ref.current;
      if (el) editAsTyped(el, '/goal ', 6);
      else setText('/goal ');
      return;
    } else if (c === 'settings') ui.openBotDialog({ mode: 'edit', botId: bot.id });
    else if (panelBeside) ui.togglePanel();
    else ui.togglePanelSheet();
  };
  const noteCaret = (el: HTMLTextAreaElement) => {
    setCaret(el.selectionStart === el.selectionEnd ? el.selectionStart : null);
  };
  const chooseSkill = (name: string) => {
    const el = ref.current;
    if (!el || caret === null) return;
    const next = pickSkill(text, caret, name);
    if (!next) return;
    editAsTyped(el, next.text, next.caret);
    setCaret(next.caret);
  };

  // On a phone focusing would pop up the keyboard over the conversation before anyone asked.
  useEffect(() => {
    if (!matchMedia(PHONE).matches) ref.current?.focus();
  }, [threadId]);
  // Back in the window, the person can type at once, unless they were in another field or a dialog.
  useEffect(() => {
    const onFocus = () => {
      if (matchMedia(PHONE).matches) return;
      const active = document.activeElement;
      if (active && active !== document.body) return;
      if (document.querySelector('[role="dialog"]')) return;
      ref.current?.focus();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, []);
  // Picking a message to answer is asking to write, so the text box takes focus on phones too.
  useEffect(() => {
    if (replyTo) ref.current?.focus();
  }, [replyTo]);
  useFitHeight(ref, text);

  const sendKey = useSendKey((s) => s.key);
  // Text quoted from a message goes to the top of the draft, as a Markdown quote.
  useEffect(
    () =>
      useUi.subscribe((state) => {
        const picked = state.pendingQuote;
        if (!picked) return;
        state.quote(null);
        const quoted = picked
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n');
        setText((prev) => `${quoted}\n\n${prev}`);
        requestAnimationFrame(() => {
          const el = ref.current;
          if (!el) return;
          el.focus();
          el.setSelectionRange(el.value.length, el.value.length);
        });
      }),
    [],
  );
  const send = useMutation({
    mutationFn: (m: {
      clientId: string;
      text: string;
      files: StagedFile[];
      replyTo: Message | null;
      /** As the conversation shows it while it is on its way. */
      shown: Message;
      /** Said aloud in a voice call. */
      spoken?: boolean;
    }) =>
      api.send(
        threadId,
        m.clientId,
        m.text,
        m.files.map((f) => f.name),
        m.replyTo?.id,
        undefined,
        m.spoken,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messages', threadId] }),
    onError: (e, m) => {
      if (isOffline(e))
        return onHeld(
          m.shown,
          m.files.map((f) => f.name),
          m.replyTo?.id,
        );
      onFailed(m.clientId);
      setText((t) => t || m.text);
      attachments.restore(m.files);
      if (m.replyTo) onReplyChange(m.replyTo);
      toast.error((e as Error).message);
    },
  });
  const stop = useMutation({
    mutationFn: () => api.stop(threadId),
    onError: (e) => toast.error((e as Error).message),
  });

  // A new version waits for the draft, files left in any composer and the send before reloading.
  const anyFiles = useAnyAttachments();
  useHoldReload(!!text.trim() || anyFiles || send.isPending);

  // Where the caret was is kept by the picker opening; the box itself lost the focus to it.
  const insertEmoji = (emoji: string) => {
    const el = ref.current;
    if (!el) return;
    const start = el.selectionStart ?? el.value.length;
    const end = el.selectionEnd ?? start;
    editAsTyped(el, el.value.slice(0, start) + emoji + el.value.slice(end), start + emoji.length);
  };
  const ready = attachments.items.length > 0 && !attachments.uploading;
  const canSend = !attachments.uploading && (!!text.trim() || ready);
  const submit = () => {
    const value = text.trim();
    if (!canSend) return;
    // `/goal …` sets what the conversation is for instead of being sent.
    const goal = goalCommand(value);
    if (goal !== null && !attachments.items.length) {
      setText('');
      void api
        .setGoal(threadId, goal)
        .then(() => {
          void qc.invalidateQueries({ queryKey: ['threads', bot.id] });
          void qc.invalidateQueries({ queryKey: ['main-thread', bot.id] });
          toast.success(goal ? t('goal.set') : t('goal.cleared'));
        })
        .catch((e: Error) => toast.error(e.message));
      return;
    }
    const files = attachments.take();
    const clientId = newClientId();
    const shown: Message = {
      id: clientId,
      threadId,
      role: 'user',
      author: 'user',
      text: value,
      props: {
        // Shown without links until the server's copy, with each file's final path, arrives.
        ...(files.length ? { files: files.map((f) => ({ ...f, path: '' })) } : {}),
        ...(replyTo ? { replyTo: { id: replyTo.id, text: replyExcerpt(replyTo) } } : {}),
      },
      clientId,
      turnId: null,
      createdAt: new Date().toISOString(),
    };
    setText('');
    onReplyChange(null);
    // Behind messages still waiting here, so the conversation keeps the order they were written in.
    if (holdsFor(threadId)) {
      onHeld(
        shown,
        files.map((f) => f.name),
        replyTo?.id,
      );
      return;
    }
    onPending(shown);
    send.mutate({ clientId, text: value, files, replyTo, shown });
  };
  // What is said in a voice call goes as a message of its own, beside whatever is typed.
  const sendSpoken = (value: string) => {
    const clientId = newClientId();
    const shown: Message = {
      id: clientId,
      threadId,
      role: 'user',
      author: 'user',
      text: value,
      props: { spoken: true },
      clientId,
      turnId: null,
      createdAt: new Date().toISOString(),
    };
    if (holdsFor(threadId)) return onHeld(shown, [], undefined);
    onPending(shown);
    send.mutate({ clientId, text: value, files: [], replyTo: null, shown, spoken: true });
  };
  const { data: callMessages = [] } = useMessages(threadId);
  const serverVoice = useServerVoice();
  const voiceCall = useVoiceCall({
    locale,
    busy,
    messages: callMessages,
    send: sendSpoken,
    serverVoice,
    onError: (error) =>
      toast.error(t('chat.dictationFailed', { message: error.key ? t(error.key) : error.message })),
  });

  return (
    <div className="px-3 pb-3 sm:px-6 sm:pb-4">
      {voiceCall.state !== 'off' && (
        <div
          role="status"
          className="mx-auto mb-2 flex max-w-(--chat-width) items-center gap-3 rounded-2xl bg-secondary/70 px-4 py-2"
        >
          <span
            aria-hidden
            className="size-2.5 shrink-0 rounded-full bg-primary transition-transform"
            style={{ transform: `scale(${1 + Math.min(voiceCall.level * 25, 1.4)})` }}
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            {t(`call.${voiceCall.state}`, { name: bot.name })}
          </span>
          <Button type="button" size="sm" variant="destructive" onClick={voiceCall.hangUp}>
            <PhoneOff className="size-4" />
            {t('call.hangUp')}
          </Button>
        </div>
      )}
      {slashMenu && (
        <div className="relative mx-auto max-w-(--chat-width)">
          <div
            role="listbox"
            aria-label={t('slash.title')}
            className="absolute bottom-1 left-0 z-20 w-full max-w-sm overflow-hidden rounded-2xl border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            {slashOptions.map((o, i) => (
              <button
                key={o.kind === 'command' ? o.id : 'skill:' + o.name}
                type="button"
                role="option"
                aria-selected={i === skillPick % slashOptions.length}
                onMouseDown={(e) => {
                  e.preventDefault();
                  runOption(o);
                }}
                className={cn(
                  'flex w-full items-baseline gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm',
                  i === skillPick % slashOptions.length && 'bg-accent text-accent-foreground',
                )}
              >
                {o.kind === 'command' ? (
                  <>
                    <span className="w-20 shrink-0 font-mono text-xs text-muted-foreground">/{o.id}</span>
                    <span className="min-w-0 truncate">{t(`slash.${o.id}`)}</span>
                  </>
                ) : (
                  <>
                    <span className="flex w-20 shrink-0 items-center gap-1 text-xs text-muted-foreground">
                      <Sparkles className="size-3" /> {t('slash.skill')}
                    </span>
                    <span className="min-w-0 truncate">
                      <span className="font-medium">{o.name}</span>
                      {o.description && <span className="text-muted-foreground"> · {o.description}</span>}
                    </span>
                  </>
                )}
              </button>
            ))}
          </div>
        </div>
      )}
      {skillMenu && !slashMenu && (
        <div className="relative mx-auto max-w-(--chat-width)">
          <div
            role="listbox"
            aria-label={t('chat.skillPick')}
            className="absolute bottom-1 left-0 z-20 w-full max-w-sm overflow-hidden rounded-2xl border bg-popover p-1 text-popover-foreground shadow-lg"
          >
            {skillOptions.map((k, i) => (
              <button
                key={k.id}
                type="button"
                role="option"
                aria-selected={i === skillPick % skillOptions.length}
                onMouseDown={(e) => {
                  e.preventDefault();
                  chooseSkill(k.name);
                }}
                className={cn(
                  'flex w-full items-start gap-2 rounded-xl px-2.5 py-1.5 text-left text-sm',
                  i === skillPick % skillOptions.length && 'bg-accent text-accent-foreground',
                )}
              >
                <Sparkles className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0">
                  <span className="block truncate font-medium">{`$${k.name}`}</span>
                  {k.description && (
                    <span className="block truncate text-xs text-muted-foreground">{k.description}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="mx-auto flex max-w-(--chat-width) flex-col rounded-[24px] border bg-card p-1 shadow-sm focus-within:ring-2 focus-within:ring-ring/30"
      >
        {replyTo && (
          <div className="mx-1 mt-1 flex items-center gap-2 rounded-2xl bg-secondary py-1.5 pr-1.5 pl-3 text-sm text-muted-foreground">
            <Reply className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">{replyExcerpt(replyTo)}</span>
            <Button
              type="button"
              size="icon"
              variant="ghost"
              className="size-6 shrink-0 rounded-full"
              onClick={() => onReplyChange(null)}
              aria-label={t('chat.cancelReply')}
            >
              <X className="size-3.5" />
            </Button>
          </div>
        )}
        {hasSecretShape(text) && (
          // A key typed here reaches the model and stays in the conversation; the vault keeps it
          // where no bot sees it. Sending is still the person's call.
          <div
            role="status"
            className="mx-1 mb-1 flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/5 py-1.5 pr-1.5 pl-3 text-xs"
          >
            <ShieldAlert className="size-4 shrink-0 text-amber-500" />
            <span className="flex-1">{t('chat.secretWarning')}</span>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 rounded-full"
              onClick={() => useUi.getState().openSettings('vault')}
            >
              {t('chat.secretToVault')}
            </Button>
          </div>
        )}
        <AttachmentChips
          items={attachments.items}
          onRemove={attachments.remove}
          onRetry={attachments.retry}
          onMarkUp={(a, png, notes) => {
            attachments.add([
              new File([png], markedName(a.name, t('markup.fileSuffix')), { type: 'image/png' }),
            ]);
            if (notes) setText((prev) => (prev.trim() ? `${prev.trimEnd()}\n\n${notes}` : notes));
          }}
        />
        <div className="flex items-end gap-1">
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              attachments.add([...(e.target.files ?? [])]);
              e.target.value = '';
            }}
          />
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-9 shrink-0 rounded-full text-muted-foreground"
                onClick={() => picker.current?.click()}
                aria-label={t('chat.attach')}
              >
                <Paperclip className="size-[18px]" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>{t('chat.attach')}</TooltipContent>
          </Tooltip>
          <EmojiButton onPick={insertEmoji} />
          <textarea
            ref={ref}
            rows={1}
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              noteCaret(e.target);
              setSkillPick(0);
              setSkillsClosed(false);
            }}
            onSelect={(e) => noteCaret(e.currentTarget)}
            onBlur={() => setCaret(null)}
            onPaste={(e) => {
              const files = filesFrom(e.clipboardData, { paste: true });
              if (files.length) {
                e.preventDefault();
                attachments.add(files);
                return;
              }
              // A long paste (a log, a document) goes as a text file, so the message stays readable.
              const pasted = e.clipboardData.getData('text/plain');
              if (pasted.length > LONG_PASTE) {
                e.preventDefault();
                attachments.add([new File([pasted], t('chat.pastedName'), { type: 'text/plain' })]);
                toast.info(t('chat.pastedAsFile', { count: pasted.length }));
              }
            }}
            onKeyDown={(e) => {
              if (slashMenu && !e.nativeEvent.isComposing) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const n = slashOptions.length;
                  setSkillPick((p) => (p + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
                  return;
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  e.preventDefault();
                  runOption(slashOptions[skillPick % slashOptions.length]!);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSkillsClosed(true);
                  return;
                }
              }
              if (skillMenu && !e.nativeEvent.isComposing) {
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const n = skillOptions.length;
                  setSkillPick((p) => (p + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
                  return;
                }
                if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
                  e.preventDefault();
                  chooseSkill(skillOptions[skillPick % skillOptions.length]!.name);
                  return;
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setSkillsClosed(true);
                  return;
                }
              }
              if (e.key === 'Escape' && replyTo) {
                e.preventDefault();
                onReplyChange(null);
                return;
              }
              const action = keyAction({ ...e, isComposing: e.nativeEvent.isComposing }, sendKey);
              if (action === 'send') {
                e.preventDefault();
                submit();
                return;
              }
              if (action === 'newline') {
                const el = e.currentTarget;
                if (el.selectionStart !== el.selectionEnd) return;
                const next = continueList(text, el.selectionStart);
                if (!next) return;
                e.preventDefault();
                editAsTyped(el, next.text, next.caret);
              }
            }}
            placeholder={replyTo ? t('chat.replyPlaceholder') : t('chat.placeholder', { name: bot.name })}
            className="scroll-thin max-h-60 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-base outline-none sm:text-[15px] placeholder:text-muted-foreground"
          />
          {voiceCall.supported && voiceCall.state === 'off' && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-9 shrink-0 rounded-full text-muted-foreground"
                  onClick={voiceCall.start}
                  aria-label={t('call.start')}
                >
                  <Phone className="size-[18px]" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{t('call.start')}</TooltipContent>
            </Tooltip>
          )}
          {dictation.supported && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant={dictation.state === 'recording' ? 'destructive' : 'ghost'}
                  className={cn(
                    'size-9 shrink-0 rounded-full',
                    dictation.state !== 'recording' && 'text-muted-foreground',
                  )}
                  onClick={dictation.toggle}
                  disabled={dictation.state === 'working'}
                  aria-pressed={dictation.state === 'recording'}
                  aria-label={t(dictation.state === 'recording' ? 'chat.dictationStop' : 'chat.dictation')}
                >
                  {dictation.state === 'working' ? (
                    <Loader2 className="size-[18px] animate-spin" />
                  ) : dictation.state === 'recording' ? (
                    <Square className="size-3.5 fill-current" />
                  ) : (
                    <Mic className="size-[18px]" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {t(dictation.state === 'recording' ? 'chat.dictationStop' : 'chat.dictation')}
              </TooltipContent>
            </Tooltip>
          )}
          {busy && !text.trim() && !attachments.items.length ? (
            <Button
              type="button"
              size="icon"
              variant="secondary"
              className="size-9 shrink-0 rounded-full"
              onClick={() => stop.mutate()}
              aria-label={t('chat.stop')}
            >
              <Square className="size-3.5 fill-current" />
            </Button>
          ) : (
            <Button
              type="submit"
              size="icon"
              className="size-9 shrink-0 rounded-full text-white"
              style={{ background: bot.color }}
              disabled={!canSend}
              aria-label={t('chat.send')}
            >
              <ArrowUp className="size-5" />
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}

type SlashOption =
  { kind: 'command'; id: SlashCommand } | { kind: 'skill'; name: string; description: string };

/**
 * Tells a screen reader about each reply once it has arrived whole, by the bot's name and its
 * start: the streamed text is not announced token by token, and the replies already there when
 * the conversation opened are not read out again.
 */
function ReplyAnnouncer({ messages, bots }: { messages: Message[]; bots: Map<string, Bot> }) {
  const t = useT();
  // Only replies written after the conversation opened; history loads in later and stays quiet.
  const [since] = useState(() => new Date().toISOString());
  const latest = messages.findLast(
    (m) => (m.role === 'assistant' || m.role === 'error') && m.createdAt > since,
  );
  const name = latest?.author.startsWith('bot:') ? bots.get(latest.author.slice(4))?.name : undefined;
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {latest
        ? t(latest.role === 'error' ? 'chat.announceError' : 'chat.announceReply', {
            name: name ?? t('common.bot'),
            text: quoteExcerpt(latest.text, 300),
          })
        : ''}
    </div>
  );
}

/** What the conversation is for, above its messages, with a button that clears it. */
/**
 * Says the bot is paused, above the message box: what the person writes waits until it is
 * resumed, and the button resumes it (or its group) at once.
 */
function PausedBar({ bot }: { bot: Bot }) {
  const t = useT();
  const { paused, group } = usePaused(bot);
  const manages = useManagesServer();
  const pause = usePauseActions();
  const [busy, setBusy] = useState(false);
  if (!paused) return null;
  const may = group ? manages : bot.yourLevel !== 'chat';
  const resume = () => {
    setBusy(true);
    (group ? pause.group(group.id, false) : pause.bot(bot.id, false))
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setBusy(false));
  };
  return (
    <div className="mx-auto mb-2 flex w-full max-w-3xl items-center gap-2 rounded-2xl border bg-muted/60 px-3 py-2 text-sm">
      <Pause className="size-4 shrink-0 fill-current text-muted-foreground" />
      <span className="min-w-0 flex-1">
        {group
          ? t('pause.barGroup', { name: bot.name, group: group.name })
          : t('pause.bar', { name: bot.name })}
      </span>
      {may && (
        <Button size="sm" variant="outline" className="shrink-0 rounded-xl" disabled={busy} onClick={resume}>
          <Play className="size-3.5" /> {group ? t('pause.resumeGroup') : t('pause.resume')}
        </Button>
      )}
    </div>
  );
}

function GoalBar({ threadId, botId, goal }: { threadId: string; botId: string; goal: string }) {
  const t = useT();
  const qc = useQueryClient();
  const clear = () =>
    void api
      .setGoal(threadId, '')
      .then(() => qc.invalidateQueries({ queryKey: ['threads', botId] }))
      .catch((e: Error) => toast.error(e.message));
  return (
    <div className="flex items-start gap-2 rounded-2xl border border-[var(--brand)]/30 bg-background/90 px-3 py-2 text-sm shadow-sm backdrop-blur">
      <Target className="mt-0.5 size-4 shrink-0 text-[var(--brand)]" />
      <span className="min-w-0 flex-1">
        <span className="font-medium">{t('goal.label')}</span> {goal}
      </span>
      <button
        type="button"
        onClick={clear}
        aria-label={t('goal.clear')}
        title={t('goal.clear')}
        className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** The message pinned above the conversation: a click brings it into view, the cross unpins it. */
function PinnedBar({
  threadId,
  botId,
  pinned,
}: {
  threadId: string;
  botId: string;
  pinned: NonNullable<Thread['pinned']>;
}) {
  const t = useT();
  const qc = useQueryClient();
  const unpin = () =>
    void api
      .pinMessage(threadId, null)
      .then(() => qc.invalidateQueries({ queryKey: ['threads', botId] }))
      .catch((e: Error) => toast.error(e.message));
  return (
    <div className="flex items-start gap-2 rounded-2xl border bg-background/90 px-3 py-2 text-sm shadow-sm backdrop-blur">
      <Pin className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left hover:underline"
        onClick={() => useUi.getState().focusMessage({ id: pinned.id, threadId })}
        title={t('pin.jump')}
      >
        {pinned.text}
      </button>
      <button
        type="button"
        onClick={unpin}
        aria-label={t('pin.remove')}
        title={t('pin.remove')}
        className="shrink-0 rounded-full p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

/** The bot's suggested answers under its reply; a press sends that text as the person's message. */
function QuickReplies({ options, onPick }: { options: string[]; onPick(text: string): void }) {
  return (
    <div className="flex flex-wrap gap-2 pl-1" role="group">
      {options.map((o) => (
        <Button
          key={o}
          type="button"
          variant="outline"
          size="sm"
          className="h-auto rounded-full px-3 py-1.5 text-sm whitespace-normal"
          onClick={() => onPick(o)}
        >
          {o}
        </Button>
      ))}
    </div>
  );
}

/** In place of a message that could not be drawn; the rest of the conversation stays. */
function BrokenMessage() {
  const t = useT();
  return <div className="py-1 text-center text-xs text-muted-foreground">{t('chat.messageBroken')}</div>;
}

/** How long typing pauses before the draft is saved. */
const DRAFT_PAUSE_MS = 400;
const draftKey = (threadId: string) => `leafbot.draft.${threadId}`;

function readDraft(threadId: string): string {
  try {
    return localStorage.getItem(draftKey(threadId)) ?? '';
  } catch {
    return '';
  }
}

function writeDraft(threadId: string, text: string) {
  try {
    if (text.trim()) localStorage.setItem(draftKey(threadId), text);
    else localStorage.removeItem(draftKey(threadId));
  } catch {
    // Storage can be off (a private window); the draft then lasts until the page closes.
  }
}
