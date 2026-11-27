import type { Approval, Bot, BotAction, PermissionRule, SecondYes, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { askRuleFor } from '../src/services/approvals';
import { OWNER_ID } from '../src/users';
import { testServer, waitFor, type Person, type TestServer } from './helpers';

const TOOL = 'mcp__leafbot__routine_create';
const ROUTINE = { name: 'Morning', prompt: 'Say good morning.', schedule: { type: 'daily', time: '08:00' } };
const create = (name = 'Morning') => `[araç:routine_create ${JSON.stringify({ ...ROUTINE, name })}]`;

describe('steps that need a second person', () => {
  let t: TestServer;
  let ada: Person;
  let mel: Person;
  let bot: Bot;
  let thread: Thread;

  beforeEach(async () => {
    t = await testServer();
    // Ada looks after the server; Mel may only talk with the bot.
    ada = await t.person('ada', 'admin');
    mel = await t.person('mel');
    bot = await t.bot();
    // In a team space, where those who look after the server may change it.
    const space = (await t.api<{ id: string }>('POST', '/api/groups', { name: 'Ekip', space: true })).body;
    await t.api('POST', `/api/bots/${bot.id}/move`, { pinned: false, groupId: space.id, beforeId: null });
    await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'none', people: { mel: 'chat' } });
    thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
  });
  afterEach(async () => {
    await t.dispose();
  });

  const twoKeys = (extra: Record<string, unknown> = {}) =>
    t.api<PermissionRule>('POST', '/api/rules', {
      list: 'ask',
      pattern: TOOL,
      botId: bot.id,
      secondPerson: true,
      ...extra,
    });
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
  const card = async (id: string) => (await t.api<Approval>('GET', `/api/approvals/${id}`)).body;
  const actions = async () => (await t.api<BotAction[]>('GET', `/api/bots/${bot.id}/actions`)).body;
  const routines = async () => (await t.services.routines.list(bot.id)).length;
  /** The step is asked, and the owner gives the first yes. */
  const firstYes = async (rule: Record<string, unknown> = {}, mode: 'ask' | 'auto' = 'ask') => {
    if (mode === 'auto') await t.api('PATCH', `/api/bots/${bot.id}`, { permissionMode: 'auto' });
    expect((await twoKeys(rule)).status).toBe(200);
    await t.send(thread.id, create());
    const waiting = await waitFor(async () => (await pending())[0]);
    const said = await t.api<Approval>('POST', `/api/approvals/${waiting.id}`, { decision: 'allow' });
    expect(said.status).toBe(200);
    return { id: waiting.id, said: said.body };
  };

  describe('making the rule', () => {
    it('is refused while nobody else could give the second yes', async () => {
      // Two people look after the server only once Ada is gone.
      await t.api('PATCH', '/api/people/ada', { disabled: true });
      const res = await twoKeys();
      expect(res.status).toBe(409);
      expect(await t.api<PermissionRule[]>('GET', '/api/rules')).toMatchObject({ body: [] });
    });

    it('is kept when another person who may change the bot exists', async () => {
      const res = await twoKeys();
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ list: 'ask', secondPerson: true, secondUserId: null });
    });

    it('is refused for someone who may only talk with the bot', async () => {
      const res = await mel.api('POST', '/api/rules', {
        list: 'ask',
        pattern: TOOL,
        botId: bot.id,
        secondPerson: true,
      });
      expect([403, 404]).toContain(res.status);
    });

    it('may name a second person only among those who could give it', async () => {
      expect((await twoKeys({ secondUserId: 'mel' })).status).toBe(400);
      const named = await twoKeys({ secondUserId: 'ada' });
      expect(named.body).toMatchObject({ secondUserId: 'ada' });
    });

    it('is only for an "always ask" rule, and a name needs the option', async () => {
      const allow = await t.api('POST', '/api/rules', {
        list: 'allow',
        pattern: TOOL,
        botId: bot.id,
        secondPerson: true,
      });
      expect(allow.status).toBe(400);
      const bare = await t.api('POST', '/api/rules', {
        list: 'ask',
        pattern: TOOL,
        botId: bot.id,
        secondUserId: 'ada',
      });
      expect(bare.status).toBe(400);
    });

    it('lists those who could give it', async () => {
      const people = (await t.api<{ id: string }[]>('GET', `/api/approvers?botId=${bot.id}`)).body;
      expect(people.map((p) => p.id).sort()).toEqual(['ada', OWNER_ID]);
    });
  });

  describe('the card', () => {
    it('stays waiting after the first yes, and the step does not run', async () => {
      const { id, said } = await firstYes();
      expect(said).toMatchObject({ status: 'pending', needsSecond: true, firstApprover: OWNER_ID });
      expect(said.firstAt).toBeTruthy();
      expect((await card(id)).status).toBe('pending');
      expect(await routines()).toBe(0);
      expect(await actions()).toEqual([]);
    });

    it('is not skipped by a bot that goes ahead by itself', async () => {
      const { id } = await firstYes({}, 'auto');
      expect((await card(id)).status).toBe('pending');
      expect(await routines()).toBe(0);
    });

    it('does not take "always allow" from the first yes', async () => {
      expect((await twoKeys()).status).toBe(200);
      await t.send(thread.id, create());
      const waiting = await waitFor(async () => (await pending())[0]);
      const said = await t.api<Approval>('POST', `/api/approvals/${waiting.id}`, {
        decision: 'allow',
        remember: true,
      });
      expect(said.body.remembered).toBe(false);
      expect((await t.api<Bot>('GET', `/api/bots/${bot.id}`)).body.permissionMode).toBe('ask');
    });

    it('is not given the second yes by the same person', async () => {
      const { id } = await firstYes();
      const again = await t.api('POST', `/api/approvals/${id}`, { decision: 'allow' });
      expect(again.status).toBe(403);
      expect((await card(id)).status).toBe('pending');
      const viaList = await t.api('POST', `/api/approvals-second/${id}`, { decision: 'allow' });
      expect(viaList.status).toBe(403);
      expect(await routines()).toBe(0);
    });

    it('runs the step on a second person’s yes, and the step log names both', async () => {
      const { id } = await firstYes();
      const done = await ada.api<Approval>('POST', `/api/approvals-second/${id}`, { decision: 'allow' });
      expect(done.status).toBe(200);
      expect(done.body.status).toBe('allowed');
      await t.services.turns.idle();
      expect(await routines()).toBe(1);
      expect(await actions()).toEqual([
        expect.objectContaining({ how: 'card', toolName: TOOL, approvedBy: [OWNER_ID, 'ada'] }),
      ]);
    });

    it('is refused by a "no" from the first person', async () => {
      const { id } = await firstYes();
      await t.api('POST', `/api/approvals/${id}`, { decision: 'deny' });
      await t.services.turns.idle();
      expect((await card(id)).status).toBe('denied');
      expect(await routines()).toBe(0);
      expect(await actions()).toEqual([]);
    });

    it('is refused by a "no" from the second person', async () => {
      const { id } = await firstYes();
      const done = await ada.api<Approval>('POST', `/api/approvals-second/${id}`, { decision: 'deny' });
      expect(done.body.status).toBe('denied');
      await t.services.turns.idle();
      expect(await routines()).toBe(0);
      expect(await actions()).toEqual([]);
    });

    it('is refused by a "no" before any yes', async () => {
      expect((await twoKeys()).status).toBe(200);
      await t.send(thread.id, create());
      const waiting = await waitFor(async () => (await pending())[0]);
      await t.api('POST', `/api/approvals/${waiting.id}`, { decision: 'deny' });
      await t.services.turns.idle();
      expect((await card(waiting.id)).status).toBe('denied');
    });

    it('does not take a second yes from someone who may only talk with the bot', async () => {
      const { id } = await firstYes();
      const res = await mel.api('POST', `/api/approvals-second/${id}`, { decision: 'allow' });
      expect(res.status).toBe(404);
    });

    it('does not take a second yes before the first', async () => {
      expect((await twoKeys()).status).toBe(200);
      await t.send(thread.id, create());
      const waiting = await waitFor(async () => (await pending())[0]);
      const res = await ada.api('POST', `/api/approvals-second/${waiting.id}`, { decision: 'allow' });
      expect(res.status).toBe(404);
      expect((await card(waiting.id)).status).toBe('pending');
    });

    it('does not let the named second person give the first yes', async () => {
      expect((await twoKeys({ secondUserId: 'ada' })).status).toBe(200);
      await t.send(thread.id, create());
      const waiting = await waitFor(async () => (await pending())[0]);
      const res = await ada.api('POST', `/api/approvals/${waiting.id}`, { decision: 'allow' });
      expect(res.status).toBe(404);
      // And through the service, as a chat app answers for the person it is linked to.
      await expect(
        t.services.approvals.answer(waiting.id, { decision: 'allow', remember: false }, 'ada'),
      ).rejects.toMatchObject({ status: 403 });
    });

    it('counts an answer from a chat app as the person it is linked to', async () => {
      const { id } = await firstYes();
      await expect(
        t.services.approvals.answer(id, { decision: 'allow', remember: false }, OWNER_ID),
      ).rejects.toMatchObject({ status: 403 });
      const done = await t.services.approvals.answer(id, { decision: 'allow', remember: false }, 'ada');
      expect(done.status).toBe('allowed');
    });
  });

  describe('the second person', () => {
    it('sees what the step is, but not the conversation', async () => {
      const { id } = await firstYes();
      const list = (await ada.api<SecondYes[]>('GET', '/api/approvals-second')).body;
      expect(list).toHaveLength(1);
      expect(list[0]).toMatchObject({
        id,
        botId: bot.id,
        askedBy: OWNER_ID,
        firstApprover: OWNER_ID,
      });
      expect(list[0]!.summary).not.toBe('');
      expect(list[0]!.step).not.toBe('');
      expect(JSON.stringify(list[0])).not.toContain(thread.id);
      // Not the conversation, nor the card in the conversation's list.
      expect((await ada.api('GET', `/api/threads/${thread.id}/messages`)).status).toBe(404);
      expect((await ada.api<Approval[]>('GET', '/api/approvals?status=pending')).body).toEqual([]);
    });

    it('does not list the step for the first person, nor for someone who may only talk with the bot', async () => {
      await firstYes();
      expect((await t.api<SecondYes[]>('GET', '/api/approvals-second')).body).toEqual([]);
      expect((await mel.api<SecondYes[]>('GET', '/api/approvals-second')).body).toEqual([]);
    });

    it('is told alone, with no conversation named', async () => {
      const notices: { to?: string[]; threadId: string; kind: string }[] = [];
      t.services.ctx.bus.on('notice', (e) => notices.push(e));
      await firstYes();
      const second = notices.find((n) => n.to);
      expect(second).toMatchObject({ kind: 'needsYou', to: ['ada'], threadId: '' });
    });

    it('is the one named by the rule, not just anyone', async () => {
      const { id } = await firstYes({ secondUserId: 'ada' });
      expect((await ada.api<SecondYes[]>('GET', '/api/approvals-second')).body).toHaveLength(1);
      const other = await t.person('bo', 'admin');
      expect((await other.api<SecondYes[]>('GET', '/api/approvals-second')).body).toEqual([]);
      expect((await other.api('POST', `/api/approvals-second/${id}`, { decision: 'allow' })).status).toBe(
        404,
      );
    });
  });

  describe('when the second person is gone', () => {
    it('refuses the card, with a reason, once the named person is removed', async () => {
      const { id } = await firstYes({ secondUserId: 'ada' });
      const gone = await t.api('PATCH', '/api/people/ada', { disabled: true });
      expect(gone.status).toBe(200);
      await t.services.turns.idle();
      const refused = await card(id);
      expect(refused.status).toBe('denied');
      expect(refused.answer).toBeTruthy();
      expect(await routines()).toBe(0);
      expect(await actions()).toEqual([]);
    });

    it('refuses the card when the only other person loses the bot', async () => {
      // Bo is shared the bot to change; Ada, an admin, is turned off, leaving Bo.
      await t.person('bo');
      await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'none', people: { bo: 'edit' } });
      const { id } = await firstYes();
      await t.api('PATCH', '/api/people/ada', { disabled: true });
      expect((await card(id)).status).toBe('pending');
      await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'none', people: { bo: 'chat' } });
      await t.services.turns.idle();
      expect((await card(id)).status).toBe('denied');
    });

    it('refuses the step at once when nobody could give the second yes', async () => {
      expect((await twoKeys({ secondUserId: 'ada' })).status).toBe(200);
      await t.api('PATCH', '/api/people/ada', { disabled: true });
      await t.send(thread.id, create());
      await t.services.turns.idle();
      expect(await pending()).toEqual([]);
      expect(await routines()).toBe(0);
    });
  });
});

