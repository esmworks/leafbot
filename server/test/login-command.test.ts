import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { login, serverAnswers, terminal as tty, type LoginIo } from '../src/cli/login';
import { loadConfig, type Config } from '../src/config';
import { schema } from '../src/db';
import { translator } from '../src/i18n';
import { AccountLinks } from '../src/tunnel/links';
import { OWNER_ID } from '../src/users';
import { CODE, ISSUER, fakeAccount, ownerClaims } from './fake-account';
import { testServer } from './helpers';

const en = translator('en');
const ACCOUNT = { issuer: ISSUER, relayUrl: 'ws://127.0.0.1:9/v1/signal', webHost: 'www.leafbot.app' };

/**
 * A terminal that types the given answers, then ends its input; it keeps what was asked and said.
 * `onAsk` runs as a question is asked (a test presses Ctrl+C there).
 */
function terminal(
  answers: string[],
  opts: { signal?: AbortSignal; onAsk?: (question: string) => void } = {},
): LoginIo & { asked: string[]; said: string[] } {
  const asked: string[] = [];
  const said: string[] = [];
  return {
    asked,
    said,
    ...(opts.signal ? { signal: opts.signal } : {}),
    ask: async (question) => {
      asked.push(question);
      opts.onAsk?.(question);
      return answers.shift() ?? null;
    },
    say: (line) => void said.push(line),
  };
}

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A data folder no server has started on; on disk unless `memory`. */
function dataFolder(memory = false): Config {
  const dataDir = mkdtempSync(join(tmpdir(), 'leafbot-login-'));
  dirs.push(dataDir);
  return loadConfig({}, { dataDir, memoryDb: memory, databaseUrl: null, account: ACCOUNT });
}

const stopped = async () => false;

