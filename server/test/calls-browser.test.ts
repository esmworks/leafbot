import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Thread } from '@leafbot/shared';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { findBrowser } from '../src/browser/find';
import { OWNER_ID } from '../src/users';
import { testServer, waitFor, type TestServer } from './helpers';

/** A real browser: LEAFBOT_TEST_BROWSER, or one found on this machine. */
const BROWSER = process.env.LEAFBOT_TEST_BROWSER ?? findBrowser();

/**
 * A call's page as the bot's browser plays it: the other person's voice comes in a media element,
 * as meeting sites play what they receive. The browser here reaches the web only through the
 * server's own proxy, with WebRTC kept to it, so two connections in one page do not reach each
 * other; how a call's own tracks are taken is tested in call-capture.test.ts. Sound starts on a
 * click, as a browser asks of a page; the bot's click to join is that click.
 */
const CALL_PAGE = `<!doctype html><body><audio id="far" autoplay></audio><script>
  const ctx = new AudioContext();
  const tone = ctx.createOscillator();
  const out = ctx.createMediaStreamDestination();
  tone.connect(out);
  tone.start();
  const far = document.getElementById('far');
  far.srcObject = out.stream;
  addEventListener('pointerdown', () => { ctx.resume(); far.play(); });
  window.hangUp = () => out.stream.getTracks().forEach((t) => t.stop());
</script></body>`;

describe.skipIf(!BROWSER)('görüşme dinleme: botun gerçek tarayıcısında', () => {
  let site: Server;
  let base = '';
  let t: TestServer;
  let heard: number;

  beforeAll(async () => {
    site = createServer((_req, res) => {
      res.setHeader('content-type', 'text/html');
      res.end(CALL_PAGE);
    });
    await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => site.close(() => r())));

  beforeEach(async () => {
    t = await testServer({
      browserPath: BROWSER,
      browserSandbox: process.getuid?.() !== 0,
      browserLocalHosts: ['127.0.0.1'],
    });
    heard = 0;
    t.services.transcribe.available = async () => true;
    t.services.transcribe.transcribe = async () => `parça ${++heard}`;
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;

  it('sesi kayıtlar hâlinde yazıya döker; sayfa yenilense de dinler; kapanınca bitirir', async () => {
    const browser = t.services.ctx.browser;
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await browser.use(bot.id, (page) => page.goto(`${base}/call`, { waitUntil: 'load' }));
    await t.services.calls.start({ bot, threadId: thread.id, userId: OWNER_ID, segmentMs: 1500 });
    // The bot's click to join is what lets the page play sound.
    await browser.use(bot.id, (page) => page.mouse.click(5, 5));
    await waitFor(async () => heard >= 1, 15_000);
    expect((await browser.listenState(bot.id))?.tracks).toBe(1);

    // Joining may load another page: listening goes on there.
    await browser.use(bot.id, (page) => page.reload({ waitUntil: 'load' }));
    await browser.use(bot.id, (page) => page.mouse.click(5, 5));
    const before = heard;
    await waitFor(async () => heard > before, 15_000);
    expect((await browser.listenState(bot.id))?.listening).toBe(true);

    // The call ends: nobody is heard any more, and two checks later listening stops.
    await browser.use(bot.id, (page) => page.evaluate('window.hangUp()'));
    await waitFor(async () => (await browser.listenState(bot.id))?.tracks === 0, 10_000);
    await t.services.calls.check();
    await t.services.calls.check();
    expect(t.services.calls.listening(bot.id)).toBe(false);
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).toContain('sayfa görüşmeden çıktı');
  }, 60_000);
});
