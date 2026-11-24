import { randomInt } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  MAX_UPLOAD_BYTES,
  SLACK_BOT_SCOPES,
  SLACK_OPTIONAL_SCOPES,
  questionItems,
  type Approval,
  type Bot,
  type Message,
  type SlackLink,
  type SlackStatus,
  type TurnEvent,
} from '@leafbot/shared';
import { and, eq, like, desc, ne } from 'drizzle-orm';
import { atLeast } from '../services/access';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import type { Services } from '../services';
import type { VaultService } from '../services/vault';
import { saveUpload, stagingDir } from '../uploads';
import { OWNER_ID } from '../users';
import { HttpError, newId, truncate } from '../util';
import {
  canOpen,
  cardView,
  dropRequest,
  heldRequests,
  holdRequest,
  lastWroteVia,
  messageFiles,
  parseChoice,
  queuedTurn,
  receivedName,
  SendQueue,
  withMissingFiles,
} from './common';
import { slackMessages, slackPlain } from './format';
import { SlackApi, SlackError, slackToken, type SlackFile, type SlackMessage } from './slack-api';
import { SlackSocket, type SlackEnvelope } from './slack-socket';

type Row = typeof schema.channels.$inferSelect;
type Person = typeof schema.slackPeople.$inferSelect;

/** A link code works this long. */
const CODE_MS = 15 * 60_000;
/**
 * Link codes: ten letters and digits that are not mistaken for each other. Anyone in the workspace
 * can write to the app, and a code that fits makes them the person, so it must not be guessable.
 */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
/** Wrong codes one Slack account may send before it is not listened to for a while. */
const CODE_TRIES = 5;
/** How much of a thread the bot reads when it is called into it. */
const HISTORY_MESSAGES = 30;
const HISTORY_CHARS = 12_000;
/** Slack's limit on files the server sends. */
const SEND_MAX = 100 * 1024 * 1024;
/** How long an event is remembered, so the same message coming as a mention and as a line counts once. */
const SEEN_MS = 10 * 60_000;
/** Message kinds that are a person writing; the rest (edits, joins, bots) are not read. */
const WRITTEN = new Set([undefined, 'file_share', 'thread_broadcast']);

interface Account {
  teamId: string;
  team: string;
  botUserId: string;
  botName: string;
}

interface Tokens {
  app: string;
  bot: string;
}

/** Where in Slack a conversation's lines go: a channel, and a thread in it. */
interface Place {
  channel: string;
  threadTs?: string;
}

/**
 * Slack text as plain words: mentions as names, links as their address, Slack's escapes undone.
 * The bot's own mention is taken out; `names` gives each user's name.
 */
