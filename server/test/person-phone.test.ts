import type { Approval, Message, PhoneAnswer, PhoneAsk, Routine, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PhoneBridge } from '../src/phone/bridge';
import { OWNER_ID } from '../src/users';
import { testServer, waitFor, type TestServer } from './helpers';

const EVENTS: PhoneAnswer = {
  ok: true,
  kind: 'calendar',
  events: [
    {
      title: 'Diş hekimi',
      start: '2026-11-17T09:00:00.000Z',
      end: '2026-11-17T09:30:00.000Z',
      allDay: false,
      location: 'Kadıköy',
      calendar: 'Kişisel',
    },
  ],
};

describe('telefon köprüsü', () => {
  it('soruyu yalnız o kişinin, o türü açan en son telefonuna gönderir', async () => {
    const phones = new PhoneBridge(50);
    const sent: { socket: string; ask: PhoneAsk }[] = [];
    phones.attach(async (socket, ask) => {
      sent.push({ socket, ask });
      return EVENTS;
    });
    phones.offer('eski', 'ali', ['calendar']);
    phones.offer('yeni', 'ali', ['calendar', 'location']);
    phones.offer('baskasi', 'ayse', ['calendar', 'contacts']);
    phones.offer('sahte', 'ali', ['camera', 7]);
    expect([...phones.kinds('ali')].sort()).toEqual(['calendar', 'location']);
    const ask: PhoneAsk = {
      kind: 'calendar',
      from: '2026-11-17T00:00:00.000Z',
      to: '2026-11-18T00:00:00.000Z',
    };
    expect(await phones.ask('ali', ask)).toEqual(EVENTS);
    expect(sent.map((s) => s.socket)).toEqual(['yeni']);
    await expect(phones.ask('ali', { kind: 'contacts', query: 'a' })).rejects.toThrow('phone not reachable');

    // A phone that takes the offer back, or goes away, is no longer asked.
    phones.offer('yeni', 'ali', []);
    phones.drop('eski');
    expect(phones.kinds('ali').size).toBe(0);
    await expect(phones.ask('ali', ask)).rejects.toThrow('phone not reachable');
  });

  it('cevap gelmezse ya da başka türde gelirse kullanılmaz', async () => {
    const phones = new PhoneBridge(50);
    phones.offer('s', 'ali', ['location', 'calendar']);
    phones.attach(() => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10)));
    await expect(phones.ask('ali', { kind: 'location' })).rejects.toThrow('phone not reachable');
    phones.attach(async () => EVENTS);
    expect(await phones.ask('ali', { kind: 'location' })).toEqual({ ok: false, reason: 'failed' });
    phones.attach(async () => ({ ok: true, kind: 'location', location: { latitude: 400 } }));
    expect(await phones.ask('ali', { kind: 'location' })).toEqual({ ok: false, reason: 'failed' });
  });
});

describe('kişinin telefonu: botlar ve onay', () => {
  let t: TestServer;
  let asked: PhoneAsk[];
  beforeEach(async () => {
    t = await testServer();
    asked = [];
    t.services.ctx.phones!.attach(async (_socket, ask) => {
      asked.push(ask);
      return EVENTS;
    });
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const toolNames = () => t.engine.requests.at(-1)!.tools.map((x) => x.name);
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;

  it('yalnız telefonda açılan türler, kişinin kendi işinde sunulur', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames().filter((n) => n.startsWith('person_phone_'))).toEqual([]);

    t.services.ctx.phones!.offer('telefon', OWNER_ID, ['calendar']);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames().filter((n) => n.startsWith('person_phone_'))).toEqual(['person_phone_calendar']);

    // A bot that may only read is not offered it.
    await t.api('PATCH', `/api/bots/${bot.id}`, { permissionMode: 'readonly' });
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames()).not.toContain('person_phone_calendar');
  });

  it('tam izinli botta bile ilk okumada bir kez sorar, “hep izin ver” sunmaz; cevap dış metindir', async () => {
    t.services.ctx.phones!.offer('telefon', OWNER_ID, ['calendar']);
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(
      thread.id,
      '[araç:person_phone_calendar {"days":2}] [araç:person_phone_calendar {"from":"2026-11-20T00:00:00Z","days":1}]',
    );
    const card = await waitFor(async () => (await pending())[0]);
    expect(card.toolName).toBe('mcp__leafbot__person_phone_calendar');
    const approval = (await t.messages(thread.id)).find((m: Message) => m.role === 'approval')!;
    expect(approval.text).toContain('telefonundaki takvimi okumak istiyor');
    expect(approval.props.noAlways).toBe(true);
    expect(asked).toEqual([]);

    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    expect(asked).toEqual([
      { kind: 'calendar', from: '2026-11-16T05:00:00.000Z', to: '2026-11-18T05:00:00.000Z' },
      { kind: 'calendar', from: '2026-11-20T00:00:00.000Z', to: '2026-11-21T00:00:00.000Z' },
    ]);
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('Diş hekimi');
    expect(reply).toContain('outside-data');
  });

  it('telefon kapalıysa hemen “ulaşılamadı” der', async () => {
    t.services.ctx.phones!.offer('telefon', OWNER_ID, ['location']);
    t.services.ctx.phones!.attach(async () => {
      throw new Error('gone');
    });
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:person_phone_location]');
    const card = await waitFor(async () => (await pending())[0]);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Telefona ulaşılamadı');
  });

  it('rutinde ve başka birinin işinde telefona gidilmez', async () => {
    t.services.ctx.phones!.offer('telefon', OWNER_ID, ['calendar', 'contacts', 'location']);
    const bot = await t.bot({ permissionMode: 'auto' });
    const routine = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Takvim',
        prompt: '[araç:person_phone_calendar]',
        schedule: { type: 'weekly', days: [0], time: '18:00' },
      })
    ).body;
    await t.api('POST', `/api/routines/${routine.id}/run`);
    await t.services.turns.idle();
    expect(toolNames().filter((n) => n.startsWith('person_phone_'))).toEqual([]);

    // Someone else using the same bot does not reach the owner's phone.
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'use', people: {} });
    const member = await t.person('ayse');
    const theirs = (await member.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await member.api('POST', `/api/threads/${theirs.id}/messages`, { text: '[araç:person_phone_location]' });
    await t.services.turns.idle();
    expect(toolNames().filter((n) => n.startsWith('person_phone_'))).toEqual([]);
    expect(asked).toEqual([]);
  });
});
