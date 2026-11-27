import { contextBridge, ipcRenderer } from 'electron';

// The page gets only these calls; no Node or Electron objects cross the bridge.
const bridge = {
  /** True when the window has no title bar and the page must leave room for the window buttons. */
  framelessTitleBar: process.platform === 'darwin',
  accessKey: (): Promise<string | null> => ipcRenderer.invoke('leafbot:access-key'),
  connectRemote: (url: string, key: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke('leafbot:connect-remote', url, key),
  useLocal: (): Promise<void> => ipcRenderer.invoke('leafbot:use-local'),
  server: (): Promise<{ mode: 'local' | 'remote'; url: string | null } | null> =>
    ipcRenderer.invoke('leafbot:server'),
  /** Every server the app keeps; the window shows one, and one is the main server. */
  servers: (): Promise<{ id: string; url: string | null; main: boolean; shown: boolean }[] | null> =>
    ipcRenderer.invoke('leafbot:servers'),
  /** Shows another kept server in the window; `local` is this computer's own. */
  showServer: (id: string): Promise<void> => ipcRenderer.invoke('leafbot:show-server', id),
  /** Opens the app's menu of its servers at the pointer; the page is not told the list. */
  serverMenu: (): Promise<void> => ipcRenderer.invoke('leafbot:server-menu'),
  openConnect: (): Promise<void> => ipcRenderer.invoke('leafbot:open-connect'),
  setLocale: (locale: string): Promise<void> => ipcRenderer.invoke('leafbot:set-locale', locale),
  setUnread: (count: number): Promise<void> => ipcRenderer.invoke('leafbot:set-unread', count),
  setBusy: (busy: boolean): Promise<void> => ipcRenderer.invoke('leafbot:set-busy', busy),
  showLogs: (): Promise<void> => ipcRenderer.invoke('leafbot:show-logs'),
  /** Whether the app opens at login; with `on`, sets it first. */
  openAtLogin: (on?: boolean): Promise<boolean | null> => ipcRenderer.invoke('leafbot:open-at-login', on),
  /** The chat a `leafbot://` link asked to open, once; null when there is none. */
  takeLink: (): Promise<{ kind: 'thread' | 'bot' | 'room' | 'app'; id: string } | null> =>
    ipcRenderer.invoke('leafbot:take-link'),
  /** Opens a saved app in a window of its own. */
  openApp: (id: string): Promise<void> => ipcRenderer.invoke('leafbot:open-app', id),
  /** The saved apps installed on this computer; null where launchers cannot be made here. */
  appInstalls: (): Promise<{ id: string; name: string; desktop: boolean }[] | null> =>
    ipcRenderer.invoke('leafbot:app-installs'),
  /** Installs a saved app on this computer, or renames its launchers. */
  installApp: (id: string, name: string): Promise<{ id: string; name: string; desktop: boolean } | null> =>
    ipcRenderer.invoke('leafbot:app-install', id, name),
  uninstallApp: (id: string): Promise<void> => ipcRenderer.invoke('leafbot:app-uninstall', id),
  /** Puts an installed app on the Desktop, or takes it off; adding it installs it first. */
  appOnDesktop: (
    id: string,
    name: string,
    on: boolean,
  ): Promise<{ id: string; name: string; desktop: boolean } | null> =>
    ipcRenderer.invoke('leafbot:app-desktop', id, name, on),
  /** Calls `fn` when a link arrives while the page is open; returns a function that stops it. */
  onOpenLink: (fn: () => void): (() => void) => {
    const listener = () => fn();
    ipcRenderer.on('leafbot:open-link', listener);
    return () => ipcRenderer.removeListener('leafbot:open-link', listener);
  },
  /** Puts the quick window away. */
  quickHide: (): Promise<void> => ipcRenderer.invoke('leafbot:quick-hide'),
  /** Opens a conversation in the main window (from the quick window). */
  openThread: (id: string): Promise<void> => ipcRenderer.invoke('leafbot:open-thread', id),
  /** The global shortcut that opens the quick window, or null when none was free. */
  quickKey: (): Promise<string | null> => ipcRenderer.invoke('leafbot:quick-key'),
  /** Calls `fn` each time the quick window is shown again; returns a function that stops it. */
  onQuickShown: (fn: () => void): (() => void) => {
    const listener = () => fn();
    ipcRenderer.on('leafbot:quick-shown', listener);
    return () => ipcRenderer.removeListener('leafbot:quick-shown', listener);
  },
  /** Calls `fn` when the menu bar's Settings item is chosen; returns a function that stops it. */
  onOpenSettings: (fn: () => void): (() => void) => {
    const listener = () => fn();
    ipcRenderer.on('leafbot:open-settings', listener);
    return () => ipcRenderer.removeListener('leafbot:open-settings', listener);
  },
};
contextBridge.exposeInMainWorld('leafbotDesktop', bridge);
// A server not yet updated past the rename serves a page that looks for the bridge by its old name.
contextBridge.exposeInMainWorld('yumakbotDesktop', bridge);
