import { snoozeTimes, useMinuteClock } from '@leafbot/app/src/lib/snooze';
import type { Bot, Thread } from '@leafbot/shared';
import Feather from '@expo/vector-icons/Feather';
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar } from '@/components/Avatar';
import { IconButton, Sheet, back, type IconName, type SheetItem } from '@/components/page';
import { locale, t } from '@/i18n';
import { formatters } from '@/lib/format';
import { nav } from '@/lib/nav';
import { useInfo } from '@/lib/queries';
import { useColors } from '@/lib/theme';
import { THREAD_ICONS } from './text';
import type { ThreadActions } from './threads';

const fmt = formatters(locale, t);

/** Back, the bot's name with its conversation menu, and the buttons for its computer and panel. */
export function ChatHeader({
  bot,
  thread,
  threads,
  mainId,
  waiting,
  actions,
}: {
  bot: Bot | undefined;
  thread: Thread | undefined;
  threads: Thread[];
  mainId: string | undefined;
  waiting: Map<string, number>;
  actions: ThreadActions | undefined;
}) {
  const c = useColors();
  const info = useInfo().data;
  const hasComputer = info?.computer.status === 'ok' || info?.browser.status === 'ok';
  const [menu, setMenu] = useState<'main' | 'snooze' | 'icon' | null>(null);
  const title = thread && thread.id !== mainId && actions ? actions.name(thread) : null;

  return (
    <View style={styles.header}>
      <View style={styles.left}>
        <IconButton icon="chevron-left" size={24} label={t('chat.back')} onPress={back} />
      </View>
      {bot ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={bot.name}
          onPress={() => setMenu('main')}
          style={({ pressed }) => [
            styles.pill,
            { borderColor: c.border, backgroundColor: pressed ? c.accent : c.background },
          ]}
        >
          <Avatar
            name={bot.name}
            color={bot.color}
            avatar={bot.avatar}
            size={32}
            seed={bot.id}
            motion="always"
          />
          <Text style={[styles.pillName, { color: c.foreground }]} numberOfLines={1}>
            {bot.name}
          </Text>
          {title ? (
            <Text style={[styles.pillTitle, { color: c.mutedForeground }]} numberOfLines={1}>
              · {thread?.icon ? `${thread.icon} ` : ''}
              {title}
            </Text>
          ) : null}
          <Feather name="chevron-down" size={20} color={c.mutedForeground} />
        </Pressable>
      ) : (
        <View />
      )}
      <View style={styles.right}>
        {bot && hasComputer ? (
          <IconButton icon="monitor" label={t('computer.browserOpen')} onPress={() => nav.computer(bot.id)} />
        ) : null}
        {bot ? (
          <IconButton icon="sidebar" label={t('chat.openPanel')} onPress={() => nav.panel(bot.id)} />
        ) : null}
      </View>
      {bot && actions ? (
        <ThreadMenu
          open={menu}
          onClose={() => setMenu(null)}
          onOpen={setMenu}
          thread={thread}
          threads={threads}
          mainId={mainId}
          waiting={waiting}
          actions={actions}
        />
      ) : null}
    </View>
  );
}

