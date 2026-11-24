import { stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { PhoneNumber, type Bot, type WhatsAppGroup } from '@leafbot/shared';
import type { ChatReads } from '../channels/whatsapp';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { realPath } from '../workspace';
import type { Define } from './index';

/**
 * WhatsApp for a bot working for the person who linked it, used in a conversation like any
 * connected app: the chats kept here (30 days) and drafts. Once the person lets the bots read
 * their chats, every chat is kept and seen; until then only the chats the bot's routines read, and
 * the first look asks the person on a card. A draft (a message, a Status post) goes to the person
 * on a card and nothing is sent until they answer "send"; the card is kept, so it works whenever
 * they answer, and the bot does not wait for it.
 */
/** Why a bot's WhatsApp message went on a card instead of going at once. */
type CardWhy = 'level' | 'setting' | 'woken' | 'outside' | 'file' | 'fresh' | 'limit';

export function whatsappTools(opts: {
  def: Define;
  services: Services;
  bot: Bot;
  /** Whom the turn works for: the person who linked WhatsApp. */
  person: string;
  /** The folders the bot's files may come from, and the one a relative name is read in. */
  roots: string[];
  cwd: string;
  /** Whether the bot may draft at all: a read-only bot only reads. */
  drafts: boolean;
  /** Whether a routine of the bot reads WhatsApp: it sees those chats without the bots reading all. */
  reader: boolean;
  /**
   * Whether the person asked for this work (their message, or a routine they saved): only then
   * may the bot reach chats beyond its routines', or ask to.
   */
  asked: () => Promise<boolean>;
  /**
   * The chat whose reply started this turn, if one did: the turn reaches it too. `typed` when
   * someone also wrote in it by hand.
   */
  woken: () => Promise<{ chat: string; typed: boolean }[]>;
  /**
   * Whether nobody is watching this turn (a routine, a mail, a chat started it). Its new draft to a
   * chat takes the place of its bot's older one there: a reminder run again finds what the earlier
   * one asked out of date. One the person asks for is a message of its own and keeps the others.
   */
  unattended: boolean;
  /** Whether the turn read outside text with nobody there to see what it does. */
  unwatched: () => boolean;
  /** Asks the person on a card whether the bots may read every chat. */
  askOpen: () => Promise<'yes' | 'no' | 'timeout'>;
  t: T;
}): AppTool[] {
  const { def, services: s, bot, person, roots, cwd, t } = opts;
  const wa = s.whatsapp;
  const every: ChatReads = { groups: new Set(), people: true, all: true };
  /** The chats the bot sees: all of them once the person allowed it, else its routines'; null for none. */
  const reach = async (): Promise<ChatReads | null> => {
    if ((await wa.chatsOpen()) && (await opts.asked())) return every;
    const own = opts.reader ? await s.routines.whatsappReadsOf(bot.id) : null;
    const woke = await opts.woken();
    if (!woke.length) return own;
    return {
      groups: own?.groups ?? new Set(),
      people: own?.people ?? false,
      chats: new Set(woke.map((w) => w.chat)),
    };
  };
  /**
   * The chats the bot sees, or the person is asked first; a string is what the tool answers when
   * they did not allow it. A bot whose routines read some chats asks only once it needs others.
   */
  const reachOrAsk = async (others = false): Promise<ChatReads | string> => {
    const r = await reach();
    if (r && (r.all || !others)) return r;
    if (!(await opts.asked())) return r ?? t('tool.whatsappNotAsked');
    const answer = await opts.askOpen();
    if (answer === 'timeout') return t('tool.questionTimedOut');
    if (answer !== 'yes') return r ?? t('tool.whatsappOpenSkipped');
    await wa.openChats(true);
    return every;
  };

  /**
   * Why a message to `chat` goes on a card, or null when it goes at once. The bot is told the
   * reason: without it, it guessed one and sent the person after a setting or a button that does
   * not exist.
   */
  const cardWhy = async (chat: string): Promise<CardWhy | null> => {
    if (bot.permissionMode !== 'auto' && bot.permissionMode !== 'review') return 'level';
    if (!(await wa.autoSendOn())) return 'setting';
    // A reply's turn answers only that chat, and not over someone who answered it by hand.
    const woke = await opts.woken();
    if (woke.length) return woke.some((w) => w.chat === chat && !w.typed) ? null : 'woken';
    // Outside text read on the way (a mail, a page, a chat) with nobody watching: on a card.
    if (opts.unwatched()) return 'outside';
    return (await opts.asked()) ? null : 'outside';
  };

  /**
   * Whether `ref` is a chat this bot wrote to with the person's approval a little while ago and
   * the person still lets the bots read: its answers come to the bot, which may then read the chat
   * and draft a reply (still a card) though no routine of the bot reads it and the run started
   * from the contact's own words.
   */
  const answering = async (ref: string): Promise<boolean> => {
    const phone = PhoneNumber.safeParse(ref.trim());
    const chat = phone.success ? `${phone.data}@s.whatsapp.net` : ref.trim();
    if ((await wa.replyOwner(chat))?.botId !== bot.id) return false;
    return (await wa.chatsOpen()) || (await s.routines.whatsappReads()).people;
  };

  /** A file the bot names, when it is inside one of its own folders. */
  const ownFile = async (name: string): Promise<string | null> => {
    const full = realPath(isAbsolute(name) ? name : resolve(cwd, name));
    if (!roots.some((r) => full.startsWith(realPath(r) + sep))) return null;
    const info = await stat(full).catch(() => null);
    return info?.isFile() ? full : null;
  };

  /** Puts a draft on a card in the bot's conversation with the person, and keeps it. */
  const draft = async (
    d: {
      kind: 'message' | 'status';
      chat: string | null;
      text: string;
      file: string | null;
      summary: string;
      approve: string;
      reject: string;
    },
    why?: CardWhy,
  ) => {
    const thread = await s.threads.main(bot.id, person);
    await wa.putOnCard({
      ...d,
      botId: bot.id,
      threadId: thread.id,
      replace: d.kind === 'message' && opts.unattended,
    });
    return why
      ? t('tool.whatsappDraftedWhy', { why: t(`tool.whatsappCardWhy.${why}`) })
      : t('tool.whatsappDrafted');
  };

  const reads: AppTool[] = [
    def(
      'whatsapp_chats',
      { limit: z.number().int().min(1).max(100).default(30) },
      async ({ limit }) => {
        const r = await reachOrAsk();
        if (typeof r === 'string') return r;
        const rows = await wa.chats(limit, r);
        if (!rows.length) return t(r.all ? 'tool.whatsappNoChatsYet' : 'tool.whatsappNoChats');
        return rows
          .map((r) => `- ${r.jid} · ${r.kind} · ${r.name || '-'} · ${r.lastAt.toISOString()}`)
          .join('\n');
      },
      'read',
    ),
    def(
      'whatsapp_history',
      { chat: z.string().min(3).max(120), limit: z.number().int().min(1).max(200).default(50) },
      async ({ chat, limit }) => {
        let r = (await answering(chat)) ? every : await reachOrAsk();
        if (typeof r === 'string') return r;
        // A chat the bot's routines do not read: the person may let it see every chat.
        if (!r.all && !(await wa.knownChat(chat, r)) && (await wa.knownChat(chat))) {
          r = await reachOrAsk(true);
          if (typeof r === 'string') return r;
        }
        return (
          (await wa.history(chat, limit, bot.id, r)) ??
          t(r.all ? 'tool.whatsappUnknownChatOpen' : 'tool.whatsappUnknownChat', { chat })
        );
      },
      'read',
    ),
  ];
  const tools: AppTool[] = [...reads];
  if (!opts.drafts) return tools;
  tools.push(
    def(
      'whatsapp_send',
      {
        chat: z.string().min(3).max(120),
        text: z.string().max(4000).default(''),
        file: z.string().max(1000).optional(),
      },
      async ({ chat: ref, text, file }) => {
        let r = (await answering(ref)) ? every : await reachOrAsk();
        if (typeof r === 'string') return r;
        let chat = ref.trim();
        let fresh = false;
        let known = await wa.knownChat(chat, r);
        // A number, or a chat the bot's routines do not read: the person may let it reach every chat.
        const phone = PhoneNumber.safeParse(chat);
        if (!known && !r.all && (phone.success || (await wa.knownChat(chat)))) {
          r = await reachOrAsk(true);
          if (typeof r === 'string') return r;
          known = await wa.knownChat(chat, r);
        }
        if (!known && r.all && phone.success) {
          const asChat = `${phone.data}@s.whatsapp.net`;
          known = await wa.knownChat(asChat, r);
          if (known) chat = asChat;
          else {
            // Someone who never wrote: only a number that is on WhatsApp. When that cannot be
            // checked now, the draft waits for the connection like any other.
            const found = await wa.numberChat(phone.data);
            if (found === null) return t('tool.whatsappNotOnWhatsApp', { phone: phone.data });
            chat = asChat;
            known = { name: '', kind: 'person' };
            fresh = true;
          }
        }
        if (!known) return t(r.all ? 'tool.whatsappUnknownChatOpen' : 'tool.whatsappUnknownChat', { chat });
        // Groups are only read.
        if (known.kind === 'group') return t('tool.whatsappNoGroupReply');
        const path = file ? await ownFile(file) : null;
        if (file && !path) return t('tool.whatsappBadFile', { file });
        if (!text.trim() && !path) return t('tool.whatsappEmpty');
        const number = chat.replace(/@.*$/, '');
        const to = known.name ? `${known.name} (${number})` : `+${number}`;
        // Without a card only when the person let the bots send so, the bot is at full access, no
        // file goes along, and it is the person's own work or the answer to the chat that woke it.
        // A first message to a number goes on a card: many at once is how a linked number gets barred.
        let why: CardWhy | null = path ? 'file' : fresh ? 'fresh' : await cardWhy(chat);
        if (!why) {
          const thread = await s.threads.main(bot.id, person);
          const sent = await wa.sendNow({ botId: bot.id, threadId: thread.id, chat, text: text.trim() });
          if (sent === 'sent') return t('tool.whatsappSentNow', { to });
          if (sent !== 'card') return t('whatsapp.draftFailed', { message: sent.failed });
          why = 'limit';
        }
        const summary = [
          t('whatsapp.draftCard', { to, text: text.trim() }),
          ...(path ? ['', t('whatsapp.draftCardFile', { name: basename(path) })] : []),
        ].join('\n');
        return draft(
          {
            kind: 'message',
            chat,
            text: text.trim(),
            file: path,
            summary,
            approve: t('whatsapp.send'),
            reject: t('whatsapp.dontSend'),
          },
          why,
        );
      },
      'internal',
    ),
  );
  // A Status post reads no chat: any of the person's bots (a social one) may draft one.
  tools.push(
    def(
      'whatsapp_status',
      { text: z.string().max(700).default(''), file: z.string().max(1000).optional() },
      async ({ text, file }) => {
        const path = file ? await ownFile(file) : null;
        if (file && !path) return t('tool.whatsappBadFile', { file });
        if (!text.trim() && !path) return t('tool.whatsappEmpty');
        const count = (await wa.statusAudience()).length;
        if (!count) return t('tool.whatsappNoAudience');
        const summary = [
          t('whatsapp.statusCard', { count, text: text.trim() }),
          ...(path ? ['', t('whatsapp.draftCardFile', { name: basename(path) })] : []),
        ].join('\n');
        return draft({
          kind: 'status',
          chat: null,
          text: text.trim(),
          file: path,
          summary,
          approve: t('whatsapp.post'),
          reject: t('whatsapp.dontPost'),
        });
      },
      'internal',
    ),
  );
  return tools;
}

/** The folders a bot's files for WhatsApp may come from: its own, and its project's. */
export function whatsappRoots(dataDir: string, bot: Bot): string[] {
  return [join(resolve(dataDir, 'workspaces'), 'bots', bot.id), ...(bot.projectDir ? [bot.projectDir] : [])];
}

/**
 * The group a bot names, by its address or its name: an exact name first (case and accents as
 * WhatsApp keeps them aside), else the one name that contains it. `many` lists the names when more
 * than one fits; null when none does.
 */
export function pickGroup(
  groups: WhatsAppGroup[],
  ref: string,
): { group: WhatsAppGroup } | { many: string[] } | null {
  const fold = (x: string) => x.normalize('NFKC').toLocaleLowerCase('tr').replace(/\s+/g, ' ').trim();
  const wanted = fold(ref);
  if (!wanted) return null;
  const byId = groups.find((g) => g.id === ref.trim());
  if (byId) return { group: byId };
  const exact = groups.filter((g) => fold(g.name) === wanted);
  const hits = exact.length ? exact : groups.filter((g) => fold(g.name).includes(wanted));
  if (hits.length === 1) return { group: hits[0]! };
  return hits.length ? { many: hits.map((g) => g.name) } : null;
}
