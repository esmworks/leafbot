import {
  describeAction,
  type Approval,
  type Bot,
  type BotSummary,
  type Memory,
  type MemoryChange,
  type Routine,
  type RoutineRun,
  type Thread,
} from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNER_ID } from '../src/users';
import { eq } from 'drizzle-orm';
import { schema } from '../src/db';
import { MEMORY_PROMPT_CHARS } from '../src/runtime/prompt';
import { newId } from '../src/util';
import { testServer, waitFor, type TestServer } from './helpers';

describe('hafıza', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  /** Lets the turns finish, approving any memory card; returns what the cards said (none ask now). */
  const approving = async () => {
    const asked: string[] = [];
    for (;;) {
      try {
        await t.services.turns.idle(300);
        return asked;
      } catch {
        const cards = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
        for (const c of cards.filter((x) => x.toolName.startsWith('memory_'))) {
          asked.push(c.summary);
          await t.api('POST', `/api/approvals/${c.id}`, { decision: 'allow', answer: 'Onayla' });
        }
      }
    }
  };

  it('bot hafızası yalnızca o botun istemine girer; kullanıcı hafızası hepsine', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    await t.api('POST', '/api/memory', { scope: 'user', content: 'Kullanıcının adı Erhan' });
    await t.api('POST', '/api/memory', { scope: 'bot', botId: a.id, content: 'Ali raporları cuma yazar' });
    await t.send((await main(a.id)).id, 'x');
    await t.send((await main(b.id)).id, 'y');
    await t.services.turns.idle();
    const pa = t.engine.requests.find((r) => r.botId === a.id)!.systemPrompt;
    const pb = t.engine.requests.find((r) => r.botId === b.id)!.systemPrompt;
    expect(pa).toContain('Kullanıcının adı Erhan');
    expect(pa).toContain('Ali raporları cuma yazar');
    expect(pb).toContain('Kullanıcının adı Erhan');
    expect(pb).not.toContain('Ali raporları');
  });

  it('sohbetin hedefi o sohbetteki her turun isteminde yer alır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const thread = await main(a.id);
    await t.api('PATCH', `/api/threads/${thread.id}`, { goal: 'Cuma günü raporu bitir' });
    expect((await t.api<Thread>('GET', `/api/threads/${thread.id}`)).body.goal).toBe(
      'Cuma günü raporu bitir',
    );
    await t.send(thread.id, 'x');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.systemPrompt).toContain('Cuma günü raporu bitir');
    const other = (await t.api<Thread>('POST', `/api/bots/${a.id}/threads`, {})).body;
    await t.send(other.id, 'y');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.systemPrompt).not.toContain('Cuma günü raporu bitir');
  });

  it('botun kendi akıl yürütme düzeyi bütün botlar için seçilenin önüne geçer', async () => {
    await t.api('PATCH', '/api/settings', { effort: 'low' });
    const own = await t.bot({ name: 'Derin', effort: 'max' });
    const plain = await t.bot({ name: 'Sade' });
    await t.send((await main(own.id)).id, 'x');
    await t.send((await main(plain.id)).id, 'y');
    await t.services.turns.idle();
    expect(t.engine.requests.find((r) => r.botId === own.id)!.effort).toBe('max');
    expect(t.engine.requests.find((r) => r.botId === plain.id)!.effort).toBe('low');
  });

  it('hafızası kapalı bot hiç not görmez ve hafıza araçlarını almaz', async () => {
    const a = await t.bot({ name: 'Ali', memory: false });
    await t.api('POST', '/api/memory', { scope: 'user', content: 'Kullanıcının adı Erhan' });
    await t.send((await main(a.id)).id, 'x');
    await t.services.turns.idle();
    const req = t.engine.requests.find((r) => r.botId === a.id)!;
    expect(req.systemPrompt).not.toContain('Erhan');
    expect(req.tools.some((x) => x.name.startsWith('memory_'))).toBe(false);
    await t.api('PATCH', `/api/bots/${a.id}`, { memory: true });
    await t.send((await main(a.id)).id, 'y');
    await t.services.turns.idle();
    const again = t.engine.requests.filter((r) => r.botId === a.id).at(-1)!;
    expect(again.systemPrompt).toContain('Erhan');
    expect(again.tools.some((x) => x.name === 'memory_write')).toBe(true);
  });

  it('bot kendi hafızasına da ortak hafızaya da sormadan yazar; yazdığı hemen istemine girer', async () => {
    const a = await t.bot({ name: 'Ali' });
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:memory_write {"content":"Kahveyi şekersiz içer","scope":"user"}]');
    // The bot keeps its memory itself; the person sees and changes it in the memory screen.
    expect(await approving()).toEqual([]);
    await t.send(ta.id, '[araç:memory_write {"content":"Ali notu","scope":"bot"}]');
    await t.services.turns.idle();
    expect((await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body).toHaveLength(0);
    expect((await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body).toHaveLength(0);
    const all = (await t.api<Memory[]>('GET', '/api/memory')).body;
    expect(all.map((m) => m.content)).toEqual(['Kahveyi şekersiz içer', 'Ali notu']);
    await t.send(ta.id, 'kontrol');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.systemPrompt).toContain('şekersiz');
  });

  it('kimsenin izlemediği turun ve başka botun istediği hafıza değişikliği de hemen yapılır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Veli' });
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:memory_write {"content":"Eski adres Kadıköy","scope":"user"}]');
    await t.services.turns.idle();
    const [old] = (await t.api<Memory[]>('GET', '/api/memory')).body;
    const routine = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Gelen kutusu',
        prompt: [
          '[araç:memory_write {"content":"Pazartesi toplantısı var","scope":"user"}]',
          `[araç:memory_update {"id":"${old!.id}","content":"Adres Beşiktaş"}]`,
          '[araç:memory_write {"content":"Pazartesi toplantısı var","scope":"user"}]',
        ].join(' '),
        schedule: { type: 'weekly', days: [0], time: '18:00' },
      })
    ).body;
    await t.api('POST', `/api/routines/${routine.id}/run`);
    await t.services.turns.idle();
    // Made straight away, the same note once; nothing waits for the person.
    const notes = (await t.api<Memory[]>('GET', '/api/memory')).body;
    expect(notes.map((m) => m.content).sort()).toEqual(['Adres Beşiktaş', 'Pazartesi toplantısı var']);
    expect(notes.find((m) => m.content.startsWith('Pazartesi'))!.source).toBe(`bot:${a.id}`);
    expect((await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body).toHaveLength(0);
    // Another bot's request to forget a note is done too.
    const tb = await main(b.id);
    await t.send(tb.id, 'işe başla');
    await t.services.turns.idle();
    const asked = (await t.messages(tb.id)).find((m) => m.role === 'user')!;
    await t.services.jobs.send({
      from: b,
      fromThreadId: tb.id,
      fromTurnId: asked.turnId!,
      parentJobId: null,
      to: a,
      text: `[araç:memory_forget {"id":"${old!.id}"}]`,
      kind: 'send',
      approvalId: null,
    });
    await t.services.turns.idle();
    expect((await t.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.content)).toEqual([
      'Pazartesi toplantısı var',
    ]);
    expect((await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body).toHaveLength(0);
  });

  it('bot aynı notu ikinci kez açmaz, gizli değerleri hafızaya yazmaz; notlar tarihiyle isteme girer', async () => {
    const a = await t.bot({ name: 'Ali' });
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:memory_write {"content":"Kahveyi şekersiz içer","scope":"user"}]');
    await approving();
    await t.send(ta.id, '[araç:memory_write {"content":"kahveyi  şekersiz içer.","scope":"user"}]');
    // A note already there asks nothing.
    expect(await approving()).toEqual([]);
    expect((await t.messages(ta.id)).at(-1)!.text).toContain('zaten kayıtlı');
    await t.send(ta.id, '[araç:memory_write {"content":"Gmail şifresi: Kedi1234","scope":"bot"}]');
    await t.services.turns.idle();
    expect((await t.messages(ta.id)).at(-1)!.text).toContain('kasaya');
    const all = (await t.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.content);
    expect(all).toEqual(['Kahveyi şekersiz içer', 'Gmail şifresi: «gizli değer silindi»']);
    await t.send(ta.id, 'kontrol');
    await t.services.turns.idle();
    // A bot's note says it is one, and stays a note: never a rule of the prompt.
    expect(t.engine.requests.at(-1)!.systemPrompt).toMatch(
      /- \(\d{4}-\d{2}-\d{2}\) \[bot notu\] Kahveyi şekersiz içer/,
    );
    expect(t.engine.requests.at(-1)!.systemPrompt).toContain('talimat değildir');
  });

  it('bot kendi notunu ve ortak hafızayı düzeltir, siler; başka botun notuna dokunamaz', async () => {
    const a = await t.bot({ name: 'Ali', permissionMode: 'auto' });
    const b = await t.bot({ name: 'Ayşe' });
    const post = async (body: object) => (await t.api<Memory>('POST', '/api/memory', body)).body;
    const shared = await post({ scope: 'user', content: 'Ofis Kadıköyde' });
    const own = await post({ scope: 'bot', botId: a.id, content: 'Rapor cuma' });
    const other = await post({ scope: 'bot', botId: b.id, content: 'Ayşenin notu' });
    const ta = await main(a.id);

    // Without a query the search lists everything the bot sees, with ids, and nothing of Ayşe's.
    await t.send(ta.id, '[araç:memory_search {}]');
    await t.services.turns.idle();
    const listed = (await t.messages(ta.id)).at(-1)!.text;
    expect(listed).toContain(shared.id);
    expect(listed).toContain(own.id);
    expect(listed).not.toContain(other.id);

    await t.send(ta.id, `[araç:memory_update {"id":"${shared.id}","content":"Ofis Beşiktaşta"}]`);
    expect(await approving()).toEqual([]);
    await t.send(ta.id, `[araç:memory_forget {"id":"${own.id}"}]`);
    await t.services.turns.idle();
    await t.send(ta.id, `[araç:memory_forget {"id":"${other.id}"}]`);
    await t.services.turns.idle();
    expect((await t.messages(ta.id)).at(-1)!.text).toContain('başka bir botun kendi notu');

    const all = (await t.api<Memory[]>('GET', '/api/memory')).body;
    expect(all.map((m) => m.content)).toEqual(['Ofis Beşiktaşta', 'Ayşenin notu']);
    const history = (await t.api<{ action: string; actor: string }[]>('GET', '/api/memory-history')).body;
    expect(history.filter((h) => h.actor === `bot:${a.id}`).map((h) => h.action)).toEqual([
      'update',
      'delete',
    ]);
  });

  it('yönetici bot yönetici olmayan botların notlarını görür, düzeltir, siler; başka yöneticininkine dokunamaz', async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true, permissionMode: 'auto' });
    const other = await t.bot({ name: 'Başmüdür', isManager: true });
    const ali = await t.bot({ name: 'Ali' });
    const eski = await t.bot({ name: 'Eski' });
    const post = async (body: object) => (await t.api<Memory>('POST', '/api/memory', body)).body;
    const aliNote = await post({ scope: 'bot', botId: ali.id, content: 'Ali rapor cuma' });
    const eskiNote = await post({ scope: 'bot', botId: eski.id, content: 'Eski not' });
    const otherNote = await post({ scope: 'bot', botId: other.id, content: 'Başmüdürün notu' });
    await t.api('POST', `/api/bots/${eski.id}/archive`);
    const tm = await main(m.id);
    const last = async () => (await t.messages(tm.id)).at(-1)!.text;

    await t.send(tm.id, '[araç:memory_search {}]');
    await t.services.turns.idle();
    const listed = await last();
    // Bots that are not managers, archived ones included, each note named by its bot.
    expect(listed).toContain(`[${aliNote.id}] (Ali) Ali rapor cuma`);
    expect(listed).toContain(eskiNote.id);
    expect(listed).not.toContain(otherNote.id);

    await t.send(tm.id, '[araç:memory_search {"bot":"ali"}]');
    await t.services.turns.idle();
    expect(await last()).toContain(aliNote.id);
    expect(await last()).not.toContain(eskiNote.id);

    // The manager changes another bot's notes by itself, as it does its own.
    await t.send(tm.id, `[araç:memory_update {"id":"${aliNote.id}","content":"Ali rapor perşembe"}]`);
    expect(await approving()).toEqual([]);
    await t.send(tm.id, `[araç:memory_forget {"id":"${eskiNote.id}"}]`);
    expect(await approving()).toEqual([]);
    expect(await last()).toContain('Eski bu bilgiyi artık hiçbir yerden göremez');
    await t.send(tm.id, `[araç:memory_forget {"id":"${otherNote.id}"}]`);
    await t.services.turns.idle();
    expect(await last()).toContain('başka bir botun kendi notu');
    const all = (await t.api<Memory[]>('GET', '/api/memory')).body;
    expect(all.map((n) => n.content).sort()).toEqual(['Ali rapor perşembe', 'Başmüdürün notu']);

    // A bot that is not a manager still sees only its own notes.
    const ta = await main(ali.id);
    await t.send(ta.id, '[araç:memory_search {"bot":"Başmüdür"}]');
    await t.services.turns.idle();
    expect((await t.messages(ta.id)).at(-1)!.text).toContain('başka bir botun kendi notu');
  });

  it('bir botun kendi notlarının hepsi tek seferde silinir; ortak hafıza ve başka botlar kalır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const post = (body: object) => t.api('POST', '/api/memory', body);
    await post({ scope: 'bot', botId: a.id, content: 'bir' });
    await post({ scope: 'bot', botId: a.id, content: 'iki' });
    await post({ scope: 'bot', botId: b.id, content: 'Ayşenin' });
    await post({ scope: 'user', content: 'ortak' });
    const r = await t.api<{ count: number }>('DELETE', `/api/bots/${a.id}/memory`);
    expect(r.body).toEqual({ count: 2 });
    const all = (await t.api<Memory[]>('GET', '/api/memory')).body;
    expect(all.map((m) => m.content)).toEqual(['Ayşenin', 'ortak']);
    const history = (await t.api<{ action: string }[]>('GET', '/api/memory-history')).body;
    expect(history.filter((h) => h.action === 'delete')).toHaveLength(2);
  });

  it('silinen site notu sitesiyle geri eklenebilir', async () => {
    const bot = await t.bot();
    const r = await t.api<Memory>('POST', '/api/memory', {
      scope: 'bot',
      botId: bot.id,
      content: 'Giriş /giris adresinde',
      site: 'ornek.com',
    });
    expect(r.body.site).toBe('ornek.com');
    expect(
      (await t.services.memory.forSite(bot.id, 'www.ornek.com', OWNER_ID)).map((m) => m.content),
    ).toEqual(['Giriş /giris adresinde']);
  });
});

