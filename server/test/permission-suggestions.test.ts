import type { Approval, PermissionRule, PermissionSuggestions, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  permissionSuggestions,
  SUGGEST_MODE_MIN,
  SUGGEST_RULE_MIN,
  type AnsweredCard,
} from '../src/services/approvals';
import { testServer, waitFor, type TestServer } from './helpers';

const card = (status: AnsweredCard['status'], toolName = 'mcp__mail__send', input = {}): AnsweredCard => ({
  toolName,
  input,
  summary: `Use ${toolName}`,
  status,
});
const times = (n: number, c: AnsweredCard) => Array.from({ length: n }, () => c);
const rule = (r: Pick<PermissionRule, 'list' | 'pattern'>): PermissionRule => ({
  id: 'r1',
  note: '',
  botId: null,
  field: null,
  limit: null,
  createdAt: new Date().toISOString(),
  ...r,
});
const suggest = (cards: AnsweredCard[], o: Partial<Parameters<typeof permissionSuggestions>[0]> = {}) =>
  permissionSuggestions({ mode: 'ask', cards, rules: [], dismissed: new Set(), ...o });

describe('ways to ask less', () => {
  it('suggests a step the person always allowed, often enough', () => {
    expect(suggest(times(SUGGEST_RULE_MIN - 1, card('allowed'))).rules).toEqual([]);
    expect(suggest(times(SUGGEST_RULE_MIN, card('allowed'))).rules).toEqual([
      { pattern: 'mcp__mail__send', summary: 'Use mcp__mail__send', allowed: SUGGEST_RULE_MIN },
    ]);
  });

  it('suggests nothing the person refused even once', () => {
    expect(suggest([...times(10, card('allowed')), card('denied')]).rules).toEqual([]);
  });

  it('keeps a command to its program, as a card would', () => {
    const cards = times(SUGGEST_RULE_MIN, card('allowed', 'Bash', { command: 'git status --short' }));
    expect(suggest(cards).rules[0]?.pattern).toBe('Bash(git status:*)');
  });

  it('leaves out what a rule already covers, what is turned down, and a bot that does not ask', () => {
    const cards = times(SUGGEST_RULE_MIN, card('allowed'));
    expect(suggest(cards, { rules: [rule({ list: 'allow', pattern: 'mcp__mail__*' })] }).rules).toEqual([]);
    expect(suggest(cards, { rules: [rule({ list: 'ask', pattern: 'mcp__mail__send' })] }).rules).toEqual([]);
    expect(suggest(cards, { dismissed: new Set(['mcp__mail__send']) }).rules).toEqual([]);
    expect(suggest(cards, { mode: 'auto' }).rules).toEqual([]);
    expect(suggest(cards, { mode: 'readonly' }).rules).toEqual([]);
    // The retired review level goes ahead by itself and asks for nothing a rule would spare.
    expect(suggest(cards, { mode: 'review' }).rules).toEqual([]);
  });

  it('offers no plain rule for a tool the person gave an amount limit', () => {
    const cards = times(SUGGEST_RULE_MIN, card('allowed', 'mcp__pay__refund', { amount: 500 }));
    const limited = { ...rule({ list: 'allow', pattern: 'mcp__pay__refund' }), field: 'amount', limit: 100 };
    expect(suggest(cards, { rules: [limited] }).rules).toEqual([]);
  });

  it('suggests full access to a bot in "ask" whose cards the person nearly always allowed', () => {
    const many = (denied: number) => [
      ...times(SUGGEST_MODE_MIN - denied, card('allowed', 'mcp__docs__write')),
      ...times(denied, card('denied', 'mcp__docs__write')),
    ];
    expect(suggest(many(0)).mode).toEqual({ to: 'auto', allowed: SUGGEST_MODE_MIN, denied: 0 });
    expect(suggest(many(1)).mode).toEqual({ to: 'auto', allowed: SUGGEST_MODE_MIN - 1, denied: 1 });
    expect(suggest(many(2)).mode).toBeNull();
    expect(suggest(times(SUGGEST_MODE_MIN - 1, card('allowed'))).mode).toBeNull();
    expect(suggest(many(0), { mode: 'review' }).mode).toBeNull();
    expect(suggest(many(0), { dismissed: new Set(['mode']) }).mode).toBeNull();
  });

  it('counts toward full access only cards it would spare', () => {
    const sending = times(SUGGEST_MODE_MIN, card('allowed', 'mcp__mail__send', { sends: true }));
    expect(suggest(sending).mode).toEqual({ to: 'auto', allowed: SUGGEST_MODE_MIN, denied: 0 });
    const held = times(SUGGEST_MODE_MIN, card('allowed'));
    expect(suggest(held, { rules: [rule({ list: 'ask', pattern: 'mcp__mail__*' })] }).mode).toBeNull();
  });
});

