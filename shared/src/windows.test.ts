import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAC_KEY_CODES, type MacDriver } from './mac';
import { helperShot, startHelper, windowsDriver, windowsHelper, windowsKey } from './windows';

/** Stands in for the Windows helper: keeps what it was asked and answers with `reply`. */
const fakeHelper = (
  reply: (req: Record<string, unknown>) => Record<string, unknown> = () => ({ ok: true }),
) => {
  const sent: Record<string, unknown>[] = [];
  const driver: MacDriver = {
    send: async (req) => {
      sent.push(req);
      return reply(req);
    },
    close: () => undefined,
  };
  return { sent, driver };
};

describe('keys on Windows', () => {
  it('turns the keys the bots name into Windows virtual-key codes', () => {
    expect(windowsKey({ code: MAC_KEY_CODES.return!, modifiers: [] })).toEqual({ vk: 0x0d, modifiers: [] });
    expect(windowsKey({ code: MAC_KEY_CODES.s!, modifiers: ['control'] })).toEqual({
      vk: 0x53,
      modifiers: [0x11],
    });
    expect(windowsKey({ code: MAC_KEY_CODES.tab!, modifiers: ['option'] })).toEqual({
      vk: 0x09,
      modifiers: [0x12],
    });
    expect(windowsKey({ code: MAC_KEY_CODES['7']!, modifiers: ['command', 'shift'] })).toEqual({
      vk: 0x37,
      modifiers: [0x5b, 0x10],
    });
    expect(windowsKey({ code: MAC_KEY_CODES.f5!, modifiers: ['fn'] })).toEqual({ vk: 0x74, modifiers: [] });
    expect(windowsKey({ code: MAC_KEY_CODES.delete!, modifiers: [] })).toEqual({ vk: 0x2e, modifiers: [] });
  });

  it('has a Windows key for every key a bot can name', () => {
    for (const [name, code] of Object.entries(MAC_KEY_CODES)) {
      expect(windowsKey({ code, modifiers: [] }), name).not.toBeNull();
    }
  });

  it('refuses a key or modifier it does not know', () => {
    expect(windowsKey({ code: 999, modifiers: [] })).toBeNull();
    expect(windowsKey({ code: MAC_KEY_CODES.a!, modifiers: ['hyper'] })).toBeNull();
  });

  it('passes keys to the helper in Windows codes and everything else as it is', async () => {
    const { sent, driver } = fakeHelper();
    const win = windowsDriver(driver);
    await win.send({ op: 'key', code: MAC_KEY_CODES.c, modifiers: ['control'] });
    await win.send({ op: 'click', x: 1, y: 2, button: 'left', count: 1 });
    expect(sent).toEqual([
      { op: 'key', vk: 0x43, modifiers: [0x11] },
      { op: 'click', x: 1, y: 2, button: 'left', count: 1 },
    ]);
    expect(await win.send({ op: 'key', code: 999, modifiers: [] })).toEqual({
      ok: false,
      error: 'badRequest',
    });
    expect(sent).toHaveLength(2);
  });
});

describe('the Windows picture', () => {
  it('asks the helper for JPEG, and again at lower quality when a busy screen is too large', async () => {
    const { sent, driver } = fakeHelper((req) => ({
      ok: true,
      data: 'x'.repeat(req.quality === 70 ? 300 : 50),
    }));
    const shot = await helperShot(driver, 100)({ width: 8, height: 5 });
    expect(shot).toEqual({ data: 'x'.repeat(50), mimeType: 'image/jpeg' });
    expect(sent).toEqual([
      { op: 'shot', width: 8, height: 5, quality: 70 },
      { op: 'shot', width: 8, height: 5, quality: 45 },
    ]);
  });

  it('fails when the helper cannot take it, or it stays too large', async () => {
    await expect(
      helperShot(fakeHelper(() => ({ ok: false, error: 'failed' })).driver)({ width: 8, height: 5 }),
    ).rejects.toThrow();
    await expect(
      helperShot(
        fakeHelper(() => ({ ok: true, data: 'x'.repeat(300) })).driver,
        100,
      )({ width: 8, height: 5 }),
    ).rejects.toThrow('too large');
  });
});

/** The script the desktop app ships for Windows. */
const SCRIPT = join(__dirname, '..', '..', 'desktop', 'native', 'person-computer.ps1');

// These start the real script with Windows PowerShell; they read and look only, never post input.
describe.runIf(process.platform === 'win32')('the real Windows helper', () => {
  it('reads the screen, takes a picture and refuses what it does not know', async () => {
    const helper = windowsHelper(SCRIPT, 60_000);
    try {
      const status = await helper.send({ op: 'status' });
      expect(status).toMatchObject({ ok: true, accessibility: true, screen: true, os: 'windows' });
      expect(Number(status.width)).toBeGreaterThan(0);
      expect(Number(status.height)).toBeGreaterThan(0);

      expect(await helper.send({ op: 'shell', command: 'dir' })).toMatchObject({
        ok: false,
        error: 'badRequest',
      });

      const shot = await helper.send({ op: 'shot', width: 64, height: 40, quality: 70 });
      expect(shot.ok).toBe(true);
      // A JPEG starts with FF D8.
      expect(Buffer.from(String(shot.data), 'base64').subarray(0, 2).toString('hex')).toBe('ffd8');
    } finally {
      helper.close();
    }
  }, 120_000);

  it('starts through the same entry the server and the desktop app use', async () => {
    const { driver, shot } = startHelper(SCRIPT, 'jpeg');
    try {
      expect(await driver.send({ op: 'status' })).toMatchObject({ ok: true, os: 'windows' });
      expect((await shot({ width: 32, height: 20 })).mimeType).toBe('image/jpeg');
    } finally {
      driver.close();
    }
  }, 120_000);
});
