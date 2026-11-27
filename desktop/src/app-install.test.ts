import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APPS_FOLDER,
  createInstaller,
  desktopEntry,
  desktopEntryAppId,
  launcherName,
  macInfoPlist,
  macPlistAppId,
  type InstallEnv,
  type ShortcutDetails,
} from './app-install';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'leafbot-apps-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function env(platform: NodeJS.Platform, extra: Partial<InstallEnv> = {}): InstallEnv {
  const home = path.join(root, 'home');
  const desktop = path.join(home, 'Desktop');
  mkdirSync(desktop, { recursive: true });
  return {
    platform,
    path,
    home,
    userData: path.join(root, 'userData'),
    appData: path.join(home, 'AppData', 'Roaming'),
    desktopDir: () => desktop,
    executable: '/opt/Leaf Bot/leafbot',
    hostBundleId: 'com.esmworks.leafbot',
    hostIcon: null,
    fs: fs as unknown as InstallEnv['fs'],
    ...extra,
  };
}

describe('launcher names', () => {
  it('keeps to what every file system takes', () => {
    expect(launcherName('Bütçe / Harcamalar: 2026?')).toBe('Bütçe Harcamalar 2026');
    expect(launcherName('..gizli')).toBe('gizli');
    expect(launcherName('Rapor. ')).toBe('Rapor');
    expect(launcherName('CON')).toBe('CON app');
    expect(launcherName('\u0000\n')).toBe('App');
    expect(launcherName('x'.repeat(200))).toHaveLength(60);
  });

  it('marks each launcher with its app, and reads only that mark back', () => {
    const plist = macInfoPlist({
      id: 'a_1',
      name: 'A & B <x>',
      hostBundleId: 'com.esmworks.leafbot',
      icon: true,
    });
    expect(plist).toContain('<string>A &amp; B &lt;x&gt;</string>');
    expect(plist).toContain('<string>com.esmworks.leafbot.app.a-1</string>');
    expect(macPlistAppId(plist)).toBe('a_1');
    expect(macPlistAppId('<key>CFBundleName</key><string>a_1</string>')).toBeNull();
    const entry = desktopEntry({
      id: 'a1',
      name: 'Rapor\nExec=rm',
      executable: '/opt/a "b"/leafbot',
      icon: null,
    });
    expect(entry).toContain('Name=Rapor Exec=rm\n');
    expect(entry).toContain('Exec="/opt/a \\"b\\"/leafbot" "leafbot://app/a1"');
    expect(desktopEntryAppId(entry)).toBe('a1');
  });
});

