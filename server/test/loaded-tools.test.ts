import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ClaudeEngine } from '../src/engine/claude';
import { LoadedTools, projectFolder } from '../src/engine/loaded-tools';
import type { AppTool } from '../src/engine/types';

/** A resumed session that loaded a tool before the server changed it is told apart from one that did not. */
describe('tools a session loaded', () => {
  let dir: string;
  const cwd = '/data/workspaces/bots/b1/threads/t1';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'loaded-tools-'));
    mkdirSync(join(dir, 'projects', projectFolder(cwd)), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const file = (id: string) => join(dir, 'projects', projectFolder(cwd), `${id}.jsonl`);
  const record = (entries: { name: string; description: string; properties: Record<string, unknown> }[]) =>
    `${JSON.stringify({
      type: 'attachment',
      attachment: {
        type: 'deferred_tools_record',
        entries: entries.map((e) => ({
          name: e.name,
          description: e.description,
          input_schema: { type: 'object', properties: e.properties },
          defer_loading: true,
        })),
      },
    })}\n`;
  const tool = (name: string, description: string, input: z.ZodRawShape): AppTool =>
    ({ name, description, input, readOnly: false, internal: false, handler: async () => '' }) as AppTool;

  it('names a loaded tool whose description or fields changed, and only that one', async () => {
    writeFileSync(
      file('s1'),
      `${JSON.stringify({ type: 'user', message: { content: 'merhaba' } })}\n` +
        record([
          {
            name: 'mcp__leafbot__routine_update',
            description: 'Change a routine.',
            properties: { routine: {} },
          },
          { name: 'mcp__leafbot__bot_send', description: 'Send.', properties: { bot: {}, message: {} } },
        ]),
    );
    const loaded = new LoadedTools();
    const now = [
      tool('routine_update', 'Change a routine.', { routine: z.string(), condition: z.string().optional() }),
      tool('bot_send', 'Send.', { message: z.string(), bot: z.string() }),
      // Never loaded in the session, so nothing stale to hold.
      tool('routine_run', 'Run.', { routine: z.string() }),
    ];
    expect(await loaded.changed(dir, cwd, 's1', now)).toEqual(['routine_update']);

    // A later load of the new definition in the same session is what counts from then on.
    appendFileSync(
      file('s1'),
      record([
        {
          name: 'mcp__leafbot__routine_update',
          description: 'Change a routine.',
          properties: { routine: {}, condition: {} },
        },
      ]),
    );
    expect(await loaded.changed(dir, cwd, 's1', now)).toEqual([]);
    expect(await loaded.changed(dir, cwd, 's1', [tool('bot_send', 'Send a bot a message.', {})])).toEqual([
      'bot_send',
    ]);
  });

  it('reads a connection tool by its JSON fields, and finds a transcript kept in another folder', async () => {
    const other = join(dir, 'projects', 'cut-short-1a2b');
    mkdirSync(other, { recursive: true });
    writeFileSync(
      join(other, 's2.jsonl'),
      record([{ name: 'mcp__crm__search', description: 'Search.', properties: { q: {} } }]),
    );
    const crm = {
      ...tool('search', 'Search.', {}),
      server: 'crm',
      jsonSchema: { properties: { q: {}, page: {} } },
    } as AppTool;
    expect(await new LoadedTools().changed(dir, cwd, 's2', [crm])).toEqual(['search']);
  });

  it('counts nothing as changed when the transcript is missing, half written or not JSON', async () => {
    const loaded = new LoadedTools();
    const now = [tool('routine_update', 'New.', { routine: z.string() })];
    expect(await loaded.changed(dir, cwd, 'gone', now)).toEqual([]);
    expect(await loaded.changed(dir, cwd, '../../etc/passwd', now)).toEqual([]);
    const line = record([{ name: 'mcp__leafbot__routine_update', description: 'Old.', properties: {} }]);
    writeFileSync(file('s3'), `not json "deferred_tools_record"\n${line.slice(0, 40)}`);
    expect(await loaded.changed(dir, cwd, 's3', now)).toEqual([]);
    // The line finished later is read then.
    appendFileSync(file('s3'), line.slice(40));
    expect(await loaded.changed(dir, cwd, 's3', now)).toEqual(['routine_update']);
  });
  it('hands the turn to a new session before the CLI starts, naming the changed tools', async () => {
    writeFileSync(
      file('s4'),
      record([{ name: 'mcp__leafbot__routine_update', description: 'Old.', properties: { routine: {} } }]),
    );
    const engine = new ClaudeEngine({ configDir: dir });
    const out = await engine.run({
      turnId: 't',
      threadId: 'th',
      botId: 'b',
      model: 'haiku',
      prompt: 'merhaba',
      sessionId: 's4',
      systemPrompt: '',
      locale: 'tr',
      sandbox: { cwd, additionalDirectories: [], writable: [cwd], internet: false, readOnly: false },
      shell: 'sandbox',
      tools: [tool('routine_update', 'New.', { routine: z.string() })],
      canUseTool: async () => ({ behavior: 'deny', message: 'hayır' }),
      onText: () => {},
      onSession: () => {},
      signal: new AbortController().signal,
    });
    expect(out).toMatchObject({
      ok: false,
      kind: 'lostSession',
      sessionId: null,
      staleTools: ['routine_update'],
    });
  });
});