describe('leafbot login', () => {
  it('signs a never-started server in, and the server it starts there is linked to the account', async () => {
    const config = dataFolder();
    const account = fakeAccount({ name: 'Ada Lovelace' });
    const io = terminal(['ada@example.com', '123456']);
    const code = await login({ config, io, locale: 'en', fetcher: account.fetcher, serverAnswers: stopped });
    expect(code).toBe(0);
    expect(io.asked).toEqual([en('login.askEmail'), en('login.askCode')]);
    expect(io.said).toEqual([
      en('login.codeSent', { email: 'ada@example.com' }),
      en('login.linked', { email: 'ada@example.com' }),
    ]);
    expect(account.calls.map((c) => c.path)).toEqual([
      '/v1/auth/email/start',
      '/v1/auth/email/verify',
      '/v1/servers/install-codes',
      '/v1/host/claim',
      '/v1/auth/signout',
    ]);

    // The server started on the same folder reads the link, opens the machine token with its own
    // vault and knows the account as its owner.
    const t = await testServer({ dataDir: config.dataDir, memoryDb: false, databaseUrl: null });
    try {
      const state = await t.api<{ linked: boolean; hostId: string }>('GET', '/api/account-host');
      expect(state.body.linked).toBe(true);
      const [row] = await t.services.ctx.db
        .select()
        .from(schema.kv)
        .where(eq(schema.kv.key, 'account-host'))
        .limit(1);
      const stored = row?.value as { hostId: string; token: string };
      expect(stored.hostId).toBe(state.body.hostId);
      expect(t.services.vault.open(stored.token, ['account-host', stored.hostId, 'token'])).toBe('mt_secret');
      expect(await new AccountLinks(t.services.ctx.db).resolve(ownerClaims('acct_ada00001'))).toEqual({
        userId: OWNER_ID,
      });
      expect((await t.services.settings.all(OWNER_ID)).userName).toBe('Ada Lovelace');
    } finally {
      await t.dispose();
    }
  });

  it('asks again after a wrong code, then asks for the name the account lacks', async () => {
    const config = dataFolder(true);
    const account = fakeAccount();
    const io = terminal(['ada@example.com', '000000', '123456', '   ', 'Ada  Byron']);
    const code = await login({ config, io, locale: 'en', fetcher: account.fetcher, serverAnswers: stopped });
    expect(code).toBe(0);
    expect(io.asked).toEqual([
      en('login.askEmail'),
      en('login.askCode'),
      en('login.askCode'),
      en('login.askName'),
      en('login.askName'),
    ]);
    expect(io.said).toEqual([
      en('login.codeSent', { email: 'ada@example.com' }),
      en('login.codeWrong'),
      en('login.linked', { email: 'ada@example.com' }),
      en('error.accountNameInvalid'),
      en('login.named', { name: 'Ada Byron' }),
    ]);
    // The name went to the account with the sign-in kept for it, which then ended.
    expect(account.calls.slice(-2)).toEqual([
      { path: '/v1/me', body: { name: 'Ada Byron' }, auth: 'Bearer desk-token-0000000000000000' },
      { path: '/v1/auth/signout', body: null, auth: 'Bearer desk-token-0000000000000000' },
    ]);
  });

  it('mails a new code when the code is left empty, and names the server as it is told', async () => {
    const account = fakeAccount({ name: 'Ada' });
    const io = terminal(['ada@example.com', '', '123456']);
    // In a container the computer's name is the container's id; the installer names it instead.
    process.env.LEAFBOT_SERVER_NAME = 'bot.example.com';
    try {
      const code = await login({
        config: dataFolder(true),
        io,
        locale: 'en',
        fetcher: account.fetcher,
        serverAnswers: stopped,
      });
      expect(code).toBe(0);
    } finally {
      delete process.env.LEAFBOT_SERVER_NAME;
    }
    expect(account.calls.filter((c) => c.path === '/v1/auth/email/start')).toHaveLength(2);
    expect(account.calls.find((c) => c.path === '/v1/servers/install-codes')?.body).toEqual({
      name: 'bot.example.com',
    });
    expect(account.calls.find((c) => c.path === '/v1/host/claim')?.body?.name).toBe('bot.example.com');
  });

  it('says why when the server belongs to another account, and stops', async () => {
    const account = fakeAccount({ hostTaken: true });
    const io = terminal(['ada@example.com', '123456']);
    const code = await login({
      config: dataFolder(true),
      io,
      locale: 'en',
      fetcher: account.fetcher,
      serverAnswers: stopped,
    });
    expect(code).toBe(1);
    expect(io.said.at(-1)).toBe(en('error.installCodeOtherAccount'));
    // The account's sign-in is not left open.
    expect(account.calls.at(-1)?.path).toBe('/v1/auth/signout');
  });

  it('speaks the terminal’s language and asks again for an email the account refuses', async () => {
    const tr = translator('tr');
    const io = terminal(['x', 'ada@example.com']);
    const account = fakeAccount({ down: true });
    const code = await login({
      config: dataFolder(true),
      io,
      locale: 'tr',
      fetcher: account.fetcher,
      serverAnswers: stopped,
    });
    expect(code).toBe(1);
    expect(io.said).toEqual([tr('error.accountEmailInvalid'), tr('error.accountUnreachable')]);
  });

  it('leaves the embedded database alone while another process holds it, whatever port it is on', async () => {
    const config = dataFolder();
    // A server on this folder: another live process holds the folder's lock.
    const other = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
    const lock = join(config.dataDir, 'db.lock');
    writeFileSync(lock, JSON.stringify({ pid: other.pid, host: hostname(), token: 'server' }));
    try {
      const account = fakeAccount();
      const io = terminal(['ada@example.com']);
      const code = await login({ config, io, locale: 'en', fetcher: account.fetcher });
      expect(code).toBe(1);
      expect(io.said).toEqual([en('login.stopServer')]);
      expect(io.asked).toEqual([]);
      expect(account.calls).toEqual([]);
      // The holder's lock stays.
      expect(existsSync(lock)).toBe(true);
    } finally {
      other.kill();
    }
  });

  it('links nothing once the person stops it while the code is checked', async () => {
    const stop = new AbortController();
    const account = fakeAccount({ name: 'Ada' });
    const io = terminal(['ada@example.com', '123456'], {
      signal: stop.signal,
      // Ctrl+C right after the code is typed, while it is checked.
      onAsk: (q) => q === en('login.askCode') && queueMicrotask(() => stop.abort()),
    });
    const code = await login({
      config: dataFolder(true),
      io,
      locale: 'en',
      fetcher: account.fetcher,
      serverAnswers: stopped,
    });
    expect(code).toBe(1);
    expect(account.calls.map((c) => c.path)).toEqual([
      '/v1/auth/email/start',
      '/v1/auth/email/verify',
      '/v1/auth/signout',
    ]);
    expect(io.said).toEqual([en('login.codeSent', { email: 'ada@example.com' })]);
  });

  it('says the account would not make an install code, not that the email is wrong', async () => {
    const account = fakeAccount({ installRefused: true });
    const io = terminal(['ada@example.com', '123456']);
    const code = await login({
      config: dataFolder(true),
      io,
      locale: 'en',
      fetcher: account.fetcher,
      serverAnswers: stopped,
    });
    expect(code).toBe(1);
    expect(io.said.at(-1)).toBe(en('error.accountInstallRefused'));
    expect(account.calls.at(-1)?.path).toBe('/v1/auth/signout');
  });

  it('stops when the input ends', async () => {
    const account = fakeAccount();
    const code = await login({
      config: dataFolder(true),
      io: terminal([]),
      locale: 'en',
      fetcher: account.fetcher,
      serverAnswers: stopped,
    });
    expect(code).toBe(1);
    expect(account.calls).toEqual([]);
  });
});

