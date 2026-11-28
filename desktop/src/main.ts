import './old-env';
import { copyFileSync, existsSync, lstatSync, readFileSync, readlinkSync, renameSync } from 'node:fs';
import * as fsp from 'node:fs/promises';
import { hostname } from 'node:os';
import * as nodePath from 'node:path';
import { dirname, join } from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  nativeTheme,
  net,
  powerSaveBlocker,
  protocol,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import { pathToFileURL } from 'node:url';
import log from 'electron-log/main';
import { autoUpdater } from 'electron-updater';
import { accountClient, AccountError, isConnectLink, WEBSITE, type ServerEntry } from './account';
import {
  BOTS_HOST,
  BOTS_ORIGIN,
  BOTS_SCHEME,
  botsFile,
  botsPolicy,
  botsUrl,
  contentType,
  pageOrigin,
} from './bots-page';
import { BrowserSignIn, readSession, writeSession, type SessionFile } from './sign-in';
import { helperState, macMenuShape, offerStep } from './computer-offer';
import {
  chooseServer,
  LOCAL_ONLY,
  readDesktopConfig,
  setLocal,
  show,
  writeDesktopConfig,
  type DesktopConfig,
} from './desktop-config';
import { canInstall, createInstaller, isAppId, type InstallEnv, type Installer } from './app-install';
import { appWindowUrl, readAppWindowSize, writeAppWindowSize } from './app-windows';
import { createCrashGuard, isCrash } from './crash-guard';
import { DISPLAY_POLL_MS, DisplayHold, keepDisplayOn } from './display-awake';
import { startEgress } from './egress';
import { startHelper } from '@leafbot/shared/windows';
import { readMoveDeclined, runsFromTransientPlace, writeMoveDeclined } from './install-location';
import { readSpellingOn, spellingEntries, spellingLanguages, writeSpellingOn } from './spelling';
import { isLocale } from '@leafbot/shared/i18n';
import { loadLocale, locale, saveLocale, setLocale, t, type DesktopKey } from './i18n';
import { LINK_SCHEMES, linkInArgs, parseLink, type AppLink } from './links';
import { CommandJobs } from './commands';
import {
  type MacGate,
  readCommandsOn,
  readMacOn,
  startMacBridge,
  writeCommandsOn,
  writeMacOn,
} from './mac-bridge';
import { claimQuickKey, isThreadId, quickBounds, quickUrl, readQuickOn, writeQuickOn } from './quick';
import { ServerProcess } from './server-process';
import { newDevice, nodeRtc, openServer, RELAY_URL, ServerLink } from './tunnel-link';
import { compileCacheDir, pruneCompileCaches } from './compile-cache';
import {
  describe as describeLaunch,
  kindOf,
  readHistory,
  withRecord,
  writeHistory,
  type LaunchRecord,
} from './launch-record';
import { isLoadingPage, loadingPageUrl } from './loading-page';
import { startUpdates, type Updates } from './updates';
import { MIN_SIZE, readWindowState, resolveWindowState, writeWindowState } from './window-state';

/**
 * The app was called Yumak Bot before Leaf Bot, and Asistan before that; its bots, chats and settings
 * live in a folder named after it. The newest earlier folder is moved once to the new name so an
 * earlier installation keeps its data.
 */
const EARLIER_DATA = [
  { folder: 'esmworks-yumakbot', name: 'Yumak Bot' },
  { folder: 'esmworks-asistan', name: 'Asistan' },
];

function adoptRenamedData(dir: string): string {
  if (existsSync(dir)) return dir;
  const earlier = EARLIER_DATA.find((e) => existsSync(join(dirname(dir), e.folder)));
  if (!earlier) return dir;
  const before = join(dirname(dir), earlier.folder);
  // Moving the folder under a running copy of the old app would pull its database away mid-write,
  // and starting here would make an empty folder that stops the move for good. So stop and ask.
  if (heldByRunningApp(before)) {
    loadLocale(before, app.getPreferredSystemLanguages());
    dialog.showErrorBox(
      t('error.oldAppTitle', { name: earlier.name }),
      t('error.oldAppRunning', { name: earlier.name }),
    );
    app.exit(0);
    return dir;
  }
  try {
    renameSync(before, dir);
  } catch {
    // Left where it is; the app starts with an empty folder instead.
  }
  return dir;
}

