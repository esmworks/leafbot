import type { Routine } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAILURE_LIMIT } from '../src/services/routines';
import { OWNER_ID } from '../src/users';
import { testServer, type TestServer } from './helpers';

describe('art arda başarısız olan rutin kendini kapatır', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, prompt: string) =>
    (
      await t.api<Routine>('POST', '/api/routines', {
        botId,
        name: 'Bozulan',
        prompt,
        schedule: { type: 'interval', minutes: 30 },
        inMain: false,
      })
    ).body;
  const routine = async (id: string) =>
    (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.id === id)!;
  /** Runs it by hand `times` times, one second apart so each is its own run. */
  const runTimes = async (id: string, times: number) => {
    for (let i = 0; i < times; i++) {
      t.now.value = new Date(t.now.value.getTime() + 1000);
      await t.api('POST', `/api/routines/${id}/run`);
      await t.services.turns.idle();
    }
  };

  it('sınıra varınca kapanır, nedenini yazar, kişiye ana konuşmada haber verir; açınca sayım baştan başlar', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, '[hata]');
    await runTimes(r.id, FAILURE_LIMIT - 1);
    expect(await routine(r.id)).toMatchObject({ enabled: true, pausedReason: null });
    await runTimes(r.id, 1);
    expect(await routine(r.id)).toMatchObject({ enabled: false, nextRunAt: null, pausedReason: 'failures' });
    const main = await t.services.threads.main(bot.id, OWNER_ID);
    const told = (await t.messages(main.id)).filter((m) => m.props.routineName === 'Bozulan');
    expect(told).toHaveLength(1);
    expect(told[0]!.text).toContain(String(FAILURE_LIMIT));

    // Turned on again, one more failure is the first of a new count, not the eleventh.
    await t.api('PATCH', `/api/routines/${r.id}`, { enabled: true });
    expect(await routine(r.id)).toMatchObject({ enabled: true, pausedReason: null });
    await runTimes(r.id, 1);
    expect((await routine(r.id)).enabled).toBe(true);
  });

  it('araya giren başarılı çalışma sayımı sıfırlar', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, '[hata]');
    await runTimes(r.id, FAILURE_LIMIT - 1);
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: 'tamam' });
    await runTimes(r.id, 1);
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: '[hata]' });
    await runTimes(r.id, FAILURE_LIMIT - 1);
    expect((await routine(r.id)).enabled).toBe(true);
  });

  it('kullanım sınırı ve geçici hata rutinin hatası sayılmaz', async () => {
    const bot = await t.bot();
    const limit = await make(bot.id, '[sınır]');
    await runTimes(limit.id, FAILURE_LIMIT + 2);
    expect((await routine(limit.id)).enabled).toBe(true);
    const busy = await make(bot.id, '[meşgul]');
    await runTimes(busy.id, FAILURE_LIMIT + 2);
    expect((await routine(busy.id)).enabled).toBe(true);
  });

  it('botun başarısız işaretlediği çalışmalar da sayılır', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const r = await make(bot.id, '[araç:routine_failed {"reason":"Sayfa değişmiş"}]');
    await runTimes(r.id, FAILURE_LIMIT);
    expect(await routine(r.id)).toMatchObject({ enabled: false, pausedReason: 'failures' });
  });
});
