import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import {
  createServer as httpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { Approval, ComputerState, DesktopStart, ServerInfo, Thread } from '@leafbot/shared';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { desc, eq } from 'drizzle-orm';
import { RfbClientFilter } from '../src/computer/rfb-filter';
import { schema } from '../src/db';
import type { AppTool } from '../src/engine/types';
import { KEY, testServer, waitFor, type TestServer } from './helpers';

const TOKEN = 'computer-test-token-0123456789abcdef';
/** A 1x1 PNG. */
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const key = (down: boolean) => Buffer.from([4, down ? 1 : 0, 0, 0, 0, 0, 0, 0x61]);
const handshake = () => Buffer.concat([Buffer.from('RFB 003.008\n'), Buffer.from([1, 1])]);

describe('ekran akışı süzgeci', () => {
  it('el sıkışmayı geçirir; denetim yokken klavye, fare ve panoyu düşürür', () => {
    let control = false;
    const f = new RfbClientFilter(() => control);
    const update = Buffer.from([3, 0, 0, 0, 0, 0, 5, 0, 3, 32]);
    const r1 = f.push(Buffer.concat([handshake(), key(true), update, Buffer.from([5, 1, 0, 1, 0, 2])]));
    expect('out' in r1 && r1.out).toEqual(Buffer.concat([handshake(), update]));

    control = true;
    const r2 = f.push(key(true));
    expect('out' in r2 && r2.out).toEqual(key(true));
  });

  it('parçalı gelen iletileri birleştirir; boyut değişikliğini düşürür, bilinmeyeni reddeder', () => {
    const f = new RfbClientFilter(() => true);
    f.push(handshake());
    const k = key(true);
    expect(f.push(k.subarray(0, 3))).toEqual({ out: Buffer.alloc(0) });
    expect(f.push(k.subarray(3))).toEqual({ out: k });
    // SetDesktopSize with one screen: 8 + 16 bytes.
    const resize = Buffer.alloc(24);
    resize[0] = 251;
    resize[6] = 1;
    expect(f.push(resize)).toEqual({ out: Buffer.alloc(0) });
    expect(f.push(Buffer.from([99, 0, 0]))).toHaveProperty('error');
  });

  it('genişletilmiş tuş ve fare iletilerini tanır; denetim yokken onları da düşürür', () => {
    let control = false;
    const f = new RfbClientFilter(() => control);
    f.push(handshake());
    const qemuKey = Buffer.from([255, 0, 0, 1, 0, 0, 0, 0x61, 0, 0, 0, 0x1e]);
    const extPointer = Buffer.from([5, 0x81, 0, 1, 0, 2, 1]);
    expect(f.push(Buffer.concat([qemuKey, extPointer]))).toEqual({ out: Buffer.alloc(0) });
    control = true;
    expect(f.push(Buffer.concat([qemuKey, extPointer]))).toEqual({
      out: Buffer.concat([qemuKey, extPointer]),
    });
    expect(f.push(Buffer.from([255, 1, 0, 0]))).toHaveProperty('error');
  });

  it('çok büyük pano metnini reddeder', () => {
    const f = new RfbClientFilter(() => true);
    f.push(handshake());
    const head = Buffer.alloc(8);
    head[0] = 6;
    head.writeInt32BE(-(2 << 20), 4);
    expect(f.push(head)).toHaveProperty('error');
  });
});

/** A stand-in for the computer service: records what the server asks of it. */
class FakeComputer {
  failStart: string | null = null;
  /** Desktops that may run at once, like the real service's limit. */
  max = Infinity;
  server: Server;
  wss = new WebSocketServer({ noServer: true });
  url = '';
  status = new Map<string, 'off' | 'running'>();
  starts: { id: string; body: DesktopStart }[] = [];
  calls: { id: string; op: string; body: Record<string, unknown> }[] = [];
  /** Bytes the desktop's screen server received from viewers. */
  received: Buffer[] = [];
  screens: WsSocket[] = [];

  constructor() {
    this.server = httpServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, sock, head) => {
      const u = new URL(req.url ?? '/', 'http://x');
      if (u.searchParams.get('token') !== TOKEN || !u.pathname.endsWith('/vnc')) return sock.destroy();
      this.wss.handleUpgrade(req, sock, head, (ws) => {
        this.screens.push(ws);
        ws.on('message', (d: Buffer) => this.received.push(Buffer.from(d)));
        ws.send(Buffer.from('RFB 003.008\n'));
      });
    });
  }

  async listen() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  close() {
    for (const ws of this.screens) ws.terminate();
    this.wss.close();
    return new Promise<void>((r) => this.server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.headers.authorization !== `Bearer ${TOKEN}`)
      return send(401, { error: 'no', code: 'unauthorized' });
    let raw = '';
    for await (const c of req) raw += String(c);
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, unknown>;
    if (req.url === '/health') return send(200, { ok: true });
    if (req.url === '/desktops') {
      return send(
        200,
        [...this.status].map(([id, status]) => ({ id, status, startedAt: null, browserProxied: false })),
      );
    }
    const m = /^\/desktops\/([\w-]+)(?:\/([\w-]+))?$/.exec(req.url ?? '');
    if (!m) return send(404, { error: 'not found', code: 'badRequest' });
    const [, id, op] = m as unknown as [string, string, string | undefined];
    const state = () => ({
      id,
      status: this.status.get(id) ?? 'off',
      startedAt: null,
      browserProxied: false,
    });
    if (!op) return send(200, state());
    if (op === 'start') {
      this.starts.push({ id, body: body as unknown as DesktopStart });
      // A start the sandbox refuses: the desktop stays off and says why.
      if (this.failStart) return send(200, { ...state(), lastError: this.failStart });
      const running = [...this.status].filter(([other, s]) => other !== id && s === 'running').length;
      if (running >= this.max) return send(409, { error: 'full', code: 'full' });
      this.status.set(id, 'running');
      return send(200, state());
    }
    if (op === 'stop') {
      this.status.set(id, 'off');
      return send(200, state());
    }
    if (this.status.get(id) !== 'running') return send(409, { error: 'not running', code: 'notRunning' });
    this.calls.push({ id, op, body });
    if (op === 'git') return send(200, {});
    if (op === 'screenshot') return send(200, { png: PNG, width: 1280, height: 800 });
    if (op === 'action') return send(200, { ok: true });
    if (op === 'exec') {
      return send(200, {
        exitCode: 0,
        output: `çalıştı: ${String(body.command)}`,
        truncated: false,
        timedOut: false,
      });
    }
    if (op === 'jobs-start') {
      return send(200, { id: 'j1', running: true, exitCode: null, output: '', truncated: false, seconds: 0 });
    }
    if (op === 'jobs-status') {
      return send(200, {
        id: 'j1',
        running: false,
        exitCode: 0,
        output: 'derleme bitti',
        truncated: false,
        seconds: 900,
      });
    }
    send(404, { error: 'unknown', code: 'badRequest' });
  }
}

