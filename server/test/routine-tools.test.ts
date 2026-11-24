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

  it('sets a step to run only when the step before found something, and reads it back the same', async () => {
    const bot = await t.bot({ name: 'Paşa', permissionMode: 'auto' });
    const thread = await main(bot.id);
    const steps = [
      { kind: 'agent', prompt: 'Siparişleri say.' },
      { kind: 'notify', text: 'Gecikmiş sipariş var', when: { filter: 'late!=0', otherwise: 'end' } },
    ];
    expect(await ask(thread.id, 'routine_create', { ...briefing, steps })).toContain('rutini kuruldu');
    const r = await mine(bot.id);
    expect(r.steps![0]!.when).toBeUndefined();
    expect(r.steps![1]!.when).toEqual({ contains: '', filter: 'late!=0', absent: false, otherwise: 'end' });
    const read = await ask(thread.id, 'routine_read', { routine: 'Brifing' });
    expect(read).toContain('"filter": "late!=0"');
    expect(read).toContain('"otherwise": "end"');
    // A step sent back without its condition runs every time again.
    const ids = r.steps!.map((s) => s.id);
    await ask(thread.id, 'routine_update', {
      routine: 'Brifing',
      steps: [
        { id: ids[0], kind: 'agent', prompt: 'Siparişleri say.' },
        { id: ids[1], kind: 'notify', text: 'Gecikmiş sipariş var' },
      ],
    });
    expect((await mine(bot.id)).steps![1]!.when).toBeFalsy();
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
    // A longer id is left to the engine, and a step it already runs on never blocks a change.
    await t.services.routines.update((await mine(bot.id)).id, {
      steps: [{ id: 'a', kind: 'agent', prompt: 'Derle', model: 'eskimodel' } as never],
    });
    expect(
      await ask(thread.id, 'routine_update', {
        routine: 'Brifing',
        model: 'sonnet[1m]',
        steps: [
          { id: 'a', kind: 'agent', prompt: 'Derle', model: 'eskimodel' },
          { kind: 'agent', prompt: 'Gözden geçir', model: 'us.anthropic.claude-sonnet-5-5' },
        ],
      }),
    ).toContain('rutini güncellendi');
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

    // A condition that could pass the approval over lets what follows run unasked: asked about too.
    const now = (await mine(bot.id)).steps!;
    const gated = now.map((s) =>
      s.kind === 'approval'
        ? { id: s.id, kind: 'approval', question: 'Gönderilsin mi?', when: { contains: 'acil' } }
        : s.kind === 'agent'
          ? { id: s.id, kind: 'agent', prompt: s.prompt, model: s.model }
          : { id: s.id, kind: 'notify', text: 'Brifing hazır' },
    );
    await t.send(thread.id, `[araç:routine_update ${JSON.stringify({ routine: 'Brifing', steps: gated })}]`);
    const third = await waitFor(async () => (await pending())[0]);
    expect(third.summary).toContain('koşul');
    await t.api('POST', `/api/approvals/${third.id}`, { decision: 'allow', answer: 'Reddet' });
    await t.services.turns.idle();
    expect((await mine(bot.id)).steps!.find((s) => s.kind === 'approval')!.when).toBeFalsy();
    // One that ends the run when it does not hold lets nothing through, so it needs no card.
    const ending = gated.map((s) =>
      s.kind === 'approval' ? { ...s, when: { contains: 'acil', otherwise: 'end' } } : s,
    );
    expect(await ask(thread.id, 'routine_update', { routine: 'Brifing', steps: ending })).toContain(
      'rutini güncellendi',
    );
    expect(await pending()).toHaveLength(0);
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

  it('lets a manager set a routine up for a bot it looks after, never for another manager', async () => {
    const m = await t.bot({ name: 'Kahya', isManager: true, permissionMode: 'auto' });
    const other = await t.bot({ name: 'Şef', isManager: true });
    const pasa = await t.bot({ name: 'Paşa' });
    const plain = await t.bot({ name: 'Ali', permissionMode: 'auto' });
    const thread = await main(m.id);
    const made = await ask(thread.id, 'routine_create', { ...briefing, bot: 'Paşa' });
    expect(made).toContain('"Brifing" rutini kuruldu');
    expect(await mine(pasa.id)).toMatchObject({ name: 'Brifing', botId: pasa.id, model: 'haiku' });
    expect(await t.services.routines.list(m.id)).toHaveLength(0);
    // The same name again for that bot is its own routine already.
    expect(await ask(thread.id, 'routine_create', { ...briefing, bot: 'Paşa' })).toContain('Brifing');
    expect(await t.services.routines.list(pasa.id)).toHaveLength(1);
    await ask(thread.id, 'routine_create', { ...briefing, bot: 'Şef' });
    expect(await t.services.routines.list(other.id)).toHaveLength(0);
    // A bot that is not a manager sets routines up for itself only.
    const own = await main(plain.id);
    await ask(own.id, 'routine_create', { ...briefing, bot: 'Paşa' });
    expect(await t.services.routines.list(pasa.id)).toHaveLength(1);
    expect(await t.services.routines.list(plain.id)).toHaveLength(0);
    const card = describeAction(
      'mcp__leafbot__routine_create',
      { ...briefing, bot: 'Paşa' },
      { bot: 'Kahya', locale: 'tr' },
    );
    expect(card.want).toBe('Kahya "Paşa" botuna "Brifing" adında bir rutin kurmak istiyor.');
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
    const gated = describeAction(
      'mcp__leafbot__routine_create',
      {
        ...briefing,
        steps: [
          { kind: 'agent', prompt: 'Gönder', when: { contains: '[1]', otherwise: 'end' } },
          { kind: 'notify', text: 'Boş', when: { absent: true } },
        ],
      },
      { bot: 'Paşa', locale: 'tr' },
    ).detail;
    expect(gated).toContain('(yalnız varsa: "[1]"; yoksa çalışma biter)');
    expect(gated).toContain('(yalnız önceki adımdan bir şey gelmezse)');
    const branched = describeAction(
      'mcp__leafbot__routine_create',
      {
        ...briefing,
        steps: [
          {
            id: 'bak',
            kind: 'agent',
            prompt: 'Fiyatlara bak',
            when: { contains: 'değişti', otherwise: 'goto', goto: 'sessiz' },
            next: 'end',
            on_error: 'hata',
          },
          { id: 'sessiz', kind: 'notify', text: 'Değişiklik yok', next: 'end' },
          { id: 'hata', kind: 'notify', text: 'Bakılamadı' },
        ],
      },
      { bot: 'Paşa', locale: 'tr' },
    ).detail;
    expect(branched).toContain('yoksa 2. adıma geçer');
    expect(branched).toContain('→ sonra çalışma biter → olmazsa 3. adım');
  });

  it('sets up fetch and extract steps, reads them back whole, and shows them on the card', async () => {
    const bot = await t.bot({ name: 'Paşa', permissionMode: 'auto' });
    const thread = await main(bot.id);
    const steps = [
      { id: 'oku', kind: 'fetch', url: 'https://api.ornek.com/fiyat/{{kod}}', on_error: 'hata' },
      { id: 'al', kind: 'extract', fields: 'fiyat=item.price\nad=item.name', on_error: 'hata' },
      { id: 'bildir', kind: 'notify', text: '{{ad}}: {{fiyat}}', with_before: false, next: 'end' },
      { id: 'hata', kind: 'notify', text: 'Fiyat okunamadı' },
    ];
    expect(await ask(thread.id, 'routine_create', { ...briefing, steps })).toContain('rutini kuruldu');
    const r = await mine(bot.id);
    expect(r.steps![0]).toEqual(
      expect.objectContaining({ kind: 'fetch', url: 'https://api.ornek.com/fiyat/{{kod}}', onError: 'hata' }),
    );
    expect(r.steps![1]).toEqual(
      expect.objectContaining({ kind: 'extract', fields: 'fiyat=item.price\nad=item.name', onError: 'hata' }),
    );
    const read = await ask(thread.id, 'routine_read', { routine: 'Brifing' });
    expect(read).toContain('"url": "https://api.ornek.com/fiyat/{{kod}}"');
    expect(read).toContain('"on_error": "hata"');
    // An address with a value in its server name is turned away.
    const bad = await ask(thread.id, 'routine_update', {
      routine: 'Brifing',
      steps: [{ id: 'oku', kind: 'fetch', url: 'https://{{site}}/x' }],
    });
    expect(bad).toContain('1. adım kurulamadı');
    const detail = describeAction(
      'mcp__leafbot__routine_create',
      { ...briefing, steps },
      { bot: 'Paşa', locale: 'tr' },
    ).detail;
    expect(detail).toContain('1. adresi okur: https://api.ornek.com/fiyat/{{kod}} → olmazsa 4. adım');
    expect(detail).toContain('2. değerleri alır: fiyat=item.price, ad=item.name');
  });

  it('sets up branches, reads them back, and asks before a new way passes an approval step', async () => {
    const bot = await t.bot({ name: 'Paşa', permissionMode: 'auto' });
    const thread = await main(bot.id);
    const steps = [
      {
        id: 'bak',
        kind: 'agent',
        prompt: 'Fiyatlara bak.',
        on_error: 'hata',
        when: { contains: 'değişti', otherwise: 'goto', goto: 'hata' },
      },
      { id: 'sor', kind: 'approval', question: 'Gönderilsin mi?' },
      { id: 'gonder', kind: 'agent', prompt: 'Gönder.', next: 'end' },
      { id: 'hata', kind: 'notify', text: 'Bakılamadı' },
    ];
    expect(await ask(thread.id, 'routine_create', { ...briefing, steps })).toContain('rutini kuruldu');
    const r = await mine(bot.id);
    expect(r.steps![0]).toMatchObject({ onError: 'hata', when: { otherwise: 'goto', goto: 'hata' } });
    expect(r.steps![2]).toMatchObject({ next: 'end' });
    const read = await ask(thread.id, 'routine_read', { routine: 'Brifing' });
    expect(read).toContain('"on_error": "hata"');
    expect(read).toContain('"goto": "hata"');
    expect(read).toContain('"next": "end"');

    // A way back is turned away, with the reason, and nothing changes.
    const back = steps.map((s) => (s.id === 'hata' ? { ...s, next: 'bak' } : s));
    expect(await ask(thread.id, 'routine_update', { routine: 'Brifing', steps: back })).toContain(
      'sonraki bir adıma',
    );
    expect((await mine(bot.id)).steps![3]).not.toHaveProperty('next', 'bak');

    // A new way from before the approval to after it lets the sending run unasked: asked on a card.
    const around = steps.map((s) => (s.id === 'bak' ? { ...s, next: 'gonder' } : s));
    await t.send(thread.id, `[araç:routine_update ${JSON.stringify({ routine: 'Brifing', steps: around })}]`);
    const card = await waitFor(async () => (await pending())[0]);
    expect(card.summary).toContain('Brifing');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answer: 'Reddet' });
    await t.services.turns.idle();
    expect((await mine(bot.id)).steps![0]!.next).toBeFalsy();
    // A way that only went past it before, as the failure one did, needs no card when it stays.
    expect(await ask(thread.id, 'routine_update', { routine: 'Brifing', steps })).toContain(
      'rutini güncellendi',
    );
    expect(await pending()).toHaveLength(0);
  });
});
