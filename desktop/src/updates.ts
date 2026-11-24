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
  warn: (message: string) => void;
  everyMs?: number;
}

export interface Updates {
  /** Stops the server and restarts into the downloaded version. */
  install(): Promise<void>;
  /** Looks for a new version now, for a person who asked; the answer says what to tell them. */
  checkNow(): Promise<CheckResult>;
  stop(): void;
}

/**
 * Updates from the GitHub releases named by electron-builder's `publish` setting. A new version
 * downloads in the background; the person is asked once whether to restart into it, and a version
 * left waiting installs when the app quits. Once one is waiting there is nothing more to look for
 * until the restart, so the periodic checks stop asking.
 */
export function startUpdates(options: UpdateOptions): Updates {
  const { updater, everyMs = CHECK_EVERY_MS } = options;
  updater.autoDownload = true;
  updater.autoInstallOnAppQuit = true;

  let ready: string | null = null;
  let installing = false;

  const install = async () => {
    if (!ready || installing) return;
    installing = true;
    if (options.confirmInstall && !(await options.confirmInstall().catch(() => true))) {
      installing = false;
      return;
    }
    try {
      await options.beforeInstall();
    } finally {
      // Silent, so the Windows installer does not walk the person through its pages again, and
      // started again afterwards, as "restart" promises.
      updater.quitAndInstall(true, true);
    }
  };

  updater.on('update-downloaded', (info) => {
    if (ready === info.version) return;
    ready = info.version;
    options.onReady(info.version);
    void options.ask(info.version).then((now) => (now ? install() : undefined));
  });
  // A failed check (offline, GitHub unreachable, an unsigned Mac build) is tried again later.
  updater.on('error', (error) => options.warn(`update check failed: ${error.message}`));

  const check = () => {
    if (ready) return;
    updater.checkForUpdates().catch(() => undefined);
  };
  check();
  const timer = setInterval(check, everyMs);
  timer.unref?.();

  const checkNow = async (): Promise<CheckResult> => {
    if (ready) return { status: 'ready', version: ready };
    try {
      const found = await updater.checkForUpdates();
      const version = found?.updateInfo?.version;
      return found?.isUpdateAvailable && version ? { status: 'downloading', version } : { status: 'current' };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { status: 'failed', offline: isOfflineError(message), message };
    }
  };

  return { install, checkNow, stop: () => clearInterval(timer) };
}
