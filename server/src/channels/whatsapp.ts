import { randomBytes } from 'node:crypto';
import { copyFile, mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import {
  questionItems,
  type Bot,
  type Message,
  type NoticeEvent,
  type TurnEvent,
  type WhatsAppDoor,
  type WhatsAppGroup,
  type WhatsAppReplyMode,
  WhatsAppRoute,
  type WhatsAppSet,
  type WhatsAppStatus,
} from '@leafbot/shared';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  like,
  lt,
  lte,
  ne,
  notInArray,
  not,
  notExists,
  or,
  sql,
} from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { isSilentReply, SILENT_REPLY, type TurnOutcome } from '../engine/types';
import type { ServerKey, T } from '../i18n';
import type { Services } from '../services';
import type { VaultService } from '../services/vault';
import { safeFileName, saveUpload, stagingDir } from '../uploads';
import { HttpError, newId, truncate } from '../util';
import {
  cardView,
  chatCommand,
  dropRequest,
  heldRequests,
  holdRequest,
  lastWroteVia,
  messageFiles,
  mimeOf,
  queuedTurn,
  receivedName,
  saidNothing,
  SendQueue,
  withMissingFiles,
} from './common';
import { whatsappMessages } from './format';
import { privateText } from './private-text';
import { qrImage } from './qr';

type Row = typeof schema.channels.$inferSelect;
type Settings = {
  mode?: WhatsAppSet['mode'];
  phone?: string;
  notices?: boolean;
  /** Whether the bots may read every chat and draft messages in a conversation. */
  chats?: boolean;
  /** Whether a bot at full access may send a message without its card. */
  autoSend?: boolean;
  /** Chats given to bots: a person by number, a group by address. */
  routes?: WhatsAppRoute[];
  /** The bot that answers people with no chat given to a bot. */
  door?: WhatsAppDoor | null;
  /** Route suggestions already acted on, so a card's answer counts once. */
  routeAnswers?: string[];
  threadId?: string;
  /** When the newest message read here was written, in seconds: older ones handed again are not new. */
  seenAt?: number;
};

/**
 * How long a chat a routine reads stays quiet before its new messages go to the routine: one run
 * reads a whole exchange (a request and the photo after it) instead of one run for each line.
 */
const CHAT_QUIET_MS = 2 * 60_000;
/** The longest a batch waits in a chat that never goes quiet. */
const CHAT_MAX_WAIT_MS = 10 * 60_000;
/** Messages one batch carries; a run reading more would cost much and read little of it. */
const CHAT_BATCH_MAX = 200;
/** Text one batch carries at most, with the messages before it: a run must be able to read it all. */
const CHAT_BATCH_CHARS = 60_000;
/** Earlier messages of the chat a batch brings along, so the bot knows what was said before. */
const CHAT_CONTEXT = 20;
/** How much of one message's text is kept. */
const CHAT_TEXT_MAX = 4000;
/** How long the messages of chats routines read are kept. */
const CHAT_KEEP_MS = 30 * 24 * 3600_000;
/**
 * Messages bots may send to one chat in an hour without a card: two bots answering each other's
 * automatic replies stop here, and the next one waits on a card.
 */
const AUTO_SEND_MAX = 5;
/**
 * Turns a chat given to a bot, or the front door, may start in an hour: someone writing on and on
 * (or another bot answering every answer) stops costing more here; the rest is kept unread.
 */
const CONTACT_TURNS_MAX = 10;
/** Earlier lines of a group handed with a mention of the account, for what it refers to. */
const MENTION_CONTEXT = 10;

/** The chat address a route names: a person's number, or a group as it is. */
const routeChat = (chat: string) => (chat.includes('@') ? chat : `${chat}@s.whatsapp.net`);

/** Where a chat given to a bot, or the front door, keeps its conversation, in the chat's threads. */
type ContactRole = 'door' | 'route';
/** A conversation a bot keeps for a chat it answers. */
type Contact = { chat: string; kind: 'person' | 'group'; role: ContactRole; botId: string };
/** How many conversations' answer to `contactOf` are kept in memory. */
const CONTACTS_KEPT = 5000;
/** How long a front-door card's answer is looked for. */
const ROUTE_ANSWER_MS = 30 * 24 * 3600_000;
const contactKey = (role: ContactRole, botId: string) => `${role}:${botId}`;

/**
 * Whether a group message names the linked account (an @mention) or answers one of its messages:
 * only that starts the bot a group is given to.
 */
export function mentionsAccount(m: WaMessage, ids: string[]): boolean {
  const ours = new Set(ids.filter(Boolean).map((id) => bareJid(id)));
  if (!ours.size) return false;
  let msg = (m.message ?? {}) as Record<string, Record<string, unknown> | undefined>;
  for (const wrap of [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'documentWithCaptionMessage',
  ]) {
    const inner = msg[wrap]?.message as typeof msg | undefined;
    if (inner) msg = inner;
  }
  return Object.values(msg).some((part) => {
    const info = part?.contextInfo as { mentionedJid?: unknown; participant?: unknown } | undefined;
    if (!info) return false;
    const named = Array.isArray(info.mentionedJid) ? info.mentionedJid : [];
    if (named.some((j) => typeof j === 'string' && ours.has(bareJid(j)))) return true;
    return typeof info.participant === 'string' && ours.has(bareJid(info.participant));
  });
}
/** How often what is older than that is dropped. */
const PRUNE_EVERY_MS = 6 * 3600_000;
/** Where a Status post goes. */
const STATUS_JID = 'status@broadcast';
/** How long the list of groups and their names is taken as current. */
const GROUP_NAMES_FRESH_MS = 10 * 60_000;

/** How old a message WhatsApp held while this device was away may be and still be answered. */
const HELD_MAX_S = 24 * 3600;
/**
 * How long after a bot's approved message the contact's answers still reach that bot. People
 * answer a business message within a day or two; past that the answer is more likely a new
 * subject, which the person or a routine handles.
 */
const REPLY_WINDOW_MS = 3 * 24 * 3600_000;

/** The name to show for a chat: the one the person saved for the contact, else the one it gave itself. */
const shownName = (r: { name: string; savedName: string }) => r.savedName || r.name;

/** When a WhatsApp message was written, in seconds since the epoch; 0 when it does not say. */
export const stampOf = (m: WaMessage): number => {
  const v = m.messageTimestamp;
  const n = typeof v === 'number' ? v : v && typeof v === 'object' ? v.toNumber() : 0;
  return Number.isFinite(n) ? n : 0;
};

/** How long a QR setup may wait to be scanned before it is given up on. */
const LINK_MS = 5 * 60_000;
/** WhatsApp takes files up to about this size. */
const SEND_MAX = 64 * 1024 * 1024;
const RECEIVE_MAX = 64 * 1024 * 1024;
/** How long a reply waits for the connection to come back before it is given up on. */
const OFFLINE_WAIT_MS = 5 * 60_000;
/** Failed connection attempts in a row after which the person is told it keeps failing. */
const FAILING_AFTER = 12;
/** The least time between two posts to one chat; a burst from a dedicated number looks like spam. */
const PACE_MS = 1000;
/** How long the current WhatsApp Web version is looked up before the last known one is used. */
const VERSION_WAIT_MS = 5000;
const VERSION_FRESH_MS = 3600_000;
/** How many sent messages are kept for WhatsApp's resend requests, and for how long. */
const SENT_KEPT = 500;
const SENT_KEEP_MS = 24 * 3600_000;
/** Message ids already handled, so a message WhatsApp hands twice is answered once. */
const SEEN_KEPT = 1000;
/** Requests in the self chat that mean two bots are answering each other, and how long to pause. */
const LOOP_LIMITS = [
  { count: 30, ms: 10 * 60_000 },
  { count: 90, ms: 3600_000 },
];
const LOOP_PAUSE_MS = 10 * 60_000;
/** Keys of a device being linked live under this prefix until the link is saved. */
const LINK_NS = 'link/';
/** Keys that belong to no device: they survive a new link and an unlink. */
const META_NS = 'meta:';

/** A WhatsApp Web version as Baileys takes it. */
export type WaVersion = [number, number, number];

/** What the library is told when a socket is made. */
export interface WaConnectOptions {
  version?: WaVersion;
  /** The content of a message this device sent, for WhatsApp's resend requests. */
  getMessage(key: { id?: string | null }): Promise<Record<string, unknown> | undefined>;
  /**
   * Chats whose messages are dropped before they are read: every group a routine does not follow,
   * unless the bots may read every chat.
   */
  ignore(jid: string): boolean;
}

/** The parts of a WhatsApp message this server reads. */
export interface WaMessage {
  key: {
    remoteJid?: string | null;
    remoteJidAlt?: string | null;
    fromMe?: boolean | null;
    id?: string | null;
    participant?: string | null;
    /** In a group, the writer's phone address when `participant` is a lid. */
    participantAlt?: string | null;
  };
  message?: Record<string, unknown> | null;
  /** Set on a stand-in with no message of its own, such as one WhatsApp could not decrypt. */
  messageStubType?: number | null;
  messageTimestamp?: number | { toNumber(): number } | null;
  /** The name the writer gave themselves on WhatsApp. */
  pushName?: string | null;
}

/** A contact WhatsApp tells of: `name` is the one saved in the person's phone book, `notify` the one it chose. */
export interface WaContact {
  id: string;
  lid?: string;
  phoneNumber?: string;
  name?: string;
  notify?: string;
}

/** The parts of a Baileys socket this server uses; tests hand in their own. */
export interface WaSocket {
  ev: {
    on(
      event: 'connection.update',
      fn: (u: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } }) => void,
    ): void;
    on(event: 'creds.update', fn: (u: Record<string, unknown>) => void): void;
    on(event: 'messages.upsert', fn: (u: { type: string; messages: WaMessage[] }) => void): void;
    on(event: 'contacts.upsert', fn: (u: WaContact[]) => void): void;
    on(event: 'contacts.update', fn: (u: Partial<WaContact>[]) => void): void;
    on(event: 'messaging-history.set', fn: (u: { contacts?: WaContact[] }) => void): void;
  };
  user?: { id: string; lid?: string; name?: string } | null;
  sendMessage(
    jid: string,
    content: Record<string, unknown>,
    options?: { messageId?: string; statusJidList?: string[]; broadcast?: boolean },
  ): Promise<{ key?: { id?: string | null }; message?: Record<string, unknown> | null } | undefined>;
  /** Which numbers are on WhatsApp, checked before a message to someone new is drafted. */
  onWhatsApp?: (...jids: string[]) => Promise<{ jid: string; exists: boolean }[] | undefined>;
  /** The groups the account is in, by address; only read for the list a routine picks from. */
  groupFetchAllParticipating?: () => Promise<Record<string, { id: string; subject?: string | null }>>;
  /** Asks the phone to upload media again, for files whose link on WhatsApp's servers expired. */
  updateMediaMessage?: (m: WaMessage) => Promise<WaMessage>;
  sendPresenceUpdate(type: 'composing' | 'paused', jid: string): Promise<void>;
  logout(): Promise<void>;
  end(err?: Error): void;
  signalRepository?: { lidMapping?: { getPNForLID(lid: string): Promise<string | null | undefined> } };
}

/** What the server needs from Baileys; loaded only when WhatsApp is used. */
export interface WaLibrary {
  connect(auth: unknown, options: WaConnectOptions): WaSocket;
  /** The WhatsApp Web version now in use, or null when it cannot be found out. */
  latestVersion?(signal: AbortSignal): Promise<WaVersion | null>;
  initAuthCreds(): Record<string, unknown>;
  replacer: (k: string, v: unknown) => unknown;
  reviver: (k: string, v: unknown) => unknown;
  /** Turns a stored app-state key back into what Baileys expects. */
  appStateKey(value: unknown): unknown;
  download(m: WaMessage, socket: WaSocket): Promise<Readable>;
  /** `DisconnectReason` codes that end the connection for good or need their own words. */
  codes?: {
    forbidden: number;
    connectionReplaced: number;
    multideviceMismatch: number;
    restartRequired: number;
  };
  loggedOut: number;
}

async function baileys(): Promise<WaLibrary> {
  const wa = await import('@whiskeysockets/baileys');
  const makeWASocket = wa.default;
  // Baileys logs a great deal through pino; none of it is wanted here.
  const quiet = {
    level: 'silent',
    child: () => quiet,
    trace: () => {},
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    fatal: () => {},
  };
  return {
    connect: (auth, options) =>
      makeWASocket({
        auth: auth as never,
        ...(options.version && { version: options.version }),
        logger: quiet as never,
        browser: ['Leaf Bot', 'Chrome', '1.0'],
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        markOnlineOnConnect: false,
        getMessage: async (key) => options.getMessage(key) as never,
        // Status updates and channels are never read, nor a group no routine follows unless the
        // bots may read every chat.
        shouldIgnoreJid: (jid: string) =>
          jid === 'status@broadcast' ||
          jid.endsWith('@newsletter') ||
          jid.endsWith('@broadcast') ||
          options.ignore(jid),
      }) as unknown as WaSocket,
    initAuthCreds: () => wa.initAuthCreds() as unknown as Record<string, unknown>,
    replacer: wa.BufferJSON.replacer,
    reviver: wa.BufferJSON.reviver,
    appStateKey: (v) => wa.proto.Message.AppStateSyncKeyData.fromObject(v as never),
    latestVersion: async (signal) => {
      const found = await wa.fetchLatestWaWebVersion({ signal });
      return found.error || !found.isLatest ? null : (found.version as WaVersion);
    },
    // Old media whose link expired is asked of the phone again.
    download: (m, socket) =>
      wa.downloadMediaMessage(
        m as never,
        'stream',
        {},
        { reuploadRequest: socket.updateMediaMessage as never, logger: quiet as never },
      ) as Promise<Readable>,
    codes: {
      forbidden: wa.DisconnectReason.forbidden,
      connectionReplaced: wa.DisconnectReason.connectionReplaced,
      multideviceMismatch: wa.DisconnectReason.multideviceMismatch,
      restartRequired: wa.DisconnectReason.restartRequired,
    },
    loggedOut: wa.DisconnectReason.loggedOut,
  };
}

/** `905321234567:12@s.whatsapp.net` → `905321234567`; null for anything that is not a number's address. */
const numberOf = (jid: string | null | undefined) =>
  /^(\d+)(?::\d+)?@s\.whatsapp\.net$/.exec(jid ?? '')?.[1] ?? null;
const bareJid = (jid: string) => jid.replace(/:\d+@/, '@');

type WaMedia = { kind: string; mime?: string; name?: string; size?: number };

/**
 * The message a WhatsApp message answers: its id, its text and file, whether it was forwarded, and
 * the message itself.
 */
type WaQuoted = {
  id: string | null;
  text: string;
  media: WaMedia | null;
  forwarded: boolean;
  message: Record<string, unknown>;
};

/** The values of `MessageAssociation.AssociationType` that mark the HD copy of a photo or video. */
const HD_ASSOCIATIONS = new Set([5, 10, 19]);

/**
 * Whether a message is only the HD copy WhatsApp sends after a photo or video it has already
 * delivered: it carries no text of its own and answers nothing, so it is never a second message.
 */
export function isAssociatedChild(m: WaMessage): boolean {
  const message = (m.message ?? {}) as Record<string, unknown>;
  if (message.associatedChildMessage) return true;
  const info = message.messageContextInfo as
    { messageAssociation?: { associationType?: number | null; parentMessageKey?: unknown } } | undefined;
  const link = info?.messageAssociation;
  return !!link?.parentMessageKey && HD_ASSOCIATIONS.has(Number(link.associationType));
}

/** A saved key exists but cannot be opened, as when the server's secret key is not the one it was sealed with. */
class UnreadableKey extends Error {
  constructor() {
    super('A saved WhatsApp key cannot be read');
  }
}

/** Baileys' `proto.WebMessageInfo.StubType.CIPHERTEXT`: a message that could not be decrypted yet. */
const CIPHERTEXT_STUB = 2;

/** One contact card a message carries: the name it shows and the phone numbers in its vCard. */
export interface WaCard {
  name: string;
  numbers: string[];
}

/** The most contact cards and numbers per card that are read; a card can carry far more than a person needs. */
const CARDS_MAX = 10;
const CARD_NUMBERS_MAX = 5;

