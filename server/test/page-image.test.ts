import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as httpServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, MessageFile, Thread } from '@leafbot/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findBrowser } from '../src/browser/find';
import { bundlePage } from '../src/tools/page-bundle';
import { testServer, warmBrowser, type TestServer } from './helpers';

const BROWSER = process.env.LEAFBOT_TEST_BROWSER ?? findBrowser();

/** A PNG's size from its header. */
const pngSize = (data: Buffer) => ({ width: data.readUInt32BE(16), height: data.readUInt32BE(20) });

const fileCards = (msgs: Message[]) =>
  msgs.filter((m) => m.role === 'assistant' && Array.isArray(m.props.files));

describe('sayfayı resme çevirme', () => {
  it('stillerdeki resimleri de sayfaya gömer; bağlı stil dosyasınınkileri kendi klasörüne göre bulur', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-page-'));
    try {
      mkdirSync(join(dir, 'stil'));
      mkdirSync(join(dir, 'resim'));
      writeFileSync(join(dir, 'resim', 'zemin.png'), 'PNG1');
      writeFileSync(join(dir, 'logo.svg'), '<svg/>');
      writeFileSync(join(dir, 'stil', 'ana.css'), "body{background:url('../resim/zemin.png') center/cover}");
      writeFileSync(
        join(dir, 'index.html'),
        `<link rel="stylesheet" href="stil/ana.css">
         <style>.k{background-image:url("resim/zemin.png")}.y{background:url(yok.png)}</style>
         <div style="background:url('logo.svg')"></div><img src="./logo.svg">`,
      );
      const { html, leftOut } = await bundlePage(join(dir, 'index.html'));
      const png = `url(data:image/png;base64,${Buffer.from('PNG1').toString('base64')})`;
      const svg = `data:image/svg+xml;base64,${Buffer.from('<svg/>').toString('base64')}`;
      expect(html).toContain(`body{background:${png} center/cover}`);
      expect(html).toContain(`.k{background-image:${png}}`);
      expect(html).toContain(`<div style="background:url(${svg})"></div>`);
      expect(html).toContain(`<img src="${svg}">`);
      // A picture that is not there stays as it was.
      expect(html).toContain('url(yok.png)');
      expect(leftOut).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tarayıcı programı yoksa araç yoktur', async () => {
    const t = await testServer();
    try {
      const bot = await t.bot();
      const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
      await t.send(thread.id, 'merhaba');
      await t.services.turns.idle();
      expect(t.engine.requests.at(-1)!.tools.map((x) => x.name)).not.toContain('page_to_image');
    } finally {
      await t.dispose();
    }
  });
});

describe.skipIf(!BROWSER)('sayfayı resme çevirme (tarayıcıyla)', () => {
  let site: Server;
  let base: string;
  let hits: string[];
  let t: TestServer;

  beforeAll(async () => {
    await warmBrowser(BROWSER!, process.getuid?.() !== 0);
    site = httpServer((req, res) => {
      hits.push(req.url ?? '');
      res.end('x');
    });
    // A WebSocket arrives as an upgrade, not as a request.
    site.on('upgrade', (req, sock: { destroy(): void }) => {
      hits.push(`ws ${req.url ?? ''}`);
      sock.destroy();
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => site.close(() => r())));

  beforeEach(async () => {
    hits = [];
    // Tests may run as root, where Chromium's own sandbox cannot start.
    t = await testServer({ browserPath: BROWSER, browserSandbox: process.getuid?.() !== 0 });
  });
  afterEach(() => t.dispose());

  const setup = async () => {
    const bot = await t.bot({ name: 'Tasarımcı' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const dir = join(t.dataDir, 'workspaces', 'bots', bot.id, 'threads', thread.id);
    mkdirSync(dir, { recursive: true });
    return { bot, thread, dir };
  };
  const render = async (threadId: string, input: Record<string, unknown>) => {
    await t.send(threadId, `[araç:page_to_image ${JSON.stringify(input)}]`);
    await t.services.turns.idle();
    return t.messages(threadId);
  };
  const picture = (msgs: Message[]) => {
    const [card] = fileCards(msgs);
    const [file] = card!.props.files as MessageFile[];
    return { card: card!, file: file!, data: readFileSync(join(t.dataDir, 'workspaces', file!.path)) };
  };

  it('sayfayı istenen boyutta PNG yapar ve sormadan kart olarak gönderir', async () => {
    const { bot, thread, dir } = await setup();
    writeFileSync(
      join(dir, 'afiş.html'),
      '<style>body{margin:0;width:300px;height:100px;background:#1b3226;color:#f4efe3}</style><h1>Leaf</h1>',
    );
    const msgs = await render(thread.id, { path: 'afiş.html', width: 300, height: 100, caption: 'Afiş' });
    const { card, file, data } = picture(msgs);
    expect(card.text).toBe('Afiş');
    expect(file.name).toBe('afiş.png');
    expect(file.path).toBe(`bots/${bot.id}/threads/${thread.id}/afiş.png`);
    expect(pngSize(data)).toEqual({ width: 300, height: 100 });
    expect(msgs.at(-1)!.text).toContain('Sayfa resme çevrildi');

    // Twice as sharp, under a free name beside the first.
    const again = picture(
      (await render(thread.id, { path: 'afiş.html', width: 300, height: 100, scale: 2 })).slice(-3),
    );
    expect(again.file.name).toBe('afiş-2.png');
    expect(pngSize(again.data)).toEqual({ width: 600, height: 200 });
  });

  it('klasörü index.html ve yanındaki dosyalarla çevirir; boy verilmezse sayfanın boyunu alır', async () => {
    const { thread, dir } = await setup();
    mkdirSync(join(dir, 'kapak'));
    writeFileSync(join(dir, 'kapak', 'stil.css'), 'body{margin:0}.k{height:250px;background:#3a7d55}');
    writeFileSync(
      join(dir, 'kapak', 'index.html'),
      '<link rel="stylesheet" href="stil.css"><div class="k"></div>',
    );
    const { file, data } = picture(await render(thread.id, { path: 'kapak', width: 200 }));
    expect(file.name).toBe('kapak.png');
    expect(pngSize(data)).toEqual({ width: 200, height: 250 });
  });

  it('sayfa bu sunucuya, yerel ağa ya da başka bir adrese ulaşamaz', async () => {
    const { thread, dir } = await setup();
    writeFileSync(
      join(dir, 'sızıntı.html'),
      `<img src="${base}/resim.png"><script src="${base}/kod.js"></script>
       <script>fetch('${base}/veri').catch(() => {}); new WebSocket('${base.replace('http', 'ws')}/soket');
       location.href = '${base}/git';</script>`,
    );
    const msgs = await render(thread.id, { path: 'sızıntı.html', width: 100, height: 100 });
    expect(fileCards(msgs)).toHaveLength(1);
    expect(hits).toEqual([]);
  });

  it('HTML olmayan dosyayı çevirmez', async () => {
    const { thread, dir } = await setup();
    writeFileSync(join(dir, 'not.txt'), 'merhaba');
    const msgs = await render(thread.id, { path: 'not.txt', width: 100, height: 100 });
    expect(fileCards(msgs)).toHaveLength(0);
    expect(msgs.at(-1)!.text).toContain('Yalnızca .html');
  });
});
