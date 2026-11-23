import './old-env';
import { existsSync, lstatSync, readFileSync, readlinkSync, renameSync } from 'node:fs';
import { hostname } from 'node:os';
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
  powerSaveBlocker,
  safeStorage,
  screen,
  session,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from 'electron';
import log from 'electron-log/main';
import { autoUpdater } from 'electron-updater';
import {
  normalizeRemoteUrl,
  readDesktopConfig,
  writeDesktopConfig,
  type DesktopConfig,
} from './desktop-config';
import { createCrashGuard, isCrash } from './crash-guard';
import { DISPLAY_POLL_MS, keepDisplayOn } from './display-awake';
import { startEgress } from './egress';
import { readMoveDeclined, runsFromTransientPlace, writeMoveDeclined } from './install-location';
import { readSpellingOn, spellingEntries, spellingLanguages, writeSpellingOn } from './spelling';
import { isLocale } from '@leafbot/shared/i18n';
import { loadLocale, locale, saveLocale, setLocale, t, type DesktopKey } from './i18n';
import { LINK_SCHEMES, linkInArgs, parseLink, type AppLink } from './links';
import { claimQuickKey, isThreadId, quickBounds, quickUrl, readQuickOn, writeQuickOn } from './quick';
import { ServerProcess } from './server-process';
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
// saved server key, would otherwise be looked up under a new name. The About panel and the menu
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

const DEFAULT_PORT = 4319;
const userData = app.getPath('userData');
const dataDir = join(userData, 'data');

let win: BrowserWindow | null = null;
let connectWin: BrowserWindow | null = null;
/** The small window the global shortcut opens; kept hidden between uses so it opens at once. */
let quickWin: BrowserWindow | null = null;
/** The global shortcut that opens it, or null when another app holds every one we try. */
let quickKey: string | null = null;
let tray: Tray | null = null;
let server: ServerProcess | null = null;
let config: DesktopConfig = { mode: 'local' };
/** Origin of the page the main window shows; the only origin that may ask for the key. */
let origin: string | null = null;
let accessKey: string | null = null;
/** Tray status line, kept as a key so it follows a language change. */
let status: { key: DesktopKey; params?: Record<string, string> } = { key: 'status.starting' };
let quitting = false;
let stopped = false;
/** Bots with replies the person has not read, as the page last reported. */
let unread = 0;
/** Keeps the computer from sleeping while a bot works; null while none does. */
let awake: number | null = null;
/** Keeps the screen on while a bot uses this Mac, so its screenshots are not black; null while not. */
let displayAwake: number | null = null;
let displayTimer: ReturnType<typeof setInterval> | null = null;
let updates: Updates | null = null;
/** A downloaded version waiting for a restart. */
let updateReady: string | null = null;
/** Ends this computer's offer to be the bots' way out to the web; set while connected to a remote server. */
let stopEgress: (() => void) | null = null;

const resources = () => (app.isPackaged ? process.resourcesPath : join(app.getAppPath(), '..'));
const serverEntry = () => join(resources(), 'server', 'dist', 'index.mjs');
const appDir = () => (app.isPackaged ? join(resources(), 'app') : join(resources(), 'app', 'dist'));
const assets = () => (app.isPackaged ? join(resources(), 'assets') : join(app.getAppPath(), 'assets'));
/** The macOS helper that moves the mouse and types for a bot the person allowed to use this Mac. */
const personComputer = () =>
  app.isPackaged ? join(resources(), 'person-computer') : join(app.getAppPath(), 'dist', 'person-computer');

/** A `leafbot://` link waiting for the page to take it (see `links.ts`). */
let pendingLink: AppLink | null = linkInArgs(process.argv);

