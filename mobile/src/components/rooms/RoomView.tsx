import { FULL_PAGE, lastResetIndex, streamParts, type Bot, type Message, type Room } from '@leafbot/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { Avatar } from '@/components/Avatar';
import { Composer, type SendExtra } from '@/components/chat/Composer';
import { MessageBoundary } from '@/components/chat/Bars';
import {
  LiveReply,
  LiveText,
  MessageItem,
  Working,
  type WorkingActivity,
} from '@/components/message/MessageItem';
import { confirm, toastError } from '@/components/overlay';
import { IconButton, Sheet, back, type SheetItem } from '@/components/page';
import { Button } from '@/components/ui';
import { locale, t } from '@/i18n';
import { ApiError } from '@/lib/api';
import { useTapToDismiss } from '@/lib/dismiss';
import { formatters, needsDivider } from '@/lib/format';
import { nav } from '@/lib/nav';
import { useLiveCards } from '@/lib/liveCards';
import { useBots, useMessages } from '@/lib/queries';
import { useLiveCatchUp, useLiveState, useStream } from '@/lib/realtime';
import { useApi, useServer } from '@/lib/server';
import { newClientId, streamSaved, withPending } from '@/lib/stream';
import { useColors } from '@/lib/theme';
import { RoomFace, useMembers } from './RoomFace';

const fmt = formatters(locale, t);
const NONE: Message[] = [];

type Row =
  | { kind: 'divider'; key: string; label: string }
  | { kind: 'speaker'; key: string; bot: Bot | undefined }
  | { kind: 'message'; key: string; m: Message; bot: Bot | undefined }
  | { kind: 'part'; key: string; text: string }
  | { kind: 'live'; key: string; bot: Bot | undefined; from: number }
  | { kind: 'working'; key: string; bot: Bot; activity: WorkingActivity };

/** Whose words a row is: a bot's id, `user`, or null for the room's own notes. */
function speakerOf(m: Message): string | null {
  if (m.role === 'assistant' || m.role === 'approval' || (m.role === 'system' && m.author.startsWith('bot:')))
    return m.author.slice(4);
  return m.role === 'user' ? 'user' : null;
}