describe('ways to ask less, from real cards', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  const ROUTINE = { prompt: 'Say good morning.', schedule: { type: 'daily', time: '08:00' } };
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
  const suggestions = async (botId: string) =>
    (await t.api<PermissionSuggestions>('GET', `/api/bots/${botId}/suggestions`)).body;

  const answerCards = async (botId: string, n: number, decision: 'allow' | 'deny' = 'allow') => {
    const thread = (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
    for (let i = 0; i < n; i++) {
      await t.send(thread.id, `[araç:routine_create ${JSON.stringify({ ...ROUTINE, name: `R${i}` })}]`);
      const c = await waitFor(async () => (await pending())[0]);
      await t.api('POST', `/api/approvals/${c.id}`, { decision });
      await t.services.turns.idle();
    }
  };

  it('offers an "always allow" after enough allowed cards, and drops it once turned down', async () => {
    const bot = await t.bot();
    await answerCards(bot.id, SUGGEST_RULE_MIN);
    expect((await suggestions(bot.id)).rules).toEqual([
      expect.objectContaining({ pattern: 'mcp__leafbot__routine_create', allowed: SUGGEST_RULE_MIN }),
    ]);
    const res = await t.api('POST', `/api/bots/${bot.id}/suggestions/dismiss`, {
      key: 'mcp__leafbot__routine_create',
    });
    expect(res.status).toBe(200);
    expect((await suggestions(bot.id)).rules).toEqual([]);
  });

  it('stops offering a rule the person has added', async () => {
    const bot = await t.bot();
    await answerCards(bot.id, SUGGEST_RULE_MIN);
    await t.api('POST', '/api/rules', {
      list: 'allow',
      pattern: 'mcp__leafbot__routine_create',
      botId: bot.id,
    });
    expect((await suggestions(bot.id)).rules).toEqual([]);
  });

  it('does not count a card answered by typing in the chat', async () => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, `[araç:routine_create ${JSON.stringify({ ...ROUTINE, name: 'R' })}]`);
    const c = await waitFor(async () => (await pending())[0]);
    await t.services.approvals.redirect(c.id, 'not that one');
    await t.services.turns.idle();
    const [row] = (await t.api<Approval[]>('GET', '/api/approvals')).body;
    expect(row?.status).toBe('denied');
    await answerCards(bot.id, SUGGEST_RULE_MIN);
    // The typed answer would have counted as a refusal and kept the suggestion away.
    expect((await suggestions(bot.id)).rules).toHaveLength(1);
  });

  it('offers each person only what their own answers show', async () => {
    const bot = await t.bot();
    await answerCards(bot.id, SUGGEST_RULE_MIN);
    expect((await suggestions(bot.id)).rules).toHaveLength(1);
    // An admin may change every bot, and still does not learn from the owner's cards.
    const admin = await t.person('yonetici', 'admin');
    const theirs = await admin.api<PermissionSuggestions>('GET', `/api/bots/${bot.id}/suggestions`);
    expect(theirs.status).toBe(200);
    expect(theirs.body.rules).toEqual([]);
    expect(theirs.body.mode).toBeNull();
  });
});
