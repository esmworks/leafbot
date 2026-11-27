import { describe, expect, it } from 'vitest';
import { botImportFromText, botImportNames, BotImportTextProblem } from './bot-import-text';

const bot = (ref: string, extra: Record<string, unknown> = {}) => ({
  ref,
  name: ref.toUpperCase(),
  description: '',
  instructions: 'Do the work.',
  avatar: null,
  routines: [],
  memories: [],
  skills: [],
  ...extra,
});
const doc = (bots: unknown[], extra: Record<string, unknown> = {}) => ({
  format: 'leafbot-bot-import',
  version: 1,
  source: 'grok-bot',
  bots,
  ...extra,
});

const problem = (text: string) => {
  try {
    botImportFromText(text);
  } catch (e) {
    if (e instanceof BotImportTextProblem) return e;
    throw e;
  }
  throw new Error('read without a problem');
};

describe('botImportFromText', () => {
  it('reads a plain file', () => {
    const file = doc([bot('a')]);
    expect(botImportFromText(JSON.stringify(file))).toEqual(file);
  });

  it('finds the document in a chat reply with a code block and words around it', () => {
    const reply = `Here is your export:\n\n\`\`\`json\n${JSON.stringify(doc([bot('a')]), null, 2)}\n\`\`\`\n\nI left out the Slack task {see notes}.`;
    expect(botImportNames(botImportFromText(reply))).toEqual(['A']);
  });

  it('repairs trailing commas but keeps commas inside strings', () => {
    const text = `{"format": "leafbot-bot-import", "version": 1, "bots": [{"ref": "a", "name": "A", "instructions": "x, }", "memories": ["one",],},],}`;
    const read = botImportFromText(text) as { bots: { instructions: string; memories: string[] }[] };
    expect(read.bots[0]!.instructions).toBe('x, }');
    expect(read.bots[0]!.memories).toEqual(['one']);
  });

  it('straightens curled quotes a chat app put in place of JSON quotes', () => {
    const text = JSON.stringify(doc([bot('a')])).replace(/"/g, '“');
    expect(botImportNames(botImportFromText(text))).toEqual(['A']);
  });

  it('joins a split export: one bot over two messages, and a second bot', () => {
    const part1 = doc([bot('a', { memories: ['m1'], routines: [{ name: 'r1' }] })], {
      groups: [{ name: 'G', members: ['a'] }],
    });
    const part2 = doc([bot('a', { memories: ['m1', 'm2'], instructions: '' }), bot('b')], {
      groups: [{ name: 'G', members: ['b'] }],
      notImported: [{ bot: 'a', what: 'Slack task', reason: 'starts on a message' }],
    });
    const read = botImportFromText(
      `First part:\n${JSON.stringify(part1)}\n\nSecond part:\n${JSON.stringify(part2)}`,
    ) as {
      bots: { ref: string; memories: string[]; instructions: string; routines: unknown[] }[];
      groups: { members: string[] }[];
      notImported: unknown[];
    };
    expect(read.bots.map((b) => b.ref)).toEqual(['a', 'b']);
    expect(read.bots[0]!.memories).toEqual(['m1', 'm2']);
    expect(read.bots[0]!.instructions).toBe('Do the work.');
    expect(read.bots[0]!.routines).toHaveLength(1);
    expect(read.groups).toEqual([{ name: 'G', members: ['a', 'b'] }]);
    expect(read.notImported).toHaveLength(1);
  });

  it('ignores other objects in the reply', () => {
    const text = `Example schedule {"type": "daily", "time": "08:00"} and the file ${JSON.stringify(doc([bot('a')]))}`;
    expect(botImportNames(botImportFromText(text))).toEqual(['A']);
  });

  it('says the reply was cut off when the document does not close', () => {
    const text = JSON.stringify(doc([bot('a')])).slice(0, 80);
    expect(problem(text).code).toBe('cutOff');
  });

  it('says it is not an export when nothing names the format', () => {
    expect(problem('Sure! What would you like me to move?').code).toBe('notExport');
    expect(problem('{"bots": []}').code).toBe('notExport');
  });

  it('refuses a document with a credential field, naming it', () => {
    const text = JSON.stringify(doc([bot('a', { apiKey: 'x', settings: { access_token: 'y' } })]));
    const p = problem(text);
    expect(p.code).toBe('credentials');
    expect(p.keys).toEqual(['access_token', 'apiKey']);
  });

  it('does not take the format own fields for credentials', () => {
    const file = doc([
      bot('a', {
        skills: [{ name: 'k', description: 'd', body: 'b' }],
        routines: [{ name: 'r', prompt: 'p', schedule: { type: 'daily', time: '08:00' }, timezone: 'UTC' }],
      }),
    ]);
    expect(botImportFromText(JSON.stringify(file))).toEqual(file);
  });

  it('masks a key of a known shape inside a text, but not inside a picture', () => {
    const key = `ghp_${'a1B2'.repeat(9)}`;
    const avatar = `data:image/png;base64,${key}`;
    const read = botImportFromText(
      JSON.stringify(doc([bot('a', { instructions: `Use ${key} for GitHub.`, avatar })])),
    ) as { bots: { instructions: string; avatar: string }[] };
    expect(read.bots[0]!.instructions).not.toContain(key);
    expect(read.bots[0]!.avatar).toBe(avatar);
  });

  it('refuses a text larger than an import file may be', () => {
    expect(problem('x'.repeat(26 * 1024 * 1024)).code).toBe('tooLarge');
  });
});
