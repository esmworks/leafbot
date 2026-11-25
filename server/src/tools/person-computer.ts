import { z } from 'zod';
import { keyPresses, type PersonAction, type PersonComputer, PersonComputerError } from '../computer/person';
import { STUCK_AFTER, type ScreenWatch } from '../computer/screen-watch';
import { screenshotImage } from '../engine/fit-image';
import type { AppTool, ToolResult } from '../engine/types';
import type { T } from '../i18n';
import type { Define } from './index';

/** Lets the screen redraw after an action before the bot looks at it again. */
const SETTLE_MS = 500;

export function personComputerErrorText(err: unknown, t: T): string {
  if (err instanceof PersonComputerError) {
    if (err.code === 'accessibility') return t('personComputer.accessibility');
    if (err.code === 'screen') return t('personComputer.screenOff');
    if (err.code === 'busy') return t('personComputer.busy');
    if (err.code === 'offline') return t('personComputer.offline');
    if (err.code === 'refused') return t('personComputer.refused');
    if (err.code === 'blocked') return t('personComputer.blocked');
  }
  return t('personComputer.failed', { message: (err as Error).message });
}

/**
 * The person's own Mac: look at the screen, use the mouse and type. Every one of these goes
 * through the turn's permission check, which asks once in a turn at every level (the name prefix
 * `person_computer_` marks them), so the person says yes before a bot first sees or touches their
 * screen in a piece of work.
 */
export function personComputerTools(opts: {
  def: Define;
  botId: string;
  /** Shown on a Mac offered from afar when it asks whether this bot may use it. */
  botName: string;
  t: T;
  computer: PersonComputer;
  /** The turn's screens, to stop a bot going round in circles (see `ScreenWatch`). */
  watch?: ScreenWatch;
}): AppTool[] {
  const { def, botId, botName, t, computer, watch } = opts;
  const stuck = () => t('screen.stuck', { count: STUCK_AFTER });

  const guard = async (fn: () => Promise<ToolResult>): Promise<ToolResult> => {
    // Stopped going round in circles: no more steps on the screen this turn.
    if (watch?.stuck) return stuck();
    try {
      return await computer.use(botId, fn, Date.now(), botName);
    } catch (err) {
      return personComputerErrorText(err, t);
    }
  };

  const look = async (): Promise<ToolResult> => {
    const shot = await computer.screenshot();
    if (await watch?.seen(shot.data)) return stuck();
    const system = shot.os === 'windows' ? 'Windows' : 'macOS';
    const screen = t('personComputer.screen', { system, width: shot.width, height: shot.height });
    return {
      // A bot that knows Mac shortcuts best is told which keys this system wants.
      text: shot.os === 'windows' ? `${screen} ${t('personComputer.windowsKeys')}` : screen,
      images: [await screenshotImage(shot.data, shot.mimeType)],
    };
  };

  const act = (action: PersonAction) =>
    guard(async () => {
      await computer.act(action);
      await new Promise((r) => setTimeout(r, SETTLE_MS));
      return look();
    });

  // Coordinates are in the last picture; its size depends on the screen, so the limit is checked
  // by the computer, which keeps a point inside the screen.
  const coord = z.number().int().min(0).max(4000);

  return [
    def('person_computer_screenshot', {}, async () => guard(look)),
    def(
      'person_computer_click',
      {
        x: coord,
        y: coord,
        button: z.enum(['left', 'right', 'middle']).default('left'),
        count: z.number().int().min(1).max(3).default(1),
      },
      async (a) => act({ type: 'click', x: a.x, y: a.y, button: a.button, count: a.count }),
    ),
    def('person_computer_type', { text: z.string().min(1).max(5000) }, async (a) =>
      act({ type: 'type', text: a.text }),
    ),
    def(
      'person_computer_key',
      {
        keys: z
          .string()
          .min(1)
          .max(100)
          .describe('Key names joined by +, several separated by spaces: Return, cmd+s, cmd+shift+4, Tab'),
      },
      async (a) => {
        const presses = keyPresses(a.keys);
        if (!presses) return t('personComputer.badKeys', { keys: a.keys });
        return act({ type: 'key', presses });
      },
    ),
    def(
      'person_computer_scroll',
      {
        x: coord,
        y: coord,
        direction: z.enum(['up', 'down', 'left', 'right']),
        amount: z.number().int().min(1).max(30).default(3),
      },
      async (a) => act({ type: 'scroll', x: a.x, y: a.y, direction: a.direction, amount: a.amount }),
    ),
    def('person_computer_drag', { from_x: coord, from_y: coord, to_x: coord, to_y: coord }, async (a) =>
      act({ type: 'drag', from: { x: a.from_x, y: a.from_y }, to: { x: a.to_x, y: a.to_y } }),
    ),
  ];
}
