import {
  BRAND_COLOR,
  APPROVAL_TIMED_OUT,
  catalogEntry,
  connectionToolParts,
  describeAction,
  emailPreview,
  outsideTrigger,
  joinPicks,
  parseAnswers,
  splitPicks,
  questionItems,
  type Approval,
  type Bot,
  type Locale,
  type Message,
  type MessageFile,
  type OutsideTrigger,
  type ReplyQuote,
  quoteExcerpt,
  subagentCounts,
  subagentOf,
  subagentsOf,
  subagentTime,
  type SubagentCard as Subagent,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertCircle,
  Ban,
  KanbanSquare,
  Check,
  Circle,
  CircleCheck,
  ChevronDown,
  Clock,
  Copy,
  Eye,
  FileCode,
  GitBranch,
  KeyRound,
  Lightbulb,
  Pin,
  LoaderCircle,
  PenLine,
  Reply,
  ShieldAlert,
  SmilePlus,
  Square,
  Trash2,
  Undo2,
  Volume2,
  X,
  RotateCcw,
  Play,
  WifiOff,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type FormEvent,
  type ReactNode,
} from 'react';
import { toast } from 'sonner';
import { create } from 'zustand';
import { BotAvatar } from '@/components/BotAvatar';
import { MessageFiles } from './Attachments';
import { UndoTurnDialog } from './UndoTurn';
import { Markdown } from '@/components/Markdown';
import { copyText } from '@/lib/clipboard';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Switch } from '@/components/ui/switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLocale, useT, type T } from '@/i18n';
import { api } from '@/lib/api';
import { newClientId } from '@/lib/format';
import type { BotActivity } from '@/lib/botActivity';
import {
  useApprovals,
  useConnections,
  useJob,
  useMainThread,
  usePeople,
  useTurnChanges,
} from '@/lib/queries';
import { personNameOf } from './PeopleTab';
import { toolLabel } from '@/lib/toolLabel';
import { isRefusal } from '@/lib/refusal';
import { BotPage } from './BotPage';
import { ChatCard } from './ChatCard';
import { McpAppView } from './McpAppView';
import { EmailApprovalCard } from './EmailApproval';
import { speechSupported, toggleSpeech, useServerVoice, useSpeech } from '@/lib/speech';
import { useUi } from '@/lib/store';
import { AppLogo } from './Connections';
import { useTypewriter } from '@/lib/typewriter';
import { cn } from '@/lib/utils';

export function MessageItem({
  m,
  bots,
  pending,
  tint,
  botId,
  onReply,
  canRetry,
}: {
  m: Message;
  bots: Map<string, Bot>;
  pending?: boolean;
  /** The conversation's bot: attached files download from its folder. */
  botId?: string;
  /** The conversation's bot colour; the person's messages are drawn in a deeper shade of it. */
  tint?: string;
  /** Starts a reply to this message in the composer; without it the bot's messages have no reply button. */
  onReply?(m: Message): void;
  /** The conversation's last row with the bot idle: a failed or stopped request may run again. */
  canRetry?: boolean;
}) {
  const t = useT();
  const retry = canRetry && !m.props.retried && m.props.kind !== 'auth' && !!m.turnId;
  const authorBot = m.author.startsWith('bot:') ? bots.get(m.author.slice(4)) : undefined;
  const files = messageFiles(m);
  const quote = replyQuoteOf(m);
  // A page the bot made with show_page.
  const page =
    m.props.page && typeof m.props.page === 'object'
      ? (m.props.page as { path: string; name: string; height?: number })
      : null;
  switch (m.role) {
    case 'user':
      if (authorBot) return <IncomingBot m={m} bot={authorBot} />;
      return (
        <div className="group/own flex flex-col items-end gap-1" data-message-id={m.id}>
          {quote && <QuoteLine quote={quote} threadId={m.threadId} />}
          {m.author.startsWith('ticket:') && (
            <span className="wallpaper-chip flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs text-muted-foreground">
              <KanbanSquare className="size-3" />
              {t('message.ticketNamed', { number: String(m.props.ticketNumber ?? '') })}
            </span>
          )}
          {m.author.startsWith('routine:') && (
            <span className="wallpaper-chip flex items-center gap-1 rounded-lg px-2 py-0.5 text-xs text-muted-foreground">
              <Clock className="size-3" />
              {typeof m.props.routineName === 'string'
                ? t('message.routineNamed', { name: m.props.routineName })
                : t('message.routine')}
            </span>
          )}
          {files.length > 0 && <MessageFiles files={files} botId={pending ? undefined : botId} />}
          {m.props.queued === true && !pending ? (
            <QueuedMessage m={m} tint={tint} hasFiles={files.length > 0} />
          ) : (
            (m.text || !files.length) && (
              <div
                className={cn(
                  'relative max-w-[80%] rounded-3xl px-4 py-2.5 text-[15px] [overflow-wrap:anywhere]',
                  tint
                    ? 'wallpaper-mine wallpaper-tint bg-(--tint-fill) text-white'
                    : 'wallpaper-mine wallpaper-bubble bg-secondary',
                  typeof m.props.reaction === 'string' && 'mb-4',
                )}
                style={tint ? tintFill(tint) : undefined}
              >
                <Markdown
                  text={m.text}
                  breaks
                  className="prose-chat prose-mine leading-relaxed break-words"
                />
                {typeof m.props.reaction === 'string' && <Reaction emoji={m.props.reaction} />}
              </div>
            )
          )}
          {/* While it is on its way the row keeps the actions' room, so nothing below it moves when they come. */}
          {pending && m.props.heldOffline === true ? (
            <OfflineLine text={t('message.heldOffline')} />
          ) : pending ? (
            <div className="h-7" aria-hidden />
          ) : (
            <>
              {m.props.sentOffline === true && <OfflineLine text={t('message.sentOffline')} />}
              {m.author === 'user' && !m.props.queued && <OwnMessageActions m={m} />}
            </>
          )}
        </div>
      );
    case 'assistant':
      return (
        // The actions sit right under the message; the row's own height takes most of the gap to the next one.
        <div
          className="group/message -mb-2 flex flex-col"
          data-message-id={m.id}
          data-reply-start={m.turnId ?? m.id}
        >
          {(m.props.routineReport === true || m.props.routineInMain === true) && <RoutineReportLine m={m} />}
          {m.props.card ? (
            <ChatCard m={m} />
          ) : page ? (
            <BotPage
              botId={botId ?? ''}
              path={page.path}
              name={page.name}
              title={m.text}
              height={page.height}
            />
          ) : files.length ? (
            // Files the bot sent with send_file, with its note if it wrote one.
            <div className="flex flex-col items-start gap-2">
              <MessageFiles files={files} botId={botId} align="start" />
              {m.text && <AssistantCard text={m.text} turnId={m.turnId} />}
            </div>
          ) : (
            <AssistantCard text={m.text} turnId={m.turnId} partial={!!m.props.partial} messageId={m.id} />
          )}
          {!pending && <MessageActions m={m} onReply={onReply} />}
        </div>
      );
    case 'marker':
      return <Marker m={m} bots={bots} />;
    case 'approval':
      return (
        <ApprovalCard
          approvalId={String(m.props.approvalId ?? '')}
          fallback={m.text}
          bots={bots}
          heldBy={typeof m.props.heldBy === 'string' ? m.props.heldBy : undefined}
          reviewReason={typeof m.props.reviewReason === 'string' ? m.props.reviewReason : undefined}
          resembles={typeof m.props.resembles === 'string' ? m.props.resembles : undefined}
          askRule={typeof m.props.askRule === 'string' ? m.props.askRule : undefined}
          outside={outsideTrigger(m.props.outside)}
          noAlways={m.props.noAlways === true}
          onAnswerLate={onReply ? () => onReply(m) : undefined}
        />
      );
    case 'error':
      return (
        <div className="wallpaper-frost [--frost-tint:color-mix(in_oklab,var(--color-destructive)_10%,transparent)] flex max-w-(--bubble-width) gap-3 rounded-3xl border border-destructive/30 bg-destructive/10 px-5 py-4 text-[15px]">
          <AlertCircle className="mt-0.5 size-5 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
            {m.text}
            {retry && (
              <div className="mt-3 flex flex-wrap gap-2">
                {m.props.stepLimit === true && <GoOnButton threadId={m.threadId} />}
                <RetryButton messageId={m.id} />
              </div>
            )}
            {m.props.kind === 'auth' && (
              <div className="mt-3">
                <Button
                  size="sm"
                  className="rounded-full"
                  onClick={() => useUi.getState().openSettings('connection')}
                >
                  {t('message.connectClaude')}
                </Button>
              </div>
            )}
          </div>
          <CopyDetails m={m} />
        </div>
      );
    default:
      if (Array.isArray(m.props.plan)) return <PlanCard items={m.props.plan as PlanItem[]} />;
      if (m.props.subagents) {
        const group = subagentsOf(m.props);
        if (group)
          return group.length > 1 ? <SubagentGroupCard list={group} /> : <SubagentCard sub={group[0]!} />;
      }
      if (m.props.subagent) {
        const sub = subagentOf(m.props);
        if (sub) return <SubagentCard sub={sub} />;
      }
      if (typeof m.props.connectionSignIn === 'string')
        return <SignInCard connectionId={m.props.connectionSignIn} text={m.text} botId={botId} />;
      if (m.props.app && typeof m.props.app === 'object') return <McpAppView m={m} />;
      if (typeof m.props.openedThread === 'string') {
        const id = m.props.openedThread;
        return (
          <div className="flex items-center justify-center gap-2 py-1 text-center text-sm text-muted-foreground">
            {m.text}
            <Button
              size="sm"
              variant="secondary"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => useUi.getState().selectThread(id)}
            >
              {t('message.openThread')}
            </Button>
          </div>
        );
      }
      if (typeof m.props.suggestApp === 'string')
        return <AppSuggestion catalogId={m.props.suggestApp} reason={m.text} botId={botId} />;
      if (m.props.kind === 'offer') return <OfferCard m={m} />;
      // A page hid instructions for agents: a warning the person should not scroll past.
      if (m.props.kind === 'planted')
        return (
          <div className="wallpaper-frost [--frost-tint:color-mix(in_oklab,var(--color-amber-500)_10%,transparent)] flex max-w-(--bubble-width) gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm [overflow-wrap:anywhere]">
            <AlertCircle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" aria-hidden />
            <div className="min-w-0 flex-1">{m.text}</div>
          </div>
        );
      // What taking a turn back put back and left: several lines, kept as lines.
      if (m.props.kind === 'turnUndo')
        return (
          <div className="wallpaper-frost max-w-(--bubble-width) rounded-2xl border bg-card/50 px-4 py-3 text-sm whitespace-pre-line [overflow-wrap:anywhere]">
            {m.text}
          </div>
        );
      return (
        <div className="flex items-center justify-center gap-2 py-1 text-center text-sm text-muted-foreground">
          {m.text}
          {retry && m.props.kind === 'interrupted' && <RetryButton messageId={m.id} />}
        </div>
      );
  }
}

