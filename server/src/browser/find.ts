import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';

/**
 * The browser program for the bots: `LEAFBOT_BROWSER` if set, else an installed Chrome, Edge or
 * Chromium in its usual place. Each bot gets its own profile, so the person's own browser profile
 * is never touched.
 */
export function findBrowser(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (env.LEAFBOT_BROWSER) return exists(env.LEAFBOT_BROWSER) ? env.LEAFBOT_BROWSER : null;
  return candidates(env, platform).find(exists) ?? null;
}

function candidates(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(
      (r): r is string => !!r,
    );
    return [
      ...roots.map((r) => win32.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map((r) => win32.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ];
  }
  if (platform === 'darwin') {
    const apps = ['/Applications', ...(env.HOME ? [posix.join(env.HOME, 'Applications')] : [])];
    return apps.flatMap((a) => [
      posix.join(a, 'Google Chrome.app/Contents/MacOS/Google Chrome'),
      posix.join(a, 'Chromium.app/Contents/MacOS/Chromium'),
      posix.join(a, 'Microsoft Edge.app/Contents/MacOS/Microsoft Edge'),
    ]);
  }
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/microsoft-edge',
    '/snap/bin/chromium',
  ];
}

/**
 * The ffmpeg program that turns a page's frames into a video: `LEAFBOT_FFMPEG` if set, else the
 * first `ffmpeg` on the PATH or in a usual place. A desktop app started from the Dock gets a short
 * PATH, so Homebrew's folders are looked in by name.
 */
export function findFfmpeg(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exists: (p: string) => boolean = existsSync,
): string | null {
  if (env.LEAFBOT_FFMPEG) return exists(env.LEAFBOT_FFMPEG) ? env.LEAFBOT_FFMPEG : null;
  const path = platform === 'win32' ? win32 : posix;
  const name = platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  if (platform !== 'win32') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  return dirs.map((d) => path.join(d, name)).find(exists) ?? null;
}
