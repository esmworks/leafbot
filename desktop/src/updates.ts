/** How often a running app looks for a new release after the check at start. */
export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;

/** What a check answers, as far as it is used here. */
export interface UpdateCheck {
  isUpdateAvailable?: boolean;
  updateInfo?: { version?: string };
}

/** What a check the person asked for found. */
export type CheckResult =
  | { status: 'current' }
  /** A newer version exists; it is downloading and the person is asked when it is ready. */
  | { status: 'downloading'; version: string }
  /** A version is already downloaded and waits for a restart. */
  | { status: 'ready'; version: string }
  | { status: 'failed'; offline: boolean; message: string };

const OFFLINE =
  /ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION|ERR_TIMED_OUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EHOSTUNREACH|ENETDOWN/;

/** Whether a failed check says the network, or GitHub itself, could not be reached. */
export function isOfflineError(message: string): boolean {
  return OFFLINE.test(message);
}

/** The part of electron-updater's `autoUpdater` used here, so a test can stand in for it. */
export interface Updater {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  checkForUpdates(): Promise<UpdateCheck | null | undefined>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
  on(event: 'update-downloaded', listener: (info: { version: string }) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface UpdateOptions {
  updater: Updater;
  /** Asks whether to restart into the downloaded version now. */
  ask: (version: string) => Promise<boolean>;
  /**
   * Whether installing may go ahead now. With bots at work the restart would cut them off, so the
   * person is asked; saying no leaves the version waiting for the next quit or a later try.
   */
  confirmInstall?: () => Promise<boolean>;
  /** Stops what the app runs (the server) so the installer finds nothing holding its files. */
  beforeInstall: () => Promise<void>;
  /** A version is downloaded and waits to be installed, so the menu can offer it. */
  onReady: (version: string) => void;
  /**
   * The installer was started but the app did not quit, so what `beforeInstall` stopped must be
   * brought back; the version waits again and `install` can be tried once more.
   */
  onInstallFailed?: (version: string, message: string) => void;
  warn: (message: string) => void;
  everyMs?: number;
  /** How long the app may take to quit after the installer is started before that counts as failed. */
  installTimeoutMs?: number;
}

export interface Updates {
  /** Stops the server and restarts into the downloaded version. */
  install(): Promise<void>;
  /** Looks for a new version now, for a person who asked; the answer says what to tell them. */
  checkNow(): Promise<CheckResult>;
  stop(): void;
}

/** How long a started installer may leave the app running before the install counts as failed. */
export const INSTALL_TIMEOUT_MS = 30_000;

/**
 * Where a downloaded version is on its way to being installed. Only a version that is downloaded
 * has a phase of its own, so every variant but `idle` names the version it concerns.
 */
export type UpdateState =
  /** Nothing is downloaded; checks go on. */
  | { kind: 'idle' }
  /** Downloaded; the person is being asked whether to restart now. */
  | { kind: 'asking'; version: string }
  /** Downloaded and waiting for the person (menu) or the next quit. */
  | { kind: 'ready'; version: string }
  /** The person is being asked whether restarting may cut off the bots at work. */
  | { kind: 'confirming'; version: string }
  /** The server is being stopped so the installer finds nothing holding its files. */
  | { kind: 'stopping'; version: string }
  /** The installer was started; the app should quit any moment. */
  | { kind: 'installing'; version: string };

export type UpdateEvent =
  | { kind: 'downloaded'; version: string }
  | { kind: 'askAnswered'; version: string; yes: boolean }
  | { kind: 'install' }
  | { kind: 'confirmAnswered'; yes: boolean }
  | { kind: 'serverStopped'; error?: string }
  | { kind: 'installError'; message: string }
  | { kind: 'installTimeout' };

export type UpdateEffect =
  | { kind: 'warn'; message: string }
  | { kind: 'onReady'; version: string }
  | { kind: 'ask'; version: string }
  | { kind: 'confirm' }
  | { kind: 'beforeInstall' }
  | { kind: 'quitAndInstall' }
  | { kind: 'armInstallTimeout' }
  | { kind: 'installFailed'; version: string; message: string };

/** The step to take when an install is asked for: confirm first when something must be asked. */
function beginInstall(
  version: string,
  mustConfirm: boolean,
): { state: UpdateState; effects: UpdateEffect[] } {
  return mustConfirm
    ? { state: { kind: 'confirming', version }, effects: [{ kind: 'confirm' }] }
    : { state: { kind: 'stopping', version }, effects: [{ kind: 'beforeInstall' }] };
}

/** Pure: what a state does with an event, and what the caller must then do. */
export function updateStep(
  state: UpdateState,
  event: UpdateEvent,
  mustConfirm = false,
): { state: UpdateState; effects: UpdateEffect[] } {
  const same = { state, effects: [] as UpdateEffect[] };
  switch (event.kind) {
    case 'downloaded':
      // A version being installed is not swapped for a newer one halfway.
      if (state.kind === 'idle' || state.kind === 'ready' || state.kind === 'asking') {
        if (state.kind !== 'idle' && state.version === event.version) return same;
        return {
          state: { kind: 'asking', version: event.version },
          effects: [
            { kind: 'onReady', version: event.version },
            { kind: 'ask', version: event.version },
          ],
        };
      }
      return same;
    case 'askAnswered':
      if (state.kind !== 'asking' || state.version !== event.version) return same;
      return event.yes
        ? beginInstall(state.version, mustConfirm)
        : { state: { kind: 'ready', version: state.version }, effects: [] };
    case 'install':
      if (state.kind !== 'ready' && state.kind !== 'asking') return same;
      return beginInstall(state.version, mustConfirm);
    case 'confirmAnswered':
      if (state.kind !== 'confirming') return same;
      return event.yes
        ? { state: { kind: 'stopping', version: state.version }, effects: [{ kind: 'beforeInstall' }] }
        : { state: { kind: 'ready', version: state.version }, effects: [] };
    case 'serverStopped': {
      if (state.kind !== 'stopping') return same;
      // Whatever kept the server from stopping cleanly is no reason to leave the version waiting.
      const warn: UpdateEffect[] = event.error
        ? [{ kind: 'warn', message: `could not stop the server before installing: ${event.error}` }]
        : [];
      return {
        state: { kind: 'installing', version: state.version },
        effects: [...warn, { kind: 'quitAndInstall' }, { kind: 'armInstallTimeout' }],
      };
    }
    case 'installError':
    case 'installTimeout': {
      if (state.kind !== 'installing') return same;
      const message =
        event.kind === 'installError' ? event.message : 'the app did not quit for the installer';
      return {
        state: { kind: 'ready', version: state.version },
        effects: [
          { kind: 'warn', message: `update install failed: ${message}` },
          { kind: 'installFailed', version: state.version, message },
        ],
      };
    }
  }
}

/**
 * Updates from the GitHub releases named by electron-builder's `publish` setting. A new version
 * downloads in the background; the person is asked once whether to restart into it, and a version
 * left waiting installs when the app quits. Once one is waiting there is nothing more to look for
 * until the restart, so the periodic checks stop asking.
 */
export function startUpdates(options: UpdateOptions): Updates {
  const { updater, everyMs = CHECK_EVERY_MS, installTimeoutMs = INSTALL_TIMEOUT_MS } = options;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  let state: UpdateState = { kind: 'idle' };
  let installTimer: ReturnType<typeof setTimeout> | undefined;
  const queue: UpdateEvent[] = [];
  let draining = false;
  const waiting: (() => void)[] = [];

  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  function run(effect: UpdateEffect) {
    switch (effect.kind) {
      case 'warn':
        options.warn(effect.message);
        break;
      case 'onReady':
        options.onReady(effect.version);
        break;
      case 'ask':
        void options.ask(effect.version).then(
          (yes) => dispatch({ kind: 'askAnswered', version: effect.version, yes }),
          () => dispatch({ kind: 'askAnswered', version: effect.version, yes: false }),
        );
        break;
      case 'confirm':
        // A failed question must not strand the version, so it counts as a yes.
        void options.confirmInstall!().then(
          (yes) => dispatch({ kind: 'confirmAnswered', yes }),
          () => dispatch({ kind: 'confirmAnswered', yes: true }),
        );
        break;
      case 'beforeInstall':
        void options.beforeInstall().then(
          () => dispatch({ kind: 'serverStopped' }),
          (error) => dispatch({ kind: 'serverStopped', error: message(error) }),
        );
        break;
      case 'quitAndInstall':
        try {
          // Silent, so the Windows installer does not walk the person through its pages again,
          // and started again afterwards, as "restart" promises.
          updater.quitAndInstall(true, true);
        } catch (error) {
          dispatch({ kind: 'installError', message: message(error) });
        }
        break;
      case 'armInstallTimeout':
        installTimer = setTimeout(() => dispatch({ kind: 'installTimeout' }), installTimeoutMs);
        installTimer.unref?.();
        break;
      case 'installFailed':
        options.onInstallFailed?.(effect.version, effect.message);
        break;
    }
  }

  /** Events that come from effects (answers, timers) queue up, so one step finishes before the next. */
  function dispatch(event: UpdateEvent) {
    queue.push(event);
    if (draining) return;
    draining = true;
    try {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const result = updateStep(state, next, !!options.confirmInstall);
        state = result.state;
        if (state.kind !== 'installing') clearTimeout(installTimer);
        for (const effect of result.effects) run(effect);
      }
    } finally {
      draining = false;
    }
    if (state.kind === 'idle' || state.kind === 'ready' || state.kind === 'installing') {
      for (const resolve of waiting.splice(0)) resolve();
    }
  }

  const install = () =>
    new Promise<void>((resolve) => {
      waiting.push(resolve);
      dispatch({ kind: 'install' });
    });

  updater.on('update-downloaded', (info) => dispatch({ kind: 'downloaded', version: info.version }));
  updater.on('error', (error) => {
    // While installing, an error is the installer failing; otherwise it is a check that failed
    // (offline, GitHub unreachable, an unsigned Mac build) and is tried again later.
    if (state.kind === 'installing') dispatch({ kind: 'installError', message: error.message });
    else options.warn(`update check failed: ${error.message}`);
  });

  const check = () => {
    if (state.kind !== 'idle') return;
    updater.checkForUpdates().catch(() => undefined);
  };
  check();
  const timer = setInterval(check, everyMs);
  timer.unref?.();

  const checkNow = async (): Promise<CheckResult> => {
    if (state.kind !== 'idle') return { status: 'ready', version: state.version };
    try {
      const found = await updater.checkForUpdates();
      const version = found?.updateInfo?.version;
      return found?.isUpdateAvailable && version ? { status: 'downloading', version } : { status: 'current' };
    } catch (error) {
      const text = message(error);
      return { status: 'failed', offline: isOfflineError(text), message: text };
    }
  };

  return {
    install,
    checkNow,
    stop: () => {
      clearInterval(timer);
      clearTimeout(installTimer);
    },
  };
}
