/**
 * What the panel keeps between openings, in the extension's own storage: the server it opens and
 * whether the person shares this Chrome. The account's token is kept by `account.ts`.
 */
export interface Stored {
  /** The id of the account's server the panel opens. */
  server: string | null;
  sharing: boolean;
}

export async function loadStored(): Promise<Stored> {
  const v = await chrome.storage.local.get(['serverId', 'sharing']);
  return {
    server: typeof v.serverId === 'string' ? v.serverId : null,
    sharing: v.sharing === true,
  };
}

export const saveServer = (server: string | null) =>
  server ? chrome.storage.local.set({ serverId: server }) : chrome.storage.local.remove('serverId');

export const saveSharing = (sharing: boolean) => chrome.storage.local.set({ sharing });
