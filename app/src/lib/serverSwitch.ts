import { create } from 'zustand';
import { useT } from '@/i18n';
import { desktop, useDesktopServer, useDesktopServers } from '@/lib/desktop';

export type ServerRole = 'owner' | 'admin' | 'member';

/** A server the person can move this window to, the one shown here among them. */
export interface ServerChoice {
  id: string;
  name: string;
  role?: ServerRole;
  current: boolean;
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
  /**
   * The desktop shell's own menu of its servers. The shell lists them itself, so a page from a
   * server elsewhere, perhaps someone else's, never learns the person's other servers.
   */
  shellMenu?(): void;
}

export function useServerSwitch(): ServerSwitch {
  const t = useT();
  const host = useServerHost((s) => s.host);
  const shown = useDesktopServer();
  const kept = useDesktopServers();

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

  const hostName = (url: string | null) => (url ? new URL(url).host : t('connection.thisComputer'));
  if (desktop) {
    const name = shown ? hostName(shown.url) : '';
    if (desktop.serverMenu) {
      const menu = desktop.serverMenu;
      return { name, servers: null, shellMenu: () => void menu() };
    }
    // Older shells: only this computer's own page may list the servers and switch.
    const show = desktop.showServer;
    const connect = desktop.openConnect;
    return {
      name,
      servers: kept && kept.map((s) => ({ id: s.id, name: hostName(s.url), current: s.shown })),
      ...(show ? { choose: (id: string) => void show(id) } : {}),
      ...(connect ? { add: () => void connect() } : {}),
    };
  }

  // A server reached at its own address knows only itself.
  return { name: location.host, servers: null };
}