/** Chromium's lock in a data folder links to `host-pid` of the app using it, and stays after a crash. */
function heldByRunningApp(dir: string): boolean {
  try {
    const lock = join(dir, 'SingletonLock');
    if (!lstatSync(lock).isSymbolicLink()) return false;
    const pid = Number(readlinkSync(lock).split('-').pop());
    if (!Number.isInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

// Own data folder, separate from any earlier installation. The internal name stays LeafBot while
// the app bundle is called Leaf Bot: what Electron keys to it, such as the keychain entry for the
// window's encrypted cookies, would otherwise be looked up under a new name. The About panel and the menu
// items that name the app show the product name people see.
app.setName('LeafBot');
app.setAboutPanelOptions({ applicationName: 'Leaf Bot' });
app.setPath(
  'userData',
  process.env.LEAFBOT_DESKTOP_DATA ?? adoptRenamedData(join(app.getPath('appData'), 'esmworks-leafbot')),
);
log.initialize();
log.transports.file.resolvePathFn = () => join(app.getPath('userData'), 'logs', 'main.log');
log.transports.file.level = 'info';

// The page of the account's servers is served from this app's files under its own scheme; it is a
// secure origin of its own, so its device key (WebCrypto, IndexedDB) and WebRTC work as on the web.
protocol.registerSchemesAsPrivileged([
  {
    scheme: BOTS_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, codeCache: true },
  },
]);

const DEFAULT_PORT = 4319;
const userData = app.getPath('userData');
const dataDir = join(userData, 'data');

let win: BrowserWindow | null = null;
/** The small window the global shortcut opens; kept hidden between uses so it opens at once. */
let quickWin: BrowserWindow | null = null;
/** The global shortcut that opens it, or null when another app holds every one we try. */
let quickKey: string | null = null;
let tray: Tray | null = null;
/** This computer's own server, while it runs. */
let server: ServerProcess | null = null;
/** Its address and access key, once it answers. */
let localOrigin: string | null = null;
let localKey: string | null = null;
let config: DesktopConfig = LOCAL_ONLY;
/**
 * Origin of the page the main window shows: this computer's own server, or the page of the
 * account's servers this app serves itself. Each gets a bridge of its own (see `preload.ts` and
 * `preload-bots.ts`).
 */
let origin: string | null = null;
/** This app's session at the account service; null while the person is signed out. */
let accountToken: string | null = null;
/** The account server this computer is offered to, once the offers were started for it. */
let offeredTo: string | null = null;
/** The tunnel to that server, shared by the offers made through it. */
let link: ServerLink | null = null;
/** The servers of the signed-in account, as the account service last listed them. */
let accountServers: ServerEntry[] = [];
/** Asks this computer's server now and then whether a bot works there, while the window shows another. */
let workTimer: ReturnType<typeof setInterval> | null = null;
/** Ends when this computer's server, told to stop, has stopped; null when none is stopping. */
let localStopping: Promise<void> | null = null;
const LOCAL_WORK_POLL_MS = 30_000;
/** Tray status line, kept as a key so it follows a language change. */
let status: { key: DesktopKey; params?: Record<string, string> } = { key: 'status.starting' };
let quitting = false;
let stopped = false;
/** Bots with replies the person has not read, as the page last reported. */
let unread = 0;
/** Keeps the computer from sleeping while a bot works; null while none does. */
let awake: number | null = null;
/** Keeps the screen on while a bot uses this Mac, so its screenshots are not black. */
const display = new DisplayHold(
  () => powerSaveBlocker.start('prevent-display-sleep'),
  (id) => powerSaveBlocker.stop(id),
);
let displayTimer: ReturnType<typeof setInterval> | null = null;
let updates: Updates | null = null;
/** A downloaded version waiting for a restart. */
let updateReady: string | null = null;
/** Ends this computer's offer to be the bots' way out to the web; set while an account server is chosen. */
let stopEgress: (() => void) | null = null;
/** Ends this Mac's offer to the bots of the account server; set while it is offered. */
let stopMac: (() => void) | null = null;
let macGate: MacGate | null = null;
/** Whether a bot uses this Mac now, with the person's yes on it; shown in the menu bar. */
let macInUse = false;

/**
 * This start's stages, in milliseconds since the main process began; kept with the last starts in
 * `launch-history.json` once the page says its chat is drawn (or after LAUNCH_SETTLE_MS).
 */
const launch: {
  marks: Record<string, number>;
  server?: LaunchRecord['server'];
  pageLongTasks?: LaunchRecord['pageLongTasks'];
  done: boolean;
} = { marks: {}, done: false };
const LAUNCH_SETTLE_MS = 30_000;
const PAGE_MARKS = new Set(['first-paint', 'sidebar', 'chat']);
function launchMark(name: string) {
  if (!launch.done) launch.marks[name] ??= Math.round(performance.now());
}
launchMark('main');

/** Keeps this start's stages with the last ones and writes them to the log; once. */
function finishLaunch() {
  if (launch.done) return;
  launch.done = true;
  try {
    const history = readHistory(userData);
    const rec: LaunchRecord = {
      at: new Date().toISOString(),
      version: app.getVersion(),
      kind: kindOf(history, app.getVersion()),
      shown: config.shown === 'local' ? 'local' : 'remote',
      marks: launch.marks,
      ...(launch.server ? { server: launch.server } : {}),
      ...(launch.pageLongTasks ? { pageLongTasks: launch.pageLongTasks } : {}),
    };
    log.info(describeLaunch(rec));
    if (launch.server) log.info(`launch (server): ${JSON.stringify(launch.server)}`);
    writeHistory(userData, withRecord(history, rec));
  } catch (err) {
    log.warn('could not keep the launch times', err);
  }
}

const resources = () => (app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '..'));
const serverEntry = () => {
  // start.mjs keeps the compiled code between starts; a server built before it has only index.mjs.
  const start = join(resources(), 'server', 'dist', 'start.mjs');
  return existsSync(start) ? start : join(resources(), 'server', 'dist', 'index.mjs');
};
const appDir = () => (app.isPackaged ? join(resources(), 'app') : join(resources(), 'app', 'dist'));
/** The web app's `bots` build: the page of the account's servers. */
const botsDir = () =>
  app.isPackaged ? join(resources(), 'bots') : join(resources(), 'app', 'dist-bots', 'bots');
const assets = () => (app.isPackaged ? join(resources(), 'assets') : join(app.getAppPath(), 'assets'));
/**
 * The helper that moves the mouse and types for a bot the person allowed to use this computer: a
 * program built from Swift on macOS, a PowerShell script on Windows. None on other systems.
 */
const personComputer = () => {
  if (process.platform === 'win32') {
    return app.isPackaged
      ? join(resources(), 'person-computer.ps1')
      : join(app.getAppPath(), 'native', 'person-computer.ps1');
  }
  return app.isPackaged
    ? join(resources(), 'person-computer')
    : join(app.getAppPath(), 'dist', 'person-computer');
};
/** This system has a helper for bots to use the computer. */
const helperSystem = () => process.platform === 'darwin' || process.platform === 'win32';

const startLink = linkInArgs(process.argv);
/** A `leafbot://` link waiting for the page to take it (see `links.ts`). */
let pendingLink: AppLink | null = startLink?.kind === 'app' ? null : startLink;
/** A saved app a launcher asked for before this computer's server was up. */
let pendingApp: string | null = startLink?.kind === 'app' ? startLink.id : null;
/** Saved apps open in windows of their own, one per app and server. */
const appWindows = new Map<string, BrowserWindow>();

/** Shows the chat a link names: the window comes forward and the page is told to open it. */
function openLink(link: AppLink | null) {
  if (!link) {
    showWindow();
    return;
  }
  if (link.kind === 'app') {
    openLaunchedApp(link.id);
    return;
  }
  pendingLink = link;
  showWindow();
  // A page already up takes it now; one still loading takes it when it starts.
  if (win && !win.isDestroyed()) win.webContents.send('leafbot:open-link');
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Windows and Linux start a second copy with the link among its arguments; it hands them here.
  app.on('second-instance', (_e, argv) => {
    const back = argv.find((a) => isConnectLink(a));
    if (back) return void signInReturned(back);
    openLink(linkInArgs(argv));
  });
  // macOS hands a link to the running app, or to the app it is starting, as an event.
  app.on('open-url', (e, url) => {
    e.preventDefault();
    if (isConnectLink(url)) {
      if (app.isReady()) void signInReturned(url);
      return;
    }
    const link = parseLink(url);
    if (!link) return;
    if (app.isReady()) openLink(link);
    else if (link.kind === 'app') pendingApp = link.id;
    else pendingLink = link;
  });
  void app.whenReady().then(boot);
}

/**
 * Makes this app the one `leafbot://` links open, and `yumakbot://` links made before the rename.
 * Run from source, Electron needs the app's path.
 */
function registerLinks() {
  // A copy run with a data folder of its own is a second copy beside the installed app, for
  // trying a change: the links stay with the installed app.
  if (process.env.LEAFBOT_DESKTOP_DATA) return;
  for (const scheme of LINK_SCHEMES) {
    if (process.defaultApp && process.argv[1]) {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [join(process.cwd(), process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(scheme);
    }
  }
}

async function boot() {
  launchMark('ready');
  setTimeout(finishLaunch, LAUNCH_SETTLE_MS).unref();
  // Well after the start, not during it: the compiled code of earlier versions goes.
  setTimeout(() => pruneCompileCaches(userData, app.getVersion()), 60_000).unref();
  // A packaged app takes its Dock icon from the bundle; one run from source would show Electron's.
  // icon.png is the tile of assets/icon.icon drawn flat, without the glass macOS adds to the real one.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(assets(), 'icon.png'));
  loadLocale(userData, app.getPreferredSystemLanguages());
  config = readDesktopConfig(userData);
  accountToken = readSession(userData, sessionFile);
  launchMark('config');
  // This computer's server takes the longest to come up, so it starts before the rest is set up
  // and before the window, which it does not need; the window is ready long before it is.
  const local = config.local ? startLocal() : undefined;
  hardenSessions();
  serveBotsPage();
  setUpSpelling();
  registerIpc();
  registerLinks();
  createTray();
  registerQuickKey();
  watchForUpdates();
  await connect(local);
  void offerMove();
}

function saveConfig() {
  try {
    writeDesktopConfig(userData, config);
  } catch (err) {
    log.warn('could not save the servers', err);
  }
}

/**
 * An app opened from a disk image or straight from a download cannot replace itself, so updates
 * would never install. The person is asked once to move it to Applications; a "not now" is kept.
 */
async function offerMove() {
  if (!app.isPackaged || process.platform !== 'darwin') return;
  if (!runsFromTransientPlace(process.platform, process.execPath, app.isInApplicationsFolder())) return;
  if (readMoveDeclined(userData)) return;
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: t('move.title'),
    detail: t('move.detail'),
    buttons: [t('move.move'), t('move.notNow')],
    defaultId: 0,
    cancelId: 1,
  });
  if (response !== 0) {
    try {
      writeMoveDeclined(userData, true);
    } catch (err) {
      log.warn('could not remember the move choice', err);
    }
    return;
  }
  try {
    // On success the app restarts from Applications; the server stops through before-quit.
    if (app.moveToApplicationsFolder()) return;
  } catch (err) {
    log.warn('could not move to Applications', err);
  }
  void dialog.showMessageBox({ type: 'error', message: t('move.failed') });
}

/** The person asked for a check (the menu): the answer is shown, whatever it is. */
async function checkForUpdatesNow() {
  if (!updates) return;
  const result = await updates.checkNow();
  if (result.status === 'failed') {
    log.warn(`update check failed: ${result.message}`);
    await dialog.showMessageBox({
      type: 'warning',
      message: t('update.failed'),
      detail: result.offline ? t('update.failedOffline') : result.message,
    });
  } else if (result.status === 'current') {
    await dialog.showMessageBox({
      type: 'info',
      message: t('update.current'),
      detail: t('update.currentDetail', { version: app.getVersion() }),
    });
  } else if (result.status === 'downloading') {
    await dialog.showMessageBox({
      type: 'info',
      message: t('update.downloading', { version: result.version }),
      detail: t('update.downloadingDetail'),
    });
  } else {
    void updates.install();
  }
}

/** `started` is this computer's server already on its way up, when the app's start began it. */
async function connect(started?: Promise<void>) {
  startOffers();
  pointAtShown();
  void refreshAccountServers();
  if (!config.local) {
    setStatus('status.account');
    // Apps are installed from this computer's own server, which is off: the window opens instead.
    pendingApp = null;
    showWindow();
    return;
  }
  // The account's page opens at once; this computer's own server comes up behind it.
  if (config.shown !== 'local') showWindow();
  // This computer's own is shown: the window opens now and says the server is starting.
  else if (!pendingApp) showLoadingWindow();
  await (started ?? startLocal());
}

/** Points the window's origin at what it shows; no origin while this computer's server is not up. */
function pointAtShown() {
  origin = config.shown === 'account' ? BOTS_ORIGIN : localOrigin;
}

/** The page the window loads: the account's servers, at the chosen one when there is one. */
const windowUrl = () => (config.shown === 'account' ? botsUrl(config.server) : origin);

/** The device key and WebRTC for the tunnels; made when the first one is needed, once per run. */
let device: ReturnType<typeof newDevice> | null = null;
let rtc: ReturnType<typeof nodeRtc> | null = null;

/** The account service, with this app's own session. */
const account = accountClient({ fetch: (input, init) => fetch(input, init), token: () => accountToken });

/**
 * Offers this computer to the account server the person chose: as the bots' way out to the web,
 * and the Mac when the person turned that on. Only that server gets it. It is reached through a
 * tunnel the person's own account opens, with this app's session at the account, so no address or
 * key is kept here.
 */
function startOffers() {
  const id = config.server;
  if (id === offeredTo) return;
  offeredTo = id;
  stopEgress?.();
  stopEgress = null;
  stopMacOffer();
  link?.stop();
  link = null;
  if (!id) return;
  const mine = new ServerLink({
    serverId: id,
    account,
    session: async () => accountToken,
    open: async (server, onEnd) => {
      device ??= newDevice();
      rtc ??= nodeRtc();
      return openServer(server, {
        account,
        device: await device,
        relayUrl: RELAY_URL,
        rtc: await rtc,
        language: locale(),
        onEnd,
      });
    },
    log: (level, line) => log[level](line),
  });
  link = mine;
  stopEgress = startEgress({
    tunnel: (fn) => mine.subscribe(fn),
    device: deviceName(),
    log: (level, line) => log[level](line),
  });
  startMac();
  mine.start();
}

/** How this computer is named in the server's settings. */
const deviceName = () => hostname().replace(/\.local$/, '');

/** A server's name as the account lists it (the chosen one by default), for a question on this computer. */
function serverLabel(id = config.server): string {
  const name = accountServers.find((s) => s.id === id)?.name ?? '';
  return (
    name
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .trim()
      .slice(0, 60) || 'Leaf Bot'
  );
}

/** The account's servers, for the menu; empty while the person is signed out of the account. */
async function refreshAccountServers() {
  try {
    accountServers = await account.servers();
  } catch (err) {
    // Out of reach keeps the last list; an answer that says signed out empties it.
    if (!(err instanceof AccountError) || (err.status !== 401 && err.status !== 403)) return;
    accountServers = [];
  }
  rebuildMenu();
}

async function startLocal() {
  // A server still stopping holds the port and the data folder. With none stopping the server
  // starts before this returns, not a turn later, so the app's start can go on meanwhile.
  if (localStopping) await localStopping;
  if (server) return;
  setStatus('status.serverStarting');
  const proc = new ServerProcess({
    entry: serverEntry(),
    execPath: process.execPath,
    dataDir,
    appDir: appDir(),
    port: DEFAULT_PORT,
    log: (level, line) => {
      // The server's own start stages, printed once after its ready line.
      if (line.startsWith('LEAFBOT_TIMINGS ')) {
        try {
          launch.server ??= JSON.parse(line.slice('LEAFBOT_TIMINGS '.length)) as LaunchRecord['server'];
        } catch {
          // An older server's line, or none: the start is kept without it.
        }
        return;
      }
      log[level](`[sunucu] ${line}`);
    },
    env: {
      // The compiled server code is kept between starts (see compile-cache.ts, server/build.mjs).
      LEAFBOT_COMPILE_CACHE: compileCacheDir(userData, app.getVersion(), 'server'),
      // Development only: run the server with the offline test engine.
      ...(!app.isPackaged && process.env.LEAFBOT_ENGINE
        ? { LEAFBOT_ENGINE: process.env.LEAFBOT_ENGINE }
        : {}),
      ...(helperSystem() && existsSync(personComputer())
        ? { LEAFBOT_PERSON_COMPUTER: personComputer() }
        : {}),
    },
  });
  server = proc;
  proc.on('restarted', (url: string) => {
    if (server !== proc) return;
    localOrigin = url;
    setStatus('status.running');
    if (config.shown !== 'local') return;
    origin = url;
    void win?.loadURL(url);
  });
  proc.on('exit', (e: { expected: boolean }) => {
    if (!e.expected && server === proc) setStatus('status.restarting');
  });
  proc.on('gave-up', () => {
    if (server !== proc) return;
    setStatus('status.stopped');
    void dialog.showMessageBox({
      type: 'error',
      message: t('dialog.gaveUp'),
      detail: t('dialog.gaveUpDetail'),
    });
  });
  try {
    launchMark('server-start');
    const url = await proc.start();
    launchMark('server-ready');
    if (server !== proc) return;
    localOrigin = url;
    localKey = readFileSync(join(dataDir, 'access-key'), 'utf8').trim();
    setStatus('status.running');
    watchLocalWork();
    if (config.shown === 'local') pointAtShown();
    // Started from an app's launcher: that app opens, in its own window, rather than the chat.
    if (pendingApp) openLaunchedApp(pendingApp);
    else if (config.shown === 'local') showWindow();
  } catch (err) {
    if (server !== proc) return;
    log.error('server failed to start', err);
    setStatus('status.failed');
    // The window that said the server is starting would wait forever: it goes, as before.
    if (win && !win.isDestroyed() && isLoadingPage(win.webContents.getURL())) closeWindow();
    // Before, the box only had OK and the app stayed in the menu bar with nothing open.
    for (;;) {
      const { response } = await dialog.showMessageBox({
        type: 'error',
        message: t('dialog.failed'),
        detail: (err as Error).message,
        // Closing leaves the app in the menu bar, where another server can be chosen.
        buttons: [t('dialog.retry'), t('menu.showLogs'), t('dialog.close')],
        defaultId: 0,
        cancelId: 2,
      });
      if (response === 1) {
        shell.showItemInFolder(log.transports.file.getFile().path);
        continue;
      }
      if (response === 0 && server === proc) {
        await stopLocal();
        await startLocal();
      }
      return;
    }
  }
}

async function stopLocal() {
  const proc = server;
  server = null;
  localOrigin = null;
  localKey = null;
  if (workTimer) clearInterval(workTimer);
  workTimer = null;
  setAwake(false);
  const stopping = proc?.stop() ?? Promise.resolve();
  const settled = stopping.catch(() => {});
  localStopping = settled;
  void settled.then(() => {
    if (localStopping === settled) localStopping = null;
  });
  await stopping;
  if (!config.local) setStatus('status.account');
}

/**
 * Makes a new choice real: this computer's server starts or stops, the chosen account server is
 * offered this computer, and the window moves to what it now shows. The choice is kept.
 * Changes go one after another, each made from the choice the one before left, so a quick off and
 * on never starts a second server beside one still stopping. `keepWindow` is for a choice the page
 * in the window made about the server it already shows, which needs no new page.
 */
function apply(change: (cfg: DesktopConfig) => DesktopConfig, keepWindow = false): Promise<void> {
  applying = applying
    .then(() => applyNow(change(config), keepWindow))
    .catch((err: unknown) => log.warn('could not change the servers', err));
  return applying;
}
let applying: Promise<void> = Promise.resolve();

async function applyNow(next: DesktopConfig, keepWindow = false) {
  const before = config;
  config = next;
  saveConfig();
  startOffers();
  if (before.local && !next.local) await stopLocal();
  const reshow =
    !keepWindow &&
    (before.shown !== next.shown || (next.shown === 'account' && before.server !== next.server));
  if (reshow) {
    // The old page belongs to another origin; start fresh. Apps of this computer's server stay.
    closeQuick();
    closeAppWindows(localOrigin);
    closeWindow();
    pointAtShown();
    showWindow();
  }
  if (!before.local && next.local) await startLocal();
  rebuildMenu();
}

function closeWindow() {
  if (win && !win.isDestroyed()) {
    quitting = true;
    win.close();
    quitting = false;
  }
  win = null;
}

/**
 * Only an installed app updates itself: one run from source has no release to compare with. On
 * Linux only the AppImage can replace itself; a .deb is updated through the package manager.
 * LEAFBOT_DISABLE_UPDATES turns it off, e.g. while testing a packaged build.
 */
function watchForUpdates() {
  if (!app.isPackaged || process.env.LEAFBOT_DISABLE_UPDATES) return;
  if (
    process.platform === 'linux'
      ? !process.env.APPIMAGE
      : process.platform !== 'darwin' && process.platform !== 'win32'
  )
    return;
  autoUpdater.logger = log;
  updates = startUpdates({
    updater: autoUpdater,
    ask: async (version) => {
      const { response } = await dialog.showMessageBox({
        type: 'info',
        message: t('update.readyTitle', { version }),
        detail: t('update.readyDetail'),
        buttons: [t('update.restart'), t('update.later')],
        defaultId: 0,
        cancelId: 1,
      });
      return response === 0;
    },
    confirmInstall: async () => {
      const count = await runningBotCount();
      if (count < 1) return true;
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: t('dialog.quitWorking', { count }),
        detail: t('update.workingDetail'),
        buttons: [t('update.restart'), t('update.later')],
        defaultId: 1,
        cancelId: 1,
      });
      return response === 0;
    },
    // The installer replaces the app's files, the server's among them, so the server is stopped
    // the usual way first instead of being cut off mid-write.
    beforeInstall: async () => {
      quitting = true;
      setStatus('status.quitting');
      if (awake !== null) powerSaveBlocker.stop(awake);
      awake = null;
      stopDisplayWatch();
      // Stopped as when the person turns it off, so it can be started again if the install fails.
      await stopLocal();
      stopped = true;
    },
    // The installer ran but the app is still here: what beforeInstall stopped comes back.
    onInstallFailed: (version, message) => {
      log.warn(`update ${version} did not install: ${message}`);
      quitting = false;
      stopped = false;
      if (config.local) void startLocal();
      else setStatus('status.account');
      rebuildMenu();
      void dialog.showMessageBox({ type: 'error', message: t('update.failed'), detail: message });
    },
    onReady: (version) => {
      updateReady = version;
      rebuildMenu();
    },
    warn: (message) => log.warn(message),
  });
}

