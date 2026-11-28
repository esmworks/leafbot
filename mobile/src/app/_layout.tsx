import '@/lib/runtime';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { LinkBanner } from '@/components/LinkBanner';
import { keepUpright } from '@/lib/orientation';
import { RealtimeProvider } from '@/lib/realtime';
import { ServerProvider } from '@/lib/server';
import { Overlays } from '@/components/overlay';
import { useColors, useIsDark } from '@/lib/theme';
import { useAppUpdates } from '@/lib/updates';

/** Data seen on screen refreshes when the app comes back from the background, as a browser tab does. */
function useRefetchOnForeground() {
  useEffect(() => {
    if (Platform.OS === 'web') return;
    const sub = AppState.addEventListener('change', (state) => focusManager.setFocused(state === 'active'));
    return () => sub.remove();
  }, []);
}

export default function RootLayout() {
  useEffect(keepUpright, []);
  useRefetchOnForeground();
  useAppUpdates();
  const c = useColors();
  const dark = useIsDark();
  // Live pushes say what changed, and everything is read again after the live channel was away, so
  // a list read moments ago is not read again over the tunnel each time a screen opens.
  const [client] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } }),
  );
  return (
    <SafeAreaProvider>
      <QueryClientProvider client={client}>
        <ServerProvider>
          <RealtimeProvider>
            <StatusBar style={dark ? 'light' : 'dark'} />
            <Stack
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: c.background },
                headerStyle: { backgroundColor: c.background },
                headerTintColor: c.foreground,
                headerTitleStyle: { color: c.foreground },
                headerShadowVisible: false,
              }}
            >
              <Stack.Screen name="index" />
              <Stack.Screen name="connect" />
              <Stack.Screen name="servers" />
              <Stack.Screen name="bots" options={{ animation: 'fade' }} />
              {/* The editors ask before dropping changes; a swipe back would leave without asking. */}
              <Stack.Screen name="bot-edit" options={{ gestureEnabled: false }} />
              <Stack.Screen name="routine" options={{ gestureEnabled: false }} />
            </Stack>
            <LinkBanner />
            <Overlays />
          </RealtimeProvider>
        </ServerProvider>
      </QueryClientProvider>
    </SafeAreaProvider>
  );
}
