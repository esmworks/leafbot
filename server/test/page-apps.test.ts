import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PageApp, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTH, testServer, type TestServer } from './helpers';

describe('sayfayı uygulama olarak kaydetme', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(async () => {
    await t.dispose();
  });

  /** A page in the bot's main conversation folder, by its library path. */
  const page = async () => {
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const dir = join(t.dataDir, 'workspaces', 'bots', bot.id, 'threads', thread.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'takip.html'), '<h1>Harcama takibi</h1>');
    writeFileSync(join(dir, 'notlar.txt'), 'düz metin');
    return { bot, thread, dir, path: `bots/${bot.id}/threads/${thread.id}/takip.html` };
  };
  const open = (url: string) => t.app.inject({ method: 'GET', url, headers: { host: 'localhost', ...AUTH } });

  it('kaydedilen sayfa sohbet dışında, yalıtılmış ve güncel haliyle açılır', async () => {
    const { bot, thread, dir, path } = await page();
    const saved = await t.api<PageApp>('POST', `/api/bots/${bot.id}/library/app`, {
      path,
      name: 'Harcamalar',
      threadId: thread.id,
    });
    expect(saved.status).toBe(200);
    // The id goes into leafbot://app/<id> links and launcher files.
    expect(saved.body.id).toMatch(/^[\w-]{8,64}$/);
    expect(saved.body.threadId).toBe(thread.id);
    // Saving the same page again gives the same app.
    const again = await t.api<PageApp>('POST', `/api/bots/${bot.id}/library/app`, { path, name: 'x' });
    expect(again.body.id).toBe(saved.body.id);
    const found = await t.api<{ app: PageApp | null }>(
      'GET',
      `/api/bots/${bot.id}/library/app?path=${encodeURIComponent(path)}`,
    );
    expect(found.body.app?.id).toBe(saved.body.id);

    const res = await open(`/api/page-apps/${saved.body.id}/page`);
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h1>Harcama takibi</h1>');
    expect(res.body).toContain('<title>Harcamalar</title>');
    const policy = String(res.headers['content-security-policy']);
    expect(policy).toMatch(/^sandbox allow-scripts allow-forms;/);
    expect(policy).not.toContain('allow-same-origin');
    expect(policy).toContain("connect-src 'none'");

    // The app is the page as the bot last wrote it.
    writeFileSync(join(dir, 'takip.html'), '<h1>Yeni</h1>');
    expect((await open(`/api/page-apps/${saved.body.id}/page`)).body).toContain('<h1>Yeni</h1>');

    const renamed = await t.api<PageApp>('PATCH', `/api/page-apps/${saved.body.id}`, { name: 'Bütçe' });
    expect(renamed.body.name).toBe('Bütçe');
    expect((await t.api<PageApp[]>('GET', '/api/page-apps')).body.map((a) => a.name)).toEqual(['Bütçe']);

    expect(
      (await t.api<{ available: boolean }>('GET', `/api/page-apps/${saved.body.id}`)).body.available,
    ).toBe(true);
    // A page deleted since it was saved: the app says it is gone.
    rmSync(join(dir, 'takip.html'));
    expect((await open(`/api/page-apps/${saved.body.id}/page`)).statusCode).toBe(404);
    expect(
      (await t.api<{ available: boolean }>('GET', `/api/page-apps/${saved.body.id}`)).body.available,
    ).toBe(false);

    expect((await t.api('DELETE', `/api/page-apps/${saved.body.id}`)).status).toBe(200);
    expect((await t.api<PageApp[]>('GET', '/api/page-apps')).body).toEqual([]);
  });

  it('yalnızca HTML sayfası kaydedilir, bot klasörü dışından hiçbir şey kaydedilmez', async () => {
    const { bot, path } = await page();
    const txt = await t.api('POST', `/api/bots/${bot.id}/library/app`, {
      path: path.replace('takip.html', 'notlar.txt'),
      name: 'N',
    });
    expect(txt.status).toBe(400);
    const outside = await t.api('POST', `/api/bots/${bot.id}/library/app`, {
      path: '../../etc/passwd',
      name: 'E',
    });
    expect(outside.status).toBeGreaterThanOrEqual(400);
  });

  it('herkes kendi uygulamalarını görür; başkasınınkini açamaz, değiştiremez, silemez', async () => {
    const { bot, path } = await page();
    const { body: mine } = await t.api<PageApp>('POST', `/api/bots/${bot.id}/library/app`, {
      path,
      name: 'Benim',
    });
    const other = await t.person('ayse');
    expect((await other.api<PageApp[]>('GET', '/api/page-apps')).body).toEqual([]);
    expect((await other.api('GET', `/api/page-apps/${mine.id}`)).status).toBe(404);
    expect((await other.api('GET', `/api/page-apps/${mine.id}/page`)).status).toBe(404);
    expect((await other.api('PATCH', `/api/page-apps/${mine.id}`, { name: 'Onun' })).status).toBe(404);
    await other.api('DELETE', `/api/page-apps/${mine.id}`);
    expect((await t.api<PageApp[]>('GET', '/api/page-apps')).body.map((a) => a.name)).toEqual(['Benim']);
    // A page in a conversation that is not theirs does not become their app either.
    const theirs = await other.api('POST', `/api/bots/${bot.id}/library/app`, { path, name: 'Al' });
    expect(theirs.status).toBeGreaterThanOrEqual(400);
  });

  it('oturum olmadan uygulamalar açılmaz', async () => {
    const { bot, path } = await page();
    const { body } = await t.api<PageApp>('POST', `/api/bots/${bot.id}/library/app`, { path, name: 'A' });
    for (const url of ['/api/page-apps', `/api/page-apps/${body.id}/page`]) {
      const res = await t.app.inject({ method: 'GET', url, headers: { host: 'localhost' } });
      expect(res.statusCode).toBe(401);
    }
  });
});
