import { useEffect, useState } from 'react';

/** Bridge exposed by the desktop shell's preload script; absent in a normal browser. */
interface DesktopBridge {
  accessKey(): Promise<string | null>;
  useLocal(): Promise<void>;
  /** The server this window shows: the one on this computer or a remote one. Missing in older shells. */
  server?(): Promise<{ mode: 'local' | 'remote'; url: string | null } | null>;
  /** Every server the shell keeps, the window's among them. Missing in older shells. */
  servers?(): Promise<DesktopServerEntry[] | null>;
  /** Shows another kept server in the window; `local` is this computer's own. Missing in older shells. */
  showServer?(id: string): Promise<void>;
  /**
   * Opens the shell's own menu of its servers beside the pointer; the page never sees the list.
   * Missing in older shells.
   */
  serverMenu?(): Promise<void>;
  /** Opens the shell's window for connecting to another server. Missing in older shells. */
  openConnect?(): Promise<void>;
  /** Tells the shell the app's language, for its menu and windows. Missing in older shells. */
  setLocale?(locale: string): Promise<void>;
  /** Puts the number of bots with unread replies on the app icon (0 clears it). Missing in older shells. */
  setUnread?(count: number): Promise<void>;
  /** Whether a bot is working, so the shell keeps a computer running the server awake. Missing in older shells. */
  setBusy?(busy: boolean): Promise<void>;
  /** Shows the desktop app's log file in the file manager. Missing in older shells. */
  showLogs?(): Promise<void>;
  /** Whether the app opens when the person logs in; with `on`, sets it first. Missing in older shells. */
  openAtLogin?(on?: boolean): Promise<boolean | null>;
  /** Calls `fn` when Settings is chosen in the menu bar; returns a function that stops it. Missing in older shells. */
  onOpenSettings?(fn: () => void): () => void;
  /** The chat a `leafbot://` link asked to open, once. Missing in older shells. */
  takeLink?(): Promise<{ kind: 'thread' | 'bot' | 'room' | 'app'; id: string } | null>;
  /** Opens a saved app in a window of its own. Missing in older shells. */
  openApp?(id: string): Promise<void>;
  /**
   * The saved apps installed on this computer; null where launchers cannot be made (another
   * server's page, an app run from source). Missing in older shells.
   */
  appInstalls?(): Promise<InstalledApp[] | null>;
  /** Installs a saved app on this computer, or renames its launchers. Missing in older shells. */
  installApp?(id: string, name: string): Promise<InstalledApp | null>;
  uninstallApp?(id: string): Promise<void>;
  /** Puts an installed app on the Desktop or takes it off; adding installs it first. Missing in older shells. */
  appOnDesktop?(id: string, name: string, on: boolean): Promise<InstalledApp | null>;
  /** Calls `fn` when a link arrives while the page is open. Missing in older shells. */
  onOpenLink?(fn: () => void): () => void;
  /** Puts the quick window away. Missing in older shells. */
  quickHide?(): Promise<void>;
  /** Opens a conversation in the main window, from the quick window. Missing in older shells. */
  openThread?(id: string): Promise<void>;
  /** The global shortcut that opens the quick window, or null when none was free. Missing in older shells. */
  quickKey?(): Promise<string | null>;
  /** Calls `fn` each time the quick window is shown again. Missing in older shells. */
  onQuickShown?(fn: () => void): () => void;
  /** Tells the shell this page reached a stage of its start, for the launch times. Missing in older shells. */
  launchMark?(
    name: 'first-paint' | 'sidebar' | 'chat',
    longTasks?: { count: number; totalMs: number },
  ): Promise<void>;
  /** The window has no title bar; the page leaves room for the window buttons. Missing in older shells. */
  framelessTitleBar?: boolean;
}

/** Shells made before the rename offer the bridge under its old name only. */
const shell = window as unknown as { leafbotDesktop?: DesktopBridge; yumakbotDesktop?: DesktopBridge };
export const desktop = shell.leafbotDesktop ?? shell.yumakbotDesktop ?? null;

/** A saved app with a launcher on this computer, and whether it is on the Desktop too. */
export type InstalledApp = { id: string; name: string; desktop: boolean };

export type DesktopServer = { mode: 'local' | 'remote'; url: string | null };

/**
 * A server the desktop app keeps: this computer's own (`id` is `local`, no `url`) or one elsewhere.
 * The main server is the first one elsewhere, else this computer's own.
 */
export type DesktopServerEntry = { id: string; url: string | null; main: boolean; shown: boolean };

/** The servers the desktop app keeps; null outside the desktop app or in an older shell. */
export function useDesktopServers(): DesktopServerEntry[] | null {
  const [servers, setServers] = useState<DesktopServerEntry[] | null>(null);
  useEffect(() => {
    desktop
      ?.servers?.()
      .then(setServers)
      .catch(() => setServers(null));
  }, []);
  return servers;
}

/** The server the desktop window shows; null outside the desktop app or in an older shell. */
export function useDesktopServer(): DesktopServer | null {
  const [server, setServer] = useState<DesktopServer | null>(null);
  useEffect(() => {
    desktop
      ?.server?.()
      .then(setServer)
      .catch(() => setServer(null));
  }, []);
  return server;
}
