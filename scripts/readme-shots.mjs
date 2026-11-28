#!/usr/bin/env node
// Draws the README's screenshots from made-up bots, conversations, tasks and a shop's orders, so the
// pictures show the app as it is now without anyone's own data in them. It starts the built server
// with the fake engine in a new data folder, sets everything up through the server's own API (the
// fake engine calls the table and dashboard tools when asked), then stops the server and writes the
// bots' replies into the database: the fake engine only echoes, and a picture needs real sentences.
// The server starts again on the same folder and headless Chromium draws each screen at 2x.
//
//   pnpm --filter @leafbot/server build && pnpm --filter @leafbot/app build
//   node scripts/readme-shots.mjs [--dark] [--out docs/screenshots]
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { checkBuilt, converse, headlessShell, requireFromServer, root, startServer } from './snap-kit.mjs';

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const outArg = value('--out', 'docs/screenshots');
const out = isAbsolute(outArg) ? outArg : join(root, outArg);
const dark = args.includes('--dark');
checkBuilt();
// The server writes its own messages (and the bots answer) in the language it starts in.
process.env.LANG = 'en_US.UTF-8';

const KEY = 'readme-shots-access-key-0123456789';
const TZ = 'Europe/London';
const HOST = 'bots.home';

// The cast. Pinned bots sit at the top of the sidebar; the others are in two team spaces.
const SPACES = { home: 'Home', work: 'Fernhill Ceramics' };
const BOTS = [
  {
    key: 'scout',
    name: 'Scout',
    description: 'Researches products, prices and places, and compares them in a table.',
    color: '#2f9e6a',
    avatar: 'object:circle',
    pinned: true,
  },
  {
    key: 'chef',
    name: 'Chef',
    description: "Plans the week's meals and writes the shopping list.",
    color: '#f0743e',
    avatar: 'object:mug',
    pinned: true,
  },
  {
    key: 'planner',
    name: 'Planner',
    description: 'Plans trips and keeps the family calendar tidy.',
    color: '#2a9fd6',
    avatar: 'object:cloud',
    pinned: true,
  },
  {
    key: 'ledger',
    name: 'Ledger',
    description: 'Keeps the household budget and spots subscriptions to cancel.',
    color: '#e0a526',
    avatar: 'object:square',
    space: 'home',
  },
  {
    key: 'postman',
    name: 'Postman',
    description: 'Sorts the inbox every morning and drafts the replies.',
    color: '#4f6bed',
    avatar: 'object:drop',
    space: 'home',
  },
  {
    key: 'till',
    name: 'Till',
    description: "Keeps the shop's orders and stock in tables and draws the shop dashboard.",
    color: '#1f7a8c',
    avatar: 'object:hexagon',
    space: 'work',
  },
  {
    key: 'quill',
    name: 'Quill',
    description: "Writes the shop's product pages and the monthly newsletter.",
    color: '#8b5cf6',
    avatar: 'object:lightbulb',
    space: 'work',
  },
  {
    key: 'patch',
    name: 'Patch',
    description: "Looks after the shop's website and fixes what breaks.",
    color: '#d6457a',
    avatar: 'object:controller',
    space: 'work',
  },
];

// The shop's orders this month, made up the same way on every run.
const PRODUCTS = [
  ['Speckled mug', 28],
  ['Stoneware bowl', 34],
  ['Serving platter', 72],
  ['Bud vase', 26],
  ['Teapot', 89],
  ['Planter', 45],
];
const CUSTOMERS = [
  'Ines R.',
  'Tom W.',
  'Maya K.',
  'Leo B.',
  'Priya S.',
  'Owen H.',
  'Ada L.',
  'Sam P.',
  'Noor A.',
];
function orders() {
  let seed = 7;
  const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const rows = [];
  for (let day = 1; day <= 27; day++) {
    const count = day % 7 === 0 || day % 7 === 6 ? 3 + Math.floor(rand() * 3) : 1 + Math.floor(rand() * 3);
    for (let i = 0; i < count; i++) {
      const [product, price] = PRODUCTS[Math.floor(rand() * PRODUCTS.length)];
      const qty = 1 + Math.floor(rand() * 3);
      rows.push({
        Date: `2026-11-${String(day).padStart(2, '0')}`,
        Order: `FC-${1040 + rows.length}`,
        Customer: CUSTOMERS[Math.floor(rand() * CUSTOMERS.length)],
        Product: product,
        Quantity: qty,
        Sales: price * qty,
        Status: day >= 26 ? 'To ship' : 'Shipped',
      });
    }
  }
  return rows;
}

