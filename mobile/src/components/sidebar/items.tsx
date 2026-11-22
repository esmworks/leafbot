import type { Bot, BotSummary, Room } from '@leafbot/shared';
import { botState } from '@leafbot/app/src/lib/activity';
import Feather from '@expo/vector-icons/Feather';
import * as Haptics from 'expo-haptics';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { RoomFace, useMembers } from '@/components/rooms/RoomFace';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { useLiveState } from '@/lib/realtime';
import { isUnread, type Seen } from '@/lib/seen';
import { useColors } from '@/lib/theme';

const fmt = formatters(locale, t);

/** A long press says it took hold with a tick, as the phone's own lists do. */
export function tick() {
  void Haptics.selectionAsync().catch(() => undefined);
}

/** A dot for a bot that wrote since the person last looked at its chat on this phone. */
export function UnreadDot({ style }: { style?: object }) {
  const c = useColors();
  return (
    <View
      accessibilityRole="image"
      accessibilityLabel={t('sidebar.unread')}
      style={[styles.dot, { backgroundColor: c.unread }, style]}
    />
  );
}

/** What a bot is doing, drawn on the corner of its avatar: approvals, a failed routine, or running. */
function StateBadge({ summary }: { summary?: BotSummary }) {
  const c = useColors();
  const live = useLiveState(summary?.threadId ?? undefined);
  const state = botState(live, summary?.state);
  if (summary?.pendingApprovals) {
    return (
      <View style={[styles.badge, { backgroundColor: c.amber, borderColor: c.sidebar }]}>
        <Text style={styles.badgeText}>{summary.pendingApprovals}</Text>
      </View>
    );
  }
  if (state === 'idle') {
    if (!summary?.failedRoutine) return null;
    return (
      <View
        accessibilityRole="image"
        accessibilityLabel={t('sidebar.routineFailed', { name: summary.failedRoutine })}
        style={[styles.badge, { backgroundColor: c.destructive, borderColor: c.sidebar }]}
      >
        <Text style={[styles.badgeText, { color: '#FFFFFF' }]}>!</Text>
      </View>
    );
  }
  return <View style={[styles.running, { backgroundColor: c.success, borderColor: c.sidebar }]} />;
}

function AvatarWithBadges({
  bot,
  summary,
  size,
  unread,
}: {
  bot: Bot;
  summary?: BotSummary;
  size: number;
  unread?: boolean;
}) {
  const c = useColors();
  return (
    <View>
      <Avatar name={bot.name} color={bot.color} avatar={bot.avatar} size={size} seed={bot.id} motion="busy" />
      {unread ? <UnreadDot style={[styles.unreadCorner, { borderColor: c.sidebar }]} /> : null}
      {bot.isManager ? (
        <View style={[styles.manager, { backgroundColor: c.background, borderColor: c.border }]}>
          <Feather name="shield" size={11} color={bot.color} />
        </View>
      ) : null}
      <StateBadge summary={summary} />
    </View>
  );
}

/** A pinned bot: a large avatar with the name below. */
export function PinnedTile({
  bot,
  summary,
  unread,
  onOpen,
  onMenu,
}: {
  bot: Bot;
  summary?: BotSummary;
  unread: boolean;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const c = useColors();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={bot.name}
      onPress={onOpen}
      onLongPress={() => (tick(), onMenu())}
      delayLongPress={350}
      style={({ pressed }) => [styles.tile, pressed && { backgroundColor: c.accent }]}
    >
      <AvatarWithBadges bot={bot} summary={summary} size={80} unread={unread} />
      <Text style={[styles.tileName, { color: c.foreground }]} numberOfLines={1}>
        {bot.name}
      </Text>
    </Pressable>
  );
}