/** A room: the conversation of the person with its bots, one speaking at a time. */
export function RoomView({ room }: { room: Room }) {
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data: bots } = useBots();
  const botMap = useMemo(() => new Map((bots ?? []).map((b) => [b.id, b])), [bots]);
  const members = useMembers(room);
  const messagesQ = useMessages(room.id);
  const recent = messagesQ.data ?? NONE;

  // Messages before the latest page, loaded on request and kept while the room is open.
  const [older, setOlder] = useState<Message[]>([]);
  const [olderDone, setOlderDone] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const messages = useMemo(() => {
    if (!older.length) return recent;
    const ids = new Set(recent.map((m) => m.id));
    return [...older.filter((m) => !ids.has(m.id)), ...recent];
  }, [older, recent]);
  // A room started fresh opens empty: what came before its last reset shows only when asked for,
  // and hides again once the room is reset anew. Older pages wait until it shows.
  const resetAt = lastResetIndex(messages);
  const [earlierOf, setEarlierOf] = useState<string | null>(null);
  const hidden = resetAt >= 0 && earlierOf !== messages[resetAt]!.id ? resetAt + 1 : 0;
  const current = useMemo(() => (hidden ? messages.slice(hidden) : messages), [messages, hidden]);
  const showEarlier = () => setEarlierOf(messages[resetAt]?.id ?? null);
  const hasOlder = !hidden && !olderDone && (older.length > 0 || recent.length >= FULL_PAGE);
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);
  const busyOlder = useRef(false);
  const loadOlder = useCallback(async () => {
    const first = messagesRef.current[0];
    if (!first || busyOlder.current) return;
    busyOlder.current = true;
    setLoadingOlder(true);
    try {
      const page = await api.messages(room.id, first.id);
      setOlder((o) => [...page, ...o]);
      if (page.length < FULL_PAGE) setOlderDone(true);
    } catch (e) {
      toastError(e);
    } finally {
      busyOlder.current = false;
      setLoadingOlder(false);
    }
  }, [api, room.id]);

  const stream = useStream(room.id);
  useLiveCatchUp(room.id);
  const live = useLiveState(room.id);
  const state = live ?? room.state;
  const busy = state !== 'idle';
  const speaker = room.speakerId ? botMap.get(room.speakerId) : undefined;
  const [pending, setPending] = useState<Message[]>([]);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [menu, setMenu] = useState(false);
  const listRef = useRef<FlatList<Row>>(null);
  const tapToDismiss = useTapToDismiss();

  const signedOut = messagesQ.error instanceof ApiError && messagesQ.error.status === 401;
  useEffect(() => {
    if (signedOut) void qc.invalidateQueries({ queryKey: ['session', origin] });
  }, [signedOut, qc, origin]);

  const streamDone = streamSaved(stream, messages);
  const streaming = !!stream?.text && !streamDone;
  const listed = useMemo(() => withPending(current, pending), [current, pending]);
  // A card asked while the reply streams in goes inside it, where it was asked.
  const { messages: shown, cards, head, end } = useLiveCards(listed, stream, streamDone);
  // Whether anything was written after the last card: until then the turn waits on its answer.
  const tail = (stream?.text.length ?? 0) > end;

  const rows = useMemo(() => {
    const out: Row[] = [];
    let last: string | null = null;
    shown.forEach((m, i) => {
      if (needsDivider(shown[i - 1], m))
        out.push({ kind: 'divider', key: `d-${m.id}`, label: fmt.dayLabel(m.createdAt) });
      const who = speakerOf(m);
      const bot = who && who !== 'user' ? botMap.get(who) : undefined;
      if (who && who !== 'user' && who !== last) out.push({ kind: 'speaker', key: `s-${m.id}`, bot });
      if (who) last = who;
      out.push({ kind: 'message', key: m.clientId || m.id, m, bot });
    });
    const held = cards.length > 0 && !tail && state === 'waiting';
    if ((streaming || cards.length) && speaker && speaker.id !== last)
      out.push({ kind: 'speaker', key: 's-live', bot: speaker });
    for (const p of streamParts(head, cards)) {
      if (p.kind === 'text') out.push({ kind: 'part', key: `part-${p.from}`, text: p.text });
      else {
        const who = speakerOf(p.card);
        out.push({ kind: 'message', key: p.card.id, m: p.card, bot: who ? botMap.get(who) : undefined });
      }
    }
    if (streaming && !held) out.push({ kind: 'live', key: 'live', bot: speaker, from: end });
    else if (speaker && busy) {
      const activity: WorkingActivity =
        state === 'queued' ? 'queued' : state === 'waiting' ? 'waiting' : 'thinking';
      out.push({ kind: 'working', key: 'working', bot: speaker, activity });
    }
    return out.reverse();
  }, [shown, cards, head, end, tail, botMap, streaming, speaker, busy, state]);

  const send = useCallback(
    async (text: string, extra?: SendExtra): Promise<string | null> => {
      const clientId = newClientId();
      const local: Message = {
        id: `local-${clientId}`,
        threadId: room.id,
        role: 'user',
        author: 'user',
        text,
        props: extra?.replyTo ? { replyTo: extra.replyTo } : {},
        clientId,
        turnId: null,
        createdAt: new Date().toISOString(),
      };
      setPending((p) => [...p, local]);
      listRef.current?.scrollToOffset({ offset: 0, animated: true });
      try {
        await api.sendToRoom(room.id, clientId, text, extra?.replyTo?.id);
        await qc.invalidateQueries({ queryKey: ['messages', origin, room.id] });
        return null;
      } catch (e) {
        return e instanceof ApiError ? e.message : t('chat.sendFailed');
      } finally {
        setPending((p) => p.filter((x) => x.clientId !== clientId));
      }
    },
    [api, qc, origin, room.id],
  );
  const stop = useCallback(() => void api.stopRoom(room.id).catch(toastError), [api, room.id]);

  const remove = useCallback(async () => {
    const ok = await confirm({
      title: t('room.delete'),
      message: t('room.deleteConfirm', { name: room.title }),
      confirmLabel: t('room.delete'),
      destructive: true,
    });
    if (!ok) return;
    try {
      await api.deleteRoom(room.id);
      // The room screen leaves by itself once the list no longer has this room; going back here too
      // would pop a second screen.
      await qc.invalidateQueries({ queryKey: ['rooms', origin] });
    } catch (e) {
      toastError(e);
    }
  }, [api, qc, origin, room.id, room.title]);

  const reset = useCallback(async () => {
    const ok = await confirm({
      title: t('room.reset'),
      message: t('room.resetConfirm'),
      confirmLabel: t('room.reset'),
    });
    if (!ok) return;
    try {
      await api.resetRoom(room.id);
      await qc.invalidateQueries({ queryKey: ['messages', origin, room.id] });
    } catch (e) {
      toastError(e);
    }
  }, [api, qc, origin, room.id]);

  const items: SheetItem[] = [
    { icon: 'edit-2', label: t('room.edit'), onPress: () => nav.roomEdit(room.id) },
    ...(busy ? [{ icon: 'square' as const, label: t('chat.stop'), onPress: stop }] : []),
    { icon: 'rotate-ccw', label: t('room.reset'), onPress: () => void reset() },
    { icon: 'trash-2', label: t('room.delete'), onPress: () => void remove(), destructive: true },
  ];

  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      switch (item.kind) {
        case 'divider':
          return <Text style={[styles.divider, { color: c.mutedForeground }]}>{item.label}</Text>;
        case 'speaker':
          return <SpeakerLine bot={item.bot} />;
        case 'part':
          return <LiveText text={item.text} />;
        case 'live':
          return <LiveReply text={stream?.text.slice(item.from) ?? ''} bot={item.bot} threadId={room.id} />;
        case 'working':
          return <Working bot={item.bot} activity={item.activity} threadId={room.id} />;
        case 'message': {
          const sending = item.m.id.startsWith('local-');
          return (
            <MessageBoundary>
              <View style={sending ? styles.sending : undefined}>
                <MessageItem
                  message={item.m}
                  bot={item.bot}
                  threadId={room.id}
                  room
                  onReply={item.m.role === 'assistant' && !sending ? setReplyTo : undefined}
                />
              </View>
            </MessageBoundary>
          );
        }
      }
    },
    [c, stream?.text, room.id],
  );

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        <IconButton icon="chevron-left" size={24} label={t('chat.backToList')} onPress={back} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('room.edit')}
          onPress={() => nav.roomEdit(room.id)}
          style={[styles.pill, { backgroundColor: c.card, borderColor: c.border }]}
        >
          <RoomFace members={members} size={24} />
          <Text style={[styles.pillTitle, { color: c.foreground }]} numberOfLines={1}>
            {room.title}
          </Text>
        </Pressable>
        <IconButton icon="more-horizontal" label={t('room.edit')} onPress={() => setMenu(true)} />
      </View>
      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={styles.list}>
          {messagesQ.isPending ? (
            <View style={styles.center}>
              <ActivityIndicator color={c.mutedForeground} />
            </View>
          ) : messagesQ.isError && !messagesQ.data ? (
            <View style={styles.center}>
              <Text style={[styles.message, { color: c.foreground }]}>{t('chat.loadFailed')}</Text>
              <Text style={[styles.hint, { color: c.mutedForeground }]}>{messagesQ.error.message}</Text>
              <Button label={t('common.retry')} onPress={() => void messagesQ.refetch()} />
            </View>
          ) : rows.length === 0 ? (
            <Pressable style={styles.center} onPress={Keyboard.dismiss} accessible={false}>
              <RoomFace members={members} size={48} />
              <Text style={[styles.emptyName, { color: c.foreground }]}>{room.title}</Text>
              {room.goal ? <Text style={[styles.goal, { color: c.foreground }]}>{room.goal}</Text> : null}
              <Text style={[styles.hint, { color: c.mutedForeground }]}>
                {room.responders === 'mentions' ? t('room.emptyHintMentions') : t('room.emptyHint')}
              </Text>
              {hidden ? <Button label={t('room.showEarlier')} variant="ghost" onPress={showEarlier} /> : null}
            </Pressable>
          ) : (
            <FlatList
              ref={listRef}
              inverted
              data={rows}
              keyExtractor={(r) => r.key}
              renderItem={renderItem}
              keyboardDismissMode="interactive"
              keyboardShouldPersistTaps="handled"
              {...tapToDismiss}
              contentContainerStyle={styles.listContent}
              ItemSeparatorComponent={Gap}
              onEndReached={() => {
                if (hasOlder && !loadingOlder) void loadOlder();
              }}
              onEndReachedThreshold={0.5}
              ListFooterComponent={
                hidden ? (
                  <View style={styles.older}>
                    <Pressable
                      accessibilityRole="button"
                      onPress={showEarlier}
                      style={[styles.olderButton, { backgroundColor: c.muted }]}
                    >
                      <Text style={[styles.olderText, { color: c.foreground }]}>{t('room.showEarlier')}</Text>
                    </Pressable>
                  </View>
                ) : hasOlder ? (
                  <View style={styles.older}>
                    <Pressable
                      accessibilityRole="button"
                      disabled={loadingOlder}
                      onPress={() => void loadOlder()}
                      style={[
                        styles.olderButton,
                        { backgroundColor: c.muted, opacity: loadingOlder ? 0.6 : 1 },
                      ]}
                    >
                      {loadingOlder ? <ActivityIndicator size="small" color={c.mutedForeground} /> : null}
                      <Text style={[styles.olderText, { color: c.foreground }]}>{t('chat.loadOlder')}</Text>
                    </Pressable>
                  </View>
                ) : undefined
              }
            />
          )}
        </View>
        <Composer
          draftKey={room.id}
          placeholder={room.responders === 'mentions' ? t('room.placeholderMentions') : t('room.placeholder')}
          running={busy}
          onSend={send}
          onStop={stop}
          replyTo={replyTo}
          onReplyChange={setReplyTo}
        />
      </KeyboardAvoidingView>
      <Sheet open={menu} onClose={() => setMenu(false)} title={room.title} items={items} />
    </SafeAreaView>
  );
}