const crashGuard = createCrashGuard();

function showWindow() {
  if (!origin) return;
  const target = windowUrl() ?? origin;
  if (win && !win.isDestroyed()) {
    // The window opened before its server was up, or shows a server that moved to another port.
    const shown = win.webContents.getURL();
    if (isLoadingPage(shown) || (shown && pageOrigin(shown) !== pageOrigin(target))) {
      void win.loadURL(target);
    }
    win.show();
    win.focus();
    return;
  }
  createMainWindow();
  void win!.loadURL(target);
}

/** Opens the main window on a page that says this computer's server is starting. */
function showLoadingWindow() {
  if (win && !win.isDestroyed()) return;
  const dark = nativeTheme.shouldUseDarkColors;
  createMainWindow();
  void win!.loadURL(
    loadingPageUrl({
      background: dark ? '#1b1b1b' : '#fafafa',
      text: t('status.serverStarting'),
      name: 'Leaf Bot',
      dark,
      frameless: process.platform === 'darwin',
    }),
  );
}

function createMainWindow() {
  const primary = screen.getPrimaryDisplay();
  const screens = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)];
  const restored = resolveWindowState(
    readWindowState(userData),
    screens.map((d) => d.workArea),
  );
  win = new BrowserWindow({
    ...restored.bounds,
    minWidth: MIN_SIZE.width,
    minHeight: MIN_SIZE.height,
    title: 'Leaf Bot',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1b' : '#fafafa',
    show: false,
    // On macOS the page draws to the top edge; the window buttons sit in the
    // sidebar's top row, centred on its buttons, and the page marks drag areas.
    ...(process.platform === 'darwin' && {
      titleBarStyle: 'hidden' as const,
      trafficLightPosition: { x: 20, y: 17 },
    }),
    webPreferences: {
      // The page of the account's servers gets its own bridge: the account calls, nothing of this
      // computer's server.
      preload: join(__dirname, config.shown === 'local' ? 'preload.cjs' : 'preload-bots.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  if (restored.maximized) win.maximize();
  launchMark('window');
  rememberWindowState(win);
  showUnread();
  win.once('ready-to-show', () => {
    launchMark('window-shown');
    win?.show();
  });
  win.webContents.on('did-finish-load', () => {
    if (win && !isLoadingPage(win.webContents.getURL())) launchMark('page-loaded');
  });
  win.webContents.on('context-menu', (_e, params) => showContextMenu(win!, params));
  // A dead page is reloaded; one that dies again and again is left to the person to decide.
  win.webContents.on('render-process-gone', (_e, details) => {
    log.error(`window renderer gone: ${details.reason} (exit code ${details.exitCode})`);
    if (!isCrash(details.reason)) return;
    if (crashGuard.record() === 'reload') {
      win?.webContents.reload();
      return;
    }
    void dialog
      .showMessageBox({
        type: 'error',
        message: t('dialog.pageCrashed'),
        detail: t('dialog.pageCrashedDetail'),
        buttons: [t('dialog.reload'), t('dialog.quit')],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) win?.webContents.reload();
        else app.quit();
      });
  });
  // Closing the window keeps the bots running; only "Quit" stops the server.
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win?.hide();
    }
  });
}

