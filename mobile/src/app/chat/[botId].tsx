import type { Bot, Thread } from '@leafbot/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WaitingElsewhere } from '@/components/chat/Bars';
import { ChatHeader } from '@/components/chat/Header';
import { Conversation } from '@/components/chat/Conversation';
import { useThreadActions, useWaitingCards } from '@/components/chat/threads';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api';
import { nav } from '@/lib/nav';
import { useViewingThread } from '@/lib/push';
import { useBots, useMainThread, useSummaries, useThreads } from '@/lib/queries';
import { useSeen, markSeen } from '@/lib/seen';
import { useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** A bot's conversation: its main one, or the one the route names. */
export default function Chat() {
  const {
    botId,
    threadId: threadParam,
    focus,
    find,
  } = useLocalSearchParams<{
    botId: string;
    threadId?: string;
    focus?: string;
    find?: string;
  }>();
  const { origin } = useServer();
  const c = useColors();
  const qc = useQueryClient();
  const bots = useBots();
  const bot = bots.data?.find((b) => b.id === botId);
  const main = useMainThread(botId);
  const threadsQ = useThreads(botId);
  const threads = threadsQ.data ?? [];
  const mainId = main.data?.id;
  const threadId = threadParam || mainId;
  const thread = threads.find((th) => th.id === threadId) ?? (mainId === threadId ? main.data : undefined);
  const waiting = useWaitingCards(botId);
  const summaries = useSummaries();
  const repliedAt = summaries.data?.find((s) => s.botId === botId)?.repliedAt;
  const signedOut = [bots.error, main.error, threadsQ.error].some(
    (e) => e instanceof ApiError && e.status === 401,
  );

  useEffect(() => {
    if (signedOut) void qc.invalidateQueries({ queryKey: ['session', origin] });
  }, [signedOut, qc, origin]);

  // A conversation named by a link or remembered from before that is gone since, or an exchange
  // between bots (read where the work began): the main one.
  useEffect(() => {
    // Not while the list is being refreshed: it may be about to list a conversation just made.
    if (!threadParam || !threadsQ.data || threadsQ.isFetching || !mainId || threadParam === mainId) return;
    if (!threadsQ.data.some((th) => th.id === threadParam && th.kind !== 'bot')) nav.replaceChat(botId);
  }, [threadParam, threadsQ.data, threadsQ.isFetching, mainId, botId]);

  // What the person had read of this bot when its chat opened: the line above the first reply
  // after it marks where the new ones start. Taken once, before opening marks them read.
  const seen = useSeen(origin!);
  const loaded = seen !== undefined;
  const [readUntil, setReadUntil] = useState<string | null | undefined>(undefined);
  if (loaded && readUntil === undefined) setReadUntil(seen?.[botId] ?? null);
  useEffect(() => {
    // Replies that arrive while the conversation is open count as read.
    if (loaded && repliedAt) markSeen(origin!, botId, repliedAt);
  }, [loaded, repliedAt, origin, botId]);

  const retry = () => {
    void bots.refetch();
    void main.refetch();
  };
  if (!bot || !threadId) {
    const failed = bots.isError || main.isError || (bots.isSuccess && !bot);
    return <Starting c={c} bot={bot} failed={failed} onRetry={retry} />;
  }

  return <Loaded {...{ bot, thread, threads, mainId, waiting, threadId, readUntil, focus, find }} />;
}

function Loaded({
  bot,
  thread,
  threads,
  mainId,
  waiting,
  threadId,
  readUntil,
  focus,
  find,
}: {
  bot: Bot;
  thread: Thread | undefined;
  threads: Thread[];
  mainId: string | undefined;
  waiting: Map<string, number>;
  threadId: string;
  readUntil: string | null | undefined;
  focus: string | undefined;
  find: string | undefined;
}) {
  const c = useColors();
  const actions = useThreadActions(bot);
  useViewingThread(threadId);
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top', 'left', 'right']}>
      <ChatHeader
        bot={bot}
        thread={thread}
        threads={threads}
        mainId={mainId}
        waiting={waiting}
        actions={actions}
      />
      <KeyboardAvoidingView style={styles.body} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <Conversation
          key={threadId}
          bot={bot}
          threadId={threadId}
          thread={thread}
          readUntil={readUntil}
          focus={focus}
          find={find}
          actions={actions}
          elsewhere={
            <WaitingElsewhere
              bot={bot}
              threadId={threadId}
              threads={threads}
              waiting={waiting}
              mainId={mainId}
            />
          }
        />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

/** The header alone, while the bot and its main conversation are being fetched, or why not. */
function Starting({
  c,
  bot,
  failed,
  onRetry,
}: {
  c: ReturnType<typeof useColors>;
  bot: Bot | undefined;
  failed: boolean;
  onRetry: () => void;
}) {
  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.background }]} edges={['top', 'left', 'right']}>
      <ChatHeader
        bot={bot}
        thread={undefined}
        threads={[]}
        mainId={undefined}
        waiting={new Map()}
        actions={undefined}
      />
      <View style={styles.center}>
        {failed ? (
          <>
            <Text style={[styles.message, { color: c.foreground }]}>{t('chat.loadFailed')}</Text>
            <Button label={t('common.retry')} onPress={onRetry} />
          </>
        ) : (
          <ActivityIndicator color={c.mutedForeground} />
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  body: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  message: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
});
