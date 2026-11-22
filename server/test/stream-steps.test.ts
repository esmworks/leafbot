import type { DeltaEvent, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('the reply streaming in', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  const streamOf = async (prompt: string) => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const shown: string[] = [];
    t.services.ctx.bus.on('delta', (e) => shown.push(e.text));
    await t.send(thread.id, prompt);
    await t.services.turns.idle();
    return shown.join('');
  };

  it('starts a new paragraph for the words written after a tool ran', async () => {
    expect(await streamOf('[söz:Bakıyorum.] [uzun-araç:1] [söz:Buldum.]')).toMatch(
      /^Bakıyorum\.\n\nBuldum\./,
    );
  });

  it('tells the screen to start over when a cut-off run is tried again', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const deltas: DeltaEvent[] = [];
    t.services.ctx.bus.on('delta', (e) => deltas.push(e));
    await t.send(thread.id, '[söz:Bakıyorum.] [kesik]');
    await t.services.turns.idle();
    const restarts = deltas.filter((e) => e.restart);
    expect(deltas[0]).toMatchObject({ text: 'Bakıyorum.' });
    expect(deltas[0]!.restart).toBeUndefined();
    expect(restarts).toHaveLength(1);
    // From the restart on, the pieces are the new run's text alone.
    const after = deltas
      .slice(deltas.indexOf(restarts[0]!))
      .map((e) => e.text)
      .join('');
    expect(after).toMatch(/^Bakıyorum\./);
    expect(after).not.toContain('Bakıyorum.Bakıyorum.');
  });

  it('leaves words of one step together', async () => {
    expect(await streamOf('[söz:Bakıyorum.] [söz:Buldum.]')).toMatch(/^Bakıyorum\.Buldum\./);
  });
});
