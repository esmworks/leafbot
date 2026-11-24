import type { Routine, RoutineCondition, RoutineRun } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db';
import { numberIn, parseNumber } from '../src/services/routine-conditions';
import type * as SkillLink from '../src/services/skill-link';
import { testServer, type TestServer } from './helpers';

/** What the stand-in page answers each time it is read; a throw is a page that could not be read. */
const web = vi.hoisted(() => ({ answer: (): string => '{}' }));
vi.mock('../src/services/skill-link', async (original) => ({
  ...(await original<typeof SkillLink>()),
  fetchPublicText: async () => web.answer(),
}));

/** A routine that starts when a number read with no AI is past a line, or far from its usual. */
describe('a number condition', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
    web.answer = () => '{}';
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, check: Record<string, unknown>) =>
    t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Satış',
      prompt: 'Satışlara bak',
      schedule: { type: 'interval', minutes: 30 },
      condition: {
        checks: [{ kind: 'number', from: 'page', url: 'https://ornek.com/satis.json', ...check }],
      },
    });
  const made = async (botId: string, check: Record<string, unknown>) => {
    const r = await make(botId, check);
    expect(r.status).toBe(200);
    return r.body;
  };
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const tick = async () => {
    t.now.value = new Date(t.now.value.getTime() + 31 * 60_000);
    await t.services.routines.tick();
    await t.services.turns.idle();
  };
  const serve = (total: number) => {
    web.answer = () => JSON.stringify({ data: { total } });
  };
  const readings = async (routineId: string) =>
    t.db.db.select().from(schema.routineReadings).where(eq(schema.routineReadings.routineId, routineId));

  it('starts a run with the number once it is past a threshold, keeping no history for it', async () => {
    const bot = await t.bot();
    const r = await made(bot.id, { path: 'data.total', op: 'above', threshold: 10 });
    const asked = t.engine.requests.length;
    serve(5);
    await tick();
    expect(t.engine.requests.length).toBe(asked);
    expect((await runs(r.id))[0]!.reason).toContain('5');
    serve(15);
    await tick();
    expect(t.engine.requests.length).toBe(asked + 1);
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt).toContain('Satışlara bak');
    expect(prompt).toContain('15');
    expect(await readings(r.id)).toHaveLength(0);
  });

  it('waits for enough readings, then starts when one is far from their average, with both numbers', async () => {
    const bot = await t.bot();
    const r = await made(bot.id, { path: 'data.total', op: 'either', than: 'average', threshold: 50 });
    const asked = t.engine.requests.length;
    for (const n of [100, 102, 98, 101]) {
      serve(n);
      await tick();
    }
    expect(t.engine.requests.length).toBe(asked);
    const quiet = await runs(r.id);
    expect(quiet.every((x) => x.status === 'skipped')).toBe(true);
    serve(40);
    await tick();
    expect(t.engine.requests.length).toBe(asked + 1);
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt).toContain('40');
    // The average of the four readings before it, which it is compared with.
    expect(prompt).toContain('100.25');
    expect(await readings(r.id)).toHaveLength(5);
  });

  it('takes a reading that could not be read as neither a reading nor zero', async () => {
    const bot = await t.bot();
    const r = await made(bot.id, { path: 'data.total', op: 'below', than: 'average', threshold: 20 });
    for (const n of [100, 100, 100]) {
      serve(n);
      await tick();
    }
    web.answer = () => JSON.stringify({ data: { other: 1 } });
    await tick();
    expect((await runs(r.id))[0]).toMatchObject({ status: 'error' });
    web.answer = () => {
      throw new Error('ağ yok');
    };
    await tick();
    expect((await runs(r.id))[0]).toMatchObject({ status: 'error' });
    expect(await readings(r.id)).toHaveLength(3);
    // A source that cannot be read is not the routine's own failure: it is not switched off.
    const [row] = await t.db.db.select().from(schema.routines).where(eq(schema.routines.id, r.id));
    expect(row!.enabled).toBe(true);
  });

  it('keeps one reading per slot, and none when looked at outside a slot', async () => {
    const bot = await t.bot();
    const r = await made(bot.id, { path: 'data.total', op: 'above', than: 'average', threshold: 10 });
    serve(7);
    await t.services.routines.conditionNow(r.id);
    expect(await readings(r.id)).toHaveLength(0);
    const conditions = (
      t.services.routines as unknown as {
        conditions: { evaluate(r: Routine, c: RoutineCondition, tr: unknown, o?: string): Promise<unknown> };
      }
    ).conditions;
    const tr = await t.services.settings.translator();
    await conditions.evaluate(r, r.condition!, tr, 'slot-1');
    await conditions.evaluate(r, r.condition!, tr, 'slot-1');
    expect(await readings(r.id)).toHaveLength(1);
  });

  it('refuses both ways against a plain threshold, a percent of zero and a missing source', async () => {
    const bot = await t.bot();
    expect((await make(bot.id, { op: 'either', threshold: 5 })).status).toBe(400);
    expect((await make(bot.id, { op: 'above', than: 'average', threshold: 0 })).status).toBe(400);
    expect((await make(bot.id, { op: 'above', threshold: 5, url: 'http://ornek.com' })).status).toBe(400);
    expect((await make(bot.id, { op: 'above', threshold: 5, absent: true })).status).toBe(400);
  });

  it('reads numbers as they are written', () => {
    expect(parseNumber('1.234,5')).toBe(1234.5);
    expect(parseNumber('1,234.5')).toBe(1234.5);
    expect(parseNumber('12.500 TL')).toBe(12500);
    expect(parseNumber('3,14')).toBe(3.14);
    expect(parseNumber('−7')).toBe(-7);
    expect(parseNumber('yok')).toBeNull();
    expect(numberIn('Sıcaklık: 23,5 °C, nem 40', 'SICAKLIK')).toBe(23.5);
    expect(numberIn('Toplam 12 ürün', '')).toBe(12);
    expect(numberIn('PRICE: 9.99', 'price')).toBe(9.99);
    expect(numberIn('{"a":[{"b":"1.200"}]}', 'a.0.b')).toBe(1200);
    expect(numberIn('{"a":1}', 'b')).toBeNull();
    expect(numberIn('42', '')).toBe(42);
  });
});
