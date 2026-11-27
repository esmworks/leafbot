import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { t } from './i18n';

/** A server elsewhere: its address and the access key ('' when a pairing code signed the window in). */
export interface RemoteServer {
  url: string;
  key: string;
}

/** Which server: 'local' for this computer's own, or a remote server's address. */
export type ServerId = 'local' | (string & {});

/**
 * The servers this app keeps. This computer's own server can run while the app also stays connected
 * to servers elsewhere, so its bots and routines go on while the window shows another one. The
 * window shows one server at a time.
 */
export interface DesktopConfig {
  /** This computer's own server runs. */
  local: boolean;
  /** Servers elsewhere, in the order they were added. */
  remotes: RemoteServer[];
  /** The server the window shows. */
  shown: ServerId;
}

export const LOCAL_ONLY: DesktopConfig = { local: true, remotes: [], shown: 'local' };

interface StoredRemote {
  url: string;
  /** Access key encrypted with the OS keychain (base64). */
  keyEncrypted: string;
}

/** Version 2 keeps several servers; version 1 (no `version`) kept one, either here or elsewhere. */
interface Stored {
  version?: 2;
  local?: boolean;
  remotes?: StoredRemote[];
  shown?: string;
  /** Version 1 only. */
  mode?: 'local' | 'remote';
  url?: string;
  keyEncrypted?: string;
}

export interface Crypto {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(b: Buffer): string;
}

/**
 * The main server: the first server elsewhere, when there is one, since it keeps running while this
 * computer sleeps or is off; otherwise this computer's own. What belongs to the person across
 * servers is meant to live there.
 */
export function mainServer(cfg: DesktopConfig): ServerId {
  return cfg.remotes[0]?.url ?? 'local';
}

export function remoteOf(cfg: DesktopConfig, id: ServerId): RemoteServer | null {
  return id === 'local' ? null : (cfg.remotes.find((r) => r.url === id) ?? null);
}

/**
 * The same choice made whole: at least one server is kept (this computer's own when no other is
 * left), and the window shows one that is kept, the main server when the one it showed is gone.
 */
export function settle(cfg: DesktopConfig): DesktopConfig {
  const remotes: RemoteServer[] = [];
  for (const r of cfg.remotes) if (!remotes.some((x) => x.url === r.url)) remotes.push(r);
  const local = cfg.local || remotes.length === 0;
  const next = { local, remotes, shown: cfg.shown };
  const kept = next.shown === 'local' ? local : remotes.some((r) => r.url === next.shown);
  if (!kept) next.shown = mainServer(next);
  return next;
}

/** Adds a server elsewhere, or takes a new key for one already kept, and shows it. */
export function addRemote(cfg: DesktopConfig, remote: RemoteServer): DesktopConfig {
  const known = cfg.remotes.some((r) => r.url === remote.url);
  const remotes = known
    ? cfg.remotes.map((r) => (r.url === remote.url ? remote : r))
    : [...cfg.remotes, remote];
  return settle({ ...cfg, remotes, shown: remote.url });
}

/** Forgets a server elsewhere; this computer's own server is kept on when it is the last one. */
export function removeRemote(cfg: DesktopConfig, url: string): DesktopConfig {
  return settle({ ...cfg, remotes: cfg.remotes.filter((r) => r.url !== url) });
}

/** Turns this computer's own server on or off; it stays on while no other server is kept. */
export function setLocal(cfg: DesktopConfig, on: boolean): DesktopConfig {
  return settle({ ...cfg, local: on });
}

export function show(cfg: DesktopConfig, id: ServerId): DesktopConfig {
  return settle({ ...cfg, shown: id, local: cfg.local || id === 'local' });
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

/** The kept servers elsewhere, as stored, whichever version wrote them. */
function storedRemotes(s: Stored): StoredRemote[] {
  if (s.version === 2) {
    return (Array.isArray(s.remotes) ? s.remotes : []).filter(
      (r): r is StoredRemote =>
        !!r && typeof r.url === 'string' && !!r.url && typeof r.keyEncrypted === 'string',
    );
  }
  return s.mode === 'remote' && s.url && typeof s.keyEncrypted === 'string'
    ? [{ url: s.url, keyEncrypted: s.keyEncrypted }]
    : [];
}

export function readDesktopConfig(dir: string, crypto: Crypto): DesktopConfig {
  const s = readStored(dir);
  if (!s) return LOCAL_ONLY;
  const remotes: RemoteServer[] = [];
  if (crypto.isEncryptionAvailable()) {
    for (const r of storedRemotes(s)) {
      try {
        remotes.push({ url: r.url, key: crypto.decryptString(Buffer.from(r.keyEncrypted, 'base64')) });
      } catch {
        // A key the keychain will not give back leaves that server out; `lockedRemote` says so first.
      }
    }
  }
  if (s.version === 2) {
    return settle({
      local: s.local !== false,
      remotes,
      shown: typeof s.shown === 'string' && s.shown ? s.shown : 'local',
    });
  }
  // Version 1 ran this computer's server only while no server elsewhere was chosen; that stays so
  // until the person turns it on.
  return settle({ local: s.mode !== 'remote', remotes, shown: remotes[0]?.url ?? 'local' });
}

/**
 * The host of a saved remote server whose key cannot be read yet: the keychain is not open (on
 * Linux the keyring can come up after the app) or refuses to decrypt. Reading the config then would
 * quietly leave out the server the person chose, so the caller waits or asks first. Null when there
 * is nothing to wait for.
 */
export function lockedRemote(dir: string, crypto: Crypto): string | null {
  const s = readStored(dir);
  if (!s) return null;
  for (const r of storedRemotes(s)) {
    let host: string;
    try {
      host = new URL(r.url).host;
    } catch {
      continue;
    }
    if (!crypto.isEncryptionAvailable()) return host;
    try {
      crypto.decryptString(Buffer.from(r.keyEncrypted, 'base64'));
    } catch {
      return host;
    }
  }
  return null;
}

export function writeDesktopConfig(dir: string, cfg: DesktopConfig, crypto: Crypto) {
  if (cfg.remotes.length && !crypto.isEncryptionAvailable()) throw new Error(t('error.noKeychain'));
  const stored: Stored = {
    version: 2,
    local: cfg.local,
    remotes: cfg.remotes.map((r) => ({
      url: r.url,
      keyEncrypted: crypto.encryptString(r.key).toString('base64'),
    })),
    shown: cfg.shown,
  };
  writeFileSync(join(dir, 'desktop.json'), JSON.stringify(stored, null, 2), { mode: 0o600 });
}

/** Remote servers must use HTTPS, except on the local network for testing. */
export function normalizeRemoteUrl(input: string): string {
  const u = new URL(input.trim());
  const local = /^(localhost|127\.0\.0\.1|\[::1\]|.+\.local)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) {
    throw new Error(t('error.httpsRequired'));
  }
  return u.origin;
}
