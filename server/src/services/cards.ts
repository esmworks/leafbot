import {
  cardLink,
  cardPress,
  cardText,
  cardValueText,
  checkCardValues,
  parseCard,
  storedCard,
  type Bot,
  type Message,
  type Thread,
} from '@leafbot/shared';
import { and, eq, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import { HttpError } from '../util';
import type { Services } from './index';

/**
 * Conversations a card is not shown in: a room's members answer in turn, another bot cannot press,
 * and a rehearsal has no one to answer.
 */
const NO_CARDS: Thread['kind'][] = ['room', 'bot', 'rehearsal'];

/** What a press sends: the part pressed, the card's revision it was made on, and the field values. */
export interface CardAnswerInput {
  node: string;
  rev: number;
  values: Record<string, unknown>;
}

/**
 * Interactive cards a bot shows with `show_card`. A card is a message of the bot's whose text is
 * the card as plain text, so chat apps, search and the bot reading back see it as words. It is
 * answered once: the answer becomes the person's next message, a reply to the card.
 */
export class CardService {
  constructor(
    private ctx: Ctx,
    private services: Services,
    private clock: () => Date = () => new Date(),
  ) {}

  /** Shows a card, or replaces one not yet answered; the answer to the bot is a sentence. */
  async show(o: {
    bot: Bot;
    thread: Pick<Thread, 'id' | 'kind' | 'botId'>;
    input: unknown;
    cardId?: string;
    t: T;
  }): Promise<string> {
    const { bot, thread, t } = o;
    if (NO_CARDS.includes(thread.kind)) return t('tool.cardNotHere');
    const parsed = parseCard(o.input);
    if (!parsed.ok) {
      const { path, issue, detail = '' } = parsed.error;
      const [what, other = ''] = detail.split(':');
      return t('tool.cardInvalid', { path, problem: t(`card.issue.${issue}`, { detail: what!, other }) });
    }
    const { card } = parsed;
    const text = cardText(card);
    if (!o.cardId) {
      const { message } = await this.services.threads.addMessage({
        threadId: thread.id,
        role: 'assistant',
        author: `bot:${bot.id}`,
        text,
        // No turn id: the streaming reply of the same turn stays on screen until it is saved.
        props: { card, cardRev: 1 },
      });
      return t('tool.cardShown', { id: message.id });
    }
    const row = await this.row(o.cardId);
    if (!row || row.threadId !== thread.id || row.author !== `bot:${bot.id}` || !storedCard(row.props.card)) {
      return t('tool.cardNotFound');
    }
    const rev = Number(row.props.cardRev ?? 1);
    // Replaced in one step with the check, so a press made meanwhile either lands on the old card
    // first (and the card stays answered) or is refused as made on an older one.
    const done = await this.ctx.db
      .update(schema.messages)
      .set({ text, props: { ...row.props, card, cardRev: rev + 1 } })
      .where(and(eq(schema.messages.id, row.id), unanswered(), sameRev(rev)))
      .returning({ id: schema.messages.id });
    if (!done.length) return t('tool.cardAnswered');
    this.ctx.bus.refresh({ scope: 'thread', threadId: thread.id, botId: thread.botId });
    return t('tool.cardUpdated', { id: row.id });
  }

  /**
   * The person's press. Everything that can fail is checked before the card is marked answered,
   * and the mark is taken back when the message could not be sent, so a filled form is not lost.
   */
  async answer(messageId: string, input: CardAnswerInput, userId: string): Promise<Message> {
    const row = await this.row(messageId);
    const card = row ? storedCard(row.props.card) : null;
    if (!row || !card) throw new HttpError(400, 'error.notCard');
    if (row.props.cardAnswered) throw new HttpError(409, 'error.cardAnswered');
    if (Number(row.props.cardRev ?? 1) !== input.rev) throw new HttpError(409, 'error.cardChanged');
    const press = cardPress(card, input.node);
    // A link is opened on the device; it is not an answer.
    if (!press || cardLink(press.action)) throw new HttpError(400, 'error.cardNoSuchPart');
    const checked = checkCardValues(press, input.values);
    if (!checked.ok) {
      throw new HttpError(400, `error.cardValue.${checked.issue}`, { field: checked.field.label });
    }
    const thread = await this.services.threads.row(row.threadId);
    const bot = await this.services.bots.get(thread.botId);
    if (bot.archivedAt) throw new HttpError(409, 'error.botArchived');
    const t = await this.services.settings.translator();
    const words = { yes: t('card.yes'), no: t('card.no') };
    const lines = [press.label];
    for (const f of press.fields) {
      const v = checked.values[f.name];
      if (v === undefined || v === '') continue;
      lines.push(`${f.label}: ${cardValueText(f, v, words)}`);
    }
    const answer = {
      node: press.ref,
      label: press.label,
      values: checked.values,
      at: this.clock().toISOString(),
    };
    const claimed = await this.ctx.db
      .update(schema.messages)
      .set({ props: { ...row.props, cardAnswered: true, cardAnswer: answer } })
      .where(and(eq(schema.messages.id, row.id), unanswered(), sameRev(input.rev)))
      .returning({ id: schema.messages.id });
    if (!claimed.length) throw new HttpError(409, 'error.cardAnswered');
    try {
      await this.services.inbox.send(row.threadId, {
        text: lines.join('\n'),
        replyTo: row.id,
        // A press sent twice (a retry, two devices) is one message.
        clientId: `card:${row.id}:${input.rev}`,
        userId,
        props: { cardAnswerOf: row.id },
        forBot: t('card.forBot', {
          action: press.action ? JSON.stringify(press.action) : t('card.noAction'),
          values: JSON.stringify(checked.values),
        }),
      });
    } catch (err) {
      await this.reopen(row.id);
      throw err;
    }
    this.ctx.bus.refresh({ scope: 'thread', threadId: row.threadId, botId: thread.botId });
    return this.services.threads.message(row.id);
  }

  /** Opens a card again for another answer: its answer was taken back before the bot read it. */
  async reopen(cardId: string) {
    const row = await this.row(cardId);
    if (!row?.props.cardAnswered) return;
    const { cardAnswered: _a, cardAnswer: _b, ...props } = row.props;
    await this.services.threads.updateMessage(row.id, { props });
  }

  private async row(id: string) {
    const [row] = await this.ctx.db.select().from(schema.messages).where(eq(schema.messages.id, id)).limit(1);
    return row ?? null;
  }
}

const unanswered = () => sql`${schema.messages.props}->>'cardAnswered' is null`;
const sameRev = (rev: number) => sql`coalesce(${schema.messages.props}->>'cardRev', '1') = ${String(rev)}`;