function ThreadMenu({
  open,
  onClose,
  onOpen,
  thread,
  threads,
  mainId,
  waiting,
  actions,
}: {
  open: 'main' | 'snooze' | 'icon' | null;
  onClose: () => void;
  onOpen: (m: 'main' | 'snooze' | 'icon') => void;
  thread: Thread | undefined;
  threads: Thread[];
  mainId: string | undefined;
  waiting: Map<string, number>;
  actions: ThreadActions;
}) {
  const c = useColors();
  const now = useMinuteClock();
  const snoozed = !!thread?.snoozedUntil && new Date(thread.snoozedUntil).getTime() > now;

  // Archived and snoozed conversations are listed apart, unless a card waits in one.
  const snoozedNow = (th: Thread) => !!th.snoozedUntil && new Date(th.snoozedUntil).getTime() > now;
  const away = (th: Thread) => !waiting.has(th.id) && (!!th.archivedAt || snoozedNow(th));
  const listed = threads.filter((th) => !away(th));
  const groups: { label: string; items: Thread[]; icon?: IconName }[] = [
    { label: t('chat.threads'), items: listed.filter((th) => th.kind === 'user') },
    { label: t('chat.teamThreads'), items: listed.filter((th) => th.kind === 'team'), icon: 'users' },
    // A routine's reports reach the main conversation; its own is listed only while it needs the
    // person (a card waiting) or they pinned it.
    {
      label: t('chat.routineThreads'),
      items: listed.filter((th) => th.kind === 'routine' && (waiting.has(th.id) || !!th.pinnedAt)),
      icon: 'clock',
    },
    { label: t('chat.apiThreads'), items: listed.filter((th) => th.kind === 'api'), icon: 'globe' },
    {
      label: t('chat.snoozedThreads'),
      items: threads.filter((th) => !th.archivedAt && away(th)),
      icon: 'bell-off',
    },
    {
      label: t('chat.archivedThreads'),
      items: threads.filter((th) => th.archivedAt && away(th)),
      icon: 'archive',
    },
  ];

  const items: SheetItem[] = [{ icon: 'plus-square', label: t('chat.newThread'), onPress: actions.create }];
  if (thread) {
    items.push(
      {
        icon: 'download',
        label: t('export.action'),
        onPress: () => void actions.exportConversation(thread.id),
      },
      { icon: 'link', label: t('chat.copyLink'), onPress: () => void actions.copyLink(thread) },
      { icon: 'edit-2', label: t('chat.renameThread'), onPress: () => void actions.rename(thread) },
      { icon: 'rotate-ccw', label: t('chat.resetThread'), onPress: () => void actions.reset(thread) },
      { icon: 'smile', label: t('chat.threadIcon'), onPress: () => onOpen('icon') },
      {
        icon: 'bookmark',
        label: thread.pinnedAt ? t('chat.unpinThread') : t('chat.pinThread'),
        onPress: () => void actions.patch(thread, { pinned: !thread.pinnedAt }),
      },
      snoozed
        ? {
            icon: 'bell',
            label: t('chat.unsnoozeThread'),
            onPress: () => void actions.patch(thread, { snoozedUntil: null }),
          }
        : { icon: 'bell-off', label: t('chat.snoozeThread'), onPress: () => onOpen('snooze') },
      {
        icon: 'archive',
        label: thread.archivedAt ? t('chat.unarchiveThread') : t('chat.archiveThread'),
        onPress: () => void actions.archive(thread, !thread.archivedAt),
      },
      {
        icon: 'trash-2',
        label: t('chat.deleteThread'),
        destructive: true,
        onPress: () => void actions.remove(thread),
      },
    );
  }

  const pick = (id: string) => {
    onClose();
    if (id !== thread?.id) actions.open(id === mainId ? undefined : id);
  };

  return (
    <>
      <Sheet open={open === 'main'} onClose={onClose} items={items}>
        {groups.map((g) => (g.items.length ? renderGroup(g) : null))}
      </Sheet>
      <Sheet
        open={open === 'snooze'}
        onClose={onClose}
        title={t('chat.snoozeThread')}
        items={
          thread
            ? snoozeTimes(new Date(now)).map((o) => ({
                icon: 'bell-off' as const,
                label: t(`chat.snooze.${o.key}`),
                onPress: () => void actions.patch(thread, { snoozedUntil: o.at.toISOString() }, true),
              }))
            : []
        }
      />
      <Sheet open={open === 'icon'} onClose={onClose} title={t('chat.threadIcon')}>
        <View style={styles.icons}>
          {THREAD_ICONS.map((icon) => (
            <Pressable
              key={icon}
              accessibilityRole="button"
              accessibilityLabel={icon}
              onPress={() => {
                onClose();
                if (thread) void actions.patch(thread, { icon });
              }}
              style={({ pressed }) => [styles.iconCell, pressed && { backgroundColor: c.accent }]}
            >
              <Text style={styles.iconEmoji}>{icon}</Text>
            </Pressable>
          ))}
        </View>
        {thread?.icon ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => {
              onClose();
              void actions.patch(thread, { icon: '' });
            }}
            style={({ pressed }) => [styles.noIcon, pressed && { backgroundColor: c.accent }]}
          >
            <Text style={[styles.groupName, { color: c.foreground }]}>{t('chat.threadIconNone')}</Text>
          </Pressable>
        ) : null}
      </Sheet>
    </>
  );

  function renderGroup({
    label,
    items: list,
    icon,
  }: {
    label: string;
    items: Thread[];
    icon?: IconName;
  }): ReactNode {
    // A conversation with a card waiting comes first and stays in the list however old it is; the
    // ones the person pinned come next, then the rest by date.
    const rank = (th: Thread) => (waiting.has(th.id) ? 2 : th.pinnedAt ? 1 : 0);
    const shown = list.filter((th, i) => i < 12 || rank(th) > 0).sort((a, b) => rank(b) - rank(a));
    return (
      <View key={label}>
        <Text style={[styles.groupLabel, { color: c.mutedForeground }]}>{label}</Text>
        {shown.map((th) => {
          const cards = waiting.get(th.id);
          return (
            <Pressable
              key={th.id}
              accessibilityRole="button"
              accessibilityState={{ selected: th.id === thread?.id }}
              onPress={() => pick(th.id)}
              style={({ pressed }) => [
                styles.thread,
                (pressed || th.id === thread?.id) && { backgroundColor: c.accent },
              ]}
            >
              {icon ? (
                <Feather name={icon} size={20} color={c.mutedForeground} />
              ) : th.pinnedAt ? (
                <Feather
                  name="bookmark"
                  size={20}
                  color={c.mutedForeground}
                  accessibilityLabel={t('chat.pinnedThread')}
                />
              ) : null}
              {th.icon ? <Text style={styles.threadEmoji}>{th.icon}</Text> : null}
              <Text style={[styles.groupName, { color: c.foreground }]} numberOfLines={1}>
                {actions.name(th)}
              </Text>
              {cards ? (
                <View
                  style={[styles.badge, { backgroundColor: c.amber }]}
                  accessibilityLabel={t('chat.waitingCards', { count: cards })}
                >
                  <Text style={styles.badgeText}>{cards}</Text>
                </View>
              ) : (
                <Text style={[styles.time, { color: c.mutedForeground }]}>{fmt.shortTime(th.updatedAt)}</Text>
              )}
            </Pressable>
          );
        })}
      </View>
    );
  }
}

