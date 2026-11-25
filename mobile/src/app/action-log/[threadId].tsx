import type { TurnLogEntry } from '@leafbot/shared';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { UndoTurnSheet } from '@/components/message/UndoTurn';
import { Empty, Loading, Page, PillButton } from '@/components/page';
import { locale, t, type MessageKey } from '@/i18n';
import { formatters } from '@/lib/format';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/** A list of lines under a small heading, in the colour of what can still be done about them. */
function Lines({ title, tone, lines }: { title: string; tone: 'can' | 'done' | 'cannot'; lines: string[] }) {
  const c = useColors();
  if (!lines.length) return null;
  return (
    <View style={styles.lines}>
      <Text style={[styles.heading, { color: tone === 'cannot' ? c.amber : c.mutedForeground }]}>
        {title}
      </Text>
      {lines.map((l, i) => (
        <Text
          key={i}
          style={[
            styles.line,
            { color: tone === 'done' ? c.mutedForeground : c.foreground },
            tone === 'done' && styles.struck,
          ]}
        >
          {l}
        </Text>
      ))}
    </View>
  );
}

/** One turn: what was asked, what it changed, and what of that can still be taken back. */
function Entry({ e, onUndo }: { e: TurnLogEntry; onUndo: () => void }) {
  const c = useColors();
  const name = (i: TurnLogEntry['items'][number]) => `${t(`undo.kind.${i.kind}` as MessageKey)}: ${i.label}`;
  const can = e.items.filter((i) => !i.reason && !i.outcome).map(name);
  const done = e.items.flatMap((i) =>
    i.outcome ? [`${name(i)} (${t(`actionLog.outcome.${i.outcome}` as MessageKey)})`] : [],
  );
  const cannot = [
    ...e.items.filter((i) => i.reason && !i.outcome).map(name),
    ...e.outside.map((o) => o.summary),
  ];
  return (
    <View style={[styles.entry, { backgroundColor: c.card, borderColor: c.border }]}>
      <Text style={[styles.when, { color: c.mutedForeground }]}>{fmt.dayLabel(e.at)}</Text>
      <Text style={[styles.request, { color: c.foreground }]} numberOfLines={3}>
        {e.request}
      </Text>
      <Lines title={t('actionLog.can')} tone="can" lines={can} />
      <Lines title={t('actionLog.done')} tone="done" lines={done} />
      <Lines title={t('actionLog.cannot')} tone="cannot" lines={cannot} />
      {can.length > 0 && !e.running ? (
        <View style={styles.undo}>
          <PillButton icon="rotate-ccw" label={t('actionLog.undo')} onPress={onUndo} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * The action log of a conversation: the person's turns that changed or sent something, newest
 * first, each saying what can still be taken back, what was, and what no one can take back (a mail
 * that went, a call to another service). Taking a turn back opens the usual sheet.
 */
export default function Screen() {
  const { threadId } = useLocalSearchParams<{ threadId: string }>();
  const c = useColors();
  const api = useApi();
  const { origin } = useServer();
  const [undoing, setUndoing] = useState<string | null>(null);
  // Under the conversation's turn-changes key, so a turn finishing or taken back refreshes it.
  const { data = [], isPending } = useQuery({
    queryKey: ['turn-changes', origin, threadId, 'log'],
    queryFn: () => api.actionLog(threadId),
  });
  return (
    <Page title={t('actionLog.title')}>
      <Text style={[styles.intro, { color: c.mutedForeground }]}>{t('actionLog.intro')}</Text>
      {isPending ? <Loading /> : null}
      {!isPending && !data.length ? <Empty icon="list" text={t('actionLog.empty')} /> : null}
      {data.map((e) => (
        <Entry key={e.turnId} e={e} onUndo={() => setUndoing(e.turnId)} />
      ))}
      {undoing ? (
        <UndoTurnSheet turnId={undoing} threadId={threadId} open onClose={() => setUndoing(null)} />
      ) : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  intro: { fontSize: 15, lineHeight: 20 },
  entry: { borderWidth: StyleSheet.hairlineWidth, borderRadius: 16, padding: 16, gap: 10 },
  when: { fontSize: 14 },
  request: { fontSize: 16, fontWeight: '500', lineHeight: 22 },
  lines: { gap: 3 },
  heading: { fontSize: 14, fontWeight: '600' },
  line: { fontSize: 16, lineHeight: 22 },
  struck: { textDecorationLine: 'line-through' },
  undo: { flexDirection: 'row', justifyContent: 'flex-end' },
});
