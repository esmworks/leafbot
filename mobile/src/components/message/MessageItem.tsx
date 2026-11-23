import {
  outsideTrigger,
  quoteExcerpt,
  subagentOf,
  type Bot,
  type Message,
  type ReplyQuote,
} from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useEffect, useState, type ReactNode } from 'react';
import { Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { confirm, toast, toastError } from '@/components/overlay';
import { PillButton, Sheet, type SheetItem } from '@/components/page';
import { t } from '@/i18n';
import { mixWithBlack } from '@/lib/color';
import { nav } from '@/lib/nav';
import { useConnections, useTurnChanges } from '@/lib/queries';
import { useLiveTool } from '@/lib/realtime';
import { useApi, useServer } from '@/lib/server';
import { newClientId } from '@/lib/stream';
import { useColors, type Colors } from '@/lib/theme';
import { Body } from './Body';
import {
  AppSuggestion,
  ApprovalCard,
  OpenedFrom,
  OpenedThread,
  PlanCard,
  SubagentCard,
  SignInCard,
  type PlanItem,
} from './Cards';
import { MessageFiles } from './Files';
import { BotPage, McpAppView } from './Frames';
import { Marker } from './Marker';
import { UndoTurnSheet } from './UndoTurn';
import { ON_TINT, bubblePalette, isLocal, messageFiles, replyQuoteOf, toolLabel, useBotMap } from './util';

/**
 * The contract the chat and room screens build on. The message components replace these bodies;
 * the props stay as they are (new optional ones may be added).
 */
export interface MessageItemProps {
  message: Message;
  /** The conversation's bot; in a room, the bot that wrote this message. */
  bot: Bot | undefined;
  threadId: string;
  /** Starts a reply that quotes this message in the composer. */
  onReply?: (m: Message) => void;
  /** Marks the message the screen was opened at (a search hit, a link). */
  highlighted?: boolean;
  /** Text the find bar looks for, marked inside the message. */
  find?: string;
  /** In a room: actions that only make sense in a bot's own conversation are left out. */
  room?: boolean;
  /** The conversation's last row with the bot idle: a failed or stopped request may run again. */
  canRetry?: boolean;
  /** Brings a message of this conversation into view; a quote uses it to go back to its message. */
  onJump?: (messageId: string) => void;
}

const QUICK_EMOJIS = ['👍', '👎', '❤️', '😂', '🙏', '🔥', '👏', '🎉'];

/** Characters of a message drawn before "Show the whole message". */
const LONG_MESSAGE = 20_000;

export function MessageItem({
  message: m,
  bot,
  onReply,
  highlighted,
  find,
  room,
  canRetry,
  onJump,
}: MessageItemProps) {
  const c = useColors();
  const body = (
    <MessageBody
      m={m}
      bot={bot}
      onReply={onReply}
      find={find}
      room={room}
      canRetry={canRetry}
      onJump={onJump}
    />
  );
  if (!highlighted) return body;
  return <View style={[styles.highlight, { backgroundColor: c.amberSoft }]}>{body}</View>;
}

function MessageBody({
  m,
  bot,
  onReply,
  find,
  room,
  canRetry,
  onJump,
}: {
  m: Message;
  bot: Bot | undefined;
  onReply?: (m: Message) => void;
  find?: string;
  room?: boolean;
  canRetry?: boolean;
  onJump?: (messageId: string) => void;
}) {
  const bots = useBotMap();
  const retry = !!canRetry && !room && !m.props.retried && m.props.kind !== 'auth' && !!m.turnId;
  const authorBot = m.author.startsWith('bot:') ? bots.get(m.author.slice(4)) : undefined;
  const botId = bot?.id;
  // A page the bot made with show_page.
  const page =
    m.props.page && typeof m.props.page === 'object'
      ? (m.props.page as { path: string; name: string; height?: number })
      : null;
  switch (m.role) {
    case 'user':
      if (authorBot) return <IncomingBot m={m} bot={authorBot} find={find} />;
      return <UserRow m={m} bot={bot} find={find} room={room} onJump={onJump} />;
    case 'assistant':
      return <AssistantRow m={m} bot={bot} page={page} onReply={onReply} find={find} room={room} />;
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
      return <ErrorRow m={m} retry={retry} />;
    default:
      return <NoteRow m={m} botId={botId} retry={retry} room={room} />;
  }
}

/** System notes and the cards a bot's tools leave in the thread. */
function NoteRow({ m, botId, retry, room }: { m: Message; botId?: string; retry: boolean; room?: boolean }) {
  const c = useColors();
  if (Array.isArray(m.props.plan)) return <PlanCard items={m.props.plan as PlanItem[]} />;
  if (m.props.subagent) {
    const sub = subagentOf(m.props);
    if (sub) return <SubagentCard sub={sub} />;
  }
  if (typeof m.props.connectionSignIn === 'string')
    return <SignInCard connectionId={m.props.connectionSignIn} text={m.text} botId={botId} />;
  if (m.props.app && typeof m.props.app === 'object') return <McpAppView m={m} />;
  if (typeof m.props.openedThread === 'string')
    return <OpenedThread threadId={m.props.openedThread} text={m.text} room={room} />;
  if (typeof m.props.suggestApp === 'string')
    return <AppSuggestion catalogId={m.props.suggestApp} reason={m.text} botId={botId} />;
  // What taking a turn back put back and left: several lines, kept as lines.
  if (m.props.kind === 'turnUndo')
    return (
      <View style={[styles.undoNote, { borderColor: c.border, backgroundColor: c.card }]}>
        <Text style={[styles.undoText, { color: c.foreground }]}>{m.text}</Text>
      </View>
    );
  return (
    <View style={styles.note}>
      <Text style={[styles.noteText, { color: c.mutedForeground }]}>{m.text}</Text>
      {retry && m.props.kind === 'interrupted' ? <RetryButton messageId={m.id} /> : null}
    </View>
  );
}

// ---------------------------------------------------------------------------------- actions

/** The person's emoji on a bot message; a second tap on the same one takes it back. */
function useReact(m: Message) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const key = ['messages', origin, m.threadId];
  return useMutation({
    mutationFn: (emoji: string | null) => api.react(m.id, emoji),
    onMutate: (emoji) => {
      qc.setQueryData<Message[]>(key, (list) =>
        list?.map((x) => {
          if (x.id !== m.id) return x;
          const { userReaction: _, ...props } = x.props;
          return { ...x, props: emoji ? { ...props, userReaction: emoji } : props };
        }),
      );
    },
    onError: toastError,
    onSettled: () => qc.invalidateQueries({ queryKey: key }),
  });
}

