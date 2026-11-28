import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * What the window shows: this computer's own server, or the website's page of the person's
 * account servers (`https://www.leafbot.app/bots/`), where they sign in as in a browser.
 */
export type ServerId = 'local' | 'account';

/**
 * The choices this app keeps. This computer's own server can run while the window shows the
 * account servers, so its bots and routines go on. A server elsewhere is reached only through the
 * person's Leaf Bot account; nothing about one (address, key) is stored here.
 */
export interface DesktopConfig {
  /** This computer's own server runs. */
  local: boolean;
  /** What the window shows. */
  shown: ServerId;
  /**
   * The account server (its id at the account service) the window opens and this computer is
   * offered to, or null while none was chosen.
   */
  server: string | null;
}

export const LOCAL_ONLY: DesktopConfig = { local: true, shown: 'local', server: null };

/** Version 3 is what is written; earlier ones kept servers by address and access key. */
interface Stored {
  version?: number;
  local?: boolean;
  shown?: string;
  server?: string | null;
  /** Version 1 only. */
  mode?: 'local' | 'remote';
}

/**
 * The same choice made whole: the window shows this computer's server only while it runs, and
 * the account's page otherwise.
 */
export function settle(cfg: DesktopConfig): DesktopConfig {
  const shown = cfg.shown === 'local' && !cfg.local ? 'account' : cfg.shown;
  return { local: cfg.local, shown, server: cfg.server || null };
}

/** Turns this computer's own server on or off; the window moves to the account's page when it stops. */
export function setLocal(cfg: DesktopConfig, on: boolean): DesktopConfig {
  return settle({ ...cfg, local: on });
}

/** Shows this computer's server (turning it on) or the account's page. */
export function show(cfg: DesktopConfig, id: ServerId): DesktopConfig {
  return settle({ ...cfg, shown: id, local: cfg.local || id === 'local' });
}

/** Chooses the account server the window opens and this computer is offered to; null for none. */
export function chooseServer(cfg: DesktopConfig, id: string | null): DesktopConfig {
  return settle({ ...cfg, server: id, shown: id ? 'account' : cfg.shown });
}

function readStored(dir: string): Stored | null {
  const file = join(dir, 'desktop.json');
  if (!existsSync(file)) return null;
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return s && typeof s === 'object' ? (s as Stored) : null;
  } catch {
    return null;
  }
}

export function readDesktopConfig(dir: string): DesktopConfig {
  const s = readStored(dir);
  if (!s) return LOCAL_ONLY;
  if (s.version === 3) {
    return settle({
      local: s.local !== false,
      shown: s.shown === 'account' ? 'account' : 'local',
      server: typeof s.server === 'string' ? s.server : null,
    });
  }
  // Earlier versions kept servers elsewhere by address and access key. They are dropped: those
  // servers are reached through the account now. A window that showed one shows the account's
  // page instead, and a computer that ran no server of its own keeps none.
  const local = s.version === 2 ? s.local !== false : s.mode !== 'remote';
  const showedRemote = typeof s.shown === 'string' ? s.shown !== 'local' : s.mode === 'remote';
  return settle({ local, shown: showedRemote ? 'account' : 'local', server: null });
}

export function writeDesktopConfig(dir: string, cfg: DesktopConfig) {
  const stored: Stored = { version: 3, local: cfg.local, shown: cfg.shown, server: cfg.server };
  writeFileSync(join(dir, 'desktop.json'), JSON.stringify(stored, null, 2), { mode: 0o600 });
}
