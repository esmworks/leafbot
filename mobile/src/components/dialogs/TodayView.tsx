import type { TodayReport } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useEffect, type ReactNode } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { Item, ItemCard } from '@/components/dialogs/Item';
import {
  CanarySection,
  PromisesSection,
  RoutineSuggestionsSection,
  SkillSuggestionsSection,
  SecondYesSection,
} from '@/components/dialogs/TodaySections';
import { Loading, Page } from '@/components/page';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { nav } from '@/lib/nav';
import { useBots, useSummaries, useToday } from '@/lib/queries';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);
const usd = new Intl.NumberFormat(locale === 'tr' ? 'tr-TR' : 'en-US', {
  style: 'currency',
  currency: 'USD',
});

/**
 * Today at a glance: what waits for the person, what each bot did and what the routines ran,
 * each a tap away from its conversation.
 */
export function TodayView() {
  const c = useColors();
  const { data, refetch, isRefetching } = useToday();
  const { data: summaries = [] } = useSummaries();
  const { data: bots = [] } = useBots();
  // A report left in the cache from earlier is stale; ask again each time the page opens.
  useEffect(() => {
    void refetch();
  }, [refetch]);
  const byId = new Map(bots.map((b) => [b.id, b]));
  const waiting = summaries.filter((s) => s.waiting);
  const avatar = (botId: string) => {
    const b = byId.get(botId);
    return b ? (
      <Avatar name={b.name} color={b.color} avatar={b.avatar} size={28} />
    ) : (
      <View style={styles.blank} />
    );
  };
  return (
    <Page title={t('today.title')} scroll={false}>
      {!data ? (
        <Loading />
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />}
        >
          <Text style={[styles.summary, { color: c.mutedForeground }]}>
            {t('today.summary', {
              turns: data.bots.reduce((n, b) => n + b.turns, 0),
              runs: data.runs.length,
              cost: usd.format(data.costUsd),
            })}
          </Text>
          {/* A bot caught steered by text it read stays here until the person has seen it. */}
          <CanarySection alarms={data.canaryAlarms ?? []} />
          {/* Steps that need this person's second yes, then what was promised, then routine offers. */}
          <SecondYesSection />
          <PromisesSection />
          <RoutineSuggestionsSection />
          <SkillSuggestionsSection />
          <Block
            title={t('today.waiting')}
            empty={t('today.waitingNone')}
            count={
              waiting.length +
              (data.staleMemory ? 1 : 0) +
              (data.pendingMemory ? 1 : 0) +
              (data.expiredMemory ? 1 : 0)
            }
          >
            {[
              ...waiting.map((s) => (
                <Item key={s.botId} onPress={() => nav.chat(s.botId, { threadId: s.waiting!.threadId })}>
                  {avatar(s.botId)}
                  <Text style={[styles.grow, { color: c.mutedForeground }]} numberOfLines={1}>
                    <Text style={[styles.name, { color: c.foreground }]}>{byId.get(s.botId)?.name}</Text>{' '}
                    {s.waiting!.summary}
                  </Text>
                  <Text style={[styles.note, { color: c.amber }]}>
                    {t(`sidebar.waitingFor.${s.waiting!.kind}`)}
                  </Text>
                </Item>
              )),
              // Memory changes asked for while nobody watched wait for the person's yes.
              ...(data.pendingMemory
                ? [
                    <Item key="pending-memory" onPress={() => nav.settings('memory')}>
                      <Feather name="check-square" size={24} color={c.mutedForeground} />
                      <Text style={[styles.grow, { color: c.foreground }]} numberOfLines={1}>
                        {t('today.pendingMemory', { count: data.pendingMemory })}
                      </Text>
                      <Text style={[styles.note, { color: c.amber }]}>{t('today.pendingMemoryReview')}</Text>
                    </Item>,
                  ]
                : []),
              // Notes past their "true until" date wait in the memory screen too.
              ...(data.expiredMemory
                ? [
                    <Item key="expired-memory" onPress={() => nav.settings('memory')}>
                      <Feather name="clock" size={24} color={c.mutedForeground} />
                      <Text style={[styles.grow, { color: c.foreground }]} numberOfLines={1}>
                        {t('today.expiredMemory', { count: data.expiredMemory })}
                      </Text>
                      <Text style={[styles.note, { color: c.amber }]}>{t('today.staleMemoryReview')}</Text>
                    </Item>,
                  ]
                : []),
              // Notes no bot uses wait for the person to keep or delete them in the memory screen.
              // One list with the bots' lines, so the card draws a divider between each.
              ...(data.staleMemory
                ? [
                    <Item key="stale-memory" onPress={() => nav.settings('memory')}>
                      <Feather name="archive" size={24} color={c.mutedForeground} />
                      <Text style={[styles.grow, { color: c.foreground }]} numberOfLines={1}>
                        {t('today.staleMemory', { count: data.staleMemory })}
                      </Text>
                      <Text style={[styles.note, { color: c.amber }]}>{t('today.staleMemoryReview')}</Text>
                    </Item>,
                  ]
                : []),
            ]}
          </Block>
          <Block title={t('today.bots')} empty={t('today.botsNone')} count={data.bots.length}>
            {data.bots.map((b) => (
              <Item key={b.botId} onPress={() => nav.chat(b.botId)}>
                {avatar(b.botId)}
                <Text style={[styles.grow, styles.name, { color: c.foreground }]} numberOfLines={1}>
                  {b.name}
                </Text>
                {b.failed > 0 ? (
                  <Text style={[styles.note, { color: c.destructive }]}>
                    {t('today.failed', { count: b.failed })}
                  </Text>
                ) : null}
                <Text style={[styles.note, { color: c.mutedForeground }]}>
                  {t('usage.turnCount', { count: b.turns })}
                </Text>
              </Item>
            ))}
          </Block>
          <Block title={t('today.runs')} empty={t('today.runsNone')} count={data.runs.length}>
            {data.runs.map((r) => (
              <Item
                key={`${r.routineId}:${r.startedAt}`}
                onPress={() => nav.chat(r.botId, { threadId: r.threadId ?? undefined })}
              >
                <RunIcon status={r.status} />
                <Text style={[styles.grow, { color: c.mutedForeground }]} numberOfLines={1}>
                  <Text style={[styles.name, { color: c.foreground }]}>{r.name}</Text>{' '}
                  {byId.get(r.botId)?.name}
                </Text>
                <Text style={[styles.note, { color: c.mutedForeground }]}>{fmt.shortTime(r.startedAt)}</Text>
              </Item>
            ))}
          </Block>
        </ScrollView>
      )}
    </Page>
  );
}

