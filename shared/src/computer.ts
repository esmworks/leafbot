import { z } from 'zod';

/**
 * A bot's computer: a Linux desktop (panel, browser, terminal, file manager, office) that the
 * computer service runs next to the server. Each bot gets its own session there: its own screen,
 * processes and home, and only its own folders. This file is the contract between the server and
 * that service, and the shapes the app sees.
 */

/** A bot id as the computer service accepts it (it names folders and sockets). */
export const DesktopId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);

/** The size of every desktop, in pixels. */
export const DESKTOP_SIZE = { width: 1280, height: 800 } as const;

/** A folder the session sees, at the same absolute path as on the server. */
export const DesktopFolder = z.object({
  path: z.string().startsWith('/').max(500),
  writable: z.boolean(),
});
export type DesktopFolder = z.infer<typeof DesktopFolder>;

export const DesktopStart = z.object({
  /** Without internet the session has its own empty network (loopback only). */
  internet: z.boolean(),
  /** Desktop and app language. */
  locale: z.enum(['tr', 'en']),
  /** The session's home: settings, browser profile. Kept between starts. */
  home: z.string().startsWith('/').max(500),
  /** Where the terminal and the file manager open. */
  workdir: z.string().startsWith('/').max(500),
  /** Every folder the session may see besides home (home is always writable). */
  folders: z.array(DesktopFolder).max(20),
});
export type DesktopStart = z.infer<typeof DesktopStart>;

export const DesktopStatus = z.object({
  id: DesktopId,
  status: z.enum(['off', 'starting', 'running']),
  startedAt: z.string().nullable(),
  /** Why the last start of this desktop failed, while it is off; the bot and the person are told. */
  lastError: z.string().nullable().optional(),
  /**
   * Whether the session's browser leaves through the service's own SOCKS, which refuses private
   * addresses itself. The server then skips its own per-request guard — that guard would only cost
   * the browser its HTTP cache and its service workers — and keeps the guard when it does not.
   */
  browserProxied: z.boolean(),
});
export type DesktopStatus = z.infer<typeof DesktopStatus>;

/**
 * The GitHub key git on the desktop is to use, or none. The computer service keeps it outside the
 * session and adds it to git's requests to GitHub itself, so nothing in the session shows it.
 */
export const DesktopGit = z.object({
  token: z
    .string()
    .min(1)
    .max(1000)
    .regex(/^[\x21-\x7e]+$/)
    .nullable(),
});
export type DesktopGit = z.infer<typeof DesktopGit>;

/** Text git writes into a commit's author line as it is: no control characters, no `<` or `>`. */
const authorText = /^[^\p{Cc}<>]+$/u;

/**
 * Who a command's commits are written by: the GitHub account whose key its git uses. Left to
 * itself git on the desktop has no name, and a bot that fills one in makes one up, whose address
 * GitHub then credits to whatever account happens to own it.
 */
export const GitAuthor = z.object({
  name: z.string().min(1).max(100).regex(authorText),
  email: z
    .string()
    .min(3)
    .max(200)
    .regex(authorText)
    .regex(/^\S+@\S+$/),
});
export type GitAuthor = z.infer<typeof GitAuthor>;

export const DesktopExec = z.object({
  command: z.string().min(1).max(100_000),
  cwd: z.string().startsWith('/').max(500),
  timeoutMs: z.number().int().min(1000).max(600_000).default(120_000),
  /**
   * The GitHub key this command's git uses, for the person the step works for; left out, the
   * desktop's own. Held by the computer service for as long as the command runs, never in the
   * session.
   */
  git: DesktopGit.optional(),
  /** Who the command's commits are written by: the account of the key its git uses. */
  author: GitAuthor.optional(),
});
export type DesktopExec = z.input<typeof DesktopExec>;

export const DesktopExecResult = z.object({
  exitCode: z.number().int().nullable(),
  /** stdout and stderr interleaved as they came, cut to the last 100 000 characters. */
  output: z.string(),
  truncated: z.boolean(),
  timedOut: z.boolean(),
});
export type DesktopExecResult = z.infer<typeof DesktopExecResult>;

