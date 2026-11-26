import type { Bot, Thread } from '@leafbot/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { newId } from '../src/util';
import { testServer, waitFor, type TestServer } from './helpers';

describe('boştaki uzun sohbet önceden özetlenir', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
    await t.api('PATCH', '/api/settings', { idleCompact: true, claudeCompactWindow: 200_000 });
  });
  afterEach(() => t.dispose());

  const thread = async (botId: string) =>
    (await t.api<Thread>('POST', `/api/bots/${botId}/threads`, {})).body;
  /** Half an hour and a minute on: the conversation counts as quiet. */
  const later = () => new Date(Date.now() + 31 * 60_000);
  const row = async (id: string) =>
    (await t.db.db.select().from(schema.threads).where(eq(schema.threads.id, id)))[0]!;
  const upkeep = (threadId: string) =>
    t.db.db
      .select()
      .from(schema.turns)
      .where(and(eq(schema.turns.threadId, threadId), eq(schema.turns.source, 'upkeep')));
  const full = async (bot: Bot, tokens = 180_000) => {
    const th = await thread(bot.id);
    await t.send(th.id, `[bağlam:${tokens}] uzun bir iş`);
    await t.services.turns.idle();
    return th;
  };

  it('dolmaya yakın ve sessiz sohbeti bir kez özetler, maliyetini sayar', async () => {
    const bot = await t.bot();
    const th = await full(bot);
    const session = (await row(th.id)).engineSessionId;
    expect((await row(th.id)).engineSessionTokens).toBe(180_000);

    // Just answered: not quiet yet.
    expect(await t.services.turns.sweepIdle()).toBe(0);
    expect(t.engine.compactions).toHaveLength(0);

    expect(await t.services.turns.sweepIdle(later())).toBe(1);
    expect(t.engine.compactions).toHaveLength(1);
    expect(t.engine.compactions[0]).toMatchObject({ threadId: th.id, sessionId: session });
    expect((await row(th.id)).engineSessionTokens).toBe(20_000);
    const [turn] = await upkeep(th.id);
    expect(turn).toMatchObject({ status: 'done', costUsd: 0.05 });
    const line = (await t.messages(th.id)).find((m) => m.role === 'system' && m.props.kind === 'compacted');
    expect(line?.text).toContain('boşta');

    // Folded already: nothing more to do.
    expect(await t.services.turns.sweepIdle(later())).toBe(0);
    expect(t.engine.compactions).toHaveLength(1);
  });

  it('özetleme, oturumun turlarının çalıştığı danışmanla çalışır', async () => {
    await t.api('PATCH', '/api/settings', { claudeAdvisorModel: 'opus' });
    const bot = await t.bot();
    await full(bot);
    expect(t.engine.requests.at(-1)!.advisorModel).toBe('opus');
    expect(await t.services.turns.sweepIdle(later())).toBe(1);
    expect(t.engine.compactions[0]!.advisorModel).toBe('opus');
  });

  it('kısa sohbete, ayar kapalıyken, durdurulmuş ya da sınırını aşmış bota dokunmaz', async () => {
    const short = await t.bot({ name: 'Kısa' });
    await full(short, 50_000);
    expect(await t.services.turns.sweepIdle(later())).toBe(0);

    const bot = await t.bot({ name: 'Uzun' });
    await full(bot);
    await t.api('PATCH', '/api/settings', { idleCompact: false });
    expect(await t.services.turns.sweepIdle(later())).toBe(0);
    await t.api('PATCH', '/api/settings', { idleCompact: true });

    await t.api('POST', `/api/bots/${bot.id}/pause`, { paused: true });
    expect(await t.services.turns.sweepIdle(later())).toBe(0);
    await t.api('POST', `/api/bots/${bot.id}/pause`, { paused: false });

    // A dollar spent elsewhere today, past the bot's half-dollar day.
    const other = await thread(bot.id);
    await t.db.db.insert(schema.turns).values({
      id: newId(),
      threadId: other.id,
      botId: bot.id,
      source: 'user',
      status: 'done',
      prompt: 'pahalı',
      costUsd: 1,
      startedAt: new Date(),
      finishedAt: new Date(),
    });
    expect((await t.api('PATCH', `/api/bots/${bot.id}`, { dailyLimitUsd: 0.5 })).status).toBe(200);
    expect(await t.services.usage.reached(await t.services.bots.get(bot.id))).not.toBeNull();
    expect(await t.services.turns.sweepIdle(later())).toBe(0);
    await t.api('PATCH', `/api/bots/${bot.id}`, { dailyLimitUsd: 0 });

    expect(t.engine.compactions).toHaveLength(0);
    expect(await t.services.turns.sweepIdle(later())).toBe(1);
  });

  it('özetleme sürerken gelen mesaj bekler, sonra özetlenmiş oturumda çalışır', async () => {
    const bot = await t.bot();
    const th = await full(bot);
    const session = (await row(th.id)).engineSessionId;
    let open!: () => void;
    t.engine.compactGate = new Promise((r) => (open = r));
    const sweep = t.services.turns.sweepIdle(later());
    await waitFor(async () => t.engine.compactions.length === 1);

    const before = t.engine.requests.length;
    await t.send(th.id, 'yeni soru');
    await new Promise((r) => setTimeout(r, 200));
    expect(t.engine.requests.length).toBe(before);

    open();
    expect(await sweep).toBe(1);
    await t.services.turns.idle();
    expect(t.engine.requests.length).toBe(before + 1);
    expect(t.engine.requests.at(-1)!.sessionId).toBe(session);
    const said = await t.messages(th.id);
    const folded = said.findIndex((m) => m.props.kind === 'compacted');
    const asked = said.findIndex((m) => m.role === 'user' && m.text === 'yeni soru');
    expect(folded).toBeGreaterThan(-1);
    expect(asked).toBeGreaterThan(-1);
  });

  it('durdurulan sohbetin özetlemesi yarıda kalır ve satır eklenmez', async () => {
    const bot = await t.bot();
    const th = await full(bot);
    let open!: () => void;
    t.engine.compactGate = new Promise((r) => (open = r));
    const sweep = t.services.turns.sweepIdle(later());
    await waitFor(async () => t.engine.compactions.length === 1);
    await t.services.turns.interrupt(th.id);
    open();
    expect(await sweep).toBe(0);
    expect((await upkeep(th.id))[0]?.status).toBe('interrupted');
    expect((await t.messages(th.id)).some((m) => m.props.kind === 'compacted')).toBe(false);
    expect((await row(th.id)).engineSessionTokens).toBe(180_000);
  });

  it('başarısız özetleme her taramada yeniden denenmez; sohbet ilerleyince denenir', async () => {
    const bot = await t.bot();
    const th = await full(bot);
    t.engine.compactFails = true;
    expect(await t.services.turns.sweepIdle(later())).toBe(0);
    expect(t.engine.compactions).toHaveLength(1);
    expect((await upkeep(th.id))[0]).toMatchObject({ status: 'error', costUsd: 0.02 });
    expect(await t.services.turns.sweepIdle(later())).toBe(0);
    expect(t.engine.compactions).toHaveLength(1);

    t.engine.compactFails = false;
    await t.send(th.id, '[bağlam:185000] devam');
    await t.services.turns.idle();
    expect(await t.services.turns.sweepIdle(later())).toBe(1);
    expect(t.engine.compactions).toHaveLength(2);
  });

  it('özetlenemeyen sohbetler sıradakilerin önünü kesmez', async () => {
    const paused = await t.bot({ name: 'Duran' });
    for (let i = 0; i < 4; i++) await full(paused, 190_000);
    await t.api('POST', `/api/bots/${paused.id}/pause`, { paused: true });
    const bot = await t.bot({ name: 'Çalışan' });
    const th = await full(bot, 150_000);
    expect(await t.services.turns.sweepIdle(later())).toBe(1);
    expect(t.engine.compactions.map((c) => c.threadId)).toEqual([th.id]);
  });
});