describe('installing on Linux', () => {
  it('writes a desktop entry that starts Leaf Bot with the link, and removes it again', async () => {
    const e = env('linux');
    const installer = createInstaller(e);
    expect(await installer.install('app1', 'Harcamalar')).toEqual({
      id: 'app1',
      name: 'Harcamalar',
      desktop: false,
    });
    const file = path.join(root, 'home', '.local', 'share', 'applications', 'Harcamalar.desktop');
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('Exec="/opt/Leaf Bot/leafbot" "leafbot://app/app1"');
    expect(statSync(file).mode & 0o111).not.toBe(0);
    expect(await installer.installed()).toEqual([{ id: 'app1', name: 'Harcamalar', desktop: false }]);

    await installer.uninstall('app1');
    expect(existsSync(file)).toBe(false);
    expect(await installer.installed()).toEqual([]);
  });

  it("never replaces or removes a file that is not the app's own", async () => {
    const e = env('linux');
    const installer = createInstaller(e);
    const dir = path.join(root, 'home', '.local', 'share', 'applications');
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'Rapor.desktop'), '[Desktop Entry]\nName=Kendi dosyam\n');
    await installer.install('app1', 'Rapor');
    expect(readFileSync(path.join(dir, 'Rapor.desktop'), 'utf8')).toContain('Kendi dosyam');
    expect(readFileSync(path.join(dir, 'Rapor 2.desktop'), 'utf8')).toContain('leafbot://app/app1');

    // Another app's launcher of the same name is another app's.
    await installer.install('app2', 'Rapor');
    expect(readFileSync(path.join(dir, 'Rapor 3.desktop'), 'utf8')).toContain('leafbot://app/app2');

    // The person put their own file where the launcher was: it stays.
    writeFileSync(path.join(dir, 'Rapor 2.desktop'), '[Desktop Entry]\nName=Yeni\n');
    await installer.uninstall('app1');
    expect(readFileSync(path.join(dir, 'Rapor 2.desktop'), 'utf8')).toContain('Yeni');
  });

  it('puts it on the Desktop and takes it off, renaming both together', async () => {
    const e = env('linux');
    const installer = createInstaller(e);
    const desktop = e.desktopDir()!;
    // Adding to the Desktop installs it first.
    await installer.setDesktop('app1', 'Takvim', true);
    expect(existsSync(path.join(desktop, 'Takvim.desktop'))).toBe(true);
    expect(existsSync(path.join(installer.launcherDir, 'Takvim.desktop'))).toBe(true);

    // Renamed: the old files go, the new ones stay on the Desktop as before.
    await installer.install('app1', 'Ajanda');
    expect(existsSync(path.join(desktop, 'Takvim.desktop'))).toBe(false);
    expect(existsSync(path.join(installer.launcherDir, 'Takvim.desktop'))).toBe(false);
    expect(existsSync(path.join(desktop, 'Ajanda.desktop'))).toBe(true);
    expect(await installer.installed()).toEqual([{ id: 'app1', name: 'Ajanda', desktop: true }]);

    await installer.setDesktop('app1', 'Ajanda', false);
    expect(existsSync(path.join(desktop, 'Ajanda.desktop'))).toBe(false);
    expect(existsSync(path.join(installer.launcherDir, 'Ajanda.desktop'))).toBe(true);
  });

  it('does not make a Desktop that is not there', async () => {
    const e = env('linux', { desktopDir: () => path.join(root, 'nowhere') });
    await expect(createInstaller(e).setDesktop('app1', 'X', true)).rejects.toThrow('no Desktop folder');
    expect(existsSync(path.join(root, 'nowhere'))).toBe(false);
  });

  it('refuses an id that could leave its folder', async () => {
    await expect(createInstaller(env('linux')).install('../x', 'X')).rejects.toThrow('bad app id');
  });
});

describe('installing on macOS', () => {
  it('builds a bundle in ~/Applications that hands the link to Leaf Bot', async () => {
    const icon = path.join(root, 'icon.icns');
    writeFileSync(icon, 'ICNS');
    const installer = createInstaller(env('darwin', { hostIcon: icon }));
    await installer.install('app1', 'Harcamalar');
    const bundle = path.join(root, 'home', 'Applications', APPS_FOLDER, 'Harcamalar.app');
    expect(macPlistAppId(readFileSync(path.join(bundle, 'Contents', 'Info.plist'), 'utf8'))).toBe('app1');
    const program = path.join(bundle, 'Contents', 'MacOS', 'launch');
    expect(readFileSync(program, 'utf8')).toContain("open -b 'com.esmworks.leafbot' 'leafbot://app/app1'");
    expect(statSync(program).mode & 0o111).not.toBe(0);
    expect(readFileSync(path.join(bundle, 'Contents', 'Resources', 'icon.icns'), 'utf8')).toBe('ICNS');

    await installer.uninstall('app1');
    expect(existsSync(bundle)).toBe(false);
  });
});

describe('installing on Windows', () => {
  it('writes a Start menu shortcut that starts Leaf Bot with the link', async () => {
    const written = new Map<string, ShortcutDetails>();
    const shell = {
      writeShortcutLink(file: string, _op: 'create' | 'replace', details: ShortcutDetails) {
        writeFileSync(file, 'lnk');
        written.set(file, details);
        return true;
      },
      readShortcutLink: (file: string) => written.get(file) ?? { target: '' },
    };
    const installer = createInstaller(env('win32', { shell, executable: 'C:\\Leaf Bot\\Leaf Bot.exe' }));
    await installer.install('app1', 'Harcamalar');
    const file = path.join(
      root,
      'home',
      'AppData',
      'Roaming',
      'Microsoft',
      'Windows',
      'Start Menu',
      'Programs',
      APPS_FOLDER,
      'Harcamalar.lnk',
    );
    expect(written.get(file)).toMatchObject({
      target: 'C:\\Leaf Bot\\Leaf Bot.exe',
      args: 'leafbot://app/app1',
    });
    await installer.uninstall('app1');
    expect(existsSync(file)).toBe(false);
  });
});
