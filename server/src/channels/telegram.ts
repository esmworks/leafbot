import { randomBytes, timingSafeEqual } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_UPLOAD_BYTES,
  questionItems,
  type Approval,
  telegramToken,
  type Message,
  type NoticeEvent,
  type TelegramStatus,
  type TurnEvent,
} from '@leafbot/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import type { Services } from '../services';
import type { VaultService } from '../services/vault';
import { saveUpload, stagingDir } from '../uploads';
import { HttpError, newId, truncate } from '../util';
import { qrImage } from './qr';
import {
  canOpen,
  cardView,
  chatCommand,
  dropRequest,
  heldRequests,
  holdRequest,
  queuedTurn,
  saidNothing,
  withMissingFiles,
  lastWroteVia,
  messageFiles,
  parseChoice,
  receivedName,
  SendQueue,
} from './common';
import { telegramMessages } from './format';
import {
  TelegramApi,
  TelegramError,
  type TgCallback,
  type TgFile,
  type TgMessage,
  type TgUpdate,
} from './telegram-api';

type Row = typeof schema.channels.$inferSelect;

/** Where a forwarded Telegram message came from, as the Bot API gives it (older fields too). */
type Forward = {
  forward_origin?: {
    type?: string;
    sender_user?: { first_name?: string; last_name?: string; username?: string };
    sender_user_name?: string;
    sender_chat?: { title?: string };
    chat?: { title?: string };
  };
  forward_date?: number;
  forward_from?: { first_name?: string; last_name?: string };
  forward_from_chat?: { title?: string };
  forward_sender_name?: string;
};

/**
 * Who a forwarded message came from, as a name; null when the message is the person's own. A
 * forward is someone else's words, whatever account sent it on.
 */
export function forwardedFrom(m: TgMessage): string | null {
  const f = m as TgMessage & Forward;
  if (!f.forward_origin && !f.forward_date && !f.forward_from && !f.forward_from_chat) return null;
  const o = f.forward_origin;
  const user = o?.sender_user ?? f.forward_from;
  const name =
    [user?.first_name, user?.last_name].filter(Boolean).join(' ') ||
    o?.sender_user_name ||
    o?.sender_chat?.title ||
    o?.chat?.title ||
    f.forward_from_chat?.title ||
    f.forward_sender_name ||
    '';
  return name.slice(0, 80);
}

/** A pairing link works this long. */
const PAIR_MS = 15 * 60_000;
/** Telegram's limits: files a bot may download, and files it may send. */
const DOWNLOAD_MAX = 20 * 1024 * 1024;
const SEND_MAX = 50 * 1024 * 1024;

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/** Telegram says the person blocked the bot (or never started it): nothing sent there can arrive. */
const isBlocked = (err: unknown) => err instanceof TelegramError && err.code === 403;

const sameText = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/**
 * Each bot can have a Telegram bot of its own, made with BotFather. The server reads its messages
 * by asking Telegram for them (no public address needed), and only from the one Telegram account
 * that paired with it. What that account writes goes to the bot's main conversation as the
 * person's message; while the person last wrote from Telegram, the bot's replies, files and cards
 * go back there.
 */
export class TelegramChannels {
  private polls = new Map<string, { stop: AbortController; done: Promise<void> }>();
  private typing = new Map<string, NodeJS.Timeout>();
  private sends = new SendQueue();
  private unsubs: (() => void)[] = [];
  private stopped = false;
  /** Aborts on stop, so a wait for Telegram's "slow down" does not hold the stop up. */
  private halting = new AbortController();
  /** Conversations where a request from Telegram is being worked on, to end it once. */
  private working = new Set<string>();

  constructor(
    private ctx: Ctx,
    private services: Services,
    private vault: VaultService,
  ) {}

  async start() {
    this.unsubs.push(this.services.threads.onMessage((m) => this.outgoing(m)));
    this.unsubs.push(this.ctx.bus.on('turn', (e) => void this.turnState(e).catch(() => {})));
    this.unsubs.push(this.ctx.bus.on('notice', (e) => void this.notice(e).catch(() => {})));
    // A bot that was deleted leaves its Telegram bot behind with no one to answer for.
    await this.ctx.db
      .delete(schema.channels)
      .where(and(eq(schema.channels.kind, 'telegram'), isNull(schema.channels.botId)));
    // Before reading Telegram again, so a message that arrives now is never taken for a stale one.
    for (const row of await this.rows()) {
      if (row.secret) await this.settleHeld(row).catch((err: unknown) => console.warn('telegram held', err));
    }
    for (const row of await this.rows()) if (row.secret) this.listen(row.id);
  }

