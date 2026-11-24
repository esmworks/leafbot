import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Routine, RoutineRun, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { patternRegex, toolAnswerHolds } from '../src/services/routine-conditions';
import { testServer, type TestServer } from './helpers';

/** A routine that starts only when something holds, looked at with no AI before each scheduled run. */
describe('routine condition', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, body: Record<string, unknown>) => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Brifing',
      prompt: 'Brifingi derle',
      schedule: { type: 'interval', minutes: 30 },
      ...body,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const tick = async (minutes = 31) => {
    t.now.value = new Date(t.now.value.getTime() + minutes * 60_000);
    await t.services.routines.tick();
    await t.services.turns.idle();
  };
  const folder = (botId: string) => join(t.dataDir, 'workspaces', 'bots', botId, 'files');
  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const giveAddress = async (botId: string) =>
    t.db.db.insert(schema.emailAddresses).values({ name: 'pasa', botId });
  const mail = async (botId: string, from: string, subject: string) =>
    t.db.db.insert(schema.emails).values({
      id: `m${Math.random().toString(36).slice(2)}`,
      botId,
      to: 'pasa@bots.example.com',
      from,
      subject,
      text: 'ekte',
      receivedAt: t.now.value,
    });

  it('starts no AI until enough files came, and keeps a run of not-met slots as one line', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, {
      condition: { checks: [{ kind: 'files', pattern: 'bolumler/*.docx', min: 2 }] },
    });
    const asked = t.engine.requests.length;
    await tick();
    await tick();
    expect(t.engine.requests.length).toBe(asked);
    const quiet = await runs(r.id);
    expect(quiet).toHaveLength(1);
    expect(quiet[0]).toMatchObject({ status: 'skipped' });
    expect(quiet[0]!.reason).toContain('bolumler/*.docx');

    mkdirSync(join(folder(bot.id), 'bolumler'), { recursive: true });
    writeFileSync(join(folder(bot.id), 'bolumler', 'satis.docx'), 'a');
    writeFileSync(join(folder(bot.id), 'bolumler', 'Üretim.DOCX'), 'b');
    await tick();
    expect(t.engine.requests.length).toBe(asked + 1);
    expect((await runs(r.id))[0]).toMatchObject({ status: 'done' });
  });

  it('writes its note with no AI when the mail did not come, and runs when it did', async () => {
    const bot = await t.bot();
    await giveAddress(bot.id);
    const r = await make(bot.id, {
      condition: {
        checks: [{ kind: 'email', filter: 'from~=funda' }],
        otherwise: 'Funda’nın maili gelmedi.',
      },
    });
    const asked = t.engine.requests.length;
    await tick();
    expect(t.engine.requests.length).toBe(asked);
    expect((await t.messages((await main(bot.id)).id)).at(-1)!.text).toBe('Funda’nın maili gelmedi.');
    expect((await runs(r.id))[0]).toMatchObject({ status: 'skipped' });

    await mail(bot.id, 'funda@ornek.com', 'Günlük tahsilat');
    await tick();
    expect(t.engine.requests.length).toBe(asked + 1);
  });

  it('holds when what it looks for is absent, as a reminder that waits for a list', async () => {
    const bot = await t.bot();
    await giveAddress(bot.id);
    const r = await make(bot.id, {
      condition: { checks: [{ kind: 'email', filter: 'subject~=liste', absent: true }] },
    });
    const asked = t.engine.requests.length;
    await tick();
    expect(t.engine.requests.length).toBe(asked + 1);
    await mail(bot.id, 'batuhan@ornek.com', 'Haftalık liste');
    await tick();
    expect(t.engine.requests.length).toBe(asked + 1);
    expect((await runs(r.id))[0]).toMatchObject({ status: 'skipped' });
  });

  it('never sends its note when it could not look, and shows that as an error', async () => {
    const bot = await t.bot();
    const { table } = await t.services.tables.define(bot.id, 'Siparişler', [{ name: 'Durum', type: 'text' }]);
    const r = await make(bot.id, {
      condition: {
        checks: [{ kind: 'table', tableId: table.id, filter: 'Durum=gecikti' }],
        otherwise: 'Gecikmiş sipariş yok.',
      },
    });
    await t.services.tables.remove(table.id);
    const before = (await t.messages((await main(bot.id)).id)).length;
    await tick();
    expect((await t.messages((await main(bot.id)).id)).length).toBe(before);
    expect((await runs(r.id))[0]).toMatchObject({ status: 'error' });
  });

  it('looks again until its time the same day, then keeps to its schedule', async () => {
    const bot = await t.bot();
    await giveAddress(bot.id);
    // 05:40 UTC is 08:40 in Istanbul.
    t.now.value = new Date('2026-11-25T05:40:00Z');
    const r = await make(bot.id, {
      schedule: { type: 'daily', time: '08:45' },
      condition: {
        checks: [{ kind: 'email', filter: 'from~=funda' }],
        recheckMinutes: 5,
        recheckUntil: '08:55',
        otherwise: 'Mail gelmedi.',
      },
    });
    await tick(6); // 08:46: not met, looked at again at 08:51
    let now = await t.services.routines.get(r.id);
    expect(now.nextRunAt).toBe('2026-11-25T05:51:00.000Z');
    expect((await runs(r.id))[0]!.reason).toContain('08:51');
    await tick(6); // 08:52: 08:57 is past 08:55, so this is the last look
    now = await t.services.routines.get(r.id);
    expect(now.nextRunAt).toBe('2026-11-26T05:45:00.000Z');
    expect((await t.messages((await main(bot.id)).id)).at(-1)!.text).toBe('Mail gelmedi.');
  });

  it('is left aside by a run started by hand, and refuses a source nothing collects', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, { condition: { checks: [{ kind: 'files', pattern: '*.pdf' }] } });
    const asked = t.engine.requests.length;
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect(t.engine.requests.length).toBe(asked + 1);

    const noMail = await t.api('POST', '/api/routines', {
      botId: bot.id,
      name: 'Posta',
      prompt: 'x',
      schedule: { type: 'daily', time: '09:00' },
      condition: { checks: [{ kind: 'email', filter: '' }] },
    });
    expect(noMail.status).toBe(400);
    const noGroup = await t.api('POST', '/api/routines', {
      botId: bot.id,
      name: 'Grup',
      prompt: 'x',
      schedule: { type: 'daily', time: '09:00' },
      condition: { checks: [{ kind: 'files', folder: 'group', pattern: '*' }] },
    });
    expect(noGroup.status).toBe(400);
  });

  it('is set up by the bot, read back with what it says now, and run at once to try', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const ask = async (tool: string, input: Record<string, unknown>) => {
      await t.send(thread.id, `[araç:${tool} ${JSON.stringify(input)}]`);
      await t.services.turns.idle();
      return (await t.messages(thread.id)).at(-1)!.text;
    };
    expect(
      await ask('routine_create', {
        name: 'Depo',
        prompt: 'Sipariş öner',
        schedule: { type: 'daily', time: '09:00' },
        condition: {
          checks: [{ kind: 'files', pattern: 'stok/*.xlsx' }],
          recheck_minutes: 10,
          recheck_until: '10:00',
        },
      }),
    ).toContain('rutini kuruldu');
    const r = (await t.services.routines.list(bot.id))[0]!;
    expect(r.condition).toMatchObject({
      checks: [{ kind: 'files', folder: 'bot', pattern: 'stok/*.xlsx', min: 1 }],
      recheckMinutes: 10,
      recheckUntil: '10:00',
    });
    const read = await ask('routine_read', { routine: 'Depo' });
    expect(read).toContain('"pattern":"stok/*.xlsx"');
    expect(read).toContain('Koşul şu an (yapay zekâsız bakıldı): tutmuyor');

    const half = await ask('routine_update', {
      routine: 'Depo',
      condition: { checks: [], recheck_minutes: 5 },
    });
    expect(half).toContain('rutini güncellendi');
    expect((await t.services.routines.get(r.id)).condition).toBeNull();

    const bad = await ask('routine_update', {
      routine: 'Depo',
      condition: { checks: [{ kind: 'files', pattern: '../x' }] },
    });
    expect(bad).toContain('Koşul kurulamadı');

    // The routine writes in this same chat, so its answer may already sit below the tool's.
    const asked = t.engine.requests.length;
    await ask('routine_run', { routine: 'Depo' });
    const texts = (await t.messages(thread.id)).map((m) => m.text).join('\n');
    expect(texts).toContain('şimdi çalışmaya başladı');
    expect(t.engine.requests.length).toBeGreaterThan(asked + 1);
    expect((await runs(r.id))[0]).toMatchObject({ status: 'done' });
  });

  it('reads file patterns and app answers as a person means them', () => {
    expect(patternRegex('bolumler/*.docx').test('bolumler/satis.docx')).toBe(true);
    expect(patternRegex('bolumler/*.docx').test('bolumler/eski/satis.docx')).toBe(false);
    expect(patternRegex('**/*.pdf').test('a/b/c.pdf')).toBe(true);
    expect(patternRegex('**/*.pdf').test('c.pdf')).toBe(true);
    expect(toolAnswerHolds('[]', '', '')).toBe(false);
    expect(toolAnswerHolds('{"total":0}', 'total!=0', '')).toBe(false);
    expect(toolAnswerHolds('{"items":[{"id":1}]}', 'items.0', '')).toBe(true);
    expect(toolAnswerHolds('Gecikmiş: 3 sipariş', '', 'gecikmiş')).toBe(true);
  });
});