/**
 * A saved app a launcher opened. Launchers are installed from this computer's own server's page,
 * so the app opens there; until that server is up, it waits.
 */
function openLaunchedApp(id: string) {
  if (localOrigin) {
    pendingApp = null;
    openAppWindow(id, localOrigin);
    return;
  }
  if (config.local) pendingApp = id;
  else showWindow();
}

/** Opens a saved app in a window of its own, or brings its window forward. */
function openAppWindow(id: string, at: string) {
  const key = `${at}#${id}`;
  const open = appWindows.get(key);
  if (open && !open.isDestroyed()) {
    if (open.isMinimized()) open.restore();
    open.show();
    open.focus();
    return;
  }
  const size = readAppWindowSize(userData, id);
  const appWin = new BrowserWindow({
    ...size,
    minWidth: 360,
    minHeight: 280,
    title: 'Leaf Bot',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1b' : '#fafafa',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  appWindows.set(key, appWin);
  appWin.once('ready-to-show', () => appWin.show());
  appWin.webContents.on('context-menu', (_e, params) => showContextMenu(appWin, params));
  appWin.on('close', () => {
    if (!appWin.isMaximized() && !appWin.isFullScreen()) {
      const [width, height] = appWin.getSize();
      writeAppWindowSize(userData, id, { width: width!, height: height! });
    }
  });
  appWin.on('closed', () => {
    if (appWindows.get(key) === appWin) appWindows.delete(key);
  });
  void appWin.loadURL(appWindowUrl(at, id));
}

/** Closes every app window of a server whose page is no longer shown. */
function closeAppWindows(except?: string | null) {
  for (const [key, w] of appWindows) {
    if (except && key.startsWith(`${except}#`)) continue;
    if (!w.isDestroyed()) w.close();
    appWindows.delete(key);
  }
}

/** The launchers of saved apps on this computer; null where none can be made (run from source). */
let installer: Installer | null | undefined;
function appInstaller(): Installer | null {
  if (installer !== undefined) return installer;
  const env: InstallEnv = {
    platform: process.platform,
    path: nodePath,
    home: app.getPath('home'),
    userData,
    appData: process.platform === 'win32' ? app.getPath('appData') : undefined,
    desktopDir: () => {
      try {
        return app.getPath('desktop');
      } catch {
        return null;
      }
    },
    dataHome: process.env.XDG_DATA_HOME,
    // An AppImage runs from a mount that changes each time: the launcher starts the file itself.
    executable: process.env.APPIMAGE ?? process.execPath,
    hostBundleId: 'com.esmworks.leafbot',
    hostIcon: launcherIcon(),
    fs: fsp as unknown as InstallEnv['fs'],
    shell: process.platform === 'win32' ? shell : undefined,
    log: (line) => log.info(`app launchers: ${line}`),
  };
  installer = app.isPackaged && canInstall(env) ? createInstaller(env) : null;
  return installer;
}

/**
 * Leaf Bot's icon for the launchers: the bundle's own on macOS; on Linux a copy in the data folder,
 * since an AppImage's files are gone once it quits. Windows shows the executable's.
 */
function launcherIcon(): string | null {
  try {
    if (process.platform === 'darwin') {
      const icns = join(process.resourcesPath, 'icon.icns');
      return existsSync(icns) ? icns : null;
    }
    if (process.platform === 'linux') {
      const kept = join(userData, 'app-launcher-icon.png');
      copyFileSync(join(assets(), 'icon.png'), kept);
      return kept;
    }
  } catch (err) {
    log.warn('no icon for app launchers', err);
  }
  return null;
}

/** Saves the window's place and size as it changes, so the next start opens it there. */
function rememberWindowState(target: BrowserWindow) {
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (target.isDestroyed()) return;
    writeWindowState(userData, { bounds: target.getNormalBounds(), maximized: target.isMaximized() });
  };
  const later = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, 300);
  };
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const)
    target.on(event as 'resize', later);
  target.on('close', flush);
}

/** The unread count on the Dock icon (macOS), the launcher (Linux) or the taskbar button (Windows). */
function showUnread() {
  if (process.platform === 'win32') {
    if (!win || win.isDestroyed()) return;
    const icon =
      unread > 0 ? nativeImage.createFromPath(join(assets(), 'icon.png')).resize({ width: 16 }) : null;
    win.setOverlayIcon(icon && !icon.isEmpty() ? icon : null, unread > 0 ? String(unread) : '');
    return;
  }
  app.setBadgeCount(unread);
}

