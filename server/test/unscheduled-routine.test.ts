import type { Routine, RoutineRun } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('zamanlamasız rutin', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('saatle hiç çalışmaz, webhook çağrısıyla çalışır ve açık kalır', async () => {
    const bot = await t.bot();
    const made = await t.api<Routine>('POST', '/api/routines', {
      botId: bot.id,
      name: 'Sipariş gelince',
      prompt: 'Siparişi özetle.',
      schedule: { type: 'unscheduled' },
    });
    expect(made.status).toBe(200);
    const r = made.body;
    expect(r.enabled).toBe(true);
    expect(r.nextRunAt).toBeNull();
    const token = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body.webhookToken!;

    // A week goes by: the clock never starts it.
    t.now.value = new Date(t.now.value.getTime() + 7 * 86_400_000);
    await t.services.routines.tick();
    await t.services.turns.idle();
    const runs = async () => (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body;
    expect(await runs()).toHaveLength(0);

    const call = await t.app.inject({
      method: 'POST',
      url: `/api/hooks/routines/${r.id}/${token}`,
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: JSON.stringify({ order: 42 }),
    });
    expect(call.statusCode).toBeLessThan(300);
    await t.services.turns.idle();
    expect(await runs()).toHaveLength(1);
    const after = await t.services.routines.get(r.id);
    expect(after.enabled).toBe(true);
    expect(after.nextRunAt).toBeNull();
  });

  it('zamanlanmış çalıştırmadan önce bakılan ayarlarla birlikte reddedilir', async () => {
    const bot = await t.bot();
    const res = await t.api('POST', '/api/routines', {
      botId: bot.id,
      name: 'Sayfa',
      prompt: 'Bak.',
      schedule: { type: 'unscheduled' },
      watchUrl: 'https://example.com/fiyat',
    });
    expect(res.status).toBe(400);
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Sayfa',
        prompt: 'Bak.',
        schedule: { type: 'daily', time: '09:00' },
        watchUrl: 'https://example.com/fiyat',
      })
    ).body;
    expect(
      (await t.api('PATCH', `/api/routines/${r.id}`, { schedule: { type: 'unscheduled' } })).status,
    ).toBe(400);
  });
});
