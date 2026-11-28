/** Bridge exposed by the desktop shell's preload script; absent in a normal browser. */
interface DesktopBridge {
  accessKey(): Promise<string | null>;
  /**
   * Shows the servers of the person's Leaf Bot account in the window, where they sign in to their
   * account through their browser. Missing in older shells.
   */
  openAccount?(): Promise<void>;
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
  /**
   * On the page of the account's servers only: the account, reached by the desktop app with its own
   * session, and the sign-in in the person's browser.
   */
  account?: DesktopAccount;
  /** On the page of the account's servers only: this computer, for the bots of the server shown. Missing in older shells. */
  computer?: DesktopComputer;
}

/**
 * This computer as the desktop app offers it to an account server's bots: whether it can be
 * offered (`unsupported` on a system without computer use, `missing` when the app lacks its
 * helper), the server it is offered to (null while none was chosen), and whether the offer is on.
 */
export type DesktopComputerState = {
  helper: 'ok' | 'unsupported' | 'missing';
  server: string | null;
  on: boolean;
};

export interface DesktopComputer {
  state(): Promise<DesktopComputerState | null>;
  /**
   * Offers this computer to that server's bots, after the app asks on this computer; when it is
   * already on for that server, connects it again without asking.
   */
  offer(serverId: string): Promise<DesktopComputerState | null>;
}

/** An account call's answer as the desktop app hands it over: the status stays with an error. */
export type DesktopAnswer<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

export interface DesktopAccount {
  servers(): Promise<DesktopAnswer<unknown>>;
  ticket(serverId: string, jkt: string): Promise<DesktopAnswer<unknown>>;
  connectCode(): Promise<DesktopAnswer<unknown>>;
  /** Opens the sign-in in the browser; resolves once the browser sent the person back, or it ended. */
  signIn(): Promise<{ ok: true } | { ok: false; reason: string }>;
  /** Signs out of the account, as the menu bar's item does; `onChange` follows. Missing in older shells. */
  signOut?(): Promise<void>;
  /** Opens a page of the website in the person's browser. */
  openWebsite(path: string): Promise<void>;
  /** Calls `fn` when the person signs in or out from the menu bar; returns a function that stops it. */
  onChange(fn: () => void): () => void;
}

/** Shells made before the rename offer the bridge under its old name only. */
const shell = window as unknown as { leafbotDesktop?: DesktopBridge; yumakbotDesktop?: DesktopBridge };
export const desktop = shell.leafbotDesktop ?? shell.yumakbotDesktop ?? null;

/** A saved app with a launcher on this computer, and whether it is on the Desktop too. */
export type InstalledApp = { id: string; name: string; desktop: boolean };