async function copyText(text: string) {
  try {
    await Clipboard.setStringAsync(text);
    toast(t('message.copied'));
  } catch {
    toast(t('message.copyFailed'), { tone: 'error' });
  }
}

/** What a long press on a message offers, as a sheet; the reaction picker is a second sheet. */
function MessageSheet({
  m,
  open,
  onClose,
  room,
  onReply,
  raw,
  onToggleRaw,
  details,
  row,
}: {
  m: Message;
  open: boolean;
  onClose: () => void;
  /** Also shows the actions as a row of small buttons under the message. */
  row?: boolean;
  room?: boolean;
  onReply?: (m: Message) => void;
  raw?: boolean;
  onToggleRaw?: () => void;
  /** For a failure: the text that goes along in a report. */
  details?: string;
}) {
  const c = useColors();
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const react = useReact(m);
  const [picking, setPicking] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [undoing, setUndoing] = useState(false);
  // Only turns that changed something, and only for the person whose turn it was.
  const { data: undoable } = useTurnChanges(m.threadId);
  const reaction =
    typeof m.props.userReaction === 'string' && m.props.userReaction ? m.props.userReaction : null;
  const invalidate = () => qc.invalidateQueries({ queryKey: ['messages', origin, m.threadId] });

  const remove = async () => {
    const yes = await confirm({
      title: t('message.confirmDelete'),
      confirmLabel: t('message.delete'),
      destructive: true,
    });
    if (!yes) return;
    try {
      await api.removeMessage(m.id);
      await invalidate();
    } catch (e) {
      toastError(e);
    }
  };
  const pin = async () => {
    try {
      const updated = await api.pinMessage(m.threadId, m.id);
      await qc.invalidateQueries({ queryKey: ['threads', origin, updated.botId] });
    } catch (e) {
      toastError(e);
    }
  };
  // A branch from here: a new conversation with everything up to this reply, to go another way.
  const fork = async () => {
    try {
      const created = await api.forkFrom(m.id);
      await qc.invalidateQueries({ queryKey: ['threads', origin, created.botId] });
      nav.replaceChat(created.botId, { threadId: created.id });
      toast(t('message.forked'));
    } catch (e) {
      toastError(e);
    }
  };

  const items: SheetItem[] = [];
  if (details)
    items.push({ icon: 'copy', label: t('message.copyDetails'), onPress: () => void copyText(details) });
  if (m.role === 'assistant' || m.role === 'user') {
    if (m.text) items.push({ icon: 'copy', label: t('message.copy'), onPress: () => void copyText(m.text) });
    // A long press on a message opens this sheet, so the phone's own text selection never starts
    // on the message; here the text is shown where it can be selected and copied in part.
    if (m.text)
      items.push({ icon: 'type', label: t('message.selectText'), onPress: () => setSelecting(true) });
  }
  if (m.role === 'assistant' && m.text && onToggleRaw) {
    items.push({
      icon: 'code',
      label: raw ? t('message.showFormatted') : t('message.showMarkdown'),
      onPress: onToggleRaw,
    });
  }
  if (m.role === 'assistant' || m.role === 'user') {
    items.push({
      icon: 'trash-2',
      label: t('message.delete'),
      onPress: () => void remove(),
      destructive: true,
    });
  }
  if (m.role === 'assistant') {
    items.push({ icon: 'smile', label: t('message.react'), onPress: () => setPicking(true) });
    if (onReply) items.push({ icon: 'corner-up-left', label: t('message.reply'), onPress: () => onReply(m) });
    if (!room) {
      items.push({ icon: 'git-branch', label: t('message.fork'), onPress: () => void fork() });
      items.push({ icon: 'bookmark', label: t('message.pin'), onPress: () => void pin() });
    }
    if (m.turnId && undoable?.[m.turnId]) {
      items.push({ icon: 'rotate-ccw', label: t('message.undoTurn'), onPress: () => setUndoing(true) });
    }
  }
  return (
    <>
      {row ? (
        <View style={[styles.actions, m.role === 'user' ? styles.actionsEnd : null]}>
          {reaction && m.role === 'assistant' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('message.yourReaction', { emoji: reaction })}
              onPress={() => react.mutate(null)}
              style={[styles.rowReaction, { backgroundColor: c.muted }]}
            >
              <Text style={styles.reactionText}>{reaction}</Text>
            </Pressable>
          ) : null}
          {items.map((it) => (
            <Pressable
              key={it.label}
              accessibilityRole="button"
              accessibilityLabel={it.label}
              onPress={it.onPress}
              hitSlop={4}
              style={({ pressed }) => [styles.action, pressed && { backgroundColor: c.accent }]}
            >
              {it.icon && ROW_GLYPH[it.icon] ? (
                <MaterialCommunityIcons name={ROW_GLYPH[it.icon]} size={16} color={c.mutedForeground} />
              ) : (
                <Feather name={it.icon ?? 'circle'} size={15} color={c.mutedForeground} />
              )}
            </Pressable>
          ))}
        </View>
      ) : null}
      <Sheet open={open} onClose={onClose} items={items} />
      <Sheet open={selecting} onClose={() => setSelecting(false)} title={t('message.selectTextHint')}>
        <SelectableText text={m.text} />
      </Sheet>
      {m.turnId ? (
        <UndoTurnSheet
          turnId={m.turnId}
          threadId={m.threadId}
          open={undoing}
          onClose={() => setUndoing(false)}
        />
      ) : null}
      <Sheet open={picking} onClose={() => setPicking(false)} title={t('message.react')}>
        <View style={styles.emojis}>
          {QUICK_EMOJIS.map((e) => (
            <Pressable
              key={e}
              accessibilityRole="button"
              accessibilityLabel={t('message.reaction', { emoji: e })}
              accessibilityState={{ selected: e === reaction }}
              onPress={() => {
                setPicking(false);
                react.mutate(e === reaction ? null : e);
              }}
              style={({ pressed }) => [styles.emoji, (pressed || e === reaction) && { opacity: 0.6 }]}
            >
              <Text style={styles.emojiText}>{e}</Text>
            </Pressable>
          ))}
        </View>
      </Sheet>
    </>
  );
}