describe('leafbot login --code', () => {
  it('links the server with the install code piped in, asking nothing else', async () => {
    const config = dataFolder();
    const account = fakeAccount();
    const io = terminal([CODE]);
    process.env.LEAFBOT_SERVER_NAME = 'bot.example.com';
    try {
      const code = await login({
        config,
        io,
        locale: 'en',
        fetcher: account.fetcher,
        serverAnswers: stopped,
        withInstallCode: true,
      });
      expect(code).toBe(0);
    } finally {
      delete process.env.LEAFBOT_SERVER_NAME;
    }
    expect(io.asked).toEqual([en('login.askInstallCode')]);
    expect(io.said).toEqual([en('login.linkedWithCode')]);
    // No email sign-in: the code was made by the account the owner is signed in to on the website.
    expect(account.calls.map((c) => c.path)).toEqual(['/v1/host/claim']);
    expect(account.calls[0]?.body).toMatchObject({ code: CODE, name: 'bot.example.com' });

    const t = await testServer({ dataDir: config.dataDir, memoryDb: false, databaseUrl: null });
    try {
      const state = await t.api<{ linked: boolean }>('GET', '/api/account-host');
      expect(state.body.linked).toBe(true);
      // The account that made the code is the owner here from its first visit.
      expect(await new AccountLinks(t.services.ctx.db).resolve(ownerClaims('acct_ada00001'))).toEqual({
        userId: OWNER_ID,
      });
    } finally {
      await t.dispose();
    }
  });

  it('ends on a code that is not one, without asking the account', async () => {
    const account = fakeAccount();
    const io = terminal(['not-a-code']);
    const code = await login({
      config: dataFolder(true),
      io,
      locale: 'en',
      fetcher: account.fetcher,
      serverAnswers: stopped,
      withInstallCode: true,
    });
    expect(code).toBe(1);
    expect(io.said).toEqual([en('error.installCodeInvalid')]);
    expect(account.calls).toEqual([]);
  });

  it('says why when the server belongs to another account', async () => {
    const account = fakeAccount({ hostTaken: true });
    const io = terminal([CODE]);
    const code = await login({
      config: dataFolder(true),
      io,
      locale: 'en',
      fetcher: account.fetcher,
      serverAnswers: stopped,
      withInstallCode: true,
    });
    expect(code).toBe(1);
    expect(io.said).toEqual([en('error.installCodeOtherAccount')]);
  });

  it('ends when no code comes in', async () => {
    const account = fakeAccount();
    const code = await login({
      config: dataFolder(true),
      io: terminal([]),
      locale: 'en',
      fetcher: account.fetcher,
      serverAnswers: stopped,
      withInstallCode: true,
    });
    expect(code).toBe(1);
    expect(account.calls).toEqual([]);
  });
});

describe('the terminal', () => {
  it('keeps lines piped in before their question, then answers null once the input ends', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const io = tty(input, output, { terminal: false });
    input.end('ada@example.com\n123456\n');
    await new Promise((r) => setImmediate(r));
    expect(await io.ask('Email: ')).toBe('ada@example.com');
    expect(await io.ask('Code: ')).toBe('123456');
    expect(await io.ask('Name: ')).toBeNull();
    io.say('done');
    io.close();
    expect(String(output.read())).toContain('done\n');
  });

  it('stops on Ctrl+C: the question waiting gets no answer and what runs is told to stop', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    output.resume();
    const io = tty(input, output, { terminal: true });
    const answer = io.ask('Code: ');
    input.write('\x03');
    expect(await answer).toBeNull();
    expect(io.signal?.aborted).toBe(true);
    io.close();
  });
});

describe('whether a server answers', () => {
  it('asks the configured port on this computer, the loopback address for any address', async () => {
    const server = createServer((req, res) => res.writeHead(req.url === '/api/health' ? 200 : 404).end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as { port: number };
    const config = dataFolder(true);
    expect(await serverAnswers({ ...config, host: '0.0.0.0', port })).toBe(true);
    expect(await serverAnswers({ ...config, host: '127.0.0.1', port })).toBe(true);
    await new Promise((r) => server.close(r));
    expect(await serverAnswers({ ...config, host: '127.0.0.1', port })).toBe(false);
  });
});