const TILES = [
  {
    title: 'Daily sales',
    show: 'bar',
    table: 'Orders',
    period: 'month',
    date_column: 'Date',
    measure: 'sum',
    column: 'Sales',
    bucket: 'day',
    wide: true,
  },
  {
    title: 'Sales this month (€)',
    show: 'number',
    table: 'Orders',
    period: 'month',
    measure: 'sum',
    column: 'Sales',
  },
  {
    title: 'Monthly goal',
    show: 'progress',
    table: 'Orders',
    period: 'month',
    measure: 'sum',
    column: 'Sales',
    goal: 9000,
    ring: false,
  },
  { title: 'Orders this month', show: 'number', table: 'Orders', period: 'month', measure: 'count' },
  {
    title: 'Best sellers',
    show: 'bar',
    table: 'Orders',
    period: 'month',
    measure: 'sum',
    column: 'Sales',
    group_by: 'Product',
  },
  {
    title: 'Latest orders',
    show: 'rows',
    table: 'Orders',
    columns: ['Date', 'Customer', 'Product', 'Sales', 'Status'],
    limit: 5,
    wide: true,
  },
];

// What each bot was asked, and the reply written over the fake engine's echo. `ask` is what the
// fake engine reads; `shown` replaces it when the person's words carry the engine's directives.
const CONVERSATIONS = [
  {
    bot: 'patch',
    ask: 'Is the checkout working again?',
    reply:
      'Not yet. Orders with a gift note still fail at the payment step: the note is longer than the payment provider takes. I opened a task with the fix and will deploy it once you approve.',
  },
  {
    bot: 'quill',
    ask: 'Write a short product page for the speckled mug.',
    reply:
      '**Speckled mug, 350 ml.** Thrown by hand in our studio and glazed in oatmeal with iron flecks, so no two are alike. Dishwasher safe, and it keeps tea hot a little longer than you expect. I saved it to the Library next to the photos.',
  },
  {
    bot: 'till',
    ask: () =>
      [
        `[araç:table_define ${JSON.stringify({
          name: 'Orders',
          columns: [
            { name: 'Date', type: 'date' },
            { name: 'Order', type: 'text' },
            { name: 'Customer', type: 'text' },
            { name: 'Product', type: 'text' },
            { name: 'Quantity', type: 'number' },
            { name: 'Sales', type: 'number' },
            { name: 'Status', type: 'text' },
          ],
        })}]`,
        `[araç:table_add ${JSON.stringify({ table: 'Orders', rows: orders() })}]`,
        `[araç:dashboard_define ${JSON.stringify({ name: 'Shop', tiles: TILES })}]`,
      ].join(' '),
    shown: 'Set up a shop dashboard from the orders table.',
    reply:
      "Done. The **Shop** dashboard shows daily sales, this month's total against the €9,000 goal, the best sellers and the latest orders. It reads the Orders table, so it stays current as orders come in.",
  },
  {
    bot: 'postman',
    ask: 'Anything urgent in the inbox?',
    reply:
      'Three emails need you today: the café in Leeds wants a wholesale price list, the kiln repair is confirmed for Tuesday, and the accountant asks for October receipts. Drafts for all three are waiting for your yes.',
  },
  {
    bot: 'ledger',
    ask: 'How much did we spend on subscriptions in November?',
    reply:
      'Four renew in November, €62.97 in all. Two streaming services were not opened once this month; cancelling them saves €21.98 a month. Shall I put both on the cancel list?',
  },
  {
    bot: 'planner',
    ask: 'Find a free weekend in December for the Edinburgh trip.',
    reply:
      'The weekend of 12–14 December is free in both calendars. Trains leave at 08:30 and arrive at 12:52; I held two seats until tomorrow evening.',
  },
  {
    bot: 'chef',
    ask: 'What is for dinner this week? Two of us, nothing with mushrooms.',
    reply:
      'Five dinners planned, the shopping list is in the Library: lentil soup, salmon with greens, a tray of roast vegetables, chicken tacos and a Friday pizza.',
  },
  {
    bot: 'scout',
    ask: 'Find three standing desks under €500 that ship to Berlin, and compare them.',
    reply: [
      'I looked at eleven desks from five shops and kept the three with the best reviews that deliver to Berlin within a week.',
      '',
      '| Desk | Price | Height range | Motors | Warranty | Delivery |',
      '|---|---|---|---|---|---|',
      '| Flexispot E7 | €449 | 58–123 cm | 2 | 5 years | 3–5 days |',
      '| Ergotopia Desktopia Pro | €499 | 62–128 cm | 2 | 5 years | 2–4 days |',
      '| IKEA Mittzon | €399 | 63–128 cm | 1 | 10 years | 5–7 days |',
      '',
      '**My pick: the Flexispot E7.** Two motors keep it steady at standing height, it is the quietest of the three in reviews, and it fits your 160 cm wall.',
      '',
      'The Mittzon is the one to choose if you want the longest warranty and do not mind a slower single motor.',
    ].join('\n'),
  },
  {
    bot: 'scout',
    ask: 'Great. Watch the E7 and tell me if it drops below €420.',
    reply:
      'Done. I set up a **Price watch** routine that checks the Flexispot page every morning at 9:00 and only messages you when the price goes under €420.',
  },
];

