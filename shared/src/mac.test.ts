import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { jpegShot, MacRequest } from './mac';

/** A 1x1 PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

describe('the Mac’s picture for a server elsewhere', () => {
  /** Stands in for macOS's tools: a JPEG of `bytes[quality]` bytes for each quality tried. */
  const fake = (bytes: Record<number, number>, tried: number[]) => ({
    capture: (file: string) => writeFile(file, PNG),
    toJpeg: async (_file: string, _size: unknown, out: string, quality: number) => {
      tried.push(quality);
      await writeFile(out, Buffer.alloc(bytes[quality] ?? 0, 1));
    },
  });

  it('sends JPEG, and takes a busy screen again at lower quality to stay under the limit', async () => {
    const tried: number[] = [];
    const small = await jpegShot(fake({ 70: 30, 45: 10 }, tried), 100)({ width: 8, height: 5 });
    expect(small.mimeType).toBe('image/jpeg');
    expect(tried).toEqual([70]);

    tried.length = 0;
    const busy = await jpegShot(fake({ 70: 300, 45: 60 }, tried), 100)({ width: 8, height: 5 });
    expect(Buffer.from(busy.data, 'base64')).toHaveLength(60);
    expect(tried).toEqual([70, 45]);
  });

  it('does not send a picture too large even so: the socket would close on it', async () => {
    await expect(jpegShot(fake({ 70: 300, 45: 300 }, []), 100)({ width: 8, height: 5 })).rejects.toThrow();
  });

  it.runIf(process.platform === 'darwin')('makes a JPEG of the asked size with macOS’s tool', async () => {
    // Only the capture is stood in for, so nothing on the screen is taken; the conversion is real.
    const shot = await jpegShot({ capture: (file) => writeFile(file, PNG) })({ width: 8, height: 5 });
    const jpeg = Buffer.from(shot.data, 'base64');
    expect(shot.mimeType).toBe('image/jpeg');
    expect(jpeg.subarray(0, 2).toString('hex')).toBe('ffd8');
  });
});

describe('what a server may ask of a Mac', () => {
  it('takes the known requests within their limits, and nothing else', () => {
    expect(MacRequest.safeParse({ op: 'click', x: 1, y: 2, button: 'left', count: 1 }).success).toBe(true);
    expect(MacRequest.safeParse({ op: 'click', x: -1, y: 2, button: 'left', count: 1 }).success).toBe(false);
    expect(MacRequest.safeParse({ op: 'key', code: 1, modifiers: ['command'] }).success).toBe(true);
    expect(MacRequest.safeParse({ op: 'key', code: 1, modifiers: ['hyper'] }).success).toBe(false);
    expect(MacRequest.safeParse({ op: 'shell', command: 'ls' }).success).toBe(false);
    expect(MacRequest.safeParse({ op: 'type', text: '' }).success).toBe(false);
  });
});
