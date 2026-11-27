import {
  isLocale,
  LIVE_ACTIVITY_NAME,
  pushWanted,
  type ApnsSet,
  type ApnsStatus,
  type LiveActivityPhase,
  type LiveActivityProps,
  type LiveActivitySet,
  type Locale,
  type NoticeEvent,
  type PushDeviceSet,
  type TurnEvent,
} from '@leafbot/shared';
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import { hashSession } from '../auth';
import type { Ctx } from '../context';
import { schema } from '../db';
import { translator } from '../i18n';
import { HttpError } from '../util';
import {
  activityRequest,
  alertRequest,
  ApnsToken,
  http2Transport,
  readableKey,
  type ApnsActivity,
  type ApnsAlert,
  type ApnsCredentials,
  type ApnsTransport,
} from './apns';
import type { VaultService } from './vault';
import { OWNER_ID } from '../users';

const KEY = 'secret.apns';
/** Long replies are cut; the phone shows only the first lines anyway. */
const BODY_MAX = 240;

/** Apple ends a Live Activity after eight hours; one kept longer here could only be refused. */
const ACTIVITY_LIFE_MS = 8 * 60 * 60 * 1000;
/** Without a newer update by then, the phone dims the activity as out of date. */
const ACTIVITY_STALE_S = 30 * 60;
/** How long a finished one stays on the lock screen: long enough to be seen, a failure longer. */
const ACTIVITY_DONE_S = 15 * 60;
const ACTIVITY_FAILED_S = 60 * 60;
/** A few phones at most watch one conversation; more would be a phone that keeps starting them. */
const ACTIVITIES_PER_THREAD = 5;

/**
 * A Live Activity a phone started for a conversation's work. Kept in memory only: it lives a few
 * hours at most, and after a restart the phone shows it dimmed as out of date until it goes.
 */
interface Activity {
  token: string;
  /** The person whose phone started it. */
  by: string;
  sandbox: boolean | null;
  locale: Locale;
  bot: string;
  startedAt: number;
  phase: LiveActivityPhase;
  /** The work failed; the end says so instead of done. */
  failed: boolean;
}

/** The phase a conversation's turn state shows as; null once the work is over. */
export function phaseOf(state: TurnEvent['state']): LiveActivityPhase | null {
  if (state === 'waiting') return 'waiting';
  if (state === 'running' || state === 'queued') return 'working';
  return null;
}

/** A device and the person it was signed in as; the access key stands for the owner. */
type Device = typeof schema.pushDevices.$inferSelect & { userId: string };

/**
 * Notifications on phones while the app is closed. The phone app registers its push token with
 * its own choices; each notice from the bots is sent to the devices that want it, through Apple's
 * service with the key saved here (sealed with the vault key).
 */
export class PushService {
  private h2 = http2Transport();
  /** How requests reach Apple; tests replace it. */
  transport: ApnsTransport = this.h2;
  private token: { creds: ApnsCredentials; signer: ApnsToken } | null = null;

  constructor(
    private ctx: Ctx,
    private vault: VaultService,
  ) {}

  /**
   * Whether a person may change a phone's registration: a phone nobody holds, one whose session has
   * ended, or one they hold themselves. Knowing another person's token is not enough to take their
   * phone's notices away or to send it someone else's.
   */
  private async mayChange(token: string, userId: string): Promise<boolean> {
    const [device] = await this.ctx.db
      .select({ sessionId: schema.pushDevices.sessionId })
      .from(schema.pushDevices)
      .where(eq(schema.pushDevices.token, token.toLowerCase()))
      .limit(1);
    if (!device) return true;
    // Registered with the access key, which stands for the owner.
    if (!device.sessionId) return userId === OWNER_ID;
    const [session] = await this.ctx.db
      .select({ userId: schema.sessions.userId })
      .from(schema.sessions)
      .where(eq(schema.sessions.id, device.sessionId))
      .limit(1);
    return !session || session.userId === userId;
  }

  async register(input: PushDeviceSet, sessionToken: string | undefined, userId: string): Promise<void> {
    if (!(await this.mayChange(input.token, userId))) throw new HttpError(409, 'error.pushTokenTaken');
    const values = {
      platform: input.platform,
      locale: input.locale,
      level: input.level,
      mutes: input.mutes,
      // An update without the list keeps the one the server has counted up meanwhile.
      ...(input.unread ? { unread: [...new Set(input.unread)] } : {}),
      sessionId: sessionToken ? hashSession(sessionToken) : null,
      updatedAt: new Date(),
    };
    await this.ctx.db
      .insert(schema.pushDevices)
      .values({ token: input.token.toLowerCase(), ...values })
      .onConflictDoUpdate({ target: schema.pushDevices.token, set: values });
  }

