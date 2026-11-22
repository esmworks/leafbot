import type { Message, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('sesli görüşmede söylenen mesaj', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('sesli söylendiği işaretlenir; bot kısa ve okunabilir cevap vermesi gerektiğini okur', async () => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const r = await t.api<Message>('POST', `/api/threads/${thread.id}/messages`, {
      clientId: 'spoken-0001',
      text: 'Yarın hava nasıl',
      spoken: true,
    });
    expect(r.body.props.spoken).toBe(true);
    await t.services.turns.idle();
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt).toContain('Yarın hava nasıl');
    expect(prompt).toContain('sesli görüşmede');

    // A typed message carries neither.
    await t.send(thread.id, 'Yazdım');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).not.toContain('sesli görüşmede');
  });
});
