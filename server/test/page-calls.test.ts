import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Connection, PageApp, Thread } from '@leafbot/shared';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AUTH, testServer, type TestServer } from './helpers';

/** An issue tracker with a tool that lists issues and one that opens an issue. */
async function trackerApp() {
  const opened: string[] = [];
  const http: Server = createHttpServer(async (req, res) => {
    const s = new McpServer({ name: 'tracker', version: '1.0.0' });
    s.registerTool(
      'list_issues',
      {
        description: 'Lists open issues',
        inputSchema: { repo: z.string() },
        annotations: { readOnlyHint: true },
      },
      async ({ repo }) => ({ content: [{ type: 'text', text: `${repo}: #1 Giriş hatası` }] }),
    );
    s.registerTool(
      'open_issue',
      { description: 'Opens an issue', inputSchema: { title: z.string() } },
      async ({ title }) => {
        opened.push(title);
        return { content: [{ type: 'text', text: `opened ${title}` }] };
      },
    );
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      void transport.close();
      void s.close();
    });
    await s.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  return {
    opened,
    url: `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`,
    close: () => new Promise<void>((r) => http.close(() => r())),
  };
}

describe('sayfanın kendi verisi, tablolar ve bağlı uygulamalar', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  /** A page in the bot's main conversation folder, by its library path. */
  const page = async (text = '<h1>Uygulama</h1>', name = 'uygulama.html') => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const dir = join(t.dataDir, 'workspaces', 'bots', bot.id, 'threads', thread.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), text);
    return { bot, thread, dir, path: `bots/${bot.id}/threads/${thread.id}/${name}` };
  };
  const call = <T>(botId: string, path: string, method: string, params: object = {}, confirmed?: boolean) =>
    t.api<{ result: T; error?: string }>('POST', `/api/bots/${botId}/library/page-call`, {
      path,
      method,
      params,
      ...(confirmed !== undefined && { confirmed }),
    });

  it('sayfa kendi verisini kişi başına saklar; aynı veri kaydedilen uygulamada da görünür', async () => {
    const { bot, path } = await page();
    expect((await call(bot.id, path, 'state.get', { key: 'harcamalar' })).body.result).toBeNull();
    await call(bot.id, path, 'state.set', { key: 'harcamalar', value: [{ ad: 'Market', tutar: 120 }] });
    await call(bot.id, path, 'state.set', { key: 'ay', value: 'Kasım' });
    expect((await call(bot.id, path, 'state.get', { key: 'harcamalar' })).body.result).toEqual([
      { ad: 'Market', tutar: 120 },
    ]);
    expect((await call(bot.id, path, 'state.keys')).body.result).toEqual(['ay', 'harcamalar']);

    // The same page saved as an app reads the same data.
    const { body: app } = await t.api<PageApp>('POST', `/api/bots/${bot.id}/library/app`, {
      path,
      name: 'H',
    });
    const viaApp = await t.api<{ result: unknown }>('POST', `/api/page-apps/${app.id}/call`, {
      method: 'state.get',
      params: { key: 'ay' },
    });
    expect(viaApp.body.result).toBe('Kasım');

    // Removing a key.
    await call(bot.id, path, 'state.set', { key: 'ay' });
    expect((await call(bot.id, path, 'state.keys')).body.result).toEqual(['harcamalar']);

    // Too large a value is refused.
    const big = await call(bot.id, path, 'state.set', { key: 'büyük', value: 'x'.repeat(300 * 1024) });
    expect(big.status).toBe(413);

    // Another person, even one let into the bot, has their own data and nothing of this one's.
    await t.api('PATCH', `/api/bots/${bot.id}`, { access: { everyone: 'chat', people: {} } });
    const other = await t.person('ayse');
    const theirs = await other.api<{ result: unknown }>('POST', `/api/bots/${bot.id}/library/page-call`, {
      path,
      method: 'state.get',
      params: { key: 'harcamalar' },
    });
    // The owner's conversation is not theirs, so they cannot reach its page at all.
    expect([403, 404]).toContain(theirs.status);
    expect((await other.api('POST', `/api/page-apps/${app.id}/call`, { method: 'state.keys' })).status).toBe(
      404,
    );
  });

  it('sayfa botun tablolarını okur; satır eklemek botu düzenleme izni ister', async () => {
    const { bot, path } = await page();
    await t.services.tables.define(bot.id, 'Harcamalar', [
      { name: 'Ad', type: 'text' },
      { name: 'Tutar', type: 'number' },
    ]);
    const listed = await call<{ name: string; write: boolean }[]>(bot.id, path, 'data.tables');
    expect(listed.body.result).toMatchObject([{ name: 'Harcamalar', write: true }]);
    const added = await call<{ id: string; Ad: string }[]>(bot.id, path, 'data.add', {
      table: 'harcamalar',
      rows: [{ Ad: 'Market', Tutar: 120 }],
    });
    expect(added.status).toBe(200);
    const rows = await call<{ id: string; Ad: string; Tutar: number }[]>(bot.id, path, 'data.rows', {
      table: 'Harcamalar',
    });
    expect(rows.body.result).toMatchObject([{ Ad: 'Market', Tutar: 120 }]);
    const id = rows.body.result[0]!.id;
    await call(bot.id, path, 'data.update', { table: 'Harcamalar', id, values: { Tutar: 150 } });
    expect(
      (await call<{ Tutar: number }[]>(bot.id, path, 'data.rows', { table: 'Harcamalar' })).body.result[0]!
        .Tutar,
    ).toBe(150);
    // A value that does not fit its column stops the write.
    expect(
      (await call(bot.id, path, 'data.add', { table: 'Harcamalar', rows: [{ Tutar: 'çok' }] })).status,
    ).toBe(400);
    expect((await call(bot.id, path, 'data.rows', { table: 'Yok' })).status).toBe(404);
    await call(bot.id, path, 'data.remove', { table: 'Harcamalar', ids: [id] });
    expect((await call<unknown[]>(bot.id, path, 'data.rows', { table: 'Harcamalar' })).body.result).toEqual(
      [],
    );
    expect((await call(bot.id, path, 'nope')).status).toBe(400);
  });

  it('sayfa yalnızca söylediği araçları çağırır; değiştiren bir işlem kişinin onayını ister', async () => {
    const tracker = await trackerApp();
    try {
      const conn = (
        await t.api<Connection>('POST', '/api/connections', { name: 'Takip', url: tracker.url, auth: 'none' })
      ).body;
      const list = `mcp__${conn.slug}__list_issues`;
      const open = `mcp__${conn.slug}__open_issue`;
      const { bot, path } = await page(
        `<meta name="leafbot:connectors" content="${list} ${open}"><h1>Hatalar</h1>`,
      );
      const tools = await call<{ name: string; read: boolean; available: boolean; app: string }[]>(
        bot.id,
        path,
        'connectors.list',
      );
      expect(tools.body.result).toMatchObject([
        { name: list, read: true, available: true, app: 'Takip' },
        { name: open, read: false, available: true },
      ]);
      const read = await call<{ text: string; isError: boolean }>(bot.id, path, 'connectors.call', {
        tool: list,
        args: { repo: 'leafbot' },
      });
      expect(read.body.result).toEqual({ isError: false, text: 'leafbot: #1 Giriş hatası' });

      // A call that changes something waits for the person's yes in the app.
      const asked = await call(bot.id, path, 'connectors.call', { tool: open, args: { title: 'Yeni' } });
      expect(asked.status).toBe(409);
      expect(tracker.opened).toEqual([]);
      const yes = await call<{ text: string }>(
        bot.id,
        path,
        'connectors.call',
        { tool: open, args: { title: 'Yeni' } },
        true,
      );
      expect(yes.body.result.text).toBe('opened Yeni');
      expect(tracker.opened).toEqual(['Yeni']);

      // A tool the page did not name is refused, whatever it is.
      const { bot: other, path: plain } = await page('<h1>Başka</h1>');
      expect(
        (await call(other.id, plain, 'connectors.call', { tool: list, args: { repo: 'x' } })).status,
      ).toBe(403);
      expect((await call(other.id, plain, 'connectors.list')).body.result).toEqual([]);
    } finally {
      await tracker.close();
    }
  });

  it('JSX sayfası tema, yardımcı ve kitle birlikte sunulur; kit dosyaları oturumsuz açılır', async () => {
    const { bot, path } = await page(
      `import { useState } from 'react';\nimport { Wallet } from 'lucide-react';\nexport default function App() {\n  const [n] = useState(1);\n  return <div className="p-6"><Wallet />{n}</div>;\n}\n`,
      'uygulama.jsx',
    );
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/bots/${bot.id}/library/page?path=${encodeURIComponent(path)}&theme=dark`,
      headers: { host: 'localhost', ...AUTH },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('dataset.theme="dark"');
    expect(res.body).toContain('window.leafbot=');
    const kit = [...res.body.matchAll(/src="(\/page-kit\/[^"]+)"/g)].map((m) => m[1]!);
    expect(kit.map((u) => u.split('/').pop())).toEqual(['tailwind.js', 'react.js', 'lucide.js']);
    // The JSX became plain script.
    expect(res.body).not.toContain('<Wallet />');
    expect(String(res.headers['content-security-policy'])).toContain("script-src 'unsafe-inline' 'self'");
    const lib = await t.app.inject({ method: 'GET', url: kit[1]!, headers: { host: 'localhost' } });
    expect(lib.statusCode).toBe(200);
    expect(lib.headers['cache-control']).toContain('immutable');
    expect(
      (await t.app.inject({ method: 'GET', url: '/page-kit/eski/react.js', headers: { host: 'localhost' } }))
        .statusCode,
    ).toBe(404);

    // A page that imports something outside the kit says so instead of running.
    const { bot: b2, path: p2 } = await page(
      `import x from 'left-pad';\nexport default () => x;`,
      'kotu.jsx',
    );
    const bad = await t.app.inject({
      method: 'GET',
      url: `/api/bots/${b2.id}/library/page?path=${encodeURIComponent(p2)}`,
      headers: { host: 'localhost', ...AUTH },
    });
    expect(bad.body).toContain('left-pad');
    expect(bad.body).toContain('could not start');
  }, 60_000);
});
