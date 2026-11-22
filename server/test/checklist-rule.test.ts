import type { Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { translator } from '../src/i18n';
import { testServer, type TestServer } from './helpers';

describe('birkaç iş birden istenince hiçbiri sessizce atlanmasın', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const prompt = async () => {
    const bot = await t.bot();
    await t.send((await main(bot.id)).id, 'merhaba');
    await t.services.turns.idle();
    return t.engine.requests.at(-1)!.systemPrompt;
  };

  it('bot isteği bitirmeden önce madde madde kontrol etmesi ve yapamadığını söylemesi gerektiğini bilir', async () => {
    const text = await prompt();
    expect(text).toContain(translator('tr')('prompt.ruleChecklist'));
    expect(text).toContain('hiçbir maddeyi sessizce atlama');
  });

  it('İngilizce sunucuda kural İngilizce verilir', async () => {
    expect((await t.api('PATCH', '/api/settings', { language: 'en' })).status).toBe(200);
    const text = await prompt();
    expect(text).toContain(translator('en')('prompt.ruleChecklist'));
    expect(text).toContain('never skip one silently');
  });
});