/** One line of a vCard value: no control characters, no runs of spaces, and not long enough to be a payload. */
function cardField(v: string): string {
  return v
    .replace(/\\([nN,;\\])/g, (_, c: string) => (c === 'n' || c === 'N' ? ' ' : c))
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** The name and the phone numbers of a vCard; `shown` is the name WhatsApp shows when the card has none. */
export function cardOf(vcard: unknown, shown: unknown): WaCard | null {
  const raw = typeof vcard === 'string' ? vcard : '';
  // A folded line continues on the next one, which starts with a space or a tab.
  const lines = raw.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  let name = '';
  const numbers: string[] = [];
  for (const line of lines) {
    const at = line.indexOf(':');
    if (at < 0) continue;
    // `item1.TEL;type=CELL` and `TEL;waid=...` are the same property; only the name part matters.
    const prop = line.slice(0, at).split(';')[0]!.split('.').pop()!.toUpperCase();
    const value = line.slice(at + 1);
    if (prop === 'FN' && !name) name = cardField(value);
    else if (prop === 'TEL') {
      const n = cardField(value);
      if (n && !numbers.includes(n) && numbers.length < CARD_NUMBERS_MAX) numbers.push(n);
    }
  }
  name ||= cardField(typeof shown === 'string' ? shown : '');
  return name || numbers.length ? { name, numbers } : null;
}

/**
 * The text and the kind of file a WhatsApp message carries, whether it was forwarded, and the
 * message it answers when the person replied to one. A contact card has no text: its names and
 * numbers come back in `cards`, to be worded in the language of the server.
 */
export function contentOf(m: WaMessage): {
  text: string;
  media: WaMedia | null;
  forwarded: boolean;
  quoted: WaQuoted | null;
  cards: WaCard[];
} {
  let msg = (m.message ?? {}) as Record<string, Record<string, unknown> | undefined>;
  // Disappearing and view-once messages wrap the real one.
  for (const wrap of [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'documentWithCaptionMessage',
  ]) {
    const inner = msg[wrap]?.message as typeof msg | undefined;
    if (inner) msg = inner;
  }
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  const size = (v: unknown) =>
    typeof v === 'number' ? v : typeof v === 'object' && v ? Number(v) : undefined;
  const text = str(msg.conversation) || str(msg.extendedTextMessage?.text);
  // A reply names the message it answers and carries a copy of it.
  let quoted: WaQuoted | null = null;
  for (const part of Object.values(msg)) {
    const info = part?.contextInfo as { stanzaId?: unknown; quotedMessage?: unknown } | undefined;
    if (!info?.quotedMessage || typeof info.quotedMessage !== 'object') continue;
    const message = info.quotedMessage as Record<string, unknown>;
    const inner = contentOf({ key: {}, message });
    quoted = {
      id: typeof info.stanzaId === 'string' ? info.stanzaId : null,
      text: inner.text,
      media: inner.media,
      forwarded: inner.forwarded,
      message,
    };
    break;
  }
  // A forward is someone else's words, whichever account passed it on.
  const forwarded = Object.values(msg).some((part) => {
    const info = part?.contextInfo as { isForwarded?: unknown; forwardingScore?: unknown } | undefined;
    return (
      info?.isForwarded === true || (typeof info?.forwardingScore === 'number' && info.forwardingScore > 0)
    );
  });
  for (const [field, kind] of [
    ['imageMessage', 'photo'],
    ['documentMessage', 'document'],
    ['audioMessage', 'audio'],
    ['videoMessage', 'video'],
  ] as const) {
    const f = msg[field];
    if (!f) continue;
    const voice = field === 'audioMessage' && f.ptt === true;
    return {
      text: text || str(f.caption),
      media: {
        kind: voice ? 'voice' : kind,
        mime: str(f.mimetype) || undefined,
        name: str(f.fileName) || undefined,
        size: size(f.fileLength),
      },
      forwarded,
      quoted,
      cards: [],
    };
  }
  const cards: WaCard[] = [];
  const single = msg.contactMessage;
  const many = msg.contactsArrayMessage?.contacts;
  for (const c of single ? [single] : Array.isArray(many) ? many.slice(0, CARDS_MAX) : []) {
    const card = cardOf((c as Record<string, unknown>).vcard, (c as Record<string, unknown>).displayName);
    if (card) cards.push(card);
  }
  return { text, media: null, forwarded, quoted, cards };
}

/** A contact card as the bot reads it: who it is and the numbers on it. */
export function cardsText(cards: WaCard[], t: T): string {
  if (!cards.length) return '';
  const list = cards.map((c) => [c.name, ...c.numbers].filter(Boolean).join(', ')).join('; ');
  return t('whatsapp.contactCard', { cards: list });
}

/**
 * WhatsApp through a linked device, the way WhatsApp Web links: the person scans a QR code with
 * the account that will carry the messages. With their own number they write to the bots in
 * "Message yourself"; with a separate number they write to it from their own. Messages go to one
 * bot at a time, and `/bot <name>` changes which. Nobody else's chats are read unless a routine of
 * the person who linked WhatsApp reads them (people's chats with the account when one has that
 * switch on, and the groups one follows), or the person let the bots read every chat. Their
 * messages are kept 30 days; only the chats routines read start a routine, as outside text. A
 * message goes only once the person approves its draft, and nothing is ever written to a group.
 */
export class WhatsAppChannel {
  /** How Baileys is reached; tests replace it. */
  library: () => Promise<WaLibrary> = baileys;
  private lib: WaLibrary | null = null;
  private socket: WaSocket | null = null;
  private state: WhatsAppStatus['state'] = 'off';
  private qr: string | null = null;
  private linkTimer: NodeJS.Timeout | null = null;
  private retry: NodeJS.Timeout | null = null;
  private attempt = 0;
  /** Messages this server sent, so its own words in "Message yourself" are not read as the person's. */
  private sentIds = new Set<string>();
  /** The last message sent here, and the one that ended the last card's choices. */
  private lastSent: string | null = null;
  private cardLast: string | null = null;
  private typing = new Map<string, NodeJS.Timeout>();
  private sends = new SendQueue();
  private unsubs: (() => void)[] = [];
  private stopped = false;
  /** Prefix of the keys in use: the link prefix while a new device is being linked, else none. */
  private ns = '';
  /** Whether a QR code was shown for the link in progress; a close before that is a dead connection. */
  private qrShown = false;
  /** Sends and the connection: sends wait here for the connection to come back. */
  private waiters = new Set<(ok: boolean) => void>();
  private gaveUp = false;
  /** A reply could not be delivered; the person is told once the connection allows. */
  private undelivered = false;
  /** Requests from WhatsApp being worked on, to end each once, and the ones to settle at the first connect. */
  private working = new Set<string>();
  private settlePending = false;
  /** Incoming messages are handled one at a time, in the order they came. */
  private reading: Promise<void> = Promise.resolve();
  private seen = new Set<string>();
  /** Writes of keys and creds go one after another; the newest creds win. */
  private writes: Promise<unknown> = Promise.resolve();
  private credsChain: Promise<void> = Promise.resolve();
  private credsDirty = false;
  /** Whether an unreadable signal key was already logged, so a whole store of them logs once. */
  private unreadableLogged = false;
  private credsNow: (() => string) | null = null;
  /** What was sent lately, for WhatsApp's resend requests; kept in memory only. */
  private sentBodies = new Map<string, { message: Record<string, unknown>; at: number }>();
  private lastPost = new Map<string, number>();
  /** The least time between two posts to a chat; tests turn it off. */
  paceMs = PACE_MS;
  /** How long a QR code may wait to be scanned; tests shorten it. */
  linkMs = LINK_MS;
  private version: { value: WaVersion; at: number } | null = null;
  private requestTimes: number[] = [];
  /** Groups an enabled routine follows; every other group is dropped unread unless the bots read every chat. */
  private followed = new Set<string>();
  /** Whether a routine reads what people write to the account in chats of their own. */
  private people = false;
  /** Whether the bots may read every chat: then every chat is kept, though only routines' chats start runs. */
  private allChats = false;
  private groupNames = new Map<string, string>();
  private groupNamesAt = 0;
  /** Chats given to bots, by chat address. */
  private routes = new Map<string, WhatsAppRoute>();
  /** The front door, when one is set. */
  private door: WhatsAppDoor | null = null;
  /** Whether the account is the person's own number, not one of the bots' own. */
  private ownNumber = false;
  /** Conversations known to be, or not to be, a chat's own (`contactOf`). */
  private contacts = new Map<string, Contact | null>();
  /** Front-door answers are settled one refresh at a time. */
  private routing: Promise<void> = Promise.resolve();
  /** Messages of chats given to a bot, or at the front door, waiting for the chat to go quiet. */
  private contactWaits = new Map<
    string,
    {
      kind: 'person' | 'group';
      lines: string[];
      seqs: number[];
      firstSeq: number;
      firstId: string;
      startedAt: number;
      timer: NodeJS.Timeout | null;
    }
  >();
  /** Names the person saved for contacts, by chat address, for chats kept later. */
  private savedNames = new Map<string, string>();
  /** Answers of someone a bot wrote to, waiting for the chat to go quiet before they reach that bot. */
  private replies = new Map<
    string,
    {
      botId: string;
      threadId: string;
      lines: string[];
      /** The stored messages it holds, marked `awaiting` until they are handed over. */
      seqs: number[];
      firstId: string;
      startedAt: number;
      timer: NodeJS.Timeout | null;
    }
  >();
  /** Chats whose new messages wait for the chat to go quiet. */
  private waits = new Map<string, { startedAt: number; timer: NodeJS.Timeout | null }>();
  private pruneTimer: NodeJS.Timeout | null = null;
  /** How long a chat stays quiet before its batch goes out; tests shorten it. */
  chatQuietMs = CHAT_QUIET_MS;
  chatMaxWaitMs = CHAT_MAX_WAIT_MS;
  private pausedUntil = 0;
  /** When the person was last told a request waits out the pause. */
  private heldNoteAt = 0;

  constructor(
    private ctx: Ctx,
    private services: Services,
    private vault: VaultService,
  ) {}

  async start() {
    this.unsubs.push(this.services.threads.onMessage((m) => this.outgoing(m)));
    this.unsubs.push(this.ctx.bus.on('turn', (e) => void this.turnState(e).catch(() => {})));
    this.unsubs.push(this.ctx.bus.on('notice', (e) => void this.notice(e).catch(() => {})));
    this.unsubs.push(
      this.ctx.bus.on('refresh', (e) => {
        if (e.scope === 'routines') void this.loadFollowed().catch(() => {});
        if (e.scope === 'approvals') {
          void this.settleDrafts().catch((err: unknown) => console.warn('whatsapp draft', err));
          this.routing = this.routing
            .then(() => this.settleRoutes())
            .catch((err: unknown) => console.warn('whatsapp route', err));
        }
      }),
    );
    await this.loadFollowed();
    await this.prune().catch((err: unknown) => console.warn('whatsapp prune', err));
    this.pruneTimer = setInterval(
      () => void this.prune().catch((err: unknown) => console.warn('whatsapp prune', err)),
      PRUNE_EVERY_MS,
    );
    this.pruneTimer.unref();
    await this.resumeChats();
    await this.resumeAwaiting().catch((err: unknown) => console.warn('whatsapp resume', err));
    // A link that was never finished leaves its keys behind; the device in use is untouched.
    await this.dropNs();
    const row = await this.row();
    let creds: string | null = null;
    try {
      creds = await this.key('creds');
    } catch (err) {
      if (!(err instanceof UnreadableKey)) throw err;
      if (row) await this.fail('keysUnreadable');
    }
    if (row && creds && (JSON.parse(creds) as { registered?: boolean; me?: unknown }).me) {
      // A queued turn survives the restart and still runs, so its request stays; the others are
      // settled once the connection is open and the person can be written to.
      for (const h of await heldRequests(this.ctx, row.id)) {
        if (await queuedTurn(this.ctx, h.threadId)) this.working.add(h.threadId);
      }
      this.settlePending = true;
      await this.open().catch((err: unknown) => this.fail(errorText(err)));
    }
  }

  /** Requests that were being worked on when the server stopped are over: the person is told so they write again. */
  private async settleHeld(row: Row) {
    const t = await this.services.settings.translator();
    for (const h of await heldRequests(this.ctx, row.id)) {
      if (this.working.has(h.threadId)) continue;
      await dropRequest(this.ctx, row.id, h.threadId);
      const jid = (h.place as { jid?: string }).jid;
      if (jid) await this.say(jid, t('channel.cutShort'));
    }
  }

  async stop() {
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.clearTimers();
    for (const timer of this.typing.values()) clearInterval(timer);
    this.typing.clear();
    // Sends waiting for the connection stop waiting.
    this.settle();
    await this.sends.drain();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    // What waits for a quiet chat is in the store and goes out after the next start.
    for (const wait of this.waits.values()) if (wait.timer) clearTimeout(wait.timer);
    this.waits.clear();
    for (const r of this.replies.values()) if (r.timer) clearTimeout(r.timer);
    this.replies.clear();
    for (const r of this.contactWaits.values()) if (r.timer) clearTimeout(r.timer);
    this.contactWaits.clear();
    await this.reading;
    await this.credsChain;
    this.socket?.end();
    this.socket = null;
  }

  // The app's side

  async status(): Promise<WhatsAppStatus> {
    const row = await this.row();
    const s = (row?.settings ?? {}) as Settings;
    return {
      state: row ? this.state : 'off',
      mode: s.mode ?? null,
      phone: s.phone ?? null,
      botId: row?.botId ?? null,
      notices: s.notices !== false,
      chats: s.chats === true,
      autoSend: s.autoSend === true,
      // A chat or a door whose bot is gone, or a chat kept in a shape a save would refuse, is not
      // shown: the form sends back what it shows, and these would make every save fail.
      ...(await this.contactsShown(s)),
      linked: (row?.account as { number?: string } | undefined)?.number ?? null,
      qr: this.state === 'linking' && this.qr ? await qrImage(this.qr) : null,
      error: row?.error ?? null,
    };
  }

  /** Sets the chat up for `userId`: what comes in through it is theirs. */
  async configure(input: WhatsAppSet, userId: string): Promise<WhatsAppStatus> {
    if (input.botId) await this.services.bots.get(input.botId);
    for (const r of input.routes ?? []) await this.services.bots.get(r.botId);
    if (input.door) await this.services.bots.get(input.door.botId);
    const row = await this.row();
    const now = (row?.settings ?? {}) as Settings;
    // The bot's own number as the person's would cut the link the moment it opens: said here.
    const linked = (row?.account as { number?: string } | undefined)?.number;
    if (input.mode === 'separate' && linked && linked === input.phone)
      throw new HttpError(400, 'error.whatsappPhoneIsBot', { number: linked });
    // One bot per chat: the last one named wins.
    const routes = input.routes && [...new Map(input.routes.map((r) => [r.chat, r])).values()];
    const settings: Settings = {
      ...now,
      mode: input.mode,
      phone: input.phone,
      notices: input.notices,
      chats: input.chats ?? now.chats === true,
      autoSend: input.autoSend ?? now.autoSend === true,
      routes: routes ?? now.routes ?? [],
      door: input.door === undefined ? (now.door ?? null) : input.door,
    };
    if (row) {
      await this.ctx.db
        .update(schema.channels)
        .set({ settings, botId: input.botId, userId })
        .where(eq(schema.channels.id, row.id));
    } else {
      await this.ctx.db
        .insert(schema.channels)
        .values({ id: newId(), kind: 'whatsapp', botId: input.botId, settings, userId });
    }
    this.allChats = settings.chats === true;
    this.loadRoutes(settings);
    this.changed();
    return this.status();
  }

  /**
   * Starts over with a new device: the QR code to scan comes in the status. The new device's keys
   * are kept apart until the scan is saved, so a code that is never scanned costs nothing: the
   * device that works now is brought back.
   */
  async link(): Promise<WhatsAppStatus> {
    const row = await this.row();
    if (!row || !(row.settings as Settings).phone) throw new HttpError(409, 'error.whatsappNotSetUp');
    await this.close();
    await this.flushCreds();
    await this.dropNs();
    this.ns = LINK_NS;
    this.qrShown = false;
    await this.ctx.db.update(schema.channels).set({ error: null }).where(eq(schema.channels.id, row.id));
    this.state = 'linking';
    this.qr = null;
    this.attempt = 0;
    try {
      await this.open();
    } catch (err) {
      await this.dropNs();
      this.ns = '';
      this.state = 'error';
      this.settle();
      throw new HttpError(502, 'error.whatsappUnavailable', { message: errorText(err) });
    }
    this.linkTimer = setTimeout(() => {
      if (this.state === 'linking') void this.abandonLink('expired', true).catch(() => {});
    }, this.linkMs);
    this.linkTimer.unref?.();
    this.changed();
    return this.status();
  }

  /**
   * A link that will not finish (the code expired, WhatsApp cannot be reached): its keys go and the
   * device that worked before is connected again; without one, the error is shown.
   */
  private async abandonLink(error: string, reconnect: boolean) {
    await this.close();
    await this.flushCreds();
    await this.dropNs();
    this.ns = '';
    this.qr = null;
    this.qrShown = false;
    const old = await this.key('creds').catch(() => null);
    if (reconnect && old && (JSON.parse(old) as { me?: unknown }).me && !this.stopped) {
      this.state = 'connecting';
      this.changed();
      await this.open().catch((err: unknown) => this.fail(errorText(err)));
      return;
    }
    await this.fail(error);
  }

  /** Unlinks the device (WhatsApp shows it gone from Linked Devices) and forgets its keys. */
  async disconnect(): Promise<WhatsAppStatus> {
    const socket = this.socket;
    this.socket = null;
    this.clearTimers();
    if (socket) {
      await socket.logout().catch(() => {});
      socket.end();
    }
    await this.flushCreds();
    await this.wipeKeys();
    await this.forgetSavedNames();
    this.ns = '';
    await this.ctx.db.delete(schema.channels).where(eq(schema.channels.kind, 'whatsapp'));
    this.state = 'off';
    this.qr = null;
    this.settle();
    this.changed();
    return this.status();
  }

  // The connection

  /**
   * The WhatsApp Web version to connect with: the current one when it can be found out in a few
   * seconds, else the last good one, else the library's own. WhatsApp turns old versions away.
   */
  private async webVersion(lib: WaLibrary): Promise<WaVersion | undefined> {
    if (!lib.latestVersion) return undefined;
    if (this.version && Date.now() - this.version.at < VERSION_FRESH_MS) return this.version.value;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), VERSION_WAIT_MS);
    try {
      const found = await Promise.race([
        lib.latestVersion(abort.signal),
        new Promise<null>((resolve) => abort.signal.addEventListener('abort', () => resolve(null))),
      ]);
      if (found) {
        this.version = { value: found, at: Date.now() };
        await this.setKeys({ [`${META_NS}version`]: JSON.stringify(found) }, true).catch(() => {});
        return found;
      }
    } catch (err) {
      console.warn('whatsapp version', errorText(err));
    } finally {
      clearTimeout(timer);
    }
    if (this.version) return this.version.value;
    const kept = await this.key(`${META_NS}version`, '').catch(() => null);
    try {
      const value = kept ? (JSON.parse(kept) as WaVersion) : null;
      if (Array.isArray(value) && value.length === 3 && value.every((n) => Number.isInteger(n))) {
        this.version = { value, at: 0 };
        return value;
      }
    } catch {
      // A stored version that cannot be read is as good as none.
    }
    return undefined;
  }

  private async open() {
    if (this.stopped) return;
    this.lib ??= await this.library();
    const lib = this.lib;
    // What the scan wrote must be on disk before it is read back for the restart that follows.
    await this.flushCreds();
    let saved: string | null;
    try {
      saved = await this.key('creds');
    } catch (err) {
      if (!(err instanceof UnreadableKey)) throw err;
      // The link is left as it is: it opens again if the server's secret key is put back.
      await this.fail('keysUnreadable');
      return;
    }
    const creds = saved ? (JSON.parse(saved, lib.reviver) as Record<string, unknown>) : lib.initAuthCreds();
    if (!saved) await this.setKeys({ creds: JSON.stringify(creds, lib.replacer) });
    const auth = {
      creds,
      keys: {
        get: async (type: string, ids: string[]) => {
          const out: Record<string, unknown> = {};
          for (const id of ids) {
            let v: string | null;
            try {
              v = await this.key(`${type}:${id}`);
            } catch (err) {
              if (!(err instanceof UnreadableKey)) throw err;
              // Skipped like a missing key, which WhatsApp asks for again; said once, not per key.
              if (!this.unreadableLogged) console.warn('whatsapp: a saved signal key cannot be read');
              this.unreadableLogged = true;
              continue;
            }
            if (v === null) continue;
            const value = JSON.parse(v, lib.reviver) as unknown;
            out[id] = type === 'app-state-sync-key' ? lib.appStateKey(value) : value;
          }
          return out;
        },
        set: async (data: Record<string, Record<string, unknown> | undefined>) => {
          const values: Record<string, string | null> = {};
          for (const [type, entries] of Object.entries(data)) {
            for (const [id, value] of Object.entries(entries ?? {})) {
              values[`${type}:${id}`] = value == null ? null : JSON.stringify(value, lib.replacer);
            }
          }
          await this.setKeys(values);
        },
      },
    };
    if (this.state !== 'linking') this.state = 'connecting';
    const version = await this.webVersion(lib);
    if (this.stopped) return;
    const socket = lib.connect(auth, {
      ...(version && { version }),
      getMessage: async (key) => this.sentMessage(key.id),
      ignore: (jid) =>
        jid.endsWith('@g.us') && !this.allChats && !this.followed.has(jid) && !this.routes.has(jid),
    });
    this.socket = socket;
    socket.ev.on('creds.update', (update) => {
      if (this.socket !== socket) return;
      Object.assign(creds, update);
      this.credsNow = () => JSON.stringify(creds, lib.replacer);
      this.credsDirty = true;
      void this.flushCreds();
    });
    socket.ev.on('connection.update', (u) => {
      if (this.socket !== socket) return;
      void this.connection(socket, u).catch((err: unknown) => console.warn('whatsapp', err));
    });
    const contacts = (list: Partial<WaContact>[]) => {
      if (this.socket !== socket) return;
      this.reading = this.reading
        .then(() => this.saveContacts(list))
        .catch((err: unknown) => console.warn('whatsapp contacts', err));
    };
    socket.ev.on('contacts.upsert', contacts);
    socket.ev.on('contacts.update', contacts);
    socket.ev.on('messaging-history.set', (u) => contacts(u.contacts ?? []));
    socket.ev.on('messages.upsert', (u) => {
      // New messages come as `notify`. Ones WhatsApp held while this device was away may come as
      // `append` after it connects again; those are read only when newer than the last one read.
      if (this.socket !== socket || (u.type !== 'notify' && u.type !== 'append')) return;
      for (const m of u.messages) {
        this.reading = this.reading
          .then(() => this.received(socket, m, u.type === 'append'))
          .catch((err: unknown) => console.warn('whatsapp message', err));
      }
    });
  }

  /** Writes the newest creds; one write at a time, in the order asked, and a failure is logged. */
  private flushCreds(): Promise<void> {
    this.credsChain = this.credsChain.then(async () => {
      if (!this.credsDirty || !this.credsNow) return;
      this.credsDirty = false;
      try {
        await this.setKeys({ creds: this.credsNow() });
      } catch (err) {
        console.warn('whatsapp creds', errorText(err));
      }
    });
    return this.credsChain;
  }

  /** What `connection.update` said about why the connection closed. */
  private async closed(code: number | undefined) {
    const codes = this.lib?.codes;
    const linking = this.state === 'linking';
    this.socket = null;
    const final = (error: string) => (linking ? this.abandonLink(error, false) : this.fail(error));
    if (code === this.lib?.loggedOut) {
      // Removed from Linked Devices on the phone: its keys are useless now.
      if (linking) return this.abandonLink('loggedOut', false);
      await this.wipeKeys();
      await this.forgetSavedNames();
      return this.fail('loggedOut');
    }
    if (code !== undefined && codes) {
      if (code === codes.forbidden) return final('forbidden');
      if (code === codes.multideviceMismatch) return final('mismatch');
      // The number was opened somewhere else; taking it back would only start a tug of war.
      if (code === codes.connectionReplaced) return final('replaced');
    }
    if (this.stopped) return;
    // A link that was just scanned asks for a restart at once; any other drop is tried again, slower each time.
    const restart = code !== undefined && code === codes?.restartRequired;
    if (linking && !restart && !this.qrShown) return this.abandonLink('unreachable', true);
    const wait = restart ? 0 : Math.min(linking ? 10_000 : 60_000, 1000 * 2 ** Math.min(this.attempt++, 6));
    if (!linking) this.state = 'connecting';
    this.changed();
    if (this.attempt >= FAILING_AFTER) {
      const row = await this.row();
      if (row && row.error !== 'failing') {
        await this.ctx.db
          .update(schema.channels)
          .set({ error: 'failing' })
          .where(eq(schema.channels.id, row.id));
        this.changed();
      }
    }
    this.retry = setTimeout(() => {
      void this.open().catch((err: unknown) => this.fail(errorText(err)));
    }, wait);
    this.retry.unref?.();
  }

  private async connection(
    socket: WaSocket,
    u: { connection?: string; qr?: string; lastDisconnect?: { error?: unknown } },
  ) {
    if (u.qr && this.state === 'linking') {
      this.qr = u.qr;
      this.qrShown = true;
      this.changed();
    }
    if (u.connection === 'open') {
      const own = numberOf(socket.user?.id);
      const row = await this.row();
      const settings = (row?.settings ?? {}) as Settings;
      if (row && own && settings.mode === 'separate' && own === settings.phone) {
        // With "separate number" the linked account must not be the person's own.
        await this.close();
        if (this.state === 'linking') {
          await this.dropNs();
          this.ns = '';
        } else {
          await this.wipeKeys();
        }
        return this.fail('ownNumber');
      }
      if (this.state === 'linking') await this.promote();
      if (row) {
        await this.ctx.db
          .update(schema.channels)
          .set({ account: { number: own, lid: socket.user?.lid ?? null }, error: null })
          .where(eq(schema.channels.id, row.id));
      }
      this.state = 'connected';
      this.qr = null;
      this.attempt = 0;
      this.gaveUp = false;
      if (this.linkTimer) clearTimeout(this.linkTimer);
      this.linkTimer = null;
      this.settle();
      this.changed();
      if (row && this.settlePending) {
        this.settlePending = false;
        void this.settleHeld(row).catch((err: unknown) => console.warn('whatsapp held', err));
      }
      void this.tellUndelivered().catch(() => {});
      // Replies approved while the connection was down go now.
      void this.settleDrafts().catch((err: unknown) => console.warn('whatsapp draft', err));
    }
    if (u.connection === 'close') {
      const code = (u.lastDisconnect?.error as { output?: { statusCode?: number } } | undefined)?.output
        ?.statusCode;
      await this.closed(code);
    }
  }

  private async fail(error: string) {
    // The reason is saved before the state shows it, so no one sees a stopped chat without one.
    const row = await this.row();
    if (row) await this.ctx.db.update(schema.channels).set({ error }).where(eq(schema.channels.id, row.id));
    this.state = 'error';
    this.qr = null;
    this.settle();
    this.changed();
  }

  private async close() {
    this.clearTimers();
    const socket = this.socket;
    this.socket = null;
    socket?.end();
  }

  private clearTimers() {
    if (this.linkTimer) clearTimeout(this.linkTimer);
    if (this.retry) clearTimeout(this.retry);
    this.linkTimer = null;
    this.retry = null;
  }

  /** Wakes the sends waiting for the connection: it came back, or it will not. */
  private settle() {
    for (const w of [...this.waiters]) w(true);
  }

  /**
   * The open socket, waiting for it to come back when the connection dropped; null when it does not
   * (the chat was stopped, it failed for good, or the wait ran out). Once a wait has run out, later
   * sends do not wait again until the connection is back, so a long outage does not hold every reply
   * for its own five minutes.
   */
  private async online(): Promise<WaSocket | null> {
    const ready = () => (this.state === 'connected' && this.socket ? this.socket : null);
    if (ready()) return ready();
    if (this.stopped || this.gaveUp || this.state === 'off' || this.state === 'error') return null;
    await new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(() => {
        this.gaveUp = true;
        done();
      }, OFFLINE_WAIT_MS);
      timer.unref?.();
      this.waiters.add(done);
    });
    return ready();
  }

  // Reading WhatsApp

  /** The address to answer at when the message is the person's own; null for anyone else's. */
  private async from(
    socket: WaSocket,
    m: WaMessage,
    settings: Settings,
    channelId: string,
  ): Promise<string | null> {
    const jid = m.key.remoteJid;
    if (!jid || m.key.participant || !/@(s\.whatsapp\.net|lid)$/.test(jid)) return null;
    let phone = numberOf(jid);
    if (!phone && jid.endsWith('@lid')) {
      phone = numberOf(m.key.remoteJidAlt);
      if (
        !phone &&
        settings.mode === 'own' &&
        socket.user?.lid &&
        bareJid(jid) === bareJid(socket.user.lid)
      ) {
        phone = numberOf(socket.user.id);
      }
      phone ??= numberOf(await socket.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null));
    }
    if (!phone) return null;
    if (settings.mode === 'own') {
      // Only "Message yourself", and only what the person typed there, not this server's replies.
      if (phone !== numberOf(socket.user?.id) || !m.key.fromMe) return null;
      // Remembered in memory for the moment after a send, and in the records for after a restart.
      if (m.key.id && (this.sentIds.has(m.key.id) || (await this.ours(channelId, m.key.id)))) return null;
    } else if (phone !== settings.phone || m.key.fromMe) {
      return null;
    }
    return bareJid(jid);
  }

  private async received(socket: WaSocket, m: WaMessage, held = false) {
    // The HD copy of a photo or video already received: not a message of its own, so it neither
    // counts toward the flood guard nor gets a second answer.
    if (isAssociatedChild(m)) return;
    // A message that could not be decrypted comes first as an empty stand-in, while WhatsApp asks
    // the sender's phone for it again; the message itself follows under the same id, so the
    // stand-in must not mark that id as already read.
    if (m.messageStubType === CIPHERTEXT_STUB) return;
    const row = await this.row();
    if (!row) return;
    const settings = row.settings as Settings;
    // A followed group's messages never reach the person's chat with the bots, its commands or its cards.
    const remote = m.key.remoteJid;
    if (remote?.endsWith('@g.us')) {
      if (this.allChats || this.followed.has(remote) || this.routes.has(remote))
        await this.chatMessage(socket, m, remote, 'group');
      return;
    }
    const jid = await this.from(socket, m, settings, row.id);
    if (!jid) {
      // Someone else's chat with the account: read when a routine reads people's chats, the bots
      // may read every chat, the chat is given to a bot, or a front door answers people.
      if (!this.people && !this.allChats && !this.door && !this.routes.size) return;
      const chat = await this.personChat(socket, m, settings);
      if (chat && (this.people || this.allChats || this.routes.has(chat) || (await this.atDoor(chat))))
        await this.chatMessage(socket, m, chat, 'person');
      return;
    }
    // Before any command or download: a message WhatsApp hands again must not run twice.
    const id = m.key.id;
    if (id) {
      if (this.seen.has(id) || (await this.ours(row.id, id))) return;
      this.seen.add(id);
      if (this.seen.size > SEEN_KEPT) this.seen.delete(this.seen.values().next().value!);
    }
    const stamp = stampOf(m);
    if (held) {
      // Only what came after the last message read, and not long ago: never old history.
      const seen = settings.seenAt ?? 0;
      if (!seen || stamp <= seen || Date.now() / 1000 - stamp > HELD_MAX_S) return;
    }
    try {
      await this.handle(socket, row, jid, m, stamp);
    } catch (err) {
      console.warn('whatsapp message', err);
      const t = await this.services.settings.translator();
      await this.say(jid, t('channel.updateFailed')).catch(() => {});
    }
  }

  // Names the person saved

  /** Remembers the phone-book names WhatsApp tells of, and puts them on the chats already kept. */
  private async saveContacts(list: Partial<WaContact>[]) {
    for (const c of list) {
      const name = oneLine(c.name ?? '');
      if (!name || !c.id) continue;
      // A contact is a number when WhatsApp says which; a chat is kept under one address for both.
      const phone = numberOf(c.phoneNumber) ?? numberOf(c.id);
      const chats = new Set([phone ? `${phone}@s.whatsapp.net` : bareJid(c.id)]);
      if (c.lid && !phone) chats.add(bareJid(c.lid));
      for (const chat of chats) {
        if (this.savedNames.get(chat) === name) continue;
        this.savedNames.set(chat, name);
        await this.ctx.db
          .insert(schema.whatsappSavedNames)
          .values({ jid: chat, name })
          .onConflictDoUpdate({
            target: schema.whatsappSavedNames.jid,
            set: { name, updatedAt: new Date() },
          });
        await this.ctx.db
          .update(schema.whatsappChats)
          .set({ savedName: name })
          .where(and(eq(schema.whatsappChats.jid, chat), eq(schema.whatsappChats.kind, 'person')));
      }
    }
  }

  /** The name the person saved for a chat's address, if WhatsApp has told it. */
  private async savedNameOf(chat: string): Promise<string> {
    const known = this.savedNames.get(chat);
    if (known) return known;
    const [saved] = await this.ctx.db
      .select({ name: schema.whatsappSavedNames.name })
      .from(schema.whatsappSavedNames)
      .where(eq(schema.whatsappSavedNames.jid, chat))
      .limit(1);
    if (saved) {
      this.savedNames.set(chat, saved.name);
      return saved.name;
    }
    const [row] = await this.ctx.db
      .select({ savedName: schema.whatsappChats.savedName })
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, chat))
      .limit(1);
    return row?.savedName ?? '';
  }

  // Answers to a bot's message

  /**
   * The bot that wrote to a chat most recently, within the window, and the conversation it wrote
   * from. Only a message the person approved counts, so the chat is one they asked the bot to work
   * with; the newest writer owns the answers, so one answer never reaches two bots.
   */
  async replyOwner(chat: string): Promise<{ botId: string; threadId: string } | null> {
    const at = sql`coalesce(${schema.whatsappDrafts.sentAt}, ${schema.whatsappDrafts.createdAt})`;
    // What a bot said as the chat's own bot, or at the front door, is answered there, not here.
    const contacts = await this.contactThreads(chat);
    const [row] = await this.ctx.db
      .select({ botId: schema.whatsappDrafts.botId, threadId: schema.whatsappDrafts.threadId })
      .from(schema.whatsappDrafts)
      .where(
        and(
          eq(schema.whatsappDrafts.chat, chat),
          eq(schema.whatsappDrafts.kind, 'message'),
          eq(schema.whatsappDrafts.status, 'sent'),
          // Compared with an expression, not a column, so the time goes in as text: on PostgreSQL
          // drizzle hands a Date there to the driver unconverted and the query fails.
          gte(at, sql`${new Date(Date.now() - REPLY_WINDOW_MS).toISOString()}::timestamptz`),
          contacts.length ? notInArray(schema.whatsappDrafts.threadId, contacts) : undefined,
        ),
      )
      .orderBy(desc(at))
      .limit(1);
    return row ?? null;
  }

  /** Holds an answer for the bot that wrote to the chat; it goes out when the chat is quiet. */
  private async queueReply(chat: string, line: string, seq: number, t: T): Promise<boolean> {
    const owner = await this.replyOwner(chat);
    if (!owner) return false;
    // A routine of that bot reading people's chats already hands it the answer in its own way.
    if ((await this.services.routines.chatReaders(chat, 'person')).includes(owner.botId)) return true;
    await this.markAwaiting([seq], true);
    const wait = this.replies.get(chat);
    if (wait && wait.botId !== owner.botId) {
      // Another bot wrote since: what waits goes to the one it was for, then this one starts.
      await this.flushReply(chat, t);
    }
    const open = this.replies.get(chat) ?? {
      ...owner,
      lines: [],
      seqs: [],
      // From the stored message, so the same batch handed again after a restart is one message.
      firstId: `s${seq}`,
      startedAt: Date.now(),
      timer: null,
    };
    open.lines.push(line);
    open.seqs.push(seq);
    if (open.timer) clearTimeout(open.timer);
    const left = Math.max(0, Math.min(this.chatQuietMs, open.startedAt + this.chatMaxWaitMs - Date.now()));
    open.timer = setTimeout(() => {
      this.reading = this.reading
        .then(() => this.flushReply(chat, t))
        .catch((err: unknown) => console.warn('whatsapp reply', err));
    }, left);
    this.replies.set(chat, open);
    return true;
  }

  /** Gives the waiting answers of a chat to the bot's conversation, as outside text. */
  private async flushReply(chat: string, t: T) {
    const wait = this.replies.get(chat);
    if (!wait) return;
    this.replies.delete(chat);
    if (wait.timer) clearTimeout(wait.timer);
    try {
      await this.giveReply(chat, wait, t);
    } finally {
      await this.markAwaiting(wait.seqs, false);
    }
  }

  private async giveReply(
    chat: string,
    wait: { botId: string; threadId: string; lines: string[]; firstId: string },
    t: T,
  ) {
    const row = await this.row();
    const [known] = await this.ctx.db
      .select({ name: schema.whatsappChats.name, savedName: schema.whatsappChats.savedName })
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, chat))
      .limit(1);
    const label = known ? shownName(known) : '';
    const who = label ? `${label} (+${numberOf(chat) ?? chat})` : `+${numberOf(chat) ?? chat}`;
    const input = {
      text: [
        t('whatsapp.replyHeader', { name: who }),
        t('whatsapp.chatId', { chat }),
        '',
        ...wait.lines,
      ].join('\n'),
      clientId: `whatsapp-reply:${chat}:${wait.firstId}`.slice(0, 120),
      userId: row?.userId ?? null,
      props: {
        via: 'whatsapp',
        outside: 'whatsapp',
        lead: t('whatsapp.replyLead', { name: who }),
        // The turn it starts reaches this chat, and sends to it without a card only where nobody
        // answered by hand meanwhile.
        whatsappReply: chat,
        ...((await this.typedSince(chat)) && { typed: true }),
      },
    };
    try {
      await this.services.inbox.send(wait.threadId, input);
    } catch (err) {
      // The conversation it was written from is gone: the person's main one with that bot instead.
      if (!row) throw err;
      const main = await this.services.threads.main(wait.botId, row.userId);
      await this.services.inbox.send(main.id, input);
    }
  }

  /**
   * Whether someone wrote in a chat by hand from the account since a bot's message last went out
   * to it: the person answering it themselves, whom a bot must not talk over without a card.
   */
  private async typedSince(chat: string, otherwise?: Date): Promise<boolean> {
    const at = sql`coalesce(${schema.whatsappDrafts.sentAt}, ${schema.whatsappDrafts.createdAt})`;
    const sent = await this.ctx.db
      .select({ text: schema.whatsappDrafts.text, at: sql<Date>`${at}` })
      .from(schema.whatsappDrafts)
      .where(and(eq(schema.whatsappDrafts.chat, chat), eq(schema.whatsappDrafts.status, 'sent')))
      .orderBy(desc(at))
      .limit(50);
    const since = sent[0] ? new Date(sent[0].at) : otherwise;
    if (!since) return false;
    const mine = await this.ctx.db
      .select({ text: schema.whatsappMessages.text })
      .from(schema.whatsappMessages)
      .where(
        and(
          eq(schema.whatsappMessages.chat, chat),
          eq(schema.whatsappMessages.fromMe, true),
          eq(schema.whatsappMessages.hidden, false),
          // A message's time is kept to the second.
          gte(schema.whatsappMessages.at, new Date(Math.floor(since.getTime() / 1000) * 1000)),
        ),
      );
    const texts = new Set(sent.map((d) => d.text));
    return mine.some((r) => !texts.has(r.text));
  }

  // Chats given to bots, and the front door

  private loadRoutes(settings: Settings) {
    this.routes = new Map((settings.routes ?? []).map((r) => [routeChat(r.chat), r]));
    this.door = settings.door ?? null;
    this.ownNumber = settings.mode === 'own';
  }

  /** The routes and the door as the settings show them: only those whose bot is still here. */
  private async contactsShown(s: Settings) {
    const named = [...(s.routes ?? []).map((r) => r.botId), ...(s.door ? [s.door.botId] : [])];
    const here = new Set(
      named.length
        ? (
            await this.ctx.db
              .select({ id: schema.bots.id })
              .from(schema.bots)
              .where(inArray(schema.bots.id, named))
          ).map((b) => b.id)
        : [],
    );
    const routes = (s.routes ?? []).filter((r) => here.has(r.botId) && WhatsAppRoute.safeParse(r).success);
    return {
      routes: await this.routesShown(routes),
      door: s.door && here.has(s.door.botId) ? s.door : null,
    };
  }

  /** The routes as the settings show them, with the name each chat goes by here. */
  private async routesShown(routes: WhatsAppRoute[]) {
    if (!routes.length) return [];
    const rows = await this.ctx.db
      .select({
        jid: schema.whatsappChats.jid,
        name: schema.whatsappChats.name,
        savedName: schema.whatsappChats.savedName,
      })
      .from(schema.whatsappChats)
      .where(
        inArray(
          schema.whatsappChats.jid,
          routes.map((r) => routeChat(r.chat)),
        ),
      );
    const names = new Map(rows.map((r) => [r.jid, shownName(r)]));
    return routes.map((r) => ({ ...r, name: names.get(routeChat(r.chat)) ?? '' }));
  }

  /** Who answers a chat now: the bot it is given to, else the front door for a person. */
  private async contactTarget(chat: string, kind: 'person' | 'group') {
    const route = this.routes.get(chat);
    if (route) return { role: 'route' as const, botId: route.botId, mode: route.mode };
    if (kind !== 'person' || !(await this.atDoor(chat))) return null;
    const door = this.door!;
    // On the person's own number its answers go out as them: always on a card first.
    const mode: WhatsAppReplyMode = this.ownNumber && door.mode === 'auto' ? 'draft' : door.mode;
    return { role: 'door' as const, botId: door.botId, mode };
  }

  /**
   * Whether the front door answers a person's chat. On the person's own number everyone who
   * writes may be someone they know: there only a number not in their phone book is a stranger.
   */
  private async atDoor(chat: string): Promise<boolean> {
    if (!this.door) return false;
    return !this.ownNumber || !(await this.savedNameOf(chat));
  }

  /** Holds a message for the chat's own bot, or the front door; it goes when the chat is quiet. */
  private async queueContact(
    chat: string,
    kind: 'person' | 'group',
    line: string,
    seq: number,
  ): Promise<boolean> {
    const target = await this.contactTarget(chat, kind);
    if (!target || target.mode === 'off') return false;
    await this.markAwaiting([seq], true);
    const open = this.contactWaits.get(chat) ?? {
      kind,
      lines: [],
      seqs: [],
      firstSeq: seq,
      // From the stored message, so the same batch handed again after a restart is one message.
      firstId: `s${seq}`,
      startedAt: Date.now(),
      timer: null,
    };
    open.lines.push(line);
    open.seqs.push(seq);
    if (open.timer) clearTimeout(open.timer);
    const left = Math.max(0, Math.min(this.chatQuietMs, open.startedAt + this.chatMaxWaitMs - Date.now()));
    open.timer = setTimeout(() => {
      this.reading = this.reading
        .then(() => this.flushContact(chat))
        .catch((err: unknown) => console.warn('whatsapp contact', err));
    }, left);
    this.contactWaits.set(chat, open);
    return true;
  }

  /**
   * Gives a chat's waiting messages to the bot that answers it, in that bot's conversation for the
   * chat. They are someone else's words, written by someone with no account here: the turn works
   * with no one's own data and asks before anything but its answer, and its answer is what goes
   * back to the chat (`onTurnFinished`).
   */
  private async flushContact(chat: string) {
    const wait = this.contactWaits.get(chat);
    if (!wait) return;
    this.contactWaits.delete(chat);
    if (wait.timer) clearTimeout(wait.timer);
    try {
      await this.giveContact(chat, wait);
    } finally {
      await this.markAwaiting(wait.seqs, false);
    }
  }

  private async giveContact(
    chat: string,
    wait: { kind: 'person' | 'group'; lines: string[]; firstSeq: number; firstId: string },
  ) {
    const target = await this.contactTarget(chat, wait.kind);
    const owner = await this.ownerId();
    if (!target || target.mode === 'off' || !owner) return;
    const bot = await this.services.bots.get(target.botId).catch(() => null);
    if (!bot || bot.archivedAt) return;
    const t = await this.services.settings.translator();
    const [row] = await this.ctx.db
      .select()
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, chat))
      .limit(1);
    if (!row) return;
    const label = shownName(row);
    const who =
      wait.kind === 'group'
        ? label || chat
        : label
          ? `${label} (+${numberOf(chat) ?? chat})`
          : `+${numberOf(chat) ?? chat}`;
    const thread = await this.contactThread(chat, target.role, bot.id, owner, who, t);
    // Someone writing on and on starts only so many turns an hour; what is past that stays kept.
    const [{ n }] = (await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, thread),
          sql`${schema.messages.props}->>'whatsappContact' is not null`,
          gt(schema.messages.createdAt, new Date(Date.now() - 3600_000)),
        ),
      )) as [{ n: number }];
    if (n >= CONTACT_TURNS_MAX) return;
    // In a group, the lines before the mention say what it is about.
    const before =
      wait.kind === 'group'
        ? (
            await this.ctx.db
              .select()
              .from(schema.whatsappMessages)
              .where(
                and(eq(schema.whatsappMessages.chat, chat), lt(schema.whatsappMessages.seq, wait.firstSeq)),
              )
              .orderBy(desc(schema.whatsappMessages.seq))
              .limit(MENTION_CONTEXT)
          )
            .reverse()
            .map((r) => `[${r.at.toISOString()}] ${r.writer}: ${r.text}`)
        : [];
    const lead =
      wait.kind === 'group'
        ? t('whatsapp.contactGroupLead', { name: who, silent: SILENT_REPLY })
        : t(target.role === 'door' ? 'whatsapp.doorLead' : 'whatsapp.contactLead', {
            name: who,
            silent: SILENT_REPLY,
          });
    await this.services.inbox.send(thread, {
      text: [
        t(wait.kind === 'group' ? 'whatsapp.groupHeader' : 'whatsapp.chatHeader', { name: who }),
        ...(before.length ? ['', t('whatsapp.chatBefore'), ...before, '', t('whatsapp.chatNew')] : ['']),
        ...wait.lines,
      ].join('\n'),
      clientId: `whatsapp-contact:${chat}:${wait.firstId}`.slice(0, 120),
      userId: owner,
      guest: true,
      props: { via: 'whatsapp', outside: 'whatsapp', lead, whatsappContact: chat },
    });
  }

  /** The conversation a bot keeps for a chat it answers, made the first time; the person's own. */
  private async contactThread(
    chat: string,
    role: ContactRole,
    botId: string,
    owner: string,
    who: string,
    t: T,
  ): Promise<string> {
    const key = contactKey(role, botId);
    const [row] = await this.ctx.db
      .select({ threads: schema.whatsappChats.threads, kind: schema.whatsappChats.kind })
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, chat))
      .limit(1);
    const kept = row?.threads[key];
    if (kept) {
      const thread = await this.services.threads.row(kept).catch(() => null);
      if (thread && !thread.archivedAt) return kept;
    }
    const made = await this.services.threads.create(botId, {
      title: truncate(
        t(role === 'door' ? 'whatsapp.doorTitle' : 'whatsapp.contactTitle', { name: who }),
        120,
      ),
      userId: owner,
    });
    this.contacts.set(made.id, { chat, kind: row?.kind ?? 'person', role, botId });
    // Only the conversation is noted: where routines are in the chat stays as it is.
    await this.ctx.db
      .update(schema.whatsappChats)
      .set({ threads: sql`${schema.whatsappChats.threads} || ${JSON.stringify({ [key]: made.id })}::jsonb` })
      .where(eq(schema.whatsappChats.jid, chat));
    return made.id;
  }

  /** The conversations kept for a chat by its own bot and the front door. */
  private async contactThreads(chat: string): Promise<string[]> {
    const [row] = await this.ctx.db
      .select({ threads: schema.whatsappChats.threads })
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, chat))
      .limit(1);
    return Object.entries(row?.threads ?? {})
      .filter(([k]) => k.startsWith('door:') || k.startsWith('route:'))
      .map(([, v]) => v);
  }

  /**
   * The chat a conversation answers, when it is one a bot keeps for a chat given to it (`route`)
   * or at the front door (`door`). Every turn there works with no one's own data, and at the front
   * door with no tool but suggesting a bot for the chat.
   */
  async contactOf(threadId: string): Promise<Contact | null> {
    // Asked at the start and end of every turn: a conversation's answer never changes once known,
    // as one is made a chat's only when it is created.
    const known = this.contacts.get(threadId);
    if (known !== undefined) return known;
    const found = await this.findContact(threadId);
    if (this.contacts.size >= CONTACTS_KEPT) this.contacts.clear();
    this.contacts.set(threadId, found);
    return found;
  }

  private async findContact(threadId: string): Promise<Contact | null> {
    const [row] = await this.ctx.db
      .select({
        jid: schema.whatsappChats.jid,
        kind: schema.whatsappChats.kind,
        threads: schema.whatsappChats.threads,
      })
      .from(schema.whatsappChats)
      .where(
        sql`exists (select 1 from jsonb_each_text(${schema.whatsappChats.threads}) e where e.value = ${threadId} and (e.key like 'door:%' or e.key like 'route:%'))`,
      )
      .limit(1);
    if (!row) return null;
    const key = Object.entries(row.threads).find(
      ([k, v]) => v === threadId && (k.startsWith('door:') || k.startsWith('route:')),
    )?.[0];
    if (!key) return null;
    const [role, botId] = key.split(':') as [ContactRole, string];
    return { chat: row.jid, kind: row.kind, role, botId };
  }

  /**
   * The answer of a turn the chat's own messages started goes back to the chat: at once when its
   * mode says so and nobody answered there by hand, else on a card. A group is never written to:
   * the answer stays in the conversation, for the person. A failed, stopped or silent turn sends
   * nothing.
   */
  async onTurnFinished(
    turn: { id: string; threadId: string; botId: string },
    outcome: TurnOutcome,
  ): Promise<void> {
    if (!outcome.ok) return;
    const text = outcome.text.trim();
    if (!text || isSilentReply(text)) return;
    const contact = await this.contactOf(turn.threadId);
    if (!contact || contact.kind === 'group' || contact.botId !== turn.botId) return;
    const [started] = await this.ctx.db
      .select({ at: schema.messages.createdAt })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, turn.threadId),
          eq(schema.messages.turnId, turn.id),
          sql`${schema.messages.props}->>'whatsappContact' is not null`,
        ),
      )
      .orderBy(asc(schema.messages.createdAt))
      .limit(1);
    if (!started) return;
    // The mode as it is now: a route taken away or a door changed since asks first.
    const target = await this.contactTarget(contact.chat, contact.kind);
    const mode: WhatsAppReplyMode =
      target && target.role === contact.role && target.botId === contact.botId ? target.mode : 'draft';
    if (mode === 'off') return;
    const typed = await this.typedSince(contact.chat, new Date(started.at.getTime() - 3600_000));
    if (mode === 'auto' && !typed) {
      const sent = await this.sendNow({
        botId: contact.botId,
        threadId: turn.threadId,
        chat: contact.chat,
        text,
      });
      if (sent !== 'card') return;
    }
    const t = await this.services.settings.translator();
    // One answer waits at a time: a newer one takes the place of the one not yet answered.
    const open = await this.ctx.db
      .select({ approvalId: schema.whatsappDrafts.approvalId })
      .from(schema.whatsappDrafts)
      .where(
        and(
          eq(schema.whatsappDrafts.chat, contact.chat),
          eq(schema.whatsappDrafts.threadId, turn.threadId),
          eq(schema.whatsappDrafts.status, 'pending'),
        ),
      );
    for (const d of open) {
      await this.services.approvals
        .answer(d.approvalId, { decision: 'deny', remember: false })
        .catch((err: unknown) => console.warn('whatsapp draft', errorText(err)));
    }
    const known = await this.knownChat(contact.chat);
    const number = contact.chat.replace(/@.*$/, '');
    await this.putOnCard({
      botId: contact.botId,
      threadId: turn.threadId,
      kind: 'message',
      chat: contact.chat,
      text,
      file: null,
      summary: t('whatsapp.draftCard', {
        to: known?.name ? `${known.name} (${number})` : `+${number}`,
        text,
      }),
      approve: t('whatsapp.send'),
      reject: t('whatsapp.dontSend'),
    });
  }

  /**
   * Puts a draft on a card in a conversation and keeps it; the answer is handled when it comes
   * (`settleDrafts`), not by whoever drafted it, who does not wait for it.
   */
  async putOnCard(d: {
    botId: string;
    threadId: string;
    kind: 'message' | 'status';
    chat: string | null;
    text: string;
    file: string | null;
    summary: string;
    approve: string;
    reject: string;
  }): Promise<void> {
    let made!: () => void;
    const created = new Promise<void>((done) => (made = done));
    const id = newId();
    const asked = this.services.approvals.ask({
      threadId: d.threadId,
      botId: d.botId,
      turnId: null,
      kind: 'question',
      toolName: d.kind === 'status' ? 'whatsapp_status' : 'whatsapp_send',
      input: { chat: d.chat, text: d.text, file: d.file },
      summary: d.summary,
      options: [d.approve, d.reject],
      onCreated: async (ap) => {
        await this.ctx.db.insert(schema.whatsappDrafts).values({
          id,
          approvalId: ap.id,
          botId: d.botId,
          threadId: d.threadId,
          kind: d.kind,
          chat: d.chat,
          text: d.text,
          file: d.file,
          approve: d.approve,
        });
        await this.services.threads.addMessage({
          threadId: d.threadId,
          role: 'approval',
          author: `bot:${d.botId}`,
          text: ap.summary,
          props: { approvalId: ap.id },
        });
        made();
      },
    });
    void asked.catch((err: unknown) => console.warn('whatsapp draft card', err));
    await Promise.race([created, asked.then(() => undefined)]);
  }

  /**
   * The front door suggests a bot for the chat it answers: a card to the person, who gives the
   * chat to that bot (its answers on cards) or not. The chat is the door's own; one suggestion
   * waits at a time.
   */
  async suggestRoute(
    d: { threadId: string; botId: string; ref: string; reason: string },
    t: T,
  ): Promise<string> {
    const contact = await this.contactOf(d.threadId);
    if (!contact || contact.role !== 'door' || contact.kind !== 'person')
      return t('tool.whatsappRouteNotHere');
    // A chat is given to a bot by its number; one WhatsApp shows without it cannot be.
    if (!numberOf(contact.chat)) return t('tool.whatsappRouteNoNumber');
    const owner = await this.ownerId();
    if (!owner) return t('tool.whatsappRouteNotHere');
    const reached = new Set(
      await this.services.access.botIds(await this.services.access.viewerOf(owner), 'chat'),
    );
    const bots = (await this.services.bots.list()).filter(
      (b) => reached.has(b.id) && !b.archivedAt && b.id !== d.botId,
    );
    const ref = d.ref.trim().toLocaleLowerCase();
    const bot = bots.find((b) => b.id === d.ref.trim() || b.name.toLocaleLowerCase() === ref);
    if (!bot) return t('tool.whatsappRouteUnknown', { names: bots.map((b) => b.name).join(', ') || '-' });
    const waiting = await this.ctx.db
      .select({ id: schema.approvals.id })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.toolName, 'whatsapp_route'),
          eq(schema.approvals.status, 'pending'),
          sql`${schema.approvals.input}->>'chat' = ${contact.chat}`,
        ),
      )
      .limit(1);
    if (waiting.length) return t('tool.whatsappRouteWaiting');
    const [row] = await this.ctx.db
      .select({ name: schema.whatsappChats.name, savedName: schema.whatsappChats.savedName })
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, contact.chat))
      .limit(1);
    const number = `+${numberOf(contact.chat) ?? contact.chat}`;
    // The name a person gives themselves on WhatsApp is theirs to choose: shown as theirs.
    const who = row?.savedName
      ? `${row.savedName} (${number})`
      : row?.name
        ? t('whatsapp.routeWho', { number, name: row.name })
        : number;
    const yes = t('whatsapp.routeYes');
    let made!: () => void;
    const created = new Promise<void>((done) => (made = done));
    const asked = this.services.approvals.ask({
      threadId: d.threadId,
      botId: d.botId,
      turnId: null,
      kind: 'question',
      toolName: 'whatsapp_route',
      input: { chat: contact.chat, botId: bot.id, yes },
      summary: t('whatsapp.routeCard', {
        who,
        bot: bot.name,
        reason: truncate(d.reason.trim().replace(/\s+/g, ' '), 300),
      }),
      options: [yes, t('whatsapp.routeNo')],
      onCreated: async (ap) => {
        await this.services.threads.addMessage({
          threadId: d.threadId,
          role: 'approval',
          author: `bot:${d.botId}`,
          text: ap.summary,
          props: { approvalId: ap.id },
        });
        made();
      },
    });
    void asked.catch((err: unknown) => console.warn('whatsapp route card', err));
    await Promise.race([created, asked.then(() => undefined)]);
    return t('tool.whatsappRouteAsked', { bot: bot.name });
  }

  /** Gives a chat to the bot a front-door card named, once the person said yes; each card once. */
  private async settleRoutes() {
    const row = await this.row();
    if (!row) return;
    const done = new Set((row.settings as Settings).routeAnswers ?? []);
    // Cards answered lately: the ones kept as handled are only these, so the list stays short and
    // an older card never counts again.
    const answered = await this.ctx.db
      .select({
        id: schema.approvals.id,
        status: schema.approvals.status,
        answer: schema.approvals.answer,
        input: schema.approvals.input,
        options: schema.approvals.options,
        threadId: schema.approvals.threadId,
        botId: schema.approvals.botId,
        by: schema.approvals.decidedByUserId,
      })
      .from(schema.approvals)
      .where(
        and(
          eq(schema.approvals.toolName, 'whatsapp_route'),
          ne(schema.approvals.status, 'pending'),
          gt(
            sql`coalesce(${schema.approvals.decidedAt}, ${schema.approvals.createdAt})`,
            sql`${new Date(Date.now() - ROUTE_ANSWER_MS).toISOString()}::timestamptz`,
          ),
        ),
      );
    const fresh = answered.filter((a) => !done.has(a.id));
    if (!fresh.length) return;
    // Built on the settings as they are when written, so a save made meanwhile is kept.
    await this.saveSettings(row, (now) => {
      const routes = [...(now.routes ?? [])];
      for (const a of fresh) {
        const input = a.input as { chat?: unknown; botId?: unknown; yes?: unknown };
        if (a.status !== 'allowed' || a.answer !== input.yes) continue;
        if (typeof input.chat !== 'string' || typeof input.botId !== 'string') continue;
        // What the door suggested asks first: the person decides later whether it goes at once.
        const route = WhatsAppRoute.safeParse({ chat: numberOf(input.chat), botId: input.botId });
        if (!route.success) continue;
        const at = routes.findIndex((r) => routeChat(r.chat) === input.chat);
        if (at >= 0) routes[at] = route.data;
        else routes.push(route.data);
      }
      return { routes, routeAnswers: answered.map((a) => a.id) };
    });
    this.loadRoutes(((await this.row())?.settings ?? {}) as Settings);
    this.changed();
    // Words written on the card in place of a button are meant for the front door: it reads them
    // and goes on (another bot, a question), as with any card answered in words.
    const t = await this.services.settings.translator();
    for (const a of fresh) {
      const words =
        a.status === 'allowed' && a.answer?.trim() && !a.options.includes(a.answer) ? a.answer.trim() : '';
      if (!words || !a.threadId || !a.botId) continue;
      await this.services.turns
        .enqueue({
          threadId: a.threadId,
          botId: a.botId,
          source: 'user',
          prompt: t('whatsapp.routeAnsweredPrompt', { answer: words }),
          ...(a.by && { userId: a.by }),
        })
        .catch((err: unknown) => console.warn('whatsapp route answer', errorText(err)));
    }
  }

  // Chats routines read: people who write to the account, and followed groups

  private async loadFollowed() {
    const reads = await this.services.routines.whatsappReads();
    this.followed = reads.groups;
    this.people = reads.people;
    const settings = ((await this.row())?.settings ?? {}) as Settings;
    this.allChats = settings.chats === true;
    this.loadRoutes(settings);
    // A chat no longer read keeps what was stored, but no batch goes out for it.
    for (const [jid, wait] of this.waits) {
      if (jid.endsWith('@g.us') ? this.followed.has(jid) : this.people) continue;
      if (wait.timer) clearTimeout(wait.timer);
      this.waits.delete(jid);
    }
  }

  /** Whose WhatsApp is linked: who set it up; null when it is not set up. */
  async ownerId(): Promise<string | null> {
    return (await this.row())?.userId ?? null;
  }

  /** Whether the bots may read every chat and draft messages in a conversation. */
  async chatsOpen(): Promise<boolean> {
    return ((await this.row())?.settings as Settings | undefined)?.chats === true;
  }

  /** Lets the bots read every chat, or only the ones routines read, as the person answered. */
  async openChats(on: boolean): Promise<void> {
    const row = await this.row();
    if (!row) throw new HttpError(409, 'error.whatsappNotSetUp');
    await this.saveSettings(row, { chats: on });
    this.allChats = on;
    this.changed();
  }

  /** Whether a bot at full access may send a message without its card. */
  async autoSendOn(): Promise<boolean> {
    return ((await this.row())?.settings as Settings | undefined)?.autoSend === true;
  }

  /**
   * Sends a bot's message at once, without a card, and notes in the conversation what went out:
   * the person's record of it. `card` when it should go on a card after all: not connected, or
   * the chat had its share of messages without one this hour.
   */
  async sendNow(d: { botId: string; threadId: string; chat: string; text: string }) {
    if (this.state !== 'connected' || !this.socket) return 'card' as const;
    const [{ n }] = (await this.ctx.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.whatsappDrafts)
      .where(
        and(
          eq(schema.whatsappDrafts.chat, d.chat),
          eq(schema.whatsappDrafts.approvalId, ''),
          gt(schema.whatsappDrafts.createdAt, new Date(Date.now() - 3600_000)),
        ),
      )) as [{ n: number }];
    if (n >= AUTO_SEND_MAX) return 'card' as const;
    const [draft] = await this.ctx.db
      .insert(schema.whatsappDrafts)
      .values({
        id: newId(),
        approvalId: '',
        botId: d.botId,
        threadId: d.threadId,
        kind: 'message',
        chat: d.chat,
        text: d.text,
        approve: '',
        status: 'sent',
        sentAt: new Date(),
      })
      .returning();
    const t = await this.services.settings.translator();
    try {
      await this.sendDraft(draft!, t);
    } catch (err) {
      await this.ctx.db
        .update(schema.whatsappDrafts)
        .set({ status: 'failed' })
        .where(eq(schema.whatsappDrafts.id, draft!.id));
      await this.draftNote(draft!, 'failed', errorText(err));
      return { failed: errorText(err) };
    }
    await this.draftNote(draft!, 'sent').catch((err: unknown) =>
      console.warn('whatsapp sent note', errorText(err)),
    );
    return 'sent' as const;
  }

  /**
   * The chats whose answers started a turn, when some did (an answer to a bot's message): that
   * turn reaches only these chats. `typed` when someone also wrote in the chat by hand from the
   * account since the bot's message went out.
   */
  async wokenBy(turn: { id: string; threadId: string }): Promise<{ chat: string; typed: boolean }[]> {
    const rows = await this.ctx.db
      .select({ props: schema.messages.props })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.threadId, turn.threadId),
          eq(schema.messages.turnId, turn.id),
          sql`${schema.messages.props}->>'whatsappReply' is not null`,
        ),
      );
    return rows.map((r) => {
      const props = r.props as { whatsappReply: string; typed?: unknown };
      return { chat: props.whatsappReply, typed: props.typed === true };
    });
  }

  /**
   * The chat address of a number when it is on WhatsApp; null when it is not, undefined when that
   * cannot be found out now (not connected).
   */
  async numberChat(phone: string): Promise<string | null | undefined> {
    const socket = this.socket;
    if (this.state !== 'connected' || !socket?.onWhatsApp) return undefined;
    const jid = `${phone}@s.whatsapp.net`;
    const found = await socket.onWhatsApp(jid).catch(() => undefined);
    if (!found) return undefined;
    return found.some((f) => f.exists) ? jid : null;
  }

  /** The groups the linked account is in, for a routine to pick the one it follows. */
  async groups(): Promise<WhatsAppGroup[]> {
    const socket = this.state === 'connected' ? this.socket : null;
    if (!socket?.groupFetchAllParticipating) throw new HttpError(409, 'error.whatsappNotConnected');
    await this.loadGroupNames(socket, true);
    return [...this.groupNames]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private async loadGroupNames(socket: WaSocket, force = false) {
    if (!force && Date.now() - this.groupNamesAt < GROUP_NAMES_FRESH_MS) return;
    const all = (await socket.groupFetchAllParticipating?.()) ?? {};
    this.groupNames = new Map(Object.values(all).map((g) => [g.id, oneLine(g.subject ?? '') || g.id]));
    this.groupNamesAt = Date.now();
  }

  private async groupName(socket: WaSocket, jid: string): Promise<string> {
    await this.loadGroupNames(socket).catch(() => {});
    return this.groupNames.get(jid) ?? '';
  }

  /** A phone number for an address: its own, or the one WhatsApp pairs with a lid. */
  private async phoneOf(socket: WaSocket, jid: string, alt?: string | null): Promise<string | null> {
    let phone = numberOf(jid) ?? numberOf(alt);
    if (!phone && jid.endsWith('@lid')) {
      if (socket.user?.lid && bareJid(jid) === bareJid(socket.user.lid)) phone = numberOf(socket.user.id);
      phone ??= numberOf(await socket.signalRepository?.lidMapping?.getPNForLID(jid).catch(() => null));
    }
    return phone;
  }

  /**
   * The chat of someone else writing to the account, under one address however WhatsApp names
   * them (a number, or a lid); null for the person's own chat with the bots and for anything else.
   */
  private async personChat(socket: WaSocket, m: WaMessage, settings: Settings): Promise<string | null> {
    const jid = m.key.remoteJid;
    if (!jid || m.key.participant || !/@(s\.whatsapp\.net|lid)$/.test(jid)) return null;
    const phone = await this.phoneOf(socket, jid, m.key.remoteJidAlt);
    // "Message yourself", and the person's own number when the bots have one of their own.
    if (phone && (phone === numberOf(socket.user?.id) || phone === settings.phone)) return null;
    return phone ? `${phone}@s.whatsapp.net` : bareJid(jid);
  }

  /** Who wrote a message in a chat: their WhatsApp name and number, as far as they are known. */
  private async writerOf(socket: WaSocket, m: WaMessage, chat: string, t: T): Promise<string> {
    if (m.key.fromMe) return t('whatsapp.groupYou');
    const who = m.key.participant ?? chat;
    const phone = await this.phoneOf(socket, who, m.key.participantAlt);
    const name = oneLine(
      (await this.savedNameOf(phone ? `${phone}@s.whatsapp.net` : bareJid(who))) || (m.pushName ?? ''),
    );
    if (name && phone) return `${name} (+${phone})`;
    return name || (phone ? `+${phone}` : '?');
  }

  /**
   * A message in a chat a routine reads: stored, and its chat's batch waits for the chat to go
   * quiet. Codes, passwords and sign-in links are dropped before anything is kept. The person's
   * own messages in the chat are kept as context but start nothing. Nothing is said back.
   */
  private async chatMessage(socket: WaSocket, m: WaMessage, chat: string, kind: 'person' | 'group') {
    const id = m.key.id;
    if (!id) return;
    const stamp = stampOf(m) || Math.floor(Date.now() / 1000);
    // Only what is new, not history WhatsApp hands over long after.
    if (Date.now() / 1000 - stamp > HELD_MAX_S) return;
    const t = await this.services.settings.translator();
    const content = contentOf(m);
    const { media, forwarded, quoted } = content;
    const text = (content.text || cardsText(content.cards, t)).trim();
    if (!text && !media) return;
    // A code, a password or a sign-in link: none of it is kept, not even the file; a line without
    // its content says one was left out, so a payment worded like a code does not vanish unseen.
    const hidden =
      privateText(text) || (!!quoted && privateText(quoted.text)) || privateText(media?.name ?? '');
    // A code from someone with no chat here (a bank, a sign-in) leaves no trace at all.
    if (hidden && !(await this.knownChat(chat))) return;
    const writer = await this.writerOf(socket, m, chat, t);
    const name =
      kind === 'group' ? await this.groupName(socket, chat) : !m.key.fromMe ? oneLine(m.pushName ?? '') : '';
    const at = new Date(stamp * 1000);
    const saved = kind === 'person' ? await this.savedNameOf(chat) : '';
    await this.ctx.db
      .insert(schema.whatsappChats)
      .values({ jid: chat, kind, name, savedName: saved, lastAt: at })
      .onConflictDoUpdate({
        target: schema.whatsappChats.jid,
        set: { lastAt: at, ...(name && { name }), ...(saved && { savedName: saved }) },
      });
    const quote =
      !hidden && quoted?.text.trim()
        ? `${t('whatsapp.groupQuote', { text: truncate(quoted.text.trim().replace(/\s+/g, ' '), 300) })}\n`
        : '';
    const [stored] = await this.ctx.db
      .insert(schema.whatsappMessages)
      .values({
        chat,
        externalId: id,
        fromMe: !!m.key.fromMe,
        hidden,
        writer: forwarded ? `${writer} ${t('whatsapp.groupForwarded')}` : writer,
        text: hidden ? t('whatsapp.hidden') : `${quote}${truncate(text, CHAT_TEXT_MAX)}`,
        at,
      })
      .onConflictDoNothing()
      .returning({ seq: schema.whatsappMessages.seq });
    // Handed again, or sent from here: already kept.
    if (!stored) return;
    // An answer from someone a bot wrote to reaches that bot, whether or not a routine reads the chat.
    if (!m.key.fromMe && !hidden) {
      const said = `[${at.toISOString()}] ${writer}: ${quote}${truncate(text, CHAT_TEXT_MAX)}`;
      const line = media ? `${said}\n  ${t('whatsapp.fileNotKept')}` : said;
      // The bot that wrote to the person lately has their answer; else the bot the chat is given
      // to, or the front door. In a group, only a message to the account.
      const taken = kind === 'person' && (await this.queueReply(chat, line, stored.seq, t));
      if (
        !taken &&
        (kind === 'person' ||
          (this.routes.has(chat) && mentionsAccount(m, [socket.user?.id ?? '', socket.user?.lid ?? ''])))
      )
        await this.queueContact(chat, kind, line, stored.seq);
    }
    // A chat no routine reads is kept for the bots to look at, not handed over: its place moves on
    // at once, so a routine that starts reading it later gets what comes next, not 30 days of it.
    if (!(kind === 'group' ? this.followed.has(chat) : this.people)) {
      if (media && !hidden) {
        await this.ctx.db
          .update(schema.whatsappMessages)
          .set({ file: { failed: 'whatsapp.fileNotKept' } })
          .where(eq(schema.whatsappMessages.seq, stored.seq));
      }
      await this.moveOn(chat, stored.seq, {}, null);
      return;
    }
    if (hidden) return;
    if (media) {
      const name = receivedName(media.kind, id, media.mime, media.name);
      const file = await this.chatFile(socket, chat, kind, m, name, media.size);
      await this.ctx.db
        .update(schema.whatsappMessages)
        .set({ file })
        .where(eq(schema.whatsappMessages.seq, stored.seq));
    }
    // The person answering in the chat themselves holds the batch back until the chat is quiet.
    if (!m.key.fromMe || this.waits.has(chat)) this.waitForQuiet(chat);
  }

  /** Where a bot keeps a chat's files, inside its own folder. */
  private chatFolder(botId: string, chat: string) {
    const root = resolve(this.ctx.config.dataDir, 'workspaces');
    return join(root, 'bots', botId, 'files', 'whatsapp', chat.replace(/@.*$/, '').replace(/[^\w-]/g, '_'));
  }

  /** Saves a chat message's file under the same name in each reading bot's folder. */
  private async chatFile(
    socket: WaSocket,
    chat: string,
    kind: 'person' | 'group',
    m: WaMessage,
    name: string,
    size: number | undefined,
  ): Promise<{ name: string; size: number } | { failed: string }> {
    if ((size ?? 0) > RECEIVE_MAX) return { failed: 'whatsapp.groupFileTooLarge' };
    const bots = await this.services.routines.chatReaders(chat, kind);
    if (!bots.length) return { failed: 'whatsapp.groupFileFailed' };
    // The message id keeps two files of the same name apart.
    const file = `${(m.key.id ?? newId()).slice(0, 24)}-${safeFileName(name) || 'file'}`;
    try {
      const first = this.chatFolder(bots[0]!, chat);
      await mkdir(first, { recursive: true, mode: 0o700 });
      const saved = await saveUpload(first, file, await this.lib!.download(m, socket));
      const path = join(first, saved.name);
      for (const botId of bots.slice(1)) {
        await mkdir(this.chatFolder(botId, chat), { recursive: true, mode: 0o700 });
        await copyFile(path, join(this.chatFolder(botId, chat), saved.name));
      }
      return { name: saved.name, size: (await stat(path)).size };
    } catch (err) {
      console.warn('whatsapp chat file', errorText(err));
      return { failed: 'whatsapp.groupFileFailed' };
    }
  }

  /** Each new message waits for the chat to go quiet again, up to the longest wait from the first. */
  private waitForQuiet(chat: string, ms = this.chatQuietMs) {
    const wait = this.waits.get(chat) ?? { startedAt: Date.now(), timer: null };
    if (wait.timer) clearTimeout(wait.timer);
    const left = Math.max(0, Math.min(ms, wait.startedAt + this.chatMaxWaitMs - Date.now()));
    wait.timer = setTimeout(() => {
      this.reading = this.reading
        .then(() => this.handOver(chat))
        .catch((err: unknown) => console.warn('whatsapp chat', err));
    }, left);
    this.waits.set(chat, wait);
  }

  /** One message of a chat as a bot reads it, with its file in that bot's own folder. */
  private chatLine(row: typeof schema.whatsappMessages.$inferSelect, botId: string, t: T): string {
    const head = `[${row.at.toISOString()}] ${row.writer}: ${row.text}`.trimEnd();
    const file = row.file;
    if (!file) return head;
    if ('failed' in file) return `${head}\n  ${t(file.failed as ServerKey, { name: '' }).trim()}`;
    const path = join(this.chatFolder(botId, row.chat), file.name);
    return `${head}\n  ${t('whatsapp.groupFile', { path, size: file.size })}`;
  }

  /**
   * Hands a chat's new messages to the routines that read it, with the messages before them for
   * context. The chat's place in the store moves on only once every routine has the batch, so a
   * restart or a busy routine hands it again later instead of losing it.
   */
  private async handOver(chat: string) {
    this.waits.delete(chat);
    const [row] = await this.ctx.db
      .select()
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, chat))
      .limit(1);
    if (!row) return;
    if (row.kind === 'group' ? !this.followed.has(chat) : !this.people) return;
    // A batch a busy routine did not take goes out again as it was, nothing added to it.
    const held = row.heldSeq !== null && row.heldSeq > row.batchedSeq ? row.heldSeq : null;
    const fresh = await this.ctx.db
      .select()
      .from(schema.whatsappMessages)
      .where(
        and(
          eq(schema.whatsappMessages.chat, chat),
          gt(schema.whatsappMessages.seq, row.batchedSeq),
          held !== null ? lte(schema.whatsappMessages.seq, held) : undefined,
        ),
      )
      .orderBy(asc(schema.whatsappMessages.seq))
      .limit(CHAT_BATCH_MAX + 1);
    if (!fresh.length) {
      if (held !== null) await this.moveOn(chat, row.batchedSeq, {}, null);
      return;
    }
    const batch = withinChars(fresh.slice(0, CHAT_BATCH_MAX), CHAT_BATCH_CHARS);
    const last = batch[batch.length - 1]!.seq;
    const more = fresh.length > batch.length || held !== null;
    // Only the person's own lines, or left-out ones: nothing to answer; they become context.
    if (batch.every((r) => r.fromMe || r.hidden)) {
      await this.moveOn(chat, last, {}, null);
      if (more) this.waitForQuiet(chat, 0);
      return;
    }
    const before = withinChars(
      await this.ctx.db
        .select()
        .from(schema.whatsappMessages)
        .where(and(eq(schema.whatsappMessages.chat, chat), lte(schema.whatsappMessages.seq, row.batchedSeq)))
        .orderBy(desc(schema.whatsappMessages.seq))
        .limit(CHAT_CONTEXT),
      Math.max(0, CHAT_BATCH_CHARS - batch.reduce((n, r) => n + lineChars(r), 0)),
      true,
    ).reverse();
    const t = await this.services.settings.translator();
    const label = shownName(row);
    const title = label ? (row.kind === 'person' ? `${label} (+${numberOf(chat) ?? chat})` : label) : chat;
    const payloadFor = (botId: string) =>
      [
        t(row.kind === 'group' ? 'whatsapp.groupHeader' : 'whatsapp.chatHeader', { name: title }),
        t('whatsapp.chatId', { chat }),
        ...(before.length
          ? ['', t('whatsapp.chatBefore'), ...before.map((r) => this.chatLine(r, botId, t))]
          : []),
        '',
        t('whatsapp.chatNew'),
        ...batch.map((r) => this.chatLine(r, botId, t)),
      ].join('\n');
    const handed = await this.services.routines.runFromWhatsApp(
      { jid: chat, kind: row.kind, name: shownName(row) || chat, threads: row.threads },
      `${chat}:${batch[0]!.seq}-${last}`,
      payloadFor,
    );
    if (!handed.done) {
      // A routine was too busy to take it: the same batch is offered again in a while.
      await this.moveOn(chat, row.batchedSeq, handed.threads, last);
      this.waitForQuiet(chat, this.chatQuietMs);
      return;
    }
    await this.moveOn(chat, last, handed.threads, null);
    if (more) this.waitForQuiet(chat, 0);
  }

  /** Moves a chat's place in the store on to `seq`, and keeps where a batch to offer again ends. */
  private async moveOn(chat: string, seq: number, threads: Record<string, string>, held: number | null) {
    await this.ctx.db
      .update(schema.whatsappChats)
      .set({
        batchedSeq: sql`greatest(${schema.whatsappChats.batchedSeq}, ${seq})`,
        heldSeq: held,
        ...(Object.keys(threads).length && {
          threads: sql`${schema.whatsappChats.threads} || ${JSON.stringify(threads)}::jsonb`,
        }),
      })
      .where(eq(schema.whatsappChats.jid, chat));
  }

  /** Marks stored messages as waiting for a bot, or no longer waiting. */
  private async markAwaiting(seqs: number[], awaiting: boolean) {
    if (!seqs.length) return;
    await this.ctx.db
      .update(schema.whatsappMessages)
      .set({ awaiting })
      .where(inArray(schema.whatsappMessages.seq, seqs));
  }

  /**
   * Messages that were waiting for a quiet chat when the server stopped: they wait again, for the
   * bot that answers them now (the one that wrote may have dropped out of the window meanwhile).
   */
  private async resumeAwaiting() {
    const rows = await this.ctx.db
      .select({ message: schema.whatsappMessages, kind: schema.whatsappChats.kind })
      .from(schema.whatsappMessages)
      .innerJoin(schema.whatsappChats, eq(schema.whatsappChats.jid, schema.whatsappMessages.chat))
      .where(eq(schema.whatsappMessages.awaiting, true))
      .orderBy(asc(schema.whatsappMessages.seq));
    if (!rows.length) return;
    // Whatever takes them marks them again; one a routine reads in its own way stays unmarked.
    await this.markAwaiting(
      rows.map((r) => r.message.seq),
      false,
    );
    const t = await this.services.settings.translator();
    for (const { message: r, kind } of rows) {
      const said = `[${r.at.toISOString()}] ${r.writer}: ${r.text}`;
      const line = r.file ? `${said}\n  ${t('whatsapp.fileNotKept')}` : said;
      if (!(kind === 'person' && (await this.queueReply(r.chat, line, r.seq, t))))
        await this.queueContact(r.chat, kind, line, r.seq);
    }
  }

  /** Chats with messages not yet handed over, from before a restart: their batches go out again. */
  private async resumeChats() {
    const rows = await this.ctx.db
      .select({ jid: schema.whatsappChats.jid })
      .from(schema.whatsappChats)
      .where(
        exists(
          this.ctx.db
            .select({ seq: schema.whatsappMessages.seq })
            .from(schema.whatsappMessages)
            .where(
              and(
                eq(schema.whatsappMessages.chat, schema.whatsappChats.jid),
                gt(schema.whatsappMessages.seq, schema.whatsappChats.batchedSeq),
                eq(schema.whatsappMessages.fromMe, false),
                eq(schema.whatsappMessages.hidden, false),
              ),
            ),
        ),
      );
    for (const r of rows) this.waitForQuiet(r.jid);
  }

  /**
   * Drops what is older than the time chats are kept, with its files in every bot's folder, and the
   * chats left with nothing.
   */
  async prune(now = new Date()) {
    const before = new Date(now.getTime() - CHAT_KEEP_MS);
    const old = await this.ctx.db
      .delete(schema.whatsappMessages)
      .where(lt(schema.whatsappMessages.at, before))
      .returning({ chat: schema.whatsappMessages.chat, file: schema.whatsappMessages.file });
    // A settled draft's text goes with them; one whose card is still open waits for its answer.
    await this.ctx.db
      .delete(schema.whatsappDrafts)
      .where(and(ne(schema.whatsappDrafts.status, 'pending'), lt(schema.whatsappDrafts.createdAt, before)));
    const bots = await readdir(resolve(this.ctx.config.dataDir, 'workspaces', 'bots')).catch(() => []);
    for (const r of old) {
      if (!r.file || !('name' in r.file)) continue;
      for (const botId of bots) await rm(join(this.chatFolder(botId, r.chat), r.file.name), { force: true });
    }
    await this.ctx.db
      .delete(schema.whatsappChats)
      .where(
        and(
          lt(schema.whatsappChats.lastAt, before),
          notExists(
            this.ctx.db
              .select({ seq: schema.whatsappMessages.seq })
              .from(schema.whatsappMessages)
              .where(eq(schema.whatsappMessages.chat, schema.whatsappChats.jid)),
          ),
        ),
      );
  }

  // For the bots' tools

  /** The chats kept here that `reads` covers, newest first, with their last message's time. */
  async chats(limit: number, reads: ChatReads) {
    const groups = [...reads.groups];
    const covered = reads.all
      ? sql`true`
      : or(
          reads.people ? eq(schema.whatsappChats.kind, 'person') : undefined,
          groups.length ? inArray(schema.whatsappChats.jid, groups) : undefined,
          reads.chats?.size ? inArray(schema.whatsappChats.jid, [...reads.chats]) : undefined,
        );
    if (!covered) return [];
    const rows = await this.ctx.db
      .select({
        jid: schema.whatsappChats.jid,
        kind: schema.whatsappChats.kind,
        name: schema.whatsappChats.name,
        savedName: schema.whatsappChats.savedName,
        lastAt: schema.whatsappChats.lastAt,
      })
      .from(schema.whatsappChats)
      .where(covered)
      .orderBy(desc(schema.whatsappChats.lastAt))
      .limit(limit);
    return rows.map(({ savedName, ...r }) => ({ ...r, name: shownName({ name: r.name, savedName }) }));
  }

  /** A chat's last messages as `botId` reads them; null when it is not kept here or not the bot's. */
  async history(chat: string, limit: number, botId: string, reads: ChatReads): Promise<string | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, chat))
      .limit(1);
    if (!row || !covers(reads, row)) return null;
    const rows = (
      await this.ctx.db
        .select()
        .from(schema.whatsappMessages)
        .where(eq(schema.whatsappMessages.chat, chat))
        .orderBy(desc(schema.whatsappMessages.seq))
        .limit(limit)
    ).reverse();
    const t = await this.services.settings.translator();
    const title = shownName(row) || chat;
    return [
      t(row.kind === 'group' ? 'whatsapp.groupHeader' : 'whatsapp.chatHeader', { name: title }),
      t('whatsapp.chatId', { chat }),
      '',
      ...rows.map((r) => this.chatLine(r, botId, t)),
    ].join('\n');
  }

  /** Whether a chat is kept here, and `reads` covers it when given: only those can be answered. */
  async knownChat(
    chat: string,
    reads?: ChatReads,
  ): Promise<{ name: string; kind: 'person' | 'group' } | null> {
    const [row] = await this.ctx.db
      .select({
        jid: schema.whatsappChats.jid,
        name: schema.whatsappChats.name,
        savedName: schema.whatsappChats.savedName,
        kind: schema.whatsappChats.kind,
      })
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.jid, chat))
      .limit(1);
    if (!row || (reads && !covers(reads, row))) return null;
    return { name: shownName(row), kind: row.kind };
  }

  /** Who sees a Status post: the people whose chats are kept here. */
  async statusAudience(): Promise<string[]> {
    const rows = await this.ctx.db
      .select({ jid: schema.whatsappChats.jid })
      .from(schema.whatsappChats)
      .where(eq(schema.whatsappChats.kind, 'person'));
    return rows.map((r) => r.jid).filter((j) => j.endsWith('@s.whatsapp.net'));
  }

  /**
   * Sends the drafts whose cards were answered "send", and lets go of the ones turned down. Run on
   * every card answer and at each connect; a draft is claimed before it is sent, so it goes once.
   */
  private async settleDrafts() {
    if (this.stopped) return;
    const rows = await this.ctx.db
      .select({
        draft: schema.whatsappDrafts,
        status: schema.approvals.status,
        answer: schema.approvals.answer,
        options: schema.approvals.options,
        by: schema.approvals.decidedByUserId,
      })
      .from(schema.whatsappDrafts)
      .innerJoin(schema.approvals, eq(schema.approvals.id, schema.whatsappDrafts.approvalId))
      .where(and(eq(schema.whatsappDrafts.status, 'pending'), ne(schema.approvals.status, 'pending')));
    for (const { draft, status, answer, options, by } of rows) {
      const send = status === 'allowed' && answer === draft.approve;
      if (!send) {
        // Words the person wrote on the card in place of a button are meant for the bot: it reads
        // them and goes on, as it would a message in the chat. Dropped as a plain "no", they read
        // to the person as if the bot ignored them.
        const words =
          status === 'allowed' && answer?.trim() && !options.includes(answer) ? answer.trim() : '';
        const [dropped] = await this.ctx.db
          .update(schema.whatsappDrafts)
          .set({ status: 'dropped' })
          .where(and(eq(schema.whatsappDrafts.id, draft.id), eq(schema.whatsappDrafts.status, 'pending')))
          .returning();
        if (!dropped) continue;
        await this.answerNote(draft, words ? 'answered' : 'dropped');
        if (words) await this.answerTurn(draft, words, by);
        continue;
      }
      // Sent only while connected; otherwise it waits for the next connect.
      if (this.state !== 'connected') continue;
      const [claimed] = await this.ctx.db
        .update(schema.whatsappDrafts)
        .set({ status: 'sent', sentAt: new Date() })
        .where(and(eq(schema.whatsappDrafts.id, draft.id), eq(schema.whatsappDrafts.status, 'pending')))
        .returning();
      if (!claimed) continue;
      const t = await this.services.settings.translator();
      try {
        if (draft.kind === 'status') await this.postStatus(draft);
        else await this.sendDraft(draft, t);
      } catch (err) {
        console.warn('whatsapp draft', errorText(err));
        await this.ctx.db
          .update(schema.whatsappDrafts)
          .set({ status: 'failed' })
          .where(eq(schema.whatsappDrafts.id, draft.id));
        await this.answerNote(draft, 'failed', errorText(err));
        continue;
      }
      // Sent: whatever goes wrong after this does not make it look unsent, which would get it sent twice.
      await this.answerNote(draft, 'sent').catch((err: unknown) =>
        console.warn('whatsapp draft note', errorText(err)),
      );
    }
  }

  /**
   * The note on a card's answer. The bot's reply is posted only when its turn ends, so a card
   * answered while that turn still runs gets its note below the reply: written above it, the
   * reply (made before the answer) would read as the bot getting the note wrong. Held in memory;
   * a server stop writes it as the turn ends, a crash loses it (the draft row keeps the outcome).
   */
  private async answerNote(
    draft: typeof schema.whatsappDrafts.$inferSelect,
    outcome: 'sent' | 'dropped' | 'answered' | 'failed',
    error = '',
  ) {
    const write = () => this.draftNote(draft, outcome, error);
    if (!this.services.turns.afterTurn(draft.threadId, write)) await write();
  }

  /** Starts the bot that made a draft on the words the person wrote on its card instead. */
  private async answerTurn(
    draft: typeof schema.whatsappDrafts.$inferSelect,
    words: string,
    by: string | null,
  ) {
    const t = await this.services.settings.translator();
    await this.services.turns
      .enqueue({
        threadId: draft.threadId,
        botId: draft.botId,
        source: 'user',
        prompt: t('whatsapp.draftAnsweredPrompt', {
          to: draft.kind === 'status' ? t('whatsapp.statusName') : await this.draftTo(draft),
          answer: words,
          text: this.draftSaid(draft),
        }),
        ...(by && { userId: by }),
      })
      .catch((err: unknown) => console.warn('whatsapp draft answer', errorText(err)));
  }

  /** Whom a draft is for, by name and number as the person knows the chat. */
  private async draftTo(draft: typeof schema.whatsappDrafts.$inferSelect): Promise<string> {
    const chat = draft.chat ?? '';
    const known = chat ? await this.knownChat(chat) : null;
    const number = chat.replace(/@.*$/, '');
    return known?.name ? `${known.name} (${number})` : `+${number}`;
  }

  /** What a draft says: its text, or the name of the file it sends. */
  private draftSaid(draft: typeof schema.whatsappDrafts.$inferSelect): string {
    return draft.text || (draft.file ? (draft.file.split('/').pop() ?? '') : '');
  }

  /**
   * Says in the conversation the draft was made in what became of it, with whom it was for and
   * what it said: the person's record of what went out, and the bot's, which reads it with its
   * next message there.
   */
  async draftNote(
    draft: typeof schema.whatsappDrafts.$inferSelect,
    outcome: 'sent' | 'dropped' | 'answered' | 'failed',
    error = '',
  ) {
    const t = await this.services.settings.translator();
    let text: string;
    if (draft.kind === 'status') {
      text =
        outcome === 'sent'
          ? t('whatsapp.statusPosted')
          : outcome === 'dropped'
            ? t('whatsapp.statusDropped')
            : outcome === 'answered'
              ? t('whatsapp.statusAnswered')
              : t('whatsapp.draftFailed', { message: error });
    } else {
      const to = await this.draftTo(draft);
      const said = this.draftSaid(draft);
      text =
        outcome === 'sent'
          ? t('whatsapp.draftSent', { to, text: said })
          : outcome === 'dropped'
            ? t('whatsapp.draftDropped', { to, text: said })
            : outcome === 'answered'
              ? t('whatsapp.draftAnswered', { to, text: said })
              : t('whatsapp.draftFailedTo', { to, text: said, message: error });
    }
    await this.services.threads.addMessage({
      threadId: draft.threadId,
      role: outcome === 'failed' ? 'error' : 'assistant',
      author: `bot:${draft.botId}`,
      text,
      props: { whatsappDraft: draft.id },
    });
  }

  /** What a draft's file is sent as, or nothing when it has none or it is gone. */
  private async draftFile(draft: typeof schema.whatsappDrafts.$inferSelect) {
    if (!draft.file) return null;
    const size = (await stat(draft.file)).size;
    if (size > SEND_MAX) throw new Error('file too large');
    const name = draft.file.split('/').pop() ?? 'file';
    const mime = mimeOf(name);
    return mime.startsWith('image/')
      ? { image: { url: draft.file }, mimetype: mime }
      : { document: { url: draft.file }, fileName: name, mimetype: mime };
  }

  /** Sends an approved reply into the chat it answers, and keeps it there as the person's own line. */
  private async sendDraft(draft: typeof schema.whatsappDrafts.$inferSelect, t: T) {
    const chat = draft.chat!;
    const socket = this.socket;
    if (!socket) throw new Error('not connected');
    const known = await this.knownChat(chat);
    // Groups are only read, whatever a draft says.
    if (known && known.kind !== 'person') throw new Error('WhatsApp groups are never written to');
    if (!known) {
      // Someone who never wrote: a number the bot checked was on WhatsApp before drafting.
      if (!/^\d{7,15}@s\.whatsapp\.net$/.test(chat)) throw new Error('chat not found');
      await this.ctx.db
        .insert(schema.whatsappChats)
        .values({ jid: chat, kind: 'person', name: '', lastAt: new Date() })
        .onConflictDoNothing();
    }
    const file = await this.draftFile(draft);
    const content = file ? { ...file, ...(draft.text && { caption: draft.text }) } : { text: draft.text };
    const messageId = waMessageId();
    this.sentIds.add(messageId);
    const sent = await socket.sendMessage(chat, content, { messageId });
    const id = sent?.key?.id ?? messageId;
    if (sent?.message) this.sentBodies.set(id, { message: sent.message, at: Date.now() });
    await this.ctx.db
      .insert(schema.whatsappMessages)
      .values({
        chat,
        externalId: id,
        fromMe: true,
        writer: t('whatsapp.groupYou'),
        text: draft.text,
        at: new Date(),
        ...(draft.file && { file: { failed: 'whatsapp.draftFileSent' } }),
      })
      .onConflictDoNothing()
      .catch((err: unknown) => console.warn('whatsapp sent line', errorText(err)));
  }

  /** Posts an approved Status to the people whose chats are kept here. */
  private async postStatus(draft: typeof schema.whatsappDrafts.$inferSelect) {
    const socket = this.socket;
    if (!socket) throw new Error('WhatsApp is not connected');
    const audience = await this.statusAudience();
    if (!audience.length) throw new Error('nobody to show it to');
    const file = await this.draftFile(draft);
    const content = file ? { ...file, ...(draft.text && { caption: draft.text }) } : { text: draft.text };
    const messageId = waMessageId();
    this.sentIds.add(messageId);
    await socket.sendMessage(STATUS_JID, content, { messageId, statusJidList: audience, broadcast: true });
  }

  /**
   * Whether the self chat is being flooded, which happens when another bot answers on the same
   * number: requests pause for a while and the person is told. A request that comes during the pause
   * is not passed on, but the person hears so (at most once a minute) and when to write again;
   * commands and card answers still work, so they can stop what is going on.
   */
  private async looping(jid: string, t: T): Promise<boolean> {
    const now = Date.now();
    if (now < this.pausedUntil) {
      if (now - this.heldNoteAt >= 60_000) {
        this.heldNoteAt = now;
        const minutes = Math.max(1, Math.ceil((this.pausedUntil - now) / 60_000));
        await this.say(jid, t('channel.loopHeld', { minutes })).catch(() => {});
      }
      return true;
    }
    this.requestTimes.push(now);
    const longest = Math.max(...LOOP_LIMITS.map((l) => l.ms));
    this.requestTimes = this.requestTimes.filter((at) => now - at <= longest);
    const flood = LOOP_LIMITS.some(
      (l) => this.requestTimes.filter((at) => now - at <= l.ms).length > l.count,
    );
    if (!flood) return false;
    this.pausedUntil = now + LOOP_PAUSE_MS;
    this.requestTimes = [];
    this.heldNoteAt = now;
    await this.say(jid, t('channel.loopPaused')).catch(() => {});
    return true;
  }

  private async handle(socket: WaSocket, row: Row, jid: string, m: WaMessage, stamp: number) {
    const t = await this.services.settings.translator();
    const content = contentOf(m);
    const { media, forwarded, quoted } = content;
    const text = (content.text || cardsText(content.cards, t)).trim();
    // `/bot` names the bot the messages go to; a forwarded `/bot` is only text.
    const pick = forwarded ? null : /^\/bot(?:\s+(.+))?$/i.exec(text);
    if (pick) {
      await this.pickBot(jid, row, pick[1]?.trim(), t);
      return;
    }
    const bot = row.botId ? await this.services.bots.get(row.botId).catch(() => null) : null;
    if (!bot) {
      await this.say(jid, t('channel.noBot'));
      return;
    }
    if (bot.archivedAt) {
      await this.say(jid, t('channel.botArchived'));
      return;
    }
    // The conversation of the person who set the chat up.
    const thread = await this.services.threads.main(bot.id, row.userId);
    if (!media && !forwarded) {
      const done = await chatCommand(this.services, thread.id, text, t);
      if (done) {
        await this.say(jid, done);
        return;
      }
      // A number answers the card when the card is the last thing sent here, the way a button
      // would; "always allow" takes the number and a word, so a stray digit never keeps a rule.
      const word = t('channel.alwaysWord').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const numbered = new RegExp(`^(\\d{1,2})(?:\\s+(${word}))?$`, 'iu').exec(text);
      if (numbered && (await this.answeredCard(jid, thread.id, Number(numbered[1]), !!numbered[2], t)))
        return;
    }
    // An empty or unreadable message starts nothing, so it must not count toward the flood guard.
    if (!text && !media && !quoted?.media) return;
    // Only what would start the bot counts toward the flood guard; commands and card answers do not.
    if ((row.settings as Settings).mode === 'own' && (await this.looping(jid, t))) return;
    const files: string[] = [];
    const failed: string[] = [];
    const tooLarge: string[] = [];
    const fetchFile = async (target: WaMessage, name: string, size: number | undefined, log: string) => {
      if ((size ?? 0) > RECEIVE_MAX) {
        tooLarge.push(name);
        await this.say(jid, t('channel.fileTooLarge', { name }));
        return;
      }
      try {
        const body = await this.lib!.download(target, socket);
        files.push((await saveUpload(stagingDir(this.ctx.config.dataDir, thread.id), name, body)).name);
      } catch (err) {
        console.warn(log, errorText(err));
        failed.push(name);
        await this.say(jid, t('channel.fileFailed', { name }));
      }
    };
    if (media) {
      const name = receivedName(media.kind, m.key.id ?? newId().slice(0, 8), media.mime, media.name);
      await fetchFile(m, name, media.size, 'whatsapp file');
    }
    // A reply to a message: one of ours is quoted by the app; another one's text and file come along.
    const replyTo = quoted?.id ? await this.ours(row.id, quoted.id) : null;
    let quote = '';
    if (quoted && !replyTo) {
      quote = quoted.text.trim();
      if (quoted.media) {
        const name = receivedName(
          quoted.media.kind,
          quoted.id ?? newId().slice(0, 8),
          quoted.media.mime,
          quoted.media.name,
        );
        await fetchFile(
          { key: { remoteJid: m.key.remoteJid, id: quoted.id }, message: quoted.message },
          name,
          quoted.media.size,
          'whatsapp quoted file',
        );
      }
    }
    if (!text && !files.length) return;
    // A quoted message not known here may be anyone's words (a forward, a message from before this
    // device): the message carries it as outside text, so it is never taken as the person's request.
    const outside = forwarded || quoted?.forwarded ? 'forward' : quoted && !replyTo ? 'stored' : null;
    const quoteBlock = quote
      ? `${quote
          .split('\n')
          .map((l) => `> ${l}`)
          .join('\n')}\n\n`
      : '';
    // Against the settings as they are now: a message handled alongside may have moved it on.
    await this.saveSettings(row, (now) => ({
      threadId: thread.id,
      seenAt: Math.max(now.seenAt ?? 0, stamp) || undefined,
    }));
    // Noted before the turn can start, so a restart in the middle leaves a trace to settle.
    await holdRequest(this.ctx, row.id, thread.id, { jid });
    this.working.add(thread.id);
    let message;
    try {
      ({ message } = await this.services.inbox.send(thread.id, {
        // Files that did not arrive are said to the bot too, or it would answer as if it had them.
        text: withMissingFiles(`${quoteBlock}${text}`, { failed, tooLarge }, t),
        files,
        clientId: `whatsapp:${(m.key.id ?? newId()).slice(0, 48)}`,
        userId: row.userId,
        ...(replyTo && { replyTo }),
        props: { via: 'whatsapp', ...(outside && { outside }) },
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
    if (m.key.id) await this.remember(row.id, m.key.id, message.id);
  }

  /** Keeps which message here a WhatsApp message is, so a reply to it can be found. */
  private async remember(channelId: string, externalId: string, messageId: string) {
    await this.ctx.db
      .insert(schema.channelMessages)
      .values({ channelId, externalId, messageId })
      .onConflictDoNothing()
      .catch(() => {});
  }

  /** The message here that a WhatsApp message is, when it is one we know. */
  private async ours(channelId: string, externalId: string): Promise<string | null> {
    const [found] = await this.ctx.db
      .select({ messageId: schema.channelMessages.messageId })
      .from(schema.channelMessages)
      .where(
        and(
          eq(schema.channelMessages.channelId, channelId),
          eq(schema.channelMessages.externalId, externalId),
        ),
      )
      .limit(1);
    return found?.messageId ?? null;
  }

  private async pickBot(jid: string, row: Row, name: string | undefined, t: T) {
    // Only bots the person who set the chat up may talk with.
    const reached = new Set(
      await this.services.access.botIds(await this.services.access.viewerOf(row.userId), 'chat'),
    );
    const bots = (await this.services.bots.list()).filter((b) => !b.archivedAt && reached.has(b.id));
    const names = bots.map((b) => b.name).join(', ');
    if (!name) {
      const current = bots.find((b) => b.id === row.botId);
      await this.say(
        jid,
        current ? t('channel.current', { bot: current.name, bots: names }) : t('channel.noBot'),
      );
      return;
    }
    const want = name.toLocaleLowerCase('tr');
    const bot: Bot | undefined =
      bots.find((b) => b.name.toLocaleLowerCase('tr') === want) ??
      bots.find((b) => b.name.toLocaleLowerCase('tr').startsWith(want));
    if (!bot) {
      await this.say(jid, t('channel.unknownBot', { name, bots: names }));
      return;
    }
    await this.ctx.db.update(schema.channels).set({ botId: bot.id }).where(eq(schema.channels.id, row.id));
    this.changed();
    await this.say(jid, t('channel.switched', { bot: bot.name }));
  }

  /**
   * Answers the card the numbered choices were sent for, when it is still open and nothing was
   * sent here after it. `always`: the person wrote the word for "always allow" after the number,
   * which alone keeps a rule; a bare number for that choice is answered with how to write it.
   */
  private async answeredCard(
    jid: string,
    threadId: string,
    n: number,
    always: boolean,
    t: T,
  ): Promise<boolean> {
    const row = await this.row();
    const card = (row?.settings as { card?: { threadId: string; choices: string[] } } | undefined)?.card;
    if (!this.cardLast || this.lastSent !== this.cardLast) return false;
    const data = card && card.threadId === threadId ? card.choices[n - 1] : undefined;
    if (!data) return false;
    const [kind, approvalId, value] = data.split(':') as ['a' | 'q', string, string];
    const approval = await this.services.approvals.get(approvalId).catch(() => null);
    if (!approval || approval.status !== 'pending') return false;
    if (always !== (kind === 'a' && value === 'r')) {
      if (always) return false;
      await this.say(jid, t('channel.alwaysByWord', { answer: `${n} ${t('channel.alwaysWord')}` }));
      // The card is still the one the next number answers.
      this.cardLast = this.lastSent;
      return true;
    }
    try {
      if (kind === 'a') {
        // Answered as the person who linked WhatsApp, so "always allow" is theirs to give.
        const after = await this.services.approvals.answer(
          approvalId,
          { decision: value === 'n' ? 'deny' : 'allow', remember: value === 'r' },
          row?.userId ?? null,
        );
        // The first yes of a step that needs two people leaves it waiting for the second.
        if (after.status === 'pending') await this.say(jid, t('channel.waitingSecond'));
      } else {
        const { items } = questionItems(approval);
        const option = items.length === 1 ? items[0]!.options[Number(value)] : undefined;
        if (!option) return false;
        await this.services.approvals.answer(
          approvalId,
          { decision: 'allow', answer: option, remember: false },
          row?.userId ?? null,
        );
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return false;
      if (err instanceof HttpError && err.status === 403) {
        await this.say(jid, err.localized(t));
        return true;
      }
      throw err;
    }
    return true;
  }

  // Writing to WhatsApp

  /**
   * Where replies go: "Message yourself", or the person's own number. Not only while connected: a
   * reply written while the connection is down waits for it (see `online`).
   */
  private async chat(): Promise<{ row: Row; jid: string } | null> {
    const row = await this.row();
    if (!row || this.state === 'off' || this.state === 'error') return null;
    const settings = row.settings as Settings;
    const own = (row.account as { number?: string }).number;
    const number = settings.mode === 'own' ? own : settings.phone;
    return number ? { row, jid: `${number}@s.whatsapp.net` } : null;
  }

  private async outgoing(m: Message) {
    if (this.stopped || !['assistant', 'approval', 'error'].includes(m.role)) return;
    const target = await this.chat();
    if (!target) return;
    const { row, jid } = target;
    const settings = row.settings as Settings;
    const thread = await this.services.threads.row(m.threadId).catch(() => null);
    if (!thread) return;
    const here = settings.threadId === m.threadId && (await lastWroteVia(this.ctx, m.threadId, 'whatsapp'));
    const t = await this.services.settings.translator();
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
      if (settings.notices === false || thread.botId !== row.botId) return;
      if (!report || m.role !== 'assistant' || !m.text.trim()) return;
      await this.deliver(async () => {
        // A report with nothing numbered in it leaves a number to the card sent before it.
        const answerable = this.cardLast !== null && this.cardLast === this.lastSent && !numbered(m.text);
        await this.markdown(jid, headed(), m.id);
        if (answerable) this.cardLast = this.lastSent;
      });
      return;
    }
    await this.deliver(async () => {
      if (m.role === 'approval') {
        const card = await this.services.approvals.get(String(m.props.approvalId)).catch(() => null);
        if (!card || card.status !== 'pending') return;
        const view = cardView(card, m.props, t, await this.services.settings.locale());
        const how = (i: number) => t('channel.alwaysHow', { answer: `${i + 1} ${t('channel.alwaysWord')}` });
        const choices = view.buttons
          .map((b, i) => `${i + 1}. ${b.label}${b.data.endsWith(':r') ? ` (${how(i)})` : ''}`)
          .join('\n');
        await this.markdown(jid, choices ? `${view.text}\n\n${choices}` : view.text);
        // A number answers this card only while nothing else was sent after it.
        this.cardLast = this.lastSent;
        const latest = await this.row();
        if (latest) {
          await this.saveSettings(latest, {
            card: { threadId: m.threadId, choices: view.buttons.map((b) => b.data) },
          });
        }
        return;
      }
      if (m.role === 'error') return this.markdown(jid, `⚠️ ${m.text}`);
      if (m.author !== `bot:${thread.botId}`) return;
      if (m.text.trim()) {
        // A report with nothing numbered in it leaves a number to the card sent before it.
        const answerable =
          report && this.cardLast !== null && this.cardLast === this.lastSent && !numbered(m.text);
        await this.markdown(jid, report ? headed() : m.text, m.id);
        if (answerable) this.cardLast = this.lastSent;
      }
      for (const f of messageFiles(m)) {
        const path = join(this.ctx.config.dataDir, 'workspaces', f.path);
        const size = await stat(path).then(
          (s) => s.size,
          () => -1,
        );
        // Inside the queue already: written straight away, not queued behind this job.
        if (size < 0 || size > SEND_MAX) {
          await this.markdown(jid, t('channel.fileInApp', { name: f.name }));
          continue;
        }
        try {
          const id = await this.send(jid, {
            document: { url: path },
            fileName: f.name,
            mimetype: mimeOf(f.name),
          });
          if (id) await this.mark(id, m.id);
        } catch (err) {
          console.warn('whatsapp send file', errorText(err));
          await this.markdown(jid, t('channel.fileInApp', { name: f.name }));
        }
      }
    });
  }

  /** Sends Markdown as WhatsApp text; with `messageId`, a reply to what was sent finds that message. */
  private async markdown(jid: string, md: string, messageId?: string) {
    for (const part of whatsappMessages(md)) {
      const id = await this.send(jid, { text: part });
      if (id && messageId) await this.mark(id, messageId);
    }
  }

  /** Keeps a message sent to WhatsApp as the message here it came from. */
  private async mark(externalId: string, messageId: string) {
    const row = await this.row();
    if (row) await this.remember(row.id, externalId, messageId);
  }

  /** A short line outside the order of replies (a command's answer). */
  private async say(jid: string, text: string) {
    await this.deliver(() => this.markdown(jid, text));
  }

  /**
   * Runs the sends of one reply in the chat's order. When some of it could not be delivered, the
   * person is told once that the rest is in the app, as soon as the connection allows.
   */
  private async deliver(job: () => Promise<void>) {
    const ok = await this.sends.run('wa', job);
    if (!ok && !this.stopped) this.undelivered = true;
    await this.tellUndelivered();
  }

  private async tellUndelivered() {
    if (!this.undelivered || this.stopped || this.state !== 'connected') return;
    const target = await this.chat();
    if (!target) return;
    this.undelivered = false;
    const t = await this.services.settings.translator();
    // Not through `deliver`: this note failing is only logged, it does not ask for another note.
    await this.sends.run('wa', () => this.markdown(target.jid, t('channel.notDelivered')));
  }

  /** What was sent lately, for WhatsApp's resend requests when the phone could not read a reply. */
  private sentMessage(id: string | null | undefined): Record<string, unknown> | undefined {
    const found = id ? this.sentBodies.get(id) : undefined;
    return found && Date.now() - found.at < SENT_KEEP_MS ? found.message : undefined;
  }

  private async send(jid: string, content: Record<string, unknown>): Promise<string | null> {
    // Groups are only read: whatever goes wrong elsewhere, nothing is written to one.
    if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) throw new Error('WhatsApp only writes to a person');
    let socket = await this.online();
    if (!socket) throw new Error('WhatsApp is not connected');
    // One chat is posted to at a time (the send queue); this keeps its posts from coming in a burst.
    const wait = (this.lastPost.get(jid) ?? 0) + this.paceMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    // The id is chosen here and kept for a second try: should the first have gone through after
    // all, WhatsApp takes the second as the same message and the person sees it once.
    const messageId = waMessageId();
    // Known as ours before WhatsApp hands it back, which can happen before the send returns.
    this.sentIds.add(messageId);
    let sent;
    try {
      sent = await socket.sendMessage(jid, content, { messageId });
    } catch (err) {
      // The connection dropped under the send: once it is back, the send is tried again, once.
      if (this.socket === socket && this.state === 'connected') throw err;
      socket = await this.online();
      if (!socket) throw err;
      sent = await socket.sendMessage(jid, content, { messageId });
    }
    this.lastPost.set(jid, Date.now());
    const id = sent?.key?.id;
    this.lastSent = id ?? newId();
    if (id) {
      this.sentIds.add(id);
      // Only recent ones matter: WhatsApp hands a sent message back at once.
      if (this.sentIds.size > 500) this.sentIds.delete(this.sentIds.values().next().value!);
      if (sent?.message) {
        this.sentBodies.set(id, { message: sent.message, at: Date.now() });
        if (this.sentBodies.size > SENT_KEPT) this.sentBodies.delete(this.sentBodies.keys().next().value!);
      }
    }
    return id ?? null;
  }

  private async turnState(e: TurnEvent) {
    const target = await this.chat();
    const settings = (target?.row.settings ?? {}) as Settings;
    const active =
      !!target &&
      this.state === 'connected' &&
      settings.threadId === e.threadId &&
      (e.state === 'running' || e.state === 'queued') &&
      (await lastWroteVia(this.ctx, e.threadId, 'whatsapp'));
    const timer = this.typing.get(e.threadId);
    if (!active) {
      if (timer) {
        clearInterval(timer);
        this.typing.delete(e.threadId);
        if (target) void this.socket?.sendPresenceUpdate('paused', target.jid).catch(() => {});
      }
      if (e.state === 'idle') await this.finished(e.threadId);
      return;
    }
    if (timer || this.stopped) return;
    const send = () => void this.socket?.sendPresenceUpdate('composing', target.jid).catch(() => {});
    send();
    const next = setInterval(send, 8000);
    next.unref?.();
    this.typing.set(e.threadId, next);
  }

  /**
   * The bot is done with a request from WhatsApp: the note of it goes, and when it ended well but
   * said nothing, the person hears that instead of only seeing "typing…" stop.
   */
  private async finished(threadId: string) {
    if (!this.working.delete(threadId)) return;
    const row = await this.row();
    if (!row) return;
    await dropRequest(this.ctx, row.id, threadId);
    if (this.stopped) return;
    if (!(await saidNothing(this.ctx, threadId))) return;
    const target = await this.chat();
    if (!target) return;
    const t = await this.services.settings.translator();
    await this.deliver(() => this.markdown(target.jid, t('channel.noAnswer')));
  }

  private async notice(e: NoticeEvent) {
    if (this.stopped || e.kind === 'reply') return;
    const target = await this.chat();
    if (!target || target.row.botId !== e.botId) return;
    const settings = target.row.settings as Settings;
    if (settings.notices === false) return;
    // A step waiting for this person's second yes: told to them alone, with no conversation named.
    if (e.to) {
      if (!e.to.includes(target.row.userId)) return;
      const t = await this.services.settings.translator();
      await this.say(target.jid, t('channel.noticeSecond', { text: e.text }));
      return;
    }
    // Only of the person's own conversations, or the bot's own work they may change.
    if (!(await this.services.access.noticeAudience(e.threadId)).includes(target.row.userId)) return;
    // Its cards come as cards there, or the person is in the app with it.
    if (settings.threadId === e.threadId) return;
    const t = await this.services.settings.translator();
    const thread = await this.services.threads.row(e.threadId).catch(() => null);
    const title = thread?.title || t('channel.otherChat');
    await this.say(
      target.jid,
      t(e.kind === 'error' ? 'channel.noticeError' : 'channel.noticeNeedsYou', { title, text: e.text }),
    );
  }

  // Records

  private async row(): Promise<Row | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.kind, 'whatsapp'))
      .limit(1);
    return row ?? null;
  }

  /** Changes some settings; `patch` may be worked out from the settings as they are when saved. */
  private async saveSettings(
    row: Row,
    patch: Record<string, unknown> | ((now: Settings) => Record<string, unknown>),
  ) {
    const latest = (await this.row()) ?? row;
    const changes = typeof patch === 'function' ? patch(latest.settings as Settings) : patch;
    await this.ctx.db
      .update(schema.channels)
      .set({ settings: { ...latest.settings, ...changes } })
      .where(eq(schema.channels.id, row.id));
  }

  /** A stored key; `ns` is the prefix of the device being used, or '' for keys of no device. */
  private async key(key: string, ns = this.ns): Promise<string | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.whatsappKeys)
      .where(eq(schema.whatsappKeys.key, `${ns}${key}`))
      .limit(1);
    if (!row) return null;
    try {
      return this.vault.open(row.value);
    } catch {
      // Not the same as no key: a saved key that cannot be opened must never be taken for a missing
      // one, or fresh keys would be written over the link.
      throw new UnreadableKey();
    }
  }

  /** Runs a change of the keys after the ones asked before it, so the order they were asked in holds. */
  private ordered<T>(job: () => Promise<T>): Promise<T> {
    const run = this.writes.then(job);
    this.writes = run.catch(() => {});
    return run;
  }

  /** Writes keys in one transaction; `plain` keys belong to no device and ignore the link prefix. */
  private setKeys(values: Record<string, string | null>, plain = false): Promise<void> {
    return this.ordered(async () => {
      const ns = plain ? '' : this.ns;
      await this.ctx.db.transaction(async (tx) => {
        for (const [name, value] of Object.entries(values)) {
          const key = `${ns}${name}`;
          if (value === null) {
            await tx.delete(schema.whatsappKeys).where(eq(schema.whatsappKeys.key, key));
            continue;
          }
          const sealed = this.vault.seal(value);
          await tx
            .insert(schema.whatsappKeys)
            .values({ key, value: sealed })
            .onConflictDoUpdate({ target: schema.whatsappKeys.key, set: { value: sealed } });
        }
      });
    });
  }

  /** The phone book of an account that is no longer linked is not kept. */
  private async forgetSavedNames() {
    this.savedNames.clear();
    await this.ctx.db.delete(schema.whatsappSavedNames);
  }

  /** The keys of a device that is gone; keys of no device stay. */
  private wipeKeys(): Promise<void> {
    return this.ordered(async () => {
      await this.ctx.db.delete(schema.whatsappKeys).where(not(like(schema.whatsappKeys.key, `${META_NS}%`)));
    });
  }

  /** The keys of a link that did not finish. */
  private dropNs(): Promise<void> {
    return this.ordered(async () => {
      await this.ctx.db.delete(schema.whatsappKeys).where(like(schema.whatsappKeys.key, `${LINK_NS}%`));
    });
  }

  /**
   * The new device is saved: the device that was linked before goes, and the new keys take their
   * place, all at once, so there is never a moment with neither.
   */
  private async promote() {
    await this.flushCreds();
    await this.ordered(async () => {
      await this.ctx.db.transaction(async (tx) => {
        await tx
          .delete(schema.whatsappKeys)
          .where(
            and(
              not(like(schema.whatsappKeys.key, `${LINK_NS}%`)),
              not(like(schema.whatsappKeys.key, `${META_NS}%`)),
            ),
          );
        await tx
          .update(schema.whatsappKeys)
          .set({ key: sql`substr(${schema.whatsappKeys.key}, ${LINK_NS.length + 1})` })
          .where(like(schema.whatsappKeys.key, `${LINK_NS}%`));
      });
      this.ns = '';
    });
  }

  /** Keys of a kind, e.g. every session; only for tests and checks. */
  async keyCount(prefix = ''): Promise<number> {
    const rows = await this.ctx.db
      .select({ key: schema.whatsappKeys.key })
      .from(schema.whatsappKeys)
      .where(like(schema.whatsappKeys.key, `${prefix}%`));
    return rows.length;
  }

  private changed() {
    this.ctx.bus.refresh({ scope: 'channels' });
  }
}

