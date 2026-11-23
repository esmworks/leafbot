import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { BotSummary, Message, MessageFile, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { safeFileName, saveUpload, sweepUploads } from '../src/uploads';
import { AUTH, testServer, type TestServer } from './helpers';

describe('dosya ekleme', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const upload = async (threadId: string, name: string, content: string | Buffer, uploadId?: string) => {
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/threads/${threadId}/files?name=${encodeURIComponent(name)}${uploadId ? `&uploadId=${uploadId}` : ''}`,
      headers: { ...AUTH, host: 'localhost', 'content-type': 'application/octet-stream' },
      payload: typeof content === 'string' ? Buffer.from(content) : content,
    });
    return { status: res.statusCode, body: res.json() as { name: string; size: number } };
  };
  const send = (threadId: string, body: { text?: string; files?: string[]; clientId?: string }) =>
    t.api<Message>('POST', `/api/threads/${threadId}/messages`, {
      clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
      ...body,
    });
  const threadDir = (botId: string, threadId: string) =>
    join(t.dataDir, 'workspaces', 'bots', botId, 'threads', threadId);
  const staging = (threadId: string) => join(t.dataDir, 'uploads', threadId);
  const waiting = (threadId: string) => readdirSync(staging(threadId)).sort();
  const cancel = (threadId: string, uploadId: string) =>
    t.app.inject({
      method: 'DELETE',
      url: `/api/threads/${threadId}/uploads/${uploadId}`,
      headers: { ...AUTH, host: 'localhost' },
    });
  const filesOf = (m: Message) => m.props.files as MessageFile[];
  const library = async (botId: string) =>
    (await t.api<{ name: string }[]>('GET', `/api/bots/${botId}/library`)).body.map((f) => f.name);

  it('ek gönderilene kadar botun klasörlerinin dışında bekler, gönderilince bota yoluyla ulaşır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const up = await upload(thread.id, 'rapor.txt', 'merhaba dosya');
    expect(up.status).toBe(200);
    expect(up.body).toEqual({ name: 'rapor.txt', size: 13 });
    const dir = threadDir(bot.id, thread.id);
    // Waiting: neither in the bot's folder nor in its library.
    expect(existsSync(join(dir, 'rapor.txt'))).toBe(false);
    expect(readFileSync(join(staging(thread.id), 'rapor.txt'), 'utf8')).toBe('merhaba dosya');
    expect(await library(bot.id)).not.toContain('rapor.txt');

    const clientId = 'sabit-ekli-mesaj';
    const sent = await send(thread.id, { text: 'şuna bak', files: ['rapor.txt'], clientId });
    expect(sent.status).toBe(201);
    const [file] = filesOf(sent.body);
    expect(file).toEqual({
      name: 'rapor.txt',
      size: 13,
      path: `bots/${bot.id}/threads/${thread.id}/rapor.txt`,
    });
    expect(readFileSync(join(dir, 'rapor.txt'), 'utf8')).toBe('merhaba dosya');
    expect(existsSync(join(staging(thread.id), 'rapor.txt'))).toBe(false);
    await t.services.turns.idle();
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt.startsWith('şuna bak\n\n')).toBe(true);
    expect(prompt).toContain(join(dir, 'rapor.txt'));

    // Sending again with the same id gives the same message, though its files have moved.
    const again = await send(thread.id, { text: 'şuna bak', files: ['rapor.txt'], clientId });
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(sent.body.id);

    // The library serves the file by the path in the message.
    const dl = await t.app.inject({
      method: 'GET',
      url: `/api/bots/${bot.id}/library/file?path=${encodeURIComponent(file!.path)}`,
      headers: { ...AUTH, host: 'localhost' },
    });
    expect(dl.statusCode).toBe(200);
    expect(dl.body).toBe('merhaba dosya');
  });

  it('sohbet klasöründe aynı adda dosya varsa onu korur, ek yeni ad alır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const dir = threadDir(bot.id, thread.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'rapor.txt'), 'botun dosyası');
    await upload(thread.id, 'rapor.txt', 'yeni');
    const sent = await send(thread.id, { files: ['rapor.txt'] });
    expect(filesOf(sent.body)[0]!.name).toBe('rapor (2).txt');
    expect(readFileSync(join(dir, 'rapor.txt'), 'utf8')).toBe('botun dosyası');
    expect(readFileSync(join(dir, 'rapor (2).txt'), 'utf8')).toBe('yeni');
  });

  it('yalnızca dosyalı mesaj: başlık ve önizleme dosya adından', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await upload(thread.id, 'foto.png', 'png');
    expect((await send(thread.id, { files: ['foto.png'] })).status).toBe(201);
    await t.services.turns.idle();
    expect((await t.api<Thread>('GET', `/api/threads/${thread.id}`)).body.title).toBe('foto.png');
    expect(t.engine.requests.at(-1)!.prompt.startsWith('Kullanıcı bu mesaja dosya ekledi')).toBe(true);
    const first = (await t.messages(thread.id))[0]!;
    expect(first.text).toBe('');
    // A conversation whose latest message has only files is previewed by their names.
    const other = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    await t.services.threads.addMessage({
      threadId: other.id,
      role: 'user',
      author: 'user',
      text: '',
      props: { files: [{ name: 'a.pdf' }, { name: 'b.png' }] },
    });
    expect((await t.api<Thread>('GET', `/api/threads/${other.id}`)).body.preview).toBe('a.pdf, b.png');
    const summary = (await t.api<BotSummary[]>('GET', '/api/summaries')).body.find((s) => s.botId === bot.id);
    expect(summary?.preview).toBe('a.pdf, b.png');
  });

  it('resimler, PDF, ses ve video sayfada gösterilir; SVG korumalı, gerisi indirilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const get = async (name: string) => {
      await upload(thread.id, name, 'x');
      const path = filesOf((await send(thread.id, { files: [name] })).body)[0]!.path;
      return t.app.inject({
        method: 'GET',
        url: `/api/bots/${bot.id}/library/file?path=${encodeURIComponent(path)}&inline=1`,
        headers: { ...AUTH, host: 'localhost' },
      });
    };
    const png = await get('a.png');
    expect(png.headers['content-type']).toBe('image/png');
    expect(png.headers['content-disposition']).toMatch(/^inline;/);
    const pdf = await get('rapor.pdf');
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.headers['content-disposition']).toMatch(/^inline;/);
    expect(pdf.headers['x-content-type-options']).toBe('nosniff');
    const html = await get('c.html');
    expect(html.headers['content-type']).toBe('application/octet-stream');
    expect(html.headers['content-disposition']).toMatch(/^attachment;/);
    expect(html.headers['x-content-type-options']).toBe('nosniff');
    // An SVG shows as a picture, sandboxed: opened on its own it runs no script and loads nothing.
    const svg = await get('b.svg');
    expect(svg.headers['content-type']).toBe('image/svg+xml');
    expect(svg.headers['content-security-policy']).toMatch(/^sandbox; default-src 'none'/);
    const song = await get('kayit.mp3');
    expect(song.headers['content-type']).toBe('audio/mpeg');
    expect(song.headers['content-disposition']).toMatch(/^inline;/);
    expect(song.headers['accept-ranges']).toBe('bytes');
  });

  it('bir mesajın dosyaları tek ZIP olarak indirilir; klasör dışı yol reddedilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    for (const n of ['a.txt', 'b.txt', 'c.txt']) await upload(thread.id, n, `içerik ${n}`);
    const files = filesOf((await send(thread.id, { files: ['a.txt', 'b.txt', 'c.txt'] })).body);
    const qs = files.map((f) => `path=${encodeURIComponent(f.path)}`).join('&');
    const r = await t.app.inject({
      method: 'GET',
      url: `/api/bots/${bot.id}/library/zip?${qs}&name=dosyalar`,
      headers: { ...AUTH, host: 'localhost' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/zip');
    expect(r.headers['content-disposition']).toContain('dosyalar.zip');
    expect(r.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(r.rawPayload.includes(Buffer.from('b.txt'))).toBe(true);
    const out = await t.app.inject({
      method: 'GET',
      url: `/api/bots/${bot.id}/library/zip?path=${encodeURIComponent('../../../etc/passwd')}`,
      headers: { ...AUTH, host: 'localhost' },
    });
    expect([403, 404]).toContain(out.statusCode);
  });

  it('oynatıcı dosyanın bir parçasını isteyebilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await upload(thread.id, 'klip.mp4', '0123456789');
    const path = filesOf((await send(thread.id, { files: ['klip.mp4'] })).body)[0]!.path;
    const part = (range: string) =>
      t.app.inject({
        method: 'GET',
        url: `/api/bots/${bot.id}/library/file?path=${encodeURIComponent(path)}&inline=1`,
        headers: { ...AUTH, host: 'localhost', range },
      });
    const mid = await part('bytes=2-5');
    expect(mid.statusCode).toBe(206);
    expect(mid.headers['content-range']).toBe('bytes 2-5/10');
    expect(mid.body).toBe('2345');
    expect((await part('bytes=-3')).body).toBe('789');
    expect((await part('bytes=7-')).body).toBe('789');
    const whole = await part('bytes=20-30');
    expect(whole.statusCode).toBe(200);
    expect(whole.body).toBe('0123456789');
  });

  it('genel istek sınırından (5 MB) büyük dosyayı da alır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const big = Buffer.alloc(6 * 1024 * 1024, 1);
    const up = await upload(thread.id, 'buyuk.bin', big);
    expect(up.status).toBe(200);
    expect(up.body.size).toBe(big.length);
  });

  it('bekleyen ekler aynı adın üzerine yazmaz, klasör dışına çıkamaz', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    expect((await upload(thread.id, 'a.txt', '1')).body.name).toBe('a.txt');
    expect((await upload(thread.id, 'a.txt', '2')).body.name).toBe('a (2).txt');
    const escaped = await upload(thread.id, '../../../kacis.txt', '3');
    expect(escaped.body.name).toBe('kacis.txt');
    expect(readdirSync(staging(thread.id)).sort()).toEqual(['a (2).txt', 'a.txt', 'kacis.txt']);
    expect(readFileSync(join(staging(thread.id), 'a.txt'), 'utf8')).toBe('1');
  });

  it('aynı yükleme kimliğiyle gelen tekrar ikinci bir dosya bırakmaz', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    // The first try was saved but its answer was lost; the app sends the same file again.
    expect((await upload(thread.id, 'rapor.pdf', 'aynı', 'yukleme-1')).body).toEqual({
      name: 'rapor.pdf',
      size: 5,
    });
    expect((await upload(thread.id, 'rapor.pdf', 'aynı', 'yukleme-1')).body.name).toBe('rapor.pdf');
    expect(waiting(thread.id)).toEqual(['rapor.pdf']);
    // Other bytes under the same id, or another file with the same name, keep their own copy.
    expect((await upload(thread.id, 'rapor.pdf', 'farklı', 'yukleme-1')).body.name).toBe('rapor (2).pdf');
    expect((await upload(thread.id, 'rapor.pdf', 'aynı', 'yukleme-2')).body.name).toBe('rapor (3).pdf');
    expect((await upload(thread.id, 'rapor.pdf', 'aynı')).body.name).toBe('rapor (4).pdf');
    // A bad id is refused before anything is written.
    expect((await upload(thread.id, 'rapor.pdf', 'aynı', 'a/b')).status).toBe(400);
    expect(waiting(thread.id)).toHaveLength(4);
  });

  it('gönderilmiş ekin tekrarı yeni bir bekleyen dosya olur', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await upload(thread.id, 'not.txt', 'x', 'yukleme-3');
    expect((await send(thread.id, { text: 'al', files: ['not.txt'] })).status).toBe(201);
    expect((await upload(thread.id, 'not.txt', 'x', 'yukleme-3')).body.name).toBe('not.txt');
    expect(waiting(thread.id)).toEqual(['not.txt']);
    // Another file waiting under that name, same size, other bytes: the repeat keeps its own copy.
    await t.app.inject({
      method: 'DELETE',
      url: `/api/threads/${thread.id}/files/not.txt`,
      headers: { ...AUTH, host: 'localhost' },
    });
    await upload(thread.id, 'kayit.txt', 'a', 'yukleme-4');
    expect((await send(thread.id, { text: 'al', files: ['kayit.txt'] })).status).toBe(201);
    await upload(thread.id, 'kayit.txt', 'b');
    expect((await upload(thread.id, 'kayit.txt', 'a', 'yukleme-4')).body.name).toBe('kayit (2).txt');
  });

  it('yükleme kimliğinin kaydı diskte, bekleyen dosyaların yanında durur; sunucu yeniden başlasa da tekrar tanınır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await upload(thread.id, 'sozlesme.pdf', 'imza', 'yukleme-5');
    // The staging folder holds only the waiting file; the record is in its own folder.
    expect(readdirSync(staging(thread.id))).toEqual(['sozlesme.pdf']);
    expect(readdirSync(join(t.dataDir, 'upload-ids', thread.id))).toEqual(['yukleme-5.json']);
    // Nothing of the first try is kept in memory: a fresh process reads the same record.
    const { saveStagedUpload } = await import('../src/uploads');
    const again = await saveStagedUpload(
      t.dataDir,
      thread.id,
      'sozlesme.pdf',
      Readable.from([Buffer.from('imza')]),
      'yukleme-5',
    );
    expect(again.name).toBe('sozlesme.pdf');
    expect(readdirSync(staging(thread.id))).toEqual(['sozlesme.pdf']);
  });

  it('kayıt yazılıp dosya bekleme klasörüne konmadan durulursa tekrar yeni dosya olur', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    // A record left by a server stopped before the file appeared: it names a file that is not there.
    const ids = join(t.dataDir, 'upload-ids', thread.id);
    mkdirSync(ids, { recursive: true });
    writeFileSync(join(ids, 'yukleme-9.json'), JSON.stringify({ name: 'yarim.txt', size: 1, hash: 'x' }));
    expect((await upload(thread.id, 'yarim.txt', 'y', 'yukleme-9')).body.name).toBe('yarim.txt');
    expect(readFileSync(join(staging(thread.id), 'yarim.txt'), 'utf8')).toBe('y');
  });

  it('yüklenirken kaldırılan ek, yüklemesi önce de sonra da bitse silinir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    // Got through, only the answer was lost: the cancel removes it.
    await upload(thread.id, 'once.txt', 'a', 'yukleme-6');
    expect((await cancel(thread.id, 'yukleme-6')).statusCode).toBe(200);
    // Still on its way when the cancel came: removed as soon as it is saved.
    expect((await cancel(thread.id, 'yukleme-7')).statusCode).toBe(200);
    expect((await upload(thread.id, 'sonra.txt', 'b', 'yukleme-7')).status).toBe(404);
    // Another file with the same name is not touched by a cancel.
    await upload(thread.id, 'once.txt', 'baska', 'yukleme-8');
    await cancel(thread.id, 'yukleme-6');
    expect(waiting(thread.id)).toEqual(['once.txt']);
    expect(readFileSync(join(staging(thread.id), 'once.txt'), 'utf8')).toBe('baska');
    expect((await cancel(thread.id, 'a/b')).statusCode).toBe(404);
  });

  it('olmayan ya da klasör dışını gösteren eki reddeder', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    expect((await send(thread.id, { text: 'x', files: ['yok.txt'] })).status).toBe(404);
    expect((await send(thread.id, { text: 'x', files: ['../access-key'] })).status).toBe(400);
    expect((await send(thread.id, {})).status).toBe(400);
    await t.services.turns.idle();
    expect(t.engine.requests).toHaveLength(0);
  });

  it('gönderilmeden kaldırılan ek silinir; gönderilmiş dosyaya bu yoldan ulaşılmaz', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await upload(thread.id, 'sil.txt', 'x');
    expect((await t.api('DELETE', `/api/threads/${thread.id}/files/sil.txt`)).status).toBe(200);
    expect(existsSync(join(staging(thread.id), 'sil.txt'))).toBe(false);
    expect((await t.api('DELETE', `/api/threads/${thread.id}/files/sil.txt`)).status).toBe(404);

    await upload(thread.id, 'kalsin.txt', 'x');
    await send(thread.id, { files: ['kalsin.txt'] });
    expect((await t.api('DELETE', `/api/threads/${thread.id}/files/kalsin.txt`)).status).toBe(404);
    expect(existsSync(join(threadDir(bot.id, thread.id), 'kalsin.txt'))).toBe(true);
  });

  it('erişim anahtarı olmadan yükleme yapılamaz', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const res = await t.app.inject({
      method: 'POST',
      url: `/api/threads/${thread.id}/files?name=a.txt`,
      headers: { host: 'localhost', 'content-type': 'application/octet-stream' },
      payload: Buffer.from('x'),
    });
    expect(res.statusCode).toBe(401);
  });

  it('silinen sohbetin klasörü ve bekleyen ekleri de silinir', async () => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    await upload(thread.id, 'bekleyen.txt', 'x');
    const dir = threadDir(bot.id, thread.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'cikti.txt'), 'y');
    expect((await t.api('DELETE', `/api/threads/${thread.id}`)).status).toBe(200);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(staging(thread.id))).toBe(false);
  });
});

describe('saveUpload', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'leafbot-upload-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('sınırı aşan dosyayı keser ve yarım dosyayı bırakmaz', async () => {
    await expect(
      saveUpload(dir, 'buyuk.bin', Readable.from([Buffer.alloc(8), Buffer.alloc(8)]), 10),
    ).rejects.toMatchObject({ status: 413 });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('boş dosyayı 400 ile reddeder ve geride dosya bırakmaz', async () => {
    await expect(saveUpload(dir, 'bos.txt', Readable.from([]))).rejects.toMatchObject({
      status: 400,
      key: 'error.fileEmpty',
    });
    await expect(saveUpload(dir, 'bos.txt', Readable.from([Buffer.alloc(0)]))).rejects.toMatchObject({
      status: 400,
    });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('dosya adını temizler', () => {
    expect(safeFileName('C:\\Users\\x\\belge.pdf')).toBe('belge.pdf');
    expect(safeFileName('.gizli')).toBe('gizli');
    expect(safeFileName('a\u0000b\nc.txt')).toBe('abc.txt');
    expect(safeFileName('..')).toBe('file');
    expect(safeFileName(`${'x'.repeat(300)}.docx`)).toHaveLength(120);
  });

  it('süresi geçen bekleyen ekleri ve boşalan klasörleri siler, yenilere dokunmaz', async () => {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const a = join(dir, 'uploads', 'sohbet-a');
    const b = join(dir, 'uploads', 'sohbet-b');
    mkdirSync(a, { recursive: true });
    mkdirSync(b, { recursive: true });
    for (const [file, ageMs] of [
      [join(a, 'eski.txt'), 2 * day],
      [join(b, 'eski.txt'), 2 * day],
      [join(b, 'yeni.txt'), 60_000],
    ] as const) {
      writeFileSync(file, 'x');
      const at = new Date(now - ageMs);
      utimesSync(file, at, at);
    }
    // The upload ids' records, and bytes a stopped server left half-way, go by the same age.
    const ids = join(dir, 'upload-ids', 'sohbet-b');
    mkdirSync(ids, { recursive: true });
    for (const [file, ageMs] of [
      [join(ids, 'eski.json'), 2 * day],
      [join(ids, 'eski.part'), 2 * day],
      [join(ids, 'yeni.json'), 60_000],
    ] as const) {
      writeFileSync(file, '{}');
      const at = new Date(now - ageMs);
      utimesSync(file, at, at);
    }
    expect(await sweepUploads(dir, day, now)).toBe(2);
    expect(existsSync(a)).toBe(false);
    expect(readdirSync(b)).toEqual(['yeni.txt']);
    expect(readdirSync(ids)).toEqual(['yeni.json']);
    // Nothing staged yet: nothing to do.
    expect(await sweepUploads(join(dir, 'yok'), day, now)).toBe(0);
  });
});
