import { createServer as httpServer } from 'node:http';
import { createInterface } from 'node:readline';
import type { Locale } from '@leafbot/shared';
import type { Config } from '../config';
import type { Ctx } from '../context';
import { openDb } from '../db';
import { translator, type T } from '../i18n';
import { VaultService } from '../services/vault';
import { AccountHost, accountHostConfig } from '../tunnel/host';
import { AccountLinks } from '../tunnel/links';
import { AccountSignIn } from '../tunnel/signin';
import { adoptLegacyAccount } from '../users';
import { HttpError } from '../util';

/** The terminal the command talks through; `ask` answers null once the input has ended. */
export interface LoginIo {
  ask(question: string): Promise<string | null>;
  say(line: string): void;
}

export interface LoginOptions {
  config: Config;
  io: LoginIo;
  locale: Locale;
  /** The account service as the tests stand it in; the real one otherwise. */
  fetcher?: typeof fetch;
  /** Whether a server already answers on this data folder's port. */
  serverAnswers?: (config: Config) => Promise<boolean>;
}

/**
 * `leafbot login`: the owner of a server with no screen signs in to their Leaf Bot account with a
 * code mailed to them, and the server links itself to that account, as the app's sign-in does. It
 * works on the data folder itself (its database and vault key), so a server that is not running can
 * be signed in before its first start. Returns the exit code.
 */
export async function login(opts: LoginOptions): Promise<number> {
  const { config, io } = opts;
  const t = translator(opts.locale);
  const running = await (opts.serverAnswers ?? serverAnswers)(config);
  // The embedded database is one folder that only one process may open at a time.
  if (running && !config.databaseUrl) {
    io.say(t('login.stopServer'));
    return 1;
  }
  const db = await openDb({ url: config.databaseUrl, dataDir: config.dataDir, memory: config.memoryDb });
  try {
    // A data folder the server never started on has no owner yet to link the account to.
    await adoptLegacyAccount(db.db);
    // Only the vault key's file is read, from the data folder, as the server reads it.
    const vault = new VaultService({ config } as Ctx);
    const host = new AccountHost({
      db: db.db,
      vault,
      // The tunnel is not started here (no WebRTC), so the server is never listened on.
      server: httpServer(),
      config: accountHostConfig(config),
      rtc: null,
      ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
    });
    const signIn = new AccountSignIn({
      issuer: accountHostConfig(config).issuer,
      host,
      links: new AccountLinks(db.db),
      ...(opts.fetcher ? { fetcher: opts.fetcher } : {}),
    });
    if ((await host.state()).linked) io.say(t('login.alreadyLinked'));
    const done = await steps(signIn, io, t, opts.locale);
    if (!done) return 1;
    if (running) io.say(t('login.restart'));
    return 0;
  } finally {
    await db.close();
  }
}

/** Email, code, then the name when the account has none; false when it stopped on the way. */
async function steps(signIn: AccountSignIn, io: LoginIo, t: T, locale: Locale): Promise<boolean> {
  /** Says why a step failed; true when the same step may be tried again. */
  const failed = (e: unknown, again: HttpError['key'][]) => {
    if (!(e instanceof HttpError)) throw e;
    io.say(t(e.key, e.params));
    return again.includes(e.key);
  };

  let email = '';
  for (;;) {
    const typed = await io.ask(t('login.askEmail'));
    if (typed === null) return false;
    email = typed.trim();
    if (!email) continue;
    if (email.length < 3 || email.length > 254) {
      io.say(t('error.accountEmailInvalid'));
      continue;
    }
    try {
      await signIn.start(email, locale);
      break;
    } catch (e) {
      if (!failed(e, ['error.accountEmailInvalid'])) return false;
    }
  }
  io.say(t('login.codeSent', { email }));

  for (;;) {
    const typed = await io.ask(t('login.askCode'));
    if (typed === null) return false;
    const code = typed.trim();
    if (!code) {
      // An empty line asks for a new code, for one that expired or never came.
      try {
        await signIn.start(email, locale);
        io.say(t('login.codeSent', { email }));
      } catch (e) {
        failed(e, []);
        return false;
      }
      continue;
    }
    try {
      const signed = await signIn.verify(email, code.slice(0, 16));
      io.say(t('login.linked', { email: signed.email }));
      if (!signed.needsName) return true;
      break;
    } catch (e) {
      if (e instanceof HttpError && e.key === 'error.accountCodeWrong') {
        io.say(t('login.codeWrong'));
        continue;
      }
      failed(e, []);
      return false;
    }
  }

  // Linked already; the account has no name yet, and the app would ask for it next.
  for (;;) {
    const typed = await io.ask(t('login.askName'));
    // The server stays linked; the account asks for the name on its next visit to the website.
    if (typed === null) return true;
    try {
      const { name } = await signIn.setName(typed);
      io.say(t('login.named', { name }));
      return true;
    } catch (e) {
      if (!failed(e, ['error.accountNameInvalid'])) return false;
    }
  }
}

/** Whether the server answers on its own port on this computer. */
async function serverAnswers(config: Config): Promise<boolean> {
  const any = !config.host || config.host === '0.0.0.0' || config.host === '::';
  const host = any ? '127.0.0.1' : config.host.includes(':') ? `[${config.host}]` : config.host;
  const res = await fetch(`http://${host}:${config.port}/api/health`, {
    signal: AbortSignal.timeout(1500),
  }).catch(() => null);
  return !!res?.ok;
}

/** `leafbot login` on the terminal it was typed in. */
export async function loginFromTerminal(config: Config, locale: Locale): Promise<number> {
  const io = terminal();
  try {
    return await login({ config, io, locale });
  } finally {
    io.close();
  }
}

/** Questions and answers on the terminal; Ctrl+C or the end of the input stops the questions. */
function terminal(): LoginIo & { close(): void } {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // Lines typed or piped in before their question is asked (the database opens first) wait here.
  const lines: string[] = [];
  const waiting: ((answer: string | null) => void)[] = [];
  let closed = false;
  rl.on('line', (line) => {
    const answer = waiting.shift();
    if (answer) answer(line);
    else lines.push(line);
  });
  rl.on('close', () => {
    closed = true;
    // The line a question was left on ends, so what is printed next starts a line of its own.
    if (waiting.length) process.stdout.write('\n');
    for (const answer of waiting.splice(0)) answer(null);
  });
  // Without a listener of its own, Ctrl+C would only pause the questions.
  rl.on('SIGINT', () => rl.close());
  return {
    ask: (question) => {
      // Piped answers may all be read, and the input closed, before the first question.
      if (closed) process.stdout.write(question);
      else {
        rl.setPrompt(question);
        rl.prompt();
      }
      const line = lines.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (closed) {
        process.stdout.write('\n');
        return Promise.resolve(null);
      }
      return new Promise((resolve) => waiting.push(resolve));
    },
    say: (line) => console.log(line),
    close: () => rl.close(),
  };
}