  /**
   * Requests that were being worked on when the server stopped are over: the person is told so
   * they write again. A queued turn survives the restart and still runs, so its request stays.
   */
  private async settleHeld(row: Row) {
    const held = await heldRequests(this.ctx, row.id);
    if (!held.length) return;
    const t = await this.services.settings.translator();
    const api = row.secret ? this.api(this.vault.open(row.secret)) : null;
    for (const h of held) {
      if (await queuedTurn(this.ctx, h.threadId)) {
        this.working.add(h.threadId);
        continue;
      }
      await dropRequest(this.ctx, row.id, h.threadId);
      const chat = (h.place as { chat?: string }).chat;
      if (!api || !chat || !row.owner) continue;
      await this.sends.run(row.id, async () => {
        await api.sendMessage(chat, t('channel.cutShort'));
      });
    }
  }

  async stop() {
    this.stopped = true;
    this.halting.abort();
    for (const u of this.unsubs) u();
    for (const p of this.polls.values()) p.stop.abort();
    await Promise.all([...this.polls.values()].map((p) => p.done));
    this.polls.clear();
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
    await this.sends.drain();
  }

  // The app's side

  async status(botId: string): Promise<TelegramStatus> {
    await this.services.bots.get(botId);
    const row = await this.forBot(botId);
    const account = row?.account as { username?: string; name?: string } | undefined;
    const unreadable = !!row?.secret && !canOpen(this.vault, row.secret);
    const pairing = !!row?.pairCode && !!row.pairUntil && row.pairUntil.getTime() > Date.now();
    const pairLink =
      pairing && account?.username ? `https://t.me/${account.username}?start=${row.pairCode}` : null;
    return {
      connected: !!row?.secret && !unreadable,
      bot: account?.username ? { username: account.username, name: account.name ?? account.username } : null,
      owner: row?.owner ? { name: row.ownerName ?? '' } : null,
      pairLink,
      pairQr: pairLink ? await qrImage(pairLink) : null,
      pairUntil: pairing ? row.pairUntil!.toISOString() : null,
      notices: (row?.settings as { notices?: boolean } | undefined)?.notices !== false,
      error: unreadable
        ? (await this.services.settings.translator())('channel.secretUnreadable')
        : (row?.error ?? null),
    };
  }

