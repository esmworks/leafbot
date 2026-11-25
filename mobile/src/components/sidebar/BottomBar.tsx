import { INTL_LOCALE } from '@leafbot/shared/i18n';
import MaterialCommunityIcons from '@expo/vector-icons/MaterialCommunityIcons';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { IconButton } from '@/components/page';
import { locale, t } from '@/i18n';
import { nav } from '@/lib/nav';
import { useSettings } from '@/lib/queries';
import { useConnected } from '@/lib/realtime';
import { useColors } from '@/lib/theme';

/** Up to two letters from a name, as the web app's profile disc shows them. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const first = Array.from(parts[0] ?? '?')[0] ?? '?';
  const second = Array.from(parts[1] ?? '')[0] ?? '';
  return (first + second).toLocaleUpperCase(INTL_LOCALE[locale]);
}

/** The profile with the connection dot, and the buttons for Today, Apps and Settings. */
export function BottomBar() {
  const c = useColors();
  const { data: settings } = useSettings();
  const connected = useConnected();
  const userName = settings?.userName || t('sidebar.defaultUser');
  return (
    <SafeAreaView edges={['bottom', 'left', 'right']} style={[styles.bar, { borderTopColor: c.border }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('profile.open')}
        onPress={() => nav.settings('profile')}
        style={({ pressed }) => [styles.profile, pressed && { backgroundColor: c.accent }]}
      >
        <View style={[styles.disc, { backgroundColor: c.muted }]}>
          <Text style={[styles.initials, { color: c.foreground }]}>{initials(userName)}</Text>
        </View>
        <View style={styles.profileText}>
          <Text style={[styles.userName, { color: c.foreground }]} numberOfLines={1}>
            {userName}
          </Text>
          <View style={styles.status}>
            <View style={[styles.statusDot, { backgroundColor: connected ? c.success : c.amber }]} />
            <Text style={[styles.statusText, { color: c.mutedForeground }]} numberOfLines={1}>
              {connected ? t('sidebar.connected') : t('sidebar.connecting')}
            </Text>
          </View>
        </View>
      </Pressable>
      <IconButton label={t('today.title')} onPress={() => nav.today()}>
        <MaterialCommunityIcons name="calendar-check-outline" size={20} color={c.foreground} />
      </IconButton>
      <IconButton label={t('dashboards.title')} onPress={() => nav.dashboards()}>
        <MaterialCommunityIcons name="view-dashboard-outline" size={20} color={c.foreground} />
      </IconButton>
      <IconButton label={t('apps.open')} onPress={() => nav.apps()}>
        <MaterialCommunityIcons name="widgets-outline" size={20} color={c.foreground} />
      </IconButton>
      <IconButton label={t('settings.title')} onPress={() => nav.settings()} filled>
        <MaterialCommunityIcons name="tune-variant" size={20} color={c.foreground} />
      </IconButton>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 8,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  profile: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minWidth: 0,
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderRadius: 16,
  },
  disc: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  initials: { fontSize: 16, fontWeight: '600' },
  profileText: { flex: 1, minWidth: 0 },
  userName: { fontSize: 16, fontWeight: '500' },
  status: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  statusDot: { width: 6, height: 6, borderRadius: 3 },
  statusText: { fontSize: 13 },
});
