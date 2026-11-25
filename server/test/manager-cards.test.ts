import type { Approval, Thread } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { managerMayNotAnswer } from '../src/services/approvals';
import { OWNER_ID } from '../src/users';
import { testServer, waitFor, type TestServer } from './helpers';

/** A manager answers the cards waiting on the person, in the person's words. */
describe('a manager answering waiting cards', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
  const card = (id: string) => t.api<Approval>('GET', `/api/approvals/${id}`).then((r) => r.body);
  /**
   * The bot's latest reply once it says `text`. The waiting bots' turns stay open on their cards,
   * so the turns are never all idle here.
   */
  const said = (threadId: string, text: string) =>
    waitFor(async () => {
      const last = (await t.messages(threadId)).filter((m) => m.role === 'assistant').at(-1)?.text ?? '';
      return last.includes(text) ? last : null;
    });
  const answer = (items: unknown[]) => `[araç:cards_answer ${JSON.stringify({ answers: items })}]`;

  /** A bot waiting on a question card in its own conversation. */
  const asking = async (name: string, isManager = false) => {
    const bot = await t.bot({ name, isManager });
    const thread = await main(bot.id);
    const call = { questions: [{ question: 'Hangi şehir?', options: ['İstanbul', 'Ankara'] }] };
    await t.send(thread.id, `[araç:ask_user ${JSON.stringify(call)}]`);
    const c = await waitFor(async () => (await pending()).find((x) => x.botId === bot.id));
    return { bot, thread, card: c };
  };

  it('answers a question from the person’s own word without a card, and says so', async () => {
    const worker = await asking('Yazar');
    const m = await t.bot({ name: 'Müdür', isManager: true });
    const home = await main(m.id);
    await t.send(home.id, '[araç:cards_waiting {}]');
    const listed = await said(home.id, worker.card.id);
    expect(listed).toContain('Hangi şehir?');

    await t.send(
      home.id,
      answer([{ card: worker.card.id, bot: 'yazar', decision: 'yes', answer: 'Ankara' }]),
    );
    await said(home.id, 'yanıtlandı');
    // No card of the manager's own: the person said it, in their own conversation.
    expect((await pending()).filter((x) => x.botId === m.id)).toHaveLength(0);
    const done = await card(worker.card.id);
    expect(done).toMatchObject({ status: 'allowed', answer: 'Ankara', answeredVia: m.id });
    // The waiting bot hears whose answer it is.
    expect(await said(worker.thread.id, 'Ankara')).toContain('Müdür');
  });

  it('asks the person on one card once a card’s words came from outside', async () => {
    const worker = await asking('Yazar');
    await t.db.db
      .update(schema.approvals)
      .set({ outside: true })
      .where(eq(schema.approvals.id, worker.card.id));
    const m = await t.bot({ name: 'Müdür', isManager: true, permissionMode: 'auto' });
    const home = await main(m.id);
    await t.send(
      home.id,
      `[araç:cards_waiting {}] ${answer([{ card: worker.card.id, bot: 'Yazar', decision: 'yes', answer: 'Ankara' }])}`,
    );
    const asked = await waitFor(async () => (await pending()).find((x) => x.botId === m.id));
    expect(asked.toolName).toBe('cards_answer');
    expect(asked.input.questions).toEqual([
      expect.objectContaining({ context: expect.stringContaining('Ankara') }),
    ]);
    expect((await card(worker.card.id)).status).toBe('pending');

    await t.api('POST', `/api/approvals/${asked.id}`, { decision: 'allow' });
    await said(home.id, 'yanıtlandı');
    expect(await card(worker.card.id)).toMatchObject({ status: 'allowed', answeredVia: m.id });
  });

  it('turns a step down with the person’s words, signed, and never remembers it', async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true });
    const g = (await t.api<{ id: string }>('POST', '/api/groups', { name: 'Ekip' })).body;
    const careful = await t.bot({ name: 'Dikkatli', permissionMode: 'ask', groupId: g.id });
    await t.bot({ name: 'Serbest', groupId: g.id, permissionMode: 'auto' });
    const tc = await main(careful.id);
    await t.send(tc.id, '[araç:bot_send {"bot":"Serbest","message":"merhaba"}]');
    const step = await waitFor(async () => (await pending()).find((x) => x.botId === careful.id));
    expect(step.kind).toBe('tool');

    const home = await main(m.id);
    await t.send(
      home.id,
      answer([{ card: step.id, bot: 'Dikkatli', decision: 'no', answer: 'Daha samimi yaz' }]),
    );
    await said(home.id, 'reddedildi');
    expect(await card(step.id)).toMatchObject({ status: 'denied', answeredVia: m.id });
    expect(await said(tc.id, 'Daha samimi yaz')).toContain('Müdür');
    const rules = await t.db.db
      .select()
      .from(schema.permissionRules)
      .where(eq(schema.permissionRules.botId, careful.id));
    expect(rules).toHaveLength(0);
  });

  it('leaves another manager’s card and a mismatched bot name unanswered', async () => {
    const other = await asking('Başka Müdür', true);
    const worker = await asking('Yazar');
    const m = await t.bot({ name: 'Müdür', isManager: true });
    const home = await main(m.id);
    await t.send(
      home.id,
      answer([
        { card: other.card.id, bot: 'Başka Müdür', decision: 'yes', answer: 'Ankara' },
        { card: worker.card.id, bot: 'Başka Müdür', decision: 'yes', answer: 'Ankara' },
      ]),
    );
    const out = await said(home.id, 'tutmuyor');
    expect(out).toContain('kullanıcıda kalır');
    expect((await card(other.card.id)).status).toBe('pending');
    expect((await card(worker.card.id)).status).toBe('pending');
    // The service refuses it too, whoever calls it.
    await expect(
      t.services.approvals.answer(
        other.card.id,
        { decision: 'allow', answer: 'Ankara', remember: true },
        OWNER_ID,
        { via: { botId: m.id, name: m.name } },
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('the cards that stay with the person', () => {
  const base = {
    kind: 'tool',
    toolName: 'bot_send',
    input: {},
    options: [],
    summary: '',
    botId: 'w',
  } as const;
  const may = (card: Partial<Approval>, line: Record<string, unknown> = {}) =>
    managerMayNotAnswer({ ...base, ...card } as Approval, line, 'm');

  it('keeps payments, keys, sign-ins, the person’s devices, two-person steps and lookalikes', () => {
    expect(may({})).toBeNull();
    expect(may({ toolName: 'browser_card' })).toBe('cards.keep.payment');
    expect(may({ toolName: 'browser_login' })).toBe('cards.keep.secret');
    expect(may({ toolName: 'credential_request' })).toBe('cards.keep.secret');
    expect(may({ kind: 'login' })).toBe('cards.keep.secret');
    expect(
      may({
        kind: 'question',
        toolName: 'ask_user',
        input: { questions: [{ question: 'Şifre?', secret: true }] },
      }),
    ).toBe('cards.keep.secret');
    expect(may({ needsSecond: true })).toBe('cards.keep.second');
    expect(may({ botId: 'm' })).toBe('cards.keep.manager');
    expect(may({}, { resembles: 'bank.example' })).toBe('cards.keep.lookalike');
  });
});
