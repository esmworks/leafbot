import type { Thread } from '@leafbot/shared';
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

  it('leaves words of one step together', async () => {
    expect(await streamOf('[söz:Bakıyorum.] [söz:Buldum.]')).toMatch(/^Bakıyorum\.Buldum\./);
  });
});