  /**
   * Saves a bot's Telegram token after Telegram accepts it, and starts a pairing: the link it
   * gives opens the Telegram bot with a code, and whoever presses Start there pairs.
   */
  /** Links a Telegram bot for `userId`: what comes in through it is theirs. */
  async connect(botId: string, raw: string, userId: string): Promise<TelegramStatus> {
    const bot = await this.services.bots.get(botId);
    const token = telegramToken(raw);
    if (!token) throw new HttpError(400, 'error.telegramToken');
    const api = this.api(token);
    let me;
    try {
      me = await api.getMe();
    } catch (err) {
      if (err instanceof TelegramError && (err.code === 401 || err.code === 404)) {
        throw new HttpError(400, 'error.telegramTokenRefused');
      }
      throw new HttpError(502, 'error.telegramUnreachable');
    }
    if (!me.username) throw new HttpError(400, 'error.telegramToken');
    // One Telegram bot answers for one bot here, or the two would read each other's messages.
    for (const other of await this.rows()) {
      if (other.botId !== botId && (other.account as { id?: number }).id === me.id) {
        const name = await this.services.bots.get(other.botId!).then(
          (b) => b.name,
          () => '?',
        );
        throw new HttpError(409, 'error.telegramInUse', { bot: name });
      }
    }
    // Messages come by asking for them; a webhook left from elsewhere would keep them away.
    await api.call('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
    const t = await this.services.settings.translator();
    await api
      .call('setMyCommands', {
        commands: [
          { command: 'stop', description: t('channel.cmdStop') },
          { command: 'new', description: t('channel.cmdNew') },
        ],
      })
      .catch(() => {});
    const existing = await this.forBot(botId);
    const sameBot = (existing?.account as { id?: number } | undefined)?.id === me.id;
    const values = {
      secret: this.vault.seal(token),
      account: { id: me.id, username: me.username, name: me.first_name },
      error: null,
      userId,
      pairCode: randomBytes(16).toString('base64url'),
      pairUntil: new Date(Date.now() + PAIR_MS),
      // Another Telegram bot starts over: nobody has paired with it yet.
      ...(!sameBot && { owner: null, ownerName: null, cursor: null }),
    };
    let id: string;
    if (existing) {
      id = existing.id;
      await this.ctx.db.update(schema.channels).set(values).where(eq(schema.channels.id, id));
    } else {
      id = newId();
      await this.ctx.db.insert(schema.channels).values({ id, kind: 'telegram', botId: bot.id, ...values });
    }
    this.listen(id);
    this.changed();
    return this.status(botId);
  }

  /** A new pairing link, for another phone or after the last one ran out. */
  async pair(botId: string): Promise<TelegramStatus> {
    const row = await this.forBot(botId);
    if (!row?.secret) throw new HttpError(409, 'error.telegramNotConnected');
    await this.ctx.db
      .update(schema.channels)
      .set({ pairCode: randomBytes(16).toString('base64url'), pairUntil: new Date(Date.now() + PAIR_MS) })
      .where(eq(schema.channels.id, row.id));
    this.changed();
    return this.status(botId);
  }

  async update(botId: string, patch: { notices: boolean }): Promise<TelegramStatus> {
    const row = await this.forBot(botId);
    if (!row) throw new HttpError(409, 'error.telegramNotConnected');
    await this.patchSettings(row.id, { notices: patch.notices });
    this.changed();
    return this.status(botId);
  }

  /** Forgets the token and the paired account; the Telegram bot itself stays with its owner. */
  async disconnect(botId: string): Promise<void> {
    const row = await this.forBot(botId);
    if (!row) return;
    this.halt(row.id);
    await this.ctx.db.delete(schema.channels).where(eq(schema.channels.id, row.id));
    this.changed();
  }

  // Reading Telegram

  private listen(id: string) {
    if (this.stopped) return;
    this.halt(id);
    const stop = new AbortController();
    const done = this.poll(id, stop.signal).catch((err: unknown) => console.warn('telegram', err));
    this.polls.set(id, { stop, done });
  }

  private halt(id: string) {
    this.polls.get(id)?.stop.abort();
    this.polls.delete(id);
  }

  private async poll(id: string, signal: AbortSignal) {
    let wait = 1000;
    while (!signal.aborted) {
      const row = await this.row(id);
      if (!row?.secret || !row.botId) return;
      let token: string;
      try {
        token = this.vault.open(row.secret);
      } catch (err) {
        // A token that cannot be opened will not open on a retry; the status says why.
        console.warn('telegram token', err);
        return;
      }
      const api = this.api(token);
      try {
        const updates = await api.getUpdates(
          row.cursor ? Number(row.cursor) : undefined,
          this.ctx.config.telegramPollSeconds,
          signal,
        );
        // A blocked bot is not cleared by Telegram answering; the person unblocking it does that.
        if (row.error && !(row.settings as { blocked?: boolean }).blocked) await this.setError(id, null);
        for (const u of updates) {
          if (signal.aborted) return;
          await this.handle(id, api, u).catch((err: unknown) => this.failed(row, api, u, err));
          await this.ctx.db
            .update(schema.channels)
            .set({ cursor: String(u.update_id + 1) })
            .where(eq(schema.channels.id, id));
        }
        wait = 1000;
      } catch (err) {
        if (signal.aborted) return;
        if (err instanceof TelegramError) {
          // The blocked note stays until the person unblocks; a poll error would hide it for good.
          if (!(row.settings as { blocked?: boolean }).blocked) {
            await this.setError(id, err.description || err.message);
          }
          // The token was revoked or the bot deleted: asking again changes nothing.
          if (err.code === 401 || err.code === 404) return;
          if (err.retryAfter) wait = Math.max(wait, err.retryAfter * 1000);
        } else {
          console.warn('telegram poll', (err as Error).message);
        }
        await sleep(wait, signal);
        wait = Math.min(wait * 2, 60_000);
      }
    }
  }

  /** One update could not be handled: it is logged, and the person is told so they can try again. */
  private async failed(row: Row, api: TelegramApi, u: TgUpdate, err: unknown) {
    console.warn('telegram update', err);
    const chat = u.message?.chat.id ?? u.callback_query?.message?.chat.id;
    const from = u.message?.from?.id ?? u.callback_query?.from.id;
    // Only the paired person is ever written to, not whoever found the bot.
    if (!chat || !row.owner || String(from) !== row.owner || isBlocked(err)) return;
    const t = await this.services.settings.translator();
    await api.sendMessage(chat, t('channel.updateFailed')).catch(() => {});
  }

  private async handle(id: string, api: TelegramApi, u: TgUpdate) {
    const row = await this.row(id);
    if (!row?.botId) return;
    if (u.my_chat_member) {
      const { chat, new_chat_member: now } = u.my_chat_member;
      if (chat.type !== 'private' || !row.owner || String(chat.id) !== row.owner) return;
      if (now.status === 'kicked' || now.status === 'left') await this.blocked(row);
      else if (now.status === 'member') await this.unblock(row);
      return;
    }
    if (u.callback_query) return this.pressed(row, api, u.callback_query);
    const m = u.message;
    // Only one-to-one chats with a person; groups and other bots are not read.
    if (!m?.from || m.from.is_bot || m.chat.type !== 'private') return;
    const t = await this.services.settings.translator();
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(m.text?.trim() ?? '');
    if (start) return this.paired(row, api, m, start[1], t);
    // Nobody but the paired account is listened to, not even with a reply.
    if (!row.owner || String(m.from.id) !== row.owner) return;
    // A message from the person means they can reach the bot again.
    await this.unblock(row);
    const bot = await this.services.bots.get(row.botId).catch(() => null);
    if (!bot || bot.archivedAt) {
      await api.sendMessage(m.chat.id, t('channel.botArchived'));
      return;
    }
    // The conversation of the person who set the chat up.
    const thread = await this.services.threads.main(bot.id, row.userId);
    const text = (m.text || m.caption || '').trim();
    // Someone else's words the person passed on: never a command, and the bot reads them as data.
    const forward = forwardedFrom(m);
    const done = forward === null ? await chatCommand(this.services, thread.id, text, t) : null;
    if (done) {
      await api.sendMessage(m.chat.id, done);
      return;
    }
    const got = await this.received(api, m, thread.id, t);
    const files = got.names;
    if (!text && !files.length) return;
    const said = withMissingFiles(text, got, t);
    const replyTo = m.reply_to_message
      ? await this.ours(row.id, String(m.reply_to_message.message_id))
      : null;
    // Known before the bot starts, so "typing…" and its reply find their way back here.
    await this.patchSettings(row.id, { threadId: thread.id });
    // Noted before the turn can start, so a restart in the middle leaves a trace to settle.
    await holdRequest(this.ctx, row.id, thread.id, { chat: String(m.chat.id) });
    this.working.add(thread.id);
    let message;
    try {
      ({ message } = await this.services.inbox.send(thread.id, {
        text: said,
        files,
        clientId: `telegram:${m.chat.id}:${m.message_id}`,
        userId: row.userId,
        ...(replyTo && { replyTo }),
        props: {
          via: 'telegram',
          ...(forward !== null && { outside: 'forward', ...(forward && { forwardedFrom: forward }) }),
        },
      }));
    } catch (err) {
      this.working.delete(thread.id);
      await dropRequest(this.ctx, row.id, thread.id);
      throw err;
    }
    // Nothing started (a repeated message, say): no turn will end it, so it ends here.
    if (this.working.has(thread.id) && (await this.services.threads.state(thread.id)) === 'idle') {
      this.working.delete(thread.id);
      await dropRequest(this.ctx, row.id, thread.id);
    }
    await this.remember(row.id, String(m.message_id), message.id);
  }

  /** `/start <code>`: the account that sends the code shown in the app pairs with the bot. */
  private async paired(row: Row, api: TelegramApi, m: TgMessage, code: string | undefined, t: T) {
    const from = m.from!;
    const bot = await this.services.bots.get(row.botId!);
    if (row.owner && String(from.id) === row.owner && !code) {
      await api.sendMessage(m.chat.id, t('channel.alreadyPaired', { bot: bot.name }));
      return;
    }
    const valid =
      !!code &&
      !!row.pairCode &&
      !!row.pairUntil &&
      row.pairUntil.getTime() > Date.now() &&
      sameText(code, row.pairCode);
    if (!valid) {
      // Strangers who found the bot learn nothing; the person who already paired is told why.
      if (!row.owner || String(from.id) === row.owner) await api.sendMessage(m.chat.id, t('channel.badCode'));
      return;
    }
    const name =
      [from.first_name, from.last_name].filter(Boolean).join(' ') +
      (from.username ? ` (@${from.username})` : '');
    await this.ctx.db
      .update(schema.channels)
      .set({ owner: String(from.id), ownerName: name.trim(), pairCode: null, pairUntil: null })
      .where(eq(schema.channels.id, row.id));
    await api.sendMessage(m.chat.id, t('channel.paired', { bot: bot.name }));
    this.changed();
  }

  /** A button under a card: the person's answer to it, as if given in the app. */
  private async pressed(row: Row, api: TelegramApi, cb: TgCallback) {
    const t = await this.services.settings.translator();
    // Every press is answered once, or the button keeps spinning in Telegram.
    let answered = false;
    const answer = async (text: string) => {
      if (answered) return;
      answered = true;
      await api.call('answerCallbackQuery', { callback_query_id: cb.id, text }).catch(() => {});
    };
    try {
      await this.press(row, api, cb, t, answer);
    } catch (err) {
      console.warn('telegram press', err);
      await answer(t('channel.pressFailed'));
    }
  }

  private async press(
    row: Row,
    api: TelegramApi,
    cb: TgCallback,
    t: T,
    answer: (text: string) => Promise<void>,
  ) {
    const choice = cb.data ? parseChoice(cb.data) : null;
    if (!row.owner || String(cb.from.id) !== row.owner || !choice) return answer('');
    const card = await this.services.approvals.get(choice.approvalId).catch(() => null);
    // A card of another bot cannot be answered from this one's chat.
    if (!card || card.botId !== row.botId) return answer(t('channel.cardClosed'));
    let result: string;
    try {
      if (choice.kind === 'a') {
        const allow = choice.value !== 'n';
        // Answered as the person who linked the chat, so "always allow" is theirs to give.
        const after = await this.services.approvals.answer(
          card.id,
          { decision: allow ? 'allow' : 'deny', remember: choice.value === 'r' },
          row.userId,
        );
        // The first yes of a step that needs two people leaves it waiting for the second.
        result = t(
          !allow
            ? 'channel.denied'
            : after.status === 'pending'
              ? 'channel.waitingSecond'
              : 'channel.allowed',
        );
      } else {
        const option = card.kind === 'question' ? this.option(card, Number(choice.value)) : null;
        if (option === null) return answer(t('channel.cardClosed'));
        await this.services.approvals.answer(
          card.id,
          { decision: 'allow', answer: option, remember: false },
          row.userId,
        );
        result = option;
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return answer(t('channel.cardClosed'));
      if (err instanceof HttpError && err.status === 403) return answer(truncate(err.localized(t), 190));
      throw err;
    }
    await answer(truncate(result, 190));
    if (cb.message) {
      // The buttons go, and the card says how it was answered.
      await api
        .call('editMessageReplyMarkup', {
          chat_id: cb.message.chat.id,
          message_id: cb.message.message_id,
          reply_markup: { inline_keyboard: [] },
        })
        .catch(() => {});
      await api
        .sendMessage(cb.message.chat.id, `✓ ${result}`, {
          reply_parameters: { message_id: cb.message.message_id, allow_sending_without_reply: true },
        })
        .catch(() => {});
    }
  }

  /** The choice a button stands for, on a one-question card. */
  private option(card: Approval, i: number): string | null {
    const { items } = questionItems(card);
    return items.length === 1 ? (items[0]!.options[i] ?? null) : null;
  }

  /** The files of a message, downloaded into the conversation's staging folder. */
  private async received(
    api: TelegramApi,
    m: TgMessage,
    threadId: string,
    t: T,
  ): Promise<{ names: string[]; failed: string[]; tooLarge: string[] }> {
    const found: [string, TgFile][] = [];
    if (m.photo?.length) found.push(['photo', m.photo.at(-1)!]);
    for (const kind of ['document', 'audio', 'voice', 'video', 'video_note', 'animation'] as const) {
      const f = m[kind];
      if (f) found.push([kind, f]);
    }
    const names: string[] = [];
    const failed: string[] = [];
    const tooLarge: string[] = [];
    for (const [kind, f] of found) {
      const name = receivedName(kind, String(m.message_id), f.mime_type, f.file_name);
      if ((f.file_size ?? 0) > Math.min(DOWNLOAD_MAX, MAX_UPLOAD_BYTES)) {
        tooLarge.push(name);
        await api.sendMessage(m.chat.id, t('channel.fileTooLarge', { name }));
        continue;
      }
      try {
        const body = await api.download(f.file_id);
        const saved = await saveUpload(stagingDir(this.ctx.config.dataDir, threadId), name, body);
        names.push(saved.name);
      } catch (err) {
        console.warn('telegram file', (err as Error).message);
        failed.push(name);
        await api.sendMessage(m.chat.id, t('channel.fileFailed', { name }));
      }
    }
    return { names, failed, tooLarge };
  }

  // Writing to Telegram

  /** A new message here that the paired person should see in Telegram. */
  private async outgoing(m: Message) {
    if (this.stopped || !['assistant', 'approval', 'error'].includes(m.role)) return;
    const thread = await this.services.threads.row(m.threadId).catch(() => null);
    if (!thread) return;
    const row = await this.forBot(thread.botId);
    if (!row?.secret || !row.owner) return;
    const settings = row.settings as { threadId?: string; notices?: boolean };
    const here = settings.threadId === m.threadId && (await lastWroteVia(this.ctx, m.threadId, 'telegram'));
    const t = await this.services.settings.translator();
    const api = this.api(this.vault.open(row.secret));
    const chat = row.owner;
    // A routine's report is written in the routine's conversation and copied to the main one; the
    // copy is the one sent, so it arrives once.
    // So is something the bot kept track of coming up: it is said once, wherever the person talks from.
    const followUp = m.props.followUp === true;
    // A routine that runs in the person's own conversation writes there what would be its report.
    const report = m.props.routineReport === true || m.props.routineInMain === true || followUp;
    const headed = () =>
      followUp
        ? `🔔 ${m.text}`
        : `📋 **${String(m.props.routineName ?? '') || t('channel.routine')}**\n\n${m.text}`;
    // Turned off, routine reports stay in the app wherever the person talks from.
    if (report && settings.notices === false) return;
    if (!here) {
      // A routine's report from another conversation, when the person wants those here too.
      if (settings.notices === false || !report || m.role !== 'assistant' || !m.text.trim()) return;
      await this.deliver(row, api, chat, t, async () => {
        await this.text(api, chat, headed());
      });
      return;
    }
    await this.deliver(row, api, chat, t, async () => {
      if (m.role === 'approval') {
        const card = await this.services.approvals.get(String(m.props.approvalId)).catch(() => null);
        if (!card || card.status !== 'pending') return;
        const view = cardView(card, m.props, t, await this.services.settings.locale());
        const sent = await this.text(
          api,
          chat,
          view.text,
          view.buttons.length ? this.keyboard(view.buttons) : undefined,
        );
        if (sent) await this.remember(row.id, sent, m.id);
        return;
      }
      if (m.role === 'error') {
        await this.text(api, chat, `⚠️ ${m.text}`);
        return;
      }
      if (m.author !== `bot:${thread.botId}`) return;
      if (m.text.trim()) {
        const sent = await this.text(api, chat, report ? headed() : m.text);
        if (sent) await this.remember(row.id, sent, m.id);
      }
      for (const f of messageFiles(m)) {
        const path = join(this.ctx.config.dataDir, 'workspaces', f.path);
        const size = await stat(path).then(
          (s) => s.size,
          () => -1,
        );
        if (size < 0 || size > SEND_MAX) {
          await this.text(api, chat, t('channel.fileInApp', { name: f.name }));
          continue;
        }
        try {
          const sent = await api.sendDocument(chat, path);
          await this.remember(row.id, String(sent.message_id), m.id);
        } catch (err) {
          if (isBlocked(err)) throw err;
          console.warn('telegram send file', (err as Error).message);
          await this.text(api, chat, t('channel.fileInApp', { name: f.name }));
        }
      }
    });
  }

  /**
   * Runs the sends of one reply in the chat's order. When some of it could not be delivered, the
   * person is told once that the rest is in the app; a blocked bot is noted on the channel instead.
   */
  private async deliver(row: Row, api: TelegramApi, chat: string, t: T, job: () => Promise<void>) {
    let blocked = false;
    const ok = await this.sends.run(row.id, async () => {
      try {
        await job();
      } catch (err) {
        if (isBlocked(err)) {
          blocked = true;
          await this.blocked(row);
        }
        throw err;
      }
      await this.unblock(row);
    });
    if (ok || blocked) return;
    await this.sends.run(row.id, async () => {
      await api.sendMessage(chat, t('channel.notDelivered'));
    });
  }

  /** Sends a reply in as many messages as it takes; the id of the last one sent. */
  private async text(api: TelegramApi, chat: string, md: string, markup?: unknown): Promise<string | null> {
    const parts = telegramMessages(md);
    let last: string | null = null;
    for (const [i, p] of parts.entries()) {
      const extra = i === parts.length - 1 && markup ? { reply_markup: markup } : {};
      let sent;
      try {
        sent = await api.sendMessage(chat, p.html, { parse_mode: 'HTML', ...extra });
      } catch (err) {
        // Telegram refused the marks: the words as written still arrive.
        if (!(err instanceof TelegramError) || err.code !== 400) throw err;
        sent = await api.sendMessage(chat, p.plain, extra);
      }
      last = String(sent.message_id);
    }
    return last;
  }

  private keyboard(buttons: { label: string; data: string }[]) {
    // Two short choices side by side; longer ones each on a line of their own.
    const rows: { text: string; callback_data: string }[][] = [];
    for (const b of buttons) {
      const button = { text: b.label, callback_data: b.data };
      const last = rows.at(-1);
      if (last && last.length < 3 && buttons.every((x) => x.label.length <= 16)) last.push(button);
      else rows.push([button]);
    }
    return { inline_keyboard: rows };
  }

  /** "typing…" in Telegram while the bot works on what the person wrote there. */
  private async turnState(e: TurnEvent) {
    const row = await this.forBot(e.botId);
    const active =
      !!row?.secret &&
      !!row.owner &&
      (row.settings as { threadId?: string }).threadId === e.threadId &&
      (e.state === 'running' || e.state === 'queued') &&
      (await lastWroteVia(this.ctx, e.threadId, 'telegram'));
    const timer = this.typing.get(e.threadId);
    if (!active) {
      if (timer) clearInterval(timer);
      this.typing.delete(e.threadId);
      if (e.state === 'idle' && row) await this.finished(row, e.threadId);
      return;
    }
    if (timer || this.stopped) return;
    const api = this.api(this.vault.open(row.secret!));
    const send = () =>
      void api.call('sendChatAction', { chat_id: row.owner, action: 'typing' }).catch((err: unknown) => {
        // Typing to someone who blocked the bot only fails again every few seconds.
        if (!isBlocked(err)) return;
        clearInterval(this.typing.get(e.threadId));
        this.typing.delete(e.threadId);
        void this.blocked(row).catch(() => {});
      });
    send();
    const next = setInterval(send, 4500);
    next.unref?.();
    this.typing.set(e.threadId, next);
  }

  /**
   * The bot is done with a request from Telegram: the note of it goes, and when it ended well but
   * said nothing, the person hears that instead of only seeing "typing…" stop.
   */
  private async finished(row: Row, threadId: string) {
    if (!this.working.delete(threadId)) return;
    await dropRequest(this.ctx, row.id, threadId);
    if (this.stopped || !row.secret || !row.owner) return;
    if (!(await saidNothing(this.ctx, threadId))) return;
    const t = await this.services.settings.translator();
    const api = this.api(this.vault.open(row.secret));
    const chat = row.owner;
    await this.deliver(row, api, chat, t, async () => {
      await api.sendMessage(chat, t('channel.noAnswer'));
    });
  }

  /** A card or a failure in another conversation of the bot: a short note, so it is not missed. */
  private async notice(e: NoticeEvent) {
    if (this.stopped || e.kind === 'reply') return;
    const row = await this.forBot(e.botId);
    if (!row?.secret || !row.owner) return;
    const settings = row.settings as { threadId?: string; notices?: boolean };
    if (settings.notices === false) return;
    // A step waiting for this person's second yes: told to them alone, with no conversation named.
    if (e.to) {
      if (!e.to.includes(row.userId)) return;
      const t = await this.services.settings.translator();
      const api = this.api(this.vault.open(row.secret));
      await this.deliver(row, api, row.owner!, t, async () => {
        await this.text(api, row.owner!, t('channel.noticeSecond', { text: e.text }));
      });
      return;
    }
    // The conversation the person writes to from Telegram gets its cards as cards, or the person
    // is in the app with it; either way a note would only repeat it.
    if (settings.threadId === e.threadId) return;
    // Only of the person's own conversations, or the bot's own work they may change.
    if (!(await this.services.access.noticeAudience(e.threadId)).includes(row.userId)) return;
    const t = await this.services.settings.translator();
    const thread = await this.services.threads.row(e.threadId).catch(() => null);
    const title = thread?.title || t('channel.otherChat');
    const api = this.api(this.vault.open(row.secret));
    await this.deliver(row, api, row.owner!, t, async () => {
      await this.text(
        api,
        row.owner!,
        t(e.kind === 'error' ? 'channel.noticeError' : 'channel.noticeNeedsYou', { title, text: e.text }),
      );
    });
  }

  // Records

  private api(token: string) {
    return new TelegramApi(token, this.ctx.config.telegramApi, this.halting.signal);
  }

  private async rows(): Promise<Row[]> {
    return this.ctx.db.select().from(schema.channels).where(eq(schema.channels.kind, 'telegram'));
  }

  private async row(id: string): Promise<Row | null> {
    const [row] = await this.ctx.db.select().from(schema.channels).where(eq(schema.channels.id, id)).limit(1);
    return row ?? null;
  }

  private async forBot(botId: string): Promise<Row | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.channels)
      .where(and(eq(schema.channels.kind, 'telegram'), eq(schema.channels.botId, botId)))
      .limit(1);
    return row ?? null;
  }