/** Shows the chat a link names: the window comes forward and the page is told to open it. */
function openLink(link: AppLink | null) {
  if (!link) {
    showWindow();
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
  app.on('second-instance', (_e, argv) => openLink(linkInArgs(argv)));
  // macOS hands a link to the running app, or to the app it is starting, as an event.
  app.on('open-url', (e, url) => {
    e.preventDefault();
    const link = parseLink(url);
    if (!link) return;
    if (app.isReady()) openLink(link);
    else pendingLink = link;
  });
  void app.whenReady().then(boot);
}

/**
 * Makes this app the one `leafbot://` links open, and `yumakbot://` links made before the rename.
 * Run from source, Electron needs the app's path.
 */
function registerLinks() {
  for (const scheme of LINK_SCHEMES) {
    if (process.defaultApp && process.argv[1]) {
      app.setAsDefaultProtocolClient(scheme, process.execPath, [join(process.cwd(), process.argv[1])]);
    } else {
      app.setAsDefaultProtocolClient(scheme);
    }
  }
}

async function boot() {
  // A packaged app takes its Dock icon from the bundle; one run from source would show Electron's.
  // icon.png is the tile of assets/icon.icon drawn flat, without the glass macOS adds to the real one.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(join(assets(), 'icon.png'));
  loadLocale(userData, app.getPreferredSystemLanguages());
  hardenSessions();
  setUpSpelling();
  registerIpc();
  registerLinks();
  createTray();
  registerQuickKey();
  watchForUpdates();
  config = readDesktopConfig(userData, safeStorage);
  await connect();
  void offerMove();
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

async function connect() {
  if (config.mode === 'remote') {
    origin = config.url;
    accessKey = config.key;
    setStatus('status.remote', { host: new URL(config.url).host });
    showWindow();
    const remote = config;
    stopEgress = startEgress({
      url: remote.url,
      // The access key, or the session a pairing code gave the window.
      headers: async (): Promise<Record<string, string>> => {
        if (remote.key) return { authorization: `Bearer ${remote.key}` };
        const cookies = await session.defaultSession.cookies.get({ url: remote.url });
        return cookies.length ? { cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; ') } : {};
      },
      device: hostname().replace(/\.local$/, ''),
      log: (level, line) => log[level](line),
    });
    return;
  }
  setStatus('status.serverStarting');
  server = new ServerProcess({
    entry: serverEntry(),
    execPath: process.execPath,
    dataDir,
    appDir: appDir(),
    port: DEFAULT_PORT,
    log: (level, line) => log[level](`[sunucu] ${line}`),
    // Development only: run the server with the offline test engine.
    env: {
      ...(!app.isPackaged && process.env.LEAFBOT_ENGINE
        ? { LEAFBOT_ENGINE: process.env.LEAFBOT_ENGINE }
        : {}),
      ...(process.platform === 'darwin' && existsSync(personComputer())
        ? { LEAFBOT_PERSON_COMPUTER: personComputer() }
        : {}),
    },
  });
  server.on('restarted', (url: string) => {
    origin = url;
    setStatus('status.running');
    void win?.loadURL(url);
  });
  server.on('exit', (e: { expected: boolean }) => {
    if (!e.expected) setStatus('status.restarting');
  });
  server.on('gave-up', () => {
    setStatus('status.stopped');
    void dialog.showMessageBox({
      type: 'error',
      message: t('dialog.gaveUp'),
      detail: t('dialog.gaveUpDetail'),
    });
  });
  try {
    origin = await server.start();
    accessKey = readFileSync(join(dataDir, 'access-key'), 'utf8').trim();
    setStatus('status.running');
    showWindow();
  } catch (err) {
    log.error('server failed to start', err);
    setStatus('status.failed');
    await dialog.showMessageBox({
      type: 'error',
      message: t('dialog.failed'),
      detail: (err as Error).message,
    });
  }
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
      await server?.stop();
      stopped = true;
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
  if (win && !win.isDestroyed()) {
    win.show();
    win.focus();
    return;
  }
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
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: true,
    },
  });
  if (restored.maximized) win.maximize();
  rememberWindowState(win);
  showUnread();
  win.once('ready-to-show', () => win?.show());
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
  void win.loadURL(origin);
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
  if (!origin) return;
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

function openConnectWindow() {
  if (connectWin && !connectWin.isDestroyed()) return connectWin.focus();
  connectWin = new BrowserWindow({
    width: 460,
    height: 420,
    resizable: false,
    title: t('connect.title'),
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1b1b1b' : '#fafafa',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  void connectWin.loadFile(join(assets(), 'connect.html'), { query: { lang: locale() } });
}

/** A pairing code as people type it (`ABCD-2345`); access keys are much longer. */
const isPairingCode = (v: string) => /^[A-Za-z0-9]{4}[\s-]?[A-Za-z0-9]{4}$/.test(v);

/** Spends a pairing code at `url` and keeps the session it gives as the window's sign-in cookie. */
async function pairWith(url: string, code: string) {
  const res = await session.defaultSession.fetch(`${url}/api/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, token: true }),
  });
  const body = (await res.json().catch(() => null)) as {
    token?: string;
    cookie?: string;
    maxAge?: number;
    error?: string;
  } | null;
  if (!res.ok || !body?.token || !body.cookie) {
    throw new Error(body?.error ?? t('connect.noResponse', { status: String(res.status) }));
  }
  const secure = url.startsWith('https:');
  await session.defaultSession.cookies.set({
    url,
    name: body.cookie,
    value: body.token,
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    expirationDate: Date.now() / 1000 + (body.maxAge ?? 90 * 24 * 3600),
  });
}

function isAppOrigin(url: string) {
  try {
    return !!origin && new URL(url).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

function fromMainPage(e: IpcMainInvokeEvent) {
  try {
    return !!origin && new URL(e.senderFrame?.url ?? '').origin === origin;
  } catch {
    return false;
  }
}
function fromConnectPage(e: IpcMainInvokeEvent) {
  return !!connectWin && e.sender === connectWin.webContents;
}

function registerIpc() {
  ipcMain.handle('leafbot:access-key', (e) => (fromMainPage(e) ? accessKey : null));
  // The chat a `leafbot://` link named, once: the page asks when it starts and when told to.
  ipcMain.handle('leafbot:take-link', (e) => {
    if (!fromMainPage(e)) return null;
    const link = pendingLink;
    pendingLink = null;
    return link;
  });
  // Which server the window shows, so the page can offer to switch.
  ipcMain.handle('leafbot:server', (e) =>
    fromMainPage(e) ? { mode: config.mode, url: config.mode === 'remote' ? config.url : null } : null,
  );
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
  ipcMain.handle('leafbot:open-connect', (e) => {
    if (fromMainPage(e)) openConnectWindow();
  });
  ipcMain.handle('leafbot:connect-remote', async (e, rawUrl: string, key: string) => {
    if (!fromConnectPage(e)) return { ok: false, error: t('connect.noPermission') };
    try {
      const url = normalizeRemoteUrl(String(rawUrl));
      const res = await session.defaultSession.fetch(`${url}/api/health`);
      if (!res.ok) throw new Error(t('connect.noResponse', { status: String(res.status) }));
      let saved = String(key).trim();
      // A pairing code signs this app in once; the session it gives is kept with the window's
      // cookies, and there is no key to keep.
      if (isPairingCode(saved)) {
        await pairWith(url, saved);
        saved = '';
      }
      writeDesktopConfig(userData, { mode: 'remote', url, key: saved }, safeStorage);
      await switchTo(readDesktopConfig(userData, safeStorage));
      connectWin?.close();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
  // The app reports its language so the menu and windows match it.
  ipcMain.handle('leafbot:set-locale', (e, next: unknown) => {
    if (!fromMainPage(e) || !isLocale(next) || next === locale()) return;
    setLocale(next);
    try {
      saveLocale(userData, next);
    } catch (err) {
      log.warn('dil kaydedilemedi', err);
    }
    if (connectWin && !connectWin.isDestroyed()) connectWin.setTitle(t('connect.title'));
    rebuildMenu();
  });
  ipcMain.handle('leafbot:set-unread', (e, count: unknown) => {
    if (!fromMainPage(e)) return;
    const n =
      typeof count === 'number' && Number.isFinite(count) ? Math.min(999, Math.max(0, Math.trunc(count))) : 0;
    if (n === unread) return;
    unread = n;
    showUnread();
  });
  // While a bot works on this computer, the computer stays awake, so a routine or a long reply is
  // not cut short by sleep. The screen may still turn off, except while a bot is using this Mac
  // (see `startDisplayWatch`).
  ipcMain.handle('leafbot:set-busy', (e, busy: unknown) => {
    if (!fromMainPage(e) || config.mode !== 'local') return;
    if (busy === true && awake === null) awake = powerSaveBlocker.start('prevent-app-suspension');
    if (busy === true) startDisplayWatch();
    if (busy !== true && awake !== null) {
      powerSaveBlocker.stop(awake);
      awake = null;
    }
    if (busy !== true) stopDisplayWatch();
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
  ipcMain.handle('leafbot:use-local', async (e) => {
    if (!fromConnectPage(e) && !fromMainPage(e)) return;
    writeDesktopConfig(userData, { mode: 'local' }, safeStorage);
    await switchTo({ mode: 'local' });
    connectWin?.close();
  });
}

/**
 * While bots work, asks the server now and then whether one is using this Mac, and keeps the screen
 * on for that time only: a sleeping display makes the bot's screenshots black.
 */
function startDisplayWatch() {
  if (displayTimer) return;
  const tick = async () => {
    if (config.mode !== 'local') return;
    const { personComputerIdleMs } = await localTurns();
    const on = keepDisplayOn(personComputerIdleMs);
    if (on && displayAwake === null) displayAwake = powerSaveBlocker.start('prevent-display-sleep');
    if (!on && displayAwake !== null) releaseDisplay();
  };
  displayTimer = setInterval(() => void tick(), DISPLAY_POLL_MS);
}

function releaseDisplay() {
  if (displayAwake !== null) powerSaveBlocker.stop(displayAwake);
  displayAwake = null;
}

function stopDisplayWatch() {
  if (displayTimer) clearInterval(displayTimer);
  displayTimer = null;
  releaseDisplay();
}

async function switchTo(next: DesktopConfig) {
  stopEgress?.();
  stopEgress = null;
  if (awake !== null) powerSaveBlocker.stop(awake);
  awake = null;
  await server?.stop();
  server = null;
  config = next;
  // The old page belongs to another origin; start fresh.
  closeQuick();
  if (win && !win.isDestroyed()) {
    quitting = true;
    win.close();
    quitting = false;
    win = null;
  }
  await connect();
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
  // picture has no other route there) and the microphone alone (speaking a message instead of
  // typing it). The camera and the screen stay closed. Only the top frame counts: a frame inside the
  // page (a bot's page, a connected app) gets nothing, even one served from the same address.
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb, details) => {
    if (!details.isMainFrame || !isAppOrigin(details.requestingUrl)) return cb(false);
    if (perm === 'clipboard-sanitized-write') return cb(true);
    const media = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    cb(perm === 'media' && media.length > 0 && media.every((m) => m === 'audio'));
  });
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (e, url) => {
      // The origin is compared whole: a prefix would also let https://bot.example.com.evil.net or
      // https://bot.example.com@evil.net through.
      const allowed = url.startsWith('file://') || isAppOrigin(url);
      if (!allowed) {
        e.preventDefault();
        if (/^https?:\/\//.test(url)) void shell.openExternal(url);
      }
    });
  });
}

function createTray() {
  const icon = nativeImage.createFromPath(join(assets(), 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Leaf Bot');
  tray.on('click', () => tray?.popUpContextMenu());
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
            enabled: !!origin,
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
  const openAtLogin = app.getLoginItemSettings().openAtLogin;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: t('menu.open'), click: () => showWindow(), enabled: !!origin },
      {
        label: t('menu.quick'),
        click: () => toggleQuick(),
        enabled: !!origin,
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
      config.mode === 'local'
        ? { label: t('menu.connectRemote'), click: () => openConnectWindow() }
        : { label: t('menu.useLocal'), click: () => void switchTo({ mode: 'local' }) },
      { type: 'separator' },
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
  if (config.mode !== 'local' || !origin) return {};
  return session.defaultSession
    .fetch(`${origin}/api/turns/running`, { signal: AbortSignal.timeout(2000) })
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
