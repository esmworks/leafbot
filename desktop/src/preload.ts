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
  openConnect: (): Promise<void> => ipcRenderer.invoke('leafbot:open-connect'),
  setLocale: (locale: string): Promise<void> => ipcRenderer.invoke('leafbot:set-locale', locale),
  setUnread: (count: number): Promise<void> => ipcRenderer.invoke('leafbot:set-unread', count),
  setBusy: (busy: boolean): Promise<void> => ipcRenderer.invoke('leafbot:set-busy', busy),
  showLogs: (): Promise<void> => ipcRenderer.invoke('leafbot:show-logs'),
  /** Whether the app opens at login; with `on`, sets it first. */
  openAtLogin: (on?: boolean): Promise<boolean | null> => ipcRenderer.invoke('leafbot:open-at-login', on),
  /** The chat a `leafbot://` link asked to open, once; null when there is none. */
  takeLink: (): Promise<{ kind: 'thread' | 'bot' | 'room'; id: string } | null> =>
    ipcRenderer.invoke('leafbot:take-link'),
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
