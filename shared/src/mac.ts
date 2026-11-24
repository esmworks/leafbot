import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import { z } from 'zod';

/**
 * The person's own Mac, used by bots: the helper program that moves the mouse and types, the
 * screen's picture, and the requests a server sends to a desktop app that offers its Mac from
 * afar. The server and the desktop app both use this, so a request means the same on each side.
 */

const run = promisify(execFile);

/** Talks to the helper, or to a Mac across the network: one request at a time, one answer each. */
export interface MacDriver {
  send(req: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/**
 * The longest one request may take: typing a long text takes a few seconds; a helper that hangs
 * is stopped, so the Mac is not held by a step that never ends.
 */
export const MAC_REQUEST_MS = 30_000;

/** Starts the helper program and keeps it running until closed. */
export function helperDriver(path: string, timeoutMs = MAC_REQUEST_MS, args: string[] = []): MacDriver {
  let child: ChildProcessWithoutNullStreams | null = null;
  let next = 1;
  const waiting = new Map<number, (r: Record<string, unknown>) => void>();
  let chain: Promise<unknown> = Promise.resolve();

  const start = () => {
    // No console window on Windows, where the helper is a PowerShell script.
    const c = spawn(path, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    createInterface({ input: c.stdout }).on('line', (line) => {
      try {
        const r = JSON.parse(line) as Record<string, unknown>;
        const done = waiting.get(Number(r.id));
        waiting.delete(Number(r.id));
        done?.(r);
      } catch {
        // Not an answer: ignored.
      }
    });
    c.stderr.resume();
    const fail = () => {
      for (const done of waiting.values()) done({ ok: false, error: 'failed' });
      waiting.clear();
      if (child === c) child = null;
    };
    c.on('exit', fail);
    c.on('error', fail);
    // Writing to a helper that has just ended fails here, not in the process that started it.
    c.stdin.on('error', fail);
    return c;
  };

  return {
    send(req) {
      const sent = chain.then(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            const c = (child ??= start());
            const id = next++;
            const timer = setTimeout(() => {
              waiting.delete(id);
              resolve({ ok: false, error: 'failed' });
              c.kill();
            }, timeoutMs);
            waiting.set(id, (r) => {
              clearTimeout(timer);
              resolve(r);
            });
            c.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
          }),
      );
      chain = sent.catch(() => undefined);
      return sent;
    },
    close() {
      child?.kill();
      child = null;
    },
  };
}

/** Takes a picture of the main screen into `file` (PNG), with the pointer in it. */
async function captureScreen(file: string): Promise<void> {
  await run('/usr/sbin/screencapture', ['-x', '-C', '-m', '-t', 'png', file]);
}

/** Scales a PNG in place to exactly `size`. */
async function scalePng(file: string, size: { width: number; height: number }): Promise<void> {
  await run('/usr/bin/sips', ['-z', String(size.height), String(size.width), file]);
}

/** Scales a PNG to exactly `size` and writes it to `out` as JPEG of `quality` (0–100). */
async function toJpeg(file: string, size: { width: number; height: number }, out: string, quality: number) {
  await run('/usr/bin/sips', [
    '-z',
    String(size.height),
    String(size.width),
    '-s',
    'format',
    'jpeg',
    '-s',
    'formatOptions',
    String(quality),
    file,
    '--out',
    out,
  ]);
}

/** A picture of the screen: base64 data and its type. */
export interface MacPicture {
  data: string;
  mimeType: 'image/png' | 'image/jpeg';
}

/** A picture of the main screen at `size`. */
export type MacShot = (size: { width: number; height: number }) => Promise<MacPicture>;

/** Takes the picture on this Mac as PNG, with macOS's own tools; `io` stands in for them in tests. */
export function localShot(
  io: {
    capture: (file: string) => Promise<void>;
    scale: (file: string, size: { width: number; height: number }) => Promise<void>;
  } = { capture: captureScreen, scale: scalePng },
): MacShot {
  return async (size) => {
    const dir = await mkdtemp(join(tmpdir(), 'leafbot-screen-'));
    const file = join(dir, 'screen.png');
    try {
      await io.capture(file);
      await io.scale(file, size);
      return { data: (await readFile(file)).toString('base64'), mimeType: 'image/png' };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/**
 * The most a picture sent across the network may be, as base64. The server's socket takes a
 * message of 1 MB at most and closes the connection on a larger one, so a picture stays well under.
 */
export const MAC_SHOT_MAX = 700_000;

/**
 * Takes the picture for a server elsewhere: JPEG, which the server turns any picture into for the
 * model anyway, a few times smaller than PNG. A busy screen that is still too large is taken again
 * at lower quality; one that is too large even so is not sent.
 */
export function jpegShot(
  stand: {
    capture?: (file: string) => Promise<void>;
    toJpeg?: (
      file: string,
      size: { width: number; height: number },
      out: string,
      quality: number,
    ) => Promise<void>;
  } = {},
  max = MAC_SHOT_MAX,
): MacShot {
  const io = { capture: captureScreen, toJpeg, ...stand };
  return async (size) => {
    const dir = await mkdtemp(join(tmpdir(), 'leafbot-screen-'));
    const file = join(dir, 'screen.png');
    try {
      await io.capture(file);
      for (const quality of [70, 45]) {
        const out = join(dir, `screen-${quality}.jpg`);
        await io.toJpeg(file, size, out, quality);
        const data = (await readFile(out)).toString('base64');
        if (data.length <= max) return { data, mimeType: 'image/jpeg' };
      }
      throw new Error('picture too large');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
}

/**
 * macOS virtual key codes by name (their place on the keyboard, whatever its layout). Requests
 * carry these; the Windows helper's are made from them (`windowsKey`).
 */
export const MAC_KEY_CODES: Record<string, number> = {
  a: 0,
  s: 1,
  d: 2,
  f: 3,
  h: 4,
  g: 5,
  z: 6,
  x: 7,
  c: 8,
  v: 9,
  b: 11,
  q: 12,
  w: 13,
  e: 14,
  r: 15,
  y: 16,
  t: 17,
  '1': 18,
  '2': 19,
  '3': 20,
  '4': 21,
  '6': 22,
  '5': 23,
  equal: 24,
  '9': 25,
  '7': 26,
  minus: 27,
  '8': 28,
  '0': 29,
  bracketright: 30,
  o: 31,
  u: 32,
  bracketleft: 33,
  i: 34,
  p: 35,
  return: 36,
  l: 37,
  j: 38,
  apostrophe: 39,
  k: 40,
  semicolon: 41,
  backslash: 42,
  comma: 43,
  slash: 44,
  n: 45,
  m: 46,
  period: 47,
  tab: 48,
  space: 49,
  grave: 50,
  backspace: 51,
  escape: 53,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
  home: 115,
  page_up: 116,
  delete: 117,
  end: 119,
  page_down: 121,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
};

/** Where a desktop app offering its Mac connects, and the one event requests travel on. */
export const MAC_NAMESPACE = '/mac';
export const MAC_EVENT = 'do';

/**
 * How long the server waits for the person to answer the Mac's own question before a bot first
 * uses it; the Mac stops asking a little earlier, so a late yes never opens a use nobody waits on.
 */
export const MAC_BEGIN_MS = 60_000;
export const MAC_ASK_MS = 55_000;

/** A point on the screen, in points; the largest screens are well under this. */
const coord = z.number().int().min(0).max(20_000);
const shift = z.number().int().min(-30).max(30);

/**
 * Everything a server may ask of a Mac across the network. The desktop app checks each request
 * against this before the helper sees it: nothing else reaches the Mac, no commands and no files.
 * The limits are those of the bots' tools.
 */
export const MacRequest = z.discriminatedUnion('op', [
  z.object({ op: z.literal('status') }),
  z.object({ op: z.literal('request') }),
  z.object({ op: z.literal('begin'), bot: z.string().max(200) }),
  z.object({
    op: z.literal('screenshot'),
    width: z.number().int().min(1).max(2000),
    height: z.number().int().min(1).max(2000),
  }),
  z.object({
    op: z.literal('click'),
    x: coord,
    y: coord,
    button: z.enum(['left', 'right', 'middle']),
    count: z.number().int().min(1).max(3),
  }),
  z.object({ op: z.literal('type'), text: z.string().min(1).max(5000) }),
  z.object({
    op: z.literal('key'),
    code: z.number().int().min(0).max(127),
    modifiers: z.array(z.enum(['command', 'control', 'option', 'shift', 'fn'])).max(5),
  }),
  z.object({ op: z.literal('scroll'), x: coord, y: coord, dx: shift, dy: shift }),
  z.object({ op: z.literal('drag'), fromX: coord, fromY: coord, toX: coord, toY: coord }),
]);
export type MacRequest = z.infer<typeof MacRequest>;

/** Requests that see or touch the screen: each needs a use the person allowed on the Mac itself. */
export const MAC_TOUCHES: ReadonlySet<MacRequest['op']> = new Set([
  'screenshot',
  'click',
  'type',
  'key',
  'scroll',
  'drag',
]);
