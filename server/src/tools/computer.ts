import { stuckResult, type ScreenWatch } from '../computer/screen-watch';
import { DESKTOP_SIZE, type Bot, type DesktopAction } from '@leafbot/shared';
import { z } from 'zod';
import { ComputerError, type ComputerClient } from '../computer/client';
import type { ComputerService } from '../computer/service';
import { screenshotImage } from '../engine/fit-image';
import type { AppTool, ToolResult } from '../engine/types';
import type { T } from '../i18n';
import type { Define } from './index';

const x = z
  .number()
  .int()
  .min(0)
  .max(DESKTOP_SIZE.width - 1);
const y = z
  .number()
  .int()
  .min(0)
  .max(DESKTOP_SIZE.height - 1);
const sends = z
  .boolean()
  .default(false)
  .describe('true if this sends, posts, buys, books, deletes or shares something');

/** Lets the screen redraw after an action before the bot looks at it again. */
const SETTLE_MS = 600;
/** The longest a background command keeps the desktop awake. */
const BACKGROUND_MAX_MS = 2 * 60 * 60_000;

export function computerErrorText(err: unknown, t: T): string {
  if (err instanceof ComputerError) {
    if (err.code === 'userControl') return t('computer.userControl');
    if (err.code === 'full') return t('computer.full');
    if (err.code === 'unreachable') return t('computer.unreachable');
    if (err.code === 'noAnswer') return t('computer.noAnswer', { seconds: err.seconds });
    return t('computer.failed', { message: err.message });
  }
  return t('computer.failed', { message: (err as Error).message });
}

/** Keys that submit what was typed: in a terminal, they run it. */
const SUBMIT = /^(?:return|enter|kp_enter|iso_enter|linefeed|3270_enter)$/i;

/**
 * Whether pressing `keys` (xdotool names: `Return`, `ctrl+s`, `alt+Tab Return`) could submit,
 * run or send something: Enter in any form, or a combination with a modifier (a shortcut can
 * run, paste into a terminal, send or delete). Plain typing keys, arrows and Tab cannot.
 */
export function submits(keys: string): boolean {
  return keys
    .trim()
    .split(/\s+/)
    .some((combo) => {
      const parts = combo.split('+').filter(Boolean);
      if (parts.length > 1) return true;
      return SUBMIT.test(parts[0] ?? '');
    });
}

/**
 * The bot's own desktop: look at the screen, use the mouse and keyboard, and run commands in its
 * terminal. Looking and moving around run without a card; a step marked as sending something, and
 * every command, follow the bot's permission settings. A read-only bot can only look.
 */
