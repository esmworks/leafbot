import type { Approval, Message, Thread } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { turnStallMinutes } from '../src/config';
import { schema } from '../src/db';
import { translator } from '../src/i18n';
import { stallText } from '../src/runtime/turns';
import { BASH_MAX_TIMEOUT_MS, stallLimits, TurnWatchdog, type Stall } from '../src/runtime/watchdog';
import { testServer, waitFor, type TestServer } from './helpers';

/** A watchdog on a clock the test moves; its own timer never fires during a test. */
function watched(o: { waiting?: () => boolean } = {}) {
  const clock = { now: 0 };
  const stalls: Stall[] = [];
  const dog = new TurnWatchdog({
    limits: { silenceMs: 60_000, toolSilenceMs: 600_000 },
    waiting: o.waiting ?? (() => false),
    onStall: (s) => stalls.push(s),
    now: () => clock.now,
    tickMs: 1_000,
  });
  /** Moves the clock in ticks, as the timer would, looking at each one. */
  const pass = (ms: number) => {
    for (let left = ms; left > 0; left -= 1_000) {
      clock.now += Math.min(1_000, left);
      dog.check();
    }
  };
  return { clock, stalls, dog, pass };
}

describe('tur bekçisi', () => {
  it('sessizlik sınırını aşan turu bir kez durdurur; her işaret saati baştan başlatır', () => {
    const { dog, stalls, pass } = watched();
    pass(59_000);
    dog.activity();
    pass(59_000);
    expect(stalls).toEqual([]);
    pass(1_000);
    expect(stalls).toEqual([{ cause: 'silent', ms: 60_000 }]);
    pass(120_000);
    expect(stalls).toHaveLength(1);
    dog.stop();
  });

  it('bir araç çalışırken daha uzun sessizliğe izin verir ve duran aracı adıyla söyler', () => {
    const { dog, stalls, pass } = watched();
    dog.activity({ id: 't1', name: 'Bash', running: true });
    pass(300_000);
    expect(stalls).toEqual([]);
    dog.activity({ id: 't1', name: 'Bash', running: false });
    pass(60_000);
    expect(stalls).toEqual([{ cause: 'silent', ms: 60_000 }]);

    const second = watched();
    second.dog.activity({ id: 't2', name: 'mcp__takvim__list_events', running: true });
    second.pass(600_000);
    expect(second.stalls).toEqual([{ cause: 'tool', ms: 600_000, tool: 'mcp__takvim__list_events' }]);
    dog.stop();
    second.dog.stop();
  });

  it('özet yazılırken araç sınırı kadar bekler; özet bitince sessizlik sınırı yeniden geçerli olur', () => {
    const { dog, stalls, pass } = watched();
    dog.compacting(true);
    pass(300_000);
    expect(stalls).toEqual([]);
    dog.compacting(false);
    pass(60_000);
    expect(stalls).toEqual([{ cause: 'silent', ms: 60_000 }]);
    dog.stop();
  });

  it('kişinin cevabını bekleyen tur sessiz sayılmaz; bekleme bitince saat oradan başlar', () => {
    let waiting = true;
    const { stalls, pass, dog } = watched({ waiting: () => waiting });
    pass(3_600_000);
    expect(stalls).toEqual([]);
    waiting = false;
    pass(59_000);
    expect(stalls).toEqual([]);
    pass(1_000);
    expect(stalls).toHaveLength(1);
    dog.stop();
  });

  it('bilgisayarın uykuda geçirdiği süreyi sessizlik saymaz', () => {
    const { clock, dog, stalls, pass } = watched();
    pass(30_000);
    // The timer fires once, two hours late: the process was not running meanwhile. Only the one
    // tick it should have taken counts.
    clock.now += 2 * 3_600_000;
    dog.check();
    expect(stalls).toEqual([]);
    pass(28_000);
    expect(stalls).toEqual([]);
    pass(1_000);
    expect(stalls).toEqual([{ cause: 'silent', ms: 60_000 }]);
    dog.stop();
  });

  it('araç sınırı kabuk komutunun ve bağlı uygulama çağrısının kendi sınırından uzundur', () => {
    const limits = stallLimits({
      silenceMs: 600_000,
      mcpCallTimeoutMs: 3_600_000,
      shellMaxMs: BASH_MAX_TIMEOUT_MS,
    });
    expect(limits.silenceMs).toBe(600_000);
    expect(limits.toolSilenceMs).toBeGreaterThan(3_600_000);
    expect(
      stallLimits({ silenceMs: 120_000, mcpCallTimeoutMs: 10_000, shellMaxMs: BASH_MAX_TIMEOUT_MS })
        .toolSilenceMs,
    ).toBeGreaterThan(BASH_MAX_TIMEOUT_MS);
  });

  it('sessizlik sınırı ayardan okunur ama kapatılamaz', () => {
    expect(turnStallMinutes(undefined)).toBe(10);
    expect(turnStallMinutes('30')).toBe(30);
    expect(turnStallMinutes('0')).toBe(10);
    expect(turnStallMinutes('-5')).toBe(10);
    expect(turnStallMinutes('kapalı')).toBe(10);
    expect(turnStallMinutes('1')).toBe(2);
    expect(turnStallMinutes('100000')).toBe(240);
  });

  it('durma notu aracın kısa adını ve dakikayı söyler', () => {
    const t = translator('tr');
    expect(stallText({ cause: 'silent', ms: 600_000 }, t)).toContain('10 dakikadır');
    const tool = stallText({ cause: 'tool', ms: 3_900_000, tool: 'mcp__takvim__list_events' }, t);
    expect(tool).toContain('list_events aracı 65 dakikadır');
    expect(tool).not.toContain('mcp__');
  });
});

