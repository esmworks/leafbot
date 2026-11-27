import type path from 'node:path';

/**
 * Pages saved as apps, installed on this computer: each gets a launcher of its own that opens
 * `leafbot://app/<id>`, the app in a window of its own, without the chat. The person may also put
 * a copy on the Desktop.
 *
 * - macOS: a small bundle in ~/Applications/Leaf Bot Apps whose program asks Leaf Bot to open the link;
 * - Windows: a Start menu shortcut in "Leaf Bot Apps" that starts Leaf Bot with the link;
 * - Linux: a desktop entry in ~/.local/share/applications that does the same.
 *
 * Nothing is written outside those folders, the Desktop and this app's own data folder. A file
 * already there is replaced or removed only when it carries the same app's id inside it (the
 * bundle's Info.plist, the entry's own key, the shortcut's link), so a file the person made, or
 * another app's launcher, is never touched.
 */

export const APPS_FOLDER = 'Leaf Bot Apps';
/** The id in launcher files and links: what the server's app ids are made of. */
export const isAppId = (v: unknown): v is string => typeof v === 'string' && /^[\w-]{1,64}$/.test(v);
export const appLink = (id: string) => `leafbot://app/${id}`;

/**
 * A name every file system takes: no path separators, characters Windows refuses or control
 * characters; no leading dot (a hidden file) or trailing dot or space (Windows drops them).
 */
export function launcherName(name: string): string {
  const clean = name
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .slice(0, 60)
    .trim();
  // Names Windows keeps for devices.
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean)) return `${clean} app`;
  return clean || 'App';
}

const xml = (s: string) =>
  s.replace(
    /[<>&"']/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]!,
  );

/** The key in a launcher bundle's Info.plist that says which app it opens. */
const PLIST_KEY = 'LeafBotAppId';
/** The key in a desktop entry that says which app it opens. */
const ENTRY_KEY = 'X-LeafBot-App';

export function macInfoPlist(o: { id: string; name: string; hostBundleId: string; icon: boolean }): string {
  const bundleId = `${o.hostBundleId}.app.${o.id.replace(/[^A-Za-z0-9-]/g, '-')}`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>${xml(o.name)}</string>
  <key>CFBundleDisplayName</key><string>${xml(o.name)}</string>
  <key>CFBundleIdentifier</key><string>${xml(bundleId)}</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>1.0</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>${o.icon ? '\n  <key>CFBundleIconFile</key><string>icon</string>' : ''}
  <key>LSUIElement</key><true/>
  <key>${PLIST_KEY}</key><string>${xml(o.id)}</string>
</dict>
</plist>
`;
}

/** The bundle's program: hands the link to Leaf Bot itself, by its bundle id, and is done. */
export const macLauncherScript = (id: string, hostBundleId: string) =>
  `#!/bin/sh\nexec /usr/bin/open -b '${hostBundleId}' '${appLink(id)}'\n`;

export function macPlistAppId(text: string | null): string | null {
  const m = text && new RegExp(`<key>${PLIST_KEY}</key>\\s*<string>([\\w-]{1,64})</string>`).exec(text);
  return m ? m[1]! : null;
}

/** A desktop entry's value: one line, with the characters the format gives meaning escaped. */
const entryValue = (s: string) => s.replace(/\\/g, '\\\\').replace(/[\r\n\t]/g, ' ');
/** One word of the entry's Exec line, quoted as the format asks. */
const execArg = (s: string) => `"${s.replace(/(["`$\\])/g, '\\$1')}"`.replace(/%/g, '%%');

export function desktopEntry(o: {
  id: string;
  name: string;
  executable: string;
  icon: string | null;
}): string {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    `Name=${entryValue(o.name)}`,
    `Exec=${execArg(o.executable)} ${execArg(appLink(o.id))}`,
    ...(o.icon ? [`Icon=${entryValue(o.icon)}`] : []),
    'Terminal=false',
    'Categories=Utility;',
    `${ENTRY_KEY}=${o.id}`,
    '',
  ].join('\n');
}

export function desktopEntryAppId(text: string | null): string | null {
  const m = text && new RegExp(`^${ENTRY_KEY}=([\\w-]{1,64})\\s*$`, 'm').exec(text);
  return m ? m[1]! : null;
}

type Kind = 'bundle' | 'entry' | 'shortcut';
interface Placed {
  path: string;
  kind: Kind;
}
interface Entry {
  name: string;
  launcher: Placed;
  desktop?: Placed;
}
interface Manifest {
  version: 1;
  apps: Record<string, Entry>;
}

export interface ShortcutDetails {
  target: string;
  args?: string;
  icon?: string;
  iconIndex?: number;
  description?: string;
}