/**
 * The right-click menu a page gets in a browser: edit actions where text can be edited or is
 * selected, and copying a link's address or an image. Electron shows none by itself.
 */
function showContextMenu(target: BrowserWindow, params: Electron.ContextMenuParams) {
  const items: Electron.MenuItemConstructorOptions[] = [];
  const { editFlags } = params;
  if (params.isEditable) {
    const spelling = spellingEntries(params.misspelledWord, params.dictionarySuggestions, {
      none: t('spelling.none'),
      learn: t('spelling.learn'),
    });
    for (const e of spelling) {
      items.push({
        label: e.label,
        enabled: e.enabled ?? true,
        click: () => {
          if (e.replace) target.webContents.replaceMisspelling(e.replace);
          if (e.learn) target.webContents.session.addWordToSpellCheckerDictionary(e.learn);
        },
      });
    }
    if (spelling.length) items.push({ type: 'separator' });
    items.push(
      { role: 'undo', label: t('edit.undo'), enabled: editFlags.canUndo },
      { role: 'redo', label: t('edit.redo'), enabled: editFlags.canRedo },
      { type: 'separator' },
      { role: 'cut', label: t('edit.cut'), enabled: editFlags.canCut },
      { role: 'copy', label: t('edit.copy'), enabled: editFlags.canCopy },
      { role: 'paste', label: t('edit.paste'), enabled: editFlags.canPaste },
      { role: 'selectAll', label: t('edit.selectAll') },
      { type: 'separator' },
      {
        label: t('spelling.check'),
        type: 'checkbox',
        checked: session.defaultSession.isSpellCheckerEnabled(),
        click: (item) => setSpelling(item.checked),
      },
    );
  } else if (params.selectionText.trim()) {
    items.push({ role: 'copy', label: t('edit.copy') });
  }
  if (params.linkURL && /^https?:/i.test(params.linkURL)) {
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: t('edit.copyLink'), click: () => clipboard.writeText(params.linkURL) });
  }
  if (params.mediaType === 'image') {
    if (items.length) items.push({ type: 'separator' });
    items.push({
      label: t('edit.copyImage'),
      click: () => target.webContents.copyImageAt(params.x, params.y),
    });
  }
  if (items.length) Menu.buildFromTemplate(items).popup({ window: target });
}

/**
 * Takes the first free global shortcut for the quick window, unless the person turned it off in
 * the tray menu; the menu shows which one it is.
 */
function registerQuickKey() {
  if (quickKey) globalShortcut.unregister(quickKey);
  quickKey = readQuickOn(userData) ? claimQuickKey((key) => globalShortcut.register(key, toggleQuick)) : null;
  if (!quickKey && readQuickOn(userData)) log.warn('no global shortcut was free for the quick window');
  rebuildMenu();
}

/** Opens the quick window over whatever app is in front, or puts it away when it is already up. */
function toggleQuick() {
  // The quick window is a page of this computer's own server and needs the bridge to put itself away.
  if (!origin || config.shown !== 'local') return;
  if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible() && quickWin.isFocused()) {
    quickWin.hide();
    return;
  }
  const bounds = quickBounds(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea);
  if (!quickWin || quickWin.isDestroyed()) {
    quickWin = new BrowserWindow({
      ...bounds,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      title: 'Leaf Bot',
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1b' : '#fafafa',
      webPreferences: {
        preload: join(__dirname, 'preload.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: true,
      },
    });
    // It floats over full-screen apps too, on whichever desktop the person is on.
    quickWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    // Clicking elsewhere puts it away, as a launcher does; closing it only hides it.
    quickWin.on('blur', () => quickWin?.hide());
    quickWin.on('close', (e) => {
      if (!quitting) {
        e.preventDefault();
        quickWin?.hide();
      }
    });
    quickWin.webContents.on('context-menu', (_e, params) => showContextMenu(quickWin!, params));
    quickWin.once('ready-to-show', () => {
      quickWin?.show();
      quickWin?.focus();
    });
    void quickWin.loadURL(quickUrl(origin));
    return;
  }
  quickWin.setBounds(bounds);
  quickWin.show();
  quickWin.focus();
  // The page refetches and starts again from the top each time it is shown.
  quickWin.webContents.send('leafbot:quick-shown');
}

function closeQuick() {
  if (quickWin && !quickWin.isDestroyed()) {
    quitting = true;
    quickWin.close();
    quitting = false;
  }
  quickWin = null;
}

/** The pages this app shows: this computer's own server's, and the page of the account's servers. */
function isAppOrigin(url: string) {
  const at = pageOrigin(url);
  return !!at && (at === BOTS_ORIGIN || (!!localOrigin && at === localOrigin));
}

/** From the page of the account's servers, shown in the main window. */
function fromBotsPage(e: IpcMainInvokeEvent) {
  return (
    !!win &&
    !win.isDestroyed() &&
    e.sender === win.webContents &&
    config.shown === 'account' &&
    pageOrigin(e.senderFrame?.url ?? '') === BOTS_ORIGIN
  );
}

/**
 * From the page of this computer's own server, shown in the main window: the only page that may
 * use the bridge to this app. The page of the account's servers, shown in the same window, has a
 * bridge of its own (`preload-bots.ts`).
 */
function fromMainPage(e: IpcMainInvokeEvent) {
  try {
    return (
      config.shown === 'local' &&
      !!localOrigin &&
      origin === localOrigin &&
      new URL(e.senderFrame?.url ?? '').origin === localOrigin
    );
  } catch {
    return false;
  }
}
/** From a saved app's own window, showing the page of this computer's server. */
function fromLocalAppWindow(e: IpcMainInvokeEvent) {
  if (!localOrigin) return false;
  try {
    const sent = new URL(e.senderFrame?.url ?? '').origin === localOrigin;
    return sent && [...appWindows.values()].some((w) => !w.isDestroyed() && w.webContents === e.sender);
  } catch {
    return false;
  }
}
const isAppName = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0 && v.length <= 120;

