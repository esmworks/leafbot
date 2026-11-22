import type { Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { translator } from '../src/i18n';
import { testServer, type TestServer } from './helpers';

describe('kararlar nedeniyle saklansın, cevaplanmış soru yeniden sorulmasın', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const prompt = async () => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    return t.engine.requests.at(-1)!.systemPrompt;
  };

  it('bot kararı tarihi ve nedeniyle yazması, sormadan önce hafızasına bakması gerektiğini bilir', async () => {
    const text = await prompt();
    expect(text).toContain(translator('tr')('prompt.ruleDecisions'));
    expect(text).toContain('kararın tarihini ve nedenini');
    expect(text).toContain('yeniden sorma');
  });

  it('İngilizce sunucuda kural İngilizce verilir', async () => {
    expect((await t.api('PATCH', '/api/settings', { language: 'en' })).status).toBe(200);
    const text = await prompt();
    expect(text).toContain(translator('en')('prompt.ruleDecisions'));
    expect(text).toContain('do not ask again what they already answered or decided');
  });
});