/**
 * A message's text where any part of it can be selected and copied. iOS selects within text only in
 * a text box, so there it is a box that cannot be edited; Android selects within plain text.
 */
function SelectableText({ text }: { text: string }) {
  const c = useColors();
  const style = [styles.selectable, { color: c.foreground }];
  return Platform.OS === 'ios' ? (
    <TextInput value={text} editable={false} multiline scrollEnabled={false} style={style} />
  ) : (
    <Text selectable style={style}>
      {text}
    </Text>
  );
}

/** Row buttons whose usual icon reads differently from the sheet's: the pin, adding a reaction, the source. */
const ROW_GLYPH: Partial<Record<string, keyof typeof MaterialCommunityIcons.glyphMap>> = {
  bookmark: 'pin-outline',
  smile: 'emoticon-plus-outline',
  code: 'file-code-outline',
};

/**
 * Puts the message's actions under it as small buttons, as touch screens show them, and in a
 * sheet on a long press.
 */
function Actionable({
  children,
  disabled,
  ...sheet
}: {
  children: ReactNode;
  disabled?: boolean;
  m: Message;
  room?: boolean;
  onReply?: (m: Message) => void;
  raw?: boolean;
  onToggleRaw?: () => void;
  details?: string;
}) {
  const [open, setOpen] = useState(false);
  const { m } = sheet;
  const row = !disabled && !m.props.partial && (m.role === 'assistant' || m.role === 'user');
  return (
    <>
      <Pressable
        accessibilityActions={disabled ? undefined : [{ name: 'longpress', label: t('message.copy') }]}
        onLongPress={
          disabled
            ? undefined
            : () => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
                setOpen(true);
              }
        }
        delayLongPress={350}
        style={styles.pressable}
      >
        {children}
      </Pressable>
      <MessageSheet {...sheet} open={open} onClose={() => setOpen(false)} row={row} />
    </>
  );
}