function registerIpc() {
  ipcMain.handle('leafbot:access-key', (e) => (fromMainPage(e) || fromLocalAppWindow(e) ? localKey : null));
  // Saved apps: a window of their own, from any server's page; launchers on this computer only
  // from this computer's own server's page, whose apps they open.
  ipcMain.handle('leafbot:open-app', (e, id: unknown) => {
    if (fromMainPage(e) && origin && isAppId(id)) openAppWindow(id, origin);
  });
  ipcMain.handle('leafbot:app-installs', (e) =>
    fromMainPage(e) ? (appInstaller()?.installed() ?? null) : null,
  );
  ipcMain.handle('leafbot:app-install', async (e, id: unknown, name: unknown) => {
    if (!fromMainPage(e) || !isAppId(id) || !isAppName(name)) return null;
    return appInstaller()?.install(id, name.trim()) ?? null;
  });
  ipcMain.handle('leafbot:app-uninstall', async (e, id: unknown) => {
    if (fromMainPage(e) && isAppId(id)) await appInstaller()?.uninstall(id);
  });
  ipcMain.handle('leafbot:app-desktop', async (e, id: unknown, name: unknown, on: unknown) => {
    if (!fromMainPage(e) || !isAppId(id) || !isAppName(name) || typeof on !== 'boolean') return null;
    return appInstaller()?.setDesktop(id, name.trim(), on) ?? null;
  });
  // The chat a `leafbot://` link named, once: the page asks when it starts and when told to.
  ipcMain.handle('leafbot:take-link', (e) => {
    if (!fromMainPage(e)) return null;
    const link = pendingLink;
    pendingLink = null;
    return link;
  });
  // The quick window: putting itself away, opening a conversation in the main window, and the
  // shortcut that opens it, for the app to show.
  ipcMain.handle('leafbot:quick-hide', (e) => {
    if (fromMainPage(e)) quickWin?.hide();
  });
  ipcMain.handle('leafbot:open-thread', (e, id: unknown) => {
    if (!fromMainPage(e) || !isThreadId(id)) return;
    quickWin?.hide();
    openLink({ kind: 'thread', id });
  });
  ipcMain.handle('leafbot:quick-key', (e) => (fromMainPage(e) ? quickKey : null));
  // The page of this computer's server offers the way to the account's servers, which the window
  // then shows.
  ipcMain.handle('leafbot:open-account', async (e) => {
    if (fromMainPage(e)) await apply((c) => show(c, 'account'));
  });
  // The page of the account's servers: the account calls, made here with this app's session, and
  // the sign-in in the person's browser. Answers are plain objects, so the page keeps the status.
  // `ends` is for the calls whose 401 says the service no longer takes this session (signed out
  // elsewhere, or expired); another call's 401 may be about that call alone.
  const answer = async <T>(e: IpcMainInvokeEvent, call: () => Promise<T>, ends = true) => {
    if (!fromBotsPage(e)) return { ok: false, status: 403, code: 'forbidden' };
    try {
      return { ok: true, data: await call() };
    } catch (err) {
      if (err instanceof AccountError) {
        if (ends && err.status === 401) setAccountSession(null);
        return { ok: false, status: err.status, code: err.code };
      }
      return { ok: false, status: 0, code: 'failed' };
    }
  };
  ipcMain.handle('leafbot:account-servers', (e) =>
    answer(e, async () => {
      const servers = await account.servers();
      accountServers = servers;
      rebuildMenu();
      return servers;
    }),
  );
  ipcMain.handle('leafbot:account-ticket', (e, serverId: unknown, jkt: unknown) =>
    typeof serverId === 'string' && typeof jkt === 'string' && serverId.length <= 200 && jkt.length <= 200
      ? answer(e, () => account.ticket(serverId, jkt))
      : { ok: false, status: 400, code: 'invalid' },
  );
  // This computer for the bots of the server the page shows: what the page needs to say why the
  // server sees no computer, and the way to offer it from there. Turning it on asks on this computer
  // first, in the app's own dialog, so the page alone cannot do it.
  ipcMain.handle('leafbot:computer-state', (e) => (fromBotsPage(e) ? computerState() : null));
  ipcMain.handle('leafbot:computer-offer', async (e, serverId: unknown) => {
    if (!fromBotsPage(e) || typeof serverId !== 'string') return null;
    const step = offerStep({
      helper: helperFound(),
      listed: accountServers.map((s) => s.id),
      chosen: config.server,
      on: readMacOn(userData),
      serverId,
    });
    if (step.do === 'refuse') return computerState();
    if (step.do === 'ask' && !(await confirmOffer(serverId, step.moveFrom))) return computerState();
    writeMacOn(userData, true);
    if (config.server === serverId) startMac();
    else await apply((c) => chooseServer(c, serverId), true);
    rebuildMenu();
    return computerState();
  });
  ipcMain.handle('leafbot:account-connect-code', (e) => answer(e, () => account.connectCode(), false));
  ipcMain.handle('leafbot:account-sign-in', (e) =>
    fromBotsPage(e) ? browserSignIn.start() : { ok: false, reason: 'failed' },
  );
  // Adding a server and the rest of the account's pages are the website's, in the person's browser.
  ipcMain.handle('leafbot:account-website', (e, path: unknown) => {
    if (!fromBotsPage(e) || typeof path !== 'string' || !/^\/[a-z0-9/_-]*$/i.test(path)) return;
    const prefix = locale() === 'tr' ? '/tr' : '';
    void shell.openExternal(`${WEBSITE}${prefix}${path}`);
  });
  // The app reports its language so the menu and windows match it.
  ipcMain.handle('leafbot:set-locale', (e, next: unknown) => {
    if (!(fromMainPage(e) || fromBotsPage(e)) || !isLocale(next) || next === locale()) return;
    setLocale(next);
    try {
      saveLocale(userData, next);
    } catch (err) {
      log.warn('dil kaydedilemedi', err);
    }
    rebuildMenu();
  });
  ipcMain.handle('leafbot:set-unread', (e, count: unknown) => {
    if (!(fromMainPage(e) || fromBotsPage(e))) return;
    const n =
      typeof count === 'number' && Number.isFinite(count) ? Math.min(999, Math.max(0, Math.trunc(count))) : 0;
    if (n === unread) return;
    unread = n;
    showUnread();
  });
  // The page says when it drew its first screen, its sidebar and its chat, for the launch times.
  ipcMain.handle('leafbot:launch-mark', (e, name: unknown, longTasks?: unknown) => {
    if (!fromMainPage(e) || typeof name !== 'string' || !PAGE_MARKS.has(name)) return;
    launchMark(`page-${name}`);
    if (
      longTasks &&
      typeof longTasks === 'object' &&
      typeof (longTasks as { count?: unknown }).count === 'number' &&
      typeof (longTasks as { totalMs?: unknown }).totalMs === 'number'
    ) {
      const { count, totalMs } = longTasks as { count: number; totalMs: number };
      launch.pageLongTasks = { count, totalMs: Math.round(totalMs) };
    }
    if (name === 'chat') finishLaunch();
  });
  // The page of this computer's server says when its bots work (see `setAwake`).
  ipcMain.handle('leafbot:set-busy', (e, busy: unknown) => {
    if (!fromMainPage(e) || config.shown !== 'local') return;
    setAwake(busy === true);
  });
  ipcMain.handle('leafbot:open-at-login', (e, on?: unknown) => {
    if (!fromMainPage(e)) return null;
    if (typeof on === 'boolean') {
      app.setLoginItemSettings({ openAtLogin: on });
      rebuildMenu();
    }
    return app.getLoginItemSettings().openAtLogin;
  });
  ipcMain.handle('leafbot:show-logs', (e) => {
    if (fromMainPage(e)) shell.showItemInFolder(log.transports.file.getFile().path);
  });
}

/**
 * Keeps the computer awake while a bot works on this computer's server, so a routine or a long
 * reply is not cut short by sleep. The screen may still turn off, except while a bot is using this
 * Mac (see `startDisplayWatch`).
 */
function setAwake(busy: boolean) {
  if (busy && awake === null) awake = powerSaveBlocker.start('prevent-app-suspension');
  if (busy) startDisplayWatch();
  if (!busy && awake !== null) {
    powerSaveBlocker.stop(awake);
    awake = null;
  }
  if (!busy) stopDisplayWatch();
}

/**
 * While the window shows the account's page, that page cannot say whether this computer's bots
 * work: this computer's server is asked now and then instead.
 */
function watchLocalWork() {
  if (workTimer) return;
  workTimer = setInterval(() => {
    if (config.shown === 'local' || !server?.running) return;
    void runningBotCount().then((count) => {
      if (config.shown !== 'local' && server?.running) setAwake(count > 0);
    });
  }, LOCAL_WORK_POLL_MS);
}

/**
 * While bots work, asks the server now and then whether one is using this Mac, and keeps the screen
 * on for that time only: a sleeping display makes the bot's screenshots black.
 */
function startDisplayWatch() {
  if (displayTimer) return;
  const tick = async () => {
    if (!server?.running) return;
    const { personComputerIdleMs } = await localTurns();
    if (displayTimer) display.set('local', keepDisplayOn(personComputerIdleMs));
  };
  displayTimer = setInterval(() => void tick(), DISPLAY_POLL_MS);
}

function stopDisplayWatch() {
  if (displayTimer) clearInterval(displayTimer);
  displayTimer = null;
  display.set('local', false);
}

/**
 * Words misspelled in a field the person types in are underlined, with what they could be on a
 * right-click. On by default; turned off from the same menu, and remembered.
 */
function setUpSpelling() {
  const ses = session.defaultSession;
  ses.setSpellCheckerEnabled(readSpellingOn(userData));
  // macOS uses the system's checker, which picks the language itself and needs no list.
  if (process.platform !== 'darwin') {
    const langs = spellingLanguages(app.getPreferredSystemLanguages(), ses.availableSpellCheckerLanguages);
    if (langs.length) ses.setSpellCheckerLanguages(langs);
  }
}

function setSpelling(on: boolean) {
  writeSpellingOn(userData, on);
  session.defaultSession.setSpellCheckerEnabled(on);
  rebuildMenu();
}

function hardenSessions() {
  // Everything is refused except, for the app's own page, writing to the clipboard (copying a
  // picture has no other route there), going full screen (the full-screen button of a video in the
  // chat asks for it) and the microphone alone (speaking a message instead of typing it). The camera
  // and the screen stay closed. Only the top frame counts: a frame inside the page (a bot's page, a
  // connected app) gets nothing, even one served from the same address.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => {
    if (!details.isMainFrame || !isAppOrigin(details.requestingUrl)) return cb(false);
    if (perm === 'clipboard-sanitized-write' || perm === 'fullscreen') return cb(true);
    const media = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    cb(perm === 'media' && media.length > 0 && media.every((m) => m === 'audio'));
  });
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    // A page stays on its own origin, which is this computer's server or the page of the account's
    // servers and nothing else: the origin is compared whole, as a prefix would also let
    // http://127.0.0.1:4319.evil.net through. Anything else (the website, a link in a reply) opens in
    // the person's browser, which a redirect is held to as well.
    const stay = (e: { preventDefault(): void }, url: string) => {
      // A page not loaded yet has no origin to stay on.
      const here = pageOrigin(contents.getURL());
      if (isAppOrigin(url) && here !== null && pageOrigin(url) === here) return;
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    };
    contents.on('will-navigate', (e, url) => stay(e, url));
    contents.on('will-redirect', (e, url) => stay(e, url));
  });
}