describe('hafızanın kullanımı', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const post = async (body: object) => (await t.api<Memory>('POST', '/api/memory', body)).body;
  const note = async (id: string) =>
    (await t.api<Memory[]>('GET', '/api/memory')).body.find((m) => m.id === id)!;
  /** Moves a note's every time `days` days back, as if it had been left alone that long. */
  const age = async (id: string, days: number) => {
    const then = new Date(Date.now() - days * 86_400_000);
    await t.db.db
      .update(schema.memories)
      .set({ createdAt: then, updatedAt: then, lastUsedAt: null })
      .where(eq(schema.memories.id, id));
  };

  it('aramanın bulduğu ve açılan sitenin notu kullanılmış sayılır; hepsini listelemek ve istemde olmak sayılmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const kahve = await post({ scope: 'user', content: 'Kahveyi şekersiz içer' });
    const ofis = await post({ scope: 'user', content: 'Ofis Kadıköyde' });
    const site = await post({
      scope: 'bot',
      botId: a.id,
      content: 'Giriş /giris adresinde',
      site: 'ornek.com',
    });
    const ta = await main(a.id);

    await t.send(ta.id, 'merhaba');
    await t.services.turns.idle();
    await t.send(ta.id, '[araç:memory_search {}]');
    await t.services.turns.idle();
    expect((await note(kahve.id)).useCount).toBe(0);
    expect((await note(kahve.id)).lastUsedAt).toBeNull();

    await t.send(ta.id, '[araç:memory_search {"query":"kahve"}]');
    await t.services.turns.idle();
    const used = await note(kahve.id);
    expect(used.useCount).toBe(1);
    expect(used.lastUsedAt).not.toBeNull();
    // A lookup is not a change: the note keeps its time of change and gets no history line.
    expect(used.updatedAt).toBe(kahve.updatedAt);
    expect((await note(ofis.id)).useCount).toBe(0);

    await t.services.memory.forSite(a.id, 'www.ornek.com', OWNER_ID);
    expect((await note(site.id)).useCount).toBe(1);

    // Saving a fact already kept writes no second note, but the first one is in use again.
    await t.send(ta.id, '[araç:memory_write {"content":"Ofis Kadıköyde","scope":"user"}]');
    await t.services.turns.idle();
    expect((await note(ofis.id)).useCount).toBe(1);
    const history = (await t.api<{ action: string }[]>('GET', '/api/memory-history')).body;
    expect(history.map((h) => h.action)).toEqual(['create', 'create', 'create']);
  });

  it('istemde yer olmayınca, uzun süre kimsenin kullanmadığı not kullanılmayanlar listesine düşer; istemdeki eski not düşmez', async () => {
    const a = await t.bot({ name: 'Ali' });
    const kept = await post({ scope: 'user', content: 'Adı Erhan' });
    // Longer than the room a filler leaves when the looked-up note pushes it out.
    const dropped = await post({
      scope: 'bot',
      botId: a.id,
      content: 'Eski proje Zeytin '.padEnd(1995, '.'),
    });
    const site = await post({
      scope: 'bot',
      botId: a.id,
      content: 'Giriş /giris adresinde',
      site: 'ornek.com',
    });
    for (const m of [kept, dropped, site]) await age(m.id, 40);
    // Twelve newer notes fill the prompt to the last character, so an old note gets in only by
    // being looked up lately.
    for (let i = 0; i < 12; i++)
      await post({ scope: 'bot', botId: a.id, content: String(i).padEnd(MEMORY_PROMPT_CHARS / 12 - 3, 'x') });

    let stale = (await t.api<Memory[]>('GET', '/api/memory-stale')).body;
    expect(stale.map((m) => m.id).sort()).toEqual([kept.id, dropped.id, site.id].sort());

    await t.services.memory.markUsed([kept.id]);
    stale = (await t.api<Memory[]>('GET', '/api/memory-stale')).body;
    expect(stale.map((m) => m.id).sort()).toEqual([dropped.id, site.id].sort());
    expect((await t.api<{ staleMemory?: number }>('GET', '/api/today')).body.staleMemory).toBe(2);

    // A note used again after the list was shown is not deleted with it.
    await t.services.memory.markUsed([site.id]);
    const r = await t.api<{ count: number }>('POST', '/api/memory-stale/delete', {
      ids: stale.map((m) => m.id),
    });
    expect(r.body.count).toBe(1);
    const left = (await t.api<Memory[]>('GET', '/api/memory')).body.map((m) => m.id);
    expect(left).toContain(kept.id);
    expect(left).toContain(site.id);
    expect(left).not.toContain(dropped.id);
    const history = (
      await t.api<{ action: string; actor: string; targetId: string }[]>('GET', '/api/memory-history')
    ).body;
    expect(history.filter((h) => h.action === 'delete')).toMatchObject([
      { actor: 'user:owner', targetId: dropped.id },
    ]);
  });

  it('istemine giren eski not, hafızası kapalı ya da arşivlenmiş botun notu olunca kullanılmayanlara düşer', async () => {
    const on = await t.bot({ name: 'Açık' });
    const off = await t.bot({ name: 'Kapalı', memory: false });
    const shared = await post({ scope: 'user', content: 'Adı Erhan' });
    const onNote = await post({ scope: 'bot', botId: on.id, content: 'Rapor cuma' });
    const offNote = await post({ scope: 'bot', botId: off.id, content: 'Fatura ayın biri' });
    for (const m of [shared, onNote, offNote]) await age(m.id, 40);

    let stale = (await t.api<Memory[]>('GET', '/api/memory-stale')).body;
    expect(stale.map((m) => m.id)).toEqual([offNote.id]);

    await t.api('POST', `/api/bots/${on.id}/archive`);
    stale = (await t.api<Memory[]>('GET', '/api/memory-stale')).body;
    expect(stale.map((m) => m.id).sort()).toEqual([shared.id, onNote.id, offNote.id].sort());
  });
});