  /** A person lets their own phone go; another person's stays as it is. */
  async unregister(token: string, userId: string): Promise<void> {
    if (await this.mayChange(token, userId)) await this.forget(token);
  }

  private async forget(token: string): Promise<void> {
    await this.ctx.db.delete(schema.pushDevices).where(eq(schema.pushDevices.token, token.toLowerCase()));
  }

  async apnsStatus(): Promise<ApnsStatus> {
    const c = await this.credentials();
    return c
      ? { configured: true, teamId: c.teamId, keyId: c.keyId, bundleId: c.bundleId }
      : { configured: false, teamId: null, keyId: null, bundleId: null };
  }

  async setApns(input: ApnsSet): Promise<void> {
    const key = input.key.trim();
    if (!readableKey(key)) throw new HttpError(400, 'error.apnsKey');
    const sealed = this.vault.seal(JSON.stringify({ ...input, key }));
    await this.ctx.db
      .insert(schema.kv)
      .values({ key: KEY, value: sealed })
      .onConflictDoUpdate({ target: schema.kv.key, set: { value: sealed } });
    this.token = null;
  }

  async clearApns(): Promise<void> {
    await this.ctx.db.delete(schema.kv).where(eq(schema.kv.key, KEY));
    this.token = null;
  }

  private activities = new Map<string, Activity[]>();

  /**
   * Keeps a Live Activity the phone started for a conversation's work up to date from here, since
   * the app is asleep while it shows. Says whether this server can send to it at all: without an
   * Apple key the phone ends it at once rather than show work that never moves.
   */
  async watchActivity(
    threadId: string,
    input: LiveActivitySet,
    userId: string,
    stateOf: () => Promise<TurnEvent['state']>,
  ): Promise<{ pushing: boolean; over?: boolean }> {
    if (!(await this.credentials())) return { pushing: false };
    const [row] = await this.ctx.db
      .select({ name: schema.bots.name })
      .from(schema.threads)
      .innerJoin(schema.bots, eq(schema.bots.id, schema.threads.botId))
      .where(eq(schema.threads.id, threadId))
      .limit(1);
    const t = translator(input.locale);
    const token = input.token.toLowerCase();
    const now = Date.now();
    // Activities past Apple's limit are gone on the phones too, in every conversation.
    for (const [id, list] of this.activities) {
      const live = list.filter((a) => now - a.startedAt < ACTIVITY_LIFE_MS);
      if (live.length) this.activities.set(id, live);
      else this.activities.delete(id);
    }
    // The phone's own start, unless it is in the future or older than an activity can be.
    const since =
      input.since && input.since <= now && now - input.since < ACTIVITY_LIFE_MS ? input.since : null;
    // An activity belongs to the person whose phone started it: another person who learns its
    // token cannot have this server write on that lock screen.
    for (const list of this.activities.values()) {
      if (list.some((a) => a.token === token && a.by !== userId)) {
        throw new HttpError(409, 'error.pushTokenTaken');
      }
    }
    const list = this.activities.get(threadId) ?? [];
    // Apple may give a running activity a new token; the phone sends it with the same start, and
    // it takes the old token's place instead of being a second activity. Only the same person's.
    const before = list.find(
      (a) => a.by === userId && (a.token === token || (since !== null && a.startedAt === since)),
    );
    const entry: Activity = {
      token,
      by: userId,
      // A new token comes from the same build, so from the same one of Apple's services.
      sandbox: before?.sandbox ?? null,
      locale: input.locale,
      bot: row?.name ?? t('push.bot'),
      startedAt: since ?? before?.startedAt ?? now,
      phase: before?.phase ?? 'working',
      failed: before?.failed ?? false,
    };
    this.activities.set(threadId, [...list.filter((a) => a !== before), entry].slice(-ACTIVITIES_PER_THREAD));
    // The work is read only once the activity is kept: a turn that ends from now on finds it and
    // ends it, and one that ended before is seen here.
    const state = await stateOf();
    const phase = phaseOf(state);
    if (!phase) {
      // A short reply can be over before the phone has Apple's token: it ends the card itself.
      this.dropActivity(threadId, token);
      return { pushing: true, over: true };
    }
    // Already waiting for the person: the card says so at once.
    if (phase !== entry.phase) await this.activityTurn({ threadId, botId: '', state });
    return { pushing: true };
  }

