import { create } from 'zustand';
import { useT } from '@/i18n';
import { desktop } from '@/lib/desktop';

export type ServerRole = 'owner' | 'admin' | 'member';

/** A server the person can move this window to, the one shown here among them. */
export interface ServerChoice {
  id: string;
  name: string;
  role?: ServerRole;
  current: boolean;
  /** When the server last reached the account (milliseconds), as the account lists it. */
  seenAt?: number;
}

/**
 * What the page holding the app knows about the person's servers: the web app on the website lists
 * them from the account and opens the chosen one through the tunnel. Null everywhere else.
 */
export interface ServerHost {
  servers: ServerChoice[];
  choose(id: string): void;
  add(): void;
}

export const useServerHost = create<{ host: ServerHost | null }>(() => ({ host: null }));

/** The server this window shows and the ways to reach another, for the sidebar. */
export interface ServerSwitch {
  name: string;
  role?: ServerRole;
  /** Servers to choose from, this one marked; null when this page cannot list them. */
  servers: ServerChoice[] | null;
  choose?(id: string): void;
  add?(): void;
}

export function useServerSwitch(): ServerSwitch {
  const t = useT();
  const host = useServerHost((s) => s.host);

  if (host) {
    const current = host.servers.find((s) => s.current);
    return {
      name: current?.name ?? location.host,
      ...(current?.role ? { role: current.role } : {}),
      servers: host.servers,
      choose: host.choose,
      add: host.add,
    };
  }

  // The desktop app's own page is this computer's server; the account's servers open in the
  // window as the website's page, which lists them itself.
  if (desktop) {
    const open = desktop.openAccount;
    return {
      name: t('connection.thisComputer'),
      servers: null,
      ...(open ? { add: () => void open() } : {}),
    };
  }

  // A server reached at its own address knows only itself.
  return { name: location.host, servers: null };
}
