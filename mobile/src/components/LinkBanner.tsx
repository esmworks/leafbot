import { router, usePathname } from 'expo-router';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/i18n';
import { useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/**
 * A line over the screens while the tunnel to the server is down, so a screen that cannot load does
 * not look broken: the phone is trying again, or the server turned it away (a tap says why). The
 * first screen says the same itself, so it shows none there.
 */
export function LinkBanner() {
  const c = useColors();
  const inset = useSafeAreaInsets();
  const path = usePathname();
  const { phase, reason, origin } = useServer();
  if (!origin || path === '/' || (phase !== 'retrying' && phase !== 'refused' && phase !== 'connecting'))
    return null;
  const text =
    phase === 'refused'
      ? t('link.banner.refused')
      : phase === 'retrying' && reason === 'offline'
        ? t('link.banner.offline')
        : t('link.banner.retrying');
  return (
    <Pressable
      accessibilityRole="button"
      onPress={() => router.replace('/')}
      style={[styles.bar, { top: inset.top, backgroundColor: phase === 'refused' ? c.destructive : c.amber }]}
    >
      <Text style={styles.text}>{text}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: { position: 'absolute', left: 0, right: 0, paddingVertical: 4, alignItems: 'center' },
  text: { color: '#FFFFFF', fontSize: 13, fontWeight: '500' },
});