  /** A failed turn ends its activities as failed rather than done. */
  activityNotice(e: NoticeEvent): void {
    if (e.kind !== 'error') return;
    for (const a of this.activities.get(e.threadId) ?? []) a.failed = true;
  }

  /** How the conversation's last turn ended: a stop or a failure shows as such, not as done. */
  private async lastEnd(threadId: string): Promise<'done' | 'failed' | 'stopped'> {
    const [last] = await this.ctx.db
      .select({ status: schema.turns.status })
      .from(schema.turns)
      .where(
        and(
          eq(schema.turns.threadId, threadId),
          isNotNull(schema.turns.finishedAt),
          // The server's own upkeep after the work is not the work.
          ne(schema.turns.source, 'upkeep'),
        ),
      )
      .orderBy(desc(schema.turns.finishedAt))
      .limit(1)
      .catch(() => []);
    if (last?.status === 'error') return 'failed';
    if (last?.status === 'interrupted') return 'stopped';
    return 'done';
  }

  /** Moves a conversation's activities along with its work, and ends them when it is over. */
  async activityTurn(e: TurnEvent): Promise<void> {
    const list = this.activities.get(e.threadId);
    if (!list?.length) return;
    const phase = phaseOf(e.state);
    if (!phase) this.activities.delete(e.threadId);
    const end = phase ? null : await this.lastEnd(e.threadId);
    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    await Promise.all(
      list.map(async (a) => {
        if (now - a.startedAt >= ACTIVITY_LIFE_MS) return this.dropActivity(e.threadId, a.token);
        // The same phase again (a second tool, a second card) changes nothing on the lock screen.
        if (phase && phase === a.phase) return;
        const shown: LiveActivityPhase = phase ?? (a.failed ? 'failed' : (end ?? 'done'));
        a.phase = shown;
        const t = translator(a.locale);
        const props: LiveActivityProps = {
          bot: a.bot,
          state: t(`activity.${shown}`),
          phase: shown,
          since: a.startedAt,
        };
        const update: ApnsActivity = {
          event: phase ? 'update' : 'end',
          timestamp: seconds,
          contentState: { name: LIVE_ACTIVITY_NAME, props: JSON.stringify(props) },
          ...(phase
            ? { staleDate: seconds + ACTIVITY_STALE_S }
            : { dismissalDate: seconds + (shown === 'failed' ? ACTIVITY_FAILED_S : ACTIVITY_DONE_S) }),
        };
        const result = await this.sendActivity(a, update);
        if (result === 'gone') this.dropActivity(e.threadId, a.token);
      }),
    ).catch((err: unknown) => console.warn('live activity', err));
  }

  private dropActivity(threadId: string, token: string) {
    const left = (this.activities.get(threadId) ?? []).filter((a) => a.token !== token);
    if (left.length) this.activities.set(threadId, left);
    else this.activities.delete(threadId);
  }

  /** One update to one activity, learning whether its token is from Apple's test service. */
  private async sendActivity(a: Activity, update: ApnsActivity): Promise<'sent' | 'gone' | 'refused'> {
    const creds = await this.credentials();
    if (!creds) return 'gone';
    if (!this.token || JSON.stringify(this.token.creds) !== JSON.stringify(creds)) {
      this.token = { creds, signer: new ApnsToken(creds) };
    }
    const tries = a.sandbox === null ? [false, true] : [a.sandbox];
    for (const sandbox of tries) {
      const res = await this.transport(
        activityRequest(a.token, sandbox, this.token.signer.get(), creds.bundleId, update),
      ).catch(() => null);
      if (!res) return 'refused';
      if (res.status === 200) {
        a.sandbox = sandbox;
        return 'sent';
      }
      if (res.reason === 'BadDeviceToken' && tries.length > 1) continue;
      // The activity ended on the phone, or its token was never good.
      if (res.status === 410 || res.reason === 'BadDeviceToken' || res.reason === 'ExpiredToken')
        return 'gone';
      console.warn('live activity refused', res.status, res.reason);
      return 'refused';
    }
    return 'gone';
  }

