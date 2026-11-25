import type { Approval, BotSummary, Group, SearchHit, Thread } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';

/** A tool call the fake engine makes, written as the bot's words. */
const call = (name: string, input: unknown) => `[araç:${name} ${JSON.stringify(input)}]`;
const ask = call('ask_user', { questions: [{ question: 'Hangi lisans?', options: ['A', 'B'] }] });

describe('botlar arası konuşmada sorulan kart', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const group = async (name: string) => (await t.api<Group>('POST', '/api/groups', { name })).body;
  const pending = async () =>
    waitFor(async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0]);
  const summary = async (botId: string) =>
    (await t.api<BotSummary[]>('GET', '/api/summaries')).body.find((s) => s.botId === botId)!;

  it('işin başladığı sohbette gösterilir; rozet ve bildirim o bota gider', async () => {
    const g = await group('Ekip');
    const vezir = await t.bot({ name: 'Vezir', groupId: g.id });
    const dev = await t.bot({ name: 'Geliştirici', groupId: g.id });
    const tv = await main(vezir.id);
    const notices: { botId: string; threadId: string }[] = [];
    t.services.ctx.bus.on('notice', (e: { kind: string; botId: string; threadId: string }) => {
      if (e.kind === 'needsYou') notices.push(e);
    });
    await t.send(tv.id, call('bot_send', { bot: 'Geliştirici', message: ask }));
    const card = await pending();

    // Asked in the exchange, shown where the person gave Vezir the work.
    expect(card.botId).toBe(dev.id);
    expect(card.threadId).not.toBe(tv.id);
    expect(card.answerIn).toMatchObject({ threadId: tv.id, botId: vezir.id, props: { approvalId: card.id } });
    expect(notices.at(-1)).toMatchObject({ botId: vezir.id, threadId: tv.id });

    const own = await summary(vezir.id);
    expect(own.pendingApprovals).toBe(1);
    expect(own.waiting?.threadId).toBe(tv.id);
    // The developer's line in the sidebar is not what it said to Vezir.
    const other = await summary(dev.id);
    expect(other.pendingApprovals).toBe(0);
    expect(other.preview).toBeNull();

    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answers: ['B'] });
    await t.services.turns.idle();
  });

  it('zincirin daha aşağısında sorulsa da işin başladığı sohbette gösterilir', async () => {
    const g = await group('Ekip');
    const vezir = await t.bot({ name: 'Vezir', groupId: g.id });
    await t.bot({ name: 'Geliştirici', groupId: g.id });
    const guard = await t.bot({ name: 'Güvenlik', groupId: g.id });
    const tv = await main(vezir.id);
    const inner = call('bot_send', { bot: 'Güvenlik', message: ask });
    await t.send(tv.id, call('bot_send', { bot: 'Geliştirici', message: inner }));
    const card = await pending();
    expect(card.botId).toBe(guard.id);
    expect(card.answerIn).toMatchObject({ threadId: tv.id, botId: vezir.id });
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answers: ['A'] });
    await t.services.turns.idle();
  });

  it('işin başladığı sohbet yoksa kişinin isteyen botla ana sohbetinde gösterilir', async () => {
    const g = await group('Ekip');
    const vezir = await t.bot({ name: 'Vezir', groupId: g.id });
    await t.bot({ name: 'Geliştirici', groupId: g.id });
    const tv = await main(vezir.id);
    const side = (await t.api<Thread>('POST', `/api/bots/${vezir.id}/threads`, {})).body;
    await t.send(side.id, call('bot_send', { bot: 'Geliştirici', message: ask }));
    const card = await pending();
    expect(card.answerIn?.threadId).toBe(side.id);

    // As if the conversation were gone without its requests being stopped.
    await t.db.db.delete(schema.threads).where(eq(schema.threads.id, side.id));
    const after = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0]!;
    expect(after.answerIn).toMatchObject({ threadId: tv.id, botId: vezir.id });

    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
  });

  it('kişinin kendi sohbetindeki kart olduğu yerde kalır', async () => {
    const bot = await t.bot({ name: 'Vezir' });
    const tv = await main(bot.id);
    await t.send(tv.id, ask);
    const card = await pending();
    expect(card.threadId).toBe(tv.id);
    expect(card.answerIn).toBeUndefined();
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answers: ['A'] });
    await t.services.turns.idle();
  });

  it('ayrı sohbetteki bekleyen kart kendi satırıyla gelir; ana sohbet onu oradan da gösterir', async () => {
    const bot = await t.bot({ name: 'Vezir' });
    const side = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    await t.send(side.id, ask);
    const card = await pending();
    expect(card.threadId).toBe(side.id);
    expect(card.line).toMatchObject({ approvalId: card.id });

    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answers: ['A'] });
    await t.services.turns.idle();
    const answered = (await t.api<Approval[]>('GET', '/api/approvals')).body.find((a) => a.id === card.id)!;
    expect(answered.line).toBeUndefined();
  });

  it('başka bot için çalışan bot ayrı sohbet açamaz; arama botlar arası konuşmayı göstermez', async () => {
    const g = await group('Ekip');
    const vezir = await t.bot({ name: 'Vezir', groupId: g.id });
    const dev = await t.bot({ name: 'Geliştirici', groupId: g.id });
    const tv = await main(vezir.id);
    const open = call('open_conversation', { title: 'Lisans uyumu', message: 'karar ver' });
    await t.send(tv.id, call('bot_send', { bot: 'Geliştirici', message: `zebercet ${open}` }));
    await t.services.turns.idle();

    const threads = (await t.api<Thread[]>('GET', `/api/bots/${dev.id}/threads`)).body;
    expect(threads.some((x) => x.title === 'Lisans uyumu')).toBe(false);
    const hits = (await t.api<SearchHit[]>('GET', '/api/search?q=zebercet')).body;
    // Vezir's own words to the developer are in Vezir's conversation, not the exchange.
    expect(hits.every((h) => h.threadKind !== 'bot')).toBe(true);
    expect(hits.some((h) => h.threadId === tv.id)).toBe(true);
  });
});