// ---------------------------------------------------------------------------------- the person

function UserRow({
  m,
  bot,
  find,
  room,
  onJump,
}: {
  m: Message;
  bot: Bot | undefined;
  find?: string;
  room?: boolean;
  onJump?: (messageId: string) => void;
}) {
  const c = useColors();
  const files = messageFiles(m);
  const quote = replyQuoteOf(m);
  const sending = isLocal(m);
  const queued = m.props.queued === true && !sending;
  const tint = mixWithBlack(bot?.color ?? c.brand, 0.82);
  const reaction = typeof m.props.reaction === 'string' && m.props.reaction ? m.props.reaction : null;
  return (
    <View style={styles.userCol}>
      {quote ? <QuoteLine quote={quote} threadId={m.threadId} bot={bot} room={room} onJump={onJump} /> : null}
      {m.author.startsWith('routine:') ? (
        <View style={styles.routine}>
          <Feather name="clock" size={12} color={c.mutedForeground} />
          <Text style={[styles.small, { color: c.mutedForeground }]}>
            {typeof m.props.routineName === 'string'
              ? t('message.routineNamed', { name: m.props.routineName })
              : t('message.routine')}
          </Text>
        </View>
      ) : null}
      {files.length > 0 ? (
        <View style={{ opacity: sending ? 0.6 : 1 }}>
          <MessageFiles files={files} botId={sending ? undefined : bot?.id} />
        </View>
      ) : null}
      {queued ? (
        <QueuedMessage m={m} tint={tint} hasFiles={files.length > 0} />
      ) : m.text || !files.length ? (
        <Actionable m={m} room={room} disabled={sending || m.author !== 'user'}>
          <View
            style={[
              styles.user,
              { backgroundColor: tint, opacity: sending ? 0.6 : 1 },
              reaction ? styles.withReaction : null,
            ]}
          >
            <Body text={m.text} palette={ON_TINT} breaks find={find} />
            {reaction ? <Reaction emoji={reaction} /> : null}
          </View>
        </Actionable>
      ) : null}
    </View>
  );
}

/** The bot's emoji on a user message, pinned to the bubble's lower corner. */
function Reaction({ emoji }: { emoji: string }) {
  const c = useColors();
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={t('message.reaction', { emoji })}
      style={[styles.reaction, { backgroundColor: c.muted, borderColor: c.background }]}
    >
      <Text style={styles.reactionText}>{emoji}</Text>
    </View>
  );
}