describe('amount limits with a second person', () => {
  const rule = (r: Partial<PermissionRule>): PermissionRule => ({
    id: `r-${Math.random()}`,
    list: 'ask',
    pattern: 'mcp__pay__fill_card',
    note: '',
    botId: null,
    field: null,
    limit: null,
    createdAt: new Date().toISOString(),
    ...r,
  });

  it('wants two people only above the line', () => {
    const rules = [rule({ field: 'amount', limit: 1000, secondPerson: true })];
    expect(askRuleFor(rules, 'mcp__pay__fill_card', { amount: 900 })).toBeNull();
    expect(askRuleFor(rules, 'mcp__pay__fill_card', { amount: 1500 })?.secondPerson).toBe(true);
    // An amount it cannot read counts as above.
    expect(askRuleFor(rules, 'mcp__pay__fill_card', { amount: 'a lot' })?.secondPerson).toBe(true);
  });

  it('is not hidden by a plainer rule that covers the same step', () => {
    const rules = [rule({}), rule({ field: 'amount', limit: 1000, secondPerson: true })];
    expect(askRuleFor(rules, 'mcp__pay__fill_card', { amount: 50 })?.secondPerson).toBeFalsy();
    expect(askRuleFor(rules, 'mcp__pay__fill_card', { amount: 5000 })?.secondPerson).toBe(true);
  });

  it('keeps the line through the API', async () => {
    const t = await testServer();
    try {
      await t.person('ada', 'admin');
      const res = await t.api<PermissionRule>('POST', '/api/rules', {
        list: 'ask',
        pattern: 'mcp__pay__fill_card',
        field: 'amount',
        limit: 1000,
        secondPerson: true,
      });
      expect(res.body).toMatchObject({ field: 'amount', limit: 1000, secondPerson: true });
    } finally {
      await t.dispose();
    }
  });
});
