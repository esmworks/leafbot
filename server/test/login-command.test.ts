import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { login, type LoginIo } from '../src/cli/login';
import { loadConfig, type Config } from '../src/config';
import { schema } from '../src/db';
import { translator } from '../src/i18n';
import { AccountLinks } from '../src/tunnel/links';
import { OWNER_ID } from '../src/users';
import { ISSUER, fakeAccount, ownerClaims } from './fake-account';
import { testServer } from './helpers';

const en = translator('en');
const ACCOUNT = { issuer: ISSUER, relayUrl: 'ws://127.0.0.1:9/v1/signal', webHost: 'www.leafbot.app' };

/** A terminal that types the given answers, then ends its input; it keeps what was asked and said. */
function terminal(answers: string[]): LoginIo & { asked: string[]; said: string[] } {
  const asked: string[] = [];
  const said: string[] = [];
  return {
    asked,
    said,
    ask: async (question) => {
      asked.push(question);
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

  it('leaves the embedded database alone while a server runs on it', async () => {
    const account = fakeAccount();
    const io = terminal(['ada@example.com']);
    const code = await login({
      config: dataFolder(),
      io,
      locale: 'en',
      fetcher: account.fetcher,
      serverAnswers: async () => true,
    });
    expect(code).toBe(1);
    expect(io.said).toEqual([en('login.stopServer')]);
    expect(io.asked).toEqual([]);
    expect(account.calls).toEqual([]);
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