/** A command started in the background on the desktop; it runs past the call that started it. */
export const DesktopJobStart = z.object({
  command: z.string().min(1).max(100_000),
  cwd: z.string().startsWith('/').max(500),
  /** As for `DesktopExec`: held until the background command ends. */
  git: DesktopGit.optional(),
  /** As for `DesktopExec`. */
  author: GitAuthor.optional(),
});
export type DesktopJobStart = z.infer<typeof DesktopJobStart>;

/** Asks how a background command is doing, waiting up to `waitMs` for it to end. */
export const DesktopJobQuery = z.object({
  id: z.string().regex(/^[\w-]{1,40}$/),
  waitMs: z.number().int().min(0).max(60_000).default(0),
});
export type DesktopJobQuery = z.input<typeof DesktopJobQuery>;

export const DesktopJob = z.object({
  id: z.string(),
  running: z.boolean(),
  exitCode: z.number().int().nullable(),
  /** The output so far, cut to its last 100 000 characters. */
  output: z.string(),
  truncated: z.boolean(),
  seconds: z.number(),
});
export type DesktopJob = z.infer<typeof DesktopJob>;

const coord = z.number().int().min(0).max(10_000);
const point = z.object({ x: coord, y: coord });
const mouseButton = z.enum(['left', 'right', 'middle']);

/** Mouse and keyboard on the desktop, in screen pixels. */
export const DesktopAction = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('click'),
    x: coord,
    y: coord,
    button: mouseButton.default('left'),
    count: z.number().int().min(1).max(3).default(1),
  }),
  z.object({ type: z.literal('move'), x: coord, y: coord }),
  z.object({ type: z.literal('drag'), from: point, to: point }),
  z.object({ type: z.literal('type'), text: z.string().min(1).max(5000) }),
  /** xdotool key names joined by "+": "ctrl+s", "Return", "alt+F4". */
  z.object({
    type: z.literal('key'),
    keys: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9_+ -]+$/),
  }),
  z.object({
    type: z.literal('scroll'),
    x: coord,
    y: coord,
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().min(1).max(30).default(3),
  }),
]);
export type DesktopAction = z.input<typeof DesktopAction>;

export const DesktopScreenshot = z.object({
  /** PNG, base64. */
  png: z.string(),
  width: z.number().int(),
  height: z.number().int(),
});
export type DesktopScreenshot = z.infer<typeof DesktopScreenshot>;

/**
 * The computer service's HTTP API. Every request carries `Authorization: Bearer <token>`; the two
 * WebSocket paths take the token as `?token=` because WebSocket clients cannot always set headers.
 *
 *   GET  /health                       → { ok: true }
 *   GET  /desktops                     → DesktopStatus[]
 *   GET  /desktops/:id                 → DesktopStatus
 *   POST /desktops/:id/start           DesktopStart → DesktopStatus   (no-op when running)
 *   POST /desktops/:id/stop            → DesktopStatus
 *   POST /desktops/:id/exec            DesktopExec → DesktopExecResult
 *   POST /desktops/:id/jobs-start      DesktopJobStart → DesktopJob (runs in the background)
 *   POST /desktops/:id/jobs-status     DesktopJobQuery → DesktopJob
 *   POST /desktops/:id/screenshot      → DesktopScreenshot
 *   POST /desktops/:id/action          DesktopAction → { ok: true }
 *   WS   /desktops/:id/vnc?token=      raw RFB bytes both ways (binary frames)
 *   WS   /desktops/:id/cdp?token=      Chrome DevTools Protocol, one JSON message per text frame;
 *                                      starts the session's Chromium if it is not running
 *
 * Errors: `{ error: string, code: ComputerErrorCode }` with 4xx/5xx.
 */
export const COMPUTER_API_VERSION = 1;

export type ComputerErrorCode = 'badRequest' | 'unauthorized' | 'notRunning' | 'full' | 'failed';

/** What the app sees about a bot's computer. `off` is shown as asleep once it has been used. */
export interface ComputerState {
  botId: string;
  status: 'off' | 'starting' | 'running';
  /** A person has the mouse and keyboard; the bot's actions wait until they give it back. */
  user: boolean;
  /** The bot is doing something on it right now. */
  busy: boolean;
  /** A step of the bot's waits for the person in control to give it back, to go on from there. */
  waiting?: boolean;
}

export type ComputerAck = { ok: true } | { ok: false; error: string };