const ROUTINES = [
  {
    bot: 'scout',
    name: 'Price watch',
    prompt: 'Check the Flexispot E7 page. Message me only when the price is under €420.',
    schedule: { type: 'daily', time: '09:00' },
  },
  {
    bot: 'till',
    name: 'Weekly shop report',
    prompt:
      "Read this week's orders and stock. Write a short report: sales against last week, the best sellers, and what runs out within two weeks.",
    schedule: { type: 'weekly', days: [5], time: '17:00' },
    steps: [
      {
        id: 'note',
        kind: 'agent',
        prompt:
          'Turn the report into a two-paragraph note for the team, with the three numbers that matter most.',
      },
      { id: 'ok', kind: 'approval', question: "Send this week's report to the team?" },
      { id: 'send', kind: 'notify', text: "This week's report is out." },
    ],
  },
  {
    bot: 'postman',
    name: 'Morning inbox',
    prompt: 'Sort the inbox, draft replies to what needs one, and list what needs me today.',
    schedule: { type: 'weekdays', time: '07:30' },
  },
  {
    bot: 'ledger',
    name: 'Subscription check',
    prompt: 'List the subscriptions that renew this month and the ones nobody used.',
    schedule: { type: 'monthly', day: 1, time: '09:00' },
  },
];

const TICKETS = [
  ['Photograph the winter glaze collection', 'quill', 'normal', 'todo'],
  ['Compare courier rates for parcels over 5 kg', 'scout', 'normal', 'todo'],
  ['Plan Sunday lunch for eight, one vegetarian', 'chef', 'low', 'todo'],
  ['Move the newsletter sign-up into the footer', 'patch', 'high', 'todo'],
  ['Draft the December newsletter: gift guide and last shipping dates', 'quill', 'high', 'in_review'],
  ['Cancel the two streaming services nobody watched in November', 'ledger', 'normal', 'in_review'],
  ['Reply to the wholesale enquiry from the café in Leeds', 'postman', 'normal', 'in_review'],
  ['Restock speckled mugs: the kiln is booked until 4 December', 'till', 'urgent', 'blocked'],
  ['Fix the checkout error on orders with a gift note', 'patch', 'urgent', 'blocked'],
  ['Book train seats to Edinburgh for 12 December', 'planner', 'normal', 'done'],
  ["Update shipping prices after the courier's new rates", 'till', 'normal', 'done'],
];
const TICKET_NOTES = {
  'Restock speckled mugs: the kiln is booked until 4 December':
    'Eight left in stock and selling three a day. Waiting for a kiln slot before the next batch can be fired.',
  'Fix the checkout error on orders with a gift note':
    'Gift notes over 140 characters are cut off by the payment provider and the order fails. Fix ready; needs approval to deploy.',
  'Move the newsletter sign-up into the footer':
    'The pop-up asks too early. A plain field in the footer, with the same list behind it.',
  'Draft the December newsletter: gift guide and last shipping dates':
    'Six gifts under €50, the last day to order for Christmas delivery, and the studio sale on the 14th.',
};