/**
 * This computer can be offered to the account server's bots: a Mac or a Windows computer, with its
 * helper in place, with an account server chosen.
 */
const canOfferMac = () => helperFound() === 'ok' && !!link;
const helperFound = () => helperState(helperSystem(), helperSystem() && existsSync(personComputer()));

/**
 * What the page of the account's servers is told about this computer: whether it can be offered
 * at all, the server it is offered to (null while none was chosen), and whether the person turned
 * the offer on.
 */
const computerState = () => ({ helper: helperFound(), server: config.server, on: readMacOn(userData) });

/**
 * Asks on this computer before it is offered to the bots of `serverId`, saying which server it
 * leaves (`previous`); default is no.
 */
async function confirmOffer(serverId: string, previous: string | null): Promise<boolean> {
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: t('mac.offerAskTitle', { host: serverLabel(serverId) }),
    detail: previous
      ? `${t('mac.offerAskDetail')}\n\n${t('mac.offerAskMove', { previous: serverLabel(previous) })}`
      : t('mac.offerAskDetail'),
    buttons: [t('mac.offerYes'), t('mac.offerNo')],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

/**
 * Offers this Mac to the bots of the account server, when the person turned it on in the menu bar.
 * The Mac is the one of the person signed in to this app's account: the tunnel is made with that
 * account, so the server sees who it belongs to.
 */
function startMac() {
  stopMacOffer();
  const mine = link;
  if (!canOfferMac() || !readMacOn(userData) || !mine) return;
  const helper = startHelper(personComputer(), 'jpeg');
  const bridge = startMacBridge({
    tunnel: (fn) => mine.subscribe(fn),
    device: deviceName(),
    driver: helper.driver,
    shot: helper.shot,
    ask: (bot, signal) => askForMac(bot, serverLabel(), signal),
    commands: readCommandsOn(userData) ? commandJobs(serverLabel()) : null,
    onChange: (active) => {
      macInUse = active;
      // A sleeping display makes the bot's screenshots black: kept on while the use goes on, which
      // ends by itself after a quiet while.
      display.set('mac', active);
      rebuildMenu();
    },
    log: (level, line) => log[level](line),
  });
  macGate = bridge.gate;
  stopMac = bridge.stop;
}

/** The commands bots run here; made once, so jobs outlive a connection that drops. */
let jobs: CommandJobs | null = null;
function commandJobs(host: string): CommandJobs {
  jobs ??= new CommandJobs({
    ask: (bot, command, place, signal) => askForCommand(bot, host, command, place, signal),
    onChange: () => rebuildMenu(),
  });
  return jobs;
}

/** The session file is encrypted with the system's keychain; without one nothing is kept. */
const sessionFile: SessionFile = {
  encrypt: (text) => {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('no keychain');
    return safeStorage.encryptString(text);
  },
  decrypt: (data) => safeStorage.decryptString(data),
};

/** The sign-in in the person's browser, waiting for the website to send them back. */
const browserSignIn = new BrowserSignIn({
  account,
  openBrowser: (url) => shell.openExternal(url),
  locale: () => locale(),
  signedIn: (token) => setAccountSession(token),
});

/** The website sent the person back with a `leafbot://connect` link: the waiting sign-in spends it. */
async function signInReturned(url: string) {
  showWindow();
  const result = await browserSignIn.finish(url);
  if (result && !result.ok) log.warn(`account: sign-in did not finish (${result.reason})`);
}

/**
 * Keeps a new session, or none (signed out). It changes whose computer this is: the tunnel is made
 * again with the new session, or not at all without one, and what the previous one allowed ends
 * with it. The page hears of it and starts again from its servers or its sign-in.
 */
function setAccountSession(token: string | null) {
  if (token === accountToken) return;
  accountToken = token;
  try {
    writeSession(userData, sessionFile, token);
  } catch (err) {
    log.warn('account: the session is not kept for the next start', err);
  }
  // Commands started for the one signed in before are theirs: they stop with the change.
  jobs?.stopAll();
  void link?.signInChanged();
  void refreshAccountServers();
  if (win && !win.isDestroyed()) win.webContents.send('leafbot:account-changed');
}

/** Ends this app's session, at the service too when it can be reached. */
async function signOut() {
  browserSignIn.cancel();
  await account.signOut().catch((err: unknown) => log.warn('account: sign-out at the service failed', err));
  setAccountSession(null);
}

/** Serves the page of the account's servers from this app's files; nothing outside its folder. */
function serveBotsPage() {
  const dir = botsDir();
  const policy = botsPolicy(RELAY_URL);
  protocol.handle(BOTS_SCHEME, async (req) => {
    const file = botsFile(dir, req.url);
    if (!file || !existsSync(file)) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers({
      'content-type': contentType(file),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
    });
    if (file.endsWith('.html')) {
      headers.set('content-security-policy', policy);
      headers.set('cache-control', 'no-cache');
    }
    return new Response(res.body, { status: 200, headers });
  });
  log.info(`bots page: ${BOTS_SCHEME}://${BOTS_HOST} from ${dir}`);
}

function stopMacOffer() {
  stopMac?.();
  stopMac = null;
  macGate = null;
  if (macInUse) {
    macInUse = false;
    display.set('mac', false);
  }
}

/**
 * Asks on this Mac whether a bot of the server at `host` may use it. The question is the app's own,
 * not the page's, so the server cannot answer it; the bot's name comes from the server and is shown
 * with the server's address.
 */
async function askForMac(bot: string, host: string, signal: AbortSignal): Promise<boolean> {
  const name =
    bot
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .trim()
      .slice(0, 60) || t('mac.someBot');
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'question',
    message: t('mac.askTitle', { bot: name, host }),
    detail: t('mac.askDetail'),
    buttons: [t('mac.allow'), t('mac.deny')],
    defaultId: 1,
    cancelId: 1,
    signal,
  });
  return response === 0 && !signal.aborted;
}

/**
 * Asks on this computer before a command that names a place where keys are kept runs: the server's
 * card is not enough for those. Default is no.
 */
async function askForCommand(
  bot: string,
  host: string,
  command: string,
  place: string,
  signal: AbortSignal,
): Promise<boolean> {
  const name =
    bot
      .replace(/[\p{Cc}\p{Cf}]/gu, ' ')
      .trim()
      .slice(0, 60) || t('mac.someBot');
  app.focus({ steal: true });
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: t('mac.commandAskTitle', { bot: name, host, place }),
    detail: t('mac.commandAskDetail', { command: command.slice(0, 2000) }),
    buttons: [t('mac.allow'), t('mac.deny')],
    defaultId: 1,
    cancelId: 1,
    signal,
  });
  return response === 0 && !signal.aborted;
}

/** The menu bar's part for this Mac: the switch, and while a bot uses it, a way to stop that. */
function macMenu(): Electron.MenuItemConstructorOptions[] {
  const shape = macMenuShape({
    helper: helperFound(),
    linked: !!link,
    accountServers: accountServers.length,
  });
  if (shape === 'none') return [];
  // Without a chosen server the switch would have no one to offer this computer to; it shows, off,
  // with the step that is missing, so the person is not left looking for it.
  if (shape === 'chooseServer') {
    return [
      { label: t('mac.offer'), type: 'checkbox', checked: false, enabled: false },
      { label: t('mac.chooseServer'), enabled: false },
      { type: 'separator' },
    ];
  }
  const running = jobs?.running().length ?? 0;
  return [
    {
      label: t('mac.offer'),
      type: 'checkbox',
      checked: readMacOn(userData),
      click: (item) => {
        writeMacOn(userData, item.checked);
        if (item.checked) startMac();
        else {
          jobs?.stopAll();
          stopMacOffer();
        }
        rebuildMenu();
      },
    },
    ...(macInUse ? [{ label: t('mac.stop'), click: () => macGate?.stop() }] : []),
    {
      label: t('mac.commands'),
      type: 'checkbox',
      checked: readCommandsOn(userData),
      enabled: readMacOn(userData),
      click: (item) => {
        writeCommandsOn(userData, item.checked);
        // Off stops what runs; either way the connection tells the server again what it may ask.
        if (!item.checked) jobs?.stopAll();
        if (readMacOn(userData)) startMac();
        rebuildMenu();
      },
    },
    ...(running > 0
      ? [
          { label: t('mac.jobs', { count: String(running) }), enabled: false },
          { label: t('mac.stopJobs'), click: () => jobs?.stopAll() },
        ]
      : []),
    { type: 'separator' },
  ];
}

