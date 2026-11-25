import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import type { PersonComputer } from '../src/computer/person';
import { ScreenWatch, STUCK_AFTER } from '../src/computer/screen-watch';
import type { ToolResult } from '../src/engine/types';
import { translator } from '../src/i18n';
import type { Define } from '../src/tools/index';
import { personComputerTools } from '../src/tools/person-computer';

/** A grey 1280x800 screen with white boxes on it, as PNG. */
const screen = (boxes: { left: number; top: number; width: number; height: number }[] = []) =>
  sharp({ create: { width: 1280, height: 800, channels: 3, background: { r: 90, g: 90, b: 90 } } })
    .composite(
      boxes.map((b) => ({
        input: { create: { width: b.width, height: b.height, channels: 3 as const, background: '#ffffff' } },
        left: b.left,
        top: b.top,
      })),
    )
    .png()
    .toBuffer();

describe('ekranda dönüp duran bot', () => {
  it('yeni bir şey göstermeyen ekranları art arda sayar, yenisi sayacı sıfırlar', async () => {
    const watch = new ScreenWatch(3);
    const plain = await screen();
    expect(await watch.seen(plain)).toBe(false);
    expect(await watch.seen(plain)).toBe(false);
    expect(watch.repeats).toBe(1);
    // A blinking caret or a clock's minute is not new.
    expect(await watch.seen(await screen([{ left: 600, top: 400, width: 6, height: 14 }]))).toBe(false);
    expect(watch.repeats).toBe(2);
    // A dialog that opened is.
    expect(await watch.seen(await screen([{ left: 400, top: 300, width: 400, height: 200 }]))).toBe(false);
    expect(watch.repeats).toBe(0);
  });

  it('birkaç ekran arasında gidip gelmek de ilerleme sayılmaz', async () => {
    const watch = new ScreenWatch(4);
    const a = await screen();
    const b = (await screen([{ left: 0, top: 0, width: 640, height: 400 }])).toString('base64');
    expect(await watch.seen(a)).toBe(false);
    expect(await watch.seen(b)).toBe(false);
    for (const s of [a, b, a]) expect(await watch.seen(s)).toBe(false);
    expect(await watch.seen(b)).toBe(true);
    // Stays stopped for the rest of the turn, even if the screen then changes.
    expect(await watch.seen(await screen([{ left: 900, top: 600, width: 300, height: 150 }]))).toBe(true);
  });

  it('yavaşça ilerleyen bir çubuk sonunda yeni sayılır', async () => {
    const watch = new ScreenWatch(STUCK_AFTER);
    for (let w = 8; w <= 400; w += 8) {
      expect(await watch.seen(await screen([{ left: 100, top: 700, width: w, height: 16 }]))).toBe(false);
    }
  });

  it('kişinin bilgisayarında durdurulan bot ekranı görmez, nedenini söylemesi istenir', async () => {
    const t = translator('tr');
    const data = (await screen()).toString('base64');
    let shots = 0;
    const mac = {
      use: <R>(_botId: string, fn: () => Promise<R>) => fn(),
      screenshot: async () => {
        shots++;
        return { data, mimeType: 'image/png' as const, width: 1280, height: 800, os: 'mac' as const };
      },
      act: async () => {},
    } as unknown as PersonComputer;
    // Only the name and the handler matter here.
    const def = ((name: string, _input: unknown, handler: (a: unknown) => Promise<ToolResult>) => ({
      name,
      handler,
    })) as unknown as Define;
    const watch = new ScreenWatch(2);
    const tools = personComputerTools({ def, botId: 'b', botName: 'Ali', t, computer: mac, watch });
    const look = tools.find((x) => x.name === 'person_computer_screenshot')!;
    const click = tools.find((x) => x.name === 'person_computer_click')!;

    expect(await look.handler({})).toMatchObject({ images: [expect.anything()] });
    expect(await look.handler({})).toMatchObject({ images: [expect.anything()] });
    const stopped = await look.handler({});
    expect(stopped).toBe(t('screen.stuck', { count: STUCK_AFTER }));
    expect(stopped).toContain('engelled');

    // Nothing more is done or looked at on the screen this turn.
    const before = shots;
    expect(await click.handler({ x: 10, y: 10 })).toBe(stopped);
    expect(shots).toBe(before);
  });
});
