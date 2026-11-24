import {
  helperDriver,
  jpegShot,
  localShot,
  MAC_KEY_CODES,
  MAC_REQUEST_MS,
  MAC_SHOT_MAX,
  type MacDriver,
  type MacShot,
} from './mac';

/**
 * The person's own Windows computer, used by bots the same way as a Mac: the helper is a Windows
 * PowerShell script (`desktop/native/person-computer.ps1`), and the requests are the Mac's, with
 * the keys turned into Windows virtual-key codes on the way.
 */

/** Windows virtual-key codes by the key names the bots' tools know (see `MAC_KEY_CODES`). */
export const WINDOWS_KEYS: Record<string, number> = {
  ...Object.fromEntries([...'abcdefghijklmnopqrstuvwxyz'].map((c) => [c, c.toUpperCase().charCodeAt(0)])),
  ...Object.fromEntries([...'0123456789'].map((c) => [c, c.charCodeAt(0)])),
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, 0x70 + i])),
  return: 0x0d,
  tab: 0x09,
  space: 0x20,
  backspace: 0x08,
  escape: 0x1b,
  delete: 0x2e,
  home: 0x24,
  end: 0x23,
  page_up: 0x21,
  page_down: 0x22,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  // The punctuation keys of a US layout; Windows names them by place, as macOS's codes do.
  minus: 0xbd,
  equal: 0xbb,
  comma: 0xbc,
  period: 0xbe,
  slash: 0xbf,
  semicolon: 0xba,
  apostrophe: 0xde,
  bracketleft: 0xdb,
  bracketright: 0xdd,
  backslash: 0xdc,
  grave: 0xc0,
};

/**
 * Modifiers on Windows. A bot's `ctrl` is Control, as people say it there; `cmd` (also `win`,
 * `super`) is the Windows key, and `alt` is Alt. Fn never reaches Windows, so it is left out.
 */
export const WINDOWS_MODIFIERS: Record<string, number | null> = {
  command: 0x5b,
  control: 0x11,
  option: 0x12,
  shift: 0x10,
  fn: null,
};

/** macOS key codes, as the server sends them, to Windows virtual-key codes. */
const BY_MAC_CODE = new Map<number, number>(
  Object.entries(MAC_KEY_CODES).flatMap(([name, code]) => {
    const vk = WINDOWS_KEYS[name];
    return vk === undefined ? [] : [[code, vk] as [number, number]];
  }),
);

/** A key request for Windows, or null when its key has no Windows twin. */
export function windowsKey(req: {
  code: number;
  modifiers: string[];
}): { vk: number; modifiers: number[] } | null {
  const vk = BY_MAC_CODE.get(req.code);
  if (vk === undefined) return null;
  const modifiers: number[] = [];
  for (const m of req.modifiers) {
    const code = WINDOWS_MODIFIERS[m];
    if (code === undefined) return null;
    if (code !== null && !modifiers.includes(code)) modifiers.push(code);
  }
  return { vk, modifiers };
}

/** Passes requests to the Windows helper, with keys in Windows' codes. */
export function windowsDriver(helper: MacDriver): MacDriver {
  return {
    send(req) {
      if (req.op !== 'key') return helper.send(req);
      const key = windowsKey({
        code: Number(req.code),
        modifiers: Array.isArray(req.modifiers) ? req.modifiers.map(String) : [],
      });
      if (!key) return Promise.resolve({ ok: false, error: 'badRequest' });
      return helper.send({ op: 'key', ...key });
    },
    close: () => helper.close(),
  };
}

/**
 * Takes the picture with the helper itself, which encodes it as JPEG; a busy screen that is too
 * large for one message is taken again at lower quality.
 */
export function helperShot(helper: MacDriver, max = MAC_SHOT_MAX): MacShot {
  return async (size) => {
    for (const quality of [70, 45]) {
      const r = await helper.send({ op: 'shot', ...size, quality });
      if (r.ok !== true || typeof r.data !== 'string') throw new Error(String(r.error ?? 'failed'));
      if (r.data.length <= max) return { data: r.data, mimeType: 'image/jpeg' };
    }
    throw new Error('picture too large');
  };
}

/** Starts Windows PowerShell on the helper script, with no window and no profile of the person's. */
export function windowsHelper(script: string, timeoutMs = MAC_REQUEST_MS): MacDriver {
  return helperDriver('powershell.exe', timeoutMs, [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
  ]);
}

/**
 * Starts the helper at `path`: the macOS program, or the Windows PowerShell script (`.ps1`).
 * `picture` is how a Mac takes its screen's picture: PNG where the server runs on it, JPEG to send
 * across the network. The Windows helper always gives JPEG.
 */
export function startHelper(path: string, picture: 'png' | 'jpeg'): { driver: MacDriver; shot: MacShot } {
  if (path.toLowerCase().endsWith('.ps1')) {
    const helper = windowsHelper(path);
    return { driver: windowsDriver(helper), shot: helperShot(helper) };
  }
  return { driver: helperDriver(path), shot: picture === 'png' ? localShot() : jpegShot() };
}