/** The parts of `node:fs/promises` the installer uses, so tests can hand it a folder of their own. */
export interface InstallFs {
  readFile(path: string, encoding: 'utf8'): Promise<string>;
  readFile(path: string): Promise<Buffer>;
  writeFile(path: string, data: string | Buffer, opts?: { mode?: number }): Promise<void>;
  mkdir(path: string, opts: { recursive: true }): Promise<unknown>;
  rm(path: string, opts: { recursive?: boolean; force?: boolean }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  lstat(path: string): Promise<{ isDirectory(): boolean; isFile(): boolean; isSymbolicLink(): boolean }>;
  chmod(path: string, mode: number): Promise<void>;
  copyFile(from: string, to: string): Promise<void>;
}

export interface InstallEnv {
  platform: NodeJS.Platform;
  path: typeof path;
  home: string;
  /** This app's own data folder: the list of what was written is kept there. */
  userData: string;
  /** Windows: the roaming app data folder the Start menu lives in. */
  appData?: string;
  /** The Desktop folder, or null when there is none. It is never made. */
  desktopDir(): string | null;
  /** Linux: the XDG data folder; ~/.local/share when unset. */
  dataHome?: string;
  /** What a Windows shortcut or Linux entry starts: Leaf Bot itself (its AppImage, if it is one). */
  executable: string;
  /** macOS: Leaf Bot's bundle id, which the launcher asks to open the link. */
  hostBundleId: string;
  /** Leaf Bot's icon: an .icns on macOS, a .png on Linux; Windows takes the executable's. */
  hostIcon: string | null;
  fs: InstallFs;
  /** Electron's shortcut calls; Windows only. */
  shell?: {
    writeShortcutLink(path: string, op: 'create' | 'replace', details: ShortcutDetails): boolean;
    readShortcutLink(path: string): ShortcutDetails;
  };
  log?(line: string): void;
}

export interface Installed {
  id: string;
  name: string;
  desktop: boolean;
}

/** Whether this computer can have launchers: a packaged app on macOS, Windows or Linux. */
export function canInstall(env: Pick<InstallEnv, 'platform' | 'shell'>): boolean {
  if (env.platform === 'win32') return !!env.shell;
  return env.platform === 'darwin' || env.platform === 'linux';
}

export function createInstaller(env: InstallEnv) {
  const { path, fs, platform } = env;
  const log = env.log ?? (() => {});
  const stateFile = path.join(env.userData, 'app-launchers.json');
  const dataHome = env.dataHome || path.join(env.home, '.local', 'share');
  const launcherDir =
    platform === 'darwin'
      ? path.join(env.home, 'Applications', APPS_FOLDER)
      : platform === 'win32'
        ? path.join(env.appData ?? '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', APPS_FOLDER)
        : path.join(dataHome, 'applications');
  const kind: Kind = platform === 'darwin' ? 'bundle' : platform === 'win32' ? 'shortcut' : 'entry';
  const ext = { bundle: '.app', shortcut: '.lnk', entry: '.desktop' }[kind];

  const stat = async (p: string) => {
    try {
      return await fs.lstat(p);
    } catch {
      return null;
    }
  };
  const text = async (p: string) => {
    try {
      return await fs.readFile(p, 'utf8');
    } catch {
      return null;
    }
  };

  async function read(): Promise<Manifest> {
    try {
      const m = JSON.parse((await text(stateFile)) ?? '') as Manifest;
      if (m?.version === 1 && m.apps && typeof m.apps === 'object') return m;
    } catch {
      // Missing or unreadable: nothing is known to be installed.
    }
    return { version: 1, apps: {} };
  }
  async function write(m: Manifest) {
    await fs.mkdir(env.userData, { recursive: true });
    const temp = `${stateFile}.${process.pid}.tmp`;
    await fs.writeFile(temp, JSON.stringify(m, null, 2));
    await fs.rename(temp, stateFile);
  }

  /** Only these folders are ever written in, and only directly. */
  const inside = (dir: string | null, file: string) =>
    !!dir && path.dirname(file) === dir && path.basename(file) !== '' && !file.includes('\0');
  const allowed = (file: string) => inside(launcherDir, file) || inside(env.desktopDir(), file);

  /** Whether `file` is a launcher written for `id`: the id is inside it, and it is no link. */
  async function owns(id: string, file: string, k: Kind): Promise<boolean> {
    const st = await stat(file);
    if (!st || st.isSymbolicLink()) return false;
    if (k === 'bundle')
      return st.isDirectory() && macPlistAppId(await text(path.join(file, 'Contents', 'Info.plist'))) === id;
    if (k === 'entry') return st.isFile() && desktopEntryAppId(await text(file)) === id;
    try {
      return st.isFile() && env.shell?.readShortcutLink(file).args?.trim() === appLink(id);
    } catch {
      return false;
    }
  }

  /** `<name>`, else `<name> 2`, `<name> 3`…: the first that is free or already this app's. */
  async function freeFile(id: string, dir: string, name: string, k: Kind): Promise<string> {
    const base = launcherName(name);
    for (let n = 1; n <= 50; n++) {
      const file = path.join(dir, `${n === 1 ? base : `${base} ${n}`}${ext}`);
      if (!(await stat(file)) || (await owns(id, file, k))) return file;
    }
    throw new Error('no free name');
  }

  async function remove(id: string, placed: Placed | undefined) {
    if (!placed) return;
    if (!allowed(placed.path)) return log(`left ${placed.path}: outside the launcher folders`);
    if (!(await stat(placed.path))) return;
    if (!(await owns(id, placed.path, placed.kind)))
      return log(`left ${placed.path}: not this app's launcher`);
    await fs.rm(placed.path, { recursive: placed.kind === 'bundle', force: true });
  }

  /** Writes the launcher for `id` as `file`, replacing only this app's own. */
  async function place(id: string, name: string, file: string) {
    if (!allowed(file)) throw new Error('outside the launcher folders');
    const shown = path.basename(file, ext);
    if (kind === 'bundle') {
      // Built beside it and moved into place, so a half-written bundle is never there to open.
      const staging = path.join(path.dirname(file), `.leafbot-${id}.staging`);
      await fs.rm(staging, { recursive: true, force: true });
      try {
        await fs.mkdir(path.join(staging, 'Contents', 'MacOS'), { recursive: true });
        await fs.mkdir(path.join(staging, 'Contents', 'Resources'), { recursive: true });
        let icon = false;
        if (env.hostIcon) {
          try {
            await fs.copyFile(env.hostIcon, path.join(staging, 'Contents', 'Resources', 'icon.icns'));
            icon = true;
          } catch {
            // Without an icon of its own the bundle shows the system's.
          }
        }
        await fs.writeFile(
          path.join(staging, 'Contents', 'Info.plist'),
          macInfoPlist({ id, name: shown, hostBundleId: env.hostBundleId, icon }),
        );
        await fs.writeFile(path.join(staging, 'Contents', 'PkgInfo'), 'APPL????');
        const program = path.join(staging, 'Contents', 'MacOS', 'launch');
        await fs.writeFile(program, macLauncherScript(id, env.hostBundleId), { mode: 0o755 });
        await fs.chmod(program, 0o755);
        await fs.rm(file, { recursive: true, force: true });
        await fs.rename(staging, file);
      } catch (err) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
        throw err;
      }
      return;
    }
    if (kind === 'entry') {
      await fs.writeFile(
        file,
        desktopEntry({ id, name: shown, executable: env.executable, icon: env.hostIcon }),
        // A desktop entry on the Desktop runs only when it may be run.
        { mode: 0o755 },
      );
      await fs.chmod(file, 0o755);
      return;
    }
    const ok = env.shell!.writeShortcutLink(file, (await stat(file)) ? 'replace' : 'create', {
      target: env.executable,
      args: appLink(id),
      icon: env.executable,
      iconIndex: 0,
      description: shown,
    });
    if (!ok) throw new Error(`Windows did not write ${file}`);
  }