export function BotRow({
  bot,
  summary,
  seen,
  muted,
  onOpen,
  onMenu,
}: {
  bot: Bot;
  summary?: BotSummary;
  seen: Seen | null | undefined;
  muted: boolean;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const c = useColors();
  const unread = !!summary && isUnread(summary, seen);
  const waiting = summary?.waiting;
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onOpen}
      onLongPress={() => (tick(), onMenu())}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.accent }]}
    >
      <AvatarWithBadges bot={bot} summary={summary} size={48} />
      <View style={styles.rowText}>
        <View style={styles.line}>
          <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
            {bot.name}
          </Text>
          {muted ? (
            <Feather
              name="bell-off"
              size={15}
              color={c.mutedForeground}
              accessibilityLabel={t('sidebar.muted')}
            />
          ) : null}
          {summary?.previewAt ? (
            <Text
              style={[
                styles.time,
                { color: unread ? c.foreground : c.mutedForeground },
                unread && styles.bold,
              ]}
            >
              {fmt.shortTime(summary.previewAt)}
            </Text>
          ) : null}
        </View>
        {waiting ? (
          <Text style={styles.preview} numberOfLines={1}>
            <Text style={{ color: c.amber, fontWeight: '500' }}>
              {t(`sidebar.waitingFor.${waiting.kind}`)}{' '}
            </Text>
            <Text style={{ color: c.mutedForeground }}>{waiting.summary}</Text>
          </Text>
        ) : (
          <View style={styles.line}>
            <Text
              style={[
                styles.preview,
                styles.grow,
                { color: unread ? c.foreground : c.mutedForeground },
                unread && styles.medium,
              ]}
              numberOfLines={1}
            >
              {summary?.preview ?? (bot.description || t('sidebar.noMessages'))}
            </Text>
            {unread ? <UnreadDot /> : null}
          </View>
        )}
      </View>
    </Pressable>
  );
}

export function RoomRow({
  room,
  memberCount,
  onOpen,
}: {
  room: Room;
  memberCount: number;
  onOpen: () => void;
}) {
  const c = useColors();
  const members = useMembers(room);
  const live = useLiveState(room.id);
  const busy = (live ?? room.state) !== 'idle';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onOpen}
      style={({ pressed }) => [styles.row, pressed && { backgroundColor: c.accent }]}
    >
      <View style={styles.roomFace}>
        <RoomFace members={members} size={30} />
        {busy ? (
          <View style={[styles.running, { backgroundColor: c.success, borderColor: c.sidebar }]} />
        ) : null}
      </View>
      <View style={styles.rowText}>
        <View style={styles.line}>
          <Text style={[styles.name, { color: c.foreground }]} numberOfLines={1}>
            {room.title}
          </Text>
          <Text style={[styles.time, { color: c.mutedForeground }]}>{fmt.shortTime(room.updatedAt)}</Text>
        </View>
        <Text style={[styles.preview, { color: c.mutedForeground }]} numberOfLines={1}>
          {room.preview ?? t('rooms.members', { count: memberCount })}
        </Text>
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 68,
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 16,
  },
  rowText: { flex: 1, minWidth: 0 },
  line: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  grow: { flex: 1 },
  name: { flex: 1, fontSize: 17, lineHeight: 22, fontWeight: '600' },
  time: { fontSize: 13 },
  bold: { fontWeight: '600' },
  medium: { fontWeight: '500' },
  preview: { fontSize: 16, lineHeight: 22 },
  dot: { width: 10, height: 10, borderRadius: 5 },
  unreadCorner: {
    position: 'absolute',
    top: -2,
    left: -2,
    borderWidth: 2,
    width: 14,
    height: 14,
    borderRadius: 7,
  },
  badge: {
    position: 'absolute',
    right: -3,
    bottom: -3,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 3,
    borderRadius: 9,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 10, fontWeight: '700', color: '#000000' },
  running: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 13,
    height: 13,
    borderRadius: 7,
    borderWidth: 2,
  },
  manager: {
    position: 'absolute',
    top: -4,
    right: -4,
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tile: {
    width: 104,
    alignItems: 'center',
    gap: 6,
    borderRadius: 16,
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  tileName: { width: '100%', fontSize: 15, fontWeight: '500', textAlign: 'center' },
  roomFace: { width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
});