/**
 * The menu bar's part for the servers: what the window shows (this computer's own server, or the
 * page of the account's servers), this computer's own server on or off, the account server the
 * window opens and this computer is offered to, and signing in to the account or out of it.
 */
function serverMenu(): Electron.MenuItemConstructorOptions[] {
  return [
    {
      label: t('menu.thisComputer'),
      type: 'radio',
      checked: config.shown === 'local',
      click: () => void apply((c) => show(c, 'local')),
    },
    {
      label: t('menu.accountServers'),
      type: 'radio',
      checked: config.shown === 'account',
      click: () => void apply((c) => show(c, 'account')),
    },
    {
      label: t('menu.accountServer'),
      submenu: [
        ...accountServers.map((s) => ({
          label: s.name,
          type: 'radio' as const,
          checked: config.server === s.id,
          click: () => void apply((c) => chooseServer(c, s.id)),
        })),
        ...(accountServers.length
          ? [
              { type: 'separator' as const },
              {
                label: t('menu.noAccountServer'),
                type: 'radio' as const,
                checked: !config.server,
                click: () => void apply((c) => chooseServer(c, null)),
              },
            ]
          : [{ label: t('menu.signInForServers'), enabled: false }]),
      ],
    },
    {
      label: t('menu.runLocal'),
      type: 'checkbox',
      checked: config.local,
      click: (item) => void turnLocal(item.checked),
    },
    accountToken
      ? { label: t('menu.signOut'), click: () => void signOut() }
      : {
          label: t('menu.signIn'),
          click: () => {
            // The window's own sign-in screen says what happens; the browser opens from there too.
            if (config.shown !== 'account') void apply((c) => show(c, 'account'));
            void browserSignIn.start();
          },
        },
  ];
}

/** Turns this computer's own server on, or off after asking when its bots are at work. */
async function turnLocal(on: boolean) {
  if (!on) {
    const count = await runningBotCount();
    if (count > 0) {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: t('dialog.quitWorking', { count }),
        detail: t('dialog.stopLocalDetail'),
        buttons: [t('dialog.stopLocal'), t('dialog.keepWorking')],
        defaultId: 1,
        cancelId: 1,
      });
      if (response !== 0) return rebuildMenu();
    }
  }
  await apply((c) => setLocal(c, on));
}

function createTray() {
  const icon = nativeImage.createFromPath(join(assets(), 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Leaf Bot');
  tray.on('click', () => {
    // The list is read in the background, so it is a little behind the first time the menu opens.
    void refreshAccountServers();
    tray?.popUpContextMenu();
  });
  rebuildMenu();
}

function setStatus(key: DesktopKey, params?: Record<string, string>) {
  status = { key, params };
  log.info(`durum: ${key}`);
  rebuildMenu();
}

/**
 * The macOS menu bar: the app menu with Settings (⌘,), and the usual Edit, View and Window menus,
 * so the standard shortcuts keep working. Other systems keep the default menu.
 */
function buildAppMenu() {
  if (process.platform !== 'darwin') return;
  const openSettings = () => {
    showWindow();
    win?.webContents.send('leafbot:open-settings');
  };
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Leaf Bot',
        submenu: [
          { role: 'about', label: t('menu.about') },
          { type: 'separator' },
          {
            label: t('menu.settings'),
            accelerator: 'CommandOrControl+,',
            click: openSettings,
            // Settings are a page of this computer's own server; an account server's are in its page.
            enabled: !!origin && config.shown === 'local',
          },
          { type: 'separator' },
          // Without a label these read "Hide LeafBot", from the internal name.
          { role: 'hide', label: t('menu.hide') },
          { role: 'hideOthers', label: t('menu.hideOthers') },
          { role: 'unhide', label: t('menu.unhide') },
          { type: 'separator' },
          { role: 'quit', label: t('menu.quit') },
        ],
      },
      {
        label: t('menu.edit'),
        submenu: [
          { role: 'undo', label: t('edit.undo') },
          { role: 'redo', label: t('edit.redo') },
          { type: 'separator' },
          { role: 'cut', label: t('edit.cut') },
          { role: 'copy', label: t('edit.copy') },
          { role: 'paste', label: t('edit.paste') },
          { role: 'selectAll', label: t('edit.selectAll') },
          { type: 'separator' },
          {
            label: t('spelling.check'),
            type: 'checkbox',
            checked: session.defaultSession.isSpellCheckerEnabled(),
            click: (item) => setSpelling(item.checked),
          },
        ],
      },
      {
        label: t('menu.view'),
        submenu: [
          { role: 'reload' },
          { role: 'toggleDevTools' },
          { type: 'separator' },
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
        ],
      },
      { role: 'windowMenu', label: t('menu.window') },
    ]),
  );
}

function rebuildMenu() {
  buildAppMenu();
  if (!tray) return;
  // While a bot uses this computer, the menu bar says so next to the icon; Windows' tray has no
  // text, so its tooltip does.
  if (process.platform === 'darwin') tray.setTitle(macInUse ? t('mac.inUse') : '');
  else tray.setToolTip(macInUse ? `Leaf Bot · ${t('mac.inUse')}` : 'Leaf Bot');
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('menu.open'), click: () => showWindow(), enabled: !!origin },
      {
        label: t('menu.quick'),
        click: () => toggleQuick(),
        enabled: !!origin && config.shown === 'local',
        ...(quickKey && { accelerator: quickKey, registerAccelerator: false }),
      },
      {
        label: t('menu.quickKey'),
        type: 'checkbox',
        checked: !!quickKey,
        click: (item) => {
          writeQuickOn(userData, item.checked);
          registerQuickKey();
        },
      },
      { type: 'separator' },
      { label: t(status.key, status.params), enabled: false },
      ...serverMenu(),
      { type: 'separator' },
      ...macMenu(),
      {
        label: t('menu.openAtLogin'),
        type: 'checkbox',
        checked: openAtLogin,
        click: (item) => {
          app.setLoginItemSettings({ openAtLogin: item.checked });
          rebuildMenu();
        },
      },
      { label: t('menu.showLogs'), click: () => shell.showItemInFolder(log.transports.file.getFile().path) },
      { type: 'separator' },
      ...(updates ? [{ label: t('menu.checkUpdates'), click: () => void checkForUpdatesNow() }] : []),
      ...(updateReady
        ? [
            {
              label: t('menu.installUpdate', { version: updateReady }),
              click: () => void updates?.install(),
            },
          ]
        : []),
      { label: t('menu.quit'), role: 'quit' },
    ]),
  );
}

app.on('activate', () => showWindow());
app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (workTimer) clearInterval(workTimer);
  // A command does not outlive the app that answers for it.
  jobs?.stopAll();
  stopMacOffer();
  link?.stop();
  stopDisplayWatch();
});
// Keep running in the menu bar when every window is closed.
app.on('window-all-closed', () => {});
/** How many bots are working on the local server; a server that does not answer counts as none. */
async function runningBotCount(): Promise<number> {
  const { count } = await localTurns();
  return typeof count === 'number' ? count : 0;
}

/** What the local server says about running turns; a server that does not answer says nothing. */
async function localTurns(): Promise<{ count?: unknown; personComputerIdleMs?: unknown }> {
  if (!localOrigin) return {};
  return session.defaultSession
    .fetch(`${localOrigin}/api/turns/running`, { signal: AbortSignal.timeout(2000) })
    .then(async (res) => (res.ok ? ((await res.json()) as object) : {}))
    .catch(() => ({}));
}

/**
 * Whether quitting may stop the local server now: with bots at work, the person is asked first,
 * since their work would stop with it. A server that does not answer in time does not hold it up.
 */
async function confirmQuit(): Promise<boolean> {
  const count = await runningBotCount();
  if (count < 1) return true;
  const { response } = await dialog.showMessageBox({
    type: 'warning',
    message: t('dialog.quitWorking', { count }),
    detail: t('dialog.quitWorkingDetail'),
    buttons: [t('dialog.quitAnyway'), t('dialog.keepWorking')],
    defaultId: 1,
    cancelId: 1,
  });
  return response === 0;
}

let quitAsked = false;
app.on('before-quit', (e) => {
  if (server?.running && !stopped && !quitting && !quitAsked) {
    e.preventDefault();
    quitAsked = true;
    void confirmQuit().then((ok) => {
      quitAsked = false;
      if (!ok) return;
      quitting = true;
      app.quit();
    });
    return;
  }
  if (quitAsked) {
    e.preventDefault();
    return;
  }
  quitting = true;
  if (server?.running && !stopped) {
    e.preventDefault();
    setStatus('status.quitting');
    void server.stop().finally(() => {
      stopped = true;
      app.quit();
    });
  }
});
