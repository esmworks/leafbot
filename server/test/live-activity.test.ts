import { generateKeyPairSync } from 'node:crypto';
import type { Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ApnsRequest, ApnsResponse } from '../src/services/apns';
import { testServer, type TestServer } from './helpers';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const P8 = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const APNS = { teamId: 'TEAM123456', keyId: 'KEY1234567', bundleId: 'com.leafbot.app', key: P8 };
const TOKEN = 'cd'.repeat(40);

describe('kilit ekranındaki iş', () => {
  let t: TestServer;
  let sent: ApnsRequest[];
  let answer: (req: ApnsRequest) => ApnsResponse;
  let thread: Thread;
  beforeEach(async () => {
    t = await testServer();
    sent = [];
    answer = () => ({ status: 200 });
    t.services.push.transport = async (req) => {
      sent.push(req);
      return answer(req);
    };
    const bot = await t.bot({ name: 'Yazıcı' });
    thread = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
  });
  afterEach(() => t.dispose());

  const route = (body: Record<string, unknown> = {}) =>
    t.api<{ pushing: boolean; over?: boolean }>('PUT', `/api/threads/${thread.id}/activity`, {
      token: TOKEN,
      locale: 'tr',
      ...body,
    });
  /** As the route does while the bot is at work. */
  const watch = (
    body: { locale?: 'tr' | 'en'; since?: number } = {},
    state: 'running' | 'waiting' = 'running',
  ) => t.services.push.watchActivity(thread.id, { token: TOKEN, locale: 'tr', ...body }, state);
  const turn = (state: 'running' | 'waiting' | 'idle' | 'queued') =>
    t.services.push.activityTurn({ threadId: thread.id, botId: thread.botId, state });
  const aps = (req: ApnsRequest) => (JSON.parse(req.body) as { aps: Record<string, unknown> }).aps;
  const props = (req: ApnsRequest) =>
    JSON.parse((aps(req)['content-state'] as { props: string }).props) as Record<string, string | number>;

  it('Apple anahtarı yoksa telefona kartı hemen kapatmasını söyler', async () => {
    expect((await route()).body).toEqual({ pushing: false });
    await turn('idle');
    expect(sent).toHaveLength(0);
  });

  it('kısa iş telefon kaydolmadan bittiyse kartı telefona kapattırır, hiçbir şey saklamaz', async () => {
    await t.api('PUT', '/api/push/apns', APNS);
    expect((await route()).body).toEqual({ pushing: true, over: true });
    await turn('waiting');
    await turn('idle');
    expect(sent).toHaveLength(0);
  });

  it('kart açılırken bot zaten bekliyorsa bunu hemen söyler, sayacı telefonun başlangıcından sürdürür', async () => {
    await t.api('PUT', '/api/push/apns', APNS);
    const since = Date.now() - 60_000;
    expect(await watch({ since }, 'waiting')).toEqual({ pushing: true });
    expect(sent).toHaveLength(1);
    expect(props(sent[0]!)).toMatchObject({ phase: 'waiting', since });
  });

  it('işi durumdan duruma götürür ve bitince kapatır', async () => {
    await t.api('PUT', '/api/push/apns', APNS);
    expect(await watch()).toEqual({ pushing: true });
    // The phone started it as working: the same phase sends nothing.
    await turn('running');
    expect(sent).toHaveLength(0);
    await turn('waiting');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.token).toBe(TOKEN);
    expect(sent[0]!.headers).toMatchObject({
      'apns-push-type': 'liveactivity',
      'apns-topic': 'com.leafbot.app.push-type.liveactivity',
    });
    expect(aps(sent[0]!)).toMatchObject({ event: 'update', 'content-state': { name: 'BotWork' } });
    expect(props(sent[0]!)).toMatchObject({ bot: 'Yazıcı', state: 'Sizi bekliyor', phase: 'waiting' });
    expect(props(sent[0]!).since).toBeGreaterThan(0);
    expect(aps(sent[0]!)['stale-date']).toBeGreaterThan(aps(sent[0]!).timestamp as number);
    await turn('idle');
    expect(aps(sent[1]!)).toMatchObject({ event: 'end' });
    expect(aps(sent[1]!)['dismissal-date']).toBeGreaterThan(aps(sent[1]!).timestamp as number);
    expect(props(sent[1]!)).toMatchObject({ state: 'Bitti', phase: 'done' });
    // Ended: nothing more goes to it.
    await turn('running');
    expect(sent).toHaveLength(2);
  });

  it('başarısız iş "bir sorun" diye biter, dilini telefonun diliyle yazar', async () => {
    await t.api('PUT', '/api/push/apns', APNS);
    await watch({ locale: 'en' });
    t.services.push.activityNotice({ kind: 'error', botId: thread.botId, threadId: thread.id, text: 'x' });
    await turn('idle');
    expect(props(sent[0]!)).toMatchObject({ bot: 'Yazıcı', state: 'Ran into a problem', phase: 'failed' });
  });

  it('telefonda kapanmış kartı bırakır, test servisinin jetonunu öğrenir', async () => {
    await t.api('PUT', '/api/push/apns', APNS);
    await watch();
    answer = (req) => (req.sandbox ? { status: 200 } : { status: 400, reason: 'BadDeviceToken' });
    await turn('waiting');
    expect(sent.map((r) => r.sandbox)).toEqual([false, true]);
    answer = () => ({ status: 410, reason: 'Unregistered' });
    await turn('running');
    expect(sent.at(-1)!.sandbox).toBe(true);
    await turn('waiting');
    expect(sent).toHaveLength(3);
  });

  it('başkasının konuşmasına kart bağlanamaz', async () => {
    const ayse = await t.person('ayse');
    const r = await ayse.api('PUT', `/api/threads/${thread.id}/activity`, { token: TOKEN, locale: 'tr' });
    expect(r.status).toBe(404);
  });
});