  private async setError(id: string, error: string | null) {
    await this.ctx.db.update(schema.channels).set({ error }).where(eq(schema.channels.id, id));
    this.changed();
  }

  /**
   * Changes some of the channel's settings where they are stored, so a change made meanwhile (the
   * blocked note, the conversation in use) is never written over with an older copy.
   */
  private async patchSettings(id: string, patch: Record<string, unknown>) {
    await this.ctx.db
      .update(schema.channels)
      .set({ settings: sql`${schema.channels.settings} || ${JSON.stringify(patch)}::jsonb` })
      .where(eq(schema.channels.id, id));
  }

  /** The person blocked the bot in Telegram: the channel says so until they let it back in. */
  private async blocked(row: Row) {
    const t = await this.services.settings.translator();
    // Only when not noted yet, judged by the stored settings rather than a copy read earlier.
    const changed = await this.ctx.db
      .update(schema.channels)
      .set({
        error: t('channel.telegramBlocked'),
        settings: sql`${schema.channels.settings} || '{"blocked":true}'::jsonb`,
      })
      .where(and(eq(schema.channels.id, row.id), sql`(${schema.channels.settings}->>'blocked') is null`))
      .returning({ id: schema.channels.id });
    if (changed.length) this.changed();
  }

  /** Telegram reached the person again (a send went through, or they wrote or unblocked): the note goes. */
  private async unblock(row: Row) {
    const changed = await this.ctx.db
      .update(schema.channels)
      .set({ error: null, settings: sql`${schema.channels.settings} - 'blocked'` })
      .where(and(eq(schema.channels.id, row.id), sql`(${schema.channels.settings}->>'blocked') is not null`))
      .returning({ id: schema.channels.id });
    if (changed.length) this.changed();
  }

  private async remember(channelId: string, externalId: string, messageId: string) {
    await this.ctx.db
      .insert(schema.channelMessages)
      .values({ channelId, externalId, messageId })
      .onConflictDoNothing()
      .catch(() => {});
  }

  /** The message here that a Telegram message is, when it is one we know. */
  private async ours(channelId: string, externalId: string): Promise<string | null> {
    const [row] = await this.ctx.db
      .select({ messageId: schema.channelMessages.messageId })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.channelId, channelId),
          eq(schema.channelMessages.externalId, externalId),
        ),
      )
      .limit(1);
    return row?.messageId ?? null;
  }

  private changed() {
    this.ctx.bus.refresh({ scope: 'channels' });
  }
}
