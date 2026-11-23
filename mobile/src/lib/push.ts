import type { PushLevel } from '@leafbot/shared';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import { useFocusEffect } from 'expo-router';
import * as Notifications from 'expo-notifications';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';
import { MUTED_KEY, type Mutes } from '@/components/sidebar/mutes';
import { locale } from '@/i18n';
import { apiFor } from './api';
import { useUnread } from './seen';
import { nav } from './nav';
import { useStored } from './stored';

/**
 * Notifications on the phone while the app is closed. The app asks Apple for this phone's device
 * token and hands it to the server with the phone's choices (level, muted bots, language); the
 * server then sends each notice that passes them straight to Apple. Only the iPhone app for now:
 * the server speaks to Apple's service alone, and Expo Go cannot receive another app's
 * notifications.
 */

/** The same key the web app keeps its level under, so the two read alike. */
export const LEVEL_KEY = 'leafbot.notify';
const TOKEN_KEY = 'leafbot.push.token';

export const pushSupported =
  Platform.OS === 'ios' && Constants.executionEnvironment !== ExecutionEnvironment.StoreClient;

export type PushPermission = Notifications.PermissionStatus | 'unsupported';

/** The conversation on screen, if any. */
let viewing: string | null = null;

// While the app is open a notice still shows, unless it is about the conversation on screen,
// which updates live.
if (pushSupported) {
  Notifications.setNotificationHandler({
    handleNotification: async (n) => {
      const { kind, threadId } = payloadOf(n.request);
      const show = kind === 'test' || threadId !== viewing;
      // The number on the icon is set from the bot list while the app is open.
      return { shouldShowBanner: show, shouldShowList: show, shouldPlaySound: show, shouldSetBadge: false };
    },
  });
}

/** Marks the conversation on screen while its screen is in front, so its notices stay quiet. */
export function useViewingThread(threadId: string | undefined) {
  useFocusEffect(
    useCallback(() => {
      if (!threadId) return;
      viewing = threadId;
      return () => {
        if (viewing === threadId) viewing = null;
      };
    }, [threadId]),
  );
}

/** The server puts its fields next to `aps`, which the phone hands over as the trigger's payload. */
function payloadOf(request: Notifications.NotificationRequest): Record<string, unknown> {
  const { trigger, content } = request;
  return (
    (trigger && 'type' in trigger && trigger.type === 'push' ? trigger.payload : undefined) ??
    content.data ??
    {}
  );
}

/** This phone's notification level, kept on the phone. */
export function usePushLevel(): [PushLevel, (level: PushLevel) => void, boolean] {
  return useStored<PushLevel>(LEVEL_KEY, 'all');
}

/** Whether the phone lets the app notify, read again whenever the app comes back to the front. */
export function usePushPermission(): [PushPermission, () => Promise<PushPermission>] {
  const [status, setStatus] = useState<PushPermission>(
    pushSupported ? Notifications.PermissionStatus.UNDETERMINED : 'unsupported',
  );
  useEffect(() => {
    if (!pushSupported) return;
    const read = () =>
      Notifications.getPermissionsAsync()
        .then((p) => setStatus(p.status))
        .catch(() => undefined);
    void read();
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void read();
    });
    return () => sub.remove();
  }, []);
  const ask = useCallback(async () => {
    if (!pushSupported) return 'unsupported' as const;
    const p = await Notifications.requestPermissionsAsync();
    setStatus(p.status);
    if (p.status === Notifications.PermissionStatus.GRANTED)
      void fetchToken().catch((err: unknown) => console.warn('push token', err));
    return p.status;
  }, []);
  return [status, ask];
}

/** This phone's device token once the phone has given one, for the test notification. */
export function usePushToken(): string | null {
  return useStored<string | null>(TOKEN_KEY, null)[0];
}

let tokenSetter: ((token: string) => void) | null = null;

async function fetchToken() {
  const t = await Notifications.getDevicePushTokenAsync();
  if (typeof t.data === 'string') tokenSetter?.(t.data);
}

/**
 * Follows the phone's push service while signed in to `origin`: asks once for permission, gets
 * the token again (Apple may change it), keeps the server's copy of the choices current, clears
 * delivered notifications when the app opens and notes a tapped one for the bot list to open.
 */
