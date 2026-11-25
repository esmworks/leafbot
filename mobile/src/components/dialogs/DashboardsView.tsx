import { INTL_LOCALE, type DashboardTileView } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Alert, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { ShownCard } from '@/components/message/ChatCard';
import { confirm, toastError } from '@/components/overlay';
import { back, Empty, IconButton, Loading, Page, Row } from '@/components/page';
import { locale, t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useBots, useDashboard, useDashboards } from '@/lib/queries';
import { useApi } from '@/lib/server';
import { useColors } from '@/lib/theme';

const when = new Intl.DateTimeFormat(INTL_LOCALE[locale], { dateStyle: 'short', timeStyle: 'short' });

/** The dashboards the person sees some of, most recently changed first. */
export function DashboardsView() {
  const { data: pages, refetch, isRefetching } = useDashboards();
  return (
    <Page title={t('dashboards.title')} scroll={false}>
      {!pages ? (
        <Loading />
      ) : !pages.length ? (
        <ScrollView contentContainerStyle={styles.content}>
          <Empty icon="layout" text={`${t('dashboards.emptyTitle')}\n\n${t('dashboards.empty')}`} />
        </ScrollView>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />}
        >
          {pages.map((p) => (
            <Row
              key={p.id}
              icon="layout"
              label={p.name}
              detail={t('dashboards.tiles', { count: p.tileCount })}
              onPress={() => nav.dashboard(p.id)}
            />
          ))}
        </ScrollView>
      )}
    </Page>
  );
}

/**
 * One dashboard, its tiles one under another. A tile from a table is worked out from its rows as
 * they stand each time the page reads, and it reads again whenever a bot writes a row.
 */
export function DashboardView({ id }: { id: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const { data: view, refetch, isRefetching, error } = useDashboard(id);
  const changed = () => {
    void qc.invalidateQueries({ queryKey: ['dashboards'] });
    void qc.invalidateQueries({ queryKey: ['dashboard'] });
  };
  const remove = useMutation({
    mutationFn: () => api.removeDashboard(id),
    onSuccess: () => {
      changed();
      back();
    },
    onError: toastError,
  });
  const askRemove = async () => {
    if (!view) return;
    const yes = await confirm({
      title: t('dashboards.removeTitle', { name: view.name }),
      message: t('dashboards.removeBody'),
      confirmLabel: t('common.delete'),
      destructive: true,
    });
    if (yes) remove.mutate();
  };
  return (
    <Page
      title={view?.name ?? t('dashboards.title')}
      scroll={false}
      right={
        view ? (
          <IconButton icon="trash-2" label={t('dashboards.remove')} onPress={() => void askRemove()} />
        ) : null
      }
    >
      {!view ? (
        error ? (
          <Empty icon="alert-triangle" text={error.message} />
        ) : (
          <Loading />
        )
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          refreshControl={<RefreshControl refreshing={isRefetching} onRefresh={() => void refetch()} />}
        >
          {!view.tiles.length ? <Empty text={t('dashboards.noTiles')} /> : null}
          {view.tiles.map((tile, i) => (
            <Tile
              key={tile.id}
              tile={tile}
              first={i === 0}
              last={i === view.tiles.length - 1}
              onChanged={changed}
            />
          ))}
        </ScrollView>
      )}
    </Page>
  );
}

function Tile({
  tile,
  first,
  last,
  onChanged,
}: {
  tile: DashboardTileView;
  first: boolean;
  last: boolean;
  onChanged: () => void;
}) {
  const c = useColors();
  const api = useApi();
  const { data: bots = [] } = useBots();
  const bot = bots.find((b) => b.id === tile.botId);
  const remove = useMutation({
    mutationFn: () => api.removeDashboardTile(tile.id),
    onSuccess: onChanged,
    onError: toastError,
  });
  const move = useMutation({
    mutationFn: (direction: 'earlier' | 'later') => api.moveDashboardTile(tile.id, direction),
    onSuccess: onChanged,
    onError: toastError,
  });
  const menu = () =>
    Alert.alert(tile.title, undefined, [
      ...(first ? [] : [{ text: t('dashboards.moveEarlier'), onPress: () => move.mutate('earlier') }]),
      ...(last ? [] : [{ text: t('dashboards.moveLater'), onPress: () => move.mutate('later') }]),
      { text: t('dashboards.removeTile'), style: 'destructive' as const, onPress: () => remove.mutate() },
      { text: t('common.cancel'), style: 'cancel' as const },
    ]);
  const source =
    tile.show === 'card'
      ? t('dashboards.written', { time: when.format(new Date(tile.updatedAt)) })
      : t('dashboards.live');
  return (
    <View
      accessibilityLabel={tile.title}
      style={[styles.tile, { borderColor: c.border, backgroundColor: c.card }]}
    >
      {tile.card ? (
        <ShownCard card={tile.card} />
      ) : (
        <View style={styles.problem}>
          <Text style={[styles.title, { color: c.foreground }]}>{tile.title}</Text>
          <View style={styles.problemLine}>
            <Feather name="alert-triangle" size={15} color={c.amber} />
            <Text style={[styles.problemText, { color: c.mutedForeground }]}>{tile.error}</Text>
          </View>
        </View>
      )}
      <View style={styles.footer}>
        {bot ? <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={16} /> : null}
        <Text style={[styles.footerText, { color: c.mutedForeground }]} numberOfLines={1}>
          {[bot?.name, source].filter(Boolean).join(' · ')}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={t('dashboards.tileMenu')}
          onPress={menu}
          hitSlop={8}
          style={({ pressed }) => [styles.more, pressed && { backgroundColor: c.accent }]}
        >
          <Feather name="more-horizontal" size={18} color={c.mutedForeground} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { padding: 16, gap: 12 },
  tile: { borderWidth: 1, borderRadius: 16, padding: 14, gap: 12 },
  problem: { gap: 6 },
  problemLine: { flexDirection: 'row', gap: 6, alignItems: 'flex-start' },
  problemText: { flex: 1, fontSize: 14, lineHeight: 19 },
  title: { fontSize: 15, fontWeight: '600' },
  footer: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  footerText: { flex: 1, fontSize: 12 },
  more: { padding: 4, borderRadius: 8 },
});
