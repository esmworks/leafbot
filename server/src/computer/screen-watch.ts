import { library } from '../engine/fit-image';

/** The size a screen is shrunk to before two are compared: a word typed still shows, a clock's minute does not. */
const WIDTH = 160;
const HEIGHT = 90;
/** How far a cell's grey must move to count as changed. */
const CELL_CHANGE = 32;
/** How many cells must change for a screen to count as new. */
const CELLS_NEW = 5;
/** The screens remembered: going back and forth between a few of them is no progress either. */
const REMEMBERED = 8;
/** Screens in a row with nothing new before the bot is stopped. */
export const STUCK_AFTER = 40;

/**
 * Watches the screens one turn's bot looks at. A bot going round in circles (clicking a button that
 * does nothing, scrolling back and forth, waiting on a page that never loads) takes screen after
 * screen that shows nothing it has not seen; past `STUCK_AFTER` of them in a row it is stopped
 * using the screen and asked to say what blocks it. Counted per screen, not by time: a card waiting
 * on the person takes no screens.
 */
export class ScreenWatch {
  private seenScreens: Uint8Array[] = [];
  private same = 0;
  /** Set once the bot is stopped; stays for the rest of the turn. */
  stuck = false;

  constructor(private limit = STUCK_AFTER) {}

  /** Takes one screen the bot was shown; true when it is now stopped. */
  async seen(image: string | Buffer): Promise<boolean> {
    if (this.stuck) return true;
    const print = await fingerprint(image);
    // Without the image library nothing is compared, and nothing is stopped.
    if (!print) return false;
    if (this.seenScreens.some((s) => near(s, print))) {
      this.same++;
    } else {
      this.same = 0;
      this.seenScreens.push(print);
      if (this.seenScreens.length > REMEMBERED) this.seenScreens.shift();
    }
    if (this.same >= this.limit) this.stuck = true;
    return this.stuck;
  }

  /** Screens in a row that showed nothing new. */
  get repeats(): number {
    return this.same;
  }
}

async function fingerprint(image: string | Buffer): Promise<Uint8Array | null> {
  const sharp = await library();
  if (!sharp) return null;
  try {
    const raw = await sharp(typeof image === 'string' ? Buffer.from(image, 'base64') : image)
      .resize(WIDTH, HEIGHT, { fit: 'fill' })
      .greyscale()
      .raw()
      .toBuffer();
    return new Uint8Array(raw);
  } catch {
    return null;
  }
}

function near(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let changed = 0;
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i]! - b[i]!) > CELL_CHANGE && ++changed >= CELLS_NEW) return false;
  }
  return true;
}