export function usePush(origin: string | null, signedIn: boolean) {
  const [level, , levelLoaded] = usePushLevel();
  const [mutes, , mutesLoaded] = useStored<Mutes>(MUTED_KEY, {});
  const [token, setToken] = useStored<string | null>(TOKEN_KEY, null);
  const active = pushSupported && !!origin && signedIn;
  const unread = useUnread(origin);
  // The same bots in a new array are not a change.
  const unreadKey = unread?.join(',');

  useEffect(() => {
    if (!active || !levelLoaded) return;
    let gone = false;
    tokenSetter = (t) => {
      if (!gone) setToken(t);
    };
    const sync = async () => {
      let { status } = await Notifications.getPermissionsAsync();
      // Asked once, the first time the person is signed in and has not turned notifications off.
      if (status === Notifications.PermissionStatus.UNDETERMINED && level !== 'off') {
        ({ status } = await Notifications.requestPermissionsAsync());
      }
      if (status === Notifications.PermissionStatus.GRANTED) await fetchToken();
    };
    const onActive = () => {
      void Notifications.dismissAllNotificationsAsync().catch(() => undefined);
      void sync().catch((err: unknown) => console.warn('push token', err));
    };
    onActive();
    const state = AppState.addEventListener('change', (s) => {
      if (s === 'active') onActive();
    });
    const changed = Notifications.addPushTokenListener((t) => {
      if (typeof t.data === 'string') tokenSetter?.(t.data);
    });
    return () => {
      gone = true;
      tokenSetter = null;
      state.remove();
      changed.remove();
    };
  }, [active, levelLoaded, level, setToken]);

  // The icon shows how many bots have replies not yet read, as the computer's does; the server
  // counts on from the same list while the app is closed.
  useEffect(() => {
    if (!pushSupported || unreadKey === undefined) return;
    const count = unreadKey ? unreadKey.split(',').length : 0;
    void Notifications.setBadgeCountAsync(count).catch(() => undefined);
  }, [unreadKey]);

  // A choice changed on this phone reaches the server at once, and so does a bot read here.
  useEffect(() => {
    if (!active || !token || !levelLoaded || !mutesLoaded) return;
    const ids = unreadKey === undefined ? undefined : unreadKey ? unreadKey.split(',') : [];
    apiFor(origin)
      .pushDevice({ token, platform: 'ios', locale, level, mutes, ...(ids ? { unread: ids } : {}) })
      .catch((err: unknown) => console.warn('push register', err));
  }, [active, origin, token, level, mutes, levelLoaded, mutesLoaded, unreadKey]);

  useEffect(() => {
    if (!pushSupported) return;
    const take = (r: Notifications.NotificationResponse | null) => {
      if (r) tapped(r);
    };
    // A notification that opened the app from closed arrives before any listener is set.
    take(Notifications.getLastNotificationResponse());
    Notifications.clearLastNotificationResponse();
    const sub = Notifications.addNotificationResponseReceivedListener(take);
    return () => sub.remove();
  }, []);
}

interface Target {
  botId: string;
  threadId: string;
}

let pending: Target | null = null;
const listeners = new Set<() => void>();

let lastTapped: string | null = null;

function tapped(r: Notifications.NotificationResponse) {
  // A tap that opened the app can come both as the last response and through the listener.
  const id = r.notification.request.identifier;
  if (id === lastTapped) return;
  lastTapped = id;
  const { botId, threadId } = payloadOf(r.notification.request);
  if (typeof botId !== 'string' || typeof threadId !== 'string') return;
  pending = { botId, threadId };
  listeners.forEach((fn) => fn());
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

/**
 * Opens the conversation of a tapped notification from the bot list, which every signed-in path
 * passes through: a room, or the bot's chat at that thread. Waits for the rooms to know which.
 */
export function useOpenTappedNotice(rooms: { id: string }[] | undefined, roomsSettled: boolean) {
  const target = useSyncExternalStore(subscribe, () => pending);
  useEffect(() => {
    if (!target || !roomsSettled) return;
    pending = null;
    listeners.forEach((fn) => fn());
    if (rooms?.some((r) => r.id === target.threadId)) nav.room(target.threadId);
    else nav.chat(target.botId, { threadId: target.threadId });
  }, [target, rooms, roomsSettled]);
}
