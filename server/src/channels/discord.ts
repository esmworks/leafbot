import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  discordInviteUrl,
  discordToken,
  MAX_UPLOAD_BYTES,
  questionItems,
  type Approval,
  type Bot,
  type DiscordServer,
  type DiscordStatus,
  type DiscordUpdate,
  type Message,
  type TurnEvent,
} from '@leafbot/shared';
import { and, desc, eq, like } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import type { Services } from '../services';
import { atLeast } from '../services/access';
import type { VaultService } from '../services/vault';
import { saveUpload, stagingDir } from '../uploads';
import { OWNER_ID } from '../users';
import { HttpError, isStopRequest, newId, truncate } from '../util';
import {
  canOpen,
  cardView,
  dropRequest,
  heldRequests,
  holdRequest,
  messageFiles,
  parseChoice,
  queuedTurn,
  receivedName,
  SendQueue,
  withMissingFiles,
} from './common';
import {
  DiscordApi,
  DiscordError,
  type DiscordButton,
  type DiscordInteraction,
  type DiscordMessage,
  type DiscordUser,
} from './discord-api';
import { DiscordGateway, type GatewayEvent, type GatewayState } from './discord-gateway';
import { discordMessages } from './format';

type Row = typeof schema.channels.$inferSelect;

/** Earlier messages of a channel a new conversation reads: this many, from this long before it. */
const CONTEXT_MESSAGES = 10;
const CONTEXT_MS = 15 * 60_000;
const CONTEXT_CHARS = 8000;
/** What a bot reads of the channel since its last request in a conversation it is in: at most this much. */
const SINCE_MESSAGES = 30;
const SINCE_CHARS = 12_000;
/** Most of a forwarded message's or embed's words read into context. */
const EXTRA_CHARS = 1500;
/** A direct message is answered once an hour per person; this many people are remembered. */
const DM_NOTICE_MS = 60 * 60_000;
const DM_NOTICE_PEOPLE = 10_000;
/** Discord's limit on a bot's file, unless the server has a higher boost level. */
const SEND_MAX = 10 * 1024 * 1024;
/** How long a message is remembered, so the same one coming twice counts once. */
const SEEN_MS = 10 * 60_000;
/**
 * Most requests one person may have under way at once, and most over all. Anyone in a server may
 * write, and each request spends the model's budget.
 */
const PER_PERSON = 2;
const IN_ALL = 20;
/** Message kinds that are a person writing: a plain message and a reply. */
const WRITTEN = new Set([0, 19]);

interface Account {
  applicationId: string;
  botUserId: string;
  botName: string;
  messageContent: boolean;
}

interface Settings {
  /** For each Discord server, the roles whose members may use the bot; none: everyone there. */
  roles?: Record<string, string[]>;
}

/** A conversation the bot works on in Discord, until it is done. */
interface Work {
  /** The channel's row, for the note of the work kept in the database. */
  rowId: string;
  channel: string;
  root: string;
  /** Who wrote the request under way: only they press its buttons or stop it. */
  requester: string;
  /** Their messages since the work started; each gets a mark of how it went. */
  messages: string[];
  /** The "Working on it…" post, until the first answer takes its place. */
  status: string | null;
  stopped: boolean;
}

/** Who wrote a Discord message, as people there see them. */
const nameOf = (u: DiscordUser, nick?: string | null) => nick || u.global_name || u.username || u.id;

/** The words of a message's embeds: each one's title and description. */
const embedWords = (embeds?: { title?: string; description?: string }[]) =>
  (embeds ?? []).flatMap((e) => [e.title, e.description]);

/**
 * Discord's markup as plain words: the bot's own mention goes, other people's become their names,
 * roles and channels keep their ids, a custom emoji keeps its name.
 */
