import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as httpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Bot, BrowserState } from '@leafbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { findBrowser } from '../src/browser/find';
import { BrowserManager } from '../src/browser/manager';
import { testServer, waitFor } from './helpers';

/** A stand-in for the browser program: it records its arguments and quits when asked. */
function fakeProgram() {
  const runs: { command: string; args: string[]; signals: string[] }[] = [];
  let last: (EventEmitter & { kill(sig?: string): boolean }) | null = null;
  const spawn = (command: string, args: string[]) => {
    const run = { command, args, signals: [] as string[] };
    runs.push(run);
    const child = Object.assign(new EventEmitter(), {
      kill(sig = 'SIGTERM') {
        run.signals.push(sig);
        setTimeout(() => child.emit('exit', null, sig), 5);
        return true;
      },
    });
    last = child;
    return child as unknown as ChildProcess;
  };
  return { runs, spawn, quit: () => last!.emit('exit', 0, null) };
}

const managerWith = (over: Partial<ConstructorParameters<typeof BrowserManager>[0]> = {}) =>
  new BrowserManager({
    executable: '/Applications/Tarayici',
    profileDir: (id) => `/veri/browsers/${id}`,
    sandbox: true,
    max: 2,
    idleMs: 60_000,
    windows: true,
    ...over,
  });

describe('botun tarayıcısı ayrı pencerede', () => {
  it('botun profiliyle, sunucuya bağlı olmadan açılır; açıkken bot bekler, kapanınca yeniden kullanabilir', async () => {
    const program = fakeProgram();
    const m = managerWith({ spawn: program.spawn });
    const states: BrowserState[] = [];
    m.on({ state: (s) => states.push(s), frame: () => {} });

    await m.openWindow('b1', 'accounts.example.com/giris');
    expect(program.runs).toHaveLength(1);
    const { command, args } = program.runs[0]!;
    expect(command).toBe('/Applications/Tarayici');
    expect(args).toContain('--user-data-dir=/veri/browsers/b1');
    // The same cookie settings the bot's own browser uses, or it could not read them back.
    expect(args).toEqual(expect.arrayContaining(['--password-store=basic', '--use-mock-keychain']));
    expect(args.at(-1)).toBe('https://accounts.example.com/giris');
    for (const a of args) expect(a).not.toMatch(/remote-debugging|enable-automation/);
    expect(m.state('b1').status).toBe('window');
    expect(states.at(-1)?.status).toBe('window');

    // The bot's steps wait while the window is open: a stopped turn ends the wait, refused. A
    // person taking control is refused.
    await expect(m.use('b1', async () => 'x', AbortSignal.abort())).rejects.toMatchObject({
      code: 'userControl',
    });
    await expect(m.setControl('b1', true)).rejects.toMatchObject({ code: 'userControl' });

    // Opening it again does not start a second program.
    await m.openWindow('b1');
    expect(program.runs).toHaveLength(1);

    await m.closeWindow('b1');
    // Asked to quit as from its menu, which saves the cookies; SIGTERM would lose the newest.
    expect(program.runs[0]!.signals).toEqual(['SIGINT']);
    expect(m.state('b1').status).toBe('off');
    expect(states.at(-1)?.status).toBe('off');
  });

  it('kişi tarayıcıyı kendisi kapatınca bot serbest kalır', async () => {
    const program = fakeProgram();
    const m = managerWith({ spawn: program.spawn });
    await m.openWindow('b1');
    program.quit();
    await waitFor(async () => m.state('b1').status === 'off');
    // A second window may open after the first one closed.
    await m.openWindow('b1');
    expect(program.runs).toHaveLength(2);
    await m.shutdown();
    expect(program.runs[1]!.signals).toEqual(['SIGINT']);
  });

  it('başka yerde çalışan tarayıcıda ya da uzak sunucuda açılmaz; yalnızca web adresi alır', async () => {
    const program = fakeProgram();
    await expect(
      managerWith({ windows: false, spawn: program.spawn }).openWindow('b1'),
    ).rejects.toMatchObject({ code: 'unavailable' });
    const remote = managerWith({
      spawn: program.spawn,
      connect: async () => ({ url: 'ws://masaustu', proxied: false }),
    });
    expect(remote.windowAvailable).toBe(false);
    await expect(remote.openWindow('b1')).rejects.toMatchObject({ code: 'unavailable' });
    await expect(
      managerWith({ spawn: program.spawn }).openWindow('b1', 'file:///etc/passwd'),
    ).rejects.toMatchObject({
      code: 'badUrl',
    });
    expect(program.runs).toHaveLength(0);
  });

  it('API, sunucu kişinin bilgisayarında değilse pencereyi açmaz ve bunu bildirir', async () => {
    const t = await testServer();
    try {
      const bot = (await t.api<Bot>('POST', '/api/bots', { name: 'Gezgin' })).body;
      const info = (await t.api<{ browser: { window?: boolean } }>('GET', '/api/info')).body;
      expect(info.browser.window).toBeUndefined();
      const r = await t.api<{ error: string }>('POST', `/api/bots/${bot.id}/browser/window`, {});
      expect(r.status).toBe(409);
      expect(r.body.error).toMatch(/bilgisayarda|computer/);
      expect((await t.api('DELETE', `/api/bots/${bot.id}/browser/window`)).status).toBe(200);
    } finally {
      await t.dispose();
    }
  });
});

const BROWSER = process.env.LEAFBOT_TEST_BROWSER ?? findBrowser();

describe.skipIf(!BROWSER)('ayrı pencereden bota geçen oturum', () => {
  let dir: string | null = null;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it('pencerede alınan çerezi bot kendi tarayıcısında okur', async () => {
    dir = mkdtempSync(join(tmpdir(), 'leafbot-pencere-'));
    let visits = 0;
    const site = httpServer((req, res) => {
      visits++;
      res.setHeader('set-cookie', 'oturum=acik; Max-Age=86400; Path=/; HttpOnly');
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end('<title>Giriş tamam</title>');
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
    const m = managerWith({
      executable: BROWSER!,
      profileDir: (id) => join(dir!, id),
      sandbox: process.getuid?.() !== 0,
      // The real program with the real arguments, only without a window on the test machine's screen.
      spawn: (command, args) =>
        spawn(command, ['--headless=new', ...(process.getuid?.() === 0 ? ['--no-sandbox'] : []), ...args], {
          stdio: 'ignore',
        }),
    });
    try {
      await m.openWindow('b1', `${base}/giris`);
      await waitFor(async () => visits > 0, 30_000);
      await m.closeWindow('b1');
      const cookies = await m.use('b1', (page) => page.context().cookies(base));
      expect(cookies.find((c) => c.name === 'oturum')?.value).toBe('acik');
    } finally {
      await m.shutdown();
      await new Promise<void>((r) => site.close(() => r()));
    }
  }, 60_000);
});
