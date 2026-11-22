import * as Updates from 'expo-updates';
import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import { toast } from '@/components/overlay';
import { t } from '@/i18n';
import { shouldCheck } from './updateCheck';

/**
 * Whether this copy takes updates at all: a store build made from the app's EAS project, which
 * names the channel it listens on. A development build runs the code on the computer instead, and
 * a build without a project or a channel (a local release build) has nowhere to take them from.
 */
export const updatesOn = Platform.OS !== 'web' && !__DEV__ && Updates.isEnabled && !!Updates.channel;

// The app already looks at launch, so the first return to the front does not look again at once.
let lastCheck: number | null = Date.now();
let looking: Promise<boolean> | null = null;

/**
 * Looks for an update and downloads it. It is used from the next start, or at once from the
 * restart the app then offers. Resolves to whether one was found.
 */
export function checkForUpdate(): Promise<boolean> {
  // A look already under way (the settings button and a return to the front at once) is shared:
  // expo-updates refuses a second check or download while one runs.
  if (looking) return looking;
  lastCheck = Date.now();
  looking = (async () => {
    const found = await Updates.checkForUpdateAsync();
    if (!found.isAvailable) return false;
    await Updates.fetchUpdateAsync();
    return true;
  })().finally(() => {
    looking = null;
  });
  return looking;
}

export function restartIntoUpdate() {
  void Updates.reloadAsync();
}

/**
 * Keeps the app current while it is used for days without being closed: it looks again when it
 * comes back to the front, at most once an hour, and when an update has come down it offers to
 * restart into it once, without pushing; otherwise the update is used from the next start.
 */
export function useAppUpdates() {
  const { downloadedUpdate, isUpdatePending } = Updates.useUpdates();
  const offered = useRef<string | null>(null);

  useEffect(() => {
    if (!updatesOn) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state !== 'active' || !shouldCheck(lastCheck, Date.now())) return;
      // A failed look is not worth a message: the next one comes within the hour.
      checkForUpdate().catch(() => undefined);
    });
    return () => sub.remove();
  }, []);

  const id = downloadedUpdate?.updateId ?? null;
  useEffect(() => {
    if (!updatesOn || !isUpdatePending || !id || offered.current === id) return;
    offered.current = id;
    toast(t('update.ready'), { action: { label: t('update.restart'), onPress: restartIntoUpdate } });
  }, [id, isUpdatePending]);
}