export function discordText(
  raw: string,
  botUserId: string,
  mentions: { id: string; name: string }[] = [],
  botRoles: string[] = [],
): string {
  const names = new Map(mentions.map((m) => [m.id, m.name]));
  const own = new Set(botRoles);
  return raw
    .replace(new RegExp(`<@!?${botUserId}>`, 'g'), '')
    .replace(/<@&(\d+)>/g, (all, id: string) => (own.has(id) ? '' : all))
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${names.get(id) ?? id}`)
    .replace(/<@&(\d+)>/g, (_, id: string) => `@role:${id}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${id}`)
    .replace(/<a?:(\w+):\d+>/g, (_, name: string) => `:${name}:`)
    .trim();
}

/**
 * The server's Discord bot. It connects over Discord's Gateway, so no public address is needed.
 * Anyone in a server it was added to may mention it (or only members of the roles chosen for that
 * server); such a message starts a team conversation, and a reply to the bot's post goes on with it.
 * People there have no account here: their turns act for the server's owner, use only what the
 * team shares, may do no more with the bot than talk with it, and change nothing without a card.
 * Only the person who asked presses that card's buttons in Discord; in the app, as any card of a
 * team conversation.
 */
export class DiscordChannel {
  private gateway: DiscordGateway | null = null;
  private sends = new SendQueue();
  private seen = new Map<string, number>();
  private working = new Map<string, Work>();
  /** The role Discord manages for the bot in each server it is in: a mention of it is one of the bot. */
  private botRoles = new Map<string, Set<string>>();
  /** When each person last got the reply to a direct message, oldest first. */
  private dmNotified = new Map<string, number>();
  /** The lines of each conversation still being sent, so its mark waits for them. */
  private lines = new SendQueue();
  /** Conversations whose reply did not reach Discord in full: their mark is not a success. */
  private undelivered = new Set<string>();
  private unsubs: (() => void)[] = [];
  private stopped = false;

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
    // Before reading Discord again, so a message that arrives now is never taken for a stale one.
    await this.settleHeld(row).catch((err: unknown) => console.warn('discord held', err));
    await this.listen();
  }

  /**
   * Requests that were being worked on when the server stopped are over: the "Working on it…" post
   * says so and loses its button, the person's messages show the failure mark. A queued turn
   * survives the restart and still runs, so its request stays.
   */
  async settleHeld(row: Row) {
    const held = await heldRequests(this.ctx, row.id);
    if (!held.length) return;
    const t = await this.services.settings.translator();
    const api = this.api(row);
    for (const h of held) {
      const place = h.place as Partial<Omit<Work, 'rowId' | 'stopped'>>;
      if (await queuedTurn(this.ctx, h.threadId)) {
        if (place.channel && place.root && place.requester) {
          this.working.set(h.threadId, {
            rowId: row.id,
            channel: place.channel,
            root: place.root,
            requester: place.requester,
            messages: place.messages ?? [],
            status: place.status ?? null,
            stopped: false,
          });
        }
        continue;
      }
      await dropRequest(this.ctx, row.id, h.threadId);
      if (!place.channel || !place.root) continue;
      const channel = place.channel;
      const root = place.root;
      await this.sends.run(`${channel}:${root}`, async () => {
        const note = t('channel.cutShort');
        let edited = false;
        if (place.status)
          edited = await api.edit(channel, place.status, note).then(
            () => true,
            () => false,
          );
        if (!edited) await api.post(channel, note, { replyTo: root }).catch(() => {});
        for (const id of place.messages ?? []) {
          await api.unreact(channel, id, '👀');
          await api.react(channel, id, '❌');
        }
      });
    }
  }

  async stop() {
    this.stopped = true;
    for (const u of this.unsubs) u();
    this.gateway?.close();
    await this.gateway?.done;
    this.gateway = null;
    await this.sends.drain();
  }

  // The app's side

  async status(): Promise<DiscordStatus> {
    const row = await this.row();
    const account = row?.account as Partial<Account> | undefined;
    const unreadable = !!row?.secret && !canOpen(this.vault, row.secret);
    return {
      connected: !!row?.secret && !unreadable,
      botUser: account?.botName ?? null,
      botId: row?.botId ?? null,
      inviteUrl: account?.applicationId ? discordInviteUrl(account.applicationId) : null,
      servers: row?.secret && !unreadable ? await this.servers(row) : [],
      messageContent: account?.messageContent ?? true,
      error: unreadable
        ? (await this.services.settings.translator())('channel.secretUnreadable')
        : (row?.error ?? null),
    };
  }

  /** The servers the bot is in, with their roles; none when Discord does not answer now. */
  private async servers(row: Row): Promise<DiscordServer[]> {
    const api = this.api(row);
    const roles = (row.settings as Settings).roles ?? {};
    try {
      const guilds = await api.guilds();
      return await Promise.all(
        guilds.map(async (g) => {
          const all = await api.roles(g.id).catch(() => []);
          return {
            id: g.id,
            name: g.name,
            // `@everyone` has the server's id, and a role an app manages is that app's own.
            roles: all
              .filter((r) => r.id !== g.id && !r.managed)
              .sort((a, b) => (b.position ?? 0) - (a.position ?? 0))
              .map((r) => ({ id: r.id, name: r.name })),
            allowed: roles[g.id] ?? [],
          };
        }),
      );
    } catch (err) {
      console.warn('discord servers', (err as Error).message);
      return [];
    }
  }

  /** Saves the bot's token after Discord accepts it, and starts listening. */
  async connect(input: { token: string; botId: string | null }): Promise<DiscordStatus> {
    const token = discordToken(input.token);
    if (!token) throw new HttpError(400, 'error.discordToken');
    if (input.botId) await this.services.bots.get(input.botId);
    const api = new DiscordApi(token, this.ctx.config.discordApi);
    let me: DiscordUser;
    let applicationId: string;
    try {
      me = await api.me();
      // For apps made since 2020 the bot's user and its application share the id.
      applicationId = await api.application().then(
        (a) => a.id,
        () => me.id,
      );
    } catch (err) {
      if (err instanceof DiscordError && err.status < 500)
        throw new HttpError(400, 'error.discordRefused', { reason: err.code });
      throw new HttpError(502, 'error.discordUnreachable');
    }
    const existing = await this.row();
    const account: Account = {
      applicationId,
      botUserId: me.id,
      botName: nameOf(me),
      messageContent: true,
    };
    const values = {
      secret: this.vault.seal(token),
      account: { ...account },
      botId: input.botId,
      error: null,
      // Another bot's servers are not this one's.
      settings:
        existing && (existing.account as Partial<Account>).botUserId === me.id ? existing.settings : {},
    };
    if (existing) {
      await this.ctx.db.update(schema.channels).set(values).where(eq(schema.channels.id, existing.id));
    } else {
      await this.ctx.db
        .insert(schema.channels)
        .values({ id: newId(), kind: 'discord', userId: OWNER_ID, ...values });
    }
    await this.listen();
    this.changed();
    return this.status();
  }

  async update(patch: DiscordUpdate): Promise<DiscordStatus> {
    const row = await this.row();
    if (!row?.secret) throw new HttpError(409, 'error.discordNotConnected');
    const set: Partial<Row> = {};
    if (patch.botId !== undefined) {
      if (patch.botId) await this.services.bots.get(patch.botId);
      set.botId = patch.botId;
    }
    if (patch.roles) {
      const server = (await this.servers(row)).find((s) => s.id === patch.roles!.serverId);
      if (!server) throw new HttpError(400, 'error.discordServer');
      const known = new Set(server.roles.map((r) => r.id));
      const roles = { ...((row.settings as Settings).roles ?? {}) };
      const picked = [...new Set(patch.roles.roleIds)].filter((id) => known.has(id));
      if (picked.length) roles[server.id] = picked;
      else delete roles[server.id];
      set.settings = { ...row.settings, roles };
    }
    await this.ctx.db.update(schema.channels).set(set).where(eq(schema.channels.id, row.id));
    this.changed();
    return this.status();
  }

  /** Forgets the token; the bot stays in its servers until someone there removes it. */
  async disconnect(): Promise<void> {
    this.gateway?.close();
    this.gateway = null;
    // The notes of the work in the database go with the channel's row.
    this.working.clear();
    this.botRoles.clear();
    await this.ctx.db.delete(schema.channels).where(eq(schema.channels.kind, 'discord'));
    this.changed();
  }

  // Reading Discord

  private async listen() {
    this.gateway?.close();
    this.gateway = null;
    if (this.stopped) return;
    const row = await this.row();
    if (!row?.secret) return;
    // A token that cannot be opened will not open on a retry; the status says why.
    if (!canOpen(this.vault, row.secret)) return console.warn('discord token cannot be read');
    const api = this.api(row);
    this.gateway = new DiscordGateway(
      this.vault.open(row.secret),
      (signal) => api.gatewayUrl(signal),
      (e) => this.event(e),
      (s) => void this.setState(s).catch(() => {}),
    );
  }

  private async event(e: GatewayEvent) {
    if (e.t === 'MESSAGE_CREATE') await this.received(e.d as unknown as DiscordMessage);
    else if (e.t === 'INTERACTION_CREATE') await this.pressed(e.d as unknown as DiscordInteraction);
    else if (e.t.startsWith('GUILD_')) await this.guildEvent(e);
  }

  /**
   * Which role is the bot's own in each server, from the server's roles when it is first seen and
   * from the changes after. A server that is gone for good is forgotten; one that is only
   * unavailable for a while keeps what is known.
   */
  private async guildEvent(e: GatewayEvent) {
    const d = e.d as {
      id?: string;
      guild_id?: string;
      unavailable?: boolean;
      roles?: { id: string; tags?: { bot_id?: string } }[];
      role?: { id: string; tags?: { bot_id?: string } };
      role_id?: string;
    };
    if (e.t === 'GUILD_DELETE') {
      if (!d.unavailable && d.id) this.botRoles.delete(d.id);
      return;
    }
    if (!['GUILD_CREATE', 'GUILD_ROLE_CREATE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE'].includes(e.t))
      return;
    const row = await this.row();
    if (!row) return;
    const me = (row.account as Partial<Account>).botUserId;
    const guild = d.guild_id ?? d.id;
    if (!me || !guild) return;
    if (e.t === 'GUILD_CREATE') {
      this.botRoles.set(
        guild,
        new Set((d.roles ?? []).filter((r) => r.tags?.bot_id === me).map((r) => r.id)),
      );
      return;
    }
    const known = this.botRoles.get(guild) ?? new Set<string>();
    if (e.t === 'GUILD_ROLE_DELETE') known.delete(d.role_id ?? '');
    else if (d.role?.tags?.bot_id === me) known.add(d.role.id);
    else if (d.role) known.delete(d.role.id);
    this.botRoles.set(guild, known);
  }

  private botRolesOf(guild?: string): string[] {
    return guild ? [...(this.botRoles.get(guild) ?? [])] : [];
  }

  /** Whether this message was handled already (a resumed connection may send it again). */
  private once(key: string): boolean {
    const now = Date.now();
    for (const [k, at] of this.seen) if (now - at > SEEN_MS) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }

  private async received(msg: DiscordMessage) {
    const row = await this.row();
    if (!row?.secret || !msg.channel_id || !msg.author) return;
    const account = row.account as unknown as Account;
    // Bots (this one too), webhooks and notices are not read, so two bots never answer each
    // other without end.
    if (msg.author.bot || msg.webhook_id || msg.author.id === account.botUserId) return;
    if (msg.type !== undefined && !WRITTEN.has(msg.type)) return;
    if (!this.once(`${msg.channel_id}:${msg.id}`)) return;
    const api = this.api(row);
    const t = await this.services.settings.translator();
    const botRoles = this.botRolesOf(msg.guild_id);
    const mentioned =
      (msg.mentions ?? []).some((u) => u.id === account.botUserId) ||
      new RegExp(`<@!?${account.botUserId}>`).test(msg.content ?? '') ||
      (msg.mention_roles ?? []).some((r) => botRoles.includes(r));
    if (!msg.guild_id) {
      // A direct message has no server, so no one chose who may use the bot there. The notice is
      // sent once an hour per person, so a chatty one does not get an answer to every line.
      if (this.dmDue(msg.author.id)) await api.post(msg.channel_id, t('discord.dmOnly')).catch(() => {});
      return;
    }
    // Only a message that mentions the bot is for it; a reply keeps the mention by default.
    if (!mentioned) return;
    const allowed = this.rolesOf(row, msg.guild_id);
    // A mention from someone outside the chosen roles is not answered, nor told why.
    if (allowed.length && !(msg.member?.roles ?? []).some((r) => allowed.includes(r))) return;
    const author = nameOf(msg.author, msg.member?.nick);
    const text = discordText(msg.content ?? '', account.botUserId, this.mentioned(msg), botRoles);
    const say = (key: Parameters<T>[0], vars?: Record<string, string>) =>
      api.post(msg.channel_id, t(key, vars), { replyTo: msg.id }).catch(() => {});

    // A reply to the bot's post goes on with that post's conversation: the bot replies to the
    // chain's first message with every post, so the post names it.
    const ref = msg.referenced_message;
    const toBot = !!ref && ref.author?.id === account.botUserId;
    const root = toBot && ref ? (ref.message_reference?.message_id ?? ref.id) : msg.id;
    const [bound] = toBot
      ? await this.ctx.db
          .select()
          .from(schema.discordThreads)
          .where(
            and(eq(schema.discordThreads.channel, msg.channel_id), eq(schema.discordThreads.rootId, root)),
          )
          .limit(1)
      : [];
    const work = bound ? this.working.get(bound.threadId) : undefined;

    // `stop` stops the request of whoever wrote it, not someone else's.
    if (bound && isStopRequest(text) && !msg.attachments?.length) {
      if (!work) return;
      if (work.requester !== msg.author.id) return say('discord.notYours');
      await this.halt(bound.threadId, work, api);
      return;
    }

    const mine = [...this.working.values()].filter((w) => w.requester === msg.author.id).length;
    if (!work || work.requester !== msg.author.id) {
      if (mine >= PER_PERSON) return say('discord.busyYou');
      if (this.working.size >= IN_ALL) return say('discord.busyAll');
    }

    let threadId: string;
    let bot: Bot | null;
    if (bound) {
      threadId = bound.threadId;
      const thread = await this.services.threads.row(threadId).catch(() => null);
      if (!thread) return;
      bot = await this.usable(row.userId, thread.botId);
      if (!bot) return say('discord.noBot');
    } else {
      bot = row.botId ? await this.usable(row.userId, row.botId) : null;
      if (!bot) return say('discord.noBot');
      // What a bot shared with nobody does is its owner's alone; a server is not that place.
      if (!(await this.services.access.sharedWithAnyone(bot))) {
        return say('discord.botPrivate', { bot: bot.name });
      }
      const thread = await this.services.threads.create(bot.id, {
        kind: 'team',
        userId: null,
        title: truncate(text.replace(/\s+/g, ' '), 60) || bot.name,
      });
      threadId = thread.id;
      const inserted = await this.ctx.db
        .insert(schema.discordThreads)
        .values({ threadId, serverId: msg.guild_id, channel: msg.channel_id, rootId: root })
        .onConflictDoNothing()
        .returning();
      // Two replies at once to a post of the bot that had no conversation yet: the conversation
      // made first is the chain's, and this message goes there too.
      if (!inserted.length) {
        await this.services.threads.remove(threadId).catch(() => {});
        const [first] = await this.ctx.db
          .select({ threadId: schema.discordThreads.threadId })
          .from(schema.discordThreads)
          .where(
            and(eq(schema.discordThreads.channel, msg.channel_id), eq(schema.discordThreads.rootId, root)),
          )
          .limit(1);
        if (!first) return;
        threadId = first.threadId;
      }
    }

    const got = await this.files(api, msg, threadId, t);
    const files = got.names;
    if (!text && !files.length) return;
    // A new conversation reads what came just before it in the channel, or the message it
    // replies to, as others' words. A chain it is already in reads what was said in that chain since
    // its last request (lines that were not for the bot do not reach it otherwise).
    let history = '';
    if (!bound) history = await this.context(api, msg, account, ref && !toBot ? ref : null);
    else {
      const since = await this.lastRequest(threadId, msg.channel_id);
      if (since) history = await this.context(api, msg, account, null, { since, root });
    }
    const busy = (await this.services.threads.state(threadId)) !== 'idle';
    // "Working on it…" goes up first, so even a quick answer takes its place.
    await this.started(row.id, threadId, msg, root, api, t);
    try {
      await this.services.inbox.send(threadId, {
        text: withMissingFiles(text, got, t),
        files,
        clientId: `discord:${msg.channel_id}:${msg.id}`,
        userId: row.userId,
        author,
        guest: true,
        // Words of someone else than who asked wait their turn: they answer no card of theirs.
        answers: !busy || work?.requester === msg.author.id,
        ...(history && { history }),
        props: { via: 'discord', discord: { author: msg.author.id, name: author } },
      });
    } catch (err) {
      await this.finished(threadId, api, '❌');
      throw err;
    }
  }

  /** Whether the notice for a direct message is due for this person; noted when it is. */
  private dmDue(person: string): boolean {
    const now = Date.now();
    const at = this.dmNotified.get(person);
    if (at !== undefined && now - at < DM_NOTICE_MS) return false;
    // Re-added at the end, so the map stays oldest first and the oldest goes when it is full.
    this.dmNotified.delete(person);
    this.dmNotified.set(person, now);
    if (this.dmNotified.size > DM_NOTICE_PEOPLE) {
      const oldest = this.dmNotified.keys().next().value;
      if (oldest !== undefined) this.dmNotified.delete(oldest);
    }
    return true;
  }

  /** The id of the last message from this channel that went to the conversation. */
  private async lastRequest(threadId: string, channel: string): Promise<string | null> {
    const prefix = `discord:${channel}:`;
    const [last] = await this.ctx.db
      .select({ clientId: schema.messages.clientId })
      .from(schema.messages)
      .where(and(eq(schema.messages.threadId, threadId), like(schema.messages.clientId, `${prefix}%`)))
      .orderBy(desc(schema.messages.createdAt))
      .limit(1);
    const id = last?.clientId?.slice(prefix.length);
    return id && /^\d+$/.test(id) ? id : null;
  }

  /** The people a message mentions, by the names they have there. */
  private mentioned(msg: DiscordMessage) {
    return (msg.mentions ?? []).map((u) => ({ id: u.id, name: nameOf(u, u.member?.nick) }));
  }

  /**
   * What a new conversation reads first: the message it replies to, or else the channel's last
   * messages from shortly before it, `Name: text` each.
   */
  private async context(
    api: DiscordApi,
    msg: DiscordMessage,
    account: Account,
    quoted: DiscordMessage | null,
    /**
     * In a reply chain the bot is already in: only that chain's lines after `since` (the last
     * request), not the rest of the channel's talk.
     */
    chain?: { since: string; root: string },
  ) {
    const since = chain?.since;
    const roles = this.botRolesOf(msg.guild_id);
    const line = (m: DiscordMessage) => {
      const words = discordText(m.content ?? '', account.botUserId, this.mentioned(m), roles);
      // A forwarded message holds its words in a snapshot, and a link's preview or a bot's card in
      // embeds; both are read, a little of each.
      const extra = [
        ...(m.message_snapshots ?? []).flatMap((x) => [x.message?.content, ...embedWords(x.message?.embeds)]),
        ...embedWords(m.embeds),
      ]
        .filter((x): x is string => !!x?.trim())
        .join(' ');
      const files = [
        ...(m.attachments ?? []),
        ...(m.message_snapshots ?? []).flatMap((x) => x.message?.attachments ?? []),
      ]
        .map((a) => a.filename)
        .join(', ');
      const said = [words, extra && truncate(extra.replace(/\s+/g, ' '), EXTRA_CHARS), files && `(${files})`]
        .filter(Boolean)
        .join(' ');
      return said ? `${nameOf(m.author, m.member?.nick)}: ${said}` : '';
    };
    if (quoted) return truncate(line(quoted), CONTEXT_CHARS);
    // Without the text of every message, Discord gives the earlier ones empty.
    if (!account.messageContent) return '';
    const at = msg.timestamp ? Date.parse(msg.timestamp) : Date.now();
    const earlier = await api
      .history(msg.channel_id, msg.id, since ? SINCE_MESSAGES : CONTEXT_MESSAGES)
      .catch(() => []);
    const lines: string[] = [];
    // The chain grows by replies: to its first message, to the last request, or to any line already
    // in it. The bot's posts all reply to the first message, so a reply to an older one counts too.
    const inChain = new Set(chain ? [chain.root, chain.since] : []);
    for (const m of [...earlier].reverse()) {
      if (chain) {
        if (!/^\d+$/.test(m.id) || BigInt(m.id) <= BigInt(chain.since)) continue;
        const to = m.message_reference?.message_id;
        const ref = m.referenced_message;
        const toBot =
          ref?.author?.id === account.botUserId && ref.message_reference?.message_id === chain.root;
        if (!to || (!inChain.has(to) && !toBot)) continue;
        inChain.add(m.id);
      } else if (m.timestamp && at - Date.parse(m.timestamp) > CONTEXT_MS) continue;
      if (m.author?.id === account.botUserId) continue;
      const l = line(m);
      if (l) lines.push(l);
    }
    const cap = since ? SINCE_CHARS : CONTEXT_CHARS;
    const kept: string[] = [];
    let size = 0;
    for (const l of lines.reverse()) {
      if (size + l.length > cap) break;
      kept.unshift(l);
      size += l.length + 1;
    }
    return kept.join('\n');
  }

  /**
   * The files of a message, downloaded into the conversation's staging folder; those that did not
   * arrive, by name, so the bot can be told.
   */
  private async files(api: DiscordApi, msg: DiscordMessage, threadId: string, t: T) {
    const names: string[] = [];
    const failed: string[] = [];
    const tooLarge: string[] = [];
    for (const f of msg.attachments ?? []) {
      const name = receivedName('file', f.id, f.content_type, f.filename);
      if ((f.size ?? 0) > MAX_UPLOAD_BYTES) {
        tooLarge.push(name);
        await api
          .post(msg.channel_id, t('channel.fileTooLarge', { name }), { replyTo: msg.id })
          .catch(() => {});
        continue;
      }
      try {
        const body = await api.download(f.url);
        const saved = await saveUpload(stagingDir(this.ctx.config.dataDir, threadId), name, body);
        names.push(saved.name);
      } catch (err) {
        console.warn('discord file', (err as Error).message);
        failed.push(name);
        await api
          .post(msg.channel_id, t('channel.fileFailed', { name }), { replyTo: msg.id })
          .catch(() => {});
      }
    }
    return { names, failed, tooLarge };
  }

  /** 👀 on the message, and a "Working on it…" post with Stop until the first answer. */
  private async started(
    rowId: string,
    threadId: string,
    msg: DiscordMessage,
    root: string,
    api: DiscordApi,
    t: T,
  ) {
    const work = this.working.get(threadId);
    await api.react(msg.channel_id, msg.id, '👀');
    if (work) {
      work.messages.push(msg.id);
      await this.hold(threadId, work);
      return;
    }
    const entry: Work = {
      rowId,
      channel: msg.channel_id,
      root,
      requester: msg.author.id,
      messages: [msg.id],
      status: null,
      stopped: false,
    };
    this.working.set(threadId, entry);
    // Noted before the turn can start, so a restart in the middle leaves a trace to settle.
    await this.hold(threadId, entry);
    await this.sends.run(this.key(entry), async () => {
      entry.status = await api
        .post(msg.channel_id, t('discord.working'), {
          replyTo: root,
          buttons: [{ label: t('discord.stop'), customId: `stop:${threadId}`, style: 2 }],
        })
        .catch(() => null);
    });
    await this.hold(threadId, entry);
  }

  /** Keeps what is needed to undo the work's marks in Discord, should the server stop meanwhile. */
  private async hold(threadId: string, work: Work) {
    await holdRequest(this.ctx, work.rowId, threadId, {
      channel: work.channel,
      root: work.root,
      requester: work.requester,
      messages: work.messages,
      status: work.status,
    }).catch((err: unknown) => console.warn('discord hold', err));
  }

  /** Stops the work on a conversation; its messages get ⏹ when it is done. */
  private async halt(threadId: string, work: Work, api: DiscordApi) {
    work.stopped = true;
    const stopped = await this.services.turns.interrupt(threadId);
    await this.services.jobs.stopFrom(threadId);
    if (!stopped) await this.finished(threadId, api, '⏹️');
  }

  /**
   * A press of a button the bot posted: a card's answer, or Stop. Discord waits three seconds for
   * exactly one answer to it, whatever the press turns out to be, so one is always given.
   */
  private async pressed(i: DiscordInteraction) {
    if (i.type !== 3 || !i.id || !i.token) return;
    // A resumed connection may send the same press again.
    if (!this.once(`press:${i.id}`)) return;
    const row = await this.row();
    if (!row?.secret) return;
    const api = this.api(row);
    let answered = false;
    const respond = async (answer: Parameters<DiscordApi['respond']>[1]) => {
      if (answered) return;
      answered = true;
      await api.respond(i, answer).catch(() => {});
    };
    try {
      await this.press(i, row, api, respond);
    } finally {
      await respond({ ack: true });
    }
  }

  private async press(
    i: DiscordInteraction,
    row: Row,
    api: DiscordApi,
    respond: (answer: Parameters<DiscordApi['respond']>[1]) => Promise<void>,
  ) {
    const presser = i.member?.user ?? i.user;
    const data = i.data?.custom_id ?? '';
    const stop = /^stop:([\w-]+)$/.exec(data);
    const choice = stop ? null : parseChoice(data);
    // Not a button of ours, or no one pressing it: nothing to do but the acknowledgement.
    if (!presser || (!stop && !choice)) return;
    const t = await this.services.settings.translator();
    const note = (key: Parameters<T>[0]) => respond({ note: t(key) });
    // A member who lost the chosen roles since asking presses nothing.
    const allowed = i.guild_id ? this.rolesOf(row, i.guild_id) : [];
    if (allowed.length && !(i.member?.roles ?? []).some((r) => allowed.includes(r)))
      return note('discord.notYours');

    if (stop) {
      const threadId = stop[1]!;
      const work = this.working.get(threadId);
      if (!work) return note('channel.cardClosed');
      if (work.requester !== presser.id) return note('discord.notYours');
      await respond({ ack: true });
      await this.halt(threadId, work, api);
      return;
    }

    if (!choice) return;
    const card = await this.services.approvals.get(choice.approvalId).catch(() => null);
    if (!card || card.status !== 'pending') return note('channel.cardClosed');
    const [bound] = await this.ctx.db
      .select()
      .from(schema.discordThreads)
      .where(eq(schema.discordThreads.threadId, card.threadId))
      .limit(1);
    if (!bound) return note('channel.cardClosed');
    if (card.kind === 'tool' && !this.rolesOf(row, bound.serverId).length) return note('discord.cardInApp');
    if ((await this.requesterOf(card)) !== presser.id) return note('discord.notYours');
    // "Always allow" is never offered here: a rule would count for everyone's requests.
    if (choice.kind === 'a' && choice.value === 'r') return note('discord.notYours');
    let option: string | null = null;
    if (choice.kind === 'q') {
      option = card.kind === 'question' ? this.option(card, Number(choice.value)) : null;
      if (option === null) return note('channel.cardClosed');
    }
    await respond({ ack: true });
    const allow = choice.kind === 'q' || choice.value !== 'n';
    let waiting = false;
    try {
      const after = await this.services.approvals.answer(
        card.id,
        option === null
          ? { decision: allow ? 'allow' : 'deny', remember: false }
          : { decision: 'allow', answer: option, remember: false },
        row.userId,
      );
      // The first yes of a step that needs two people leaves it waiting for the second.
      waiting = after.status === 'pending';
    } catch (err) {
      if (err instanceof HttpError && (err.status === 409 || err.status === 403)) return;
      throw err;
    }
    // The buttons go, and the card says how it was answered and by whom.
    if (i.channel_id && i.message?.id) {
      const result =
        option ?? t(!allow ? 'channel.denied' : waiting ? 'channel.waitingSecond' : 'channel.allowed');
      const name = nameOf(presser, i.member?.nick);
      const done = `${i.message.content ?? ''}\n\n${t('discord.answered', { result: truncate(result, 190), name })}`;
      await api.edit(i.channel_id, i.message.id, truncate(done, 2000)).catch(() => {});
    }
  }

  /** The Discord person whose request a card belongs to. */
  private async requesterOf(card: Approval): Promise<string | null> {
    const [row] = await this.ctx.db
      .select({ turnId: schema.approvals.turnId })
      .from(schema.approvals)
      .where(eq(schema.approvals.id, card.id))
      .limit(1);
    if (!row?.turnId) return null;
    const asked = await this.ctx.db
      .select({ props: schema.messages.props })
      .from(schema.messages)
      .where(and(eq(schema.messages.turnId, row.turnId), eq(schema.messages.role, 'user')));
    const ids = asked
      .map((m) => (m.props as { discord?: { author?: unknown } }).discord?.author)
      .filter((x): x is string => typeof x === 'string');
    // A turn that gathered several people's words is no one person's to answer from Discord.
    return new Set(ids).size === 1 ? ids[0]! : null;
  }

  /** The choice a button stands for, on a one-question card. */
  private option(card: Approval, i: number): string | null {
    const { items } = questionItems(card);
    return items.length === 1 ? (items[0]!.options[i] ?? null) : null;
  }

  // Writing to Discord

  private key(place: { channel: string; root: string }) {
    return `${place.channel}:${place.root}`;
  }

  /** A new message here that belongs in Discord too; a conversation's lines are sent one after another. */
  private outgoing(m: Message): Promise<void> {
    return this.lines.run(m.threadId, () => this.sendLine(m)).then(() => {});
  }

  private async sendLine(m: Message) {
    if (this.stopped || !['assistant', 'approval', 'error', 'user'].includes(m.role)) return;
    // A person's line goes to Discord only when written in the app.
    if (m.role === 'user' && m.props.via === 'discord') return;
    const row = await this.row();
    if (!row?.secret) return;
    const [bound] = await this.ctx.db
      .select()
      .from(schema.discordThreads)
      .where(eq(schema.discordThreads.threadId, m.threadId))
      .limit(1);
    if (!bound) return;
    const thread = await this.services.threads.row(m.threadId).catch(() => null);
    if (!thread) return;
    const t = await this.services.settings.translator();
    const api = this.api(row);
    const place = { channel: bound.channel, root: bound.rootId };
    const ok = await this.deliver(place, api, t, async () => {
      /** Posts in the conversation, the first in place of "Working on it…" when it still shows. */
      const write = async (parts: string[], last?: DiscordButton[]) => {
        const work = this.working.get(m.threadId);
        for (const [n, part] of parts.entries()) {
          const buttons = n === parts.length - 1 ? last : undefined;
          if (work?.status && n === 0) {
            const status = work.status;
            work.status = null;
            try {
              await api.edit(place.channel, status, part, buttons);
              await this.hold(m.threadId, work);
              continue;
            } catch {
              // Deleted meanwhile: a new post instead.
            }
          }
          await api.post(place.channel, part, { replyTo: place.root, buttons });
        }
      };
      if (m.role === 'user') {
        const [who] = await this.ctx.db
          .select({ displayName: schema.users.displayName, username: schema.users.username })
          .from(schema.messages)
          .innerJoin(schema.users, eq(schema.users.id, schema.messages.userId))
          .where(eq(schema.messages.id, m.id))
          .limit(1);
        if (!who) return;
        const [first = '', ...rest] = discordMessages(m.text);
        await api.post(place.channel, truncate(`**${who.displayName || who.username}**: ${first}`, 2000), {
          replyTo: place.root,
        });
        for (const part of rest) await api.post(place.channel, part, { replyTo: place.root });
        return;
      }
      if (m.role === 'approval') {
        const card = await this.services.approvals.get(String(m.props.approvalId)).catch(() => null);
        if (!card || card.status !== 'pending') return;
        const view = cardView(card, m.props, t, await this.services.settings.locale());
        // A step's card is the only thing between a stranger's request and the team's things: in a
        // server where anyone may write, those who may change the bot answer it in the app.
        if (card.kind === 'tool' && !this.rolesOf(row, bound.serverId).length) {
          await write(discordMessages(`${view.text}\n\n_${t('discord.cardInApp')}_`));
          return;
        }
        const buttons: DiscordButton[] = view.buttons
          // A rule would count for everyone's requests, so it is never offered here.
          .filter((b) => !b.data.endsWith(':r'))
          .map((b) => ({
            label: b.label,
            customId: b.data,
            style: b.data.endsWith(':y') ? 3 : b.data.endsWith(':n') ? 4 : 2,
          }));
        await write(discordMessages(view.text), buttons);
        return;
      }
      if (m.role === 'error') {
        await write([truncate(`⚠️ ${m.text}`, 2000)]);
        return;
      }
      if (m.author !== `bot:${thread.botId}`) return;
      const parts = discordMessages(m.text);
      const files = messageFiles(m);
      // A reply of one file and a text that fits one post goes as one post, so the file is not left
      // alone under the text; any other shape, or a failed upload, falls back to the separate posts.
      const only = files.length === 1 && parts.length === 1 ? files[0]! : null;
      let together = false;
      if (only) {
        const path = join(this.ctx.config.dataDir, 'workspaces', only.path);
        const size = await stat(path).then(
          (s) => s.size,
          () => -1,
        );
        if (size >= 0 && size <= SEND_MAX) {
          try {
            const work = this.working.get(m.threadId);
            // An edit cannot carry a file, so the "Working on it…" post gives way to the answer.
            if (work?.status) {
              const status = work.status;
              work.status = null;
              await api.remove(place.channel, status).catch(() => {});
              await this.hold(m.threadId, work);
            }
            await api.post(place.channel, parts[0]!, {
              replyTo: place.root,
              file: { path, name: only.name },
            });
            together = true;
          } catch (err) {
            console.warn('discord send file', (err as Error).message);
          }
        }
      }
      if (together) return;
      await write(parts);
      for (const f of files) {
        const path = join(this.ctx.config.dataDir, 'workspaces', f.path);
        const size = await stat(path).then(
          (s) => s.size,
          () => -1,
        );
        if (size < 0 || size > SEND_MAX) {
          await api.post(place.channel, t('channel.fileInApp', { name: f.name }), { replyTo: place.root });
          continue;
        }
        try {
          await api.post(place.channel, '', { replyTo: place.root, file: { path, name: f.name } });
        } catch (err) {
          console.warn('discord send file', (err as Error).message);
          await api.post(place.channel, t('channel.fileInApp', { name: f.name }), { replyTo: place.root });
        }
      }
    });
    // Not inside the send: finishing sends too, and would wait for it.
    if (m.role === 'error') await this.finished(thread.id, api, '❌');
    else if (!ok && this.working.has(thread.id)) this.undelivered.add(thread.id);
  }

  /**
   * Runs the sends of one line in the place's order. When it could not be delivered the person is
   * told once, in the same place, that the rest is in the app; whether it went through is returned.
   */
  private async deliver(
    place: { channel: string; root: string },
    api: DiscordApi,
    t: T,
    job: () => Promise<void>,
  ): Promise<boolean> {
    const key = this.key(place);
    if (await this.sends.run(key, job)) return true;
    await this.sends.run(key, async () => {
      await api.post(place.channel, t('channel.notDelivered'), { replyTo: place.root });
    });
    return false;
  }

  /** The bot stopped working on a conversation: each message's 👀 becomes a mark of how it went. */
  private async turnState(e: TurnEvent) {
    if (e.state !== 'idle' || !this.working.has(e.threadId)) return;
    const row = await this.row();
    if (!row?.secret) return;
    // The lines of the reply are sent first: a reply that did not arrive is no ✅.
    await this.lines.after(e.threadId);
    const work = this.working.get(e.threadId);
    if (!work) return;
    const failed = this.undelivered.delete(e.threadId);
    await this.finished(e.threadId, this.api(row), failed ? '❌' : work.stopped ? '⏹️' : '✅');
  }

  private async finished(threadId: string, api: DiscordApi, mark: string) {
    const work = this.working.get(threadId);
    if (!work) return;
    this.working.delete(threadId);
    this.undelivered.delete(threadId);
    await dropRequest(this.ctx, work.rowId, threadId).catch(() => {});
    await this.sends.run(this.key(work), async () => {
      // No answer took its place (the bot stayed quiet, or was stopped): the post goes.
      if (work.status) await api.remove(work.channel, work.status).catch(() => {});
      for (const id of work.messages) {
        await api.unreact(work.channel, id, '👀');
        await api.react(work.channel, id, mark);
      }
    });
  }

  // Records

  private api(row: Row) {
    return new DiscordApi(this.vault.open(row.secret!), this.ctx.config.discordApi);
  }

  /** The roles whose members may use the bot in a server; none: everyone there. */
  private rolesOf(row: Row, serverId: string): string[] {
    return (row.settings as Settings).roles?.[serverId] ?? [];
  }

  private async row(): Promise<Row | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.kind, 'discord'))
      .limit(1);
    return row ?? null;
  }

  /** The bot, when the person the turns act for may talk with it and it is not archived. */
  private async usable(userId: string, botId: string): Promise<Bot | null> {
    const bot = await this.services.bots.get(botId).catch(() => null);
    if (!bot || bot.archivedAt) return null;
    const level = await this.services.access.level(await this.services.access.viewerOf(userId), bot.id);
    return atLeast(level, 'chat') ? bot : null;
  }

  private async setState(s: GatewayState) {
    const row = await this.row();
    if (!row) return;
    const account = row.account as unknown as Account;
    const next = {
      ...account,
      messageContent: s.messageContent,
      ...(s.user && { botUserId: s.user.id, botName: s.user.name }),
    };
    if (row.error === s.error && JSON.stringify(next) === JSON.stringify(account)) return;
    await this.ctx.db
      .update(schema.channels)
      .set({ error: s.error, account: next })
      .where(eq(schema.channels.id, row.id));
    this.changed();
  }

  private changed() {
    this.ctx.bus.refresh({ scope: 'channels' });
  }
}