/** A name as one line: WhatsApp names and group subjects may hold line breaks. */
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 100);

/** The chats a bot's routines read: the groups they follow, and people's chats when one reads those. */
export interface ChatReads {
  groups: Set<string>;
  people: boolean;
  /** Every chat kept here: the bots may read them all. */
  all?: boolean;
  /** Chats reached one by one: the one whose reply woke the bot. */
  chats?: Set<string>;
}

function covers(reads: ChatReads, chat: { jid: string; kind: 'person' | 'group' }): boolean {
  if (reads.all || reads.chats?.has(chat.jid)) return true;
  return chat.kind === 'group' ? reads.groups.has(chat.jid) : reads.people;
}

/** About how long a stored message is as a bot reads it. */
function lineChars(r: { writer: string; text: string }): number {
  return r.writer.length + r.text.length + 40;
}

/**
 * The first messages of `rows` that fit in `chars`: always at least one unless `orNone`, so a
 * batch moves on even past a message longer than the rest.
 */
function withinChars<R extends { writer: string; text: string }>(
  rows: R[],
  chars: number,
  orNone = false,
): R[] {
  let used = 0;
  let n = 0;
  for (const r of rows) {
    used += lineChars(r);
    if (used > chars && (n > 0 || orNone)) break;
    n++;
  }
  return rows.slice(0, n);
}

/**
 * Whether a text holds a numbered line ("1. ...", "2) ..."): a number typed after it may mean one
 * of those, so it no longer answers the card sent before it.
 */
function numbered(text: string): boolean {
  return /^\s*\d{1,2}\s*[.)-]\s/m.test(text);
}

/** A message id in the form WhatsApp's own clients use. */
const waMessageId = () => `3EB0${randomBytes(18).toString('hex').toUpperCase()}`;

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