describe('botun bilgisayarı', () => {
  let fake: FakeComputer;
  let t: TestServer;

  beforeAll(async () => {
    fake = new FakeComputer();
    await fake.listen();
  });
  afterAll(() => fake.close());

  beforeEach(async () => {
    fake.status.clear();
    fake.starts = [];
    fake.calls = [];
    fake.received = [];
    fake.failStart = null;
    fake.max = Infinity;
    t = await testServer({ computer: { url: fake.url, token: TOKEN }, computerIdleMs: 60_000 });
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const tool = (name: string): AppTool => t.engine.requests.at(-1)!.tools.find((x) => x.name === name)!;
  const text = async (name: string, args: Record<string, unknown>) => {
    const r = await tool(name).handler(args);
    return typeof r === 'string' ? r : r.text;
  };

  it('ekrana kartsız bakar; masaüstünü botun klasörleriyle açar ve sunucu kabuğunu kapatır', async () => {
    const info = await waitFor(async () => {
      const r = (await t.api<ServerInfo>('GET', '/api/info')).body;
      return r.computer.status === 'ok' && r;
    });
    expect(info.computer.detail).toBe(fake.url);

    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:computer_screenshot]');
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('[1 görüntü]');
    expect(t.engine.requests.at(-1)!.shell).toBe('computer');

    const root = join(t.dataDir, 'workspaces');
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]!.body).toMatchObject({
      internet: true,
      home: join(root, 'bots', bot.id, 'home'),
      workdir: join(root, 'bots', bot.id, 'files'),
    });
    expect(t.services.ctx.computer!.state(bot.id)).toMatchObject({ status: 'running', busy: false });

    // Clicking returns a fresh look at the screen; a click marked as sending asks first.
    const click = await tool('computer_click').handler({ x: 10, y: 20, button: 'left', count: 1 });
    expect(typeof click !== 'string' && click.images).toHaveLength(1);
    expect(fake.calls.find((c) => c.op === 'action')!.body).toMatchObject({ type: 'click', x: 10, y: 20 });
    expect(await tool('computer_click').gated!({ x: 1, y: 1, sends: true })).toBe(true);
    expect(await tool('computer_click').gated!({ x: 1, y: 1 })).toBe(false);
  });

  it('komutu Bash kartıyla sorar ve konuşmanın klasöründe çalıştırır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    // A plain read of its own folder needs no card; reaching another host asks.
    await t.send(thread.id, '[araç:run_command {"command":"curl -s https://ornek.test"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(card.toolName).toBe('Bash');
    expect(card.input).toEqual({ command: 'curl -s https://ornek.test' });
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('Çıkış kodu: 0');
    expect(reply).toContain('çalıştı: curl -s https://ornek.test');
    const exec = fake.calls.find((c) => c.op === 'exec')!;
    expect(exec.body.cwd).toBe(join(t.dataDir, 'workspaces', 'bots', bot.id, 'threads', thread.id));
  });

  it('github.com anahtarını yalnız izinli botun masaüstüne verir, değişince yeniden verir', async () => {
    const bot = await t.bot({ name: 'Yazılımcı' });
    const other = await t.bot({ name: 'Diğer' });
    const gits = (id: string) =>
      fake.calls.filter((c) => c.id === id && c.op === 'git').map((c) => c.body.token);
    const look = (id: string) => t.services.ctx.computer!.use(id, (c) => c.screenshot(id));

    await look(bot.id);
    expect(gits(bot.id)).toEqual([null]);

    // A key for another address is not git's; one for github.com is, for the bots it is open to.
    await t.services.apiCredentials.create(
      {
        name: 'github_api',
        origin: 'https://api.github.com',
        auth: { type: 'bearer' },
        value: 'github_pat_api_0123456789',
      },
      null,
    );
    await look(bot.id);
    expect(gits(bot.id)).toEqual([null]);
    const key = await t.services.apiCredentials.create(
      {
        name: 'github_git',
        origin: 'github.com',
        auth: { type: 'bearer' },
        value: 'github_pat_git_0123456789',
        botIds: [bot.id],
      },
      null,
    );
    // A running desktop gets it right away, before any step of the bot.
    await waitFor(async () => gits(bot.id).length === 2);
    await look(bot.id);
    expect(gits(bot.id)).toEqual([null, 'github_pat_git_0123456789']);
    await look(other.id);
    expect(gits(other.id)).toEqual([null]);

    // Moved to the other bot: both running desktops are told.
    await t.services.apiCredentials.update(key.id, { botIds: [other.id] });
    await waitFor(async () => gits(bot.id).length === 3 && gits(other.id).length === 2);
    await look(bot.id);
    await look(other.id);
    expect(gits(bot.id)).toEqual([null, 'github_pat_git_0123456789', null]);
    expect(gits(other.id)).toEqual([null, 'github_pat_git_0123456789']);

    // A bot with the internet off keeps git off GitHub, even with a key open to every bot.
    const offline = await t.bot({ name: 'Çevrimdışı', internet: false });
    await t.services.apiCredentials.update(key.id, { botIds: null });
    await look(offline.id);
    expect(gits(offline.id)).toEqual([null]);
  });

  it('kişinin kendi GitHub anahtarı yalnız onun konuşmasındaki komuta gider; masaüstü ekibinkiyle kalır', async () => {
    const bot = await t.bot({ name: 'Kişisel', permissionMode: 'auto' });
    const execs = () =>
      fake.calls.filter((c) => c.id === bot.id && (c.op === 'exec' || c.op === 'jobs-start'));
    const gits = () => fake.calls.filter((c) => c.id === bot.id && c.op === 'git').map((c) => c.body.token);
    await t.services.apiCredentials.create(
      { name: 'github_ekip', origin: 'https://github.com', value: 'github_pat_ekibin_0123456789' },
      null,
    );
    await t.services.apiCredentials.create(
      { name: 'github_benim', origin: 'https://github.com', value: 'github_pat_benim_0123456789' },
      'owner',
    );
    const run = async (threadId: string, input: Record<string, unknown>) => {
      await t.send(threadId, `[araç:run_command ${JSON.stringify(input)}]`);
      await t.services.turns.idle();
      return execs().at(-1)!.body;
    };

    // In the person's own conversation, each command brings their key, a background one too, and
    // its commits are written by that key's account.
    const mine = await main(bot.id);
    const theirs = { name: 'acct-benim', email: '1+acct-benim@users.noreply.github.com' };
    const fetched = await run(mine.id, { command: 'git fetch' });
    expect(fetched.git).toEqual({ token: 'github_pat_benim_0123456789' });
    expect(fetched.author).toEqual(theirs);
    const cloned = await run(mine.id, { command: 'git clone x', background: true });
    expect(cloned.git).toEqual({ token: 'github_pat_benim_0123456789' });
    expect(cloned.author).toEqual(theirs);
    // The desktop itself keeps the team's, for everything else that runs on it.
    expect(gits().at(-1)).toBe('github_pat_ekibin_0123456789');

    // A team conversation brings none, so its git goes with the team's, and so do its commits.
    const team = await t.services.threads.create(bot.id, { kind: 'team', userId: null, title: 'Ekip' });
    const pulled = await run(team.id, { command: 'git pull' });
    expect(pulled.git).toBeUndefined();
    expect(pulled.author).toEqual({ name: 'acct-ekibin', email: '1+acct-ekibin@users.noreply.github.com' });

    // Nor does a bot's turn that no request chain from the person's own message started.
    await t.services.turns.enqueue({
      threadId: mine.id,
      botId: bot.id,
      source: 'bot',
      prompt: `[araç:run_command ${JSON.stringify({ command: 'git push' })}]`,
    });
    await t.services.turns.idle();
    const handed = execs().at(-1)!.body;
    expect(handed.command).toBe('git push');
    expect(handed.git).toBeUndefined();
    expect(handed.author).toEqual({ name: 'acct-ekibin', email: '1+acct-ekibin@users.noreply.github.com' });
  });

  it('kişinin kendi mesajından başka botun devrettiği işte onun anahtarını verir; zincirde dışarıdan okunan bir şey varsa vermez', async () => {
    const dev = await t.bot({ name: 'Geliştirici', permissionMode: 'auto' });
    const lead = await t.bot({ name: 'Yönetici', permissionMode: 'auto' });
    const execs = () =>
      fake.calls.filter((c) => c.id === dev.id && (c.op === 'exec' || c.op === 'jobs-start'));
    await t.services.apiCredentials.create(
      { name: 'github_benim', origin: 'https://github.com', value: 'github_pat_benim_0123456789' },
      'owner',
    );
    const { db } = t.services.ctx;
    const lastTurn = async (threadId: string) =>
      (
        await db
          .select()
          .from(schema.turns)
          .where(eq(schema.turns.threadId, threadId))
          .orderBy(desc(schema.turns.createdAt))
          .limit(1)
      )[0]!;
    // The person asks the lead in their own conversation; the lead hands a push on to the developer.
    const handOn = async (fromThreadId: string, fromTurnId: string) => {
      await t.services.jobs.send({
        from: lead,
        to: dev,
        fromThreadId,
        fromTurnId,
        parentJobId: null,
        text: `[araç:run_command ${JSON.stringify({ command: 'git push' })}]`,
        kind: 'notify',
      });
      await t.services.turns.idle();
      return execs().at(-1)!.body;
    };

    const mine = await main(lead.id);
    await t.send(mine.id, 'CI düzeltmelerini geliştiriciye ilet');
    await t.services.turns.idle();
    const asked = await lastTurn(mine.id);
    const handed = await handOn(mine.id, asked.id);
    expect(handed.command).toBe('git push');
    expect(handed.git).toEqual({ token: 'github_pat_benim_0123456789' });

    // The lead read a mail before handing on: its words may be someone else's, so the team's.
    await db.update(schema.turns).set({ outside: 'email' }).where(eq(schema.turns.id, asked.id));
    expect((await handOn(mine.id, asked.id)).git).toBeUndefined();

    // Work a routine or another bot's own turn started is not the person's either.
    const own = await t.services.threads.create(lead.id, { title: 'Rutin', userId: 'owner' });
    await t.services.turns.enqueue({ threadId: own.id, botId: lead.id, source: 'routine', prompt: 'rapor' });
    await t.services.turns.idle();
    expect((await handOn(own.id, (await lastTurn(own.id)).id)).git).toBeUndefined();
  });

  it('uzun komutu arka planda başlatır; bitene kadar masaüstü uyumaz, durumu sonra sorulur', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:computer_screenshot]');
    await t.services.turns.idle();
    const started = await text('run_command', { command: 'make all', background: true });
    expect(started).toContain('arka planda');
    expect(started).toContain('j1');
    expect(fake.calls.find((c) => c.op === 'jobs-start')!.body.command).toBe('make all');
    const computer = t.services.ctx.computer!;
    // Idle well past the usual sleep, but the build still runs: the desktop stays up.
    await computer.tick(Date.now() + 30 * 60_000);
    expect(fake.status.get(bot.id)).toBe('running');
    const done = await text('command_status', { id: 'j1', wait_seconds: 5 });
    expect(done).toContain('Çıkış kodu: 0');
    expect(done).toContain('derleme bitti');
    expect(fake.calls.find((c) => c.op === 'jobs-status')!.body).toMatchObject({ id: 'j1', waitMs: 5000 });
    // Once it ended, an idle desktop sleeps as before.
    await computer.tick(Date.now() + 30 * 60_000);
    expect(fake.status.get(bot.id)).toBe('off');
  });

  it('açılamayan masaüstünün nedenini bota söyler', async () => {
    fake.failStart = 'bwrap: No permissions to create a new namespace';
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:computer_screenshot]');
    await t.services.turns.idle();
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('No permissions to create a new namespace');
  });

  it('kişi kontrol ederken botun işlemi bekler, geri verince sürer; boşta kalan masaüstünü uyutur', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:computer_screenshot]');
    await t.services.turns.idle();
    const computer = t.services.ctx.computer!;

    computer.setControl(bot.id, 'kişi', true);
    const shot = text('computer_screenshot', {});
    await waitFor(async () => computer.state(bot.id).waiting === true);
    expect(computer.state(bot.id)).toMatchObject({ user: true, waiting: true });
    const before = fake.calls.length;
    await new Promise((r) => setTimeout(r, 50));
    // Nothing reaches the desktop while the person has it.
    expect(fake.calls.length).toBe(before);
    computer.forget('kişi');
    expect(computer.state(bot.id).user).toBe(false);
    const after = await shot;
    expect(after).toContain('denetimi geri verdi');
    expect(after).toContain('1280x800');
    expect(computer.state(bot.id).waiting).toBe(false);

    // A click chosen on the screen before the person had it is not made; the bot sees the screen.
    computer.setControl(bot.id, 'kişi', true);
    const click = text('computer_click', { x: 10, y: 20, button: 'left', count: 1 });
    await waitFor(async () => computer.state(bot.id).waiting === true);
    const actions = fake.calls.filter((c) => c.op === 'action').length;
    computer.forget('kişi');
    const clicked = await click;
    expect(clicked).toContain('Bu adım yapılmadı');
    expect(clicked).toContain('1280x800');
    expect(fake.calls.filter((c) => c.op === 'action')).toHaveLength(actions);

    // Kept past the wait, or the turn stopped meanwhile: refused as before.
    computer.setControl(bot.id, 'kişi', true);
    await expect(computer.awaitControl(bot.id, undefined, 20)).rejects.toMatchObject({ code: 'userControl' });
    const stop = new AbortController();
    const waiting = computer.awaitControl(bot.id, stop.signal);
    stop.abort();
    await expect(waiting).rejects.toMatchObject({ code: 'userControl' });
    expect(computer.state(bot.id).waiting).toBe(false);
    computer.forget('kişi');

    computer.watch(bot.id, 'izleyen');
    await computer.tick(Date.now() + 120_000);
    expect(fake.status.get(bot.id)).toBe('running');
    computer.unwatch(bot.id, 'izleyen');
    await computer.tick(Date.now() + 120_000);
    expect(fake.status.get(bot.id)).toBe('off');
    expect(computer.state(bot.id).status).toBe('off');

    // The bot's next step wakes it again.
    expect(await text('computer_screenshot', {})).toContain('1280x800');
    expect(fake.starts).toHaveLength(2);
  });

  it('proje klasörlü bot sunucudaki Bash ile kalır; salt okunur botun klasörleri salt okunur bağlanır', async () => {
    const project = await t.bot({ projectDir: mkdtempSync(join(tmpdir(), 'leafbot-proje-')) });
    await t.send((await main(project.id)).id, 'merhaba');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.shell).toBe('sandbox');
    expect(tool('run_command')).toBeUndefined();
    expect(tool('computer_screenshot')).toBeDefined();

    const reader = await t.bot({ permissionMode: 'readonly' });
    await t.send((await main(reader.id)).id, '[araç:computer_screenshot]');
    await t.services.turns.idle();
    expect(fake.starts.at(-1)!.body.folders.every((f) => !f.writable)).toBe(true);
  });

  it('yer kalmayınca en uzun süredir boşta duran masaüstünü uyutup yenisine yer açar', async () => {
    fake.max = 2;
    const computer = t.services.ctx.computer!;
    const [a, b, c] = [(await t.bot()).id, (await t.bot()).id, (await t.bot()).id];
    await computer.ensure(a);
    await computer.ensure(b);
    // a is in use and b is watched: b, though watched, is the one that makes room.
    const release = computer.hold(a);
    computer.watch(b, 'izleyen');
    await computer.ensure(c);
    expect(fake.status.get(a)).toBe('running');
    expect(fake.status.get(b)).toBe('off');
    expect(computer.state(b).status).toBe('off');
    expect(fake.status.get(c)).toBe('running');

    // Every desktop held (a bot step, a person in control): the start is refused as before.
    computer.setControl(c, 'kişi', true);
    await expect(computer.ensure(b)).rejects.toMatchObject({ code: 'full' });
    expect(fake.status.get(a)).toBe('running');
    expect(fake.status.get(c)).toBe('running');
    release();
  });

  it('tarayıcı adımı sürerken masaüstü uyumaz; sunucu yeniden açılınca açık kalanları üstlenir', async () => {
    const computer = t.services.ctx.computer!;
    fake.status.set('eski-bot', 'running');
    await computer.adopt();
    expect(computer.state('eski-bot').status).toBe('running');

    const release = computer.hold('eski-bot');
    await computer.tick(Date.now() + 120_000);
    expect(fake.status.get('eski-bot')).toBe('running');
    release();
    await computer.tick(Date.now() + 120_000);
    expect(fake.status.get('eski-bot')).toBe('off');
  });

  describe('canlı ekran', () => {
    let url: string;
    const sockets: Socket[] = [];
    beforeEach(async () => {
      url = await t.listen();
    });
    afterEach(() => {
      for (const s of sockets.splice(0)) s.close();
    });
    const open = async () => {
      const s = connect(url, {
        transports: ['websocket'],
        reconnection: false,
        extraHeaders: { authorization: `Bearer ${KEY}` },
      });
      sockets.push(s);
      await new Promise((r) => s.on('hello', r));
      return s;
    };

    it('ekran baytlarını taşır; klavyeyi yalnızca kontrolü alan kişiden geçirir', async () => {
      const bot = await t.bot();
      const viewer = await open();
      const other = await open();
      const states: ComputerState[] = [];
      other.on('computer:state', (s: ComputerState) => states.push(s));

      expect(await viewer.emitWithAck('computer:watch', bot.id)).toMatchObject({ status: 'off' });
      expect(await viewer.emitWithAck('vnc:open', bot.id)).toMatchObject({ ok: false });
      expect(await viewer.emitWithAck('computer:wake', bot.id)).toEqual({ ok: true });
      await waitFor(async () => states.some((s) => s.botId === bot.id && s.status === 'running'));

      const data: Buffer[] = [];
      viewer.on('vnc:data', (e: { botId: string; data: Buffer }) => data.push(Buffer.from(e.data)));
      expect(await viewer.emitWithAck('vnc:open', bot.id)).toEqual({ ok: true });
      await waitFor(async () => data.length > 0);
      expect(Buffer.concat(data).toString()).toBe('RFB 003.008\n');

      viewer.emit('vnc:data', { botId: bot.id, data: Buffer.concat([handshake(), key(true)]) });
      await waitFor(async () => Buffer.concat(fake.received).length >= 14);
      await new Promise((r) => setTimeout(r, 50));
      expect(Buffer.concat(fake.received)).toEqual(handshake());

      // Someone else holding control does not let this viewer type.
      expect(await other.emitWithAck('computer:control', { botId: bot.id, on: true })).toEqual({ ok: true });
      viewer.emit('vnc:data', { botId: bot.id, data: key(true) });
      await new Promise((r) => setTimeout(r, 50));
      expect(Buffer.concat(fake.received)).toEqual(handshake());

      expect(await viewer.emitWithAck('computer:control', { botId: bot.id, on: true })).toEqual({ ok: true });
      viewer.emit('vnc:data', { botId: bot.id, data: key(false) });
      await waitFor(async () => Buffer.concat(fake.received).length === 22);
      expect(Buffer.concat(fake.received).subarray(14)).toEqual(key(false));

      // Leaving gives control back.
      viewer.close();
      await waitFor(async () => !t.services.ctx.computer!.state(bot.id).user);
    });
  });
});
