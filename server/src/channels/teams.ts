import { randomInt } from 'node:crypto';
import {
  questionItems,
  type Approval,
  type Bot,
  type Message,
  type TeamsConnect,
  type TeamsLink,
  type TeamsStatus,
} from '@leafbot/shared';
import { eq, ne } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import type { T } from '../i18n';
import { atLeast } from '../services/access';
import type { Services } from '../services';
import type { VaultService } from '../services/vault';
import { OWNER_ID } from '../users';
import { HttpError, newId, truncate } from '../util';
import { canOpen, cardView, lastWroteVia, messageFiles, parseChoice, SendQueue } from './common';
import { namedBot } from './slack';
import {
  TeamsAuth,
  TeamsConnector,
  TeamsError,
  teamsParts,
  teamsText,
  type Http,
  type TeamsActivity,
} from './teams-api';

type Row = typeof schema.channels.$inferSelect;
type Person = typeof schema.teamsPeople.$inferSelect;

/** Where Teams delivers the bot's messages; needs no access key, each request is signed. */
export const TEAMS_PATH = '/api/hooks/teams';
/** A link code works this long. */
const CODE_MS = 15 * 60_000;
/** Link codes: ten letters and digits that are not mistaken for each other, so not guessable. */
const CODE_LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 10;
/** Wrong codes one Teams account may send before it is not listened to for a while. */
const CODE_TRIES = 5;
/** How long a message id is remembered, so one Teams delivers again counts once. */
const SEEN_MS = 10 * 60_000;

interface Account {
  appId: string;
  tenantId: string;
}

/** A personal chat with the bot: the service Teams named, the conversation, and the person in it. */
interface Place {
  serviceUrl: string;
  conversationId: string;
  user: string;
}

/** Teams shows at most this many buttons on a card; a longer choice is a list with one button. */
const CARD_BUTTONS = 6;

/**
 * The server's Microsoft Teams bot, registered in Azure as a single-tenant bot. Teams delivers what
 * people write to the server's public address, each request signed by the Bot Framework and checked
 * here; replies go out through the Bot Connector. People link their Teams account with a code from
 * the app, and only messages of linked people from the bot's own directory are read. A personal
 * chat with the bot is the person's own conversation with the bot they last named; the bot's step
 * cards come with buttons, answered as in the app.
 */
export class TeamsChannel {
  private auth: TeamsAuth;
  private sends = new SendQueue();
  private lines = new SendQueue();
  private codes = new Map<string, { userId: string; until: number }>();
  private misses = new Map<string, { count: number; until: number }>();
  private seen = new Map<string, number>();
  private pending = new Set<Promise<void>>();
  private connector: { key: string; api: TeamsConnector } | null = null;
  private unsubs: (() => void)[] = [];
  private stopped = false;

  constructor(
    private ctx: Ctx,
    private services: Services,
    private vault: VaultService,
    /** How the server reaches Microsoft; tests hand in their own. */
    private http: Http = fetch,
  ) {
    this.auth = new TeamsAuth(ctx.config.teamsOpenId, http);
  }

  start() {
    this.unsubs.push(this.services.threads.onMessage((m) => this.outgoing(m)));
  }

  async stop() {
    this.stopped = true;
    for (const u of this.unsubs) u();
    await this.idle();
    await this.sends.drain();
  }