/**
 * The person's message while the bot is busy with an earlier one: it waits its turn, and until the
 * bot starts on it the person may hand it to the work under way, change it or take it back.
 */
function QueuedMessage({ m, tint, hasFiles }: { m: Message; tint: string; hasFiles: boolean }) {
  const c = useColors();
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(m.text);
  const done = () => qc.invalidateQueries({ queryKey: ['messages', origin, m.threadId] });
  const save = useMutation({
    mutationFn: () => api.editMessage(m.id, text.trim()),
    onSuccess: () => {
      setEditing(false);
      void done();
    },
    onError: toastError,
  });
  const cancel = useMutation({
    mutationFn: () => api.removeMessage(m.id),
    onSuccess: () => void done(),
    onError: toastError,
  });
  // Handed to the work under way: the bot reads it at its next step instead of afterwards.
  const steer = useMutation({
    mutationFn: () => api.steerMessage(m.id),
    onSuccess: () => void done(),
    onError: toastError,
  });
  const steering = m.props.steering === true;
  if (editing) {
    return (
      <View style={styles.edit}>
        <TextInput
          autoFocus
          multiline
          value={text}
          onChangeText={setText}
          accessibilityLabel={t('message.editQueued')}
          placeholderTextColor={c.mutedForeground}
          style={[styles.editInput, { color: c.foreground, backgroundColor: c.card, borderColor: c.border }]}
        />
        <View style={styles.editButtons}>
          <PillButton label={t('common.cancel')} variant="ghost" onPress={() => setEditing(false)} />
          <PillButton
            label={t('common.save')}
            variant="primary"
            disabled={save.isPending || (!text.trim() && !hasFiles)}
            onPress={() => save.mutate()}
          />
        </View>
      </View>
    );
  }
  return (
    <>
      {m.text || !hasFiles ? (
        <View style={[styles.user, { backgroundColor: tint, opacity: 0.75 }]}>
          <Text style={[styles.plain, { color: ON_TINT.text }]}>{m.text}</Text>
        </View>
      ) : null}
      <View style={styles.queued}>
        <Feather name="clock" size={12} color={c.mutedForeground} />
        <Text style={[styles.small, { color: c.mutedForeground }]}>
          {steering ? t('message.steering') : t('message.queued')}
        </Text>
        {!steering ? (
          <QueuedAction
            label={t('message.steer')}
            disabled={steer.isPending}
            onPress={() => steer.mutate()}
          />
        ) : null}
        <QueuedAction label={t('message.editQueued')} onPress={() => setEditing(true)} />
        <QueuedAction
          label={t('message.cancelQueued')}
          disabled={cancel.isPending}
          onPress={() => cancel.mutate()}
        />
      </View>
    </>
  );
}

function QueuedAction({
  label,
  onPress,
  disabled,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
}) {
  const c = useColors();
  return (
    <>
      <Text style={[styles.small, { color: c.mutedForeground }]}>·</Text>
      <Pressable accessibilityRole="button" disabled={disabled} onPress={onPress} hitSlop={8}>
        <Text style={[styles.small, styles.underline, { color: c.foreground, opacity: disabled ? 0.5 : 1 }]}>
          {label}
        </Text>
      </Pressable>
    </>
  );
}

