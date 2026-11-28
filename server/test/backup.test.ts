import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, Memory } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { hashPassword } from '../src/account';
import { schema } from '../src/db';
import { BACKUP_MAGIC, replaceRows, tablesInOrder } from '../src/services/backup';
import { OWNER_ID } from '../src/users';
import { newId } from '../src/util';
import { AUTH, testServer, type TestServer } from './helpers';

const PASSWORD = 'yedek-şifresi-2026';

describe('yedek', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const download = async (password: string) => {
    const made = await t.api<{ id: string; size: number }>('POST', '/api/backup', { password });
    if (made.status !== 200) return { status: made.status, file: null };
    const res = await t.app.inject({ method: 'GET', url: `/api/backup/${made.body.id}`, headers: AUTH });
    expect(res.headers['content-disposition']).toMatch(/leafbot-backup-.*\.ybk/);
    expect(res.rawPayload.length).toBe(made.body.size);
    // One download: the file does not wait on the server once fetched.
    await new Promise((r) => setTimeout(r, 50));
    expect(
      (await t.app.inject({ method: 'GET', url: `/api/backup/${made.body.id}`, headers: AUTH })).statusCode,
    ).toBe(404);
    return { status: 200, file: res.rawPayload };
  };
  const restore = (file: Buffer, password: string) =>
    t.app.inject({
      method: 'POST',
      url: '/api/backup/restore',
      headers: {
        ...AUTH,
        'content-type': 'application/octet-stream',
        'x-backup-password': encodeURIComponent(password),
      },
      payload: file,
    });
  const botNames = async () => (await t.api<Bot[]>('GET', '/api/bots')).body.map((b) => b.name).sort();

  it('tabloları üst tablolar önce gelecek biçimde sıralar', () => {
    const order = tablesInOrder();
    expect(order.indexOf(schema.bots)).toBeLessThan(order.indexOf(schema.threads));
    expect(order.indexOf(schema.threads)).toBeLessThan(order.indexOf(schema.messages));
    expect(order.indexOf(schema.routines)).toBeLessThan(order.indexOf(schema.routineRuns));
  });

  it('her şeyi şifreli tek dosyaya yazar ve geri yükler; yanlış şifre ya da bozuk dosya hiçbir şeyi değiştirmez', async () => {
    const ali = await t.bot({ name: 'Ali' });
    await t.api('POST', '/api/memory', { scope: 'bot', botId: ali.id, content: 'Raporlar cuma' });
    const files = join(t.dataDir, 'workspaces', 'bots', ali.id, 'files');
    mkdirSync(files, { recursive: true });
    writeFileSync(join(files, 'not.txt'), 'ilk hali');

    expect((await download('kısa')).status).toBe(400);
    const { file } = await download(PASSWORD);
    expect(file!.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)).toBe(true);
    // Sealed: neither the note nor the file's text can be read in it.
    expect(file!.includes(Buffer.from('Raporlar cuma'))).toBe(false);

    // Things change after the backup.
    await t.api('PATCH', `/api/bots/${ali.id}`, { name: 'Ali Yeni' });
    await t.bot({ name: 'Veli' });
    writeFileSync(join(files, 'not.txt'), 'sonraki hali');

    const wrong = await restore(file!, 'yanlış-şifre-12345');
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json().error).toContain('Şifre yanlış');
    const damaged = Buffer.from(file!);
    damaged[damaged.length - 40]! ^= 0xff;
    expect((await restore(damaged, PASSWORD)).statusCode).toBe(400);
    expect((await restore(Buffer.from('başka bir dosya'), PASSWORD)).statusCode).toBe(400);
    expect(await botNames()).toEqual(['Ali Yeni', 'Veli']);
    expect(readFileSync(join(files, 'not.txt'), 'utf8')).toBe('sonraki hali');

    const restarted = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const ok = await restore(file!, PASSWORD);
    expect(ok.statusCode).toBe(200);
    expect(await botNames()).toEqual(['Ali']);
    expect((await t.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.content)).toEqual([
      'Raporlar cuma',
    ]);
    expect(readFileSync(join(files, 'not.txt'), 'utf8')).toBe('ilk hali');
    // What it replaced is kept beside it, to undo by hand.
    expect(existsSync(join(t.dataDir, 'workspaces.before-restore'))).toBe(true);
    // The server is asked to start again: what it holds in memory belongs to the old data.
    await vi.waitFor(() => expect(restarted).toHaveBeenCalled());
    restarted.mockRestore();
    // This sign-in still works: sign-ins to this server are not part of a backup.
    expect((await t.api('GET', '/api/bots')).status).toBe(200);
  });

  it('geri yükleme owner’ın oturumunu korur; yedekte olmayan kişinin oturumu kapanır', async () => {
    const ownerPassword = await hashPassword('owner-sifresi');
    await t.services.ctx.db
      .update(schema.users)
      .set({ username: 'erhan', usernameKey: 'erhan', password: ownerPassword })
      .where(eq(schema.users.id, OWNER_ID));
    const ownerSession = await t.auth.createSession(OWNER_ID);
    const { file } = await download(PASSWORD);
    // Someone added after the backup, signed in on a device of their own.
    await t.services.ctx.db.insert(schema.users).values({ id: 'ayse', usernameKey: 'ayse', role: 'member' });
    await t.auth.createSession('ayse');

    const restarted = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await restore(file!, PASSWORD)).statusCode).toBe(200);
    await vi.waitFor(() => expect(restarted).toHaveBeenCalled());
    restarted.mockRestore();

    const sessions = await t.services.ctx.db.select().from(schema.sessions);
    expect(sessions.map((s) => s.userId)).not.toContain('ayse');
    const later = new Date(Date.now() + 2 * 60_000);
    expect(await t.auth.validSession(ownerSession, later)).toMatchObject({ userId: OWNER_ID });
    const [owner] = await t.services.ctx.db.select().from(schema.users).where(eq(schema.users.id, OWNER_ID));
    expect(owner).toMatchObject({ username: 'erhan', password: ownerPassword });
  });

  it('kişilerden önceki bir yedeğin tek hesabı owner olur', async () => {
    const ownerSession = await t.auth.createSession(OWNER_ID);
    // What such a backup holds: no people, the single account in kv.
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-old-backup-'));
    const kv = join(dir, 'kv.json');
    writeFileSync(
      kv,
      JSON.stringify([
        { key: 'account', value: { username: 'Erhan', ...(await hashPassword('eski-sifre')) } },
      ]),
    );
    await replaceRows(t.services.ctx.db, new Map([['kv', kv]]));

    const [owner] = await t.services.ctx.db.select().from(schema.users).where(eq(schema.users.id, OWNER_ID));
    expect(owner).toMatchObject({ username: 'Erhan', role: 'owner', password: { hash: expect.any(String) } });
    expect(await t.services.ctx.db.select().from(schema.kv).where(eq(schema.kv.key, 'account'))).toEqual([]);
    const later = new Date(Date.now() + 2 * 60_000);
    expect(await t.auth.validSession(ownerSession, later)).toMatchObject({ userId: OWNER_ID });
  });

  it('kişilerden önceki bir yedeğin sohbetleri owner’ın olur, botları owner’a kalır', async () => {
    const bot = await t.bot({ name: 'Eski' });
    const thread = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    // The same rows as such a backup holds them: no person on the bot or the conversation.
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-old-backup-'));
    const write = (name: string, rows: Record<string, unknown>[]) => {
      writeFileSync(join(dir, `${name}.json`), JSON.stringify(rows));
      return join(dir, `${name}.json`);
    };
    const bots = (await t.services.ctx.db.select().from(schema.bots)).map(
      ({ ownerUserId: _o, access: _a, ...r }) => r,
    );
    const threads = (await t.services.ctx.db.select().from(schema.threads)).map(({ userId: _u, ...r }) => r);
    await replaceRows(
      t.services.ctx.db,
      new Map([
        ['bots', write('bots', bots)],
        ['threads', write('threads', threads)],
      ]),
    );
    const [restored] = await t.services.ctx.db
      .select()
      .from(schema.threads)
      .where(eq(schema.threads.id, thread.id));
    expect(restored!.userId).toBe(OWNER_ID);
    const [b] = await t.services.ctx.db.select().from(schema.bots).where(eq(schema.bots.id, bot.id));
    expect(b).toMatchObject({ ownerUserId: OWNER_ID, access: { everyone: 'none', people: {} } });
  });

  it('yeniden adlandırmadan önceki yedekte uygulamanın araçlarını yeni adıyla geri yükler', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-old-backup-'));
    const rules = join(dir, 'permission_rules.json');
    writeFileSync(
      rules,
      JSON.stringify([
        { id: 'r1', list: 'ask', pattern: 'mcp__yumakbot__run_command', note: '', createdAt: new Date() },
        { id: 'r2', list: 'allow', pattern: 'mcp__notion__search', note: '', createdAt: new Date() },
      ]),
    );
    await replaceRows(t.services.ctx.db, new Map([['permission_rules', rules]]));
    const kept = await t.services.ctx.db.select().from(schema.permissionRules);
    expect(kept.map((r) => r.pattern).sort()).toEqual(['mcp__leafbot__run_command', 'mcp__notion__search']);
  });

  it('bir bot çalışırken geri yüklemez', async () => {
    const { file } = await download(PASSWORD);
    const bot = await t.bot();
    const thread = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.services.ctx.db.insert(schema.turns).values({
      id: newId(),
      threadId: thread.id,
      botId: bot.id,
      status: 'running',
      prompt: 'x',
      source: 'user',
    });
    const busy = await restore(file!, PASSWORD);
    expect(busy.statusCode).toBe(409);
  });
});