function Gap() {
  return <View style={styles.gap} />;
}

/** The name above a bot's turn in the room, when another spoke before it. */
function SpeakerLine({ bot }: { bot: Bot | undefined }) {
  const c = useColors();
  return (
    <View style={styles.speaker}>
      {bot ? (
        <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={22} />
      ) : (
        <View style={[styles.unknown, { backgroundColor: c.muted }]} />
      )}
      <Text style={[styles.speakerName, { color: bot?.color ?? c.foreground }]} numberOfLines={1}>
        {bot?.name ?? t('room.unknownBot')}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1 },
  header: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, height: 56 },
  pill: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
    gap: 8,
    height: 38,
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth * 2,
    paddingHorizontal: 8,
  },
  pillTitle: { fontSize: 17, fontWeight: '600', flexShrink: 1 },
  list: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  message: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  hint: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  goal: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  emptyName: { fontSize: 22, fontWeight: '600' },
  listContent: { paddingHorizontal: 12, paddingVertical: 12 },
  gap: { height: 16 },
  divider: { fontSize: 13, textAlign: 'center', paddingVertical: 8 },
  speaker: { flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: -8 },
  speakerName: { fontSize: 16, fontWeight: '600', flexShrink: 1 },
  unknown: { width: 22, height: 22, borderRadius: 11 },
  sending: { opacity: 0.7 },
  older: { alignItems: 'center', paddingBottom: 16 },
  olderButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
  },
  olderText: { fontSize: 16, fontWeight: '500' },
});