describe('tur bekçisi sunucuda', () => {
  let t: TestServer;
  afterEach(() => t.dispose());

  const start = async (stall: { silenceMs: number; toolSilenceMs: number }) => {
    t = await testServer({ stall });
    const bot = await t.bot();
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    return thread;
  };
  const turnOf = async (m: Message) =>
    (await t.db.db.select().from(schema.turns).where(eq(schema.turns.id, m.turnId!)))[0]!;

  it('ses vermeyen turu durdurur, sağlayıcı hatası değil takıldı diye kaydeder ve sohbeti serbest bırakır', async () => {
    const thread = await start({ silenceMs: 300, toolSilenceMs: 5_000 });
    await t.send(thread.id, '[bekle:20000]');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    await t.services.turns.idle();
    const note = (await t.messages(thread.id)).at(-1)!;
    expect(note.role).toBe('error');
    expect(note.props).toMatchObject({ kind: 'stalled' });
    expect(note.text).toMatch(/hiçbir şey yapmadığı için durduruldu/);
    const turn = await turnOf(note);
    expect(turn.status).toBe('error');
    expect(turn.error).toMatch(/durduruldu/);
    expect(t.services.turns.isRunning(thread.id)).toBe(false);
    await t.send(thread.id, 'tekrar');
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Yankı: tekrar');
  });

  it('uzun süren bir araç sessizlik sınırını aşsa da araç sınırına kadar bekletilir', async () => {
    const thread = await start({ silenceMs: 300, toolSilenceMs: 5_000 });
    await t.send(thread.id, '[uzun-araç:1200]');
    await t.services.turns.idle();
    const last = (await t.messages(thread.id)).at(-1)!;
    expect(last.role).toBe('assistant');
    expect(last.text).toContain('Bash: bitti');
  });

  it('araç sınırını da aşan aracı adıyla söyleyerek durdurur', async () => {
    const thread = await start({ silenceMs: 300, toolSilenceMs: 800 });
    await t.send(thread.id, '[uzun-araç:20000]');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    await t.services.turns.idle();
    const note = (await t.messages(thread.id)).at(-1)!;
    expect(note.props).toMatchObject({ kind: 'stalled' });
    expect(note.text).toMatch(/Bash aracı \d+ dakikadır bitmediği için/);
  });

  it('onay kartı açıkken tur takıldı sayılmaz; cevap gelince devam eder', async () => {
    const thread = await start({ silenceMs: 300, toolSilenceMs: 800 });
    await t.send(thread.id, '[izin:Bash {"command":"git push origin main"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    await new Promise((r) => setTimeout(r, 1_500));
    expect(t.services.turns.isRunning(thread.id)).toBe(true);
    expect((await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body).toHaveLength(1);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Bash: izin verildi');
  });
});
