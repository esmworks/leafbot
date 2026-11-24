import { describeAction, type Approval, type Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, waitFor, type TestServer } from './helpers';

/** A bot sets up everything a routine's window does: its steps, each on its own model, and its webhook. */
describe('routine tools with steps', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const ask = async (threadId: string, tool: string, input: Record<string, unknown>) => {
    await t.send(threadId, `[araç:${tool} ${JSON.stringify(input)}]`);
    await t.services.turns.idle();
    return (await t.messages(threadId)).at(-1)!.text;
  };
  const mine = async (botId: string) => (await t.services.routines.list(botId))[0]!;
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

  const briefing = {
    name: 'Brifing',
    prompt: 'Dört bölüm dosyası geldi mi bak; eksikse yalnız sessiz cevap ver.',
    schedule: { type: 'weekdays', time: '08:45' },
    model: 'haiku',
    steps: [
      { kind: 'agent', prompt: 'Brifingi derle ve karşı görüş yaz.', model: 'opus' },
      { kind: 'approval', question: 'Gönderilsin mi?', timeout_days: 2 },
      { kind: 'notify', text: 'Brifing hazır' },
    ],
  };

  it('sets up steps with their own models, reads them back whole, and keeps their ids on a change', async () => {
    const bot = await t.bot({ name: 'Paşa', permissionMode: 'auto' });
    const thread = await main(bot.id);
    expect(await ask(thread.id, 'routine_create', briefing)).toContain('"Brifing" rutini kuruldu');
    const r = await mine(bot.id);
    expect(r.model).toBe('haiku');
    expect(r.steps).toEqual([
      expect.objectContaining({ kind: 'agent', prompt: 'Brifingi derle ve karşı görüş yaz.', model: 'opus' }),
      expect.objectContaining({ kind: 'approval', question: 'Gönderilsin mi?', timeoutDays: 2 }),
      expect.objectContaining({ kind: 'notify', text: 'Brifing hazır', withBefore: true }),
    ]);
    const ids = r.steps!.map((s) => s.id);
    expect(new Set(ids).size).toBe(3);

    // The read gives every step in the shape the update takes, so nothing is cut on the way back.
    const long = 'x'.repeat(900);
    await t.services.routines.update(r.id, {
      steps: [{ ...r.steps![0]!, prompt: long } as never, r.steps![1]!, r.steps![2]!],
    });
    const read = await ask(thread.id, 'routine_read', { routine: 'Brifing' });
    expect(read).toContain(long);
    expect(read).toContain(`"id": "${ids[0]}"`);
    expect(read).toContain('"model": "opus"');
    expect(read).toContain('"model":"haiku"');

    // A step added after the approval keeps the others as they were.
    const back = [
      { id: ids[0], kind: 'agent', prompt: long, model: 'sonnet' },
      { id: ids[1], kind: 'approval', question: 'Gönderilsin mi?', timeout_days: 2 },
      { id: ids[2], kind: 'notify', text: 'Brifing hazır' },
      { kind: 'wait', on: 'time', minutes: 30 },
    ];
    expect(await ask(thread.id, 'routine_update', { routine: 'Brifing', steps: back })).toContain(
      'rutini güncellendi',
    );
    const after = await mine(bot.id);
    expect(after.steps!.slice(0, 3).map((s) => s.id)).toEqual(ids);
    expect(after.steps![0]).toMatchObject({ model: 'sonnet' });
    expect(after.steps![3]).toMatchObject({ kind: 'wait', on: 'time', minutes: 30 });
    expect(await pending()).toHaveLength(0);
  });

  it('refuses a step it cannot keep, and more steps than a routine takes', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const bad = await ask(thread.id, 'routine_create', {
      ...briefing,
      steps: [{ kind: 'agent', prompt: '' }],
    });
    expect(bad).toContain('1. adım kurulamadı');
    const many = Array.from({ length: 11 }, () => ({ kind: 'notify', text: 'x' }));
    expect(await ask(thread.id, 'routine_create', { ...briefing, steps: many })).toMatch(/<=10/);
    const twice = await ask(thread.id, 'routine_create', {
      ...briefing,
      steps: [
        { id: 'a', kind: 'notify', text: 'x' },
        { id: 'a', kind: 'notify', text: 'y' },
      ],
    });
    expect(twice).toContain('başka bir adımda da var');
    expect(await t.services.routines.list(bot.id)).toHaveLength(0);
  });

  it('refuses a misspelt model for the routine or a step, and takes a full model id', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    expect(await ask(thread.id, 'routine_create', { ...briefing, model: 'sonet' })).toContain(
      'sonet kullanılabilir bir model değil',
    );
    const step = await ask(thread.id, 'routine_create', {
      ...briefing,
      steps: [{ kind: 'agent', prompt: 'Derle', model: 'anthropic/opus' }],
    });
    expect(step).toContain('anthropic/opus kullanılabilir bir model değil');
    expect(await t.services.routines.list(bot.id)).toHaveLength(0);
    await ask(thread.id, 'routine_create', { ...briefing, model: 'claude-haiku-5-5' });
    expect((await mine(bot.id)).model).toBe('claude-haiku-5-5');
    expect(await ask(thread.id, 'routine_update', { routine: 'Brifing', model: 'opsu' })).toContain(
      'opsu kullanılabilir',
    );
    expect((await mine(bot.id)).model).toBe('claude-haiku-5-5');
  });

  it('asks the person before an approval step is taken out, even at full access', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await ask(thread.id, 'routine_create', briefing);
    const r = await mine(bot.id);
    const [agent, , notify] = r.steps!;
    const without = [
      { id: agent!.id, kind: 'agent', prompt: 'Brifingi derle ve karşı görüş yaz.', model: 'opus' },
      { id: notify!.id, kind: 'notify', text: 'Brifing hazır' },
    ];

    await t.send(
      thread.id,
      `[araç:routine_update ${JSON.stringify({ routine: 'Brifing', steps: without })}]`,
    );
    const card = await waitFor(async () => (await pending())[0]);
    expect(card.summary).toContain('onay adımı');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answer: 'Reddet' });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('rutini değişmedi');
    expect((await mine(bot.id)).steps).toHaveLength(3);

    // The step after the approval put before it is asked about too; a yes lets it through.
    const swapped = [
      { id: agent!.id, kind: 'agent', prompt: 'Brifingi derle ve karşı görüş yaz.', model: 'opus' },
      { id: notify!.id, kind: 'notify', text: 'Brifing hazır' },
      { id: r.steps![1]!.id, kind: 'approval', question: 'Gönderilsin mi?' },
    ];
    await t.send(
      thread.id,
      `[araç:routine_update ${JSON.stringify({ routine: 'Brifing', steps: swapped })}]`,
    );
    const next = await waitFor(async () => (await pending())[0]);
    await t.api('POST', `/api/approvals/${next.id}`, { decision: 'allow', answer: 'Onayla' });
    await t.services.turns.idle();
    expect((await mine(bot.id)).steps!.map((s) => s.kind)).toEqual(['agent', 'notify', 'approval']);
  });

  it('gives a routine whose step waits for its webhook an address, and keeps the filter', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const text = await ask(thread.id, 'routine_create', {
      name: 'PR',
      prompt: 'PR aç ve numarasını routine_set ile kaydet.',
      schedule: { type: 'daily', time: '09:00' },
      webhook_filter: 'action=closed',
      steps: [{ kind: 'wait', on: 'webhook', filter: 'number={{pr}}' }],
    });
    expect(text).toContain('/api/hooks/routines/');
    const r = await mine(bot.id);
    expect(r.webhookToken).toBeTruthy();
    expect(r.webhookFilter).toBe('action=closed');
    // The address cannot go while a step waits for it; once kept, an update leaves it as it was.
    expect(await ask(thread.id, 'routine_update', { routine: 'PR', webhook: false })).toContain(
      "webhook'unu bekliyor",
    );
    expect((await mine(bot.id)).webhookToken).toBe(r.webhookToken);
    await ask(thread.id, 'routine_update', { routine: 'PR', webhook: true });
    expect((await mine(bot.id)).webhookToken).toBe(r.webhookToken);
  });

  it('takes a Slack reaction by its emoji name and refuses one that is none', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const base = { name: 'Tepki', prompt: 'Mesajı özetle.', schedule: { type: 'daily', time: '09:00' } };
    expect(await ask(thread.id, 'routine_create', { ...base, slack_reaction: 'göz!' })).toContain(
      'bir emoji adı değil',
    );
    await ask(thread.id, 'routine_create', { ...base, slack_reaction: ':eyes:' });
    expect((await mine(bot.id)).slackReaction).toBe('eyes');
    await ask(thread.id, 'routine_update', { routine: 'Tepki', slack_reaction: '' });
    expect((await mine(bot.id)).slackReaction).toBe('');
  });

  it('shows every step on the card the person approves', () => {
    const detail = describeAction('mcp__leafbot__routine_create', briefing, {
      bot: 'Paşa',
      locale: 'tr',
    }).detail;
    expect(detail).toContain('Adımlar:');
    expect(detail).toContain('1. bot [opus]: Brifingi derle');
    expect(detail).toContain('2. sana sorar: Gönderilsin mi?');
    expect(detail).toContain('3. bildirir: Brifing hazır');
  });
});