/**
 * Tells a bot that ran out of steps mid-task to go on from where it stopped: its session holds the
 * work so far. The person decides, so a looping bot never spends twice on its own.
 */
function GoOnButton({ threadId }: { threadId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const go = useMutation({
    mutationFn: () => api.send(threadId, newClientId(), t('message.goOnText')),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['messages', threadId] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Button
      size="sm"
      className="h-7 rounded-full px-3 text-xs"
      disabled={go.isPending || go.isSuccess}
      onClick={() => go.mutate()}
    >
      <Play className="size-3.5" /> {t('message.goOn')}
    </Button>
  );
}

/** Runs again the request a failed or stopped turn left unanswered. */
function RetryButton({ messageId }: { messageId: string }) {
  const t = useT();
  const run = useMutation({
    mutationFn: () => api.retryMessage(messageId),
    onError: (e) => toast.error((e as Error).message),
  });
  return (
    <Button
      size="sm"
      variant="secondary"
      className="h-7 rounded-full px-3 text-xs"
      disabled={run.isPending || run.isSuccess}
      onClick={() => run.mutate()}
    >
      <RotateCcw className="size-3.5" /> {t('message.retry')}
    </Button>
  );
}

/**
 * A piece of work the bot noticed it could take on: "Do it" sends the task as the person's own
 * message, "Not now" puts the card away. Answered once; then it says how.
 */
function OfferCard({ m }: { m: Message }) {
  const t = useT();
  const answer = useMutation({
    mutationFn: (take: boolean) => api.answerOffer(m.id, take),
    onError: (err: Error) => toast.error(err.message),
  });
  const answered = typeof m.props.answer === 'string' ? m.props.answer : null;
  return (
    <div className="wallpaper-frost flex max-w-(--bubble-width) items-start gap-3 rounded-2xl border bg-card/50 px-4 py-3 text-sm">
      <Lightbulb className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <div>{m.text}</div>
        {answered ? (
          <div className="mt-2 text-xs text-muted-foreground">
            {answered === 'taken' ? t('offer.taken') : t('offer.declined')}
          </div>
        ) : (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" disabled={answer.isPending} onClick={() => answer.mutate(true)}>
              {t('offer.take')}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={answer.isPending}
              onClick={() => answer.mutate(false)}
            >
              {t('offer.decline')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

/** A bot's suggestion to connect a service its task needs, with the button that does it. */
function AppSuggestion({ catalogId, reason, botId }: { catalogId: string; reason: string; botId?: string }) {
  const t = useT();
  const openApps = useUi((s) => s.openApps);
  const { data: connections = [] } = useConnections();
  const entry = catalogEntry(catalogId);
  if (!entry) return null;
  const connected = connections.some(
    (c) =>
      c.catalogId === catalogId &&
      c.status === 'connected' &&
      (!botId || c.allBots || c.botIds.includes(botId)),
  );
  return (
    <section className="wallpaper-frost flex max-w-[80%] items-center gap-3 self-start rounded-2xl border bg-card/60 px-4 py-3">
      <AppLogo id={catalogId} name={entry.name} size={36} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{t('message.appSuggestTitle', { app: entry.name })}</div>
        {reason && <div className="text-xs text-muted-foreground">{reason}</div>}
      </div>
      {connected ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <Check className="size-3.5" /> {t('message.appConnected')}
        </span>
      ) : (
        <Button
          size="sm"
          className="shrink-0 rounded-full"
          onClick={() => openApps({ botId: botId ?? null, catalogId })}
        >
          {t('message.appConnect')}
        </Button>
      )}
    </section>
  );
}

/** A server a bot added that wants the person to sign in, with the button that opens it. */
function SignInCard({ connectionId, text, botId }: { connectionId: string; text: string; botId?: string }) {
  const t = useT();
  const openApps = useUi((s) => s.openApps);
  const { data: connections = [] } = useConnections();
  const c = connections.find((x) => x.id === connectionId);
  if (!c) return null;
  return (
    <section className="wallpaper-frost flex max-w-[80%] items-center gap-3 self-start rounded-2xl border bg-card/60 px-4 py-3">
      <AppLogo id={c.catalogId} name={c.name} size={36} />
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{text}</div>
        <div className="truncate text-xs text-muted-foreground">{c.url}</div>
      </div>
      {c.status === 'connected' ? (
        <span className="flex shrink-0 items-center gap-1 text-xs text-emerald-600 dark:text-emerald-400">
          <Check className="size-3.5" /> {t('message.appConnected')}
        </span>
      ) : (
        <Button
          size="sm"
          className="shrink-0 rounded-full"
          onClick={() => openApps({ botId: botId ?? null, connectionId })}
        >
          {t(c.auth === 'token' ? 'message.enterKey' : 'message.signIn')}
        </Button>
      )}
    </section>
  );
}

interface PlanItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** The bot's plan for its task, as it last wrote it: done steps ticked, the current one marked. */
function PlanCard({ items }: { items: PlanItem[] }) {
  const t = useT();
  const done = items.filter((i) => i.status === 'completed').length;
  return (
    <section
      aria-label={t('message.plan')}
      className="wallpaper-frost max-w-[80%] min-w-64 self-start rounded-2xl border bg-card/60 px-4 py-3 text-sm"
    >
      <div className="mb-2 flex items-center justify-between gap-4 text-xs text-muted-foreground">
        <span className="font-medium">{t('message.plan')}</span>
        <span className="tabular-nums">{t('message.planProgress', { done, total: items.length })}</span>
      </div>
      <ul className="space-y-1.5">
        {items.map((item, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
              {item.status === 'completed' ? (
                <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
              ) : item.status === 'in_progress' ? (
                <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden />
              ) : (
                <Circle className="size-4 text-muted-foreground" aria-hidden />
              )}
            </span>
            <span
              className={cn(
                item.status === 'completed' && 'text-muted-foreground line-through',
                item.status === 'in_progress' && 'font-medium',
              )}
            >
              {item.text}
              <span className="sr-only"> ({t(`message.planStatus.${item.status}`)})</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The time now, once a second while `live`. */
function useNow(live: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [live]);
  return now;
}

/** How a subagent stands, as an icon. */
function SubagentIcon({ state }: { state: Subagent['state'] }) {
  if (state === 'running') return <LoaderCircle className="size-4 animate-spin text-primary" aria-hidden />;
  if (state === 'waiting') return <Clock className="size-4 text-muted-foreground" aria-hidden />;
  if (state === 'done') {
    return <CircleCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />;
  }
  return <AlertCircle className="size-4 text-muted-foreground" aria-hidden />;
}

/** What a working subagent is doing now, in the words tool cards use; null once it has ended. */
function useSubagentDoing(sub: Subagent): string | null {
  const t = useT();
  const { data: connections = [] } = useConnections();
  return sub.state === 'running' && sub.tool
    ? toolLabel(sub.tool, t, new Map(connections.map((c) => [c.slug, c.name])))
    : null;
}

/**
 * A helper the bot started for part of the work: what it was asked, how it stands, what it is
 * doing now, how long it took and what it handed back.
 */
function SubagentCard({ sub }: { sub: Subagent }) {
  const t = useT();
  const running = sub.state === 'running';
  const now = useNow(running);
  const [open, setOpen] = useState(false);
  const doing = useSubagentDoing(sub);
  const time = subagentTime(sub, t, now);
  const ended = sub.state !== 'running' && sub.state !== 'waiting';
  return (
    <section
      aria-label={t('message.subagent')}
      className="wallpaper-frost max-w-[80%] min-w-64 self-start rounded-2xl border bg-card/60 px-4 py-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
          <SubagentIcon state={sub.state} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-4 text-xs text-muted-foreground">
            <span className="font-medium">{t('message.subagent')}</span>
            <span className="tabular-nums">
              {[
                t(`message.subagentState.${sub.state}`),
                t('message.subagentSteps', { count: sub.steps }),
                time,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          </div>
          {sub.description && <div className="mt-1 break-words">{sub.description}</div>}
          {doing && <div className="mt-1 text-xs text-muted-foreground">{doing}</div>}
          {sub.result && ended && (
            <div className="mt-2">
              <button
                type="button"
                className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                aria-expanded={open}
                onClick={() => setOpen((o) => !o)}
              >
                <ChevronDown
                  className={cn('size-3.5 transition-transform', open && 'rotate-180')}
                  aria-hidden
                />
                {t('message.subagentResult')}
              </button>
              {open && <SubagentResult text={sub.result} />}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function SubagentResult({ text }: { text: string }) {
  return (
    <div className="mt-1 max-h-64 overflow-y-auto rounded-lg border bg-background/60 px-3 py-2 text-xs whitespace-pre-wrap break-words">
      {text}
    </div>
  );
}

const SUBAGENT_COUNT_ORDER = ['running', 'waiting', 'done', 'failed', 'stopped'] as const;

/**
 * Subagents the bot started together, on one card: how many are working, waiting and done, and a
 * line for each that opens to what it is doing or what it handed back.
 */
function SubagentGroupCard({ list }: { list: Subagent[] }) {
  const t = useT();
  const [open, setOpen] = useState(true);
  const counts = subagentCounts(list);
  const working = counts.running + counts.waiting > 0;
  const summary = SUBAGENT_COUNT_ORDER.filter((s) => counts[s] > 0)
    .map((s) => t(`message.subagentCount.${s}`, { count: counts[s] }))
    .join(' · ');
  return (
    <section
      aria-label={t('message.subagentGroup')}
      className="wallpaper-frost w-full max-w-[80%] min-w-64 self-start rounded-2xl border bg-card/60 px-4 py-3 text-sm"
    >
      <button
        type="button"
        className="flex w-full items-start gap-2 text-start"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
          <SubagentIcon state={working ? 'running' : counts.failed || counts.stopped ? 'failed' : 'done'} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">
            {t(working ? 'message.subagentGroupWorking' : 'message.subagentGroupWorked', {
              count: list.length,
            })}
          </span>
          <span className="block text-xs text-muted-foreground tabular-nums">{summary}</span>
        </span>
        <ChevronDown
          className={cn(
            'mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </button>
      {open && (
        <ul className="mt-2 flex flex-col border-t">
          {list.map((sub, i) => (
            <SubagentLine key={i} sub={sub} />
          ))}
        </ul>
      )}
    </section>
  );
}

function SubagentLine({ sub }: { sub: Subagent }) {
  const t = useT();
  const running = sub.state === 'running';
  const now = useNow(running);
  const [open, setOpen] = useState(false);
  const doing = useSubagentDoing(sub);
  const time = subagentTime(sub, t, now);
  const ended = sub.state !== 'running' && sub.state !== 'waiting';
  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        className="flex w-full items-center gap-2 py-2 text-start"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="flex size-4 shrink-0 items-center justify-center">
          <SubagentIcon state={sub.state} />
        </span>
        <span className="min-w-0 flex-1 truncate">{sub.description || t('message.subagent')}</span>
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
          {[t(`message.subagentState.${sub.state}`), time].filter(Boolean).join(' · ')}
        </span>
      </button>
      {open && (
        <div className="pb-2 ps-6 text-xs text-muted-foreground">
          {sub.description && <div className="break-words text-foreground">{sub.description}</div>}
          <div className="mt-1 tabular-nums">{t('message.subagentSteps', { count: sub.steps })}</div>
          {doing && <div className="mt-1">{doing}</div>}
          {sub.result && ended && <SubagentResult text={sub.result} />}
        </div>
      )}
    </li>
  );
}

function messageFiles(m: Message): MessageFile[] {
  return Array.isArray(m.props.files) ? (m.props.files as MessageFile[]) : [];
}

function replyQuoteOf(m: Message): ReplyQuote | null {
  const q = m.props.replyTo as Partial<ReplyQuote> | undefined;
  return q && typeof q.id === 'string' && typeof q.text === 'string' ? { id: q.id, text: q.text } : null;
}

/** The start of a message as it is quoted above a reply. */
export function replyExcerpt(m: Message): string {
  return quoteExcerpt(
    m.text ||
      messageFiles(m)
        .map((f) => f.name)
        .join(', '),
  );
}

/** The answered message, quoted above the person's reply; clicking it scrolls back to it. */
function QuoteLine({ quote, threadId }: { quote: ReplyQuote; threadId: string }) {
  const t = useT();
  // The conversation scrolls itself to the quoted message, loading older pages if need be, and lights it.
  const jump = () => useUi.getState().focusMessage({ id: quote.id, threadId });
  return (
    <button
      type="button"
      onClick={jump}
      aria-label={t('message.replyTo', { text: quote.text })}
      className="wallpaper-chip flex max-w-[80%] items-start gap-1.5 rounded-2xl px-3 py-1 text-start text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
    >
      <Reply className="mt-0.5 size-3.5 shrink-0" />
      <span className="line-clamp-2 [overflow-wrap:anywhere]">{quote.text}</span>
    </button>
  );
}

const QUICK_EMOJIS = ['👍', '👎', '❤️', '😂', '🙏', '🔥', '👏', '🎉'];

/**
 * Copy, react and reply under one of the bot's messages. They show while the pointer is over the
 * message (always on touch screens); the person's emoji, once given, stays in view.
 */
function MessageActions({ m, onReply }: { m: Message; onReply?(m: Message): void }) {
  const t = useT();
  const qc = useQueryClient();
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState(false);
  const [undoing, setUndoing] = useState(false);
  // Only turns that changed something, and only for the person whose turn it was.
  const { data: undoable } = useTurnChanges(m.threadId);
  const row = useRef<HTMLDivElement>(null);
  const reaction = typeof m.props.userReaction === 'string' ? m.props.userReaction : null;
  const locale = useLocale((s) => s.locale);
  const speaking = useSpeech((s) => s.speaking === m.id);
  const serverVoice = useServerVoice();
  const remove = useDeleteMessage(m);
  const raw = useRawView((s) => s.ids.has(m.id));
  const toggleRaw = useRawView((s) => s.toggle);
  const pin = async () => {
    try {
      const updated = await api.pinMessage(m.threadId, m.id);
      await qc.invalidateQueries({ queryKey: ['threads', updated.botId] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  // A branch from here: a new conversation with everything up to this reply, to go another way.
  const fork = async () => {
    try {
      const created = await api.forkFrom(m.id);
      await qc.invalidateQueries({ queryKey: ['threads', created.botId] });
      useUi.getState().selectThread(created.id);
      toast.success(t('message.forked'));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(id);
  }, [copied]);

  const react = useMutation({
    mutationFn: (emoji: string | null) => api.react(m.id, emoji),
    onMutate: (emoji) => {
      qc.setQueryData<Message[]>(['messages', m.threadId], (list) =>
        list?.map((x) => {
          if (x.id !== m.id) return x;
          const { userReaction: _, ...props } = x.props;
          return { ...x, props: emoji ? { ...props, userReaction: emoji } : props };
        }),
      );
    },
    onError: (e) => toast.error((e as Error).message),
    onSettled: () => qc.invalidateQueries({ queryKey: ['messages', m.threadId] }),
  });
  const choose = (emoji: string) => {
    setPicking(false);
    react.mutate(emoji === reaction ? null : emoji);
  };

  const copy = async () => {
    // The rendered message goes along as HTML, so a table pastes as a table.
    const html = row.current?.parentElement?.querySelector('[data-message-body]')?.innerHTML;
    if (await copyText(m.text, html)) setCopied(true);
    else toast.error(t('message.copyFailed'));
  };

  return (
    <div ref={row} className="flex h-8 items-center gap-0.5 pt-1">
      {reaction && (
        <Tooltip>
          <TooltipTrigger asChild>
            <motion.button
              key={reaction}
              type="button"
              initial={{ scale: 0, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: 'spring', stiffness: 500, damping: 18 }}
              onClick={() => react.mutate(null)}
              aria-label={t('message.yourReaction', { emoji: reaction })}
              className="me-1 flex h-7 min-w-7 items-center justify-center rounded-lg bg-secondary px-1.5 text-base leading-none transition-colors hover:bg-accent"
            >
              {reaction}
            </motion.button>
          </TooltipTrigger>
          <TooltipContent>{t('message.yourReaction', { emoji: reaction })}</TooltipContent>
        </Tooltip>
      )}
      <div
        className={cn(
          // A backing of its own: the grey icons sit straight on the chat, where a picture swallows them.
          'wallpaper-chip flex items-center gap-0.5 rounded-lg transition-opacity',
          'opacity-0 group-focus-within/message:opacity-100 group-hover/message:opacity-100 [@media(hover:none)]:opacity-100',
          (picking || copied) && 'opacity-100',
        )}
      >
        {m.text && (
          <ActionButton label={copied ? t('message.copied') : t('message.copy')} onClick={() => void copy()}>
            {copied ? <Check /> : <Copy />}
          </ActionButton>
        )}
        {m.text && (
          <ActionButton
            label={raw ? t('message.showFormatted') : t('message.showMarkdown')}
            onClick={() => toggleRaw(m.id)}
          >
            <FileCode />
          </ActionButton>
        )}
        {m.text && (serverVoice || speechSupported()) && (
          <ActionButton
            label={speaking ? t('message.stopReading') : t('message.readAloud')}
            onClick={() => toggleSpeech(m.id, m.text, locale, serverVoice)}
          >
            {speaking ? <Square /> : <Volume2 />}
          </ActionButton>
        )}
        <ActionButton label={t('message.delete')} onClick={() => remove.mutate()}>
          <Trash2 />
        </ActionButton>
        <Popover open={picking} onOpenChange={setPicking}>
          <Tooltip>
            <TooltipTrigger asChild>
              <PopoverTrigger asChild>
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  className="size-7 rounded-lg text-muted-foreground hover:text-foreground [&_svg]:size-4"
                  aria-label={t('message.react')}
                >
                  <SmilePlus />
                </Button>
              </PopoverTrigger>
            </TooltipTrigger>
            <TooltipContent>{t('message.react')}</TooltipContent>
          </Tooltip>
          <PopoverContent align="start" side="top" className="flex w-auto gap-0.5 rounded-xl p-1">
            {QUICK_EMOJIS.map((e) => (
              <button
                key={e}
                type="button"
                onClick={() => choose(e)}
                aria-label={t('message.reaction', { emoji: e })}
                aria-pressed={e === reaction}
                className={cn(
                  'flex size-9 items-center justify-center rounded-lg text-xl transition-transform hover:scale-110 hover:bg-accent',
                  e === reaction && 'bg-accent',
                )}
              >
                {e}
              </button>
            ))}
          </PopoverContent>
        </Popover>
        {onReply && (
          <ActionButton label={t('message.reply')} onClick={() => onReply(m)}>
            <Reply />
          </ActionButton>
        )}
        <ActionButton label={t('message.fork')} onClick={() => void fork()}>
          <GitBranch />
        </ActionButton>
        <ActionButton label={t('message.pin')} onClick={() => void pin()}>
          <Pin />
        </ActionButton>
        {m.turnId && undoable?.[m.turnId] ? (
          <ActionButton label={t('message.undoTurn')} onClick={() => setUndoing(true)}>
            <Undo2 />
          </ActionButton>
        ) : null}
      </div>
      {undoing && m.turnId && (
        <UndoTurnDialog turnId={m.turnId} threadId={m.threadId} open onOpenChange={setUndoing} />
      )}
    </div>
  );
}

function ActionButton({ label, onClick, children }: { label: string; onClick(): void; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="size-7 rounded-lg text-muted-foreground hover:text-foreground [&_svg]:size-4"
          onClick={onClick}
          aria-label={label}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** Copies a failure with when and where it happened, for a report. */
function CopyDetails({ m }: { m: Message }) {
  const t = useT();
  const [copied, setCopied] = useState(false);
  const details = [
    m.text,
    `kind: ${String(m.props.kind ?? '-')}`,
    `turn: ${m.turnId ?? '-'}`,
    `at: ${m.createdAt}`,
  ].join('\n');
  return (
    <ActionButton
      label={copied ? t('message.copied') : t('message.copyDetails')}
      onClick={async () => {
        if (await copyText(details)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } else toast.error(t('message.copyFailed'));
      }}
    >
      {copied ? <Check /> : <Copy />}
    </ActionButton>
  );
}

/** Removes a message from the conversation after the person confirms. */
function useDeleteMessage(m: Message) {
  const t = useT();
  const qc = useQueryClient();
  const remove = useMutation({
    mutationFn: () => api.removeMessage(m.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['messages', m.threadId] }),
    onError: (e) => toast.error((e as Error).message),
  });
  return {
    mutate: () => {
      if (confirm(t('message.confirmDelete'))) remove.mutate();
    },
  };
}

/** Copy and delete beside the person's own message, shown while the pointer is over it. */
function OwnMessageActions({ m }: { m: Message }) {
  const t = useT();
  const remove = useDeleteMessage(m);
  const [copied, setCopied] = useState(false);
  return (
    // A backing of its own, as under the bot's messages: grey icons on a picture are lost.
    <div className="wallpaper-chip flex h-7 items-center gap-0.5 rounded-lg opacity-0 transition-opacity group-focus-within/own:opacity-100 group-hover/own:opacity-100 [@media(hover:none)]:opacity-100">
      {m.text && (
        <ActionButton
          label={copied ? t('message.copied') : t('message.copy')}
          onClick={async () => {
            if (await copyText(m.text)) {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } else toast.error(t('message.copyFailed'));
          }}
        >
          {copied ? <Check /> : <Copy />}
        </ActionButton>
      )}
      <ActionButton label={t('message.delete')} onClick={() => remove.mutate()}>
        <Trash2 />
      </ActionButton>
    </div>
  );
}

/**
 * The person's message while the bot is busy with an earlier one: it waits its turn, and until the
 * bot starts on it the person may change it or take it back.
 */
/** The person's bubble in the bot's colour, darkened so white text reads on it. */
const tintFill = (tint: string) =>
  ({ '--tint-fill': `color-mix(in oklab, ${tint} 82%, black)` }) as CSSProperties;

function QueuedMessage({ m, tint, hasFiles }: { m: Message; tint?: string; hasFiles: boolean }) {
  const t = useT();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  const done = () => qc.invalidateQueries({ queryKey: ['messages', m.threadId] });
  const save = useMutation({
    mutationFn: () => api.editMessage(m.id, text.trim()),
    onSuccess: () => {
      setEditing(false);
      void done();
    },
    onError: (e) => toast.error((e as Error).message),
  });
  const cancel = useMutation({
    mutationFn: () => api.removeMessage(m.id),
    onSuccess: () => void done(),
    onError: (e) => toast.error((e as Error).message),
  });
  // Handed to the work under way: the bot reads it at its next step instead of afterwards.
  const steer = useMutation({
    mutationFn: () => api.steerMessage(m.id),
    onSuccess: () => void done(),
    onError: (e) => toast.error((e as Error).message),
  });
  const steering = m.props.steering === true;
  if (editing) {
    return (
      <form
        className="flex w-full max-w-[80%] flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim() || hasFiles) save.mutate();
        }}
      >
        <textarea
          dir="auto"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
            if (e.key === 'Escape') setEditing(false);
          }}
          aria-label={t('message.editQueued')}
          className="min-h-20 w-full resize-y rounded-2xl border bg-card px-4 py-2.5 text-[15px] outline-none focus:ring-2 focus:ring-ring/30"
        />
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="rounded-full"
            onClick={() => setEditing(false)}
          >
            {t('common.cancel')}
          </Button>
          <Button
            type="submit"
            size="sm"
            className="rounded-full"
            disabled={save.isPending || (!text.trim() && !hasFiles)}
          >
            {t('common.save')}
          </Button>
        </div>
      </form>
    );
  }
  return (
    <>
      {(m.text || !hasFiles) && (
        <div
          className={cn(
            'relative max-w-[80%] rounded-3xl px-4 py-2.5 text-[15px] whitespace-pre-wrap opacity-75 [overflow-wrap:anywhere]',
            tint
              ? 'wallpaper-mine wallpaper-tint bg-(--tint-fill) text-white'
              : 'wallpaper-mine wallpaper-bubble bg-secondary',
          )}
          style={tint ? tintFill(tint) : undefined}
        >
          {m.text}
        </div>
      )}
      <div className="flex items-center gap-1 px-2 text-xs text-muted-foreground">
        <Clock className="size-3" />
        <span>{steering ? t('message.steering') : t('message.queued')}</span>
        {!steering && (
          <>
            <span aria-hidden>·</span>
            <button
              type="button"
              className="hover:text-foreground hover:underline"
              disabled={steer.isPending}
              onClick={() => steer.mutate()}
              title={t('message.steerHint')}
            >
              {t('message.steer')}
            </button>
          </>
        )}
        <span aria-hidden>·</span>
        <button
          type="button"
          className="hover:text-foreground hover:underline"
          onClick={() => setEditing(true)}
        >
          {t('message.editQueued')}
        </button>
        <span aria-hidden>·</span>
        <button
          type="button"
          className="hover:text-foreground hover:underline"
          disabled={cancel.isPending}
          onClick={() => cancel.mutate()}
        >
          {t('message.cancelQueued')}
        </button>
      </div>
    </>
  );
}

/** The bot's emoji on a user message, pinned to the bubble's lower corner. */
function Reaction({ emoji }: { emoji: string }) {
  const t = useT();
  return (
    <motion.span
      key={emoji}
      role="img"
      aria-label={t('message.reaction', { emoji })}
      title={t('message.reaction', { emoji })}
      initial={{ scale: 0, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      transition={{ type: 'spring', stiffness: 500, damping: 18 }}
      className="absolute -bottom-4 start-3 flex h-7 min-w-7 items-center justify-center rounded-full border-2 border-background bg-secondary px-1 text-base leading-none shadow-sm select-none"
    >
      {emoji}
    </motion.span>
  );
}

/** Bot messages shown as the Markdown they were written in, by message id; kept while the page is open. */
export const useRawView = create<{ ids: ReadonlySet<string>; toggle(id: string): void }>((set) => ({
  ids: new Set(),
  toggle: (id) =>
    set((s) => {
      const ids = new Set(s.ids);
      if (!ids.delete(id)) ids.add(id);
      return { ids };
    }),
}));

export function AssistantCard({
  text,
  turnId,
  partial,
  streaming,
  messageId,
  replyKey,
}: {
  text: string;
  turnId?: string | null;
  partial?: boolean;
  streaming?: boolean;
  /** The saved message shown, so its Markdown can be shown as written. */
  messageId?: string;
  /** Names this reply for the conversation's scrolling, which keeps a long one's start in view. */
  replyKey?: string;
}) {
  const t = useT();
  const raw = useRawView((s) => !!messageId && s.ids.has(messageId));
  const typed = useTypewriter(text, turnId, streaming);
  // A very long reply draws its start; the rest on request, so the chat stays quick.
  const [whole, setWhole] = useState(false);
  const long = !streaming && !whole && typed.length > LONG_MESSAGE;
  const shown = long ? `${typed.slice(0, LONG_MESSAGE)}…` : typed;
  return (
    <div
      className="max-w-(--bubble-width) wallpaper-bubble rounded-3xl bg-bubble px-5 py-4"
      data-reply-start={replyKey}
    >
      <div data-message-body>
        {raw ? (
          <pre className="font-mono text-[13px] leading-relaxed break-words whitespace-pre-wrap">{text}</pre>
        ) : (
          <Markdown text={shown} />
        )}
      </div>
      {long && (
        <Button variant="secondary" size="sm" className="mt-3 rounded-full" onClick={() => setWhole(true)}>
          {t('message.showAll', { count: typed.length })}
        </Button>
      )}
      {partial && <div className="mt-2 text-xs text-muted-foreground">{t('message.partial')}</div>}
    </div>
  );
}

/** Characters of a message drawn before "Show the whole message". */
const LONG_MESSAGE = 20_000;

/** The bot at work under the conversation: its avatar doing the same as in the sidebar, and what it does. */
export function Working({
  bot,
  activity,
  threadId,
}: {
  bot: Bot;
  activity: Exclude<BotActivity, 'idle'>;
  threadId?: string;
}) {
  const t = useT();
  // While it thinks, say what it is doing when a tool runs: a long command reads as work, not a hang.
  const tool = useUi((s) => (threadId ? s.tools[threadId] : undefined));
  const { data: connections = [] } = useConnections();
  const doing =
    activity === 'thinking' && tool
      ? toolLabel(tool, t, new Map(connections.map((c) => [c.slug, c.name])))
      : null;
  return (
    <div className="flex items-center gap-2.5 py-1 text-sm text-muted-foreground" role="status">
      <BotAvatar
        avatar={bot.avatar}
        color={bot.color}
        seed={bot.id}
        size={28}
        activity={activity}
        motion="always"
      />
      {/* Its own backing, as the line sits straight on the chat, where a picture swallows grey text. */}
      <span className="wallpaper-chip flex items-center gap-1 rounded-lg px-2 py-0.5">
        <span>{doing ?? t(`activity.${activity}`)}</span>
        <Elapsed key={doing ?? activity} />
      </span>
      {activity === 'browsing' && (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7 rounded-full px-2.5 text-xs"
          onClick={() => useUi.getState().openComputer(bot.id)}
        >
          <Eye className="size-3.5" /> {t('activity.watch')}
        </Button>
      )}
    </div>
  );
}

/** How long the bot has been on this step, once it takes longer than a few seconds. */
function Elapsed() {
  const t = useT();
  const [start] = useState(() => Date.now());
  const [now, setNow] = useState(start);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const seconds = Math.floor((now - start) / 1000);
  if (seconds < 5) return null;
  const text =
    seconds < 60
      ? t('activity.seconds', { seconds })
      : t('activity.minutes', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 });
  return (
    <span className="tabular-nums">
      <span aria-hidden>· </span>
      {text}
    </span>
  );
}

function IncomingBot({ m, bot }: { m: Message; bot: Bot }) {
  const t = useT();
  return (
    <div className="max-w-(--bubble-width) space-y-2">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <BotAvatar avatar={bot.avatar} color={bot.color} seed={bot.id} size={20} />
        <span className="font-medium text-foreground">{bot.name}</span> {t('message.wrote')}
      </div>
      {typeof m.props.openedFrom === 'string' && <OpenedFrom threadId={m.props.openedFrom} />}
      <div className="rounded-3xl border bg-background px-5 py-4">
        <Markdown text={m.text} />
      </div>
    </div>
  );
}

/** Over a routine's report in the main conversation: which routine wrote it, opening the run's steps. */
function RoutineReportLine({ m }: { m: Message }) {
  const t = useT();
  const name = typeof m.props.routineName === 'string' ? m.props.routineName : '';
  const run = typeof m.props.routineThreadId === 'string' ? m.props.routineThreadId : null;
  const label = name ? t('message.routineNamed', { name }) : t('message.routine');
  const inner = (
    <>
      <Clock className="size-3.5" /> {label}
    </>
  );
  if (!run)
    return (
      <span className="wallpaper-chip -mx-2 mb-1 flex w-fit items-center gap-1 rounded-lg px-2 py-0.5 text-xs text-muted-foreground">
        {inner}
      </span>
    );
  return (
    <button
      type="button"
      onClick={() => useUi.getState().selectThread(run)}
      title={t('message.openRoutineRun')}
      className="wallpaper-chip -mx-2 mb-1 flex w-fit items-center gap-1 rounded-lg px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground"
    >
      {inner}
    </button>
  );
}

/** Where a conversation the bot opened came from, with the way back to it. */
function OpenedFrom({ threadId }: { threadId: string }) {
  const t = useT();
  const { data: from } = useQuery({ queryKey: ['thread', threadId], queryFn: () => api.thread(threadId) });
  const { data: main } = useMainThread(from?.botId ?? null);
  if (!from) return null;
  return (
    <button
      type="button"
      onClick={() => useUi.getState().selectThread(from.id)}
      className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
    >
      <Reply className="size-3.5" />{' '}
      {t('message.openedFrom', {
        title: from.id === main?.id || !from.title ? t('chat.mainThread') : from.title,
      })}
    </button>
  );
}

/**
 * True where cards waiting in exchanges between bots show at the end of the conversation. The
 * exchange sits where it began, often far above what the bot wrote since, and a card may be asked
 * further down the chain, in an exchange this one never shows; so every card of the work that began
 * here waits at the end until it is answered, then shows in the exchange with the rest.
 */
export const CardDock = createContext(false);

/** A card asked in an exchange between bots, as its own line there describes it. */
function ExchangeCard({
  approvalId,
  fallback,
  props,
  bots,
}: {
  approvalId: string;
  fallback: string;
  props: Record<string, unknown>;
  bots: Map<string, Bot>;
}) {
  return (
    <ApprovalCard
      approvalId={approvalId}
      fallback={fallback}
      bots={bots}
      heldBy={typeof props.heldBy === 'string' ? props.heldBy : undefined}
      askRule={typeof props.askRule === 'string' ? props.askRule : undefined}
      outside={outsideTrigger(props.outside)}
      noAlways={props.noAlways === true}
      resembles={typeof props.resembles === 'string' ? props.resembles : undefined}
    />
  );
}

/**
 * The cards waiting in exchanges between bots for the work that began in this conversation, however
 * far down the chain each was asked: the person answers them here, never in the exchange itself.
 */
export function ExchangeCards({ threadId, bots }: { threadId: string; bots: Map<string, Bot> }) {
  const { data: approvals } = useApprovals();
  const waiting = (approvals ?? [])
    .filter((a) => a.status === 'pending' && a.answerIn?.threadId === threadId)
    // Oldest first, as they were asked.
    .reverse();
  return waiting.map((a) => (
    <ExchangeCard
      key={a.id}
      approvalId={a.id}
      fallback={a.summary}
      props={a.answerIn?.props ?? {}}
      bots={bots}
    />
  ));
}

/** One line in the thread for a bot-to-bot exchange; opens to show it. */
function Marker({ m, bots }: { m: Message; bots: Map<string, Bot> }) {
  const t = useT();
  const dock = useContext(CardDock);
  const [chosen, setChosen] = useState<boolean | null>(null);
  const props = m.props as { jobId?: string; peerBotId?: string; count?: number; replied?: boolean };
  const peer = props.peerBotId ? bots.get(props.peerBotId) : undefined;
  const { data: approvals } = useApprovals();
  // While the other bot works on it and has a card waiting somewhere, the exchange is read anyway:
  // the card may be in there.
  const peerWaits =
    !props.replied && (approvals ?? []).some((a) => a.botId === props.peerBotId && a.status === 'pending');
  const job = useJob(chosen || peerWaits ? (props.jobId ?? null) : null);
  const toThreadId = job.data?.job.toThreadId;
  const waiting = toThreadId
    ? (approvals ?? []).filter((a) => a.threadId === toThreadId && a.status === 'pending').length
    : 0;
  // Opens by itself for a waiting card, until the person closes it, when the card is not at the end.
  const open = chosen ?? (waiting > 0 && !dock);
  const pending = new Set((approvals ?? []).filter((a) => a.status === 'pending').map((a) => a.id));
  const shown = (job.data?.messages ?? []).filter(
    (x) => x.role === 'user' || x.role === 'assistant' || x.role === 'approval',
  );
  // Waiting cards show at the end of the conversation instead, with the rest of the chain's.
  const docked = dock
    ? shown.filter((x) => x.role === 'approval' && pending.has(String(x.props.approvalId ?? '')))
    : [];
  const card = (x: Message) => (
    <ExchangeCard
      key={x.id}
      approvalId={String(x.props.approvalId ?? '')}
      fallback={x.text}
      props={x.props}
      bots={bots}
    />
  );
  // Once read, the exchange counts itself: markers written before it was cut to one request
  // counted the pair's whole history.
  const said = job.data?.messages.filter((x) => x.role === 'user' || x.role === 'assistant').length;
  return (
    <div className="flex flex-col items-center">
      <button
        onClick={() => setChosen(!open)}
        className="wallpaper-chip flex items-center gap-2 rounded-full px-3 py-1 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <span>{t('message.count', { count: said || props.count || 1 })}</span>
        <span>·</span>
        {peer && <BotAvatar avatar={peer.avatar} color={peer.color} seed={peer.id} size={18} />}
        <span className="font-medium">{peer?.name ?? t('common.bot')}</span>
        {waiting > 0 ? (
          <span
            className="flex size-4 items-center justify-center rounded-full bg-amber-500 text-[10px] font-bold text-black"
            aria-label={t('chat.waitingCards', { count: waiting })}
          >
            {waiting}
          </span>
        ) : (
          !props.replied && <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" />
        )}
        <ChevronDown className={cn('size-4 transition-transform', open && 'rotate-180')} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="w-full max-w-(--bubble-width) overflow-hidden"
          >
            <div className="wallpaper-frost mt-2 space-y-3 rounded-3xl border p-4">
              {job.isLoading && <div className="text-sm text-muted-foreground">{t('common.loading')}</div>}
              {shown
                .filter((x) => !docked.includes(x))
                .map((x) => {
                  if (x.role === 'approval') return card(x);
                  const who = x.role === 'assistant' ? peer : bots.get(x.author.slice(4));
                  return (
                    <div key={x.id} className="space-y-1">
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        {who && <BotAvatar avatar={who.avatar} color={who.color} seed={who.id} size={16} />}
                        <span className="font-medium">{who?.name ?? t('common.bot')}</span>
                      </div>
                      <div className="ps-6 text-sm">
                        <Markdown text={x.text} />
                      </div>
                    </div>
                  );
                })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ApprovalCard({
  approvalId,
  fallback,
  bots,
  heldBy,
  askRule,
  outside,
  noAlways,
  onAnswerLate,
  reviewReason,
  resembles,
}: {
  approvalId: string;
  fallback: string;
  bots: Map<string, Bot>;
  /** The "always ask" rule that stopped a bot otherwise allowed to go ahead. */
  heldBy?: string;
  /** The "always ask" rule that covers this request, for a bot that asks anyway. */
  askRule?: string;
  /** What outside text started the run: every change asks, and "always allow" is not offered. */
  outside?: OutsideTrigger;
  /** The card offers no "always allow": a guest's request, or a turn a stricter bot holds to its level. */
  noAlways?: boolean;
  /** Answers a question that went unanswered, as a reply quoting it. */
  onAnswerLate?(): void;
  /** Why the automatic review left this step to the person. */
  reviewReason?: string;
  /** The site the page address imitates: the card warns, and offers no "always allow". */
  resembles?: string;
}) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const { data: approvals } = useApprovals();
  const { data: people = [] } = usePeople();
  const a = approvals?.find((x) => x.id === approvalId);
  const connection = useToolConnection(a?.toolName);
  const service = connection?.name;
  const decide = useMutation({
    mutationFn: (d: { decision: 'allow' | 'deny'; remember?: boolean }) => api.answer(approvalId, d),
    onError: (e) => toast.error((e as Error).message),
  });
  if (!a) return <AnsweredLine text={fallback} />;
  const bot = bots.get(a.botId);
  const botName = bot?.name ?? t('common.bot');
  if (a.kind === 'question' && a.status !== 'denied' && a.status !== 'expired') {
    return <QuestionCard a={a} color={bot?.color ?? BRAND_COLOR} />;
  }
  // A question nobody answered in time (a routine's, overnight) stays readable and can still be
  // answered: the reply quotes it and reaches the bot as an ordinary message.
  if (a.kind === 'question' && a.status === 'expired') {
    const { items } = questionItems(a);
    if (items.length && !items.some((q) => q.secret)) {
      return (
        <div className="wallpaper-frost max-w-(--bubble-width) space-y-2 rounded-3xl border border-dashed px-5 py-4 text-[15px]">
          {items.map((q, i) => (
            <div key={i}>{q.question}</div>
          ))}
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            {answeredText(a, botName, t, locale, service)}
            {onAnswerLate && (
              <Button
                size="sm"
                variant="secondary"
                className="h-7 rounded-full px-3 text-xs"
                onClick={onAnswerLate}
              >
                <Reply className="size-3.5" /> {t('question.answerLate')}
              </Button>
            )}
          </div>
        </div>
      );
    }
  }
  if (a.kind === 'login' && a.status === 'pending') return <LoginCard a={a} />;
  // A step that needs two people's yes, and has the first: it waits for the second.
  const waitingSecond = a.needsSecond && a.status === 'pending' && !!a.firstAt;
  const notes = (heldBy || reviewReason || askRule || outside || resembles || a.needsSecond) && (
    <>
      {resembles && (
        <div className="text-sm font-medium text-destructive">
          {t('approval.resembles', { site: resembles })}
        </div>
      )}
      {heldBy && (
        <div className="text-xs text-muted-foreground">{t('approval.heldBy', { rule: heldBy })}</div>
      )}
      {reviewReason && (
        <div className="text-xs text-muted-foreground">
          {t('approval.reviewReason', { reason: reviewReason })}
        </div>
      )}
      {askRule && (
        <div className="text-xs text-muted-foreground">{t('approval.askRule', { rule: askRule })}</div>
      )}
      {outside && <div className="text-xs text-muted-foreground">{t(`approval.outside.${outside}`)}</div>}
      {a.needsSecond && (
        <div className="text-xs text-muted-foreground">
          {waitingSecond
            ? t('approval.waitingSecond', {
                name: personNameOf(people, a.firstApprover, t('people.owner'), t('common.someone')),
              })
            : t('approval.needsSecond')}
        </div>
      )}
    </>
  );
  // A mail shows as the mail itself, with the button that sends it.
  const mail = a.kind === 'tool' ? emailPreview(a.toolName, a.input) : null;
  if (mail) {
    return (
      <EmailApprovalCard
        a={a}
        mail={mail}
        service={service}
        connectionId={connection?.id}
        notes={notes}
        offerAlways={!heldBy && !askRule && !outside && !resembles && !a.needsSecond}
        busy={decide.isPending}
        onDecide={(d) => decide.mutate(d)}
      />
    );
  }
  if (a.status !== 'pending') return <AnsweredLine text={answeredText(a, botName, t, locale, service)} />;
  const action = describeAction(a.toolName, a.input, { bot: botName, locale, service });
  return (
    <div className="wallpaper-frost [--frost-tint:color-mix(in_oklab,var(--color-amber-500)_5%,transparent)] max-w-(--bubble-width) space-y-3 rounded-3xl border border-amber-500/40 bg-amber-500/5 px-5 py-4">
      <div className="flex items-start gap-3">
        <ShieldAlert className="mt-0.5 size-5 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1 space-y-1 text-[15px]">
          <div className="font-medium">{action.want}</div>
          <div className="text-muted-foreground">{t('approval.question')}</div>
          {notes}
          {action.detail && <Detail text={action.detail} />}
        </div>
      </div>
      <div className="flex flex-wrap gap-2 ps-8">
        {/* After the first yes the second must come from someone else: no button for it here. */}
        {!waitingSecond && (
          <Button
            size="sm"
            className="rounded-full"
            disabled={decide.isPending}
            onClick={() => decide.mutate({ decision: 'allow' })}
          >
            <Check /> {t('approval.allowOnce')}
          </Button>
        )}
        {/* An "always ask" rule outranks "always allow": offering it would change nothing. Nor is it
            taken from a run outside text started. */}
        {!heldBy && !askRule && !outside && !resembles && !noAlways && !a.needsSecond && (
          <Button
            size="sm"
            variant="secondary"
            className="rounded-full"
            disabled={decide.isPending}
            title={t('approval.allowAlwaysHint')}
            onClick={() => decide.mutate({ decision: 'allow', remember: true })}
          >
            {t('approval.allowAlways')}
          </Button>
        )}
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ decision: 'deny' })}
        >
          <X /> {t('approval.deny')}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="rounded-full text-muted-foreground"
          disabled={decide.isPending}
          title={t('approval.neverHint')}
          onClick={() => decide.mutate({ decision: 'deny', remember: true })}
        >
          <Ban /> {t('approval.never')}
        </Button>
      </div>
    </div>
  );
}

/**
 * A bot asks to sign in to a site. What is typed here goes to the server, which types it into
 * that site; the bot never sees the password.
 */
function LoginCard({ a }: { a: Approval }) {
  const t = useT();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [save, setSave] = useState(true);
  // The card names the whole site; the exact address it was asked on, when that differs.
  const host = typeof a.input.host === 'string' ? a.input.host : null;
  const [exact, setExact] = useState(false);
  const decide = useMutation({
    mutationFn: (d: Parameters<typeof api.answer>[1]) => api.answer(a.id, d),
    onError: (e) => toast.error((e as Error).message),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (password) decide.mutate({ decision: 'allow', login: { username, password, save, exact } });
  };
  return (
    <form
      onSubmit={submit}
      className="wallpaper-frost max-w-(--bubble-width) space-y-3 rounded-3xl border border-[var(--brand)]/30 bg-bubble px-5 py-4"
    >
      <div className="flex items-start gap-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-[var(--brand)]" />
        <div className="min-w-0 flex-1 space-y-1 text-[15px]">
          <div className="font-medium">{a.summary}</div>
          <div className="text-sm text-muted-foreground">{t('signin.hint')}</div>
        </div>
      </div>
      <div className="space-y-2 ps-8">
        <Input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('signin.username')}
          aria-label={t('signin.username')}
          autoComplete="username"
          className="bg-background"
        />
        <Input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('signin.password')}
          aria-label={t('signin.password')}
          autoComplete="current-password"
          className="bg-background"
        />
        <label className="flex items-center gap-2 pt-1 text-sm">
          <Switch checked={save} onCheckedChange={setSave} />
          {t('signin.save')}
        </label>
        {save && host && (
          <label className="flex items-center gap-2 text-sm">
            <Switch checked={exact} onCheckedChange={setExact} />
            {t('signin.exactHost', { host })}
          </label>
        )}
      </div>
      <div className="flex flex-wrap gap-2 ps-8">
        <Button type="submit" size="sm" className="rounded-full" disabled={decide.isPending || !password}>
          <Check /> {t('signin.submit')}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="rounded-full"
          disabled={decide.isPending}
          onClick={() => decide.mutate({ decision: 'deny' })}
        >
          <X /> {t('signin.cancel')}
        </Button>
      </div>
    </form>
  );
}

/** The connection a tool belongs to (`mcp__<connection>__<tool>`), when it is one. */
function useToolConnection(toolName: string | undefined) {
  const { data: connections } = useConnections();
  const parts = toolName ? connectionToolParts(toolName) : null;
  return parts ? connections?.find((c) => c.slug === parts.server) : undefined;
}

/** The one line an answered card leaves in the thread. */
export function answeredText(a: Approval, botName: string, t: T, locale: Locale, service?: string): string {
  const timedOut = a.status === 'expired' && a.answer === APPROVAL_TIMED_OUT;
  if (a.kind === 'login') {
    const site = typeof a.input.site === 'string' ? a.input.site : '';
    if (a.status === 'allowed') return t('signin.done', { bot: botName, site, username: a.answer ?? '' });
    if (a.status === 'denied') return t('signin.skipped', { bot: botName, site });
    return t(timedOut ? 'signin.timedOut' : 'approval.expired', { bot: botName, site });
  }
  if (a.kind === 'question') {
    if (a.status === 'allowed') {
      const { items } = questionItems(a);
      if (items.length === 1 && items[0]!.secret) return t('question.secretGiven');
      return t('question.answer', { answer: a.answer ?? '' });
    }
    if (a.status === 'denied') return t('question.skipped');
    return t(timedOut ? 'question.timedOut' : 'question.unanswered');
  }
  const action = describeAction(a.toolName, a.input, { bot: botName, locale, service });
  if (a.status === 'allowed') return a.remembered ? action.always : action.once;
  if (a.status === 'denied') return action.wont;
  return t(timedOut ? 'approval.timedOut' : 'approval.expired');
}

function AnsweredLine({ text }: { text: string }) {
  return (
    <div className="max-w-(--bubble-width) self-end px-2 text-end text-sm text-muted-foreground">{text}</div>
  );
}

/** What exactly the bot will run or touch, hidden until asked for. */
export function Detail({ text }: { text: string }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        className="text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        onClick={() => setOpen((v) => !v)}
      >
        {open ? t('approval.hide') : t('approval.show')}
      </button>
      {open && (
        <div className="scroll-thin mt-2 max-h-48 overflow-auto rounded-xl bg-secondary px-3 py-2 text-sm break-words whitespace-pre-wrap">
          {text}
        </div>
      )}
    </div>
  );
}

/**
 * Questions from a bot, one page each. While open the options are buttons; once answered the
 * card stays, showing each question with the answer that was given.
 */
function QuestionCard({ a, color }: { a: Approval; color: string }) {
  const t = useT();
  const { title, items } = questionItems(a);
  const answered = a.status === 'allowed';
  const [page, setPage] = useState(0);
  const [answers, setAnswers] = useState<string[]>(() =>
    answered ? parseAnswers(a.answer, items.length) : items.map(() => ''),
  );
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState('');
  const decide = useMutation({
    mutationFn: (d: { decision: 'allow' | 'deny'; answer?: string; answers?: string[] }) =>
      api.answer(a.id, d),
    onError: (e) => toast.error((e as Error).message),
  });
  const shown = answered ? parseAnswers(a.answer, items.length) : answers;
  const item = items[page]!;
  const many = items.length > 1;
  const last = page === items.length - 1;

  // On a question that takes several picks, the answer holds all of them (see `joinPicks`).
  const picks = item.multi ? splitPicks(shown[page] ?? '') : [];
  const toggle = (value: string) => {
    if (answered || decide.isPending) return;
    const next = picks.includes(value) ? picks.filter((p) => p !== value) : [...picks, value];
    setAnswers(answers.map((x, i) => (i === page ? joinPicks(next) : x)));
  };
  const choose = (value: string) => {
    if (answered || decide.isPending) return;
    if (item.multi) {
      // Words written beside the ticked options join them instead of replacing them.
      if (!picks.includes(value)) toggle(value);
      setWriting(false);
      setDraft('');
      return;
    }
    const next = answers.map((x, i) => (i === page ? value : x));
    setAnswers(next);
    setWriting(false);
    setDraft('');
    if (!many) decide.mutate({ decision: 'allow', answer: value });
    else if (!last) setPage(page + 1);
  };
  // A typed draft never follows to another page, so a secret one cannot show up in plain sight.
  const go = (to: number) => {
    setPage(to);
    setWriting(false);
    setDraft('');
  };
  const current = shown[page] ?? '';
  const optionIndex = item.options.indexOf(current);
  // A secret answer is never shown back, not even right after it is typed; only that one was given.
  const rows = item.secret
    ? answered || current
      ? [{ label: t('question.secretGiven'), index: -1 }]
      : []
    : item.multi
      ? [
          ...(answered ? [] : item.options).map((o, i) => ({ label: o, index: i })),
          // Picks written in the person's own words, shown as ticked rows that can be unticked.
          ...picks
            .filter((p) => !item.options.includes(p) || answered)
            .map((p) => ({ label: p, index: item.options.indexOf(p) })),
        ]
      : answered
        ? [{ label: current || t('question.empty'), index: optionIndex }]
        : item.options.map((o, i) => ({ label: o, index: i }));
  if (item.multi && answered && !rows.length) rows.push({ label: t('question.empty'), index: -1 });

  return (
    <div className="max-w-(--bubble-width) space-y-2">
      {title && (
        <div className="w-fit wallpaper-bubble rounded-3xl bg-bubble px-4 py-2.5 text-[15px]">{title}</div>
      )}
      <div
        className={cn(
          'wallpaper-frost space-y-3 rounded-3xl border px-5 py-4',
          !answered &&
            'border-amber-500/40 bg-amber-500/5 [--frost-tint:color-mix(in_oklab,var(--color-amber-500)_5%,transparent)]',
        )}
      >
        <div className={cn('text-[15px]', answered ? 'text-muted-foreground' : 'font-medium')}>
          <Markdown text={item.question} />
        </div>
        {item.context && (
          <div className="text-sm text-muted-foreground">
            <Markdown text={item.context} />
          </div>
        )}
        <div className="space-y-1">
          {rows.map((r) => {
            const picked = item.multi
              ? !answered && picks.includes(r.label)
              : !answered && (item.secret || current === r.label);
            return (
              <button
                key={r.label}
                role={item.multi && !answered ? 'checkbox' : undefined}
                aria-checked={item.multi && !answered ? picked : undefined}
                disabled={answered || item.secret || decide.isPending}
                onClick={() => (item.multi ? toggle(r.label) : choose(r.label))}
                className={cn(
                  'flex w-full items-center gap-3 rounded-2xl px-2 py-1.5 text-start text-[15px]',
                  !answered && 'hover:bg-accent',
                  picked && 'bg-accent',
                )}
              >
                <span
                  className={cn(
                    'flex size-6 shrink-0 items-center justify-center rounded-md text-xs font-medium',
                    // A choice that declines (No, Cancel) reads quieter than the ones that go ahead.
                    r.index >= 0 && isRefusal(r.label) ? 'bg-muted text-muted-foreground' : 'text-white',
                  )}
                  style={r.index >= 0 && isRefusal(r.label) ? undefined : { backgroundColor: color }}
                >
                  {item.multi && !answered && picked ? (
                    <Check className="size-3.5" />
                  ) : r.index >= 0 ? (
                    String.fromCharCode(65 + r.index)
                  ) : item.secret ? (
                    <KeyRound className="size-3.5" />
                  ) : (
                    <PenLine className="size-3.5" />
                  )}
                </span>
                <span className="min-w-0 break-words">{r.label}</span>
              </button>
            );
          })}
          {!answered &&
            (item.secret || writing || item.options.length === 0 ? (
              <form
                key={page}
                className="flex gap-2 pt-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draft.trim()) choose(draft.trim());
                }}
              >
                <input
                  autoFocus
                  type={item.secret ? 'password' : 'text'}
                  autoComplete={item.secret ? 'off' : undefined}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  // The Enter that picks an input method's candidate is not a send.
                  onKeyDown={(e) => e.key === 'Enter' && e.nativeEvent.isComposing && e.preventDefault()}
                  placeholder={t(item.secret ? 'question.secretPlaceholder' : 'question.placeholder')}
                  className="h-9 flex-1 rounded-full bg-secondary px-4 text-sm outline-none"
                />
                <Button size="sm" className="h-9 rounded-full" disabled={!draft.trim() || decide.isPending}>
                  {t('question.ok')}
                </Button>
              </form>
            ) : (
              <button
                onClick={() => setWriting(true)}
                className="flex w-full items-center gap-3 rounded-2xl px-2 py-1.5 text-start text-[15px] text-muted-foreground hover:bg-accent"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-secondary">
                  <PenLine className="size-3.5" />
                </span>
                {t('question.other')}
              </button>
            ))}
        </div>
        {(many || !answered) && (
          <div className="flex items-center gap-2 pt-1">
            {many && (
              <div className="flex gap-1.5">
                {items.map((_, i) => (
                  <span
                    key={i}
                    className={cn(
                      'size-1.5 rounded-full',
                      i === page ? 'bg-foreground' : 'bg-muted-foreground/40',
                    )}
                  />
                ))}
              </div>
            )}
            <div className="ms-auto flex gap-2">
              {!answered && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="rounded-full text-muted-foreground"
                  disabled={decide.isPending}
                  onClick={() => decide.mutate({ decision: 'deny' })}
                >
                  {t('question.skip')}
                </Button>
              )}
              {!many && item.multi && !answered && (
                <Button
                  size="sm"
                  className="rounded-full"
                  disabled={!answers[0] || decide.isPending}
                  onClick={() => decide.mutate({ decision: 'allow', answer: answers[0] })}
                >
                  {t('question.send')}
                </Button>
              )}
              {many && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    className="rounded-full"
                    disabled={page === 0}
                    onClick={() => go(page - 1)}
                  >
                    {t('question.back')}
                  </Button>
                  {answered || !last ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="rounded-full"
                      disabled={last || (!answered && !answers[page])}
                      onClick={() => go(page + 1)}
                    >
                      {t('question.next')}
                    </Button>
                  ) : (
                    <Button
                      size="sm"
                      className="rounded-full"
                      disabled={answers.some((x) => !x) || decide.isPending}
                      onClick={() => decide.mutate({ decision: 'allow', answers })}
                    >
                      {t('question.send')}
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** Under a message written while the server could not be reached. */
function OfflineLine({ text }: { text: string }) {
  return (
    <span className="flex items-center gap-1 px-2 pt-1 text-xs text-muted-foreground">
      <WifiOff className="size-3" />
      {text}
    </span>
  );
}
