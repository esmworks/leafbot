import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Message, MessageFile, Thread } from '@leafbot/shared';
import sharp from 'sharp';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findBrowser, findFfmpeg } from '../src/browser/find';
import { renderVideo, VideoError } from '../src/browser/render';
import { testServer, type TestServer } from './helpers';

const BROWSER = process.env.LEAFBOT_TEST_BROWSER ?? findBrowser();
const FFMPEG = process.env.LEAFBOT_TEST_FFMPEG ?? findFfmpeg();

const fileCards = (msgs: Message[]) =>
  msgs.filter((m) => m.role === 'assistant' && Array.isArray(m.props.files));

const toolNames = async (t: TestServer) => {
  const bot = await t.bot();
  const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
  await t.send(thread.id, 'merhaba');
  await t.services.turns.idle();
  return t.engine.requests.at(-1)!.tools.map((x) => x.name);
};

describe('ffmpeg programını bulma', () => {
  it('LEAFBOT_FFMPEG verilmişse yalnızca onu kullanır', () => {
    const has = (p: string) => p === '/opt/ff';
    expect(findFfmpeg({ LEAFBOT_FFMPEG: '/opt/ff', PATH: '/usr/bin' }, 'linux', has)).toBe('/opt/ff');
    expect(findFfmpeg({ LEAFBOT_FFMPEG: '/yok', PATH: '/opt' }, 'linux', () => false)).toBeNull();
  });

  it("PATH'teki ilk ffmpeg'i, yoksa Homebrew'un klasörünü bulur", () => {
    const at = (want: string) => (p: string) => p === want;
    expect(findFfmpeg({ PATH: '/a:/b' }, 'linux', at('/b/ffmpeg'))).toBe('/b/ffmpeg');
    // An app started from the Dock gets a short PATH without Homebrew.
    expect(findFfmpeg({ PATH: '/usr/bin:/bin' }, 'darwin', at('/opt/homebrew/bin/ffmpeg'))).toBe(
      '/opt/homebrew/bin/ffmpeg',
    );
    expect(findFfmpeg({ Path: 'C:\\ff\\bin' }, 'win32', at('C:\\ff\\bin\\ffmpeg.exe'))).toBe(
      'C:\\ff\\bin\\ffmpeg.exe',
    );
    expect(findFfmpeg({ PATH: '/a' }, 'linux', () => false)).toBeNull();
  });
});

describe('sayfayı videoya çevirme', () => {
  it('ffmpeg yoksa araç yoktur; tarayıcı ve ffmpeg varsa vardır', async () => {
    const without = await testServer({ browserPath: '/yok/chromium', ffmpegPath: null });
    try {
      const names = await toolNames(without);
      expect(names).toContain('page_to_image');
      expect(names).not.toContain('page_to_video');
    } finally {
      await without.dispose();
    }
    const both = await testServer({ browserPath: '/yok/chromium', ffmpegPath: '/yok/ffmpeg' });
    try {
      expect(await toolNames(both)).toContain('page_to_video');
      // The limits come from the code, filled into the description.
      const description = both.engine.requests
        .at(-1)!
        .tools.find((x) => x.name === 'page_to_video')!.description;
      expect(description).toContain("en çok 60; 60 fps'te en çok 30");
      expect(description).toContain('1920×1080');
      expect(description).not.toMatch(/\{\w+\}/);
    } finally {
      await both.dispose();
    }
  });

  it('çok kısa, çok uzun, çok büyük ya da React sayfasını tarayıcı açmadan geri çevirir', async () => {
    const t = await testServer({ browserPath: '/yok/chromium', ffmpegPath: '/yok/ffmpeg' });
    try {
      const bot = await t.bot();
      const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
      const dir = join(t.dataDir, 'workspaces', 'bots', bot.id, 'threads', thread.id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'a.html'), '<p>a</p>');
      writeFileSync(join(dir, 'b.jsx'), 'export default () => <p>b</p>;');
      const ask = async (input: Record<string, unknown>) => {
        await t.send(thread.id, `[araç:page_to_video ${JSON.stringify(input)}]`);
        await t.services.turns.idle();
        return (await t.messages(thread.id)).at(-1)!.text;
      };
      expect(await ask({ path: 'a.html', width: 100, height: 100, seconds: 40, fps: 60 })).toContain(
        'Bu kadar kare çok fazla',
      );
      expect(await ask({ path: 'a.html', width: 1920, height: 1080, seconds: 1, scale: 3 })).toContain(
        'Bu video çok büyük',
      );
      expect(await ask({ path: 'a.html', width: 100, height: 100, seconds: 0.01, fps: 30 })).toContain(
        'hiç kare olmaz',
      );
      expect(await ask({ path: 'b.jsx', width: 100, height: 100, seconds: 1 })).toContain(
        'yalnızca HTML sayfası',
      );
      expect(fileCards(await t.messages(thread.id))).toEqual([]);
    } finally {
      await t.dispose();
    }
  });
});

