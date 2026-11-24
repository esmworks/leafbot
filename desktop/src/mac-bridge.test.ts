import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAC_COOL_MS, MAC_IDLE_MS, MAC_MAX_MS, MacGate, readMacOn, writeMacOn } from './mac-bridge';

/** Stands in for the helper: keeps what it was asked to do. */
const fakeHelper = () => {
  const sent: Record<string, unknown>[] = [];
  return {
    sent,
    send: async (req: Record<string, unknown>) => {
      sent.push(req);
      return req.op === 'status'
        ? { ok: true, accessibility: true, screen: true, width: 800, height: 600 }
        : { ok: true };
    },
    close: () => undefined,
  };
};

describe('this Mac offered to a remote server', () => {
  let helper: ReturnType<typeof fakeHelper>;
  let asked: string[];
  let answer: boolean | 'never';
  let changes: boolean[];
  let gate: MacGate;
  beforeEach(() => {
    vi.useFakeTimers();
    helper = fakeHelper();
    asked = [];
    answer = true;
    changes = [];
    gate = new MacGate({
      driver: helper,
      shot: async (size) => ({ data: `jpg-${size.width}x${size.height}`, mimeType: 'image/jpeg' }),
      ask: (bot, signal) => {
        asked.push(bot);
        if (answer !== 'never') return Promise.resolve(answer);
        return new Promise((resolve) => signal.addEventListener('abort', () => resolve(true)));
      },
      onChange: (active) => changes.push(active),
    });
  });
  afterEach(() => vi.useRealTimers());

  it('passes only the requests it knows, within their limits', async () => {
    expect(await gate.handle({ op: 'run', command: 'rm -rf ~' })).toEqual({ ok: false, error: 'badRequest' });
    expect(await gate.handle({ op: 'type', text: 'x'.repeat(5001) })).toEqual({
      ok: false,
      error: 'badRequest',
    });
    expect(await gate.handle('status')).toEqual({ ok: false, error: 'badRequest' });
    expect(helper.sent).toEqual([]);
  });

  it('answers the status without asking, and touches nothing without a yes on this Mac', async () => {
    expect(await gate.handle({ op: 'status' })).toMatchObject({ ok: true, width: 800 });
    expect(await gate.handle({ op: 'click', x: 1, y: 1, button: 'left', count: 1 })).toEqual({
      ok: false,
      error: 'refused',
    });
    expect(await gate.handle({ op: 'screenshot', width: 10, height: 10 })).toEqual({
      ok: false,
      error: 'refused',
    });
    expect(asked).toEqual([]);
    expect(helper.sent.map((r) => r.op)).toEqual(['status']);
  });

  it('asks once for a use, then lets its steps through', async () => {
    expect(await gate.handle({ op: 'begin', bot: 'Muhasebe' })).toEqual({ ok: true });
    expect(asked).toEqual(['Muhasebe']);
    expect(changes).toEqual([true]);
    expect(await gate.handle({ op: 'screenshot', width: 10, height: 8 })).toEqual({
      ok: true,
      data: 'jpg-10x8',
      mimeType: 'image/jpeg',
    });
    await gate.handle({ op: 'key', code: 36, modifiers: [] });
    expect(helper.sent).toEqual([{ op: 'key', code: 36, modifiers: [] }]);
    // The next step of the same use is not asked about again.
    expect(await gate.handle({ op: 'begin', bot: 'Muhasebe' })).toEqual({ ok: true });
    expect(asked).toHaveLength(1);
  });

  it('a no, or no answer in time, refuses the use', async () => {
    answer = false;
    expect(await gate.handle({ op: 'begin', bot: 'A' })).toEqual({ ok: false, error: 'refused' });
    expect(gate.active()).toBe(false);

    // The question closes itself before the server stops waiting: a late yes opens nothing.
    await vi.advanceTimersByTimeAsync(MAC_COOL_MS + 1);
    answer = 'never';
    const pending = gate.handle({ op: 'begin', bot: 'A' });
    await vi.advanceTimersByTimeAsync(56_000);
    expect(await pending).toEqual({ ok: false, error: 'refused' });
    expect(gate.active()).toBe(false);
  });

  it('two steps asking at once get one question', async () => {
    const [a, b] = await Promise.all([
      gate.handle({ op: 'begin', bot: 'A' }),
      gate.handle({ op: 'begin', bot: 'A' }),
    ]);
    expect(a).toEqual({ ok: true });
    expect(b).toEqual({ ok: true });
    expect(asked).toHaveLength(1);
  });

  it('ends after a quiet while, and after fifteen minutes however busy', async () => {
    await gate.handle({ op: 'begin', bot: 'A' });
    await vi.advanceTimersByTimeAsync(MAC_IDLE_MS + 100);
    expect(gate.active()).toBe(false);
    expect(changes).toEqual([true, false]);
    expect(await gate.handle({ op: 'type', text: 'a' })).toEqual({ ok: false, error: 'refused' });

    await gate.handle({ op: 'begin', bot: 'A' });
    for (let elapsed = 0; elapsed < MAC_MAX_MS; elapsed += 60_000) {
      await vi.advanceTimersByTimeAsync(60_000);
      await gate.handle({ op: 'type', text: 'a' });
    }
    expect(gate.active()).toBe(false);
    expect(asked).toHaveLength(2);
  });

  it('Stop ends the use at once, and the Mac says no by itself for a short while', async () => {
    await gate.handle({ op: 'begin', bot: 'A' });
    gate.stop();
    expect(changes).toEqual([true, false]);
    expect(await gate.handle({ op: 'scroll', x: 1, y: 1, dx: 0, dy: -3 })).toEqual({
      ok: false,
      error: 'refused',
    });
    expect(await gate.handle({ op: 'begin', bot: 'A' })).toEqual({ ok: false, error: 'refused' });
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MAC_COOL_MS + 1);
    expect(await gate.handle({ op: 'begin', bot: 'A' })).toEqual({ ok: true });
    expect(asked).toHaveLength(2);
  });

  it('after a no, a bot asking again at once is not asked about on the screen', async () => {
    answer = false;
    await gate.handle({ op: 'begin', bot: 'A' });
    answer = true;
    expect(await gate.handle({ op: 'begin', bot: 'A' })).toEqual({ ok: false, error: 'refused' });
    expect(asked).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MAC_COOL_MS + 1);
    expect(await gate.handle({ op: 'begin', bot: 'A' })).toEqual({ ok: true });
  });

  it('keeps the switch off until the person turns it on', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mac-'));
    expect(readMacOn(dir)).toBe(false);
    writeMacOn(dir, true);
    expect(readMacOn(dir)).toBe(true);
    writeMacOn(dir, false);
    expect(readMacOn(dir)).toBe(false);
  });
});
