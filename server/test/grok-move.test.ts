import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BotImportPlan, BotImportResult, Message, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH, testServer, type TestServer } from './helpers';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';
const blob = (key: string) => {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of Buffer.from(key, 'utf8')) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return `${out}.blob`;
};

const file = {
  format: 'leafbot-bot-import',
  version: 1,
  bots: [{ ref: 'trip-planner', name: 'Trip Planner', instructions: 'Plan trips.' }],
};

describe('moving from Grok Bot', () => {
  let t: TestServer;
  let home: string;
  const realHome = process.env.HOME;
  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'leafbot-home-'));
    process.env.HOME = home;
    t = await testServer();
  });
  afterEach(async () => {
    process.env.HOME = realHome;
    await t.dispose();
    rmSync(home, { recursive: true, force: true });
  });

  const send = async <T>(text: string, preview = false) => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/import/bots${preview ? '?preview=1' : ''}`,
      headers: { ...AUTH, host: 'localhost', 'content-type': 'application/octet-stream' },
      payload: Buffer.from(text),
    });
    return { status: res.statusCode, body: res.json() as T };
  };

  it('imports a reply pasted as it came, with words around the document', async () => {
    const reply = `Done! Here is the file:\n\n\`\`\`json\n${JSON.stringify(file, null, 2)}\n\`\`\`\nTell me if anything is missing.`;
    const plan = await send<BotImportPlan>(reply, true);
    expect(plan.status).toBe(200);
    expect(plan.body.bots.map((b) => b.name)).toEqual(['Trip Planner']);
  });

  it('refuses a reply with credential fields, naming them', async () => {
    const r = await send<{ error: string }>(JSON.stringify({ ...file, apiKey: 'x' }), true);
    expect(r.status).toBe(400);
    expect(r.body.error).toContain('apiKey');
  });

  it('lists export files in Downloads and reads one back', async () => {
    mkdirSync(join(home, 'Downloads'));
    writeFileSync(join(home, 'Downloads', 'leafbot-bots.json'), JSON.stringify(file));
    const found = await t.api<{ files: { name: string; bots: string[] }[]; appBots: string[] | null }>(
      'GET',
      '/api/import/grok',
    );
    expect(found.body.files.map((f) => [f.name, f.bots])).toEqual([['leafbot-bots.json', ['Trip Planner']]]);
    expect(found.body.appBots).toBeNull();
    const read = await t.api<{ text: string }>('POST', '/api/import/grok/files', {
      names: ['leafbot-bots.json'],
    });
    expect(JSON.parse(read.body.text)).toEqual(file);
  });

  it('brings a moved bot’s chat over once, as a record with the app’s times', async () => {
    const cache = join(home, 'Library', 'Application Support', 'Grok Bot', 'sand-client-persistence');
    mkdirSync(cache, { recursive: true });
    const slice = (kind: string, value: unknown) =>
      writeFileSync(join(cache, blob(`sand.client.slice.account.u1.${kind}`)), JSON.stringify({ value }));
    slice('roster.last-roster', { rows: [{ id: 'b1', name: 'Trip Planner' }] });
    slice('transcript.replicas.b1', {
      entries: [
        { kind: 'message', role: 'user', content: 'Plan Rome', seq: 1, timestampMs: Date.UTC(2026, 9, 1, 9) },
        {
          kind: 'send-message',
          message: { type: 'text', content: 'Which dates?' },
          seq: 2,
          timestampMs: Date.UTC(2026, 9, 1, 9, 1),
        },
      ],
    });
    expect((await t.api<{ appBots: string[] }>('GET', '/api/import/grok')).body.appBots).toEqual([
      'Trip Planner',
    ]);
    const made = await send<BotImportResult>(JSON.stringify(file));
    const botId = made.body.botIds[0]!;
    const chats = async () =>
      (
        await t.api<unknown[]>('POST', '/api/import/grok/chats', {
          bots: [{ id: botId, name: 'Trip Planner' }],
        })
      ).body;
    expect(await chats()).toEqual([{ id: botId, messages: 2 }]);
    // Asked again, the conversation it made is found and nothing is added.
    expect(await chats()).toEqual([{ id: botId, messages: 2 }]);
    const threads = (await t.api<Thread[]>('GET', `/api/bots/${botId}/threads`)).body;
    const moved = threads.filter((th) => th.title.includes('Grok Bot'));
    expect(moved).toHaveLength(1);
    const messages = (await t.api<Message[]>('GET', `/api/threads/${moved[0]!.id}/messages`)).body;
    expect(messages.map((m) => [m.role, m.text, m.createdAt])).toEqual([
      ['user', 'Plan Rome', '2026-10-01T09:00:00.000Z'],
      ['assistant', 'Which dates?', '2026-10-01T09:01:00.000Z'],
    ]);
  });

  it('opens no link where there is neither a public address nor cloudflared', async () => {
    const state = await t.api<{ available: boolean }>('GET', '/api/import/grok/link');
    if (state.body.available) return; // this computer has cloudflared
    expect((await t.api('POST', '/api/import/grok/link')).status).toBe(404);
  });

  it('answers a move link that is not open with 404 and no body', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/hooks/move/${'x'.repeat(43)}`,
      headers: { host: 'localhost', 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('');
  });
  it('on a public address, serves the link to POST only and reads what arrived once', async () => {
    await t.close();
    t = await testServer({ publicUrl: 'https://bots.example.test', onUserComputer: false });
    const open = await t.api<{ url: string }>('POST', '/api/import/grok/link');
    expect(open.status).toBe(200);
    const path = new URL(open.body.url).pathname;
    expect(path).toMatch(/^\/api\/hooks\/move\/[A-Za-z0-9_-]{43}$/);
    const hook = (method: 'GET' | 'DELETE' | 'POST', url: string, payload?: unknown) =>
      t.app.inject({
        method,
        url,
        headers: {
          host: 'localhost',
          accept: 'application/json, text/event-stream',
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload ? { payload: JSON.stringify(payload) } : {}),
      });
    for (const method of ['GET', 'DELETE'] as const) {
      const res = await hook(method, path);
      expect(res.statusCode).toBe(405);
      expect(res.headers.allow).toBe('POST');
    }
    expect((await hook('GET', `/api/hooks/move/${'x'.repeat(43)}`)).statusCode).toBe(404);

    const call = (id: number, method: string, params: unknown) => ({ jsonrpc: '2.0', id, method, params });
    const sent = await hook(
      'POST',
      path,
      call(1, 'tools/call', { name: 'send_export', arguments: { document: file } }),
    );
    expect(sent.statusCode).toBe(200);
    expect(sent.body).toContain('Received: Trip Planner');

    const state = await t.api<{ arrived: { seq: number; names: string[] }[] }>(
      'GET',
      '/api/import/grok/link',
    );
    expect(state.body.arrived).toEqual([expect.objectContaining({ names: ['Trip Planner'] })]);
    expect(state.body.arrived[0]).not.toHaveProperty('text');
    const taken = await t.api<{ text: string }>('POST', '/api/import/grok/link/take', {
      upTo: state.body.arrived[0]!.seq,
    });
    expect(JSON.parse(taken.body.text)).toMatchObject({ bots: [{ ref: 'trip-planner' }] });
    expect((await t.api<{ arrived: unknown[] }>('GET', '/api/import/grok/link')).body.arrived).toEqual([]);
  });
});
