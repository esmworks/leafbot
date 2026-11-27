#!/usr/bin/env node
// Draws screens of the app without a window, for a person or a coding agent to look at a change:
// it starts the built server with the fake engine in a new data folder, sets up an account, a bot
// and a conversation through the server's own API (the fake engine writes the replies), opens each
// screen in headless Chromium and writes a PNG and, with --tree, the page's accessibility tree.
// Nothing here is a test: it shows what a screen looks like now.
//
//   pnpm --filter @leafbot/server build && pnpm --filter @leafbot/app build
//   node scripts/snap.mjs [chat] [settings] [today] [tasks] [dashboards] [new-bot] [routine] [--tree] [--dark] [--out data/snaps] [--width 1280 --height 800]
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
// Each screen after the conversation has loaded: how to open it, and what shows it is open.
const SCREENS = {
  chat: null,
  settings: (page) => page.keyboard.press(process.platform === 'darwin' ? 'Meta+Comma' : 'Control+Comma'),
  today: (page) => page.getByRole('button', { name: 'Today', exact: true }).click(),
  tasks: (page) => page.getByRole('button', { name: 'Tasks', exact: true }).click(),
  dashboards: (page) => page.getByRole('button', { name: 'Dashboards', exact: true }).click(),
  'new-bot': (page) => page.getByRole('button', { name: 'New bot', exact: true }).click(),
  routine: (page) => page.getByRole('button', { name: 'Routine', exact: true }).click(),
};
const wanted = args.filter((a) => a in SCREENS);
const screens = wanted.length ? wanted : Object.keys(SCREENS);
const out = join(root, value('--out', 'data/snaps'));
const viewport = { width: Number(value('--width', '1280')), height: Number(value('--height', '800')) };
const tree = args.includes('--tree');
const dark = args.includes('--dark');

const entry = join(root, 'server/dist/index.mjs');
const appDir = join(root, 'app/dist');
if (!existsSync(entry) || !existsSync(join(appDir, 'index.html'))) {
  console.error('Build first: pnpm --filter @leafbot/server build && pnpm --filter @leafbot/app build');
  process.exit(1);
}
// Playwright is the server's own dependency; its headless shell has no app bundle, so no Dock icon.
const requireFromServer = createRequire(join(root, 'server/package.json'));
const { chromium } = requireFromServer('playwright-core');

/**
 * The headless shell Playwright would use, or else the newest one already downloaded (another
 * Playwright version's shell works for screenshots), or the one LEAFBOT_SNAP_BROWSER names.
 * Undefined lets Playwright say how to download one.
 */
function headlessShell() {
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

const KEY = 'snap-access-key-0123456789abcdef';
const dir = mkdtempSync(join(tmpdir(), 'leafbot-snap-'));
const server = spawn(process.execPath, [entry], {
  env: {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LEAFBOT_HOST: '127.0.0.1',
    LEAFBOT_PORT: '0',
    LEAFBOT_DATA_DIR: dir,
    LEAFBOT_APP_DIR: appDir,
    LEAFBOT_ENGINE: 'fake',
    LEAFBOT_ACCESS_KEY: KEY,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stderr = '';
server.stderr.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
const ready = new Promise((resolve, reject) => {
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

// Set once the server has said where it listens.
let base;
const call = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${KEY}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
};

const SAMPLES = [
  'Hello! Can you summarise what you can do?',
  'Write a short plan with a table:\n\n| Step | Owner | Due |\n|---|---|---|\n| Draft | Ada | Mon |\n| Review | Lin | Wed |',
  'Here is some code to check:\n\n```ts\nexport const add = (a: number, b: number) => a + b;\n```',
  'And a formula: $$e^{i\\pi} + 1 = 0$$',
];

let browser;
try {
  base = await ready;
  // The owner gets a username and password, has been welcomed, and has one bot with a conversation.
  const password = 'snap-password-0123';
  await call('PUT', '/api/account', { username: 'snap', password });
  await call('PATCH', '/api/settings', { onboarded: true, grokMoveOffered: true });
  const bot = await call('POST', '/api/bots', { name: 'Writer', description: 'Drafts and reviews text' });
  const thread = await call('GET', `/api/bots/${bot.id}/main-thread`);
  for (const [i, text] of SAMPLES.entries()) {
    await call('POST', `/api/threads/${thread.id}/messages`, { clientId: `snap-message-${i}`, text });
    // The fake engine answers each in turn; the next waits for the reply.
    for (let tries = 0; tries < 100; tries++) {
      const messages = await call('GET', `/api/threads/${thread.id}/messages`);
      if (messages.filter((m) => m.role === 'assistant').length > i) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  browser = await chromium.launch({ headless: true, executablePath: headlessShell() });
  const context = await browser.newContext({
    viewport,
    colorScheme: dark ? 'dark' : 'light',
    locale: 'en-US',
  });
  const page = await context.newPage();
  // A script error on the page is said, since the picture alone may not show it.
  page.on('pageerror', (err) => console.error(`page error: ${err.message}`));
  // The account service is not reached from here: the app is told, as an older server would, that
  // the server has no account link to offer, so it opens without the account sign-in.
  await page.route('**/api/account-host', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 404, body: '{}' }) : route.continue(),
  );
  const login = await page.request.post(`${base}/api/login`, { data: { username: 'snap', password } });
  if (!login.ok()) throw new Error(`sign-in: ${login.status()}`);
  mkdirSync(out, { recursive: true });

  for (const screen of screens) {
    await page.goto(base);
    // A screen that never shows the conversation is still drawn, so what went wrong can be seen.
    const shown = await page
      .getByText(SAMPLES[0].slice(0, 20))
      .first()
      .waitFor({ timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    if (!shown) console.error(`${screen}: the conversation did not appear`);
    if (SCREENS[screen]) await SCREENS[screen](page);
    // Pages and dialogs load their code when first opened; the network falls quiet once they have.
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(500);
    const name = `${screen}${dark ? '-dark' : ''}`;
    await page.screenshot({ path: join(out, `${name}.png`) });
    if (tree) writeFileSync(join(out, `${name}.tree.yml`), await page.locator('body').ariaSnapshot());
    console.log(`${join(out, `${name}.png`)}${tree ? ` (+ ${name}.tree.yml)` : ''}`);
  }
} finally {
  await browser?.close();
  if (server.exitCode === null && server.signalCode === null) {
    server.kill('SIGTERM');
    await new Promise((r) => server.once('exit', r));
  }
  rmSync(dir, { recursive: true, force: true });
}
