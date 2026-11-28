// What the scripts that draw the app's screens share: the built server started with the fake engine
// in a data folder of their own, and a headless Chromium with no app bundle, so no Dock icon shows.
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export const root = join(import.meta.dirname, '..');
const entry = join(root, 'server/dist/index.mjs');
const appDir = join(root, 'app/dist');

/** The server's own dependencies (Playwright, PGlite), which the scripts borrow. */
export const requireFromServer = createRequire(join(root, 'server/package.json'));

export function checkBuilt() {
  if (!existsSync(entry) || !existsSync(join(appDir, 'index.html'))) {
    console.error('Build first: pnpm --filter @leafbot/server build && pnpm --filter @leafbot/app build');
    process.exit(1);
  }
}

/**
 * The headless shell Playwright would use, or else the newest one already downloaded (another
 * Playwright version's shell works for screenshots), or the one LEAFBOT_SNAP_BROWSER names.
 * Undefined lets Playwright say how to download one.
 */
export function headlessShell(chromium) {
  if (process.env.LEAFBOT_SNAP_BROWSER) return process.env.LEAFBOT_SNAP_BROWSER;
  if (existsSync(chromium.executablePath())) return undefined;
  const cache =
    process.env.PLAYWRIGHT_BROWSERS_PATH ??
    (process.platform === 'darwin'
      ? join(homedir(), 'Library/Caches/ms-playwright')
      : process.platform === 'win32'
        ? join(homedir(), 'AppData/Local/ms-playwright')
        : join(homedir(), '.cache/ms-playwright'));
  const shells = existsSync(cache)
    ? readdirSync(cache)
        .filter((d) => d.startsWith('chromium_headless_shell-'))
        .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
    : [];
  for (const dir of shells) {
    for (const sub of readdirSync(join(cache, dir))) {
      const bin = join(
        cache,
        dir,
        sub,
        process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell',
      );
      if (existsSync(bin)) return bin;
    }
  }
  return undefined;
}

/**
 * Starts the built server with the fake engine on `dataDir`, signed in to with `key`. Resolves once
 * it has said where it listens, with that address, a `call` for its API and a `stop`. `env` adds to
 * or changes the server's settings.
 */
export async function startServer(dataDir, key, env = {}) {
  const server = spawn(process.execPath, [entry], {
    env: {
      PATH: process.env.PATH ?? '',
      HOME: process.env.HOME ?? '',
      TMPDIR: process.env.TMPDIR ?? '/tmp',
      LANG: process.env.LANG ?? 'en_US.UTF-8',
      LEAFBOT_HOST: '127.0.0.1',
      LEAFBOT_PORT: '0',
      LEAFBOT_DATA_DIR: dataDir,
      LEAFBOT_APP_DIR: appDir,
      LEAFBOT_ENGINE: 'fake',
      LEAFBOT_ACCESS_KEY: key,
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  server.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
  const stop = async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGTERM');
      await new Promise((r) => server.once('exit', r));
    }
  };
  let base;
  try {
    base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the server did not start within 60 s')), 60_000);
      createInterface({ input: server.stdout }).on('line', (line) => {
        const m = /^LEAFBOT_READY (\S+)/.exec(line);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      server.once('exit', (code) => reject(new Error(`the server stopped (${code}):\n${stderr}`)));
    });
  } catch (err) {
    await stop();
    throw err;
  }
  const call = async (method, path, body) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  };
  return { base, call, stop };
}

/**
 * Sends a message in a thread and waits until the fake engine has answered it; resolves with the
 * person's message and the reply.
 */
export async function converse(call, threadId, clientId, text) {
  const before = (await call('GET', `/api/threads/${threadId}/messages`)).filter(
    (m) => m.role === 'assistant',
  );
  await call('POST', `/api/threads/${threadId}/messages`, { clientId, text });
  for (let tries = 0; tries < 200; tries++) {
    const messages = await call('GET', `/api/threads/${threadId}/messages`);
    const replies = messages.filter((m) => m.role === 'assistant');
    if (replies.length > before.length) {
      return { mine: messages.find((m) => m.clientId === clientId), reply: replies.at(-1) };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`no reply in thread ${threadId} to: ${text.slice(0, 60)}`);
}