async function seed(call) {
  await call('PATCH', '/api/settings', { onboarded: true, grokMoveOffered: true, userName: 'Alex' });
  const spaceIds = {};
  for (const [key, name] of Object.entries(SPACES)) {
    const g = await call('POST', '/api/groups', { name, space: true, kind: 'open' });
    spaceIds[key] = g.id;
  }
  const ids = {};
  for (const b of BOTS) {
    const bot = await call('POST', '/api/bots', {
      name: b.name,
      description: b.description,
      color: b.color,
      avatar: b.avatar,
    });
    ids[b.key] = bot.id;
    // A new bot starts in its maker's Private and is moved from there.
    await call('POST', `/api/bots/${bot.id}/move`, {
      pinned: !!b.pinned,
      groupId: b.space ? spaceIds[b.space] : null,
      beforeId: null,
    });
  }
  for (const r of ROUTINES) {
    await call('POST', '/api/routines', {
      botId: ids[r.bot],
      name: r.name,
      prompt: r.prompt,
      schedule: r.schedule,
      steps: r.steps ?? [],
      timezone: TZ,
      enabled: true,
    });
  }
  // A bot starts on a task given to it at once, and on one put back to do or under way, so tasks
  // still to do are left unassigned and nothing is shown under way.
  const wanted = new Map();
  for (const [title, bot, priority, status] of TICKETS) {
    const ticket = await call('POST', '/api/tickets', {
      title,
      description: TICKET_NOTES[title] ?? '',
      priority,
      assigneeBotId: status === 'todo' ? null : ids[bot],
    });
    wanted.set(ticket.id, status);
  }
  // The fake engine hands each assigned task over for review; once every one has, each goes to the
  // column the picture wants.
  const settled = (x) => !wanted.has(x.id) || wanted.get(x.id) === 'todo' || x.status === 'in_review';
  for (let tries = 0; tries < 200; tries++) {
    const tickets = await call('GET', '/api/tickets');
    if (tickets.every(settled)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  for (const [id, status] of wanted) await call('PATCH', `/api/tickets/${id}`, { status });
  await new Promise((r) => setTimeout(r, 1500));
  for (const x of await call('GET', '/api/tickets')) {
    if (wanted.has(x.id) && x.status !== wanted.get(x.id)) {
      console.error(`task "${x.title}" is ${x.status}, not ${wanted.get(x.id)}`);
    }
  }
  // The rewrites to make once the server has stopped: message id → text.
  const rewrites = [];
  for (const [i, c] of CONVERSATIONS.entries()) {
    const thread = await call('GET', `/api/bots/${ids[c.bot]}/main-thread`);
    const ask = typeof c.ask === 'function' ? c.ask() : c.ask;
    const { mine, reply } = await converse(call, thread.id, `readme-${i}`, ask);
    if (c.shown) {
      // What the tools said, so a refused or missing tool shows here rather than as an empty tile.
      console.log(`${c.bot}: ${reply.text.replace(/\s+/g, ' ').slice(0, 600)}`);
      rewrites.push([mine.id, c.shown]);
    }
    rewrites.push([reply.id, c.reply]);
  }
  return { ids, rewrites };
}

/** Writes the replies over the fake engine's echo, while no server has the database open. */
async function rewrite(dataDir, rewrites) {
  const { PGlite } = requireFromServer('@electric-sql/pglite');
  const db = new PGlite(join(dataDir, 'db'));
  try {
    for (const [id, text] of rewrites)
      await db.query('update messages set text = $1 where id = $2', [text, id]);
  } finally {
    await db.close();
  }
}

// Each screen: how to open it from the app's first page, and a text that shows it is ready.
const SCREENS = {
  chat: {
    open: (page) => page.getByText('Scout', { exact: true }).first().click(),
    ready: 'Flexispot E7',
  },
  routine: {
    open: async (page) => {
      await page.getByText('Till', { exact: true }).first().click();
      await page.getByText('Weekly shop report').first().click();
      const flow = page.getByRole('button', { name: 'Flow', exact: true });
      if (await flow.isVisible().catch(() => false)) await flow.click();
    },
    ready: 'Start',
  },
  dashboards: {
    open: (page) => page.getByRole('button', { name: 'Dashboards', exact: true }).click(),
    ready: 'Daily sales',
  },
  tasks: {
    open: (page) => page.getByRole('button', { name: 'Tasks', exact: true }).click(),
    ready: 'Photograph the winter glaze collection',
  },
  apps: {
    open: (page) => page.getByRole('button', { name: 'Apps', exact: true }).click(),
    ready: 'Gmail',
  },
};

const dir = mkdtempSync(join(tmpdir(), 'leafbot-readme-'));
let browser;
let server;
try {
  server = await startServer(dir, KEY);
  const { rewrites } = await seed(server.call);
  await server.stop();
  await rewrite(dir, rewrites);
  server = await startServer(dir, KEY, { LEAFBOT_ALLOWED_HOSTS: HOST });
  // The page is opened at a name of its own: a server reached at its address shows that address
  // under the person's name, and 127.0.0.1 with a random port says nothing in a picture.
  const site = `http://${HOST}`;
  const port = new URL(server.base).port;

  const { chromium } = requireFromServer('playwright-core');
  browser = await chromium.launch({
    headless: true,
    executablePath: headlessShell(chromium),
    args: [`--host-resolver-rules=MAP ${HOST}:80 127.0.0.1:${port}`],
  });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    // Without motion the bots' eyes are drawn open, not caught mid-blink.
    reducedMotion: 'reduce',
    colorScheme: dark ? 'dark' : 'light',
    locale: 'en-US',
    timezoneId: TZ,
  });
  const page = await context.newPage();
  page.on('pageerror', (err) => console.error(`page error: ${err.message}`));
  // The account service is not reached from here: the app is told the server has no account link
  // to offer, so it opens without the account sign-in.
  await page.route('**/api/account-host', (route) =>
    route.request().method() === 'GET' ? route.fulfill({ status: 404, body: '{}' }) : route.continue(),
  );
  // Signed in from the page, so the session cookie belongs to the name the page is opened at.
  await page.goto(site);
  const login = await page.evaluate(
    (key) =>
      fetch('/api/access', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ key }),
      }).then((r) => r.status),
    KEY,
  );
  if (login >= 300) throw new Error(`sign-in: ${login}`);
  mkdirSync(out, { recursive: true });

  for (const [name, screen] of Object.entries(SCREENS)) {
    await page.goto(site);
    await page.getByText('Scout', { exact: true }).first().waitFor({ timeout: 15_000 });
    await screen.open(page);
    const shown = await page
      .getByText(screen.ready)
      .first()
      .waitFor({ timeout: 15_000 })
      .then(
        () => true,
        () => false,
      );
    if (!shown) console.error(`${name}: "${screen.ready}" did not appear`);
    await page.waitForLoadState('networkidle').catch(() => {});
    await page.waitForTimeout(800);
    const file = join(out, `${name}${dark ? '-dark' : ''}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
} finally {
  await browser?.close();
  await server?.stop();
  rmSync(dir, { recursive: true, force: true });
}