const styles = StyleSheet.create({
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 8, height: 56, gap: 8 },
  left: { flex: 1, minWidth: 44, alignItems: 'flex-start' },
  right: { flex: 1, minWidth: 88, flexDirection: 'row', justifyContent: 'flex-end' },
  pill: {
    flexShrink: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 40,
    paddingLeft: 6,
    paddingRight: 10,
    borderRadius: 20,
    borderWidth: 1,
  },
  pillName: { fontSize: 17, fontWeight: '600', flexShrink: 0 },
  pillTitle: { fontSize: 17, flexShrink: 1 },
  groupLabel: { fontSize: 15, paddingHorizontal: 20, paddingTop: 12, paddingBottom: 4 },
  thread: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 46, paddingHorizontal: 20 },
  threadEmoji: { fontSize: 17 },
  groupName: { flex: 1, fontSize: 17 },
  time: { fontSize: 15 },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 4,
  },
  badgeText: { fontSize: 11, fontWeight: '700', color: '#000000' },
  icons: { flexDirection: 'row', flexWrap: 'wrap', paddingHorizontal: 12, paddingBottom: 8 },
  iconCell: {
    width: '16.66%',
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 16,
  },
  iconEmoji: { fontSize: 26 },
  noIcon: { minHeight: 46, justifyContent: 'center', paddingHorizontal: 20 },
});
