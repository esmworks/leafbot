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
import { eq, inArray } from 'drizzle-orm';
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

  async register(input: PushDeviceSet, sessionToken: string | undefined): Promise<void> {
    const values = {
      platform: input.platform,
      locale: input.locale,
      level: input.level,
      mutes: input.mutes,
      sessionId: sessionToken ? hashSession(sessionToken) : null,
      updatedAt: new Date(),
    };
    await this.ctx.db
      .insert(schema.pushDevices)
      .values({ token: input.token.toLowerCase(), ...values })
      .onConflictDoUpdate({ target: schema.pushDevices.token, set: values });
  }

  async unregister(token: string): Promise<void> {
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
    state: TurnEvent['state'],
  ): Promise<{ pushing: boolean; over?: boolean }> {
    if (!(await this.credentials())) return { pushing: false };
    // A short reply can be over before the phone has Apple's token: it ends the card itself.
    const phase = phaseOf(state);
    if (!phase) return { pushing: true, over: true };
    const [row] = await this.ctx.db
      .select({ name: schema.bots.name })
      .from(schema.threads)
      .innerJoin(schema.bots, eq(schema.bots.id, schema.threads.botId))
      .where(eq(schema.threads.id, threadId))
      .limit(1);
    const t = translator(input.locale);
    const token = input.token.toLowerCase();
    const now = Date.now();
    const kept = (this.activities.get(threadId) ?? []).filter(
      (a) => a.token !== token && now - a.startedAt < ACTIVITY_LIFE_MS,
    );
    kept.push({
      token,
      sandbox: null,
      locale: input.locale,
      bot: row?.name ?? t('push.bot'),
      // The phone's own start, unless it is in the future or older than an activity can be.
      startedAt:
        input.since && input.since <= now && now - input.since < ACTIVITY_LIFE_MS ? input.since : now,
      phase: 'working',
      failed: false,
    });
    this.activities.set(threadId, kept.slice(-ACTIVITIES_PER_THREAD));
    // Already waiting for the person: the card says so at once.
    if (phase !== 'working') await this.activityTurn({ threadId, botId: '', state });
    return { pushing: true };
  }

  /** A failed turn ends its activities as failed rather than done. */
  activityNotice(e: NoticeEvent): void {
    if (e.kind !== 'error') return;
    for (const a of this.activities.get(e.threadId) ?? []) a.failed = true;
  }

  /** Moves a conversation's activities along with its work, and ends them when it is over. */
  async activityTurn(e: TurnEvent): Promise<void> {
    const list = this.activities.get(e.threadId);
    if (!list?.length) return;
    const phase = phaseOf(e.state);
    const now = Date.now();
    const seconds = Math.floor(now / 1000);
    if (!phase) this.activities.delete(e.threadId);
    await Promise.all(
      list.map(async (a) => {
        if (now - a.startedAt >= ACTIVITY_LIFE_MS) return this.dropActivity(e.threadId, a.token);
        // The same phase again (a second tool, a second card) changes nothing on the lock screen.
        if (phase && phase === a.phase) return;
        const ended: LiveActivityPhase = a.failed ? 'failed' : 'done';
        const shown = phase ?? ended;
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
            : { dismissalDate: seconds + (a.failed ? ACTIVITY_FAILED_S : ACTIVITY_DONE_S) }),
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
        devices.map((d) => {
          const t = translator(isLocale(d.locale) ? d.locale : 'tr');
          const name = bot?.name ?? t('push.bot');
          const title =
            e.kind === 'needsYou'
              ? t('push.needsYou', { name })
              : e.kind === 'error'
                ? t('push.error', { name })
                : name;
          const text = e.text.length > BODY_MAX ? `${e.text.slice(0, BODY_MAX - 1)}…` : e.text;
          return this.send(d, {
            title,
            body: text,
            threadId: e.threadId,
            collapseId: `${e.kind}:${e.threadId}`,
            data: { kind: e.kind, botId: e.botId, threadId: e.threadId },
          });
        }),
      );
    } catch (err) {
      console.warn('push notice', err);
    }
  }

  /** A notification to one registered phone right now, so the person sees what they will get. */
  async test(token: string): Promise<void> {
    const [device] = await this.ctx.db
      .select()
      .from(schema.pushDevices)
      .where(eq(schema.pushDevices.token, token.toLowerCase()))
      .limit(1);
    if (!device) throw new HttpError(404, 'error.pushDeviceUnknown');
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
        await this.unregister(d.token);
        return 'gone';
      }
      if (res.reason === 'BadDeviceToken') continue;
      console.warn('push refused', res.status, res.reason);
      return 'refused';
    }
    await this.unregister(d.token);
    return 'gone';
  }
}