/** The answered message, quoted above the person's reply; a tap scrolls back to it. */
function QuoteLine({
  quote,
  threadId,
  bot,
  room,
  onJump,
}: {
  quote: ReplyQuote;
  threadId: string;
  bot: Bot | undefined;
  room?: boolean;
  onJump?: (messageId: string) => void;
}) {
  const c = useColors();
  // Opening the same address again would change nothing, so a second tap on a quote needs the
  // screen's own way to scroll.
  const jump =
    !room && bot
      ? onJump
        ? () => onJump(quote.id)
        : () => nav.replaceChat(bot.id, { threadId, focus: quote.id })
      : undefined;
  return (
    <Pressable
      accessibilityRole={jump ? 'button' : 'text'}
      accessibilityLabel={t('message.replyTo', { text: quote.text })}
      disabled={!jump}
      onPress={jump}
      style={styles.quote}
    >
      <Feather name="corner-up-left" size={16} color={c.mutedForeground} style={styles.quoteIcon} />
      <Text style={[styles.quoteText, { color: c.mutedForeground }]} numberOfLines={2}>
        {quote.text}
      </Text>
    </Pressable>
  );
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

// ---------------------------------------------------------------------------------- the bot

function AssistantRow({
  m,
  bot,
  page,
  onReply,
  find,
  room,
}: {
  m: Message;
  bot: Bot | undefined;
  page: { path: string; name: string; height?: number } | null;
  onReply?: (m: Message) => void;
  find?: string;
  room?: boolean;
}) {
  const c = useColors();
  const files = messageFiles(m);
  const [raw, setRaw] = useState(false);
  const react = useReact(m);
  const reaction =
    typeof m.props.userReaction === 'string' && m.props.userReaction ? m.props.userReaction : null;
  const sheet = { m, room, onReply, raw, onToggleRaw: () => setRaw((v) => !v) };
  const card =
    !page && files.length && !m.text ? null : (
      <Actionable {...sheet}>
        {page ? (
          <BotPage
            botId={bot?.id ?? ''}
            path={page.path}
            name={page.name}
            title={m.text}
            height={page.height}
          />
        ) : (
          <AssistantCard text={m.text} partial={!!m.props.partial} raw={raw} find={find} />
        )}
      </Actionable>
    );
  return (
    <View style={styles.assistantCol}>
      {m.props.routineReport === true || m.props.routineInMain === true ? (
        <RoutineReportLine m={m} botId={bot?.id} />
      ) : null}
      {!page && files.length ? (
        // Files the bot sent with send_file, with its note if it wrote one.
        <View style={styles.assistantFiles}>
          <MessageFiles files={files} botId={bot?.id} align="start" />
          {m.text ? card : null}
        </View>
      ) : (
        card
      )}
      {/* With a card the reaction leads its row of actions; bare files show it here. */}
      {reaction && !card ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('message.yourReaction', { emoji: reaction })}
          onPress={() => react.mutate(null)}
          style={[styles.userReaction, { backgroundColor: c.muted }]}
        >
          <Text style={styles.reactionText}>{reaction}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/** Over a routine's report in the main conversation: which routine wrote it, opening the run's steps. */
function RoutineReportLine({ m, botId }: { m: Message; botId?: string }) {
  const c = useColors();
  const name = typeof m.props.routineName === 'string' ? m.props.routineName : '';
  const run = typeof m.props.routineThreadId === 'string' ? m.props.routineThreadId : null;
  const line = (
    <>
      <Feather name="clock" size={12} color={c.mutedForeground} />
      <Text style={[styles.small, { color: c.mutedForeground }]}>
        {name ? t('message.routineNamed', { name }) : t('message.routine')}
      </Text>
    </>
  );
  if (!run || !botId) return <View style={[styles.routine, styles.routineReport]}>{line}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={t('message.openRoutineRun')}
      onPress={() => nav.replaceChat(botId, { threadId: run })}
      style={[styles.routine, styles.routineReport]}
    >
      {line}
    </Pressable>
  );
}

function AssistantCard({
  text,
  partial,
  raw,
  find,
  streaming,
}: {
  text: string;
  partial?: boolean;
  raw?: boolean;
  find?: string;
  streaming?: boolean;
}) {
  const c = useColors();
  // A very long reply draws its start; the rest on request, so the chat stays quick.
  const [whole, setWhole] = useState(false);
  const long = !streaming && !whole && text.length > LONG_MESSAGE;
  const shown = long ? `${text.slice(0, LONG_MESSAGE)}…` : text;
  return (
    <View style={[styles.assistant, { backgroundColor: c.bubble }]}>
      {raw ? (
        <Text style={[styles.mono, { color: c.foreground }]} selectable>
          {shown}
        </Text>
      ) : (
        <Body text={shown} palette={bubblePalette(c)} find={find} />
      )}
      {long ? (
        <View style={styles.showAll}>
          <PillButton label={t('message.showAll', { count: text.length })} onPress={() => setWhole(true)} />
        </View>
      ) : null}
      {partial ? (
        <Text style={[styles.small, styles.partial, { color: c.mutedForeground }]}>
          {t('message.partial')}
        </Text>
      ) : null}
    </View>
  );
}

/** A bot's message in a thread of someone else's: who wrote it, then the text. */
function IncomingBot({ m, bot, find }: { m: Message; bot: Bot; find?: string }) {
  const c = useColors();
  return (
    <View style={styles.incoming}>
      <View style={styles.author}>
        <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={20} />
        <Text style={[styles.small, { color: c.mutedForeground }]}>
          <Text style={[styles.authorName, { color: c.foreground }]}>{bot.name}</Text> {t('message.wrote')}
        </Text>
      </View>
      {typeof m.props.openedFrom === 'string' ? <OpenedFrom threadId={m.props.openedFrom} /> : null}
      <View
        style={[styles.assistant, styles.bordered, { borderColor: c.border, backgroundColor: c.background }]}
      >
        <Body text={m.text} palette={bubblePalette(c)} find={find} />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------------- failures

function ErrorRow({ m, retry }: { m: Message; retry: boolean }) {
  const c = useColors();
  const details = [
    m.text,
    `kind: ${String(m.props.kind ?? '-')}`,
    `turn: ${m.turnId ?? '-'}`,
    `at: ${m.createdAt}`,
  ].join('\n');
  return (
    <Actionable m={m} details={details}>
      <View
        style={[
          styles.assistant,
          styles.error,
          { borderColor: `${c.destructive}4D`, backgroundColor: `${c.destructive}1A` },
        ]}
      >
        <Feather name="alert-circle" size={24} color={c.destructive} style={styles.errorIcon} />
        <View style={styles.errorBody}>
          <Text style={[styles.plain, { color: c.foreground }]} selectable>
            {m.text}
          </Text>
          {retry ? (
            <View style={styles.buttons}>
              {m.props.stepLimit === true ? <GoOnButton threadId={m.threadId} /> : null}
              <RetryButton messageId={m.id} />
            </View>
          ) : null}
          {m.props.kind === 'auth' ? (
            <View style={styles.buttons}>
              <PillButton
                label={t('message.connectClaude')}
                variant="primary"
                onPress={() => nav.settings('connection')}
              />
            </View>
          ) : null}
        </View>
      </View>
    </Actionable>
  );
}

/**
 * Tells a bot that ran out of steps mid-task to go on from where it stopped: its session holds the
 * work so far. The person decides, so a looping bot never spends twice on its own.
 */
function GoOnButton({ threadId }: { threadId: string }) {
  const api = useApi();
  const { origin } = useServer();
  const qc = useQueryClient();
  const go = useMutation({
    mutationFn: () => api.send(threadId, newClientId(), t('message.goOnText')),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['messages', origin, threadId] }),
    onError: toastError,
  });
  return (
    <PillButton
      label={t('message.goOn')}
      icon="play"
      variant="primary"
      disabled={go.isPending || go.isSuccess}
      onPress={() => go.mutate()}
    />
  );
}

/** Runs again the request a failed or stopped turn left unanswered. */
function RetryButton({ messageId }: { messageId: string }) {
  const api = useApi();
  const run = useMutation({ mutationFn: () => api.retryMessage(messageId), onError: toastError });
  return (
    <PillButton
      label={t('message.retry')}
      icon="rotate-ccw"
      disabled={run.isPending || run.isSuccess}
      onPress={() => run.mutate()}
    />
  );
}

// ---------------------------------------------------------------------------------- live

/** A reply the bot is writing now, before it is saved, with the bot at work under it. */
export function LiveReply({ text, bot, threadId }: { text: string; bot: Bot | undefined; threadId: string }) {
  return (
    <View style={styles.assistantCol}>
      {text ? <AssistantCard text={text} streaming /> : null}
      {bot ? <Working bot={bot} activity={text ? 'writing' : 'thinking'} threadId={threadId} /> : null}
    </View>
  );
}

/** Text a bot wrote before a card it asked in the same reply, while that reply still streams in. */
export function LiveText({ text }: { text: string }) {
  return (
    <View style={styles.assistantCol}>
      <AssistantCard text={text} streaming />
    </View>
  );
}

export type WorkingActivity = 'queued' | 'thinking' | 'writing' | 'browsing' | 'waiting';

/** The bot at work under the conversation: who it is, and what it does. */
export function Working({
  bot,
  activity = 'thinking',
  threadId,
}: {
  bot: Bot;
  activity?: WorkingActivity;
  threadId?: string;
}) {
  const c = useColors();
  // While it thinks, say what it is doing when a tool runs: a long command reads as work, not a hang.
  const tool = useLiveTool(threadId);
  const { data: connections = [] } = useConnections();
  const doing =
    activity === 'thinking' && tool
      ? toolLabel(tool, new Map(connections.map((x) => [x.slug, x.name])))
      : null;
  return (
    <View style={styles.working} accessibilityRole="progressbar">
      <Avatar
        name={bot.name}
        color={bot.color}
        avatar={bot.avatar}
        size={28}
        seed={bot.id}
        activity={activity}
        motion="always"
      />
      <Text style={[styles.workingText, { color: c.mutedForeground }]}>
        {doing ?? t(`activity.${activity}`)}
      </Text>
      <Elapsed key={doing ?? activity} c={c} />
      {activity === 'browsing' ? (
        <PillButton label={t('activity.watch')} icon="eye" onPress={() => nav.computer(bot.id)} />
      ) : null}
    </View>
  );
}

/** How long the bot has been on this step, once it takes longer than a few seconds. */
function Elapsed({ c }: { c: Colors }) {
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
  return <Text style={[styles.workingText, { color: c.mutedForeground }]}>{`· ${text}`}</Text>;
}

const styles = StyleSheet.create({
  highlight: { borderRadius: 20, marginHorizontal: -6, paddingHorizontal: 6, paddingVertical: 4 },
  pressable: { alignSelf: 'stretch' },
  selectable: { fontSize: 17, lineHeight: 24, paddingHorizontal: 20, paddingBottom: 12 },
  actions: { flexDirection: 'row', alignSelf: 'flex-start', gap: 2, marginTop: 2 },
  actionsEnd: { alignSelf: 'flex-end' },
  rowReaction: {
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    paddingHorizontal: 4,
    marginRight: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  action: { width: 28, height: 28, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  strongText: { fontWeight: '600' },
  small: { fontSize: 15, lineHeight: 20 },
  underline: { textDecorationLine: 'underline' },
  plain: { fontSize: 17, lineHeight: 26 },
  mono: { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontSize: 15, lineHeight: 22 },
  note: { alignItems: 'center', gap: 8, paddingVertical: 4 },
  undoNote: { alignSelf: 'stretch', borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 14 },
  undoText: { fontSize: 15, lineHeight: 22 },
  promise: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  noteText: { fontSize: 16, lineHeight: 22, textAlign: 'center', paddingHorizontal: 24 },
  userCol: { alignItems: 'flex-end', gap: 4 },
  user: {
    alignSelf: 'flex-end',
    maxWidth: '80%',
    borderRadius: 24,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  withReaction: { marginBottom: 16 },
  routine: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8 },
  routineReport: { alignSelf: 'flex-start', paddingBottom: 4 },
  reaction: {
    position: 'absolute',
    bottom: -16,
    left: 12,
    minWidth: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
  },
  reactionText: { fontSize: 17 },
  userReaction: {
    alignSelf: 'flex-start',
    marginTop: 4,
    minWidth: 28,
    height: 28,
    borderRadius: 10,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  queued: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 4, paddingHorizontal: 8 },
  edit: { alignSelf: 'stretch', gap: 8 },
  editInput: {
    minHeight: 80,
    maxHeight: 200,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 16,
    paddingVertical: 10,
    fontSize: 17,
    textAlignVertical: 'top',
  },
  editButtons: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8 },
  quote: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 6,
    maxWidth: '80%',
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  quoteIcon: { marginTop: 3 },
  quoteText: { flexShrink: 1, fontSize: 16, lineHeight: 22 },
  assistantCol: { alignItems: 'flex-start', gap: 4 },
  assistantFiles: { alignItems: 'flex-start', gap: 8 },
  // A reply may take the conversation's whole width, as on the web page on a phone.
  assistant: {
    alignSelf: 'flex-start',
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 16,
  },
  bordered: { borderWidth: 1 },
  showAll: { flexDirection: 'row', marginTop: 12 },
  partial: { marginTop: 8 },
  incoming: { alignSelf: 'flex-start', gap: 8 },
  author: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  authorName: { fontWeight: '600' },
  error: { flexDirection: 'row', gap: 12, borderWidth: 1 },
  errorIcon: { marginTop: 2 },
  errorBody: { flexShrink: 1, gap: 12 },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  working: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  workingText: { fontSize: 16 },
  emojis: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: 4,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  emoji: { width: 52, height: 52, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  emojiText: { fontSize: 28 },
});
