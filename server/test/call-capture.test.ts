import { chromium, type Browser, type Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CALL_BINDING, captureScript, type CaptureState } from '../src/browser/call-capture';
import { findBrowser } from '../src/browser/find';
import { waitFor } from './helpers';

/**
 * A call in one page: two connections looped back to each other, one sending a tone as the other
 * person's voice. The page plays what it receives, as a meeting page does.
 */
const CALL_PAGE = (gain: number) => `<!doctype html><body><audio id="far" autoplay></audio><script>
  (async () => {
    const ctx = new AudioContext();
    const tone = ctx.createOscillator();
    const level = ctx.createGain();
    level.gain.value = ${gain};
    const out = ctx.createMediaStreamDestination();
    tone.connect(level).connect(out);
    tone.start();
    const a = new RTCPeerConnection();
    const b = new RTCPeerConnection();
    a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
    b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
    b.ontrack = (e) => { document.getElementById('far').srcObject = e.streams[0] || new MediaStream([e.track]); };
    out.stream.getTracks().forEach((t) => a.addTrack(t, out.stream));
    await a.setLocalDescription(await a.createOffer());
    await b.setRemoteDescription(a.localDescription);
    await b.setLocalDescription(await b.createAnswer());
    await a.setRemoteDescription(b.localDescription);
  })();
</script></body>`;

/** A real browser: LEAFBOT_TEST_BROWSER, or one found on this machine. */
const BROWSER = process.env.LEAFBOT_TEST_BROWSER ?? findBrowser();
let browser: Browser | null = null;

beforeAll(async () => {
  if (!BROWSER) return;
  browser = await chromium.launch({
    executablePath: BROWSER,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
  });
});
afterAll(async () => {
  await browser?.close();
});

async function callPage(gain: number): Promise<{ page: Page; chunks: string[] }> {
  const context = await browser!.newContext();
  const chunks: string[] = [];
  await context.exposeBinding(CALL_BINDING, (_src, audio: string) => {
    chunks.push(audio);
  });
  await context.addInitScript(captureScript(1500));
  const page = await context.newPage();
  // A real navigation: scripts added for new documents do not run in a page written in place.
  await page.route('https://call.test/', (route) =>
    route.fulfill({ contentType: 'text/html', body: CALL_PAGE(gain) }),
  );
  await page.goto('https://call.test/');
  return { page, chunks };
}

const state = (page: Page) => page.evaluate('window.__leafbotCall.state()') as Promise<CaptureState>;

describe('görüşme dinleme betiği', () => {
  it('sayfanın aldığı sesi kısa kayıtlar hâlinde dışarı verir', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, chunks } = await callPage(0.5);
    await page.evaluate('window.__leafbotCall.start()');
    await waitFor(async () => (await state(page)).tracks > 0, 10_000);
    await waitFor(async () => chunks.length > 0, 10_000);
    const first = Buffer.from(chunks[0]!, 'base64');
    // A whole WebM file on its own, as a speech-to-text service takes it.
    expect(first.subarray(0, 4).toString('hex')).toBe('1a45dfa3');
    expect(first.length).toBeGreaterThan(1000);
    await page.evaluate('window.__leafbotCall.stop()');
    expect((await state(page)).listening).toBe(false);
    await page.context().close();
  }, 30_000);

  it('sessizliği göndermez; dinleme başlamadan bir şey vermez', async (ctx) => {
    if (!browser) return ctx.skip();
    const { page, chunks } = await callPage(0);
    await page.waitForTimeout(2000);
    expect(chunks).toEqual([]);
    await page.evaluate('window.__leafbotCall.start()');
    await waitFor(async () => (await state(page)).tracks > 0, 10_000);
    await page.waitForTimeout(3500);
    expect(chunks).toEqual([]);
    await page.context().close();
  }, 30_000);
});