export function computerTools(opts: {
  def: Define;
  bot: Bot;
  t: T;
  computer: ComputerService;
  /** Where commands run: the thread's work folder. */
  cwd: string;
  /**
   * The person whose own message started this work in their own conversation, whose own GitHub
   * key or app the commands' git uses; null otherwise, and git uses the team's. Asked at each
   * command, since what the turn has read by then can change the answer.
   */
  own?: () => Promise<string | null>;
  /** The turn's own: a step waiting for the person to hand the desktop back stops with it. */
  signal?: AbortSignal;
  /** The turn's screens, to stop a bot going round in circles (see `ScreenWatch`). */
  watch?: ScreenWatch;
}): AppTool[] {
  const { def, bot, t, computer, cwd, signal, watch } = opts;
  const stuck = () => stuckResult(t);
  const readOnly = bot.permissionMode === 'readonly';

  /**
   * Runs a step on the desktop. One that waited for the person to hand it back says so: they may
   * have closed or moved things. A step that `touches` the screen is then not carried out, since
   * its place on the screen was chosen on the one before; the bot gets the screen as it is now.
   */
  const guard = async (
    fn: (c: ComputerClient) => Promise<ToolResult>,
    touches = false,
  ): Promise<ToolResult> => {
    try {
      return await computer.use(
        bot.id,
        async (c, waited) => {
          if (!waited) return fn(c);
          const notes = [t('computer.handedBack'), ...(touches ? [t('computer.stepNotDone')] : [])].join(' ');
          const r = touches ? await look(c) : await fn(c);
          return typeof r === 'string' ? `${notes}\n\n${r}` : { ...r, text: `${notes}\n\n${r.text}` };
        },
        signal,
      );
    } catch (err) {
      return computerErrorText(err, t);
    }
  };

  const look = async (c: ComputerClient): Promise<ToolResult> => {
    const shot = await c.screenshot(bot.id);
    if (await watch?.seen(shot.png)) return stuck();
    return {
      text: t('computer.screen', { width: shot.width, height: shot.height }),
      images: [await screenshotImage(shot.png)],
    };
  };

  // Stopped going round in circles: no more steps on the screen this turn. Commands still run, as
  // the way round may be one.
  const onScreen = (step: () => Promise<ToolResult>) => (watch?.stuck ? Promise.resolve(stuck()) : step());

  const act = (action: DesktopAction) =>
    onScreen(() =>
      guard(async (c) => {
        await c.action(bot.id, action);
        await new Promise((r) => setTimeout(r, SETTLE_MS));
        return look(c);
      }, true),
    );

  // Read-only bots may look but not touch: these then go through the normal permission check.
  const touch = async (a: object) => readOnly || ('sends' in a && a.sends === true);
  // Typing a line break, or a key that submits or runs a shortcut, can run a command in the
  // desktop's terminal or send a form, whatever the bot says of it: it follows the bot's level,
  // as run_command does.
  const types = async (a: { text: string; sends?: boolean }) => (await touch(a)) || /[\r\n]/.test(a.text);
  const presses = async (a: { keys: string; sends?: boolean }) => (await touch(a)) || submits(a.keys);

  return [
    def('computer_screenshot', {}, async () => onScreen(() => guard(look)), 'internal'),
    def(
      'computer_click',
      {
        x,
        y,
        button: z.enum(['left', 'right', 'middle']).default('left'),
        count: z.number().int().min(1).max(3).default(1),
        sends,
      },
      async (a) => act({ type: 'click', x: a.x, y: a.y, button: a.button, count: a.count }),
      'internal',
      touch,
    ),
    def(
      'computer_type',
      { text: z.string().min(1).max(5000), sends },
      async (a) => act({ type: 'type', text: a.text }),
      'internal',
      types,
    ),
    def(
      'computer_key',
      {
        keys: z
          .string()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9_+ -]+$/)
          .describe('xdotool key names joined by +, e.g. Return, ctrl+s, alt+Tab'),
        sends,
      },
      async (a) => act({ type: 'key', keys: a.keys }),
      'internal',
      presses,
    ),
    def(
      'computer_scroll',
      {
        x,
        y,
        direction: z.enum(['up', 'down', 'left', 'right']),
        amount: z.number().int().min(1).max(30).default(3),
      },
      async (a) => act({ type: 'scroll', x: a.x, y: a.y, direction: a.direction, amount: a.amount }),
      'internal',
      touch,
    ),
    def(
      'computer_drag',
      { from_x: x, from_y: y, to_x: x, to_y: y },
      async (a) => act({ type: 'drag', from: { x: a.from_x, y: a.from_y }, to: { x: a.to_x, y: a.to_y } }),
      'internal',
      touch,
    ),
    def(
      'run_command',
      {
        command: z.string().min(1).max(100_000),
        timeout_seconds: z.number().int().min(1).max(600).default(120),
        background: z
          .boolean()
          .default(false)
          .describe('Leave it running (a build, an install) and check it with command_status'),
      },
      async (a) =>
        guard(async (c) => {
          // Only for this command: the desktop goes on with the team's key for everyone else. Its
          // commits are written by the account of the key it uses.
          const own = (await opts.own?.()) ?? null;
          const by = await computer.commandGit(bot.id, own);
          if (a.background) {
            const job = await c.startJob(bot.id, { command: a.command, cwd, ...by });
            computer.keepAwake(bot.id, BACKGROUND_MAX_MS);
            return t('computer.jobStarted', { id: job.id });
          }
          const r = await c.exec(bot.id, {
            command: a.command,
            cwd,
            timeoutMs: a.timeout_seconds * 1000,
            ...by,
          });
          const notes = [
            r.timedOut ? t('computer.timedOut', { seconds: a.timeout_seconds }) : null,
            r.truncated ? t('computer.truncated') : null,
          ].filter(Boolean);
          return [
            t('computer.exitCode', { code: r.exitCode ?? '-' }),
            ...notes,
            r.output || t('computer.noOutput'),
          ].join('\n');
        }),
    ),
    def(
      'command_status',
      {
        id: z.string().regex(/^[\w-]{1,40}$/),
        wait_seconds: z.number().int().min(0).max(60).default(0),
      },
      async (a) =>
        guard(async (c) => {
          const job = await c.job(bot.id, { id: a.id, waitMs: a.wait_seconds * 1000 });
          if (!job.running) computer.keepAwake(bot.id, 0);
          return [
            job.running
              ? t('computer.jobRunning', { seconds: job.seconds })
              : t('computer.exitCode', { code: job.exitCode ?? '-' }),
            ...(job.truncated ? [t('computer.truncated')] : []),
            job.output || t('computer.noOutput'),
          ].join('\n');
        }),
      'internal',
    ),
  ];
}
