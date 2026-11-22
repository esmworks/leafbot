import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Approval, Message, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CALL_QUIET_MS } from '../src/services/calls';
import { OWNER_ID } from '../src/users';
import { workspacePaths } from '../src/workspace';
import { testServer, waitFor, type TestServer } from './helpers';

/**
 * The bot's browser stands in: the test hands recordings in as the page would, and says whether the
 * page still listens. The speech-to-text service gives back the recording's own bytes as words.
 */
describe('görüşme dinleme', () => {
  let t: TestServer;
  let hear: ((audio: Buffer) => void) | null;
  let pageListens: boolean;
  /** The page between two documents: there, but not listening until the next one loads. */
  let loading: boolean;
  let unlistened: number;
  beforeEach(async () => {
    t = await testServer();
    hear = null;
    pageListens = true;
    loading = false;
    unlistened = 0;
    const browser = t.services.ctx.browser;
    Object.defineProperty(browser, 'available', { value: true });
    browser.listen = async (_botId, onAudio) => {
      hear = onAudio;
    };
    // Stopping hands over the recording under way, as the page does.
    browser.unlisten = async () => {
      hear?.(Buffer.from('Son söz.'));
      unlistened++;
      hear = null;
    };
    browser.listenState = async () =>
      !pageListens
        ? null
        : loading
          ? { listening: false, tracks: 0, audio: 'none' }
          : { listening: true, tracks: 1, audio: 'running' };
    t.services.transcribe.available = async () => true;
    t.services.transcribe.transcribe = async (audio) => audio.toString('utf8');
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const pending = async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
  const toolNames = () => t.engine.requests.at(-1)!.tools.map((x) => x.name);

  it('tam izinli botta bile her seferinde sorar, “hep izin ver” sunmaz; konuşulanlar dosyaya yazılır', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:call_listen]');
    const card = await waitFor(async () => (await pending())[0]);
    expect(card.toolName).toBe('mcp__leafbot__call_listen');
    const approval = (await t.messages(thread.id)).find((m: Message) => m.role === 'approval')!;
    expect(approval.text).toContain('tarayıcısında açık görüşmeyi yazıya dökmek istiyor');
    expect(approval.props.noAlways).toBe(true);
    expect(hear).toBeNull();

    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('calls/');
    expect(hear).not.toBeNull();

    hear!(Buffer.from('Toplantıya hoş geldiniz.'));
    hear!(Buffer.from(''));
    hear!(Buffer.from('Bütçe kararı cumaya kaldı.'));
    // The status waits for the recordings already heard to be written out.
    const status = await t.services.calls.status(bot.id, thread.id);
    expect(status!.lines).toBe(2);
    const file = join(
      workspacePaths(t.services.ctx.config.dataDir, bot.id, thread.id, null).threadDir,
      status!.file,
    );
    const written = readFileSync(file, 'utf8');
    expect(written).toMatch(/\] Toplantıya hoş geldiniz\.\n/);
    expect(written).toMatch(/\] Bütçe kararı cumaya kaldı\.\n/);

    // Stopping is not asked about; the transcript comes back as what people in the call said.
    await t.send(thread.id, '[araç:call_stop]');
    await t.services.turns.idle();
    expect(await pending()).toEqual([]);
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('Bütçe kararı cumaya kaldı.');
    expect(reply).toContain('Son söz.');
    expect(reply).toContain('outside-data');
    expect(unlistened).toBe(1);
    expect(t.services.calls.listening(bot.id)).toBe(false);
  });

  it('sayfa görüşmeden çıkınca dinleme biter ve bot not yazması için yeniden çağrılır', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.services.calls.start({ bot, threadId: thread.id, userId: OWNER_ID });
    hear!(Buffer.from('Herkese merhaba.'));
    await t.services.calls.check();
    expect(t.services.calls.listening(bot.id)).toBe(true);

    pageListens = false;
    const before = t.engine.requests.length;
    await t.services.calls.check();
    expect(t.services.calls.listening(bot.id)).toBe(false);
    await t.services.turns.idle();
    const woke = t.engine.requests.at(-1)!;
    expect(t.engine.requests.length).toBe(before + 1);
    expect(woke.prompt).toContain('sayfa görüşmeden çıktı');
    expect(woke.prompt).toMatch(/calls\/\d{4}-\d{2}-\d{2}-\d{4}\.md/);
    // A wake-up for a call is not the person's own message: listening again is not offered there.
    expect(toolNames()).not.toContain('call_listen');
  });

  it('başka bir sohbetten görüşme okunamaz ve durdurulamaz', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.services.calls.start({ bot, threadId: thread.id, userId: OWNER_ID });
    hear!(Buffer.from('Gizli konu.'));
    expect(await t.services.calls.status(bot.id, 'baska-sohbet')).toBeNull();
    expect(await t.services.calls.stop(bot.id, 'bot', 'baska-sohbet')).toBeNull();
    expect(t.services.calls.listening(bot.id)).toBe(true);
    expect((await t.services.calls.status(bot.id, thread.id))!.text).toContain('Gizli konu.');
  });

  it('sayfa yeni belgesini yüklerken dinleme bitmez; iki kontrol üst üste dinlemiyorsa biter', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.services.calls.start({ bot, threadId: thread.id, userId: OWNER_ID });
    loading = true;
    await t.services.calls.check();
    expect(t.services.calls.listening(bot.id)).toBe(true);
    loading = false;
    await t.services.calls.check();
    loading = true;
    await t.services.calls.check();
    expect(t.services.calls.listening(bot.id)).toBe(true);
    await t.services.calls.check();
    expect(t.services.calls.listening(bot.id)).toBe(false);
  });

  it('aynı anda iki başlatmadan biri reddedilir, dinleyen görüşme kaybolmaz', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const both = await Promise.allSettled([
      t.services.calls.start({ bot, threadId: thread.id, userId: OWNER_ID }),
      t.services.calls.start({ bot, threadId: thread.id, userId: OWNER_ID }),
    ]);
    expect(both.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(t.services.calls.listening(bot.id)).toBe(true);
    hear!(Buffer.from('Duyuldu.'));
    expect((await t.services.calls.status(bot.id, thread.id))!.lines).toBe(1);
  });

  it('aynı dakikada başlayan ikinci görüşme öncekinin dökümünü silmez', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    const first = await t.services.calls.start({ bot, threadId: thread.id, userId: OWNER_ID });
    hear!(Buffer.from('İlk görüşme.'));
    await t.services.calls.stop(bot.id, 'bot', thread.id);
    const second = await t.services.calls.start({ bot, threadId: thread.id, userId: OWNER_ID });
    expect(second.file).not.toBe(first.file);
    const dir = workspacePaths(t.services.ctx.config.dataDir, bot.id, thread.id, null).threadDir;
    expect(readFileSync(join(dir, first.file), 'utf8')).toContain('İlk görüşme.');
  });

  it('dinleme sürerken salt okunur olan bot görüşmeye bakabilir ve durdurabilir, yenisini başlatamaz', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.services.calls.start({ bot, threadId: thread.id, userId: OWNER_ID });
    await t.api('PATCH', `/api/bots/${bot.id}`, { permissionMode: 'readonly' });
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(
      toolNames()
        .filter((n) => n.startsWith('call_'))
        .sort(),
    ).toEqual(['call_status', 'call_stop']);
  });

  it('uzun süre kimse konuşmazsa biter', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.services.calls.start({ bot, threadId: thread.id, userId: OWNER_ID });
    await t.services.calls.check(t.now.value.getTime() + CALL_QUIET_MS - 60_000);
    expect(t.services.calls.listening(bot.id)).toBe(true);
    await t.services.calls.check(t.now.value.getTime() + CALL_QUIET_MS + 60_000);
    expect(t.services.calls.listening(bot.id)).toBe(false);
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).toContain('uzun süre kimse konuşmadı');
  });

  it('konuşma servisi yoksa dinlemez; yalnız kişinin kendi işinde sunulur', async () => {
    t.services.transcribe.available = async () => false;
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:call_listen]');
    const card = await waitFor(async () => (await pending())[0]);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('konuşmayı yazıya çeviren bir servis yok');
    expect(hear).toBeNull();

    await t.api('PATCH', `/api/bots/${bot.id}`, { permissionMode: 'readonly' });
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(toolNames().filter((n) => n.startsWith('call_'))).toEqual([]);
  });
});