export function slackText(raw: string, botUserId: string, names: Map<string, string>): string {
  return raw
    .replace(new RegExp(`<@${botUserId}(\\|[^>]*)?>`, 'g'), '')
    .replace(
      /<@([A-Z0-9]+)(?:\|([^>]*))?>/g,
      (_, id: string, label?: string) => `@${names.get(id) || label || id}`,
    )
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, (_, name: string) => `#${name}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_, w: string) => `@${w}`)
    .replace(/<!subteam\^[A-Z0-9]+(?:\|([^>]*))?>/g, (_, name?: string) => name ?? '@group')
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, (_, url: string, label: string) =>
      label === url ? url : `${label} (${url})`,
    )
    .replace(/<(https?:[^>]+)>/g, (_, url: string) => url)
    .replace(/<mailto:[^|>]+\|([^>]+)>/g, (_, label: string) => label)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * The bot a message names at its start (`Sales: …`, `sales, …`) among `bots`, with the rest of the
 * message; the longest name wins, so "Sales Team" is not read as "Sales".
 */
export function namedBot<B extends { name: string }>(
  text: string,
  bots: B[],
): { bot: B; rest: string } | null {
  const lower = text.toLocaleLowerCase('tr');
  const hit = [...bots]
    .sort((a, b) => b.name.length - a.name.length)
    .find((b) => {
      const name = b.name.trim().toLocaleLowerCase('tr');
      if (!name || !lower.startsWith(name)) return false;
      return /^\s*[:,]/.test(text.slice(name.length)) || !text.slice(name.length).trim();
    });
  if (!hit) return null;
  return {
    bot: hit,
    rest: text
      .slice(hit.name.trim().length)
      .replace(/^\s*[:,]\s*/, '')
      .trim(),
  };
}

/**
 * The server's Slack app. It connects over Socket Mode, so no public address is needed. People
 * link their Slack account with a code from the app; nobody else's requests are run. A direct
 * message goes to the person's own conversation with the bot; a mention in a channel starts a team
 * conversation, which uses only what the team shares and which everyone who may talk with the bot
 * sees in the app. Once the bot is in a Slack thread, later lines there reach it without a mention.
 */
export class SlackChannel {
  private socket: SlackSocket | null = null;
  private sends = new SendQueue();
  private codes = new Map<string, { userId: string; until: number }>();
  /** Wrong codes each Slack account sent, and until when they count. */
  private misses = new Map<string, { count: number; until: number }>();
  private seen = new Map<string, number>();
  private names = new Map<string, string>();
  /** The message each running conversation answers in Slack, to mark when the bot is done. */
  private working = new Map<string, Place & { ts: string; rowId: string }>();
  /** The lines of each conversation still being sent to Slack, so its mark waits for them. */
  private lines = new SendQueue();
  /** Conversations whose reply did not reach Slack, so their message is not marked as answered. */
  private undelivered = new Set<string>();
  /** Why the bot token is refused (null while it works), and the note shown for it. */
  private tokenError: { code: string; note: string } | null = null;
  /** Permissions the app lacks, found when it connected; shown with the status, not stored. */
  private scopeNote: string | null = null;
  /** The optional permissions the bot token lacks, as Slack last listed them. */
  private optionalMissing: string[] = [];
  private unsubs: (() => void)[] = [];
  private stopped = false;
  /** Aborts on stop, so a wait for Slack's "slow down" does not hold the stop up. */
  private halting = new AbortController();

  constructor(
    private ctx: Ctx,
    private services: Services,
    private vault: VaultService,
  ) {}

  async start() {
    this.unsubs.push(this.services.threads.onMessage((m) => this.outgoing(m)));
    this.unsubs.push(this.ctx.bus.on('turn', (e) => void this.turnState(e).catch(() => {})));
    const row = await this.row();
    if (!row?.secret) return;
    // Before reading Slack again, so a message that arrives now is never taken for a stale one.
    await this.settleHeld(row).catch((err: unknown) => console.warn('slack held', err));
    await this.listen();
    void this.probe(row).catch(() => {});
  }

  /**
   * Requests that were being worked on when the server stopped are over: their 👀 goes, they show
   * the failure mark and the thread is told so the person writes again. A queued turn survives the
   * restart and still runs, so its request stays.
   */
  async settleHeld(row: Row) {
    const held = await heldRequests(this.ctx, row.id);
    if (!held.length) return;
    const t = await this.services.settings.translator();
    const api = this.botApi(row);
    for (const h of held) {
      const place = h.place as Partial<Place & { ts: string }>;
      if (await queuedTurn(this.ctx, h.threadId)) {
        if (place.channel && place.ts)
          this.working.set(h.threadId, { ...place, channel: place.channel, ts: place.ts, rowId: row.id });
        continue;
      }
      await dropRequest(this.ctx, row.id, h.threadId);
      if (!place.channel) continue;
      if (place.ts) {
        await api.unreact(place.channel, place.ts, 'eyes');
        await api.react(place.channel, place.ts, 'x');
      }
      await this.sends.run(`${place.channel}:${place.threadTs ?? ''}`, async () => {
        await api.post(place.channel!, slackPlain(t('channel.cutShort')), { thread_ts: place.threadTs });
      });
    }
  }

  /** The bot token and its permissions, looked at once the server starts. */
  private async probe(row: Row) {
    const who = await this.botApi(row).authTest();
    await this.noteScopes(who.scopes);
  }

  /** Remembers which of the permissions the app needs its token lacks; nothing when Slack did not list them. */
  private async noteScopes(scopes: string[] | null) {
    const missing = scopes ? SLACK_BOT_SCOPES.filter((s) => !scopes.includes(s)) : [];
    const note = missing.length
      ? (await this.services.settings.translator())('slack.scopesMissing', { scopes: missing.join(', ') })
      : null;
    // An app set up before an optional permission was added works on without it; the person is
    // told what stays off rather than shown an error.
    const optional = scopes ? SLACK_OPTIONAL_SCOPES.filter((s) => !scopes.includes(s)) : [];
    if (note === this.scopeNote && optional.join() === this.optionalMissing.join()) return;
    this.scopeNote = note;
    this.optionalMissing = optional;
    this.changed();
  }

  /**
   * The bot token works (null) or Slack refused it: the status says so until a call goes through
   * again. An error the socket reported is its own and is left alone.
   */
  private tokenState(code: string | null) {
    if (code === null) {
      if (!this.tokenError) return;
      const { note } = this.tokenError;
      this.tokenError = null;
      void this.row()
        .then((row) => (row?.error === note ? this.setError(null) : undefined))
        .catch(() => {});
      return;
    }
    if (this.tokenError?.code === code || this.stopped) return;
    void this.services.settings
      .translator()
      .then((t) => {
        const note = t('slack.tokenInvalid', { reason: code });
        this.tokenError = { code, note };
        return this.setError(note);
      })
      .catch(() => {});
  }
  async stop() {
    this.stopped = true;
    this.halting.abort();
    for (const u of this.unsubs) u();
    this.socket?.close();
    await this.socket?.done;
    this.socket = null;
    await this.sends.drain();
  }

  // The app's side

  async status(): Promise<SlackStatus> {
    const row = await this.row();
    const account = row?.account as Partial<Account> | undefined;
    const people = await this.ctx.db
      .select({
        userId: schema.slackPeople.userId,
        slackName: schema.slackPeople.name,
        displayName: schema.users.displayName,
        username: schema.users.username,
      })
      .from(schema.slackPeople)
      .innerJoin(schema.users, eq(schema.users.id, schema.slackPeople.userId))
      .orderBy(schema.slackPeople.createdAt);
    const unreadable = !!row?.secret && !canOpen(this.vault, row.secret);
    return {
      connected: !!row?.secret && !unreadable,
      workspace: account?.teamId ? { id: account.teamId, name: account.team ?? '' } : null,
      botUser: account?.botName ?? null,
      botId: row?.botId ?? null,
      people: people.map((p) => ({
        userId: p.userId,
        name: p.displayName || p.username || '',
        slackName: p.slackName,
      })),
      error: unreadable
        ? (await this.services.settings.translator())('channel.secretUnreadable')
        : (row?.error ?? this.scopeNote),
      optionalMissing: row?.secret ? this.optionalMissing : [],
    };
  }

  /** Saves the Slack app's tokens after Slack accepts both, and starts listening. */
  async connect(input: { appToken: string; botToken: string; botId: string | null }): Promise<SlackStatus> {
    const app = slackToken(input.appToken, 'app');
    const bot = slackToken(input.botToken, 'bot');
    if (!app || !bot) throw new HttpError(400, 'error.slackToken');
    if (input.botId) await this.services.bots.get(input.botId);
    let who;
    try {
      who = await this.api(bot).authTest();
      // The app-level token is checked by asking for a connection; the address is not used.
      await this.api(app).socketUrl();
    } catch (err) {
      if (err instanceof SlackError) throw new HttpError(400, 'error.slackRefused', { reason: err.code });
      throw new HttpError(502, 'error.slackUnreachable');
    }
    const botName = await this.api(bot)
      .userName(who.user_id)
      .catch(() => who.user_id);
    const account: Account = { teamId: who.team_id, team: who.team, botUserId: who.user_id, botName };
    this.tokenError = null;
    await this.noteScopes(who.scopes);
    const values = {
      secret: this.vault.seal(JSON.stringify({ app, bot } satisfies Tokens)),
      account: { ...account },
      botId: input.botId,
      error: null,
    };
    const existing = await this.row();
    if (existing) {
      await this.ctx.db.update(schema.channels).set(values).where(eq(schema.channels.id, existing.id));
    } else {
      await this.ctx.db
        .insert(schema.channels)
        .values({ id: newId(), kind: 'slack', userId: OWNER_ID, ...values });
    }
    // Links made in another workspace are of other accounts.
    await this.ctx.db.delete(schema.slackPeople).where(ne(schema.slackPeople.teamId, who.team_id));
    await this.listen();
    this.changed();
    return this.status();
  }

  async update(patch: { botId: string | null }): Promise<SlackStatus> {
    const row = await this.row();
    if (!row) throw new HttpError(409, 'error.slackNotConnected');
    if (patch.botId) await this.services.bots.get(patch.botId);
    await this.ctx.db
      .update(schema.channels)
      .set({ botId: patch.botId })
      .where(eq(schema.channels.id, row.id));
    this.changed();
    return this.status();
  }

  /** Forgets the tokens; the Slack app itself stays in the workspace, and people stay linked. */
  async disconnect(): Promise<void> {
    this.socket?.close();
    this.socket = null;
    await this.ctx.db.delete(schema.channels).where(eq(schema.channels.kind, 'slack'));
    this.changed();
  }

  /** One person's link, and the code they can link with while one waits. */
  async link(userId: string): Promise<SlackLink> {
    const row = await this.row();
    const [mine] = await this.ctx.db
      .select()
      .from(schema.slackPeople)
      .where(eq(schema.slackPeople.userId, userId))
      .limit(1);
    const waiting = [...this.codes].find(([, c]) => c.userId === userId && c.until > Date.now());
    return {
      available: !!row?.secret,
      workspace: (row?.account as Partial<Account> | undefined)?.team ?? null,
      linked: mine ? { name: mine.name } : null,
      code: waiting?.[0] ?? null,
      codeUntil: waiting ? new Date(waiting[1].until).toISOString() : null,
      optionalMissing: row?.secret ? this.optionalMissing : [],
    };
  }

  /** A new code for the person to send the Slack app; an earlier one stops working. */
  async newCode(userId: string): Promise<SlackLink> {
    if (!(await this.row())?.secret) throw new HttpError(409, 'error.slackNotConnected');
    for (const [code, c] of this.codes)
      if (c.userId === userId || c.until <= Date.now()) this.codes.delete(code);
    let code: string;
    do
      code = Array.from({ length: CODE_LENGTH }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
    while (this.codes.has(code));
    this.codes.set(code, { userId, until: Date.now() + CODE_MS });
    return this.link(userId);
  }

  async unlink(userId: string): Promise<SlackLink> {
    await this.ctx.db.delete(schema.slackPeople).where(eq(schema.slackPeople.userId, userId));
    this.changed();
    return this.link(userId);
  }

  // Reading Slack

  private async listen() {
    this.socket?.close();
    this.socket = null;
    if (this.stopped) return;
    const row = await this.row();
    if (!row?.secret) return;
    // Tokens that cannot be opened will not open on a retry; the status says why.
    if (!canOpen(this.vault, row.secret)) return console.warn('slack tokens cannot be read');
    const tokens = this.tokens(row);
    const app = this.api(tokens.app);
    this.socket = new SlackSocket(
      (signal) => app.socketUrl(signal),
      (e) => this.envelope(e),
      // A hello must not wipe the note of a refused bot token; the socket only knows the app token.
      (error) => {
        if (error === null && this.tokenError) return;
        void this.setError(error).catch(() => {});
      },
    );
  }

  private async envelope(e: SlackEnvelope) {
    if (e.type === 'events_api') {
      const p = e.payload as { event_id?: string; event?: SlackMessage & { type: string } } | undefined;
      const ev = p?.event;
      // The workspace took the app's access away: said at once, not at the next failed send.
      if (ev?.type === 'tokens_revoked' || ev?.type === 'app_uninstalled') {
        this.tokenState(ev.type === 'app_uninstalled' ? 'app_uninstalled' : 'token_revoked');
        return;
      }
      if (ev?.type === 'reaction_added') return this.reacted(ev as unknown as Reaction);
      if (!ev || (ev.type !== 'message' && ev.type !== 'app_mention')) return;
      await this.received(ev);
    } else if (e.type === 'interactive') {
      await this.pressed(e.payload as Pressed);
    }
  }

  /**
   * A linked person reacted to a message: their routines set to run on that reaction run on the
   * message. It needs the optional `reactions:read` permission; without it Slack sends nothing.
   */
  private async reacted(ev: Reaction) {
    const row = await this.row();
    const item = ev.item;
    if (!row?.secret || !ev.user || !ev.reaction || item?.type !== 'message' || !item.channel || !item.ts)
      return;
    const account = row.account as unknown as Account;
    if (ev.user === account.botUserId) return;
    if (!this.once(`reaction:${item.channel}:${item.ts}:${ev.reaction}:${ev.user}`)) return;
    const person = await this.person(ev.user);
    if (!person) return;
    const api = this.botApi(row);
    // A thread's replies come with the message they answer: the one reacted to is found by its time.
    const found = await api.replies(item.channel, item.ts, 200, 1).catch(() => []);
    const raw = found.find((m) => m.ts === item.ts)?.text ?? '';
    if (!raw.trim()) return;
    const text = slackText(raw, account.botUserId, await this.namesIn(api, raw));
    await this.services.routines
      .runFromSlackReaction({
        userId: person.userId,
        reaction: ev.reaction,
        channel: item.channel,
        ts: item.ts,
        text,
      })
      .catch((err: unknown) => console.warn('slack reaction routine', err));
  }

  /** Whether this message was handled already (Slack sends a mention as two events). */
  private once(key: string): boolean {
    const now = Date.now();
    for (const [k, at] of this.seen) if (now - at > SEEN_MS) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }

  private async received(ev: SlackMessage & { type: string }) {
    const row = await this.row();
    if (!row?.secret || !ev.channel || !ev.user) return;
    const account = row.account as unknown as Account;
    // Bots (this one too) and changes to old messages are not read, so two bots never answer each
    // other without end.
    if (ev.bot_id || ev.user === account.botUserId || !WRITTEN.has(ev.subtype)) return;
    if (!this.once(`${ev.channel}:${ev.ts}`)) return;
    const api = this.botApi(row);
    const t = await this.services.settings.translator();
    const raw = ev.text ?? '';
    const mentioned = raw.includes(`<@${account.botUserId}`);
    const text = slackText(raw, account.botUserId, await this.namesIn(api, raw));
    const direct = ev.type === 'message' && ev.channel_type === 'im';
    const person = await this.person(ev.user);
    if (direct) {
      const code = /^(?:link|bağla)\s+([A-Za-z0-9]{6,32})$/i.exec(text)?.[1]?.toUpperCase();
      if (code) return this.linked(api, ev, code, person, t);
      if (!person) {
        await api.post(ev.channel, slackPlain(t('slack.linkFirst')));
        return;
      }
      return this.direct(row, api, ev, person, text, t);
    }
    const threadTs = ev.thread_ts ?? ev.ts;
    const [bound] = await this.ctx.db
      .select()
      .from(schema.slackThreads)
      .where(and(eq(schema.slackThreads.channel, ev.channel), eq(schema.slackThreads.threadTs, threadTs)))
      .limit(1);
    // In a channel the bot answers when it is mentioned, and in a thread it is already in; a line
    // there that starts by addressing someone else is for them.
    if (!mentioned && (!bound || /^\s*<@[A-Z0-9]+/.test(raw))) return;
    if (!person) {
      await api
        .ephemeral(ev.channel, ev.user, slackPlain(t('slack.linkFirst')), ev.thread_ts)
        .catch(() => {});
      return;
    }
    return this.inChannel(row, api, ev, person, text, bound?.threadId ?? null, t);
  }

  /** `link <code>` in a direct message: the Slack account becomes the person's whose code it is. */
  private async linked(api: SlackApi, ev: SlackMessage, code: string, person: Person | null, t: T) {
    const now = Date.now();
    const missed = this.misses.get(ev.user!);
    if (missed && missed.until > now && missed.count >= CODE_TRIES) {
      await api.post(ev.channel!, slackPlain(t('slack.tooManyCodes')));
      return;
    }
    const waiting = this.codes.get(code);
    if (!waiting || waiting.until <= now) {
      const count = missed && missed.until > now ? missed.count + 1 : 1;
      this.misses.set(ev.user!, { count, until: now + CODE_MS });
      await api.post(ev.channel!, slackPlain(t('slack.badCode')));
      return;
    }
    this.codes.delete(code);
    const row = await this.row();
    const account = row!.account as unknown as Account;
    const name = await this.nameOf(api, ev.user!);
    // One Slack account for one person: a link of either before is replaced.
    await this.ctx.db.delete(schema.slackPeople).where(eq(schema.slackPeople.userId, waiting.userId));
    if (person)
      await this.ctx.db.delete(schema.slackPeople).where(eq(schema.slackPeople.slackUserId, ev.user!));
    await this.ctx.db.insert(schema.slackPeople).values({
      slackUserId: ev.user!,
      teamId: account.teamId,
      userId: waiting.userId,
      name,
      dmChannel: ev.channel!,
    });
    await api.post(ev.channel!, slackPlain(t('slack.linked', { name })));
    this.changed();
  }

  /** A direct message: the person's own conversation with the bot they last named. */
  private async direct(row: Row, api: SlackApi, ev: SlackMessage, person: Person, text: string, t: T) {
    const named = namedBot(text, await this.reachable(person.userId));
    const botId = named?.bot.id ?? person.botId ?? row.botId;
    const bot = botId ? await this.usable(person.userId, botId) : null;
    if (!bot) {
      await api.post(ev.channel!, slackPlain(t(botId ? 'slack.notShared' : 'slack.noBot')));
      return;
    }
    await this.ctx.db
      .update(schema.slackPeople)
      .set({ dmChannel: ev.channel!, botId: bot.id })
      .where(eq(schema.slackPeople.slackUserId, person.slackUserId));
    const words = named ? named.rest : text;
    const thread = await this.services.threads.main(bot.id, person.userId);
    const got = await this.files(api, ev, thread.id, t);
    const files = got.names;
    if (!words && !files.length) {
      if (named) await api.post(ev.channel!, slackPlain(t('slack.talkingTo', { bot: bot.name })));
      return;
    }
    await this.submit(
      row,
      api,
      thread.id,
      { channel: ev.channel!, ts: ev.ts },
      {
        text: withMissingFiles(words, got, t),
        files,
        clientId: `slack:${ev.channel}:${ev.ts}`,
        userId: person.userId,
        props: { via: 'slack' },
      },
      t,
    );
  }

  /**
   * Hands a line to the conversation. The 👀 and the note of the request come first, so a restart in
   * the middle leaves a trace to settle; if the line cannot be taken the person is told.
   */
  private async submit(
    row: Row,
    api: SlackApi,
    threadId: string,
    place: Place & { ts: string },
    input: Parameters<Services['inbox']['send']>[1],
    t: T,
  ) {
    await this.started(row.id, threadId, place, api);
    try {
      await this.services.inbox.send(threadId, input);
    } catch (err) {
      console.warn('slack inbox', err);
      await this.finished(threadId, api, 'x');
      await api
        .post(place.channel, slackPlain(t('channel.updateFailed')), { thread_ts: place.threadTs })
        .catch(() => {});
      return;
    }
    // Nothing started (a repeated message, say): no turn will end it, so it ends here.
    if (
      this.working.get(threadId)?.ts === place.ts &&
      (await this.services.threads.state(threadId)) === 'idle'
    ) {
      await this.finished(threadId, api, null);
    }
  }

  /** A line in a channel: a team conversation, new or the one this Slack thread already is. */
  private async inChannel(
    row: Row,
    api: SlackApi,
    ev: SlackMessage,
    person: Person,
    text: string,
    boundId: string | null,
    t: T,
  ) {
    const note = (key: Parameters<T>[0], vars?: Record<string, string>) =>
      api.ephemeral(ev.channel!, ev.user!, slackPlain(t(key, vars)), ev.thread_ts).catch(() => {});
    let words = text;
    let threadId = boundId;
    let fresh = !boundId;
    let bot: Bot | null;
    if (threadId) {
      const thread = await this.services.threads.row(threadId).catch(() => null);
      if (!thread) return;
      bot = await this.usable(person.userId, thread.botId);
      if (!bot) return note('slack.notShared');
    } else {
      const named = namedBot(text, await this.reachable(person.userId));
      const botId = named?.bot.id ?? row.botId;
      if (!botId) return note('slack.noBot');
      bot = await this.usable(person.userId, botId);
      if (!bot) return note('slack.notShared');
      // What a bot shared with nobody does is its owner's alone; a channel is not that place.
      const access = bot.access ?? { everyone: 'none', people: {} };
      if (access.everyone === 'none' && !Object.keys(access.people).length) {
        return note('slack.botPrivate', { bot: bot.name });
      }
      if (named) words = named.rest;
      const thread = await this.services.threads.create(bot.id, {
        kind: 'team',
        userId: null,
        title: truncate(words.replace(/\s+/g, ' '), 60) || bot.name,
      });
      threadId = thread.id;
      const inserted = await this.ctx.db
        .insert(schema.slackThreads)
        .values({ threadId, channel: ev.channel!, threadTs: ev.thread_ts ?? ev.ts })
        .onConflictDoNothing()
        .returning();
      // Two first lines at once: the conversation made first is the thread's, and this line
      // goes there too.
      if (!inserted.length) {
        await this.services.threads.remove(threadId).catch(() => {});
        const [first] = await this.ctx.db
          .select({ threadId: schema.slackThreads.threadId })
          .from(schema.slackThreads)
          .where(
            and(
              eq(schema.slackThreads.channel, ev.channel!),
              eq(schema.slackThreads.threadTs, ev.thread_ts ?? ev.ts),
            ),
          )
          .limit(1);
        if (!first) return;
        threadId = first.threadId;
        fresh = false;
      }
    }
    const got = await this.files(api, ev, threadId, t);
    const files = got.names;
    if (!words && !files.length) return;
    // Called into a thread that was going on without it: what was said before, as others' words. In
    // a thread it is already in, what was said since its last request there (lines that were for
    // someone else do not reach it otherwise).
    let history = '';
    if (ev.thread_ts && ev.thread_ts !== ev.ts) {
      if (fresh) history = await this.history(api, ev.channel!, ev.thread_ts, ev.ts, row);
      else {
        const since = await this.lastRequest(threadId, ev.channel!);
        if (since) history = await this.history(api, ev.channel!, ev.thread_ts, ev.ts, row, since);
      }
    }
    await this.submit(
      row,
      api,
      threadId,
      { channel: ev.channel!, threadTs: ev.thread_ts ?? ev.ts, ts: ev.ts },
      {
        text: withMissingFiles(words, got, t),
        files,
        clientId: `slack:${ev.channel}:${ev.ts}`,
        userId: person.userId,
        ...(history && { history }),
        props: { via: 'slack' },
      },
      t,
    );
  }

  /** The time of the last line from Slack that went to this conversation, as Slack's `ts`. */
  private async lastRequest(threadId: string, channel: string): Promise<string | null> {
    const [last] = await this.ctx.db
      .select({ clientId: schema.messages.clientId })
      .from(schema.messages)
      .where(
        and(eq(schema.messages.threadId, threadId), like(schema.messages.clientId, `slack:${channel}:%`)),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    return last?.clientId?.slice(`slack:${channel}:`.length) ?? null;
  }

  /**
   * The earlier lines of a Slack thread, `Name: text` each, newest kept when it is long; with
   * `since`, only the lines after that one.
   */
  private async history(
    api: SlackApi,
    channel: string,
    threadTs: string,
    before: string,
    row: Row,
    since?: string,
  ) {
    const account = row.account as unknown as Account;
    const messages = await api
      .replies(channel, threadTs, HISTORY_MESSAGES + 1, 5, since)
      .catch(() => [] as SlackMessage[]);
    const lines: string[] = [];
    for (const m of messages) {
      if (m.ts === before || Number(m.ts) > Number(before) || !m.text?.trim()) continue;
      if (since && Number(m.ts) <= Number(since)) continue;
      // The bot's own lines are its words, not something it has missed.
      if (m.user === account.botUserId) continue;
      const who = m.user ? await this.nameOf(api, m.user) : m.bot_id ? 'bot' : '?';
      const words = slackText(m.text, account.botUserId, await this.namesIn(api, m.text));
      lines.push(`${who}: ${words}`);
    }
    const kept: string[] = [];
    let size = 0;
    for (const line of lines.slice(-HISTORY_MESSAGES).reverse()) {
      if (size + line.length > HISTORY_CHARS) break;
      kept.unshift(line);
      size += line.length + 1;
    }
    return kept.join('\n');
  }

  /** The files of a message, downloaded into the conversation's staging folder. */
  private async files(
    api: SlackApi,
    ev: SlackMessage,
    threadId: string,
    t: T,
  ): Promise<{ names: string[]; failed: string[]; tooLarge: string[] }> {
    const names: string[] = [];
    const failed: string[] = [];
    const tooLarge: string[] = [];
    for (const f of (ev.files ?? []) as SlackFile[]) {
      const name = receivedName('file', f.id, f.mimetype, f.name);
      if (!f.url_private_download || (f.size ?? 0) > MAX_UPLOAD_BYTES) {
        tooLarge.push(name);
        await this.say(api, ev, t('channel.fileTooLarge', { name }));
        continue;
      }
      try {
        const body = await api.download(f.url_private_download);
        const saved = await saveUpload(stagingDir(this.ctx.config.dataDir, threadId), name, body);
        names.push(saved.name);
      } catch (err) {
        console.warn('slack file', (err as Error).message);
        failed.push(name);
        await this.say(api, ev, t('channel.fileFailed', { name }));
      }
    }
    return { names, failed, tooLarge };
  }

  /** A short line back where the message came from. */
  private async say(api: SlackApi, ev: SlackMessage, text: string) {
    await api.post(ev.channel!, slackPlain(text), { thread_ts: ev.thread_ts }).catch(() => {});
  }

  /** 👀 on the message the bot works on, until it is done. */
  private async started(rowId: string, threadId: string, place: Place & { ts: string }, api: SlackApi) {
    const before = this.working.get(threadId);
    if (before) await api.unreact(before.channel, before.ts, 'eyes');
    // Noted before the turn can start, so a restart in the middle leaves a trace to settle.
    await holdRequest(this.ctx, rowId, threadId, { ...place });
    this.working.set(threadId, { ...place, rowId });
    await api.react(place.channel, place.ts, 'eyes');
  }

  /** A button under a card: the answer of the Slack account that pressed it. */
  private async pressed(p: Pressed | undefined) {
    if (p?.type !== 'block_actions' || !p.user?.id || !p.actions?.length) return;
    const row = await this.row();
    if (!row?.secret) return;
    const api = this.botApi(row);
    const t = await this.services.settings.translator();
    const channel = p.channel?.id ?? p.container?.channel_id;
    const threadTs = p.message?.thread_ts ?? p.container?.thread_ts;
    const note = (key: Parameters<T>[0]) =>
      channel ? api.ephemeral(channel, p.user!.id, slackPlain(t(key)), threadTs).catch(() => {}) : undefined;
    const choice = parseChoice(p.actions[0]!.value ?? '');
    if (!choice) return;
    const person = await this.person(p.user.id);
    if (!person) return note('slack.linkFirst');
    const card = await this.services.approvals.get(choice.approvalId).catch(() => null);
    if (!card || card.status !== 'pending') return note('channel.cardClosed');
    const thread = await this.services.threads.row(card.threadId).catch(() => null);
    // A card of someone else's own conversation is not answered from Slack by another account.
    if (!thread || (thread.userId && thread.userId !== person.userId)) return note('slack.cardNotYours');
    let result: string;
    try {
      if (choice.kind === 'a') {
        const allow = choice.value !== 'n';
        const after = await this.services.approvals.answer(
          card.id,
          { decision: allow ? 'allow' : 'deny', remember: choice.value === 'r' },
          person.userId,
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
        if (option === null) return note('channel.cardClosed');
        await this.services.approvals.answer(
          card.id,
          { decision: 'allow', answer: option, remember: false },
          person.userId,
        );
        result = option;
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return note('channel.cardClosed');
      if (err instanceof HttpError && err.status === 403) return note('slack.cardNotYours');
      throw err;
    }
    // The buttons go, and the card says how it was answered and by whom.
    if (channel && p.message?.ts) {
      const done = `${p.message.text ?? ''}\n\n${slackPlain(t('slack.answered', { result: truncate(result, 190), name: person.name }))}`;
      await api
        .call('chat.update', {
          channel,
          ts: p.message.ts,
          text: done,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: truncate(done, 2900) } }],
        })
        .catch(() => {});
    }
  }

  /** The choice a button stands for, on a one-question card. */
  private option(card: Approval, i: number): string | null {
    const { items } = questionItems(card);
    return items.length === 1 ? (items[0]!.options[i] ?? null) : null;
  }

  // Writing to Slack

  /** Where a conversation's lines go in Slack, if anywhere. */
  private async placeOf(thread: { id: string; kind: string; userId: string | null }): Promise<Place | null> {
    if (thread.kind === 'team') {
      const [bound] = await this.ctx.db
        .select()
        .from(schema.slackThreads)
        .where(eq(schema.slackThreads.threadId, thread.id))
        .limit(1);
      return bound ? { channel: bound.channel, threadTs: bound.threadTs } : null;
    }
    if (!thread.userId || !(await lastWroteVia(this.ctx, thread.id, 'slack'))) return null;
    const [person] = await this.ctx.db
      .select()
      .from(schema.slackPeople)
      .where(eq(schema.slackPeople.userId, thread.userId))
      .limit(1);
    return person?.dmChannel ? { channel: person.dmChannel } : null;
  }

  /** A new message here that belongs in Slack too; a conversation's lines are sent one after another. */
  private outgoing(m: Message): Promise<void> {
    return this.lines.run(m.threadId, () => this.sendLine(m)).then(() => {});
  }

  private async sendLine(m: Message) {
    if (this.stopped || !['assistant', 'approval', 'error', 'user'].includes(m.role)) return;
    const row = await this.row();
    if (!row?.secret) return;
    const thread = await this.services.threads.row(m.threadId).catch(() => null);
    if (!thread) return;
    // A person's own line goes to Slack only in a team conversation, and only when written in the
    // app: the thread there then reads as the whole conversation.
    if (m.role === 'user' && (thread.kind !== 'team' || m.props.via === 'slack')) return;
    const place = await this.placeOf(thread);
    if (!place) return;
    const t = await this.services.settings.translator();
    const api = this.botApi(row);
    const where = { thread_ts: place.threadTs };
    const ok = await this.deliver(place, api, t, async () => {
      if (m.role === 'user') {
        const [who] = await this.ctx.db
          .select({ displayName: schema.users.displayName, username: schema.users.username })
          .from(schema.messages)
          .innerJoin(schema.users, eq(schema.users.id, schema.messages.userId))
          .where(eq(schema.messages.id, m.id))
          .limit(1);
        if (!who) return;
        const name = slackPlain(who?.displayName || who?.username || '');
        const [first = '', ...rest] = slackMessages(m.text);
        await api.post(place.channel, `*${name}*: ${first}`, where);
        for (const part of rest) await api.post(place.channel, part, where);
        return;
      }
      if (m.role === 'approval') {
        const card = await this.services.approvals.get(String(m.props.approvalId)).catch(() => null);
        if (!card || card.status !== 'pending') return;
        const view = cardView(card, m.props, t, await this.services.settings.locale());
        const [first = '', ...rest] = slackMessages(view.text);
        for (const part of rest.length ? [first, ...rest.slice(0, -1)] : [])
          await api.post(place.channel, part, where);
        const last = rest.at(-1) ?? first;
        await api.post(place.channel, last, {
          ...where,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: truncate(last, 2900) } },
            ...(view.buttons.length
              ? [
                  {
                    type: 'actions',
                    elements: view.buttons.slice(0, 25).map((b) => ({
                      type: 'button',
                      text: { type: 'plain_text', text: truncate(b.label, 70) },
                      action_id: b.data,
                      value: b.data,
                      ...(b.data.endsWith(':y') && { style: 'primary' }),
                      ...(b.data.endsWith(':n') && { style: 'danger' }),
                    })),
                  },
                ]
              : []),
          ],
        });
        return;
      }
      if (m.role === 'error') {
        await api.post(place.channel, `⚠️ ${slackPlain(m.text)}`, where);
        return;
      }
      if (m.author !== `bot:${thread.botId}`) return;
      for (const part of slackMessages(m.text)) await api.post(place.channel, part, where);
      for (const f of messageFiles(m)) {
        const path = join(this.ctx.config.dataDir, 'workspaces', f.path);
        const size = await stat(path).then(
          (s) => s.size,
          () => -1,
        );
        if (size < 0 || size > SEND_MAX) {
          await api.post(place.channel, slackPlain(t('channel.fileInApp', { name: f.name })), where);
          continue;
        }
        try {
          await api.upload(place.channel, path, f.name, place.threadTs);
        } catch (err) {
          console.warn('slack send file', (err as Error).message);
          await api.post(place.channel, slackPlain(t('channel.fileInApp', { name: f.name })), where);
        }
      }
    });
    if (m.role === 'error') await this.finished(thread.id, api, 'x');
    else if (!ok && this.working.has(thread.id)) this.undelivered.add(thread.id);
  }

  /**
   * Runs the sends of one line in the place's order. When it could not be delivered the person is
   * told once, in the same place, that the rest is in the app; whether it went through is returned.
   */
  private async deliver(place: Place, api: SlackApi, t: T, job: () => Promise<void>): Promise<boolean> {
    const key = `${place.channel}:${place.threadTs ?? ''}`;
    if (await this.sends.run(key, job)) return true;
    await this.sends.run(key, async () => {
      await api.post(place.channel, slackPlain(t('channel.notDelivered')), { thread_ts: place.threadTs });
    });
    return false;
  }

  /**
   * A routine's report, posted to the Slack channel the routine names. False when Slack is not
   * connected or refused it (the app is not in that channel, say); the report stays in the app.
   */
  async report(channel: string, routineName: string, text: string): Promise<boolean> {
    const row = await this.row();
    if (!row?.secret || this.stopped) return false;
    const api = this.botApi(row);
    try {
      const parts = slackMessages(text);
      return await this.sends.run(channel, async () => {
        for (const [i, part] of parts.entries()) {
          await api.post(channel, i === 0 ? `📋 *${slackPlain(routineName)}*\n\n${part}` : part);
        }
      });
    } catch (err) {
      console.warn('slack report', (err as Error).message);
      return false;
    }
  }

  /**
   * A short note to one person, in the Slack app's direct messages with them, when they linked
   * their Slack account. False when they did not, when Slack is not connected, or it refused; the
   * note is then only where the app shows it.
   */
  async tellPerson(userId: string, text: string): Promise<boolean> {
    const row = await this.row();
    if (!row?.secret || this.stopped) return false;
    const [linked] = await this.ctx.db
      .select({ slackUserId: schema.slackPeople.slackUserId })
      .from(schema.slackPeople)
      .where(eq(schema.slackPeople.userId, userId))
      .limit(1);
    if (!linked || !(await this.person(linked.slackUserId))) return false;
    const api = this.botApi(row);
    try {
      return await this.sends.run(linked.slackUserId, async () => {
        await api.post(linked.slackUserId, slackPlain(text));
      });
    } catch (err) {
      console.warn('slack tell person', (err as Error).message);
      return false;
    }
  }

  /** The bot stopped working on a conversation: its 👀 becomes a mark of how it went. */
  private async turnState(e: TurnEvent) {
    if (e.state !== 'idle') return;
    const row = await this.row();
    if (!row?.secret) return;
    // The lines of the reply are sent first: a reply that did not arrive is no ✅.
    await this.lines.after(e.threadId);
    const mark = this.undelivered.delete(e.threadId) ? 'x' : 'white_check_mark';
    await this.finished(e.threadId, this.botApi(row), mark);
  }

  private async finished(threadId: string, api: SlackApi, mark: string | null) {
    const place = this.working.get(threadId);
    if (!place) return;
    this.working.delete(threadId);
    await dropRequest(this.ctx, place.rowId, threadId);
    await api.unreact(place.channel, place.ts, 'eyes');
    if (mark) await api.react(place.channel, place.ts, mark);
  }

  // Records

  private api(token: string) {
    return new SlackApi(token, this.ctx.config.slackApi, undefined, this.halting.signal);
  }

  /** The bot's own API: what Slack says about its token is watched. */
  private botApi(row: Row) {
    return new SlackApi(
      this.tokens(row).bot,
      this.ctx.config.slackApi,
      (code) => this.tokenState(code),
      this.halting.signal,
    );
  }

  private tokens(row: Row): Tokens {
    return JSON.parse(this.vault.open(row.secret!)) as Tokens;
  }

  private async row(): Promise<Row | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.kind, 'slack'))
      .limit(1);
    return row ?? null;
  }

  private async person(slackUserId: string): Promise<Person | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.slackPeople)
      .where(eq(schema.slackPeople.slackUserId, slackUserId))
      .limit(1);
    if (!row) return null;
    // Someone who may no longer sign in is not answered either.
    const [user] = await this.ctx.db
      .select({ disabledAt: schema.users.disabledAt })
      .from(schema.users)
      .where(eq(schema.users.id, row.userId))
      .limit(1);
    return user && !user.disabledAt ? row : null;
  }

  /** The bots a person may talk with, not archived. */
  private async reachable(userId: string): Promise<Bot[]> {
    const ids = new Set(
      await this.services.access.botIds(await this.services.access.viewerOf(userId), 'chat'),
    );
    return (await this.services.bots.list()).filter((b) => ids.has(b.id) && !b.archivedAt);
  }

  /** The bot, when the person may talk with it and it is not archived. */
  private async usable(userId: string, botId: string): Promise<Bot | null> {
    const bot = await this.services.bots.get(botId).catch(() => null);
    if (!bot || bot.archivedAt) return null;
    const level = await this.services.access.level(await this.services.access.viewerOf(userId), bot.id);
    return atLeast(level, 'chat') ? bot : null;
  }

  private async nameOf(api: SlackApi, user: string): Promise<string> {
    const known = this.names.get(user);
    if (known) return known;
    let name: string;
    try {
      name = await api.userName(user);
    } catch {
      // The id stands in for this message only; a failed lookup is asked again next time.
      return user;
    }
    if (this.names.size > 2000) this.names.clear();
    this.names.set(user, name);
    return name;
  }

  /** The names of the people a Slack text mentions. */
  private async namesIn(api: SlackApi, raw: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const [, id] of raw.matchAll(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g)) {
      if (!out.has(id!)) out.set(id!, await this.nameOf(api, id!));
    }
    return out;
  }

  private async setError(error: string | null) {
    const row = await this.row();
    if (!row || row.error === error) return;
    await this.ctx.db.update(schema.channels).set({ error }).where(eq(schema.channels.id, row.id));
    this.changed();
  }

  private changed() {
    this.ctx.bus.refresh({ scope: 'channels' });
  }
}

/** A reaction someone added, as the Events API hands it over. */
interface Reaction {
  type: 'reaction_added';
  user?: string;
  reaction?: string;
  item?: { type?: string; channel?: string; ts?: string };
}

/** A button press as Slack's interactivity sends it. */
interface Pressed {
  type?: string;
  user?: { id: string };
  channel?: { id: string };
  container?: { channel_id?: string; thread_ts?: string; message_ts?: string };
  message?: { ts: string; text?: string; thread_ts?: string };
  actions?: { action_id?: string; value?: string }[];
}
