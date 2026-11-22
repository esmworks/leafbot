import type { Bot, Thread } from '@leafbot/shared';
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
  const prompt = async (bot?: Bot) => {
    const b = bot ?? (await t.bot());
    await t.send((await main(b.id)).id, 'merhaba');
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
    expect(text).toContain(translator('en')('prompt.ruleChecklistBoard'));
  });

  it('sonraya kalan madde, pano açıkken bir sonraki mesajda kaybolmasın diye panoya yazılır', async () => {
    expect(await prompt()).toContain(translator('tr')('prompt.ruleChecklistBoard'));
  });

  it('panosu olmayan bot panoya yönlendirilmez ama maddeleri yine kontrol eder', async () => {
    const bot = await t.bot();
    await t.api('PATCH', `/api/bots/${bot.id}`, {
      toolSelection: { only: false, allow: [], exclude: ['mcp__leafbot__ticket_*'] },
    });
    const text = await prompt(bot);
    expect(text).toContain(translator('tr')('prompt.ruleChecklist'));
    expect(text).not.toContain(translator('tr')('prompt.ruleChecklistBoard'));
  });
});
