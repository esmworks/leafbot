import { useEffect, useReducer, useState, type ComponentType } from 'react';
import { useT } from '@/i18n';

/**
 * A screen that is fetched the first time it is shown, so the first paint does not parse the
 * code of pages most sessions never open.
 *
 * This is not `React.lazy` with Suspense, for two reasons. Suspense holds the commit back after a
 * fallback for a few hundred milliseconds even when the chunk is already in memory, so opening a
 * loaded screen would feel slow. And `React.lazy` rethrows the same failed import on every render,
 * while a browser remembers a failed dynamic import and does not fetch it again, so a flaky
 * network would leave the screen broken until the page is reloaded.
 *
 * Here the loaded component is kept in a module-level variable and rendered synchronously from then
 * on. While it loads nothing is drawn. A failed load shows one line with a button that asks again
 * with a fresh call to the loader; if that fails too, the browser is holding the failure, and the
 * button reloads the page instead.
 */
export type LazyScreen<P extends object> = ComponentType<P> & {
  /** Starts fetching without showing anything; never rejects. */
  preload(): Promise<void>;
  /** Whether the code is in memory, so showing the screen takes no waiting. */
  loaded(): boolean;
};

export function lazyScreen<P extends object>(load: () => Promise<ComponentType<P>>): LazyScreen<P> {
  let component: ComponentType<P> | null = null;
  let pending: Promise<void> | null = null;

  const start = (): Promise<void> => {
    if (component) return Promise.resolve();
    // One import at a time; a failed one is dropped so the next call imports afresh.
    pending ??= load().then(
      (c) => {
        component = c;
        pending = null;
      },
      (error: unknown) => {
        pending = null;
        throw error;
      },
    );
    return pending;
  };

  function Screen(props: P) {
    const t = useT();
    const [, refresh] = useReducer((n: number) => n + 1, 0);
    const [failures, setFailures] = useState(0);
    // Set in the handler that asks again, so the effect below only reacts to the outcome.
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      if (component) return;
      let live = true;
      start().then(
        () => live && refresh(),
        () => live && setFailures((n) => n + 1),
      );
      return () => {
        live = false;
      };
    }, [attempt]);

    if (component) {
      const Loaded = component;
      return <Loaded {...props} />;
    }
    if (failures === 0 || attempt >= failures) return null;
    return (
      <div className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground">
        <span>{t('screen.loadFailed')}</span>
        <button
          type="button"
          className="underline underline-offset-2 hover:text-foreground"
          onClick={() => {
            if (failures > 1) return window.location.reload();
            setAttempt((n) => n + 1);
          }}
        >
          {t('screen.retry')}
        </button>
      </div>
    );
  }

  return Object.assign(Screen, {
    preload: () => start().catch(() => {}),
    loaded: () => component !== null,
  });
}

/** True from the first time `open` is true on, so a closing animation can finish before unmounting. */
export function useOpenedOnce(open: boolean): boolean {
  const [seen, setSeen] = useState(open);
  if (open && !seen) setSeen(true);
  return seen;
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The desktop app serves the page from its own computer, where fetching a chunk costs next to nothing. */
export function servedLocally(hostname: string = window.location.hostname): boolean {
  return LOCAL_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * Fetches the screens one by one while the app has nothing else to do, so a first click on them
 * finds them loaded. Not done on a local address: there opening is fast already, and fetching
 * everything during launch would compete with the first paint. Returns a function that stops it.
 */
export function preloadWhenIdle(screens: readonly { preload(): Promise<void> }[]): () => void {
  if (servedLocally()) return () => {};
  const queue = [...screens];
  let stopped = false;
  let cancel = () => {};
  const next = () => {
    const screen = queue.shift();
    if (stopped || !screen) return;
    void screen.preload().then(() => schedule());
  };
  const schedule = () => {
    if (stopped || queue.length === 0) return;
    if (typeof window.requestIdleCallback === 'function') {
      const id = window.requestIdleCallback(next);
      cancel = () => window.cancelIdleCallback(id);
    } else {
      const id = window.setTimeout(next, 200);
      cancel = () => window.clearTimeout(id);
    }
  };
  schedule();
  return () => {
    stopped = true;
    cancel();
  };
}
