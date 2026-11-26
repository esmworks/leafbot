import type { Bot, Group, Routine, RoutineRun, Thread } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';

describe('botu duraklatma', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const pause = (botId: string, paused = true) => t.api<Bot>('POST', `/api/bots/${botId}/pause`, { paused });
  const turnsOf = (threadId: string) =>
    t.db.db.select().from(schema.turns).where(eq(schema.turns.threadId, threadId));

  it('duraklatılan botun süren işi durur ve neden durduğu yazılır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const thread = await main(a.id);
    await t.send(thread.id, '[bekle:5000] uzun iş');
    await waitFor(async () => t.engine.requests.some((r) => r.botId === a.id));

    const r = await pause(a.id);
    expect(r.status).toBe(200);
    expect(r.body.pausedAt).toBeTruthy();
    await t.services.turns.idle(5000);
    const [turn] = await turnsOf(thread.id);
    expect(turn!.status).toBe('interrupted');
    expect((await t.messages(thread.id)).some((m) => m.text.includes('duraklatıldı'))).toBe(true);
  });

  it('arşivlenen botun süren işi durur ve neden durduğu yazılır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const thread = await main(a.id);
    await t.send(thread.id, '[bekle:5000] uzun iş');
    await waitFor(async () => t.engine.requests.some((r) => r.botId === a.id));
    expect((await t.api('POST', `/api/bots/${a.id}/archive`)).status).toBe(200);
    await t.services.turns.idle(5000);
    const [turn] = await turnsOf(thread.id);
    expect(turn!.status).toBe('interrupted');
    expect((await t.messages(thread.id)).some((m) => m.text.includes('arşivlendi'))).toBe(true);
  });

  it('duraklatılmış bota yazılan mesaj bekler, bot sürdürülünce cevaplanır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const thread = await main(a.id);
    await pause(a.id);
    await t.send(thread.id, 'merhaba');
    // The scheduler has had its chance; the message is still waiting.
    await new Promise((r) => setTimeout(r, 100));
    expect((await turnsOf(thread.id)).map((x) => x.status)).toEqual(['queued']);
    expect(t.engine.requests.some((x) => x.botId === a.id)).toBe(false);

    await pause(a.id, false);
    await t.services.turns.idle();
    expect((await turnsOf(thread.id)).map((x) => x.status)).toEqual(['done']);
    expect((await t.messages(thread.id)).at(-1)!.role).toBe('assistant');
  });

  it('duraklatılmış botun rutini nedeniyle atlanır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const routine = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Rapor',
        prompt: 'rapor yaz',
        schedule: { type: 'interval', minutes: 30 },
      })
    ).body;
    await pause(a.id);
    await t.api('POST', `/api/routines/${routine.id}/run`);
    const runs = (await t.api<RoutineRun[]>('GET', `/api/routines/${routine.id}/runs`)).body;
    expect(runs.map((x) => [x.status, x.reason])).toEqual([['skipped', 'Bot duraklatılmış']]);
    expect(t.engine.requests).toHaveLength(0);
  });

  it('başka bot duraklatılmış bota iş veremez; nedeni ona söylenir', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    await pause(b.id);
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:bot_send {"bot":"Ayşe","message":"rapor hazır mı"}]');
    await t.services.turns.idle();
    expect(t.engine.requests.some((x) => x.botId === b.id)).toBe(false);
    expect((await t.messages(ta.id)).at(-1)!.text).toContain('Ayşe duraklatılmış');
  });

  it('grup duraklatılınca içindeki botlar da iş almaz; grup sürünce bekleyen mesaj cevaplanır', async () => {
    const g = (await t.api<Group>('POST', '/api/groups', { name: 'Ekip' })).body;
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    const paused = await t.api<Group>('POST', `/api/groups/${g.id}/pause`, { paused: true });
    expect(paused.body.pausedAt).toBeTruthy();
    const thread = await main(a.id);
    await t.send(thread.id, 'merhaba');
    await new Promise((r) => setTimeout(r, 100));
    expect((await turnsOf(thread.id)).map((x) => x.status)).toEqual(['queued']);

    await t.api('POST', `/api/groups/${g.id}/pause`, { paused: false });
    await t.services.turns.idle();
    expect((await turnsOf(thread.id)).map((x) => x.status)).toEqual(['done']);
  });

  it('bütün botları duraklatma yalnız yöneticinin; sürdürünce grupların duraklatması da kalkar', async () => {
    const g = (await t.api<Group>('POST', '/api/groups', { name: 'Ekip' })).body;
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    await t.bot({ name: 'Ayşe' });
    const member = await t.person('uye', 'member');
    const refused = await member.api('POST', '/api/bots/pause-all', { paused: true });
    expect(refused.status).toBe(403);

    expect((await t.api<{ count: number }>('POST', '/api/bots/pause-all', { paused: true })).body.count).toBe(
      2,
    );
    await t.api('POST', `/api/groups/${g.id}/pause`, { paused: true });
    expect(
      (await t.api<{ count: number }>('POST', '/api/bots/pause-all', { paused: false })).body.count,
    ).toBe(2);
    expect(await t.services.bots.isPaused(await t.services.bots.get(a.id))).toBe(false);
  });
});