  /** Waits for the messages being handled (tests, shutdown). */
  async idle() {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  // The app's side

  async status(): Promise<TeamsStatus> {
    const row = await this.row();
    const account = row?.account as Partial<Account> | undefined;
    const people = await this.ctx.db
      .select({
        userId: schema.teamsPeople.userId,
        teamsName: schema.teamsPeople.name,
        displayName: schema.users.displayName,
        username: schema.users.username,
      })
      .from(schema.teamsPeople)
      .innerJoin(schema.users, eq(schema.users.id, schema.teamsPeople.userId))
      .orderBy(schema.teamsPeople.createdAt);
    const base = this.ctx.config.publicUrl;
    const unreadable = !!row?.secret && !canOpen(this.vault, row.secret);
    return {
      connected: !!row?.secret && !unreadable,
      appId: account?.appId ?? null,
      tenantId: account?.tenantId ?? null,
      botId: row?.botId ?? null,
      endpoint: base?.startsWith('https://') ? `${base.replace(/\/+$/, '')}${TEAMS_PATH}` : null,
      people: people.map((p) => ({
        userId: p.userId,
        name: p.displayName || p.username || '',
        teamsName: p.teamsName,
      })),
      error: unreadable
        ? (await this.services.settings.translator())('channel.secretUnreadable')
        : (row?.error ?? null),
    };
  }

  /** Saves the bot's registration once Microsoft gives it a token with the secret. */
  async connect(input: TeamsConnect): Promise<TeamsStatus> {
    if (input.botId) await this.services.bots.get(input.botId);
    const api = new TeamsConnector(
      this.ctx.config.teamsLogin,
      input.tenantId,
      input.appId,
      input.secret,
      this.http,
    );
    try {
      await api.bearer();
    } catch (err) {
      if (err instanceof TeamsError) throw new HttpError(400, 'error.teamsRefused', { reason: err.code });
      throw new HttpError(502, 'error.teamsUnreachable');
    }
    const account: Account = { appId: input.appId, tenantId: input.tenantId };
    const values = {
      secret: this.vault.seal(input.secret),
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
        .values({ id: newId(), kind: 'teams', userId: OWNER_ID, ...values });
    }
    // Links made in another directory are of other accounts.
    await this.ctx.db.delete(schema.teamsPeople).where(ne(schema.teamsPeople.tenantId, input.tenantId));
    this.connector = null;
    this.changed();
    return this.status();
  }

  async update(patch: { botId: string | null }): Promise<TeamsStatus> {
    const row = await this.row();
    if (!row) throw new HttpError(409, 'error.teamsNotConnected');
    if (patch.botId) await this.services.bots.get(patch.botId);
    await this.ctx.db
      .update(schema.channels)
      .set({ botId: patch.botId })
      .where(eq(schema.channels.id, row.id));
    this.changed();
    return this.status();
  }

  /** Forgets the secret; the registration stays in Azure, and people stay linked. */
  async disconnect(): Promise<void> {
    await this.ctx.db.delete(schema.channels).where(eq(schema.channels.kind, 'teams'));
    this.connector = null;
    this.changed();
  }

  /** One person's link, and the code they can link with while one waits. */
  async link(userId: string): Promise<TeamsLink> {
    const row = await this.row();
    const [mine] = await this.ctx.db
      .select()
      .from(schema.teamsPeople)
      .where(eq(schema.teamsPeople.userId, userId))
      .limit(1);
    const waiting = [...this.codes].find(([, c]) => c.userId === userId && c.until > Date.now());
    return {
      available: !!row?.secret,
      linked: mine ? { name: mine.name } : null,
      code: waiting?.[0] ?? null,
      codeUntil: waiting ? new Date(waiting[1].until).toISOString() : null,
    };
  }

  /** A new code for the person to send the Teams bot; an earlier one stops working. */
  async newCode(userId: string): Promise<TeamsLink> {
    if (!(await this.row())?.secret) throw new HttpError(409, 'error.teamsNotConnected');
    for (const [code, c] of this.codes)
      if (c.userId === userId || c.until <= Date.now()) this.codes.delete(code);
    let code: string;
    do
      code = Array.from({ length: CODE_LENGTH }, () => CODE_LETTERS[randomInt(CODE_LETTERS.length)]).join('');
    while (this.codes.has(code));
    this.codes.set(code, { userId, until: Date.now() + CODE_MS });
    return this.link(userId);
  }

  async unlink(userId: string): Promise<TeamsLink> {
    await this.ctx.db.delete(schema.teamsPeople).where(eq(schema.teamsPeople.userId, userId));
    this.changed();
    return this.link(userId);
  }

  // Reading Teams

  /**
   * A request Teams sent to the server's address: the HTTP status to answer with. Only a request
   * the Bot Framework signed for this bot is read; what it carries is handled after the answer, as
   * Teams wants one quickly.
   */
  async receive(authorization: string | undefined, body: unknown): Promise<number> {
    const row = await this.row();
    if (!row?.secret || this.stopped) return 404;
    if (!authorization) return 401;
    const activity = (body && typeof body === 'object' ? body : {}) as TeamsActivity;
    const account = row.account as unknown as Account;
    if (!(await this.auth.check(authorization, activity, account.appId))) return 403;
    const work = this.handle(row, activity).catch((err: unknown) =>
      console.warn('teams message', (err as Error).message),
    );
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return 200;
  }

  private once(key: string): boolean {
    const now = Date.now();
    for (const [k, at] of this.seen) if (now - at > SEEN_MS) this.seen.delete(k);
    if (this.seen.has(key)) return false;
    this.seen.set(key, now);
    return true;
  }

  private async handle(row: Row, a: TeamsActivity) {
    if (a.type !== 'message' || a.channelId !== 'msteams') return;
    const from = a.from?.id;
    const conversation = a.conversation?.id;
    if (!from || !conversation || !a.serviceUrl || from === a.recipient?.id) return;
    if (a.id && !this.once(`${conversation}:${a.id}`)) return;
    const account = row.account as unknown as Account;
    // A single-tenant bot answers its own directory only.
    const tenant = a.conversation?.tenantId ?? a.channelData?.tenant?.id;
    if (tenant !== account.tenantId) return;
    const t = await this.services.settings.translator();
    const place: Place = { serviceUrl: a.serviceUrl, conversationId: conversation, user: from };
    const reply = (text: string) => this.say(row, place, text);
    if (a.conversation?.conversationType !== 'personal') {
      await reply(t('teams.personalOnly'));
      return;
    }
    const person = await this.person(from);
    if (a.value && typeof a.value === 'object') return this.pressed(row, a, person, t);
    const text = teamsText(a.text);
    const code = /^(?:link|bağla)\s+([A-Za-z0-9]{6,32})$/i.exec(text)?.[1]?.toUpperCase();
    if (code) return this.linked(row, a, code, person, t);
    if (!person) {
      await reply(t('teams.linkFirst'));
      return;
    }
    await this.ctx.db
      .update(schema.teamsPeople)
      .set({ serviceUrl: a.serviceUrl, conversationId: conversation })
      .where(eq(schema.teamsPeople.teamsUserId, person.teamsUserId));
    const named = namedBot(text, await this.reachable(person.userId));
    const botId = named?.bot.id ?? person.botId ?? row.botId;
    const bot = botId ? await this.usable(person.userId, botId) : null;
    if (!bot) {
      await reply(t(botId ? 'slack.notShared' : 'slack.noBot'));
      return;
    }
    await this.ctx.db
      .update(schema.teamsPeople)
      .set({ botId: bot.id })
      .where(eq(schema.teamsPeople.teamsUserId, person.teamsUserId));
    const words = named ? named.rest : text;
    const files = (a.attachments ?? []).filter((f) => f.contentType && f.contentType !== 'text/html');
    if (!words) {
      if (files.length) await reply(t('teams.filesInApp'));
      else if (named) await reply(t('slack.talkingTo', { bot: bot.name }));
      return;
    }
    const thread = await this.services.threads.main(bot.id, person.userId);
    // The person sees the bot is on it while the reply is written.
    void this.post(row, place, { type: 'typing' }).catch(() => {});
    try {
      await this.services.inbox.send(thread.id, {
        text: files.length ? `${words}\n\n${t('teams.filesLeftOut')}` : words,
        clientId: `teams:${conversation}:${a.id ?? newId()}`,
        userId: person.userId,
        props: { via: 'teams' },
      });
    } catch (err) {
      console.warn('teams inbox', (err as Error).message);
      await reply(t('channel.updateFailed'));
    }
  }

  /** `link <code>` in a personal chat: the Teams account becomes the person's whose code it is. */
  private async linked(row: Row, a: TeamsActivity, code: string, person: Person | null, t: T) {
    const from = a.from!.id!;
    const reply = (text: string) =>
      this.say(
        row,
        { serviceUrl: a.serviceUrl!, conversationId: a.conversation!.id!, user: a.from!.id! },
        text,
      );
    const now = Date.now();
    const missed = this.misses.get(from);
    if (missed && missed.until > now && missed.count >= CODE_TRIES) {
      await reply(t('slack.tooManyCodes'));
      return;
    }
    const waiting = this.codes.get(code);
    if (!waiting || waiting.until <= now) {
      const count = missed && missed.until > now ? missed.count + 1 : 1;
      this.misses.set(from, { count, until: now + CODE_MS });
      await reply(t('slack.badCode'));
      return;
    }
    this.codes.delete(code);
    const account = row.account as unknown as Account;
    const name = truncate((a.from?.name ?? '').trim(), 200) || from;
    // One Teams account for one person: a link of either before is replaced.
    await this.ctx.db.delete(schema.teamsPeople).where(eq(schema.teamsPeople.userId, waiting.userId));
    if (person) await this.ctx.db.delete(schema.teamsPeople).where(eq(schema.teamsPeople.teamsUserId, from));
    await this.ctx.db.insert(schema.teamsPeople).values({
      teamsUserId: from,
      tenantId: account.tenantId,
      userId: waiting.userId,
      name,
      serviceUrl: a.serviceUrl!,
      conversationId: a.conversation!.id!,
    });
    await reply(t('slack.linked', { name }));
    this.changed();
  }

  /** A button of a step card: answered as the linked person, as in the app. */
  private async pressed(row: Row, a: TeamsActivity, person: Person | null, t: T) {
    const reply = (text: string) =>
      this.say(
        row,
        { serviceUrl: a.serviceUrl!, conversationId: a.conversation!.id!, user: a.from!.id! },
        text,
      );
    const data = (a.value as { choice?: unknown }).choice;
    const choice = typeof data === 'string' ? parseChoice(data) : null;
    if (!choice) return;
    if (!person) return reply(t('teams.linkFirst'));
    const card = await this.services.approvals.get(choice.approvalId).catch(() => null);
    if (!card || card.status !== 'pending') return reply(t('channel.cardClosed'));
    const thread = await this.services.threads.row(card.threadId).catch(() => null);
    // A card of someone else's own conversation is not answered from Teams by another account.
    if (!thread || (thread.userId && thread.userId !== person.userId)) return reply(t('slack.cardNotYours'));
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
        if (option === null) return reply(t('channel.cardClosed'));
        await this.services.approvals.answer(
          card.id,
          { decision: 'allow', answer: option, remember: false },
          person.userId,
        );
        result = option;
      }
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) return reply(t('channel.cardClosed'));
      if (err instanceof HttpError && err.status === 403) return reply(t('slack.cardNotYours'));
      throw err;
    }
    await reply(t('slack.answered', { result: truncate(result, 190), name: person.name }));
  }

  /** The choice a button stands for, on a one-question card. */
  private option(card: Approval, i: number): string | null {
    const { items } = questionItems(card);
    return items.length === 1 ? (items[0]!.options[i] ?? null) : null;
  }

  // Writing to Teams

  /** A new message here that belongs in Teams too; a conversation's lines are sent one after another. */
  private outgoing(m: Message): Promise<void> {
    return this.lines.run(m.threadId, () => this.sendLine(m)).then(() => {});
  }

  private async sendLine(m: Message) {
    if (this.stopped || !['assistant', 'approval', 'error'].includes(m.role)) return;
    const row = await this.row();
    if (!row?.secret) return;
    const thread = await this.services.threads.row(m.threadId).catch(() => null);
    if (!thread?.userId || thread.kind === 'team') return;
    if (!(await lastWroteVia(this.ctx, thread.id, 'teams'))) return;
    const [person] = await this.ctx.db
      .select()
      .from(schema.teamsPeople)
      .where(eq(schema.teamsPeople.userId, thread.userId))
      .limit(1);
    if (!person?.serviceUrl || !person.conversationId) return;
    const t = await this.services.settings.translator();
    const where: Place = {
      serviceUrl: person.serviceUrl,
      conversationId: person.conversationId,
      user: person.teamsUserId,
    };
    const ok = await this.sends.run(person.conversationId, async () => {
      if (m.role === 'approval') {
        const card = await this.services.approvals.get(String(m.props.approvalId)).catch(() => null);
        if (!card || card.status !== 'pending') return;
        const view = cardView(card, m.props, t, await this.services.settings.locale());
        const many = view.buttons.length > CARD_BUTTONS;
        await this.post(row, where, {
          type: 'message',
          attachments: [
            {
              contentType: 'application/vnd.microsoft.card.adaptive',
              content: {
                type: 'AdaptiveCard',
                $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
                version: '1.4',
                body: [
                  { type: 'TextBlock', text: truncate(view.text, 4000), wrap: true },
                  // More choices than Teams shows as buttons: a list, sent with one button.
                  ...(many
                    ? [
                        {
                          type: 'Input.ChoiceSet',
                          id: 'choice',
                          style: 'expanded',
                          choices: view.buttons.map((b) => ({ title: truncate(b.label, 60), value: b.data })),
                        },
                      ]
                    : []),
                ],
                actions: many
                  ? [{ type: 'Action.Submit', title: t('teams.answer') }]
                  : view.buttons.map((b) => ({
                      type: 'Action.Submit',
                      title: truncate(b.label, 60),
                      data: { choice: b.data },
                    })),
              },
            },
          ],
        });
        return;
      }
      if (m.role === 'error') {
        await this.post(row, where, {
          type: 'message',
          text: `⚠️ ${m.text}`,
          textFormat: 'plain',
        });
        return;
      }
      if (m.author !== `bot:${thread.botId}`) return;
      for (const part of teamsParts(m.text))
        await this.post(row, where, {
          type: 'message',
          text: part,
          textFormat: 'markdown',
        });
      // Files stay in the app: sending them to Teams needs the bot to have OneDrive access.
      for (const f of messageFiles(m))
        await this.post(row, where, {
          type: 'message',
          text: t('channel.fileInApp', { name: f.name }),
          textFormat: 'plain',
        });
    });
    await this.setError(ok ? null : t('teams.notDelivered'));
  }

  /** A short plain reply in a conversation the person wrote in. */
  private async say(row: Row, place: Place, text: string) {
    await this.sends.run(place.conversationId, async () => {
      await this.post(row, place, { type: 'message', text, textFormat: 'plain' });
    });
  }

  /**
   * Posts an activity into a personal chat, naming who it is from (the bot, as Teams addresses it),
   * who it is for and which conversation, as the Bot Connector expects of a message a bot sends.
   */
  private post(row: Row, place: Place, activity: Record<string, unknown>): Promise<void> {
    const account = row.account as unknown as Account;
    return this.api(row).send(place.serviceUrl, place.conversationId, {
      ...activity,
      from: { id: `28:${account.appId}` },
      recipient: { id: place.user },
      conversation: { id: place.conversationId },
    });
  }

  // Records

  /** The Bot Connector for the saved registration; its token is kept while it is good. */
  private api(row: Row): TeamsConnector {
    const account = row.account as unknown as Account;
    const key = `${row.id}:${account.appId}:${account.tenantId}:${row.secret}`;
    if (this.connector?.key !== key) {
      this.connector = {
        key,
        api: new TeamsConnector(
          this.ctx.config.teamsLogin,
          account.tenantId,
          account.appId,
          this.vault.open(row.secret!),
          this.http,
        ),
      };
    }
    return this.connector.api;
  }

  private async row(): Promise<Row | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.channels)
      .where(eq(schema.channels.kind, 'teams'))
      .limit(1);
    return row ?? null;
  }

  private async person(teamsUserId: string): Promise<Person | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.teamsPeople)
      .where(eq(schema.teamsPeople.teamsUserId, teamsUserId))
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