describe('rutinler', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('zamanı gelince bir kez çalışır, aynı anı iki kez çalıştırmaz, sonraki zamanı hesaplar', async () => {
    const a = await t.bot({ name: 'Ali' });
    // 2026-11-16 is a Monday; 05:00Z = 08:00 Istanbul.
    t.now.value = new Date('2026-11-16T05:30:00.000Z');
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Sabah özeti',
        prompt: 'Günün özetini yaz',
        schedule: { type: 'daily', time: '09:00' },
        timezone: 'Europe/Istanbul',
        inMain: false,
      })
    ).body;
    expect(r.nextRunAt).toBe('2026-11-16T06:00:00.000Z');
    await t.services.routines.tick();
    expect((await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body).toHaveLength(0);

    t.now.value = new Date('2026-11-16T06:00:30.000Z');
    await Promise.all([t.services.routines.tick(), t.services.routines.tick()]);
    await t.services.turns.idle();
    const runs = (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body;
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('done');
    const after = (await t.api<Routine>('GET', `/api/routines`)).body as unknown as Routine[];
    expect(after[0]!.nextRunAt).toBe('2026-11-17T06:00:00.000Z');
    const thread = (await t.api<Thread>('GET', `/api/threads/${runs[0]!.threadId}`)).body;
    expect(thread.kind).toBe('routine');
    expect(t.engine.requests.at(-1)!.prompt).toContain('Günün özetini yaz');
  });

  it('önceki çalıştırma sürüyorsa yenisi atlanır ve nedeni yazılır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Uzun',
        prompt: '[bekle:3000]',
        schedule: { type: 'interval', minutes: 5 },
      })
    ).body;
    await t.api('POST', `/api/routines/${r.id}/run`);
    t.now.value = new Date(t.now.value.getTime() + 1000);
    const second = await t.api<RoutineRun | null>('POST', `/api/routines/${r.id}/run`);
    expect(second.body?.status).toBe('skipped');
    expect(second.body?.reason).toContain('sürüyor');
    const thread = (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body.find(
      (x) => x.threadId,
    )!;
    await t.api('POST', `/api/threads/${thread.threadId}/stop`);
    await t.services.turns.idle();
  });

  it('kısmi güncelleme diğer alanları varsayılana döndürmez', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Kapalı',
        prompt: 'x',
        schedule: { type: 'hourly', minute: 5 },
        timezone: 'America/New_York',
        enabled: false,
      })
    ).body;
    const u = (await t.api<Routine>('PATCH', `/api/routines/${r.id}`, { name: 'Yeni ad' })).body;
    expect(u.name).toBe('Yeni ad');
    expect(u.enabled).toBe(false);
    expect(u.timezone).toBe('America/New_York');
    expect(u.nextRunAt).toBeNull();
  });

  const promptOf = async (server: TestServer, botId: string) => {
    const thread = (await server.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
    await server.send(thread.id, 'merhaba');
    await server.services.turns.idle();
    return server.engine.requests.filter((r) => r.botId === botId).at(-1)!.systemPrompt;
  };

  it('bot kendi rutinlerini ve nerede çalıştığını istemde görür; yönetici bütün rutinleri görür', async () => {
    // A server of its own, whose routines run while the person's computer is off.
    await t.dispose();
    t = await testServer({ onUserComputer: false });
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const boss = await t.bot({ name: 'Kahya', isManager: true });
    t.now.value = new Date('2026-11-16T05:30:00.000Z');
    await t.api('POST', '/api/routines', {
      botId: a.id,
      name: 'Mail kontrolü',
      prompt: 'x',
      schedule: { type: 'weekdays', time: '09:00' },
      timezone: 'Europe/Istanbul',
    });
    await t.api('POST', '/api/routines', {
      botId: b.id,
      name: 'Gece raporu',
      prompt: 'y',
      schedule: { type: 'daily', time: '21:00' },
      enabled: false,
    });

    const pa = await promptOf(t, a.id);
    expect(pa).toContain('## Nerede çalışıyorsun');
    expect(pa).toContain('bilgisayarı kapalıyken de zamanında çalışır');
    // The schedule only: the next run's time would change the prompt after every run.
    expect(pa).toMatch(/- Mail kontrolü: Hafta içi 09:00 \(Europe\/Istanbul\)$/m);
    expect(pa).not.toContain('Gece raporu');

    const pb = await promptOf(t, b.id);
    expect(pb).toContain('- Gece raporu: Her gün 21:00 (Europe/Istanbul), kapalı');
    expect(pb).not.toContain('Mail kontrolü');

    const pk = await promptOf(t, boss.id);
    expect(pk).toContain('- Ali · Mail kontrolü:');
    expect(pk).toContain('- Ayşe · Gece raporu:');
  });

  it('rutini olmayan bota bunu söyler; masaüstü uygulamasındaki sunucu bilgisayar açıkken çalıştığını söyler', async () => {
    const local = await testServer({ onUserComputer: true });
    try {
      const a = await local.bot({ name: 'Ali' });
      const p = await promptOf(local, a.id);
      expect(p).toContain('Sana tanımlı bir rutin yok.');
      expect(p).toContain('yalnızca bilgisayar açık ve Leaf Bot çalışırken');
      expect(p).not.toContain('kapalıyken de');
    } finally {
      await local.dispose();
    }
  });

  const routine = async (botId: string) =>
    (
      await t.api<Routine>('POST', '/api/routines', {
        botId,
        name: 'Rapor',
        prompt: 'Raporu yaz',
        schedule: { type: 'interval', minutes: 5 },
        // Its runs work in a conversation of its own; the report is copied to the main one.
        inMain: false,
      })
    ).body;
  const runs = async (id: string) => (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;
  const runAgain = async (id: string) => {
    t.now.value = new Date(t.now.value.getTime() + 60 * 60_000);
    return (await t.api<RoutineRun | null>('POST', `/api/routines/${id}/run`)).body;
  };
  /** The rows a server leaves behind when it dies mid-run. */
  const crashedRun = async (r: Routine, botId: string, withTurn: boolean) => {
    const thread = await t.services.threads.routineThread(botId, r.name, null, OWNER_ID);
    const id = newId();
    await t.db.db.insert(schema.routineRuns).values({
      id,
      routineId: r.id,
      occurrence: 'eski',
      status: 'running',
      threadId: thread.id,
      promptSnapshot: r.prompt,
    });
    if (withTurn) {
      await t.db.db.insert(schema.turns).values({
        id: newId(),
        threadId: thread.id,
        botId,
        source: 'routine',
        status: 'running',
        prompt: r.prompt,
        routineRunId: id,
      });
    }
  };

  it('son çalışması başarısız olan rutin botun özetinde görünür; başarılı çalışma işareti kaldırır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Gece raporu',
        prompt: '[hata]',
        schedule: { type: 'interval', minutes: 5 },
        inMain: false,
      })
    ).body;
    const failed = async () =>
      (await t.api<BotSummary[]>('GET', '/api/summaries')).body.find((x) => x.botId === a.id)!.failedRoutine;
    expect(await failed()).toBeNull();
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect(await failed()).toBe('Gece raporu');
    // The app opens the failed routine from the mark, and marks it among the bot's routines.
    const ids = async () =>
      (await t.api<BotSummary[]>('GET', '/api/summaries')).body.find((x) => x.botId === a.id)!.failedRoutines;
    expect(await ids()).toEqual([r.id]);
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: 'tamam' });
    await runAgain(r.id);
    await t.services.turns.idle();
    expect(await failed()).toBeNull();
    expect(await ids()).toEqual([]);
    // The routine's answer reaches the main conversation, with the way to the run's own steps.
    const summary = (await t.api<BotSummary[]>('GET', '/api/summaries')).body.find((x) => x.botId === a.id)!;
    const [run] = (await t.api<RoutineRun[]>('GET', `/api/routines/${r.id}/runs`)).body;
    expect(summary.repliedThreadId).toBe(summary.threadId);
    const copy = (await t.messages(summary.threadId!)).at(-1)!;
    expect(copy.role).toBe('assistant');
    expect(copy.props).toMatchObject({
      routineReport: true,
      routineName: 'Gece raporu',
      routineThreadId: run!.threadId,
    });
  });

  it('rutin açılıp görülen hata botu işaretlemez; sonraki yeni hata yine işaretler', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Telegram grubu',
        prompt: '[hata]',
        schedule: { type: 'interval', minutes: 5 },
      })
    ).body;
    const failed = async () =>
      (await t.api<BotSummary[]>('GET', '/api/summaries')).body.find((x) => x.botId === a.id)!.failedRoutine;
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect(await failed()).toBe('Telegram grubu');
    // Later runs a check skips leave no new result; seeing the failure is what clears the mark.
    t.now.value = new Date(t.now.value.getTime() + 60_000);
    expect((await t.api('POST', `/api/routines/${r.id}/failure-seen`)).status).toBe(200);
    expect(await failed()).toBeNull();
    await runAgain(r.id);
    await t.services.turns.idle();
    expect(await failed()).toBe('Telegram grubu');
  });

  it('yeni rutin ana sohbette çalışır; seni bekleyen adımı olan kendi sohbetinde kalır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const main = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    const made = async (extra: Record<string, unknown>) =>
      (
        await t.api<Routine>('POST', '/api/routines', {
          botId: a.id,
          name: 'Özet',
          prompt: 'Özeti yaz',
          schedule: { type: 'interval', minutes: 5 },
          ...extra,
        })
      ).body;
    const plain = await made({});
    expect(plain.inMain).toBe(true);
    const run = (await t.api<RoutineRun>('POST', `/api/routines/${plain.id}/run`, {})).body;
    await t.services.turns.idle();
    expect(run.threadId).toBe(main.id);
    // A run held for the person would keep the main conversation busy for days.
    const held = await made({ steps: [{ id: 'onay', kind: 'approval', question: 'Gönderilsin mi?' }] });
    const heldRun = (await t.api<RoutineRun>('POST', `/api/routines/${held.id}/run`, {})).body;
    expect(heldRun.threadId).not.toBe(main.id);
  });

  it('rutinin raporu ana sohbete düşer, bot orada sonraki mesajda onu bilir; sessiz çalışma bir şey yazmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const main = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(main.id, 'merhaba');
    await t.services.turns.idle();
    const r = await routine(a.id);
    const run = (await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`, {})).body;
    await t.services.turns.idle();
    expect(run.threadId).not.toBe(main.id);
    const report = (await t.messages(run.threadId!)).at(-1)!;
    const copy = (await t.messages(main.id)).at(-1)!;
    expect(copy).toMatchObject({ role: 'assistant', author: `bot:${a.id}`, text: report.text });
    expect(copy.props).toMatchObject({
      routineReport: true,
      routineName: 'Rapor',
      routineThreadId: run.threadId,
    });
    // The routine's own conversation stays out of the list unless it waits on the person.
    const threads = (await t.api<Thread[]>('GET', `/api/bots/${a.id}/threads`)).body;
    expect(threads.find((x) => x.id === run.threadId)?.kind).toBe('routine');

    await t.send(main.id, 'raporda ne vardı');
    await t.services.turns.idle();
    const asked = t.engine.requests.at(-1)!.prompt;
    expect(asked).toContain('"Rapor" rutininin bir çalışmasında yazdığın rapor');
    expect(asked).toContain('raporda ne vardı');

    const before = (await t.messages(main.id)).length;
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: '[sessiz]' });
    await runAgain(r.id);
    await t.services.turns.idle();
    expect(await t.messages(main.id)).toHaveLength(before);

    // Nothing to report said with a reason above it: the reason stays in the routine's own
    // conversation, without the silent reply, and nothing reaches the main one.
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: '[sessiz-son]' });
    const quiet = (await runAgain(r.id))!;
    await t.services.turns.idle();
    expect(await t.messages(main.id)).toHaveLength(before);
    expect((await t.messages(quiet.threadId!)).at(-1)).toMatchObject({
      role: 'assistant',
      text: 'Değişiklik yok.',
    });
  });

  it('ana sohbette sessiz biten rutin çalışması orada kapalı satırı olarak kalır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const main = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(main.id, 'merhaba');
    await t.services.turns.idle();
    const r = await routine(a.id);
    await t.api('PATCH', `/api/routines/${r.id}`, { inMain: true, prompt: '[sessiz-son]' });
    const before = await t.messages(main.id);
    const run = (await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`, {})).body;
    await t.services.turns.idle();
    expect(run.threadId).toBe(main.id);
    expect((await runs(r.id)).find((x) => x.id === run.id)?.status).toBe('done');
    // The run's line stays, marked quiet, with what the bot wrote of why and how the run ended; no
    // answer goes under it.
    const listed = await t.messages(main.id);
    expect(listed).toHaveLength(before.length + 1);
    expect(listed.at(-1)).toMatchObject({
      role: 'user',
      author: `routine:${r.id}`,
      props: {
        routineRunId: run.id,
        routineQuiet: true,
        quietNote: 'Değişiklik yok.',
        routineRunStatus: 'done',
      },
    });

    // The silent reply alone leaves a quiet line too, with nothing written of why.
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: '[sessiz]' });
    const second = (await runAgain(r.id))!;
    await t.services.turns.idle();
    const after = await t.messages(main.id);
    expect(after).toHaveLength(before.length + 2);
    expect(after.at(-1)!.props).toMatchObject({ routineRunId: second.id, routineQuiet: true });
    expect(after.at(-1)!.props.quietNote).toBeUndefined();
  });

  it('ana sohbetten kendi sohbetine dönen rutin ana sohbeti kendi sohbeti saymaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = await routine(a.id);
    const main = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.api('PATCH', `/api/routines/${r.id}`, { inMain: true });
    const first = (await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`, {})).body;
    await t.services.turns.idle();
    expect(first.threadId).toBe(main.id);
    await t.api('PATCH', `/api/routines/${r.id}`, { inMain: false });
    const second = (await runAgain(r.id))!;
    await t.services.turns.idle();
    expect(second.threadId).not.toBe(main.id);
    expect((await t.api<Thread>('GET', `/api/threads/${second.threadId}`)).body.kind).toBe('routine');
  });

  it('betik rutine veri gönderebilir; veri istemde talimattan ayrı durur', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = await routine(a.id);
    const json = await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`, {
      payload: 'derleme bitti: 3 hata',
    });
    expect(json.status).toBe(200);
    await t.services.turns.idle();
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt).toContain('Raporu yaz');
    expect(prompt).toContain('<<<\nderleme bitti: 3 hata\n>>>');
    const thread = (await t.messages(json.body.threadId!)).find((m) => m.author.startsWith('routine:'))!;
    expect(thread.text).toContain('derleme bitti');
    const big = await t.api('POST', `/api/routines/${r.id}/run`, { payload: 'x'.repeat(60_000) });
    expect(big.status).toBe(413);
  });

  it('son raporu taşıyan rutin bir önceki çalışmanın yanıtını istemde görür', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = await routine(a.id);
    await runAgain(r.id);
    await t.services.turns.idle();
    // Off by default: the next run starts from the prompt alone.
    await runAgain(r.id);
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).not.toContain('<<<');
    await t.api('PATCH', `/api/routines/${r.id}`, { carryReport: true });
    await runAgain(r.id);
    await t.services.turns.idle();
    const prompt = t.engine.requests.at(-1)!.prompt;
    const report = await t.services.routines.lastReport(r.id);
    expect(report?.text).toBeTruthy();
    expect(prompt).toContain('<<<');
    expect((await t.services.routines.get(r.id)).carryReport).toBe(true);
  });

  it('ana sohbette çalışan rutin kendi sohbetini açmaz; yanıtı ana sohbete yazar', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = await routine(a.id);
    await t.api('PATCH', `/api/routines/${r.id}`, { inMain: true });
    const main = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    const run = (await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`, {})).body;
    await t.services.turns.idle();
    expect(run.threadId).toBe(main.id);
    const msgs = await t.messages(main.id);
    expect(msgs.some((m) => m.author === `routine:${r.id}`)).toBe(true);
    expect(msgs.at(-1)!.role).toBe('assistant');
    const threads = (await t.api<Thread[]>('GET', `/api/bots/${a.id}/threads`)).body;
    expect(threads.some((x) => x.kind === 'routine')).toBe(false);
  });

  it('sunucu açılınca çalışacak rutin her açılışta bir kez çalışır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = await routine(a.id);
    const other = await routine(a.id).catch(() => null);
    await t.api('PATCH', `/api/routines/${r.id}`, { onStartup: true });
    await t.services.routines.runStartup();
    await t.services.turns.idle();
    expect((await runs(r.id)).filter((x) => x.occurrence.startsWith('startup:'))).toHaveLength(1);
    if (other) expect(await runs(other.id)).toHaveLength(0);
    t.now.value = new Date(t.now.value.getTime() + 60_000);
    await t.services.routines.runStartup();
    await t.services.turns.idle();
    expect((await runs(r.id)).filter((x) => x.occurrence.startsWith('startup:'))).toHaveLength(2);
  });

  it('webhook süzgecine uymayan çağrı rutini başlatmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = await routine(a.id);
    const hooked = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
    await t.api('PATCH', `/api/routines/${r.id}`, { webhookFilter: 'action=opened' });
    const call = (payload: object) =>
      t.app.inject({
        method: 'POST',
        url: `/api/hooks/routines/${r.id}/${hooked.webhookToken}`,
        headers: { host: 'localhost' },
        payload,
      });
    expect((await call({ action: 'closed' })).json()).toMatchObject({ status: 'filtered' });
    expect(await runs(r.id)).toHaveLength(0);
    expect((await call({ action: 'opened' })).json()).toMatchObject({ status: 'running' });
    await t.services.turns.idle();
    expect(await runs(r.id)).toHaveLength(1);
  });

  it('aynı teslimat kimliğiyle yeniden gelen webhook bir kez çalışır; süren çalışma varken gelen sonra yeniden istenir', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = await routine(a.id);
    const hooked = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
    const call = (delivery: string, payload: object) =>
      t.app.inject({
        method: 'POST',
        url: `/api/hooks/routines/${r.id}/${hooked.webhookToken}`,
        headers: { host: 'localhost', 'x-github-delivery': delivery },
        payload,
      });
    expect((await call('d1', { n: 1 })).json()).toMatchObject({ status: 'running' });
    await t.services.turns.idle();
    const again = await call('d1', { n: 1 });
    expect(again.statusCode).toBe(202);
    expect(again.json()).toMatchObject({ status: 'duplicate' });
    expect(await runs(r.id)).toHaveLength(1);

    // While a run is still going, the sender is asked to come back instead of the event being lost.
    await t.api('PATCH', `/api/routines/${r.id}`, { prompt: '[bekle:1500] Raporu yaz' });
    expect((await call('d2', { n: 2 })).json()).toMatchObject({ status: 'running' });
    const busy = await call('d3', { n: 3 });
    expect(busy.statusCode).toBe(429);
    expect(busy.headers['retry-after']).toBe('60');
    await t.services.turns.idle();
    expect((await call('d3', { n: 3 })).json()).toMatchObject({ status: 'running' });
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['done', 'done', 'done']);
  });

  it('bot meşgulken başlayan rutin çalışıyor değil sırada görünür ve nedenini söyler', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Ana rapor',
        prompt: 'Raporu yaz',
        schedule: { type: 'interval', minutes: 5 },
        inMain: true,
      })
    ).body;
    const main = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(main.id, '[bekle:1500] uzun iş');
    await waitFor(async () => t.services.turns.isRunning(main.id));
    await t.api('POST', `/api/routines/${r.id}/run`);
    const [waiting] = await runs(r.id);
    expect(waiting).toMatchObject({ status: 'waiting', reason: 'Bot başka bir işi bitirince başlayacak.' });
    await t.services.turns.idle();
    expect((await runs(r.id))[0]!.status).toBe('done');
  });

  it('yalnızca yazan webhook, botu çalıştırmadan geleni botun mesajı olarak yazar', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = await routine(a.id);
    const hooked = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
    await t.api('PATCH', `/api/routines/${r.id}`, { webhookPost: true });
    const before = t.engine.requests.length;
    const call = (payload: object) =>
      t.app.inject({
        method: 'POST',
        url: `/api/hooks/routines/${r.id}/${hooked.webhookToken}`,
        headers: { host: 'localhost' },
        payload,
      });
    expect((await call({ alarm: 'disk dolu' })).json()).toMatchObject({ status: 'done' });
    await call({ alarm: 'yine dolu' });
    await t.services.turns.idle();
    expect(t.engine.requests.length).toBe(before);
    const done = await runs(r.id);
    expect(done.map((x) => x.status)).toEqual(['done', 'done']);
    // Both calls land in the routine's one conversation, as the bot's messages.
    expect(done[0]!.threadId).toBe(done[1]!.threadId);
    const msgs = await t.messages(done[0]!.threadId!);
    expect(msgs.map((m) => [m.role, m.author])).toEqual([
      ['assistant', `bot:${a.id}`],
      ['assistant', `bot:${a.id}`],
    ]);
    expect(msgs[0]!.text).toContain('disk dolu');

    // Asked about it, the bot reads the posts as data that came through the webhook, not as its own words.
    const thread = done[0]!.threadId!;
    await t.send(thread, 'bu ne demek?');
    await t.services.turns.idle();
    const first = t.engine.requests.at(-1)!.prompt;
    expect(first).toContain(`"${r.name}" rutininin webhook'una gelen gönderi`);
    expect(first).toContain('disk dolu');
    expect(first).not.toContain('Ali: {');
    // In the session that follows, only what was posted since its last message comes with the next one.
    await call({ alarm: 'şimdi düzeldi' });
    await t.send(thread, 'peki şimdi?');
    await t.services.turns.idle();
    const next = t.engine.requests.at(-1)!.prompt;
    expect(next).toContain('Son mesajından bu yana bu sohbete gelenler');
    expect(next).toContain('şimdi düzeldi');
    expect(next).not.toContain('disk dolu');
    expect(next.endsWith('peki şimdi?')).toBe(true);
  });

  it('webhook adresi anahtarsız çalıştırır; yanlış ya da kaldırılmış gizli bölüm reddedilir', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = await routine(a.id);
    expect(r.webhookToken).toBeNull();
    const on = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
    expect(on.webhookToken).toMatch(/^[\w-]{30,}$/);
    const hook = (token: string, payload: unknown) =>
      t.app.inject({
        method: 'POST',
        url: `/api/hooks/routines/${r.id}/${token}`,
        headers: { host: 'localhost', 'content-type': 'application/json' },
        payload: payload as object,
      });
    expect((await hook('yanlis', {})).statusCode).toBe(404);
    const ok = await hook(on.webhookToken!, { action: 'opened', pr: 42 });
    expect(ok.statusCode).toBe(202);
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).toContain('"pr": 42');

    const again = (await t.api<Routine>('POST', `/api/routines/${r.id}/webhook`)).body;
    expect(again.webhookToken).not.toBe(on.webhookToken);
    expect((await hook(on.webhookToken!, {})).statusCode).toBe(404);
    await t.api('DELETE', `/api/routines/${r.id}/webhook`);
    expect((await hook(again.webhookToken!, {})).statusCode).toBe(404);
  });

  it('kullanım sınırına takılan rutin sınır sıfırlanınca yeniden çalışacak biçimde ertelenir', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Günlük',
        prompt: '[sınır]',
        schedule: { type: 'daily', time: '23:00' },
      })
    ).body;
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    const after = (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.id === r.id)!;
    // The fake limit lifts at 09:00 UTC on the 16th; two minutes later it runs again, sooner than
    // its 23:00 (Istanbul) slot. A slot sooner than the retry would be kept.
    expect(after.nextRunAt).toBe('2026-11-16T09:02:00.000Z');
  });

  it('geçici bir hatayla biten rutin bir kez, birkaç dakika sonra yeniden denenir', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Günlük',
        prompt: '[meşgul]',
        schedule: { type: 'daily', time: '23:00' },
      })
    ).body;
    const next = async () =>
      (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.id === r.id)!;
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    // The clock stands at 05:00 UTC; five minutes later is sooner than the 23:00 slot.
    expect((await next()).nextRunAt).toBe('2026-11-16T05:05:00.000Z');
    t.now.value = new Date('2026-11-16T05:06:00.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['error', 'error']);
    // The second failure is not tried again; the routine waits for its own slot.
    expect((await next()).nextRunAt).not.toBe('2026-11-16T05:11:00.000Z');
  });

  it('cevapsız bir kartta uzun süre bekleyen çalışma, rutinin sıradaki çalışmasına yer açar', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Saatlik',
        prompt: '[izin:Bash {"command":"npm test"}]',
        schedule: { type: 'daily', time: '23:00' },
      })
    ).body;
    await t.api('POST', `/api/routines/${r.id}/run`);
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    // A fresh wait keeps the routine busy: the next run is skipped.
    t.now.value = new Date(t.now.value.getTime() + 60_000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    expect((await runs(r.id)).map((x) => x.status).sort()).toEqual(['running', 'skipped']);
    // Half an hour later the waiting run gives way.
    await t.db.db
      .update(schema.approvals)
      .set({ createdAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(schema.approvals.id, card.id));
    t.now.value = new Date(t.now.value.getTime() + 60_000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    const all = await runs(r.id);
    const ended = all.find((x) => x.status === 'error')!;
    expect(ended.reason).toContain('sıradaki çalışması');
    expect(all.filter((x) => x.status === 'running')).toHaveLength(1);
    expect((await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body.status).toBe('expired');
  });

  it('kendi modeli olan rutin o modelle, olmayan botun modeliyle çalışır', async () => {
    const a = await t.bot({ name: 'Ali', model: 'opus' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Ucuz',
        prompt: 'özetle',
        schedule: { type: 'daily', time: '23:00' },
        model: 'haiku',
      })
    ).body;
    expect(r.model).toBe('haiku');
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.model).toBe('haiku');
    await t.api('PATCH', `/api/routines/${r.id}`, { model: '' });
    t.now.value = new Date(t.now.value.getTime() + 60_000);
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.model).toBe('opus');
  });

  it('duraklatılan rutinin kişiyi bekleyen çalışması sona erer', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Onaylı',
        prompt: '[izin:Bash {"command":"npm test"}]',
        schedule: { type: 'daily', time: '23:00' },
      })
    ).body;
    await t.api('POST', `/api/routines/${r.id}/run`);
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    await t.api('PATCH', `/api/routines/${r.id}`, { enabled: false });
    const [run] = await runs(r.id);
    expect(run!.status).toBe('error');
    expect(run!.reason).toContain('duraklatıldığı');
    expect((await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body.status).toBe('expired');
  });

  it('tek seferlik rutin bir kez çalışır ve kapanır; geçmiş zaman reddedilir', async () => {
    const a = await t.bot({ name: 'Ali' });
    const make = (date: string) =>
      t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Hatırlat',
        prompt: 'Faturayı hatırlat',
        schedule: { type: 'once', date, time: '09:00' },
      });
    expect((await make('2026-11-10')).status).toBe(400);
    const r = (await make('2026-11-16')).body;
    // 09:00 in Istanbul is 06:00 UTC; the clock stands at 05:00 UTC.
    expect(r.nextRunAt).toBe('2026-11-16T06:00:00.000Z');
    t.now.value = new Date('2026-11-16T06:01:00.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => x.status)).toEqual(['done']);
    const after = (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.id === r.id)!;
    expect(after).toMatchObject({ enabled: false, nextRunAt: null });
    t.now.value = new Date('2026-11-17T06:01:00.000Z');
    await t.services.routines.tick();
    expect(await runs(r.id)).toHaveLength(1);
  });

  it('kapalıyken kaçırılan çalışma ayara göre atlanır ya da bir kez çalışır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const make = async (missed: 'run' | 'skip') =>
      (
        await t.api<Routine>('POST', '/api/routines', {
          botId: a.id,
          name: `Sabah ${missed}`,
          prompt: 'Günaydın',
          schedule: { type: 'daily', time: '09:00' },
          missed,
        })
      ).body;
    const skip = await make('skip');
    const run = await make('run');
    // The server was off from before 09:00 until the afternoon.
    t.now.value = new Date('2026-11-16T12:00:00.000Z');
    await t.services.routines.tick();
    await t.services.turns.idle();
    expect((await runs(skip.id)).map((x) => [x.status, x.reason])).toEqual([
      ['skipped', expect.stringContaining('kapalıydı')],
    ]);
    expect((await runs(run.id)).map((x) => x.status)).toEqual(['done']);
  });

  it('bot kendine rutin kurabilir; kart onayından geçer, aynı adı ikinci kez kurmaz', async () => {
    const a = await t.bot({ name: 'Ali', permissionMode: 'auto' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    const make =
      '[araç:routine_create {"name":"Sabah özeti","prompt":"Gündemi özetle","schedule":{"type":"weekdays","time":"08:30"},"model":"haiku"}]';
    await t.send(thread.id, make);
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain(
      '"Sabah özeti" rutini kuruldu: Hafta içi 08:30',
    );
    const mine = (await t.api<Routine[]>('GET', '/api/routines')).body.filter((r) => r.botId === a.id);
    expect(mine.map((r) => [r.name, r.schedule, r.model])).toEqual([
      ['Sabah özeti', { type: 'weekdays', time: '08:30' }, 'haiku'],
    ]);
    await t.send(thread.id, make);
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('zaten var');
    expect(
      describeAction(
        'mcp__leafbot__routine_create',
        { name: 'X', schedule: { type: 'daily', time: '07:00' }, prompt: 'p' },
        { bot: 'Ali', locale: 'en' },
      ).detail,
    ).toBe('Every day at 07:00\np');
  });

  it('bot kendi rutinini kapatıp değiştirebilir, silebilir; başka botunkine dokunamaz', async () => {
    const a = await t.bot({ name: 'Ali', permissionMode: 'auto' });
    const b = await t.bot({ name: 'Veli' });
    const mine = await routine(a.id);
    const theirs = await routine(b.id);
    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    const last = async () => (await t.messages(thread.id)).at(-1)!.text;
    const all = async () => (await t.api<Routine[]>('GET', '/api/routines')).body;

    await t.send(thread.id, '[araç:routine_update {"routine":"rapor","enabled":false}]');
    await t.services.turns.idle();
    expect(await last()).toContain('"Rapor" rutini güncellendi');
    expect((await all()).find((r) => r.id === mine.id)).toMatchObject({ enabled: false, nextRunAt: null });

    await t.send(
      thread.id,
      '[araç:routine_update {"routine":"Rapor","name":"Akşam raporu","schedule":{"type":"daily","time":"18:00"},"enabled":true}]',
    );
    await t.services.turns.idle();
    expect(await last()).toContain('"Akşam raporu" rutini güncellendi: Her gün 18:00');
    expect((await all()).find((r) => r.id === mine.id)).toMatchObject({
      name: 'Akşam raporu',
      enabled: true,
      schedule: { type: 'daily', time: '18:00' },
    });

    // Only the routine's runs change model; the bot sees which one in its routine list.
    await t.send(thread.id, '[araç:routine_update {"routine":"Akşam raporu","model":"haiku"}]');
    await t.services.turns.idle();
    expect((await all()).find((r) => r.id === mine.id)!.model).toBe('haiku');
    expect((await t.api<Bot>('GET', `/api/bots/${a.id}`)).body.model).toBe('');
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.systemPrompt).toContain(
      '- Akşam raporu: Her gün 18:00 (Europe/Istanbul), model: haiku',
    );
    expect(
      describeAction('mcp__leafbot__routine_update', { routine: 'Akşam raporu', model: '' }, { bot: 'Ali' })
        .detail,
    ).toBe('model: botun kendi modeli');
    await t.send(thread.id, '[araç:routine_update {"routine":"Akşam raporu","model":""}]');
    await t.services.turns.idle();
    expect((await all()).find((r) => r.id === mine.id)!.model).toBe('');

    // Not a manager: Veli's routine is out of reach, by name or by naming Veli.
    await t.send(thread.id, '[araç:routine_delete {"routine":"Rapor","bot":"Veli"}]');
    await t.services.turns.idle();
    expect(await last()).toContain('Yalnız kendi rutinlerini');
    await t.send(thread.id, '[araç:routine_delete {"routine":"Rapor"}]');
    await t.services.turns.idle();
    expect(await last()).toContain('"Rapor" adında bir rutin yok. Rutinler: Akşam raporu');
    expect((await all()).some((r) => r.id === theirs.id)).toBe(true);

    await t.send(thread.id, '[araç:routine_delete {"routine":"Akşam raporu"}]');
    await t.services.turns.idle();
    expect(await last()).toContain('"Akşam raporu" rutini silindi');
    expect((await all()).some((r) => r.id === mine.id)).toBe(false);
  });

  it('bot rutinini okuyabilir, başkasınınkini okuyamaz; okuma kart istemez', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Veli' });
    await routine(a.id);
    await routine(b.id);
    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    const last = async () => (await t.messages(thread.id)).at(-1)!.text;

    // Default permission mode: a changing tool would wait for a card, a read does not.
    await t.send(thread.id, '[araç:routine_read {"routine":"rapor"}]');
    await t.services.turns.idle();
    const text = await last();
    expect(text).toContain('"Rapor" rutini');
    expect(text).toContain('Talimat:\nRaporu yaz');
    expect(text).toContain('Son çalışma: henüz çalışmadı');
    expect(text).toContain('Yalnız bakıp rapor eder: false');

    await t.send(thread.id, '[araç:routine_read {"routine":"Rapor","bot":"Veli"}]');
    await t.services.turns.idle();
    expect(await last()).toContain('Yalnız kendi rutinlerini');
  });

  it('yönetici bot başka botların rutinlerini kapatıp silebilir, başka yöneticininkini değil', async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true, permissionMode: 'auto' });
    const other = await t.bot({ name: 'Şef', isManager: true });
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Veli' });
    const ra = await routine(a.id);
    const rb = await routine(b.id);
    await routine(other.id);
    const thread = (await t.api<Thread>('GET', `/api/bots/${m.id}/main-thread`)).body;
    const last = async () => (await t.messages(thread.id)).at(-1)!.text;
    const all = async () => (await t.api<Routine[]>('GET', '/api/routines')).body;

    // Two bots have a routine of that name: the manager is asked to say whose.
    await t.send(thread.id, '[araç:routine_update {"routine":"Rapor","enabled":false}]');
    await t.services.turns.idle();
    expect(await last()).toContain('birden çok rutin var (Ali, Veli)');

    await t.send(thread.id, '[araç:routine_update {"routine":"Rapor","bot":"Ali","enabled":false}]');
    await t.services.turns.idle();
    expect((await all()).find((r) => r.id === ra.id)).toMatchObject({ enabled: false });

    await t.send(thread.id, '[araç:routine_delete {"routine":"Rapor","bot":"Veli"}]');
    await t.services.turns.idle();
    expect(await last()).toContain('"Rapor" rutini silindi');
    expect((await all()).some((r) => r.id === rb.id)).toBe(false);

    await t.send(thread.id, '[araç:routine_delete {"routine":"Rapor","bot":"Şef"}]');
    await t.services.turns.idle();
    expect(await last()).toContain('Başka bir yöneticiyi');
    expect((await all()).filter((r) => r.botId === other.id)).toHaveLength(1);

    expect(
      describeAction(
        'mcp__leafbot__routine_update',
        { routine: 'Rapor', bot: 'Ali', enabled: false },
        { bot: 'Müdür' },
      ).want,
    ).toBe('Müdür "Ali" botunun "Rapor" rutinini kapatmak istiyor.');
    expect(
      describeAction('mcp__leafbot__routine_delete', { routine: 'Rapor' }, { bot: 'Müdür', locale: 'en' })
        .want,
    ).toBe('Müdür wants to delete the routine "Rapor".');
  });

  it('bot rutin çalışmasını nedeniyle başarısız işaretleyebilir; webhook isteyerek rutin kurabilir', async () => {
    const a = await t.bot({ name: 'Ali', permissionMode: 'auto' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Kur',
        prompt: '[araç:routine_failed {"reason":"Döviz servisi kapalı"}]',
        schedule: { type: 'daily', time: '23:00' },
      })
    ).body;
    await t.api('POST', `/api/routines/${r.id}/run`);
    await t.services.turns.idle();
    expect((await runs(r.id)).map((x) => [x.status, x.reason])).toEqual([['error', 'Döviz servisi kapalı']]);

    // A routine whose work is done stops itself.
    const remind = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Hatırlat',
        prompt: '[araç:routine_stop {"reason":"Kullanıcı cevap verdi"}]',
        schedule: { type: 'interval', minutes: 30 },
      })
    ).body;
    await t.api('POST', `/api/routines/${remind.id}/run`);
    await t.services.turns.idle();
    const stopped = (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.id === remind.id)!;
    expect(stopped).toMatchObject({ enabled: false, nextRunAt: null });

    const thread = (await t.api<Thread>('GET', `/api/bots/${a.id}/main-thread`)).body;
    await t.send(
      thread.id,
      '[araç:routine_create {"name":"CI","prompt":"Derlemeyi incele","schedule":{"type":"once","date":"2026-12-01","time":"10:00"},"webhook":true}]',
    );
    await t.services.turns.idle();
    const ci = (await t.api<Routine[]>('GET', '/api/routines')).body.find((x) => x.name === 'CI')!;
    expect(ci.webhookToken).toBeTruthy();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain(
      `/api/hooks/routines/${ci.id}/${ci.webhookToken}`,
    );
  });

  it('silinen rutinin sırada bekleyen işi de gider', async () => {
    await t.dispose();
    t = await testServer({ maxConcurrentTurns: 1 });
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Veli' });
    const busy = (await t.api<Thread>('GET', `/api/bots/${b.id}/main-thread`)).body;
    await t.send(busy.id, '[bekle:1500]');
    const r = await routine(a.id);
    await t.api('POST', `/api/routines/${r.id}/run`);
    expect((await t.api('DELETE', `/api/routines/${r.id}`)).status).toBe(200);
    await t.services.turns.idle();
    expect(t.engine.requests.some((x) => x.prompt.includes('Raporu yaz'))).toBe(false);
  });

  it('kuyrukta bekleyen rutin turu durdurulursa çalıştırma kapanır, rutin sonra yine çalışır', async () => {
    await t.dispose();
    t = await testServer({ maxConcurrentTurns: 1 });
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Veli' });
    const busy = (await t.api<Thread>('GET', `/api/bots/${b.id}/main-thread`)).body;
    await t.send(busy.id, '[bekle:3000]');
    const r = await routine(a.id);
    const first = (await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`)).body;
    await t.api('POST', `/api/threads/${first.threadId}/stop`);
    await t.api('POST', `/api/threads/${busy.id}/stop`);
    await t.services.turns.idle();

    expect((await runs(r.id)).map((x) => x.status)).toEqual(['stopped']);
    expect((await runAgain(r.id))?.status).toBe('running');
    await t.services.turns.idle();
  });

  it('sunucu turun ortasında durduysa yeniden açılınca çalıştırma kapanır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = await routine(a.id);
    await crashedRun(r, a.id, true);
    await t.services.turns.recover();

    const [run] = await runs(r.id);
    expect(run).toMatchObject({ status: 'error', reason: 'Sunucu yeniden başladı' });
    expect((await runAgain(r.id))?.status).toBe('running');
    await t.services.turns.idle();
  });

  it('turu kuyruğa girmeden kalan çalıştırma açılışta kapanır; süren çalıştırmaya dokunulmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const orphan = await routine(a.id);
    await crashedRun(orphan, a.id, false);
    const live = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Uzun',
        prompt: '[bekle:1000]',
        schedule: { type: 'interval', minutes: 5 },
      })
    ).body;
    await t.api('POST', `/api/routines/${live.id}/run`);
    await t.services.routines.recover();
    expect((await runs(live.id))[0]!.status).toBe('running');

    expect((await runs(orphan.id))[0]).toMatchObject({ status: 'error', reason: 'Sunucu yeniden başladı' });
    await t.services.turns.idle();
    expect((await runs(live.id))[0]!.status).toBe('done');
  });

  it('geçersiz saat dilimi ve zamanlama reddedilir', async () => {
    const a = await t.bot({ name: 'Ali' });
    const bad = await t.api('POST', '/api/routines', {
      botId: a.id,
      name: 'x',
      prompt: 'x',
      schedule: { type: 'daily', time: '25:00' },
      timezone: 'Mars/Olympus',
    });
    expect(bad.status).toBe(400);
  });
});
