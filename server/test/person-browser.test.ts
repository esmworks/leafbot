import type { Approval, ChromeAnswer, ChromeAsk, Message, Routine, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChromeBridge } from '../src/chrome/bridge';
import { OWNER_ID } from '../src/users';
import { testServer, waitFor, type TestServer } from './helpers';

const PAGE: ChromeAnswer = {
  ok: true,
  kind: 'read',
  tab: { id: 7, url: 'https://ornek.com/fiyatlar', title: 'Fiyatlar', active: true },
  text: 'Kurumsal paket ayda 40 dolar.',
  cut: false,
};

describe('Chrome köprüsü', () => {
  it('soruyu yalnız o kişinin en son paylaşan paneline gönderir', async () => {
    const chromes = new ChromeBridge(50);
    const sent: string[] = [];
    chromes.attach(async (socket) => {
      sent.push(socket);
      return PAGE;
    });
    chromes.offer('eski', 'ali', true);
    chromes.offer('yeni', 'ali', true);
    chromes.offer('baskasi', 'ayse', true);
    // Only a plain yes shares.
    chromes.offer('sahte', 'veli', 'true');
    expect(chromes.has('ali')).toBe(true);
    expect(chromes.has('veli')).toBe(false);
    expect(await chromes.ask('ali', { kind: 'read' })).toEqual(PAGE);
    expect(sent).toEqual(['yeni']);

    // A panel that stops sharing, or goes away, is no longer asked.
    chromes.offer('yeni', 'ali', false);
    chromes.drop('eski');
    expect(chromes.has('ali')).toBe(false);
    await expect(chromes.ask('ali', { kind: 'read' })).rejects.toThrow('chrome not reachable');
  });

  it('cevap gelmezse ya da başka türde gelirse kullanılmaz', async () => {
    const chromes = new ChromeBridge(50);
    chromes.offer('s', 'ali', true);
    chromes.attach(() => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10)));
    await expect(chromes.ask('ali', { kind: 'tabs' })).rejects.toThrow('chrome not reachable');
    chromes.attach(async () => PAGE);
    expect(await chromes.ask('ali', { kind: 'tabs' })).toEqual({ ok: false, reason: 'failed' });
    chromes.attach(async () => ({ ok: true, kind: 'read', tab: { id: -1 }, text: 'x', cut: false }));
    expect(await chromes.ask('ali', { kind: 'read' })).toEqual({ ok: false, reason: 'failed' });
  });

  it('panelden başlayan turları sınırlı sayıda hatırlar', () => {
    const chromes = new ChromeBridge(50);
    for (let i = 0; i < 201; i++) chromes.noteTurn(`tur-${i}`);
    expect(chromes.fromChrome('tur-0')).toBe(false);
    expect(chromes.fromChrome('tur-1')).toBe(true);
    expect(chromes.fromChrome('tur-200')).toBe(true);
  });
});

describe('kişinin Chrome’u: botlar ve onay', () => {
  let t: TestServer;
  let asked: ChromeAsk[];
  beforeEach(async () => {
    t = await testServer();
    asked = [];
    t.services.ctx.chromes!.attach(async (_socket, ask) => {
      asked.push(ask);
      return PAGE;
    });
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const toolNames = () => t.engine.requests.at(-1)!.tools.map((x) => x.name);
  const chromeTools = () => toolNames().filter((n) => n.startsWith('person_browser_'));
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
  const fromPanel = async (threadId: string, text: string) => {
    const r = await t.api<Message>('POST', `/api/threads/${threadId}/messages`, {
      clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
      text,
      chrome: true,
    });
    if (r.status >= 300) throw new Error(JSON.stringify(r.body));
    return r.body;
  };

  it('yalnız Chrome’u paylaşan panelden yazılan mesajın işinde sunulur', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);

    // From the panel, but no panel shares Chrome now.
    await fromPanel(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(chromeTools()).toEqual([]);

    // Chrome is shared, but the message came from elsewhere.
    t.services.ctx.chromes!.offer('panel', OWNER_ID, true);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(chromeTools()).toEqual([]);

    await fromPanel(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(chromeTools()).toEqual(['person_browser_tabs', 'person_browser_read']);

    // A bot that may only read is not offered it.
    await t.api('PATCH', `/api/bots/${bot.id}`, { permissionMode: 'readonly' });
    await fromPanel(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(chromeTools()).toEqual([]);
  });

  it('tam izinli botta bile ilk okumada bir kez sorar, “hep izin ver” sunmaz; cevap dış metindir', async () => {
    t.services.ctx.chromes!.offer('panel', OWNER_ID, true);
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await fromPanel(thread.id, '[araç:person_browser_read] [araç:person_browser_read {"tab":7}]');
    const card = await waitFor(async () => (await pending())[0]);
    expect(card.toolName).toBe('mcp__leafbot__person_browser_read');
    const approval = (await t.messages(thread.id)).find((m: Message) => m.role === 'approval')!;
    expect(approval.text).toContain('Chrome’da açık bir sayfayı okumak istiyor');
    expect(approval.props.noAlways).toBe(true);
    expect(asked).toEqual([]);

    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    expect(asked).toEqual([
      { kind: 'read', bot: bot.name },
      { kind: 'read', tabId: 7, bot: bot.name },
    ]);
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('Kurumsal paket ayda 40 dolar.');
    expect(reply).toContain('outside-data');
  });

  it('panel yanıt vermezse “ulaşılamadı” der', async () => {
    t.services.ctx.chromes!.offer('panel', OWNER_ID, true);
    t.services.ctx.chromes!.attach(async () => {
      throw new Error('gone');
    });
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await fromPanel(thread.id, '[araç:person_browser_tabs]');
    const card = await waitFor(async () => (await pending())[0]);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Chrome’a ulaşılamadı');
  });

  it('rutinde ve başka birinin işinde Chrome’a gidilmez', async () => {
    t.services.ctx.chromes!.offer('panel', OWNER_ID, true);
    const bot = await t.bot({ permissionMode: 'auto' });
    const routine = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Sekmeler',
        prompt: '[araç:person_browser_tabs]',
        schedule: { type: 'weekly', days: [0], time: '18:00' },
      })
    ).body;
    await t.api('POST', `/api/routines/${routine.id}/run`);
    await t.services.turns.idle();
    expect(chromeTools()).toEqual([]);

    // Someone else, writing from a panel of their own that does not share, does not reach the
    // owner's Chrome.
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'use', people: {} });
    const member = await t.person('ayse');
    const theirs = (await member.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await member.api('POST', `/api/threads/${theirs.id}/messages`, {
      clientId: 'c-uyeninmesaji',
      text: '[araç:person_browser_tabs]',
      chrome: true,
    });
    await t.services.turns.idle();
    expect(chromeTools()).toEqual([]);
    expect(asked).toEqual([]);
  });
});
