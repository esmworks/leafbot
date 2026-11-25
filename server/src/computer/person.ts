import type { ComputerPermission } from '@leafbot/shared';
import {
  helperDriver,
  localShot,
  MAC_KEY_CODES,
  type MacDriver,
  type MacPicture,
  type MacShot,
} from '@leafbot/shared/mac';
import { startHelper } from '@leafbot/shared/windows';

export { helperDriver };

/**
 * Why the person's computer could not be used. `offline`: a computer offered from afar is not
 * connected now, or went away during a step; `refused`: the person did not allow the use on the
 * computer itself; `blocked`: Windows kept the step from the window in front, which runs as
 * administrator, or from its sign-in or UAC screen.
 */
export type PersonComputerCode =
  'accessibility' | 'screen' | 'busy' | 'offline' | 'refused' | 'blocked' | 'failed';

export class PersonComputerError extends Error {
  constructor(
    readonly code: PersonComputerCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'PersonComputerError';
  }
}

/** The error a failed answer from the helper or a Mac across the network stands for. */
export function failureOf(r: Record<string, unknown>): PersonComputerError {
  const known: PersonComputerCode[] = ['accessibility', 'offline', 'refused', 'blocked'];
  const code = known.find((c) => c === r.error) ?? 'failed';
  return new PersonComputerError(code, String(r.error ?? 'failed'));
}

/** What the system lets the app do, and the main screen's size in points (pixels on Windows). */
export interface PersonComputerStatus {
  /** The macOS helper does not say; only the Windows one does. */
  os: 'macos' | 'windows';
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
      code = MAC_KEY_CODES[KEY_ALIASES[part] ?? part];
    }
    if (code === undefined) return null;
    presses.push({ code, modifiers });
  }
  return presses.length ? presses : null;
}

/** Whether pressing `keys` could submit, run or send something: Return, or any shortcut. */
export function keysSubmit(presses: KeyPress[]): boolean {
  return presses.some((p) => p.modifiers.some((m) => m !== 'shift') || p.code === MAC_KEY_CODES.return);
}

/**
 * Whether a step on the person's Mac could run or send something: a key that submits or a
 * shortcut, or typed text with a line break (which presses Return). Such a step is asked about
 * each time, beyond the yes that let the bot use the Mac in this turn.
 */
export function submitsOnMac(tool: string, input: Record<string, unknown>): boolean {
  if (tool.endsWith('person_computer_key')) {
    const presses = typeof input.keys === 'string' ? keyPresses(input.keys) : null;
    return !presses || keysSubmit(presses);
  }
  if (tool.endsWith('person_computer_type'))
    return typeof input.text !== 'string' || /[\r\n]/.test(input.text);
  return false;
}

/** What a bot does on the screen, in the coordinates of its last picture. */
export type PersonAction =
  | { type: 'click'; x: number; y: number; button: 'left' | 'right' | 'middle'; count: number }
  | { type: 'type'; text: string }
  | { type: 'key'; presses: KeyPress[] }
  | { type: 'scroll'; x: number; y: number; direction: 'up' | 'down' | 'left' | 'right'; amount: number }
  | { type: 'drag'; from: { x: number; y: number }; to: { x: number; y: number } };

/** Talks to the helper, or to a Mac across the network. */
export type PersonComputerDriver = MacDriver & {
  /**
   * Asks the Mac itself for a use by `bot` before a step sees or touches the screen, for a Mac
   * offered from afar; the Mac answers at once while a use it allowed goes on. Absent for the
   * server's own Mac, where the bot's card is the one question.
   */
  begin?(bot: string): Promise<Record<string, unknown>>;
};

/** How long a bot keeps the person's computer to itself after its last step. */
const HOLD_MS = 2 * 60_000;

/**
 * The person's own Mac, for the bots they allowed to use it. Only one bot at a time: it has one
 * mouse and one keyboard, so another bot waits until the first has not touched it for a while.
 * Coordinates are in the bot's picture of the screen (see `shotSize`).
 */
export class PersonComputer {
  private holder: { botId: string; until: number } | null = null;
  private running = 0;
  private lastUsedAt: number | null = null;

  constructor(
    private driver: PersonComputerDriver,
    private shoot: MacShot = localShot(),
  ) {}

  /** The helper of the computer the server runs on: the macOS program or the Windows script. */
  static start(helper: string): PersonComputer {
    const { driver, shot } = startHelper(helper, 'png');
    return new PersonComputer(driver, shot);
  }

  private async call(req: Record<string, unknown>): Promise<Record<string, unknown>> {
    const r = await this.driver.send(req);
    if (r.ok === true) return r;
    throw failureOf(r);
  }

  async status(): Promise<PersonComputerStatus> {
    return toStatus(await this.call({ op: 'status' }));
  }

  /**
   * Asks macOS for its permissions: with `pane`, that one alone, and System Settings opens where it
   * is turned on; without, both of macOS's own questions.
   */
  async request(pane?: ComputerPermission): Promise<PersonComputerStatus> {
    return toStatus(await this.call(pane ? { op: 'request', pane } : { op: 'request' }));
  }

  /**
   * Runs `fn` for `botId`, refused while another bot used the computer moments ago. A Mac offered
   * from afar is asked first, on its own screen, whether `botName` may use it.
   */
  async use<R>(botId: string, fn: () => Promise<R>, now = Date.now(), botName = ''): Promise<R> {
    if (this.holder && this.holder.botId !== botId && this.holder.until > now) {
      throw new PersonComputerError('busy');
    }
    this.holder = { botId, until: now + HOLD_MS };
    this.running++;
    try {
      if (this.driver.begin) {
        const r = await this.driver.begin(botName);
        if (r.ok !== true) throw failureOf(r);
      }
      return await fn();
    } finally {
      this.running--;
      this.lastUsedAt = Date.now();
      this.holder = { botId, until: Date.now() + HOLD_MS };
    }
  }

  /**
   * Milliseconds since a bot last used the computer (0 while one is at it), or null if none has
   * since the server started. The desktop app reads it to keep the screen on while a bot looks at it.
   */
  idleMs(now = Date.now()): number | null {
    if (this.running > 0) return 0;
    return this.lastUsedAt === null ? null : Math.max(0, now - this.lastUsedAt);
  }

  /** A picture of the main screen, scaled to `shotSize`. */
  async screenshot(): Promise<
    MacPicture & { width: number; height: number; os: PersonComputerStatus['os'] }
  > {
    const s = await this.status();
    if (!s.screen) throw new PersonComputerError('screen');
    const size = shotSize(s);
    return { ...(await this.shoot(size)), ...size, os: s.os };
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
    os: r.os === 'windows' ? 'windows' : 'macos',
    accessibility: r.accessibility === true,
    screen: r.screen === true,
    width: Number(r.width) || 0,
    height: Number(r.height) || 0,
  };
}
