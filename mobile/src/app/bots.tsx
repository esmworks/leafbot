import { useQueryClient } from '@tanstack/react-query';
import Feather from '@expo/vector-icons/Feather';
import { Redirect, router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { IconButton } from '@/components/page';
import { BottomBar } from '@/components/sidebar/BottomBar';
import { useSidebarMenus } from '@/components/sidebar/menus';
import { SidebarList } from '@/components/sidebar/SidebarList';
import { Button } from '@/components/ui';
import { t } from '@/i18n';
import { ApiError } from '@/lib/api';
import { ordered } from '@/lib/bots';
import { nav } from '@/lib/nav';
import { useBots, useGroups, useRooms, useSummaries } from '@/lib/queries';
import { setUnread, syncSeen, unreadBots, useSeen } from '@/lib/seen';
import { useOpenTappedNotice } from '@/lib/push';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/** The bot list, laid out as the web app's phone view lays out its sidebar. */
export default function Bots() {
  const { origin } = useServer();
  const api = useApi();
  const c = useColors();
  const queryClient = useQueryClient();
  const bots = useBots();
  const groups = useGroups();
  const rooms = useRooms();
  const summaries = useSummaries();
  const seen = useSeen(origin!);
  const list = useMemo(() => ordered(bots.data ?? []), [bots.data]);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const signedOut = bots.error instanceof ApiError && bots.error.status === 401;
  useOpenTappedNotice(rooms.data, !rooms.isPending);

  useEffect(() => {
    if (signedOut) void queryClient.resetQueries({ queryKey: ['session', origin] });
  }, [signedOut, queryClient, origin]);

  useEffect(() => {
    if (summaries.data && seen !== undefined) syncSeen(origin!, summaries.data);
  }, [summaries.data, seen, origin]);

  useEffect(() => {
    if (summaries.data && seen !== undefined) setUnread(origin!, unreadBots(summaries.data, seen));
  }, [summaries.data, seen, origin]);

  const logout = async () => {
    if (leaving) return;
    setLeaving(true);
    try {
      await api.logout();
    } catch {
      // Signed out here even if the server did not hear it; its session ends on its own.
    }
    await queryClient.resetQueries();
    setLeaving(false);
    router.replace('/login');
  };

  const menus = useSidebarMenus({
    bots: list,
    summaries: summaries.data ?? [],
    groups: groups.data ?? [],
    logout: () => void logout(),
  });

  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([bots.refetch(), groups.refetch(), rooms.refetch(), summaries.refetch()]);
    setRefreshing(false);
  };

  const closeSearch = () => {
    setQuery('');
    setSearching(false);
  };

  if (signedOut) return <Redirect href="/login" />;

  return (
    <SafeAreaView style={[styles.screen, { backgroundColor: c.sidebar }]} edges={['top', 'left', 'right']}>
      <View style={styles.header}>
        {searching ? (
          <View style={styles.searchBox}>
            <Feather name="search" size={20} color={c.mutedForeground} style={styles.searchIcon} />
            <TextInput
              autoFocus
              value={query}
              onChangeText={setQuery}
              placeholder={t('sidebar.searchPlaceholder')}
              placeholderTextColor={c.mutedForeground}
              returnKeyType="search"
              onSubmitEditing={() => query.trim().length >= 2 && nav.search(query.trim())}
              style={[styles.searchInput, { backgroundColor: c.muted, color: c.foreground }]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t('sidebar.closeSearch')}
              onPress={closeSearch}
              hitSlop={8}
              style={styles.searchClose}
            >
              <Feather name="x" size={20} color={c.mutedForeground} />
            </Pressable>
          </View>
        ) : (
          <>
            <Pressable style={styles.titleBox} onLongPress={menus.openSidebar} delayLongPress={350}>
              <Text style={[styles.title, { color: c.foreground }]} accessibilityRole="header">
                Leaf Bot
              </Text>
            </Pressable>
            <RoundButton icon="search" label={t('sidebar.search')} onPress={() => setSearching(true)} />
            <RoundButton icon="plus" label={t('sidebar.newBot')} onPress={() => nav.botEdit()} />
          </>
        )}
      </View>
      {bots.isPending ? (
        <View style={styles.center}>
          <ActivityIndicator color={c.mutedForeground} />
        </View>
      ) : bots.isError ? (
        <View style={styles.center}>
          <Text style={[styles.message, { color: c.foreground }]}>{t('bots.loadFailed')}</Text>
          <Text style={[styles.detail, { color: c.mutedForeground }]}>{bots.error.message}</Text>
          <Button label={t('common.retry')} busy={bots.isFetching} onPress={() => void bots.refetch()} />
        </View>
      ) : (
        <ScrollView
          style={styles.fill}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void refresh()} />}
        >
          <SidebarList
            bots={list}
            groups={groups.data ?? []}
            rooms={rooms.data ?? []}
            summaries={summaries.data ?? []}
            seen={seen}
            query={query}
            menus={menus}
          />
          {/* A long press on the empty space under the list opens the menu for the whole list. */}
          <Pressable style={styles.filler} onLongPress={menus.openSidebar} delayLongPress={350} />
        </ScrollView>
      )}
      <BottomBar />
      {menus.sheet}
    </SafeAreaView>
  );
}

function RoundButton({
  icon,
  label,
  onPress,
}: {
  icon: 'search' | 'plus';
  label: string;
  onPress: () => void;
}) {
  return <IconButton icon={icon} label={label} onPress={onPress} filled />;
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  fill: { flex: 1 },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingLeft: 16,
    paddingRight: 8,
    height: 56,
  },
  titleBox: { flex: 1, justifyContent: 'center', minHeight: 40 },
  title: { fontSize: 22, fontWeight: '600' },
  searchBox: { flex: 1, justifyContent: 'center', marginRight: 8 },
  searchIcon: { position: 'absolute', left: 14, zIndex: 1 },
  searchInput: { height: 40, borderRadius: 20, paddingLeft: 40, paddingRight: 40, fontSize: 17 },
  searchClose: { position: 'absolute', right: 12, height: 40, justifyContent: 'center' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  message: { fontSize: 17, fontWeight: '600', textAlign: 'center' },
  detail: { fontSize: 16, lineHeight: 22, textAlign: 'center' },
  content: { flexGrow: 1, paddingHorizontal: 8, paddingBottom: 16 },
  filler: { flexGrow: 1, minHeight: 80 },
});
