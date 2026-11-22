import type { LiveActivityProps, LiveActivitySet } from '@leafbot/shared';
import Constants, { ExecutionEnvironment } from 'expo-constants';
import type { LiveActivity, LiveActivityFactory } from 'expo-widgets';
import { Platform } from 'react-native';
import { locale, t } from '@/i18n';
import { useStored } from './stored';

/** Whether the person wants their bots' work on the lock screen; on unless turned off. */
export const LIVE_ACTIVITY_KEY = 'leafbot.liveActivity';

export function useLiveActivityChoice(): [boolean, (v: boolean) => void] {
  const [on, set] = useStored<boolean>(LIVE_ACTIVITY_KEY, true);
  return [on, set];
}

/** Until it moves, the work shows as out of date after this long. */
const STALE_MS = 30 * 60 * 1000;
/** How long to wait for Apple's token for a new activity before giving it up. */
const TOKEN_WAIT_MS = 10_000;

let loaded: LiveActivityFactory<LiveActivityProps> | null | undefined;

/**
 * The lock screen layout, loaded only where it exists: an iPhone build of the app. Expo Go and
 * Android have no Live Activities, and loading the module there would stop the app.
 */
function factory(): LiveActivityFactory<LiveActivityProps> | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (Platform.OS !== 'ios' || Constants.executionEnvironment === ExecutionEnvironment.StoreClient)
    return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded only where it exists, see above
    loaded = (require('@/widgets/BotWork') as { default: LiveActivityFactory<LiveActivityProps> }).default;
  } catch {
    loaded = null;
  }
  return loaded;
}

export const liveActivitiesSupported = () => factory() !== null;

/** The activity shown for each conversation, so a second message does not start another. */
const shown = new Map<string, LiveActivity<LiveActivityProps>>();

function tokenOf(activity: LiveActivity<LiveActivityProps>): Promise<string | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      sub.remove();
      resolve(null);
    }, TOKEN_WAIT_MS);
    const sub = activity.addPushTokenListener((e) => {
      clearTimeout(timer);
      sub.remove();
      resolve(e.pushToken);
    });
    void activity.getPushToken().then((token) => {
      if (!token) return;
      clearTimeout(timer);
      sub.remove();
      resolve(token);
    });
  });
}

/**
 * Puts a bot's work on the lock screen after the person's own message, while the app is still in
 * front (iOS starts one only then). The server moves it along and ends it, since the app sleeps
 * once put away; a server that cannot reach Apple has it ended at once rather than left standing.
 */
export async function showWork(
  watch: (threadId: string, b: LiveActivitySet) => Promise<{ pushing: boolean }>,
  threadId: string,
  bot: string,
): Promise<void> {
  const f = factory();
  if (!f) return;
  const open = shown.get(threadId);
  if (open && f.getInstances().some((a) => a.getId() === open.getId())) return;
  let activity: LiveActivity<LiveActivityProps>;
  try {
    activity = f.start(
      { bot, state: t('activity.working'), phase: 'working', since: Date.now() },
      undefined,
      new Date(Date.now() + STALE_MS),
    );
  } catch {
    // Live Activities turned off for the app in the phone's settings.
    return;
  }
  shown.set(threadId, activity);
  const end = () => {
    shown.delete(threadId);
    return activity.end('immediate').catch(() => undefined);
  };
  try {
    const token = await tokenOf(activity);
    if (!token) return void (await end());
    const { pushing } = await watch(threadId, { token, locale });
    if (!pushing) return void (await end());
    // Apple may give the activity a new token while it lasts; the server needs the newest.
    activity.addPushTokenListener(
      (e) => void watch(threadId, { token: e.pushToken, locale }).catch(() => {}),
    );
  } catch {
    await end();
  }
}
