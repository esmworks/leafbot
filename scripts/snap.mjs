#!/usr/bin/env node
// Draws screens of the app without a window, for a person or a coding agent to look at a change:
// it starts the built server with the fake engine in a new data folder, sets up an account, a bot
// and a conversation through the server's own API (the fake engine writes the replies), opens each
// screen in headless Chromium and writes a PNG and, with --tree, the page's accessibility tree.
// Nothing here is a test: it shows what a screen looks like now.
//
//   pnpm --filter @leafbot/server build && pnpm --filter @leafbot/app build
//   node scripts/snap.mjs [chat] [settings] [today] [tasks] [dashboards] [new-bot] [routine] [--tree] [--dark] [--out data/snaps] [--width 1280 --height 800]
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBuilt, converse, headlessShell, requireFromServer, root, startServer } from './snap-kit.mjs';

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
checkBuilt();

const KEY = 'snap-access-key-0123456789abcdef';
const SAMPLES = [
  'Hello! Can you summarise what you can do?',
  'Write a short plan with a table:\n\n| Step | Owner | Due |\n|---|---|---|\n| Draft | Ada | Mon |\n| Review | Lin | Wed |',
  'Here is some code to check:\n\n```ts\nexport const add = (a: number, b: number) => a + b;\n```',
  'And a formula: $$e^{i\\pi} + 1 = 0$$',
];

const dir = mkdtempSync(join(tmpdir(), 'leafbot-snap-'));
let browser;
let server;
try {
  server = await startServer(dir, KEY);
  const { base, call } = server;
  // The owner has been welcomed and has one bot with a conversation.
  await call('PATCH', '/api/settings', { onboarded: true, grokMoveOffered: true });
  const bot = await call('POST', '/api/bots', { name: 'Writer', description: 'Drafts and reviews text' });
  const thread = await call('GET', `/api/bots/${bot.id}/main-thread`);
  // The fake engine answers each in turn; the next waits for the reply.
  for (const [i, text] of SAMPLES.entries()) await converse(call, thread.id, `snap-message-${i}`, text);

  const { chromium } = requireFromServer('playwright-core');
  browser = await chromium.launch({ headless: true, executablePath: headlessShell(chromium) });
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
  // Signed in with the access key, as this computer's own app is.
  const login = await page.request.post(`${base}/api/access`, { data: { key: KEY } });
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
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
}
