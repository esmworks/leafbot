import type { Routine, RoutineRun } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('a routine with a last day', () => {
  let t: TestServer;
  beforeEach(async () => {
    // The test clock starts on Monday 2026-11-16 at 08:00 in Istanbul.
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const create = (body: Record<string, unknown>) =>
    t.api<Routine>('POST', '/api/routines', {
      name: 'Trip reminder',
      prompt: 'Remind me to pack.',
      timezone: 'Europe/Istanbul',
      ...body,
    });
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const tick = async (iso: string) => {
    t.now.value = new Date(iso);
    await t.services.routines.tick();
    await t.services.turns.idle();
  };

  it('runs through its last day, then switches itself off', async () => {
    const bot = await t.bot();
    const made = await create({
      botId: bot.id,
      schedule: { type: 'daily', time: '09:00' },
      endsOn: '2026-11-17',
    });
    expect(made.status).toBe(200);
    const id = made.body.id;
    expect(made.body.endsOn).toBe('2026-11-17');
    expect(made.body.nextRunAt).toBe('2026-11-16T06:00:00.000Z');

    await tick('2026-11-16T06:00:00.000Z');
    await tick('2026-11-17T06:00:00.000Z');
    expect(await runs(id)).toHaveLength(2);
    // The 18th is after its last day: there is no next slot, though it stays on until the day ends.
    let r = await t.services.routines.get(id);
    expect(r.nextRunAt).toBeNull();
    expect(r.enabled).toBe(true);

    await tick('2026-11-17T21:00:00.000Z');
    r = await t.services.routines.get(id);
    expect(r.enabled).toBe(false);
    expect(r.pausedReason).toBe('ended');

    await tick('2026-11-18T06:00:00.000Z');
    expect(await runs(id)).toHaveLength(2);
  });

  it('is not turned on again with its last day gone by, until the day is moved', async () => {
    const bot = await t.bot();
    const id = (
      await create({ botId: bot.id, schedule: { type: 'daily', time: '09:00' }, endsOn: '2026-11-16' })
    ).body.id;
    await tick('2026-11-16T21:00:00.000Z');
    expect((await t.services.routines.get(id)).enabled).toBe(false);

    const again = await t.api('PATCH', `/api/routines/${id}`, { enabled: true });
    expect(again.status).toBe(400);
    const moved = await t.api<Routine>('PATCH', `/api/routines/${id}`, {
      enabled: true,
      endsOn: '2026-11-20',
    });
    expect(moved.status).toBe(200);
    expect(moved.body.enabled).toBe(true);
    expect(moved.body.pausedReason).toBeNull();
    expect(moved.body.nextRunAt).toBe('2026-11-17T06:00:00.000Z');
    const removed = await t.api<Routine>('PATCH', `/api/routines/${id}`, { endsOn: null });
    expect(removed.body.endsOn).toBeNull();
  });

  it('is only paused, no longer past its last day, once the day is moved while it is off', async () => {
    const bot = await t.bot();
    const id = (
      await create({ botId: bot.id, schedule: { type: 'daily', time: '09:00' }, endsOn: '2026-11-16' })
    ).body.id;
    await tick('2026-11-16T21:00:00.000Z');
    const moved = await t.api<Routine>('PATCH', `/api/routines/${id}`, { endsOn: '2026-11-30' });
    expect(moved.status).toBe(200);
    expect(moved.body.enabled).toBe(false);
    expect(moved.body.pausedReason).toBeNull();
  });

  it('refuses a new routine whose last day has gone by', async () => {
    const bot = await t.bot();
    const res = await create({
      botId: bot.id,
      schedule: { type: 'daily', time: '09:00' },
      endsOn: '2026-11-15',
    });
    expect(res.status).toBe(400);
    // A paused one may keep it: it is turned on only once the day is moved.
    const paused = await create({
      botId: bot.id,
      schedule: { type: 'daily', time: '09:00' },
      endsOn: '2026-11-15',
      enabled: false,
    });
    expect(paused.status).toBe(200);
  });

  it('runs every other week, counted from the week of its anchor day', async () => {
    const bot = await t.bot();
    const made = await create({
      botId: bot.id,
      // The week of 9 November is one it runs in; the week of the 16th is the one between.
      schedule: { type: 'weekly', days: [1], time: '09:00', weeks: 2, anchor: '2026-11-09' },
    });
    expect(made.status).toBe(200);
    expect(made.body.nextRunAt).toBe('2026-11-23T06:00:00.000Z');
    const unanchored = await create({
      botId: bot.id,
      schedule: { type: 'weekly', days: [1], time: '09:00', weeks: 2 },
    });
    expect(unanchored.status).toBe(400);
  });
});
