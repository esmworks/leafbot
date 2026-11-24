import type { Message, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, waitFor, type TestServer } from './helpers';

const REMINDER = {
  type: 'Card',
  children: [
    { type: 'Title', value: 'Hatırlatma' },
    {
      type: 'Form',
      onSubmitAction: { type: 'save_reminder', payload: { id: 'r1' } },
      children: [
        { type: 'Label', value: 'Saat', fieldName: 'time' },
        { type: 'Input', name: 'time', defaultValue: '09:00', required: true },
        {
          type: 'Select',
          name: 'repeat',
          placeholder: 'Tekrar',
          options: [
            { value: 'weekdays', label: 'Hafta içi' },
            { value: 'daily', label: 'Her gün' },
          ],
        },
        { type: 'Button', label: 'Kaydet', submit: true },
      ],
    },
  ],
  cancel: { label: 'Vazgeç', action: { type: 'dismiss' } },
};

describe('interactive cards', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const call = (args: Record<string, unknown>) => `[araç:show_card ${JSON.stringify(args)}]`;
  const cardIn = async (threadId: string) => (await t.messages(threadId)).find((m) => m.props.card)!;
  const save = (card: Message) =>
    (
      card.props.card as { root: { children: { children?: { type: string; id: string }[] }[] } }
    ).root.children[1]!.children!.find((c) => c.type === 'Button')!.id;

  it('shows a checked card whose text chat apps can show', async () => {
    const bot = await t.bot();
    const th = await main(bot.id);
    await t.send(th.id, call({ card: REMINDER }));
    await t.services.turns.idle();
    const card = await cardIn(th.id);
    expect(card).toMatchObject({
      role: 'assistant',
      author: `bot:${bot.id}`,
      turnId: null,
      props: { cardRev: 1, card: { v: 1, root: { type: 'Card', id: 'n1' } } },
    });
    expect(card.text).toBe('Hatırlatma\nSaat: 09:00\nTekrar: Hafta içi / Her gün\n[Kaydet]\n[Vazgeç]');
    // The bot was told the card's id, to replace it later.
    expect((await t.messages(th.id)).at(-1)!.text).toContain(card.id);
  });

  it('tells the bot what is wrong with a card it cannot show', async () => {
    const bot = await t.bot();
    const th = await main(bot.id);
    await t.send(th.id, call({ card: { type: 'Card', children: [{ type: 'Chart', data: [] }] } }));
    await t.services.turns.idle();
    const msgs = await t.messages(th.id);
    expect(msgs.some((m) => m.props.card)).toBe(false);
    expect(msgs.at(-1)!.text).toContain('show_page');
    expect(msgs.at(-1)!.text).toContain('root.children[0]');
  });

  it("sends a form's values as the person's message, reads the action to the bot, and settles the card once", async () => {
    const bot = await t.bot();
    const th = await main(bot.id);
    await t.send(th.id, call({ card: REMINDER }));
    await t.services.turns.idle();
    const card = await cardIn(th.id);

    const wrong = await t.api('POST', `/api/messages/${card.id}/card`, {
      node: save(card),
      rev: 1,
      values: { time: '08:30', repeat: 'hourly' },
    });
    expect(wrong.status).toBe(400);
    expect((await cardIn(th.id)).props.cardAnswered).toBeUndefined();

    const pressed = await t.api<Message>('POST', `/api/messages/${card.id}/card`, {
      node: save(card),
      rev: 1,
      values: { time: '08:30', repeat: 'daily', other: 'ignored' },
    });
    expect(pressed.status).toBe(200);
    expect(pressed.body.props).toMatchObject({
      cardAnswered: true,
      cardAnswer: { node: save(card), label: 'Kaydet', values: { time: '08:30', repeat: 'daily' } },
    });
    await t.services.turns.idle();
    const msgs = await t.messages(th.id);
    const answer = msgs.find((m) => m.props.cardAnswerOf === card.id)!;
    expect(answer).toMatchObject({
      role: 'user',
      text: 'Kaydet\nSaat: 08:30\nTekrar: Her gün',
      props: { replyTo: { id: card.id } },
    });
    const asked = t.engine.requests.at(-1)!.prompt;
    expect(asked).toContain('Saat: 08:30');
    expect(asked).toContain('"type":"save_reminder"');
    expect(asked).toContain('"id":"r1"');
    expect(asked).toContain('"repeat":"daily"');

    const again = await t.api('POST', `/api/messages/${card.id}/card`, {
      node: 'cancel',
      rev: 1,
      values: {},
    });
    expect(again.status).toBe(409);
  });

  it('replaces a card not yet answered, refuses a press on the older one, and keeps an answered card', async () => {
    const bot = await t.bot();
    const th = await main(bot.id);
    await t.send(th.id, call({ card: REMINDER }));
    await t.services.turns.idle();
    const card = await cardIn(th.id);
    const next = {
      type: 'Card',
      children: [{ type: 'Text', value: 'Yüzde 50' }],
      confirm: { label: 'Tamam' },
    };
    await t.send(th.id, call({ card: next, card_id: card.id }));
    await t.services.turns.idle();
    const updated = await cardIn(th.id);
    expect(updated).toMatchObject({ id: card.id, text: 'Yüzde 50\n[Tamam]', props: { cardRev: 2 } });

    const stale = await t.api('POST', `/api/messages/${card.id}/card`, {
      node: 'confirm',
      rev: 1,
      values: {},
    });
    expect(stale.status).toBe(409);
    const ok = await t.api('POST', `/api/messages/${card.id}/card`, { node: 'confirm', rev: 2, values: {} });
    expect(ok.status).toBe(200);
    await t.services.turns.idle();

    await t.send(th.id, call({ card: REMINDER, card_id: card.id }));
    await t.services.turns.idle();
    expect((await cardIn(th.id)).text).toBe('Yüzde 50\n[Tamam]');
    expect((await t.messages(th.id)).at(-1)!.text).toContain('cevaplandı');
  });

  it('keeps a waiting answer as it was sent, and taking it back opens the card again', async () => {
    const bot = await t.bot();
    const th = await main(bot.id);
    await t.send(th.id, call({ card: REMINDER }));
    await t.services.turns.idle();
    const card = await cardIn(th.id);
    await t.send(th.id, '[bekle:1500]');
    await waitFor(async () => t.services.turns.isRunning(th.id));
    const pressed = await t.api('POST', `/api/messages/${card.id}/card`, {
      node: 'cancel',
      rev: 1,
      values: {},
    });
    expect(pressed.status).toBe(200);
    const answer = (await t.messages(th.id)).find((m) => m.props.cardAnswerOf === card.id)!;
    expect(answer.props.queued).toBe(true);
    expect((await t.api('PATCH', `/api/messages/${answer.id}`, { text: 'başka' })).status).toBe(409);
    expect((await t.api('DELETE', `/api/messages/${answer.id}`)).status).toBe(200);
    expect((await cardIn(th.id)).props.cardAnswered).toBeUndefined();
    await t.services.turns.idle();
    const again = await t.api('POST', `/api/messages/${card.id}/card`, {
      node: 'cancel',
      rev: 1,
      values: {},
    });
    expect(again.status).toBe(200);
  });

  it('is not shown in a conversation with another bot', async () => {
    const bot = await t.bot();
    const th = await main(bot.id);
    const said = await t.services.chatCards.show({
      bot,
      thread: { id: th.id, kind: 'bot', botId: bot.id },
      input: REMINDER,
      t: await t.services.settings.translator(),
    });
    expect(said).toContain('yazıyla');
    expect((await t.messages(th.id)).some((m) => m.props.card)).toBe(false);
  });
});
