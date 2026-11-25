import { requireOptionalNativeModule } from 'expo';
import { useFocusEffect } from 'expo-router';
import type * as ScreenOrientationModule from 'expo-screen-orientation';
import { useCallback } from 'react';

type ScreenOrientation = typeof ScreenOrientationModule;

/**
 * The orientation module, or null in a build made before it was added. Code updates reach those
 * builds too, and the module's own import fails there, so it is loaded only once the build is known
 * to have it.
 */
function orientation(): ScreenOrientation | null {
  if (!requireOptionalNativeModule('ExpoScreenOrientation')) return null;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-screen-orientation') as ScreenOrientation;
}

/** How many shown screens let the phone turn; a screen opened straight from a link may be first. */
let turnable = 0;

/** The app is laid out for an upright phone; only the screens that show a computer turn. */
export function keepUpright() {
  if (turnable > 0) return;
  const o = orientation();
  void o?.lockAsync(o.OrientationLock.PORTRAIT_UP).catch(() => undefined);
}

/** Lets the phone turn sideways while this screen is shown, and stands it up again on leaving. */
export function useTurnable() {
  useFocusEffect(
    useCallback(() => {
      turnable += 1;
      void orientation()
        ?.unlockAsync()
        .catch(() => undefined);
      return () => {
        turnable -= 1;
        keepUpright();
      };
    }, []),
  );
}