function Block({
  title,
  empty,
  count,
  children,
}: {
  title: string;
  empty: string;
  count: number;
  children: ReactNode[];
}) {
  const c = useColors();
  return (
    <View style={styles.block}>
      <Text style={[styles.title, { color: c.mutedForeground }]}>{title}</Text>
      {count ? (
        <ItemCard>{children}</ItemCard>
      ) : (
        <Text style={[styles.empty, { color: c.mutedForeground }]}>{empty}</Text>
      )}
    </View>
  );
}

function RunIcon({ status }: { status: TodayReport['runs'][number]['status'] }) {
  const c = useColors();
  if (status === 'done') return <Feather name="check-circle" size={24} color={c.success} />;
  if (status === 'error') return <Feather name="alert-circle" size={24} color={c.destructive} />;
  return <Feather name="clock" size={24} color={c.mutedForeground} />;
}

const styles = StyleSheet.create({
  content: { padding: 16, paddingBottom: 40, gap: 20 },
  summary: { fontSize: 16, lineHeight: 22, paddingHorizontal: 4 },
  block: { gap: 6 },
  title: { fontSize: 15, fontWeight: '500', paddingHorizontal: 4 },
  empty: { fontSize: 16, paddingHorizontal: 4 },
  grow: { flex: 1, fontSize: 16 },
  name: { fontWeight: '500' },
  note: { fontSize: 13 },
  blank: { width: 28, height: 28 },
});
