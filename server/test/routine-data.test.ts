import { createHmac } from 'node:crypto';
import type { Message, Routine, RoutineRun, Thread } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { schema } from '../src/db';
import type * as SkillLink from '../src/services/skill-link';
import { HttpError } from '../src/util';
import { testServer, type TestServer } from './helpers';

/** What the stand-in address serves, and the addresses asked for. */
const web = vi.hoisted(() => ({
  asked: [] as string[],
  answer: (_url: URL): { body: string; contentType: string } | Error => ({
    body: '{}',
    contentType: 'application/json',
  }),
}));
vi.mock('../src/services/skill-link', async (original) => ({
  ...(await original<typeof SkillLink>()),
  fetchPublic: async (url: URL) => {
    web.asked.push(url.toString());
    const a = web.answer(url);
    if (a instanceof Error) throw a;
    return { body: Buffer.from(a.body), contentType: a.contentType, url };
  },
}));

describe('fetch and extract steps of a routine', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
    web.asked = [];
    web.answer = () => ({ body: '{}', contentType: 'application/json' });
  });
  afterEach(() => t.dispose());

  const make = async (botId: string, prompt: string, steps: unknown[]) => {
    const r = await t.api<Routine>('POST', '/api/routines', {
      botId,
      name: 'Veri',
      prompt,
      steps,
      schedule: { type: 'interval', minutes: 30 },
      // Its report reaches the main conversation from a conversation of its own.
      inMain: false,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const reports = async (botId: string): Promise<Message[]> => {
    const main = (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
    return (await t.messages(main.id)).filter((m) => (m.props as { routineReport?: boolean }).routineReport);
  };
  /** Runs it once and waits for its turns and its data steps, which go on apart from them. */
  const runOnce = async (r: Routine) => {
    await t.api('POST', `/api/routines/${r.id}/run`);
    for (let i = 0; i < 6; i++) {
      await t.services.turns.idle();
      await t.services.routines.settled();
    }
    const [run] = await runs(r.id);
    return run!;
  };
  const runRow = async (id: string) =>
    (await t.services.ctx.db.select().from(schema.routineRuns).where(eq(schema.routineRuns.id, id)))[0]!;
  const streak = async (id: string) =>
    (await t.services.ctx.db.select().from(schema.routines).where(eq(schema.routines.id, id)))[0]!
      .failureStreak;

  it('reads an address with a saved value put in, takes values from it and tells them, with no AI', async () => {
    const bot = await t.bot();
    web.answer = () => ({
      body: JSON.stringify({ item: { name: 'Çay', price: 42, tags: ['a', 'b'] } }),
      contentType: 'application/json; charset=utf-8',
    });
    const save = JSON.stringify({ name: 'kod', value: 'a b/c?d' });
    const r = await make(bot.id, `ürünü bul [araç:routine_set ${save}]`, [
      { id: 'oku', kind: 'fetch', url: 'https://api.ornek.com/items/{{kod}}?tam=1' },
      { id: 'al', kind: 'extract', fields: 'ad=item.name\nfiyat=item.price\netiket=item.tags.1' },
      { id: 'bildir', kind: 'notify', text: '{{ad}}: {{fiyat}} TL ({{etiket}})', withBefore: false },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('done');
    expect(run.steps?.map((s) => [s.kind, s.status])).toEqual([
      ['prompt', 'done'],
      ['fetch', 'done'],
      ['extract', 'done'],
      ['notify', 'done'],
    ]);
    // The value goes in encoded: it cannot add a path or a query of its own.
    expect(web.asked).toEqual(['https://api.ornek.com/items/a%20b%2Fc%3Fd?tam=1']);
    // Only the routine's own instruction asked the bot.
    expect(t.engine.requests).toHaveLength(1);
    const sent = await reports(bot.id);
    expect(sent.at(-1)!.text).toBe('Çay: 42 TL (b)');
    const row = await runRow(run.id);
    expect(row.vars).toMatchObject({ kod: 'a b/c?d', ad: 'Çay', fiyat: '42', etiket: 'b' });
    // What the address served is outside text: the run's later turns read it as such.
    expect(row.trigger).toBe('web');
  });

  it('hands what it read to a bot step, a page as its text', async () => {
    const bot = await t.bot();
    web.answer = () => ({
      body: '<html><head><script>x()</script></head><body><h1>Fiyatlar</h1><p>Çay 42</p></body></html>',
      contentType: 'text/html',
    });
    const r = await make(bot.id, 'ilk iş', [
      { id: 'oku', kind: 'fetch', url: 'https://ornek.com/fiyat' },
      { id: 'yaz', kind: 'agent', prompt: 'Fiyatı özetle' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('done');
    const asked = t.engine.requests.at(-1)!.prompt;
    expect(asked).toContain('Fiyatlar Çay 42');
    expect(asked).not.toContain('<h1>');
    expect(asked).not.toContain('x()');
  });

  it('marks the bot turn and the conversation after a read in the main conversation as outside text', async () => {
    const bot = await t.bot();
    web.answer = () => ({ body: '{"n":1}', contentType: 'application/json' });
    const made = await t.api<Routine>('POST', '/api/routines', {
      botId: bot.id,
      name: 'Ana',
      prompt: 'ilk iş',
      steps: [
        { id: 'oku', kind: 'fetch', url: 'https://ornek.com/a.json' },
        { id: 'yaz', kind: 'agent', prompt: 'özetle' },
      ],
      schedule: { type: 'interval', minutes: 30 },
    });
    const run = await runOnce(made.body);
    expect(run.status).toBe('done');
    const turns = await t.services.ctx.db
      .select()
      .from(schema.turns)
      .where(eq(schema.turns.routineRunId, run.id));
    // The routine's own instruction read nothing from outside; the step after the read did.
    expect(turns.find((x) => x.prompt.includes('ilk iş'))!.outside).toBeNull();
    expect(turns.find((x) => x.prompt.includes('özetle'))!.outside).toBe('web');
    const [thread] = await t.services.ctx.db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, run.threadId!));
    expect(thread!.outsideSession).toBe('web');
  });

  it('takes values from the body a webhook it waited for brought, after the bot step’s answer', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'kapanis', kind: 'wait', on: 'webhook', filter: 'event=issues' },
      { id: 'al', kind: 'extract', fields: 'no=issue.number\nbaslik=issue.title' },
      { id: 'bildir', kind: 'notify', text: '#{{no}} {{baslik}}', withBefore: false },
    ]);
    const { webhookToken } = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
    const run = await runOnce(r);
    expect(run.status).toBe('waiting');
    const raw = JSON.stringify({ action: 'closed', issue: { number: 42, title: 'Giriş hatası' } });
    await t.app.inject({
      method: 'POST',
      url: `/api/hooks/routines/${r.id}/${webhookToken}`,
      headers: {
        host: 'localhost',
        'content-type': 'application/json',
        'x-github-event': 'issues',
        'x-github-delivery': 'teslim-1',
        'x-hub-signature-256': `sha256=${createHmac('sha256', webhookToken!).update(raw).digest('hex')}`,
      },
      payload: raw,
    });
    for (let i = 0; i < 6; i++) {
      await t.services.turns.idle();
      await t.services.routines.settled();
    }
    const [done] = await runs(r.id);
    expect(done!.status).toBe('done');
    const sent = await reports(bot.id);
    expect(sent.at(-1)!.text).toBe('#42 Giriş hatası');
  });

  it('does not read for a bot that may not reach the internet, and counts the failed run', async () => {
    const bot = await t.bot();
    await t.api('PATCH', `/api/bots/${bot.id}`, { internet: false });
    const r = await make(bot.id, 'ilk iş', [
      { id: 'oku', kind: 'fetch', url: 'https://ornek.com/fiyat' },
      { id: 'bildir', kind: 'notify', text: 'okundu' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('error');
    expect(run.reason).toContain('internet');
    expect(run.steps?.map((s) => s.status)).toEqual(['done', 'error', 'skipped']);
    expect(web.asked).toEqual([]);
    expect(await streak(r.id)).toBe(1);
  });

  it('goes on along its failure way with why, without counting it', async () => {
    const bot = await t.bot();
    web.answer = () => new HttpError(400, 'error.skillLinkStatus', { status: '503' });
    const r = await make(bot.id, 'ilk iş', [
      { id: 'oku', kind: 'fetch', url: 'https://ornek.com/fiyat', onError: 'hata' },
      { id: 'bildir', kind: 'notify', text: 'okundu', next: 'end' },
      { id: 'hata', kind: 'notify', text: 'Site cevap vermedi' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('done');
    expect(run.steps?.map((s) => s.status)).toEqual(['done', 'error', 'skipped', 'done']);
    expect(run.steps?.[1]!.reason).toContain('HTTP 503');
    const sent = await reports(bot.id);
    expect(sent.at(-1)!.text).toContain('Site cevap vermedi');
    expect(sent.at(-1)!.text).toContain('HTTP 503');
    expect(await streak(r.id)).toBe(0);
  });

  it('fails an extract step when a value is not there, or what reached it is not JSON', async () => {
    const bot = await t.bot();
    web.answer = () => ({ body: JSON.stringify({ item: {} }), contentType: 'application/json' });
    const r = await make(bot.id, 'ilk iş', [
      { id: 'oku', kind: 'fetch', url: 'https://ornek.com/fiyat' },
      { id: 'al', kind: 'extract', fields: 'fiyat=item.price' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('error');
    expect(run.reason).toContain('fiyat');
    expect(run.reason).toContain('item.price');

    const plain = await make(bot.id, 'ilk iş', [{ id: 'al', kind: 'extract', fields: 'fiyat=item.price' }]);
    const second = await runOnce(plain);
    expect(second.status).toBe('error');
    expect(second.reason).toContain('JSON');
  });

  it('can be tried again from the step that failed', async () => {
    const bot = await t.bot();
    web.answer = () => new Error('down');
    const r = await make(bot.id, 'ilk iş', [
      { id: 'oku', kind: 'fetch', url: 'https://ornek.com/a.json' },
      { id: 'al', kind: 'extract', fields: 'n=n' },
    ]);
    const run = await runOnce(r);
    expect(run.status).toBe('error');
    web.answer = () => ({ body: '{"n":7}', contentType: 'application/json' });
    expect((await t.api('POST', `/api/routines/${r.id}/runs/${run.id}/retry`)).status).toBe(200);
    for (let i = 0; i < 4; i++) {
      await t.services.turns.idle();
      await t.services.routines.settled();
    }
    const [again] = await runs(r.id);
    expect(again!.status).toBe('done');
    expect((await runRow(run.id)).vars).toMatchObject({ n: '7' });
    // The routine's own instruction was not asked again.
    expect(t.engine.requests).toHaveLength(1);
  });

  it('turns away an address that is not https or puts a value in its server, and bad fields', async () => {
    const bot = await t.bot();
    const post = (steps: unknown[]) =>
      t.api('POST', '/api/routines', {
        botId: bot.id,
        name: `Kötü ${Math.random()}`,
        prompt: 'x',
        steps,
        schedule: { type: 'interval', minutes: 30 },
      });
    expect((await post([{ id: 'a', kind: 'fetch', url: 'http://ornek.com' }])).status).toBe(400);
    expect((await post([{ id: 'a', kind: 'fetch', url: 'https://{{site}}/x' }])).status).toBe(400);
    expect((await post([{ id: 'a', kind: 'fetch', url: 'https://ornek.{{tld}}/x' }])).status).toBe(400);
    expect((await post([{ id: 'a', kind: 'extract', fields: '' }])).status).toBe(400);
    expect((await post([{ id: 'a', kind: 'extract', fields: 'a=b\na=c' }])).status).toBe(400);
    expect((await post([{ id: 'a', kind: 'extract', fields: 'a b=c' }])).status).toBe(400);
    expect((await post([{ id: 'a', kind: 'fetch', url: 'https://ornek.com/{{x}}' }])).status).toBe(200);
  });

  it('tells the bot to save a value a fetch step needs, unless an extract step before it takes it', async () => {
    const bot = await t.bot();
    const r = await make(bot.id, 'ilk iş', [
      { id: 'oku', kind: 'fetch', url: 'https://ornek.com/{{kod}}' },
      { id: 'al', kind: 'extract', fields: 'no=id' },
      { id: 'ikinci', kind: 'fetch', url: 'https://ornek.com/{{no}}' },
    ]);
    web.answer = () => ({ body: '{"id":"9"}', contentType: 'application/json' });
    await runOnce(r);
    const first = t.engine.requests[0]!.prompt;
    // Only `kod`: the extract step takes `no` before the step that needs it.
    expect(first).toContain('şu değerleri bekliyor: kod.');
  });
});