  /** Lets go of the open connections to Apple. */
  stop() {
    this.h2.close();
  }

  /** Sends a notice to every phone that wants it; failures are logged, never thrown. */
  /** Tells the devices of `users` (everyone's without it) about a reply, a card or a failure. */
  async notice(e: NoticeEvent, users?: string[]): Promise<void> {
    try {
      const devices = (await this.liveDevices()).filter(
        (d) => pushWanted(e, d.level, d.mutes) && (!users || users.includes(d.userId)),
      );
      if (!devices.length) return;
      const [bot] = await this.ctx.db
        .select({ name: schema.bots.name })
        .from(schema.bots)
        .where(eq(schema.bots.id, e.botId))
        .limit(1);
      await Promise.all(
        devices.map(async (d) => {
          const t = translator(isLocale(d.locale) ? d.locale : 'tr');
          const name = bot?.name ?? t('push.bot');
          const title =
            e.kind === 'needsYou'
              ? t('push.needsYou', { name })
              : e.kind === 'error'
                ? t('push.error', { name })
                : name;
          const text = e.text.length > BODY_MAX ? `${e.text.slice(0, BODY_MAX - 1)}…` : e.text;
          const badge = await this.countUnread(d, e.botId);
          return this.send(d, {
            title,
            body: text,
            threadId: e.threadId,
            collapseId: `${e.kind}:${e.threadId}`,
            data: { kind: e.kind, botId: e.botId, threadId: e.threadId },
            ...(badge === null ? {} : { badge }),
          });
        }),
      );
    } catch (err) {
      console.warn('push notice', err);
    }
  }

  /**
   * Tells the phones of those who look after the server (but `except`, who added the person
   * themselves) that someone new came, so they choose the person's team spaces. A phone that wants
   * no notifications gets none; failures are logged, never thrown.
   */
  async newcomer(userId: string, except?: string): Promise<void> {
    await this.toManagers('newcomer', userId, except, (t, name) => ({
      title: t('push.newcomerTitle'),
      body: name ? t('push.newcomer', { name }) : t('push.newcomerNameless'),
      threadId: 'newcomer',
      collapseId: `newcomer:${userId}`,
      data: { kind: 'newcomer' },
    }));
  }

  /** Tells those who look after the server that someone asks to join the closed space `space`. */
  async spaceRequest(userId: string, space: string): Promise<void> {
    await this.toManagers('space request', userId, undefined, (t, name) => ({
      title: t('push.spaceRequestTitle'),
      body: name ? t('push.spaceRequest', { name, space }) : t('push.spaceRequestNameless', { space }),
      threadId: 'space-request',
      collapseId: `space-request:${userId}:${space}`,
      data: { kind: 'space-request' },
    }));
  }

  /** A message about the person `userId` to the phones of those who look after the server. */
  private async toManagers(
    what: string,
    userId: string,
    except: string | undefined,
    make: (
      t: ReturnType<typeof translator>,
      name: string | null | undefined,
    ) => Parameters<PushService['send']>[1],
  ): Promise<void> {
    try {
      const [person] = await this.ctx.db
        .select({ displayName: schema.users.displayName, username: schema.users.username })
        .from(schema.users)
        .where(eq(schema.users.id, userId))
        .limit(1);
      const managers = await this.ctx.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(and(inArray(schema.users.role, ['owner', 'admin']), isNull(schema.users.disabledAt)));
      const to = new Set(managers.map((m) => m.id).filter((id) => id !== except));
      const devices = (await this.liveDevices()).filter((d) => to.has(d.userId) && d.level !== 'off');
      const name = person?.displayName || person?.username;
      await Promise.all(
        devices.map((d) => this.send(d, make(translator(isLocale(d.locale) ? d.locale : 'tr'), name))),
      );
    } catch (err) {
      console.warn(`push ${what}`, err);
    }
  }

  /**
   * Counts the notice's bot as unread on the phone and gives the number for its icon, as the phone
   * counts it: bots, not messages. In one statement, so two notices at once both count. Null for
   * an app that keeps no such number.
   */
  private async countUnread(d: Device, botId: string): Promise<number | null> {
    if (!d.unread) return null;
    const [row] = await this.ctx.db
      .update(schema.pushDevices)
      .set({
        unread: sql`case when ${schema.pushDevices.unread} ? ${botId} then ${schema.pushDevices.unread}
          else ${schema.pushDevices.unread} || jsonb_build_array(${botId}::text) end`,
      })
      .where(and(eq(schema.pushDevices.token, d.token), isNotNull(schema.pushDevices.unread)))
      .returning({ unread: schema.pushDevices.unread });
    return row?.unread ? row.unread.length : null;
  }

