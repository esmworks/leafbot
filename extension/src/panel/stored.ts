/**
 * What the panel keeps between openings, in the extension's own storage: the server it connects to
 * and whether the person shares this Chrome. Never a session or a key: Chrome keeps the session as
 * the server's cookie.
 */
export interface Stored {
  /** The server's origin, such as `http://localhost:4319`. */
  server: string | null;
  sharing: boolean;
}

export async function loadStored(): Promise<Stored> {
  const v = await chrome.storage.local.get(['server', 'sharing']);
  return {
    server: typeof v.server === 'string' ? v.server : null,
    sharing: v.sharing === true,
  };
}

export const saveServer = (server: string | null) =>
  server ? chrome.storage.local.set({ server }) : chrome.storage.local.remove('server');

export const saveSharing = (sharing: boolean) => chrome.storage.local.set({ sharing });