  async function installed(): Promise<Installed[]> {
    const m = await read();
    return Object.entries(m.apps).map(([id, e]) => ({ id, name: e.name, desktop: !!e.desktop }));
  }

  /** Installs the app, or renames its launchers when it is installed under another name. */
  async function install(id: string, name: string, opts: { desktop?: boolean } = {}): Promise<Installed> {
    if (!isAppId(id)) throw new Error('bad app id');
    const m = await read();
    const before = m.apps[id];
    await fs.mkdir(launcherDir, { recursive: true });
    const file = await freeFile(id, launcherDir, name, kind);
    await place(id, name, file);
    if (before && before.launcher.path !== file) await remove(id, before.launcher);
    const entry: Entry = { name, launcher: { path: file, kind } };
    const wantDesktop = opts.desktop ?? !!before?.desktop;
    if (wantDesktop) {
      const dir = env.desktopDir();
      // The Desktop is never made: without one, the launcher stands alone.
      if (!dir || !(await stat(dir))?.isDirectory()) throw new Error('no Desktop folder');
      const onDesktop = await freeFile(id, dir, name, kind);
      await place(id, name, onDesktop);
      if (before?.desktop && before.desktop.path !== onDesktop) await remove(id, before.desktop);
      entry.desktop = { path: onDesktop, kind };
    } else {
      await remove(id, before?.desktop);
    }
    m.apps[id] = entry;
    await write(m);
    return { id, name, desktop: !!entry.desktop };
  }

  async function uninstall(id: string): Promise<void> {
    const m = await read();
    const e = m.apps[id];
    if (!e) return;
    await remove(id, e.launcher);
    await remove(id, e.desktop);
    delete m.apps[id];
    await write(m);
  }

  /** Puts the app on the Desktop, or takes it off; adding it installs it first. */
  async function setDesktop(id: string, name: string, on: boolean): Promise<Installed | null> {
    const m = await read();
    const e = m.apps[id];
    if (on) return install(id, e?.name ?? name, { desktop: true });
    if (!e) return null;
    await remove(id, e.desktop);
    delete e.desktop;
    await write(m);
    return { id, name: e.name, desktop: false };
  }

  return { launcherDir, installed, install, uninstall, setDesktop };
}

export type Installer = ReturnType<typeof createInstaller>;
