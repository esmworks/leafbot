import { type ChildProcessWithoutNullStreams, execFile, spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Why the person's computer could not be used. */
export type PersonComputerCode = 'accessibility' | 'screen' | 'busy' | 'failed';

export class PersonComputerError extends Error {
  constructor(
    readonly code: PersonComputerCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'PersonComputerError';
  }
}

/** What macOS lets the app do, and the main screen's size in points. */
export interface PersonComputerStatus {
  /** Allowed under Privacy & Security → Accessibility: may move the mouse and type. */
  accessibility: boolean;
  /** Allowed under Privacy & Security → Screen Recording: may see other apps' windows. */
  screen: boolean;
  width: number;
  height: number;
}

/**
 * The largest picture of the screen a bot gets. Models place clicks best on pictures about this
 * size, and the bot's coordinates are in it: they are scaled back to the screen's points.
 */
const SHOT_MAX = { width: 1280, height: 800 };

/** The size the screen's picture is scaled to, keeping its shape. */
export function shotSize(screen: { width: number; height: number }): { width: number; height: number } {
  const scale = Math.min(1, SHOT_MAX.width / screen.width, SHOT_MAX.height / screen.height);
  return { width: Math.round(screen.width * scale), height: Math.round(screen.height * scale) };
}

/** A point in the bot's picture, as a point on the screen. */
export function toScreen(
  p: { x: number; y: number },
  screen: { width: number; height: number },
): { x: number; y: number } {
  const shot = shotSize(screen);
  const clamp = (v: number, max: number) => Math.max(0, Math.min(max - 1, v));
  return {
    x: clamp(Math.round((p.x * screen.width) / shot.width), screen.width),
    y: clamp(Math.round((p.y * screen.height) / shot.height), screen.height),
  };
}

/** macOS virtual key codes by name (their place on the keyboard, whatever its layout). */
const KEY_CODES: Record<string, number> = {
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

/** Other names bots use for the same keys (xdotool's among them). */
const KEY_ALIASES: Record<string, string> = {
  enter: 'return',
  kp_enter: 'return',
  esc: 'escape',
  backspace: 'backspace',
  back_space: 'backspace',
  forward_delete: 'delete',
  del: 'delete',
  prior: 'page_up',
  pageup: 'page_up',
  next: 'page_down',
  pagedown: 'page_down',
  '-': 'minus',
  '=': 'equal',
  ',': 'comma',
  '.': 'period',
  '/': 'slash',
  ';': 'semicolon',
  "'": 'apostrophe',
  '[': 'bracketleft',
  ']': 'bracketright',
  '\\': 'backslash',
  '`': 'grave',
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
};

const MODIFIERS: Record<string, string> = {
  cmd: 'command',
  command: 'command',
  super: 'command',
  meta: 'command',
  win: 'command',
  ctrl: 'control',
  control: 'control',
  alt: 'option',
  option: 'option',
  opt: 'option',
  shift: 'shift',
  fn: 'fn',
};

export interface KeyPress {
  code: number;
  modifiers: string[];
}

/**
 * Key presses from names such as `cmd+s`, `Return` or `ctrl+alt+Delete Tab` (one press per
 * space-separated combination). Null when a name is not a key this knows.
 */
export function keyPresses(keys: string): KeyPress[] | null {
  const presses: KeyPress[] = [];
  for (const combo of keys.trim().split(/\s+/).filter(Boolean)) {
    const parts = combo
      .split('+')
      .filter(Boolean)
      .map((p) => p.toLowerCase());
    const modifiers: string[] = [];
    let code: number | undefined;
    for (const [i, part] of parts.entries()) {
      const modifier = MODIFIERS[part];
      if (modifier && i < parts.length - 1) {
        if (!modifiers.includes(modifier)) modifiers.push(modifier);
        continue;
      }
      if (i < parts.length - 1) return null;
      code = KEY_CODES[KEY_ALIASES[part] ?? part];
    }
    if (code === undefined) return null;
    presses.push({ code, modifiers });
  }
  return presses.length ? presses : null;
}

/** Whether pressing `keys` could submit, run or send something: Return, or any shortcut. */
export function keysSubmit(presses: KeyPress[]): boolean {
  return presses.some((p) => p.modifiers.some((m) => m !== 'shift') || p.code === KEY_CODES.return);
}

/** What a bot does on the screen, in the coordinates of its last picture. */
export type PersonAction =
  | { type: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; count: number }
  | { type: 'type'; text: string }
  | { type: 'key'; presses: KeyPress[] }
  | { type: 'scroll'; x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
  | { type: 'drag'; from: { x: number; y: number }; to: { x: number; y: number } };

/** Talks to the helper: one request at a time, one JSON line each way. */
export interface PersonComputerDriver {
  send(req: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

/** Starts the helper program and keeps it running until closed. */
export function helperDriver(path: string): PersonComputerDriver {
  let child: ChildProcessWithoutNullStreams | null = null;
  let next = 1;
  const waiting = new Map<number, (r: Record<string, unknown>) => void>();
  let chain: Promise<unknown> = Promise.resolve();

  const start = () => {
    const c = spawn(path, [], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    return c;
  };

  return {
    send(req) {
      const sent = chain.then(
        () =>
          new Promise<Record<string, unknown>>((resolve) => {
            child ??= start();
            const id = next++;
            waiting.set(id, resolve);
            child.stdin.write(`${JSON.stringify({ ...req, id })}\n`);
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

/** How long a bot keeps the person's computer to itself after its last step. */
const HOLD_MS = 2 * 60_000;

/**
 * The person's own Mac, for the bots they allowed to use it. Only one bot at a time: it has one
 * mouse and one keyboard, so another bot waits until the first has not touched it for a while.
 * Coordinates are in the bot's picture of the screen (see `shotSize`).
 */
export class PersonComputer {
  private holder: { botId: string; until: number } | null = null;

  constructor(
    private driver: PersonComputerDriver,
    private io: {
      capture: (file: string) => Promise<void>;
      scale: (file: string, size: { width: number; height: number }) => Promise<void>;
    } = { capture: captureScreen, scale: scalePng },
  ) {}

  static start(helper: string): PersonComputer {
    return new PersonComputer(helperDriver(helper));
  }

  private async call(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.driver.send(req);
    if (r.ok === true) return r;
    const code: PersonComputerCode = r.error === 'accessibility' ? 'accessibility' : 'failed';
    throw new PersonComputerError(code, String(r.error ?? 'failed'));
  }

  async status(): Promise<PersonComputerStatus> {
    return toStatus(await this.call({ op: 'status' }));
  }

  /** Opens macOS's prompts for the two permissions it needs. */
  async request(): Promise<PersonComputerStatus> {
    return toStatus(await this.call({ op: 'request' }));
  }

  /** Runs `fn` for `botId`, refused while another bot used the computer moments ago. */
  async use<R>(botId: string, fn: () => Promise<R>, now = Date.now()): Promise<R> {
    if (this.holder && this.holder.botId !== botId && this.holder.until > now) {
      throw new PersonComputerError('busy');
    }
    this.holder = { botId, until: now + HOLD_MS };
    try {
      return await fn();
    } finally {
      this.holder = { botId, until: Date.now() + HOLD_MS };
    }
  }

  /** A picture of the main screen, scaled to `shotSize`. */
  async screenshot(): Promise<{ png: string; width: number; height: number }> {
    const s = await this.status();
    if (!s.screen) throw new PersonComputerError('screen');
    const size = shotSize(s);
    const dir = await mkdtemp(join(tmpdir(), 'leafbot-screen-'));
    const file = join(dir, 'screen.png');
    try {
      await this.io.capture(file);
      await this.io.scale(file, size);
      return { png: (await readFile(file)).toString('base64'), ...size };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async act(action: PersonAction): Promise<void> {
    const s = await this.status();
    if (!s.accessibility) throw new PersonComputerError('accessibility');
    const at = (p: { x: number; y: number }) => toScreen(p, s);
    switch (action.type) {
      case 'click': {
        const p = at(action);
        await this.call({ op: 'click', ...p, button: action.button, count: action.count });
        return;
      }
      case 'type':
        await this.call({ op: 'type', text: action.text });
        return;
      case 'key':
        for (const p of action.presses) await this.call({ op: 'key', code: p.code, modifiers: p.modifiers });
        return;
      case 'scroll': {
        const p = at(action);
        const step = action.amount;
        const dy = action.direction === 'up' ? step : action.direction === 'down' ? -step : 0;
        const dx = action.direction === 'left' ? step : action.direction === 'right' ? -step : 0;
        await this.call({ op: 'scroll', ...p, dx, dy });
        return;
      }
      case 'drag': {
        const from = at(action.from);
        const to = at(action.to);
        await this.call({ op: 'drag', fromX: from.x, fromY: from.y, toX: to.x, toY: to.y });
        return;
      }
    }
  }

  close() {
    this.driver.close();
  }
}

function toStatus(r: Record<string, unknown>): PersonComputerStatus {
  return {
    accessibility: r.accessibility === true,
    screen: r.screen === true,
    width: Number(r.width) || 0,
    height: Number(r.height) || 0,
  };
}