  /** A notification to one registered phone right now, so the person sees what they will get. */
  async test(token: string, userId: string): Promise<void> {
    const [device] = await this.ctx.db
      .select()
      .from(schema.pushDevices)
      .where(eq(schema.pushDevices.token, token.toLowerCase()))
      .limit(1);
    // Another person's phone answers as one that is not registered, so a token cannot be tried out.
    if (!device || !(await this.mayChange(token, userId)))
      throw new HttpError(404, 'error.pushDeviceUnknown');
    const t = translator(isLocale(device.locale) ? device.locale : 'tr');
    const result = await this.send(device, {
      title: t('push.testTitle'),
      body: t('push.testBody'),
      threadId: 'test',
      collapseId: 'test',
      data: { kind: 'test' },
    });
    if (result === 'unconfigured') throw new HttpError(409, 'error.apnsUnconfigured');
    if (result === 'refused') throw new HttpError(502, 'error.apnsRefused');
    if (result === 'gone') throw new HttpError(410, 'error.pushDeviceGone');
  }

  /** Devices whose registering session is still signed in; the rest are let go. */
  private async liveDevices(): Promise<Device[]> {
    const devices = await this.ctx.db.select().from(schema.pushDevices);
    const sessionIds = [...new Set(devices.map((d) => d.sessionId).filter((s): s is string => !!s))];
    const people = new Map(
      sessionIds.length
        ? (
            await this.ctx.db
              .select({ id: schema.sessions.id, userId: schema.sessions.userId })
              .from(schema.sessions)
              .where(inArray(schema.sessions.id, sessionIds))
          ).map((r) => [r.id, r.userId])
        : [],
    );
    const live = new Set(people.keys());
    const ended = devices.filter((d) => d.sessionId && !live.has(d.sessionId)).map((d) => d.token);
    if (ended.length) {
      await this.ctx.db.delete(schema.pushDevices).where(inArray(schema.pushDevices.token, ended));
    }
    return devices
      .filter((d) => !d.sessionId || live.has(d.sessionId))
      .map((d) => ({ ...d, userId: d.sessionId ? people.get(d.sessionId)! : OWNER_ID }));
  }

  private async credentials(): Promise<ApnsCredentials | null> {
    const [row] = await this.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, KEY)).limit(1);
    if (!row) return null;
    try {
      return JSON.parse(this.vault.open(String(row.value))) as ApnsCredentials;
    } catch {
      // A data folder restored without its vault key.
      return null;
    }
  }

  /**
   * One notification to one device. A build run from Xcode gets its token from Apple's test
   * service, an installed one from the real one; which a device uses is learnt from the answer.
   */
  private async send(
    d: typeof schema.pushDevices.$inferSelect,
    alert: ApnsAlert,
  ): Promise<'sent' | 'gone' | 'refused' | 'unconfigured'> {
    const creds = await this.credentials();
    if (!creds) return 'unconfigured';
    if (!this.token || JSON.stringify(this.token.creds) !== JSON.stringify(creds)) {
      this.token = { creds, signer: new ApnsToken(creds) };
    }
    const tries = d.sandbox === null ? [false, true] : [d.sandbox];
    for (const sandbox of tries) {
      const req = alertRequest(d.token, sandbox, this.token.signer.get(), creds.bundleId, alert);
      let res;
      try {
        res = await this.transport(req);
      } catch (err) {
        console.warn('push send', err);
        return 'refused';
      }
      if (res.status === 200) {
        if (d.sandbox !== sandbox) {
          await this.ctx.db
            .update(schema.pushDevices)
            .set({ sandbox })
            .where(eq(schema.pushDevices.token, d.token));
        }
        return 'sent';
      }
      // The app was removed from the phone, or the token belongs to the other service.
      if (res.status === 410 || (res.reason === 'BadDeviceToken' && tries.length === 1)) {
        await this.forget(d.token);
        return 'gone';
      }
      if (res.reason === 'BadDeviceToken') continue;
      console.warn('push refused', res.status, res.reason);
      return 'refused';
    }
    await this.forget(d.token);
    return 'gone';
  }
}
