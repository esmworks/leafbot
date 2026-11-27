import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, MessageFile, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ID } from '../src/users';
import { AUTH, testServer, type TestServer } from './helpers';

describe('botun dosya göndermesi', () => {
  let t: TestServer;
  const extra: string[] = [];
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
    for (const d of extra.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const threadDir = (botId: string, threadId: string) => {
    const dir = join(t.dataDir, 'workspaces', 'bots', botId, 'threads', threadId);
    mkdirSync(dir, { recursive: true });
    return dir;
  };
  const sendFile = async (threadId: string, input: Record<string, unknown>) => {
    await t.send(threadId, `[araç:send_file ${JSON.stringify(input)}]`);
    await t.services.turns.idle();
    return t.messages(threadId);
  };
  const fileMessages = (msgs: Message[]) =>
    msgs.filter((m) => m.role === 'assistant' && Array.isArray(m.props.files));
  const download = (botId: string, path: string) =>
    t.app.inject({
      method: 'GET',
      url: `/api/bots/${botId}/library/file?path=${encodeURIComponent(path)}`,
      headers: { ...AUTH, host: 'localhost' },
    });

  it('sohbet klasöründeki dosyayı kart olarak gönderir, kart indirilebilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    writeFileSync(join(threadDir(bot.id, thread.id), 'rapor.csv'), 'a,b\n1,2');
    const msgs = await sendFile(thread.id, { paths: ['rapor.csv'], caption: 'İşte rapor' });
    const [card] = fileMessages(msgs);
    expect(card).toBeDefined();
    expect(card!.author).toBe(`bot:${bot.id}`);
    expect(card!.text).toBe('İşte rapor');
    const [file] = card!.props.files as MessageFile[];
    expect(file).toEqual({
      name: 'rapor.csv',
      size: 7,
      path: `bots/${bot.id}/threads/${thread.id}/rapor.csv`,
    });
    expect((await download(bot.id, file!.path)).body).toBe('a,b\n1,2');
    // The bot is told it went out; its reply comes after the card.
    expect(msgs.at(-1)!.text).toContain('send_file: Kullanıcıya gönderildi: rapor.csv');
    expect(msgs.indexOf(card!)).toBeLessThan(msgs.length - 1);
    expect(t.engine.requests.at(-1)!.systemPrompt).toContain('send_file');
  });

  it('başka bir botla konuşurken gönderdiği dosyayı kullanıcının sohbetine koyar ve bunu bota söyler', async () => {
    const bot = await t.bot();
    const peer = await t.bot({ name: 'Paşa' });
    const botThread = await t.services.threads.peerThread(bot.id, peer.id, OWNER_ID);
    const own = join(t.dataDir, 'workspaces', 'bots', bot.id, 'files', 'Teklifler');
    mkdirSync(own, { recursive: true });
    writeFileSync(join(own, 'teklif.pdf'), '%PDF');
    const msgs = await sendFile(botThread.id, { paths: [join(own, 'teklif.pdf')], caption: 'Teklif' });
    expect(fileMessages(msgs)).toHaveLength(0);
    expect(msgs.at(-1)!.text).toContain('dosya kartı senin kullanıcıyla olan sohbetine kondu');

    const person = await main(bot.id);
    const [card] = fileMessages(await t.messages(person.id));
    expect(card!.text).toBe('Teklif');
    const [file] = card!.props.files as MessageFile[];
    expect(file).toMatchObject({ name: 'teklif.pdf', path: `bots/${bot.id}/files/Teklifler/teklif.pdf` });
    expect((await download(bot.id, file!.path)).body).toBe('%PDF');
  });

  it('kalıcı klasördeki ve grup klasöründeki dosyaları da gönderir', async () => {
    const group = (await t.api<{ id: string }>('POST', '/api/groups', { name: 'Ekip' })).body;
    const bot = await t.bot({ groupId: group.id });
    const thread = await main(bot.id);
    const own = join(t.dataDir, 'workspaces', 'bots', bot.id, 'files');
    const shared = join(t.dataDir, 'workspaces', 'groups', group.id, 'files');
    mkdirSync(own, { recursive: true });
    mkdirSync(shared, { recursive: true });
    writeFileSync(join(own, 'not.txt'), 'kalıcı');
    writeFileSync(join(shared, 'ortak.txt'), 'grup');
    const msgs = await sendFile(thread.id, { paths: [join(own, 'not.txt'), join(shared, 'ortak.txt')] });
    const files = fileMessages(msgs)[0]!.props.files as MessageFile[];
    expect(files.map((f) => f.name)).toEqual(['not.txt', 'ortak.txt']);
    expect((await download(bot.id, files[1]!.path)).body).toBe('grup');
  });

  it('proje klasöründeki dosyanın kopyasını gönderir; asıl dosya sonra değişse de gönderilen değişmez', async () => {
    const project = mkdtempSync(join(tmpdir(), 'leafbot-proje-'));
    extra.push(project);
    writeFileSync(join(project, 'cikti.txt'), 'ilk');
    const bot = await t.bot({ projectDir: project });
    const thread = await main(bot.id);
    const msgs = await sendFile(thread.id, { paths: ['cikti.txt'] });
    const [file] = fileMessages(msgs)[0]!.props.files as MessageFile[];
    expect(file!.path).toBe(`bots/${bot.id}/threads/${thread.id}/cikti.txt`);
    writeFileSync(join(project, 'cikti.txt'), 'sonra değişti');
    expect((await download(bot.id, file!.path)).body).toBe('ilk');
  });

  it('klasörlerinin dışındaki dosyayı göndermez', async () => {
    const bot = await t.bot();
    const other = await t.bot();
    const thread = await main(bot.id);
    const otherThread = await main(other.id);
    writeFileSync(join(threadDir(other.id, otherThread.id), 'gizli.txt'), 'başkasının');
    const outside = mkdtempSync(join(tmpdir(), 'leafbot-dis-'));
    extra.push(outside);
    writeFileSync(join(outside, 'dis.txt'), 'dış');
    // A link inside the bot's own folder that points out of it.
    symlinkSync(join(outside, 'dis.txt'), join(threadDir(bot.id, thread.id), 'baglanti.txt'));

    for (const path of [
      join(t.dataDir, 'access-key'),
      join(threadDir(other.id, otherThread.id), 'gizli.txt'),
      join(outside, 'dis.txt'),
      'baglanti.txt',
      '../../../../access-key',
      'yok.txt',
      '.',
    ]) {
      const msgs = await sendFile(thread.id, { paths: [path] });
      expect(fileMessages(msgs)).toHaveLength(0);
      expect(msgs.at(-1)!.text).toContain('send_file: Hata:');
    }
    expect(readFileSync(join(outside, 'dis.txt'), 'utf8')).toBe('dış');
  });

  it('yaptığı HTML sayfasını sohbette gösterir; HTML olmayanı göstermez, sayfa indirme olarak sunulur', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const dir = threadDir(bot.id, thread.id);
    writeFileSync(join(dir, 'grafik.html'), '<h1>Satışlar</h1><script>document.title = "çalıştı"</script>');
    writeFileSync(join(dir, 'notlar.txt'), 'düz metin');
    await t.send(thread.id, '[araç:show_page {"path":"grafik.html","title":"Aylık satışlar"}]');
    await t.services.turns.idle();
    let msgs = await t.messages(thread.id);
    const card = msgs.find((m) => m.props.page)!;
    expect(card.text).toBe('Aylık satışlar');
    expect(card.props.page).toMatchObject({ name: 'grafik.html' });
    expect(msgs.at(-1)!.text).toContain('grafik.html sohbette gösterildi');
    // The page itself never opens as a page of this site: it downloads.
    const res = await download(bot.id, (card.props.page as { path: string }).path);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
    expect(res.headers['content-type']).toBe('application/octet-stream');

    // Served to run in the frame: sandboxed, its scripts allowed, nothing fetched.
    const frame = await t.app.inject({
      method: 'GET',
      url: `/api/bots/${bot.id}/library/page?path=${encodeURIComponent((card.props.page as { path: string }).path)}`,
      headers: { ...AUTH, host: 'localhost' },
    });
    expect(frame.statusCode).toBe(200);
    const policy = String(frame.headers['content-security-policy']);
    expect(policy).toMatch(/^sandbox allow-scripts allow-forms;/);
    expect(policy).not.toContain('allow-same-origin');
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("frame-ancestors 'self'");
    expect(frame.body).toContain('<h1>Satışlar</h1>');
    const notPage = await t.app.inject({
      method: 'GET',
      url: `/api/bots/${bot.id}/library/page?path=${encodeURIComponent((card.props.page as { path: string }).path.replace('grafik.html', 'notlar.txt'))}`,
      headers: { ...AUTH, host: 'localhost' },
    });
    expect(notPage.statusCode).toBe(404);

    await t.send(thread.id, '[araç:show_page {"path":"notlar.txt"}]');
    await t.services.turns.idle();
    msgs = await t.messages(thread.id);
    expect(msgs.at(-1)!.text).toContain('Yalnızca .html ya da .jsx dosyası gösterilebilir');
  });

  it('klasörü sayfa olarak gösterir: betik, stil, resim ve veri dosyalarını taşır, taşıyamadıklarını söyler', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const dir = join(threadDir(bot.id, thread.id), 'harita');
    mkdirSync(dir);
    writeFileSync(
      join(dir, 'index.html'),
      '<head><link rel="stylesheet" href="stil.css"></head><img src="logo.png"><p id="v"></p><script src="./uygulama.js"></script>',
    );
    writeFileSync(join(dir, 'stil.css'), 'p { color: red }');
    writeFileSync(
      join(dir, 'uygulama.js'),
      'fetch("ulkeler.geojson").then((r) => r.json()).then((j) => (document.getElementById("v").textContent = j.type));',
    );
    writeFileSync(join(dir, 'logo.png'), Buffer.from('iVBORw0KGgo=', 'base64'));
    writeFileSync(join(dir, 'ulkeler.geojson'), '{"type":"FeatureCollection","features":[]}');
    writeFileSync(join(dir, '.env'), 'GIZLI=1');
    writeFileSync(join(dir, 'model.bin'), 'x');
    await t.send(thread.id, '[araç:show_page {"path":"harita","title":"Harita","height":600}]');
    await t.services.turns.idle();
    const msgs = await t.messages(thread.id);
    const reply = msgs.at(-1)!.text;
    expect(reply).toContain('index.html sohbette gösterildi');
    expect(reply).toContain('.env (gizli)');
    expect(reply).toContain('model.bin (sayfalar bu türü taşıyamaz)');
    const card = msgs.find((m) => m.props.page)!;
    expect(card.props.page).toMatchObject({ name: 'index.html', height: 600 });
    const frame = await t.app.inject({
      method: 'GET',
      url: `/api/bots/${bot.id}/library/page?path=${encodeURIComponent((card.props.page as { path: string }).path)}&h=600`,
      headers: { ...AUTH, host: 'localhost' },
    });
    expect(frame.body).toContain('<style>p { color: red }</style>');
    expect(frame.body).toContain('fetch("ulkeler.geojson")');
    expect(frame.body).toContain('src="data:image/png;base64,');
    expect(frame.body).toContain('"ulkeler.geojson":{"type":"application/geo+json"');
    expect(frame.body).not.toContain('GIZLI');
    expect(frame.body).toContain('const F=600');
  });
});
