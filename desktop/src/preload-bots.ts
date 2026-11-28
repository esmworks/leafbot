import { contextBridge, ipcRenderer } from 'electron';

/**
 * The bridge of the page that shows the account's servers (see `bots-page.ts`): the account calls,
 * made by this app with its own session, and the sign-in in the person's browser. Nothing of this
 * computer's own server, whose page has the other bridge. Answers come as plain objects: an error
 * thrown across the bridge would lose its status.
 */
type Answer<T> = { ok: true; data: T } | { ok: false; status: number; code: string };

const account = {
  servers: (): Promise<Answer<unknown>> => ipcRenderer.invoke('leafbot:account-servers'),
  ticket: (serverId: string, jkt: string): Promise<Answer<unknown>> =>
    ipcRenderer.invoke('leafbot:account-ticket', serverId, jkt),
  connectCode: (): Promise<Answer<unknown>> => ipcRenderer.invoke('leafbot:account-connect-code'),
  /** Opens the sign-in in the browser; resolves once the browser sent the person back, or it ended. */
  signIn: (): Promise<{ ok: true } | { ok: false; reason: string }> =>
    ipcRenderer.invoke('leafbot:account-sign-in'),
  /** Signs out of the account, as the menu bar's item does; `onChange` follows. */
  signOut: (): Promise<void> => ipcRenderer.invoke('leafbot:account-sign-out'),
  /** Opens a page of the website (adding a server, say) in the person's browser. */
  openWebsite: (path: string): Promise<void> => ipcRenderer.invoke('leafbot:account-website', path),
  /** Calls `fn` when the person signs in or out from the menu bar; returns a function that stops it. */
  onChange: (fn: () => void): (() => void) => {
    const listener = () => fn();
    ipcRenderer.on('leafbot:account-changed', listener);
    return () => ipcRenderer.removeListener('leafbot:account-changed', listener);
  },
};

const bridge = {
  framelessTitleBar: process.platform === 'darwin',
  /** The page of an account server signs in through the account, never with a key of this computer. */
  accessKey: async (): Promise<null> => null,
  setLocale: (locale: string): Promise<void> => ipcRenderer.invoke('leafbot:set-locale', locale),
  setUnread: (count: number): Promise<void> => ipcRenderer.invoke('leafbot:set-unread', count),
  account,
};
contextBridge.exposeInMainWorld('leafbotDesktop', bridge);
