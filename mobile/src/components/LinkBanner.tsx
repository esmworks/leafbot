import { router, usePathname } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '@/i18n';
import { useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/**
 * How long the tunnel may be down before the line shows. Back from the background it is opened again
 * within a second or two while the requests wait for it, and the line under the name says so; a line
 * that flashes over the screen for that says nothing more.
 */
const SHOW_AFTER_MS = 5_000;

/** Whether `on` has held for `ms` without a break. */
function useLasting(on: boolean, ms: number): boolean {
  const [lasted, setLasted] = useState(false);
  useEffect(() => {
    if (!on) return;
    const timer = setTimeout(() => setLasted(true), ms);
    return () => {
      clearTimeout(timer);
      setLasted(false);
    };
  }, [on, ms]);
  return on && lasted;
}

/**
 * Goes back to the start screen when the chosen server changes under the screens: signed out, or
 * the account's list, read after the screens opened with what was kept, no longer has the server
 * they show. The start screen then says what to do (choose another, sign in again).
 */
export function useBackToStart() {
  const { origin } = useServer();
  const was = useRef(origin);
  useEffect(() => {
    if (was.current && was.current !== origin) router.replace('/');
    was.current = origin;
  }, [origin]);
}

/**
 * A line over the screens while the tunnel to the server stays down, so a screen that cannot load
 * does not look broken: the phone is trying again, or the server turned it away (a tap says why).
 * The first screen says the same itself, so it shows none there.
 */
export function LinkBanner() {
  useBackToStart();
  const c = useColors();
  const inset = useSafeAreaInsets();
  const path = usePathname();
  const { phase, reason, origin } = useServer();
  const down = useLasting(phase === 'retrying' || phase === 'connecting', SHOW_AFTER_MS);
  if (!origin || path === '/' || (phase !== 'refused' && !down)) return null;
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