describe.skipIf(!BROWSER || !FFMPEG)('sayfayı videoya çevirme (tarayıcı ve ffmpeg ile)', () => {
  let t: TestServer;

  beforeEach(async () => {
    // Tests may run as root, where Chromium's own sandbox cannot start.
    t = await testServer({
      browserPath: BROWSER,
      browserSandbox: process.getuid?.() !== 0,
      ffmpegPath: FFMPEG,
    });
  });
  afterEach(() => t.dispose());

  /** Films the page and gives the video's card and a way to read a colour from any moment of it. */
  const film = async (page: string, input: Record<string, unknown>) => {
    const bot = await t.bot({ name: 'Yönetmen' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    const dir = join(t.dataDir, 'workspaces', 'bots', bot.id, 'threads', thread.id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'film.html'), page);
    await t.send(thread.id, `[araç:page_to_video ${JSON.stringify({ path: 'film.html', ...input })}]`);
    await t.services.turns.idle();
    const msgs = await t.messages(thread.id);
    const [card] = fileCards(msgs);
    // A failed film says why in the tool's answer, which beats a missing card in the report.
    if (!card) throw new Error(msgs.at(-1)!.text);
    const [file] = card.props.files as MessageFile[];
    const video = join(t.dataDir, 'workspaces', file!.path);
    /** Red or blue at `s` seconds, `x` of the way across the middle row: the encoding shifts exact values. */
    const colour = async (s: number, x = 0.5) => {
      const png = execFileSync(FFMPEG!, [
        ...['-loglevel', 'error', '-ss', String(s), '-i', video],
        ...['-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-'],
      ]);
      const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
      const i = (Math.floor(info.height / 2) * info.width + Math.floor(info.width * x)) * info.channels;
      return data[i]! > data[i + 2]! ? 'kırmızı' : 'mavi';
    };
    return { card: card!, file: file!, data: readFileSync(video), colour, last: msgs.at(-1)!.text };
  };

  it('window.render(t) ile her anı sayfanın kendisine çizdirir ve videoyu sormadan kart olarak gönderir', async () => {
    const { card, file, data, colour, last } = await film(
      `<style>body{margin:0;width:64px;height:64px}</style>
       <script>window.render = (t) => { document.body.style.background = t < 0.5 ? '#f00' : '#00f'; };</script>`,
      { width: 64, height: 64, seconds: 1, fps: 10, caption: 'Deneme' },
    );
    expect(card.text).toBe('Deneme');
    expect(file.name).toBe('film.mp4');
    expect(data.subarray(4, 8).toString()).toBe('ftyp');
    expect([await colour(0.2), await colour(0.8)]).toEqual(['kırmızı', 'mavi']);
    expect(last).toContain('Sayfadan 1 saniyelik video yapıldı');
  });

  it('yüklenirken biten kısa bir animasyonu da baştan çeker', async () => {
    // A short animation with no fill: it ends before the page has settled unless it is held.
    const { colour } = await film(
      `<style>body{margin:0;width:64px;height:64px}
         @keyframes k{0%,49%{background:#00f}50%,100%{background:#f00}}
         div{height:64px;background:#00f;animation:k .4s linear}</style><div></div>`,
      { width: 64, height: 64, seconds: 1, fps: 10 },
    );
    expect([await colour(0.1), await colour(0.3), await colour(0.7)]).toEqual(['mavi', 'kırmızı', 'mavi']);
  });

  it('ffmpeg çalışmazsa takılmadan ve sunucuyu düşürmeden hatayı söyler', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-ff-'));
    try {
      const broken = join(dir, 'ffmpeg');
      // Stops at once with a message, as a broken or wrong program would.
      writeFileSync(broken, '#!/bin/sh\necho bozuk program >&2\nexit 3\n', { mode: 0o755 });
      const server = await testServer({
        browserPath: BROWSER,
        browserSandbox: process.getuid?.() !== 0,
        ffmpegPath: broken,
      });
      // Replaced only once the new server is up, so the hook below never closes one twice.
      await t.dispose();
      t = server;
      await expect(
        film('<style>body{margin:0;width:64px;height:64px;background:#f00}</style>', {
          width: 64,
          height: 64,
          seconds: 2,
        }),
      ).rejects.toThrow('Kareler videoya çevrilemedi (ffmpeg): bozuk program');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sayfanın durdurduğu animasyonu bekletir, hızını ve SVG animasyonlarını izler', async () => {
    const { colour } = await film(
      `<style>body{margin:0;width:96px;height:32px;display:flex}div,svg{flex:1;height:32px}
         @keyframes k{0%,49%{background:#00f}50%,100%{background:#f00}}
         #held{background:#00f;animation:k 1s linear forwards;animation-play-state:paused}</style>
       <div id="held"></div><div id="fast"></div>
       <svg viewBox="0 0 32 32"><rect width="32" height="32" fill="#00f"><set attributeName="fill" to="#f00" begin="0.5s"/></rect></svg>
       <script>setTimeout(() => (document.getElementById('held').style.animationPlayState = 'running'), 1000);
         const a = document.getElementById('fast').animate(
           [{ background: '#00f' }, { background: '#00f', offset: 0.499 }, { background: '#f00', offset: 0.5 }, { background: '#f00' }],
           { duration: 2000, fill: 'forwards' });
         a.playbackRate = 2;</script>`,
      { width: 96, height: 32, seconds: 2, fps: 10 },
    );
    // Held until the script lets it go at one second, then half a second of its own to turn red.
    expect([await colour(0.8, 1 / 6), await colour(1.3, 1 / 6), await colour(1.7, 1 / 6)]).toEqual([
      'mavi',
      'mavi',
      'kırmızı',
    ]);
    // Twice as fast: its two seconds take one, so it turns red at half a second.
    expect([await colour(0.3, 0.5), await colour(0.7, 0.5)]).toEqual(['mavi', 'kırmızı']);
    // SVG's own animation follows the video's time, not the time the page took to load.
    expect([await colour(0.3, 5 / 6), await colour(0.8, 5 / 6)]).toEqual(['mavi', 'kırmızı']);
  });

  it('ilk karede sayfanın ilk requestAnimationFrame çizimi de vardır', async () => {
    const { colour } = await film(
      `<style>body{margin:0;width:64px;height:64px;background:#00f}</style>
       <script>requestAnimationFrame(() => (document.body.style.background = '#f00'));</script>`,
      { width: 64, height: 64, seconds: 0.5, fps: 10 },
    );
    expect(await colour(0)).toBe('kırmızı');
  });

  it('bir karede takılan ya da süresini aşan videoyu nedeniyle durdurur', async () => {
    const base = {
      executable: BROWSER!,
      sandbox: process.getuid?.() !== 0,
      ffmpeg: FFMPEG!,
      width: 32,
      height: 32,
      fps: 10,
      libraries: false,
    };
    const stuck = renderVideo({
      ...base,
      html: '<script>window.render = () => new Promise(() => {});</script>',
      seconds: 1,
      frameMs: 500,
    });
    await expect(stuck).rejects.toBeInstanceOf(VideoError);
    await expect(stuck).rejects.toMatchObject({ reason: 'stuck' });
    const long = renderVideo({ ...base, html: '<p>uzun</p>', seconds: 60, limitMs: 1500 });
    await expect(long).rejects.toMatchObject({ reason: 'timeout' });
  });

  it('CSS animasyonunu ve requestAnimationFrame ile yazılmış betiği gerçek zamandan bağımsız sarar', async () => {
    // Odd sides too: the encoder needs even ones and gets them by losing a row and a column.
    const { colour } = await film(
      `<style>body{margin:0;width:65px;height:33px;display:flex}
         @keyframes k{0%,49%{background:#f00}50%,100%{background:#00f}}
         #css{flex:1;animation:k 1s linear forwards}#js{flex:1;background:#f00}</style>
       <div id="css"></div><div id="js"></div>
       <script>const s = performance.now();
         const f = () => { if (performance.now() - s >= 1500) document.getElementById('js').style.background = '#00f';
           requestAnimationFrame(f); };
         requestAnimationFrame(f);</script>`,
      { width: 65, height: 33, seconds: 2, fps: 10 },
    );
    // The left half follows the CSS animation, the right half the script on its stopped clock.
    expect([await colour(0.3, 0.25), await colour(0.7, 0.25)]).toEqual(['kırmızı', 'mavi']);
    expect([await colour(1.2, 0.75), await colour(1.8, 0.75)]).toEqual(['kırmızı', 'mavi']);
  });
});
