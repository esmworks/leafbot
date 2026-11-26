import {
  questionItems,
  type Approval,
  type BotSummary,
  type Message,
  type Bot,
  type DeltaEvent,
  type LiveText,
  type TurnEvent,
  type Thread,
} from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWNER_ID } from '../src/users';
import {
  endsSilent,
  isSilentReply,
  maybeSilentReply,
  planItems,
  withoutSilentEnd,
} from '../src/engine/types';
import { resetTime } from '../src/engine/claude';
import { CONTEXT_FULL } from '../src/runtime/turns';
import { OVERLOADED } from '../src/engine/types';
import { sql } from 'drizzle-orm';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';
import { isStopRequest } from '../src/util';

describe('sohbet', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;

  it('mesaj gönderir, bot cevap verir ve oturum sonraki turda sürer', async () => {
    const bot = await t.bot({ name: 'Kahya' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    let msgs = await t.messages(thread.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(msgs[1]!.text).toContain('Yankı: merhaba');
    expect(msgs[1]!.text).toContain('(oturum 1. tur)');

    await t.send(thread.id, 'ikinci');
    await t.services.turns.idle();
    msgs = await t.messages(thread.id);
    expect(msgs.at(-1)!.text).toContain('(oturum 2. tur)');
    // The engine was asked to resume the stored session.
    expect(t.engine.requests.at(-1)!.sessionId).toBe(`fake-${thread.id}`);
    expect(t.engine.requests.at(-1)!.systemPrompt).toContain('Kahya');
    // A long conversation may reach the bot only as a summary: it is told where the exact words are.
    expect(t.engine.requests.at(-1)!.systemPrompt).toContain('`conversations_search` ile ara');
    // The time goes with each message, so the system prompt reads the same turn after turn and the
    // model's prompt cache holds.
    const [first, second] = t.engine.requests.slice(-2);
    expect(second!.systemPrompt).toBe(first!.systemPrompt);
    expect(second!.context).toMatch(/^\[Şu an .+ \(.+\)\.\]$/);
  });

  it('baştan başlayan sohbet yeni bir oturum açar ve öncesini devretmez', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, 'adım Ayşe');
    await t.services.turns.idle();
    expect((await t.api('POST', `/api/threads/${thread.id}/reset`)).status).toBe(200);
    expect((await t.messages(thread.id)).at(-1)!.props.kind).toBe('contextReset');
    await t.send(thread.id, 'adım neydi');
    await t.services.turns.idle();
    const last = t.engine.requests.at(-1)!;
    expect(last.sessionId).toBeNull();
    expect(last.prompt).toBe('adım neydi');
  });

  it('a session holding tools from before an update hands the conversation to a new one, and says so', async () => {
    const bot = await t.bot({ name: 'Paşa' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'adım Ayşe');
    await t.services.turns.idle();
    t.engine.outdate(`fake-${thread.id}`, ['routine_create', 'routine_update']);

    await t.send(thread.id, 'rutine koşul ekle');
    await t.services.turns.idle();
    const msgs = await t.messages(thread.id);
    const note = msgs.find((m) => m.props.kind === 'toolsHandoff')!;
    expect(note.text).toContain('routine_create, routine_update');
    const [stale, fresh] = t.engine.requests.slice(-2);
    expect(stale!.sessionId).toBe(`fake-${thread.id}`);
    expect(fresh!.sessionId).toBeNull();
    expect(fresh!.prompt).toMatch(/adım Ayşe/);
    expect(msgs.at(-1)!.text).toContain('rutine koşul ekle');
  });

  it('oturumun kaydı silinince yeni bir oturum son konuşmayı alıp devam eder', async () => {
    const bot = await t.bot({ name: 'Kahya' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'adım Ayşe');
    await t.services.turns.idle();
    t.engine.forget(`fake-${thread.id}`);

    await t.send(thread.id, 'adımı hatırlıyor musun?');
    await t.services.turns.idle();
    const msgs = await t.messages(thread.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    const [lost, retry] = t.engine.requests.slice(-2);
    expect(lost!.sessionId).toBe(`fake-${thread.id}`);
    expect(retry!.sessionId).toBeNull();
    // The earlier exchange goes along; the new message comes last and only once.
    expect(retry!.prompt).toMatch(/Kullanıcı \[[^\]]+\]: adım Ayşe/);
    expect(retry!.prompt).toMatch(/Kahya \[[^\]]+\]: Yankı: adım Ayşe/);
    expect(retry!.prompt.endsWith('adımı hatırlıyor musun?')).toBe(true);
    expect(retry!.prompt.split('adımı hatırlıyor musun?')).toHaveLength(2);

    // The new session is the thread's from now on.
    await t.send(thread.id, 'üçüncü');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.sessionId).toBe(`fake-${thread.id}-1`);
    expect(t.engine.requests.at(-1)!.prompt).toBe('üçüncü');
  });

  it('motor değişince yeni oturum sohbetin geçmişini alır', async () => {
    const bot = await t.bot({ name: 'Kahya' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'ilk konu');
    await t.services.turns.idle();
    await t.services.threads.setSession(thread.id, null);
    await t.send(thread.id, 'devam');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.sessionId).toBeNull();
    expect(t.engine.requests.at(-1)!.prompt).toMatch(/Kullanıcı \[[^\]]+\]: ilk konu/);
  });

  it('aynı istemci kimliğiyle gelen mesajı bir kez işler', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const body = { clientId: 'sabit-kimlik-1', text: 'bir kez' };
    const a = await t.api<Message>('POST', `/api/threads/${thread.id}/messages`, body);
    const b = await t.api<Message>('POST', `/api/threads/${thread.id}/messages`, body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    await t.services.turns.idle();
    expect(t.engine.requests).toHaveLength(1);
  });

  it('bağlantı yokken yazılıp sonra giden mesaj öyle işaretlenir; bot ona yine bir kez cevap verir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const body = { clientId: 'cevrimdisi-1', text: 'trende yazdım', offline: true };
    const a = await t.api<Message>('POST', `/api/threads/${thread.id}/messages`, body);
    const b = await t.api<Message>('POST', `/api/threads/${thread.id}/messages`, body);
    expect(a.status).toBe(201);
    expect(a.body.props.sentOffline).toBe(true);
    expect(b.body.id).toBe(a.body.id);
    const plain = await t.api<Message>('POST', `/api/threads/${thread.id}/messages`, {
      clientId: 'cevrimici-1',
      text: 'şimdi',
    });
    expect(plain.body.props.sentOffline).toBeUndefined();
    await t.services.turns.idle();
    expect(t.engine.requests.some((r) => r.prompt.includes('trende yazdım'))).toBe(true);
  });

  it('adım sınırına takılan turun notu kaldığı yerden devam edilebileceğini işaretler', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[adım-sınırı] uzun iş');
    await t.services.turns.idle();
    const note = (await t.messages(thread.id)).at(-1)!;
    expect(note.role).toBe('error');
    expect(note.props).toMatchObject({ kind: 'engine', stepLimit: true });
    // Going on is an ordinary message in the same session, which still holds the work so far.
    await t.send(thread.id, 'Kaldığın yerden devam et.');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.sessionId).toBeTruthy();
    expect((await t.messages(thread.id)).at(-1)!.role).toBe('assistant');
  });

  it('bot bir adımın kartını beklerken yazılan mesaj kartı kapatır; bot o sözlerle devam eder', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:Bash {"command":"git push origin main"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    const before = t.engine.requests.length;
    await t.send(thread.id, 'hayır, önce testleri çalıştır');
    await t.services.turns.idle();
    expect((await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body).toMatchObject({
      status: 'denied',
      answer: 'hayır, önce testleri çalıştır',
    });
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('Bash: reddedildi (Kullanıcı bu adımı onaylamadı');
    expect(reply).toContain('hayır, önce testleri çalıştır');
    // The words went to the waiting turn; no second turn answers them again.
    expect(t.engine.requests.length).toBe(before);
  });

  it('bot işin bir parçasını kendi adına yeni bir sohbette başlatır; bir turda en çok beşini', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(
      thread.id,
      '[araç:open_conversation {"title":"Fiyat araştırması","message":"Üç mağazanın fiyatını karşılaştır."}]',
    );
    await t.services.turns.idle();
    const threads = (await t.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body;
    const fresh = threads.find((x) => x.title === 'Fiyat araştırması')!;
    expect(fresh).toBeTruthy();
    const first = (await t.messages(fresh.id))[0]!;
    expect(first).toMatchObject({
      role: 'user',
      author: `bot:${bot.id}`,
      text: 'Üç mağazanın fiyatını karşılaştır.',
    });
    // It ran there in a turn of its own.
    expect(t.engine.requests.some((r) => r.threadId === fresh.id && r.prompt.includes('sen açtın'))).toBe(
      true,
    );
    const note = (await t.messages(thread.id)).find((m) => m.props.openedThread)!;
    expect(note.props.openedThread).toBe(fresh.id);
    expect(note.text).toContain('Fiyat araştırması');

    const six = Array.from(
      { length: 6 },
      (_, i) => `[araç:open_conversation {"title":"İş ${i}","message":"yap"}]`,
    ).join(' ');
    await t.send(thread.id, six);
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('en çok 5 sohbet');
  });

  it('sohbete listede tanınması için bir emoji simgesi verilir; düz metin simge olmaz', async () => {
    const bot = await t.bot();
    const th = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, { title: 'Tatil' })).body;
    expect((await t.api<Thread>('PATCH', `/api/threads/${th.id}`, { icon: '✈️' })).body.icon).toBe('✈️');
    expect((await t.api('PATCH', `/api/threads/${th.id}`, { icon: 'tatil' })).status).toBe(400);
    const listed = (await t.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body.find(
      (x) => x.id === th.id,
    );
    expect(listed?.icon).toBe('✈️');
    expect((await t.api<Thread>('PATCH', `/api/threads/${th.id}`, { icon: '' })).body.icon).toBe('');
  });

  it('izin kartı: izin ver, reddet ve hatırla', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:Write {"file_path":"a.txt"}]');
    const card = await waitFor(async () => {
      const r = await t.api<Approval[]>('GET', '/api/approvals?status=pending');
      return r.body[0];
    });
    expect(card.toolName).toBe('Write');
    expect((await t.api<Thread>('GET', `/api/threads/${thread.id}`)).body.state).toBe('waiting');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', remember: true });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Write: izin verildi');
    // Answering twice is refused.
    expect((await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' })).status).toBe(409);

    // "Always allow" put the bot on full access: Write goes without a card now.
    expect((await t.api<Bot>('GET', `/api/bots/${bot.id}`)).body.permissionMode).toBe('auto');
    await t.send(thread.id, '[izin:Write {"file_path":"b.txt"}]');
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Write: izin verildi');

    // Back on "ask", a step it has not been allowed asks again.
    await t.api('PATCH', `/api/bots/${bot.id}`, { permissionMode: 'ask' });
    await t.send(thread.id, '[izin:Bash {"command":"rm -rf x"}]');
    const card2 = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    await t.api('POST', `/api/approvals/${card2.id}`, { decision: 'deny' });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Bash: reddedildi');
  });

  it('"Hep izin ver" aynı turdaki sonraki istekleri de sormadan geçirir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:Write {"file_path":"a"}] [izin:Write {"file_path":"b"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', remember: true });
    await t.services.turns.idle();
    const last = (await t.messages(thread.id)).at(-1)!.text;
    expect(last.match(/Write: izin verildi/g)).toHaveLength(2);
    expect((await t.api<Approval[]>('GET', '/api/approvals')).body).toHaveLength(1);
  });

  it('"Her zaman sor" kuralının kapsadığı kartta "Hep izin ver" kaydedilmez; kart kuralı anar', async () => {
    const bot = await t.bot({ permissionMode: 'ask' });
    const thread = await main(bot.id);
    await t.api('POST', '/api/rules', { list: 'ask', pattern: 'WebSearch' });
    await t.send(thread.id, '[izin:WebSearch {"query":"a"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    const shown = (await t.messages(thread.id)).find((m) => m.role === 'approval')!;
    expect(shown.props.askRule).toBe('WebSearch');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', remember: true });
    await t.services.turns.idle();
    const answered = (await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body;
    expect(answered.status).toBe('allowed');
    expect(answered.remembered).toBe(false);
    const rules = (await t.api<{ list: string }[]>('GET', '/api/rules')).body;
    expect(rules.filter((r) => r.list === 'allow')).toHaveLength(0);
  });

  it('"Hep izin ver" yalnızca aynı botun bekleyen kartlarını kapatır', async () => {
    const a = await t.bot({ name: 'Bir' });
    const b = await t.bot({ name: 'İki' });
    const own = await main(a.id);
    const second = await t.services.threads.create(a.id, { title: 'İkinci iş', userId: OWNER_ID });
    await t.send(own.id, '[izin:Write {"file_path":"a"}]');
    await t.send(second.id, '[izin:Write {"file_path":"a2"}]');
    await t.send((await main(b.id)).id, '[izin:Write {"file_path":"b"}]');
    const pending = await waitFor(async () => {
      const r = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
      return r.length === 3 ? r : undefined;
    });
    const first = pending.find((p) => p.input.file_path === 'a')!;
    const answered = await t.api<Approval>('POST', `/api/approvals/${first.id}`, {
      decision: 'allow',
      remember: true,
    });
    expect(answered.body.remembered).toBe(true);
    // The same bot's card goes through; another bot's keeps waiting: full access is for the bot
    // that asked.
    const left = await waitFor(async () => {
      const r = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
      return r.length === 1 ? r : undefined;
    });
    expect(left.map((x) => x.input.file_path)).toEqual(['b']);
    expect((await t.api<Bot>('GET', `/api/bots/${a.id}`)).body.permissionMode).toBe('auto');
    expect((await t.api<Bot>('GET', `/api/bots/${b.id}`)).body.permissionMode).toBe('ask');
    for (const c of left) await t.api('POST', `/api/approvals/${c.id}`, { decision: 'deny' });
    await t.services.turns.idle();
  });

  it('"Her zaman sor" kuralı izin listesinden önce gelir; okuma araçları sormaz', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.api('POST', '/api/rules', { list: 'ask', pattern: 'Bash(git push*)' });
    await t.send(thread.id, '[izin:Read {"file_path":"x"}] [izin:Bash {"command":"ls"}]');
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toMatch(/Read: izin verildi[\s\S]*Bash: izin verildi/);
    await t.send(thread.id, '[izin:Bash {"command":"git push origin main"}]');
    await waitFor(async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0]);
    // The card says which rule stopped a bot that could otherwise go ahead.
    const card = await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'approval'));
    expect(card.props.heldBy).toBe('Bash(git push*)');
  });

  it('bot çalışırken değiştirilen onay seviyesi sonraki adımda geçerli olur', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:Bash {"command":"npm test"}] [izin:Write {"file_path":"a"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(card.toolName).toBe('Bash');
    await t.api('PATCH', `/api/bots/${bot.id}`, { permissionMode: 'auto' });
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow' });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Write: izin verildi');
    expect((await t.api<Approval[]>('GET', '/api/approvals')).body).toHaveLength(1);
  });

  it('botun kendi klasöründeki düz okuma komutu, salt okunurken bile kart açmaz', async () => {
    const bot = await t.bot({ permissionMode: 'readonly' });
    const thread = await main(bot.id);
    await t.send(
      thread.id,
      '[izin:Bash {"command":"cat notlar.md"}] [izin:Bash {"command":"cat /etc/passwd"}]',
    );
    await t.services.turns.idle();
    const last = (await t.messages(thread.id)).at(-1)!.text;
    expect(last).toMatch(/Bash: izin verildi[\s\S]*Bash: reddedildi/);
    expect((await t.api<Approval[]>('GET', '/api/approvals')).body).toHaveLength(0);
  });

  it('salt okunur bot yazamaz, kart açılmaz', async () => {
    const bot = await t.bot({ permissionMode: 'readonly' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:Write {"file_path":"a"}] [izin:Read {"file_path":"a"}]');
    await t.services.turns.idle();
    const last = (await t.messages(thread.id)).at(-1)!.text;
    expect(last).toContain('Write: reddedildi');
    expect(last).toContain('Read: izin verildi');
    expect((await t.api<Approval[]>('GET', '/api/approvals')).body).toHaveLength(0);
  });

  it('bot çalışırken yalnızca "dur" yazmak turu durdurur; daha uzun bir mesaj sırada bekler', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[bekle:10000]');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    await t.send(thread.id, 'Dur lütfen!');
    await t.services.turns.idle();
    const texts = (await t.messages(thread.id)).map((m) => m.text);
    expect(texts.at(-1)).toBe('Durduruldu.');
    expect(texts).toContain('Dur lütfen!');
    expect(isStopRequest('stop')).toBe(true);
    expect(isStopRequest('iptal et')).toBe(true);
    expect(isStopRequest('stop using tabs')).toBe(false);
    expect(isStopRequest('durumu anlat')).toBe(false);
  });

  it('durdur: süren tur kesilir, sohbet sonra çalışmaya devam eder', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[bekle:10000]');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    const r = await t.api<{ stopped: boolean }>('POST', `/api/threads/${thread.id}/stop`);
    expect(r.body.stopped).toBe(true);
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toBe('Durduruldu.');
    await t.send(thread.id, 'tekrar');
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Yankı: tekrar');
  });

  it('durdurulan ya da hata veren turun isteği bir kez yeniden çalıştırılır; sonrasında bir şey olduysa çalışmaz', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[bekle:600] iş');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();
    const stopped = (await t.messages(thread.id)).at(-1)!;
    expect(stopped.text).toBe('Durduruldu.');
    const r = await t.api<{ turnId: string }>('POST', `/api/messages/${stopped.id}/retry`);
    expect(r.status).toBe(200);
    await t.services.turns.idle();
    expect(t.engine.requests.filter((x) => x.prompt.endsWith('[bekle:600] iş'))).toHaveLength(2);
    expect((await t.messages(thread.id)).at(-1)!.role).toBe('assistant');
    // Once is enough.
    expect((await t.api('POST', `/api/messages/${stopped.id}/retry`)).status).toBe(409);

    // A failed request after which the person wrote again is not run out of order.
    await t.send(thread.id, '[hata] bozuk');
    await t.services.turns.idle();
    const failed = (await t.messages(thread.id)).at(-1)!;
    expect(failed.role).toBe('error');
    await t.send(thread.id, 'başka bir şey');
    await t.services.turns.idle();
    expect((await t.api('POST', `/api/messages/${failed.id}/retry`)).status).toBe(409);
  });

  it('kayıt zamanı mikrosaniyeli olan son tur da yeniden çalıştırılır, dal da o mesajı içerir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[hata] bozuk');
    await t.services.turns.idle();
    // Postgres keeps microseconds; a row read into a Date keeps only milliseconds.
    await t.db.db.execute(
      sql`update turns set created_at = date_trunc('milliseconds', created_at) + interval '500 microseconds' where thread_id = ${thread.id}`,
    );
    await t.db.db.execute(
      sql`update messages set created_at = date_trunc('milliseconds', created_at) + interval '500 microseconds' where thread_id = ${thread.id}`,
    );
    const all = await t.messages(thread.id);
    const asked = all.find((m) => m.role === 'user')!;
    const branch = (await t.api<Thread>('POST', `/api/messages/${asked.id}/fork`)).body;
    expect((await t.messages(branch.id)).map((m) => m.text)).toEqual(['[hata] bozuk']);
    const failed = all.at(-1)!;
    expect(failed.role).toBe('error');
    expect((await t.api('POST', `/api/messages/${failed.id}/retry`)).status).toBe(200);
  });

  it('bot meşgulken art arda gelen mesajlar tek turda birlikte cevaplanır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[bekle:800]');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    const one = await t.send(thread.id, 'birinci not');
    const two = await t.send(thread.id, 'ikinci not');
    await t.services.turns.idle();
    const asked = t.engine.requests.filter((r) => r.prompt.includes('not'));
    expect(asked).toHaveLength(1);
    expect(asked[0]!.prompt).toBe('birinci not\n\nikinci not');
    const msgs = await t.messages(thread.id);
    const turnOf = (id: string) => msgs.find((m) => m.id === id)!.turnId;
    expect(turnOf(one.id)).toBe(turnOf(two.id));
    expect(msgs.filter((m) => m.props.queued)).toEqual([]);
  });

  it('bot meşgulken gelen mesaj sırada bekler; başlamadan düzenlenir ya da geri çekilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[bekle:1500]');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    const first = await t.send(thread.id, 'ilk hali');
    const second = await t.send(thread.id, 'vazgeçilecek');
    expect(first.props.queued).toBe(true);
    expect(first.turnId).toBeTruthy();

    const edited = await t.api<Message>('PATCH', `/api/messages/${first.id}`, { text: 'son hali' });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ text: 'son hali', props: { queued: true, edited: true } });
    expect((await t.api('DELETE', `/api/messages/${second.id}`)).status).toBe(200);

    await t.services.turns.idle();
    const msgs = await t.messages(thread.id);
    expect(msgs.some((m) => m.text === 'vazgeçilecek')).toBe(false);
    expect(msgs.find((m) => m.id === first.id)!.props.queued).toBeUndefined();
    expect(msgs.at(-1)!.text).toContain('Yankı: son hali');
    expect(t.engine.requests.some((r) => r.prompt.includes('vazgeçilecek'))).toBe(false);
    // Once started, it stays as it was.
    expect((await t.api('PATCH', `/api/messages/${first.id}`, { text: 'geç' })).status).toBe(409);
    // A message already answered can still be removed from the conversation.
    expect((await t.api('DELETE', `/api/messages/${first.id}`)).status).toBe(200);
    expect((await t.messages(thread.id)).some((m) => m.id === first.id)).toBe(false);
  });

  it('sıradaki mesaj çalışan işe iletilir; bot onu bir sonraki adımında okur', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[bekle:800] [araç:memory_search {"query":"x"}]');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    const extra = await t.send(thread.id, 'faturayı da ekle');
    const steered = await t.api<Message>('POST', `/api/messages/${extra.id}/steer`);
    expect(steered.status).toBe(200);
    expect(steered.body.props).toMatchObject({ queued: true, steering: true });
    await t.services.turns.idle();
    expect(t.engine.requests).toHaveLength(1);
    const msgs = await t.messages(thread.id);
    expect(msgs.at(-1)!.text).toContain('faturayı da ekle');
    const handed = msgs.find((m) => m.id === extra.id)!;
    expect(handed.props.queued).toBeUndefined();
    expect(handed.props.steering).toBeUndefined();
    expect(handed.turnId).toBe(msgs.at(-1)!.turnId);
    // Nothing runs: the message keeps waiting for its own turn.
    expect((await t.api('POST', `/api/messages/${extra.id}/steer`)).status).toBe(409);
  });

  it('bot araç kullanmadan biterse iletilmek istenen mesaj kendi turunda çalışır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[bekle:600]');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    const extra = await t.send(thread.id, 'sonra bak');
    expect((await t.api('POST', `/api/messages/${extra.id}/steer`)).status).toBe(200);
    await t.services.turns.idle();
    expect(t.engine.requests.map((r) => r.prompt)).toEqual(['[bekle:600]', 'sonra bak']);
    const msg = (await t.messages(thread.id)).find((m) => m.id === extra.id)!;
    expect(msg.props.steering).toBeUndefined();
  });

  it('bot meşgulken yazılan mesaj kendiliğinden çalışan işe iletilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[bekle:800] [araç:memory_search {"query":"x"}]');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    const extra = await t.send(thread.id, 'faturayı da ekle');
    await t.services.turns.idle();
    expect(t.engine.requests).toHaveLength(1);
    const msgs = await t.messages(thread.id);
    expect(msgs.at(-1)!.text).toContain('faturayı da ekle');
    const handed = msgs.find((m) => m.id === extra.id)!;
    expect(handed.turnId).toBe(msgs.at(-1)!.turnId);
    expect(handed.props.steering).toBeUndefined();
  });

  it('durdurulan işe yeni mesaj iletilmez; kendi turunda çalışır ve olay yeni turu söyler', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const events: TurnEvent[] = [];
    const off = t.services.ctx.bus.on('turn', (e) => {
      if (e.threadId === thread.id) events.push(e);
    });
    await t.send(thread.id, '[söz:Yarım] [bekle:3000] [araç:memory_search {"query":"x"}]');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    const first = t.services.turns.liveText(thread.id)!.turnId;
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    const again = await t.send(thread.id, 'baştan söyle');
    await t.services.turns.idle();
    off();
    expect(t.engine.requests.map((r) => r.prompt).at(-1)).toBe('baştan söyle');
    expect((await t.messages(thread.id)).find((m) => m.id === again.id)!.props.steering).toBeUndefined();
    // The next turn is named as it starts, so a client drops the stopped turn's text then.
    expect(events.some((e) => e.state === 'running' && e.turnId === first)).toBe(true);
    expect(events.some((e) => e.state === 'running' && e.turnId === again.turnId)).toBe(true);
    expect(events.at(-1)).toMatchObject({ state: 'idle', turnId: null });
  });

  it('çalışan turun şimdiye dek yazdığı okunur; her parça nereden başladığını söyler', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const deltas: DeltaEvent[] = [];
    const off = t.services.ctx.bus.on('delta', (e) => {
      if (e.threadId === thread.id) deltas.push(e);
    });
    expect(
      (await t.api<{ live: LiveText | null }>('GET', `/api/threads/${thread.id}/live`)).body.live,
    ).toBeNull();
    await t.send(thread.id, '[söz:Merhaba] [bekle:600] [söz:dünya]');
    const live = await waitFor(async () => {
      const r = await t.api<{ live: LiveText | null }>('GET', `/api/threads/${thread.id}/live`);
      return r.body.live?.text ? r.body.live : undefined;
    });
    expect(live.text).toBe('Merhaba');
    await t.services.turns.idle();
    off();
    expect(deltas[0]).toMatchObject({ turnId: live.turnId, at: 0 });
    let text = '';
    for (const d of deltas) {
      expect(d.at).toBe(text.length);
      text += d.text;
    }
    expect(
      (await t.api<{ live: LiveText | null }>('GET', `/api/threads/${thread.id}/live`)).body.live,
    ).toBeNull();
  });

  it('karttaki onay beklenirken durdurulursa kart süresi dolar', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:Write {"file_path":"a"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();
    expect((await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body.status).toBe('expired');
  });

  it('giriş yoksa açık bir hata mesajı ve durum güncellenir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[giriş-yok]');
    await t.services.turns.idle();
    const last = (await t.messages(thread.id)).at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('Ayarlar → Bağlantı → Claude');
    expect(t.info().claude.status).toBe('logged-out');
  });

  it('aynı anda en fazla N tur; kullanıcı turu bot turundan önce başlar', async () => {
    await t.dispose();
    t = await testServer({ maxConcurrentTurns: 1 });
    const bot = await t.bot();
    const a = await main(bot.id);
    const b = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    const c = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    await t.send(a.id, '[bekle:200] ilk');
    await waitFor(async () => t.services.turns.isRunning(a.id));
    await t.services.turns.enqueue({ threadId: b.id, botId: bot.id, source: 'bot', prompt: 'bot işi' });
    await t.send(c.id, 'kullanıcı');
    await t.services.turns.idle();
    const order = t.engine.requests.map((r) => r.prompt);
    expect(order).toEqual(['[bekle:200] ilk', 'kullanıcı', 'bot işi']);
  });

  it('birkaç soruyu tek kartta sorar; cevaplar sırayla bota gider ve kartta kalır', async () => {
    const bot = await t.bot({ name: 'Teklifçi' });
    const thread = await main(bot.id);
    const call = {
      title: 'Teklifin son ayarları',
      questions: [
        { question: 'Kondenser hangisi olsun?', context: 'Oda 40 m³', options: ['GBOX 50', 'GBOX 40'] },
        { question: 'Ödeme şekli ne olsun?', options: ['Peşin', 'Vadeli'] },
      ],
    };
    await t.send(thread.id, `[araç:ask_user ${JSON.stringify(call)}]`);
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(card.kind).toBe('question');
    expect(card.summary).toBe('Teklifin son ayarları');
    expect(card.input.questions).toHaveLength(2);
    expect(questionItems(card).items[0]!.context).toBe('Oda 40 m³');
    await t.api('POST', `/api/approvals/${card.id}`, {
      decision: 'allow',
      answers: ['GBOX 50', '30 gün vadeli'],
    });
    await t.services.turns.idle();
    const last = (await t.messages(thread.id)).at(-1)!.text;
    expect(last).toContain('Kondenser hangisi olsun? → GBOX 50');
    expect(last).toContain('Ödeme şekli ne olsun? → 30 gün vadeli');
    const kept = (await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body;
    expect(kept.status).toBe('allowed');
    expect(JSON.parse(kept.answer!)).toEqual(['GBOX 50', '30 gün vadeli']);
  });

  it('bot tek soruluk kartta beklerken yazılan mesaj o soruyu yanıtlar', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const call = { questions: [{ question: 'Hangi şehir?', options: ['İstanbul', 'Ankara'] }] };
    await t.send(thread.id, `[araç:ask_user ${JSON.stringify(call)}]`);
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    await t.send(thread.id, 'İzmir olsun');
    await t.services.turns.idle();
    expect((await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body.answer).toBe('İzmir olsun');
    const msgs = await t.messages(thread.id);
    expect(msgs.find((m) => m.text === 'İzmir olsun')!.props.queued).toBeUndefined();
    expect(msgs.at(-1)!.text).toContain('İzmir olsun');
    // Only the bot's turn ran: the words did not start one of their own.
    expect(t.engine.requests.filter((r) => r.prompt.includes('İzmir olsun'))).toHaveLength(0);
  });

  it('bot çok soruluk kartta beklerken yazılan mesaj kartı kapatır; bot o sözleri okur', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const call = {
      questions: [
        { question: 'Hangi şehir?', options: ['İstanbul', 'Ankara'] },
        { question: 'Hangi gün?', options: ['Pazartesi', 'Salı'] },
      ],
    };
    await t.send(thread.id, `[araç:ask_user ${JSON.stringify(call)}]`);
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    const typed = await t.send(thread.id, 'Önce fiyatı söyle, sonra karar veririm');
    await t.services.turns.idle();
    const kept = (await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body;
    expect(kept.status).toBe('denied');
    expect(kept.answer).toBeNull();
    const msgs = await t.messages(thread.id);
    // The bot was told the card was set aside, and read the words in the same turn.
    expect(msgs.at(-1)!.text).toContain('sohbete yazdı');
    expect(msgs.at(-1)!.text).toContain('Önce fiyatı söyle, sonra karar veririm');
    expect(msgs.find((m) => m.id === typed.id)!.turnId).toBe(msgs.at(-1)!.turnId);
    expect(t.engine.requests).toHaveLength(1);
  });

  it('gizli cevap yalnızca bota gider; kart ve kayıt onu boş tutar', async () => {
    const bot = await t.bot({ name: 'Kurucu' });
    const thread = await main(bot.id);
    const call = {
      title: 'Servis bağlantısı',
      questions: [
        { question: 'Hangi hesap?', options: ['Kişisel', 'İş'] },
        { question: 'API anahtarı nedir?', secret: true },
      ],
    };
    await t.send(thread.id, `[araç:ask_user ${JSON.stringify(call)}]`);
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(card.input.questions).toEqual([
      { question: 'Hangi hesap?', options: ['Kişisel', 'İş'] },
      { question: 'API anahtarı nedir?', options: [], secret: true },
    ]);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answers: ['İş', 'sk-gizli-123'] });
    await t.services.turns.idle();
    // The fake engine writes back what its tool returned: the bot got the secret, marked as one.
    const last = (await t.messages(thread.id)).at(-1)!.text;
    expect(last).toContain('API anahtarı nedir? → sk-gizli-123 (gizli cevap');
    const kept = (await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body;
    expect(JSON.parse(kept.answer!)).toEqual(['İş', '']);
    const rows = await t.db.db.select().from(schema.approvals);
    expect(JSON.stringify(rows)).not.toContain('sk-gizli-123');
  });

  it('seçenekler {label, description} nesnesi olarak da gelebilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const call = { question: 'Hangisi?', options: [{ label: 'Kısa', description: 'tek paragraf' }, 'Uzun'] };
    await t.send(thread.id, `[araç:ask_user ${JSON.stringify(call)}]`);
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(card.options).toEqual(['Kısa', 'Uzun']);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answers: ['Kısa'] });
    await t.services.turns.idle();
  });

  it('tek gizli soruda da cevap kartta tutulmaz', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(
      thread.id,
      `[araç:ask_user ${JSON.stringify({ questions: [{ question: 'Kod?', secret: true }] })}]`,
    );
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answer: '424242' });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Kod? → 424242');
    const kept = (await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body;
    expect(kept.status).toBe('allowed');
    expect(kept.answer).toBeNull();
  });

  it('izin kartının özeti düz Türkçe; "Hep izin ver" kaydedilir', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:Bash {"command":"npm test"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(card.summary).toBe('Katip bilgisayarda bir komut çalıştırmak istiyor.');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', remember: true });
    await t.services.turns.idle();
    expect((await t.api<Approval>('GET', `/api/approvals/${card.id}`)).body.remembered).toBe(true);
  });

  it('kullanıcının mesajına emoji ile tepki verir; geçersiz emojiyi reddeder', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, 'teşekkürler [araç:react {"emoji":"🙏"}]');
    await t.services.turns.idle();
    let msgs = await t.messages(thread.id);
    expect(msgs[0]!.props.reaction).toBe('🙏');
    expect(t.engine.requests.at(-1)!.systemPrompt).toContain('`react`');

    // A second message gets its own reaction; the first keeps its own.
    await t.send(thread.id, 'harika [araç:react {"emoji":"👍🏽"}]');
    await t.services.turns.idle();
    msgs = await t.messages(thread.id);
    expect(msgs.filter((m) => m.role === 'user').map((m) => m.props.reaction)).toEqual(['🙏', '👍🏽']);

    await t.send(thread.id, '[araç:react {"emoji":"tamam"}]');
    await t.services.turns.idle();
    msgs = await t.messages(thread.id);
    expect(msgs.at(-2)!.props.reaction).toBeUndefined();
    expect(msgs.at(-1)!.text).toContain('react: Geçersiz girdi');
  });

  it('botun bir mesajına yanıt: alıntı mesajda kalır ve bota istemle gider', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '## Ciro\n\n| Dönem | TL |\n| --- | --- |\n| 11.11 | **24.680** |');
    await t.services.turns.idle();
    const answered = (await t.messages(thread.id)).find((m) => m.role === 'assistant')!;

    const r = await t.api<Message>('POST', `/api/threads/${thread.id}/messages`, {
      clientId: 'yanit-kimligi-1',
      text: 'bunu düzelt',
      replyTo: answered.id,
    });
    expect(r.status).toBe(201);
    expect(r.body.props.replyTo).toEqual({
      id: answered.id,
      text: expect.stringContaining('Dönem TL 11.11 24.680'),
    });
    await t.services.turns.idle();
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt).toContain('senin şu mesajına yanıt veriyor');
    expect(prompt).toContain(`> ${answered.text.split('\n')[0]}`);
    expect(prompt.trimEnd().endsWith('bunu düzelt')).toBe(true);

    // A message from another conversation cannot be answered.
    const other = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    const bad = await t.api('POST', `/api/threads/${other.id}/messages`, {
      clientId: 'yanit-kimligi-2',
      text: 'x',
      replyTo: answered.id,
    });
    expect(bad.status).toBe(404);
  });

  it('kişi botun mesajına emoji bırakır; bot yerleşen son tepkiyi bir kez duyar', async () => {
    await t.dispose();
    t = await testServer({ reactionDelayMs: 300 });
    const settle = async () => {
      await new Promise((r) => setTimeout(r, 450));
      await t.services.turns.idle();
    };
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    const [mine, theirs] = await t.messages(thread.id);
    const react = (id: string, emoji: string | null) =>
      t.api<Message>('PUT', `/api/messages/${id}/reaction`, { emoji });
    const turns = t.engine.requests.length;

    // Tried and taken off again: the bot hears nothing.
    const set = await react(theirs!.id, '👍🏽');
    expect(set.status).toBe(200);
    expect(set.body.props.userReaction).toBe('👍🏽');
    await react(theirs!.id, '❤️');
    expect((await t.messages(thread.id))[1]!.props.userReaction).toBe('❤️');
    await react(theirs!.id, null);
    expect((await t.messages(thread.id))[1]!.props.userReaction).toBeUndefined();
    await settle();
    expect(t.engine.requests.length).toBe(turns);

    // Changed a few times, then left: one turn, about the last emoji, quoting the message.
    await react(theirs!.id, '👍');
    await react(theirs!.id, '👎');
    await settle();
    expect(t.engine.requests.length).toBe(turns + 1);
    const req = t.engine.requests.at(-1)!;
    const prompt = req.prompt;
    // It may answer in words or stay quiet; the tools and rules stay those of every turn.
    expect(req.systemPrompt).toBe(t.engine.requests[0]!.systemPrompt);
    expect(req.tools.some((x) => x.name === 'ask_user')).toBe(true);
    expect(prompt).toContain('👎 tepkisini bıraktı');
    expect(prompt).toContain(`> ${theirs!.text.split('\n')[0]}`);
    expect(prompt).toContain('NO_REPLY');
    expect((await t.messages(thread.id)).filter((m) => m.role === 'assistant')).toHaveLength(2);

    // Putting back the emoji it already heard of tells it nothing new.
    await react(theirs!.id, null);
    await react(theirs!.id, '👎');
    await settle();
    expect(t.engine.requests.length).toBe(turns + 1);

    expect((await react(theirs!.id, 'tamam')).status).toBe(400);
    expect((await react(mine!.id, '👍')).status).toBe(400);
  });

  it('botun sessiz cevabı sohbete yazılmaz', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const delta = vi.spyOn(t.services.ctx.bus, 'delta');
    await t.services.turns.enqueue({
      threadId: thread.id,
      botId: bot.id,
      source: 'user',
      prompt: '[sessiz]',
    });
    await t.services.turns.idle();
    expect(await t.messages(thread.id)).toEqual([]);
    // Not even streamed: the page never shows it while it is written.
    expect(delta).not.toHaveBeenCalled();

    // Only the reply itself is silent; an answer that merely starts like it is held, then shown.
    expect(isSilentReply(' NO_REPLY. ')).toBe(true);
    expect(isSilentReply('NO_REPLY, ama bir sorum var')).toBe(false);
    expect(endsSilent('Değişiklik yok.\n\nNO_REPLY.\n')).toBe(true);
    expect(endsSilent('NO_REPLY')).toBe(false);
    expect(endsSilent('\n\nNO_REPLY')).toBe(false);
    expect(endsSilent('Yok, NO_REPLY')).toBe(false);
    expect(withoutSilentEnd('Değişiklik yok.\n\nNO_REPLY')).toBe('Değişiklik yok.');

    // In a conversation with the person, what the bot wrote above it is shown, without the marker.
    await t.services.turns.enqueue({
      threadId: thread.id,
      botId: bot.id,
      source: 'user',
      prompt: '[sessiz-son]',
    });
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).map((m) => m.text)).toEqual(['Değişiklik yok.']);
    expect(maybeSilentReply('NO_RE')).toBe(true);
    expect(maybeSilentReply('NO ')).toBe(true);
    expect(maybeSilentReply('NO bir')).toBe(false);
  });

  it('boş biten kullanıcı turu bir notla belirtilir; rutin turu not almaz', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    for (const source of ['user', 'routine'] as const) {
      await t.services.turns.enqueue({ threadId: thread.id, botId: bot.id, source, prompt: '[boş]' });
      await t.services.turns.idle();
    }
    const msgs = await t.messages(thread.id);
    expect(msgs.map((m) => [m.role, m.props.kind])).toEqual([['system', 'noReply']]);
  });

  it('yanıt, kart ve hata için bildirim olayı yayar; botlar arası yazışma için yaymaz', async () => {
    const notice = vi.spyOn(t.services.ctx.bus, 'notice');
    const bot = await t.bot({ name: 'Katip' });
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(notice).toHaveBeenLastCalledWith(
      expect.objectContaining({ kind: 'reply', botId: bot.id, threadId: thread.id }),
    );
    await t.send(thread.id, '[hata]');
    await t.services.turns.idle();
    expect(notice).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'error' }));
    await t.send(thread.id, '[izin:Write {"file_path":"/tmp/x"}]');
    await waitFor(async () => notice.mock.calls.some(([e]) => e.kind === 'needsYou'));
    // The bot's summary names the card it waits on, for the sidebar's "Needs you" section.
    const summary = (await t.api<BotSummary[]>('GET', '/api/summaries')).body.find(
      (x) => x.botId === bot.id,
    )!;
    expect(summary.waiting).toMatchObject({ kind: 'tool', threadId: thread.id });
    await t.api('POST', `/api/threads/${thread.id}/stop`);
    await t.services.turns.idle();

    notice.mockClear();
    const peer = await t.services.threads.peerThread(bot.id, (await t.bot({ name: 'Diğer' })).id, OWNER_ID);
    await t.services.turns.enqueue({ threadId: peer.id, botId: bot.id, source: 'bot', prompt: 'selam' });
    await t.services.turns.idle();
    expect(notice).not.toHaveBeenCalled();
  });

  it('botun planı turda tek bir mesajdır ve son haliyle kalır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[plan] işe başla');
    await t.services.turns.idle();
    const plans = (await t.messages(thread.id)).filter((m) => Array.isArray(m.props.plan));
    expect(plans).toHaveLength(1);
    expect(plans[0]!.props.plan).toEqual([
      { text: 'Oku', status: 'completed' },
      { text: 'Yaz', status: 'in_progress' },
    ]);
    expect(
      planItems({ todos: [{ content: ' A ', status: 'completed' }, { content: '' }, { content: 'B' }] }),
    ).toEqual([
      { text: 'A', status: 'completed' },
      { text: 'B', status: 'pending' },
    ]);
    expect(planItems({})).toBeNull();

    // A Pi bot writes its plan with plan_update; a Claude bot has its own to-do tool instead.
    expect(t.engine.requests.at(-1)!.tools.some((x) => x.name === 'plan_update')).toBe(false);
    const pi = await t.bot({ engine: 'pi', model: 'openai/gpt-4o-mini' });
    const piThread = await main(pi.id);
    await t.send(piThread.id, '[araç:plan_update {"todos":[{"content":"Ara","status":"in_progress"}]}]');
    await t.services.turns.idle();
    const piPlan = (await t.messages(piThread.id)).find((m) => Array.isArray(m.props.plan));
    expect(piPlan?.props.plan).toEqual([{ text: 'Ara', status: 'in_progress' }]);
  });

  it('bot kendi diğer sohbetlerinde konuşulanları okuyabilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    const other = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    await t.send(other.id, 'Fatura numarası 42 için not al');
    await t.services.turns.idle();
    await t.send(thread.id, '[araç:my_activity {"days":1,"query":"fatura"}]');
    await t.services.turns.idle();
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('Fatura numarası 42');
  });

  it('bot eski sohbetlerinde arar ve bir mesajı tam okur; başka botunkini göremez', async () => {
    const bot = await t.bot();
    const other = await t.bot({ name: 'Diğer' });
    const thread = await main(bot.id);
    const old = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    const { message } = await t.services.threads.addMessage({
      threadId: old.id,
      role: 'user',
      author: 'user',
      text: `Kira sözleşmesi ${'ayrıntı '.repeat(100)}SONU`,
    });
    const foreign = await t.services.threads.addMessage({
      threadId: (await main(other.id)).id,
      role: 'user',
      author: 'user',
      text: 'Kira gizli not',
    });
    await t.send(thread.id, '[araç:conversations_search {"query":"kira"}]');
    await t.services.turns.idle();
    const found = (await t.messages(thread.id)).at(-1)!.text;
    expect(found).toContain(message.id);
    expect(found).not.toContain('gizli');
    await t.send(thread.id, `[araç:message_read {"message_id":"${message.id}"}]`);
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('SONU');
    await t.send(thread.id, `[araç:message_read {"message_id":"${foreign.message.id}"}]`);
    await t.services.turns.idle();
    expect((await t.messages(thread.id)).at(-1)!.text).not.toContain('gizli');
  });

  it('bot yanıtının altına hızlı cevaplar koyabilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:quick_replies {"options":["Evet","Hayır","Evet"]}]');
    await t.services.turns.idle();
    const card = (await t.messages(thread.id)).find((m) => Array.isArray(m.props.quickReplies));
    expect(card).toMatchObject({ role: 'system', props: { quickReplies: ['Evet', 'Hayır'] } });
  });

  it('motor sohbeti özetleyince sohbete bir işaret satırı düşer', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[özet] devam');
    await t.services.turns.idle();
    const line = (await t.messages(thread.id)).find((m) => m.props.kind === 'compacted');
    expect(line).toMatchObject({ role: 'system', author: 'system' });
  });

  it('bir mesajdan dal açılır: o mesaja kadarki yazışma kopyalanır, ilk tur onu bota aktarır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, 'birinci soru');
    await t.services.turns.idle();
    await t.send(thread.id, 'ikinci soru');
    await t.services.turns.idle();
    const firstReply = (await t.messages(thread.id)).find((m) => m.role === 'assistant')!;
    const branch = (await t.api<Thread>('POST', `/api/messages/${firstReply.id}/fork`)).body;
    expect(branch.id).not.toBe(thread.id);
    expect(branch.title).toContain('(dal)');
    const copied = await t.messages(branch.id);
    expect(copied.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(copied.some((m) => m.text.includes('ikinci'))).toBe(false);
    await t.send(branch.id, 'başka bir yol');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).toContain('birinci soru');
  });

  it('bir mesaj sohbetin üstüne sabitlenir; başka sohbetin mesajı sabitlenemez', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, 'önemli: kira 5 Aralık');
    await t.services.turns.idle();
    const msg = (await t.messages(thread.id)).find((m) => m.role === 'user')!;
    const pinned = (await t.api<Thread>('PUT', `/api/threads/${thread.id}/pin`, { messageId: msg.id })).body;
    expect(pinned.pinned).toEqual({ id: msg.id, text: 'önemli: kira 5 Aralık' });
    const listed = (await t.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body.find(
      (x) => x.id === thread.id,
    );
    expect(listed?.pinned?.id).toBe(msg.id);
    const other = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    expect((await t.api('PUT', `/api/threads/${other.id}/pin`, { messageId: msg.id })).status).toBe(404);
    const cleared = (await t.api<Thread>('PUT', `/api/threads/${thread.id}/pin`, { messageId: null })).body;
    expect(cleared.pinned).toBeNull();
  });

  it('arşivlenen sohbet ana sohbet olmaz; kişinin yeni mesajı onu listeye geri getirir', async () => {
    const bot = await t.bot();
    const first = await main(bot.id);
    await t.send(first.id, 'eski konu');
    await t.services.turns.idle();
    const second = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    await t.send(second.id, 'yeni konu');
    await t.services.turns.idle();
    expect((await main(bot.id)).id).toBe(second.id);
    const put = (await t.api<Thread>('PATCH', `/api/threads/${second.id}`, { archived: true })).body;
    expect(put.archivedAt).toBeTruthy();
    expect((await main(bot.id)).id).toBe(first.id);
    // A bot's message there leaves it archived.
    await t.services.threads.addMessage({
      threadId: second.id,
      role: 'assistant',
      author: `bot:${bot.id}`,
      text: 'rapor',
    });
    expect((await t.api<Thread>('GET', `/api/threads/${second.id}`)).body.archivedAt).toBeTruthy();
    await t.send(second.id, 'bir şey daha');
    await t.services.turns.idle();
    expect((await t.api<Thread>('GET', `/api/threads/${second.id}`)).body.archivedAt).toBeNull();
  });

  it('ertelenen sohbet ana sohbet olmaz, yeni bir mesajla uyanır; üstte tutma kaydedilir', async () => {
    const bot = await t.bot();
    const first = await main(bot.id);
    await t.send(first.id, 'eski konu');
    await t.services.turns.idle();
    const second = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    await t.send(second.id, 'yeni konu');
    await t.services.turns.idle();
    const until = new Date(Date.now() + 3_600_000).toISOString();
    const put = (
      await t.api<Thread>('PATCH', `/api/threads/${second.id}`, { snoozedUntil: until, pinned: true })
    ).body;
    expect(put.snoozedUntil).toBeTruthy();
    expect(put.pinnedAt).toBeTruthy();
    expect((await main(bot.id)).id).toBe(first.id);
    // A time in the past is refused.
    const past = new Date(Date.now() - 1000).toISOString();
    expect((await t.api('PATCH', `/api/threads/${second.id}`, { snoozedUntil: past })).status).toBe(400);
    // Any new message, a bot's too, wakes it.
    await t.services.threads.addMessage({
      threadId: second.id,
      role: 'assistant',
      author: `bot:${bot.id}`,
      text: 'hazır',
    });
    const woke = (await t.api<Thread>('GET', `/api/threads/${second.id}`)).body;
    expect(woke.snoozedUntil).toBeNull();
    expect(woke.pinnedAt).toBeTruthy();
  });

  it('bot bağlı olmayan bir uygulamayı sohbette önerebilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(
      thread.id,
      '[araç:app_suggest {"app":"Notion","reason":"Notlarına bakmam için"}] [araç:app_suggest {"app":"Yokistan","reason":"x"}]',
    );
    await t.services.turns.idle();
    const msgs = await t.messages(thread.id);
    const card = msgs.find((m) => m.props.suggestApp);
    expect(card).toMatchObject({
      role: 'system',
      text: 'Notlarına bakmam için',
      props: { suggestApp: 'notion' },
    });
    expect(msgs.at(-1)!.text).toContain('Yokistan uygulama kataloğunda yok');
  });

  it('bağlam penceresi taşınca ne yapılacağını söyleyen bir hata gösterir', () => {
    for (const m of [
      "This model's maximum context length is 8192 tokens",
      'the request exceeds the available context size (n_ctx 4096)',
      'prompt is too long: 210000 tokens > 200000 maximum',
    ])
      expect(CONTEXT_FULL.test(m)).toBe(true);
    expect(CONTEXT_FULL.test('connection refused')).toBe(false);
  });

  it('kullanım sınırı dolunca sıfırlanma saatini kişinin saat diliminde söyler', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[sınır]');
    const msgs = await t.messages(thread.id);
    const err = msgs.find((m) => m.role === 'error')!;
    expect(err.props.kind).toBe('limit');
    // 09:00 UTC is 12:00 in Istanbul.
    expect(err.text).toContain('12:00');
    expect(err.text).toContain('kullanım sınırı');
    expect(resetTime(1_763_283_600)?.toISOString()).toBe('2025-11-16T09:00:00.000Z');
    expect(resetTime(undefined)).toBeNull();
  });

  it('bağlam dolunca son konuşma bir kez yeni oturuma aktarılır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    await t.send(thread.id, '[bağlam-dolu] devam');
    await t.services.turns.idle();
    const last = t.engine.requests.at(-1)!;
    expect(last.sessionId).toBeNull();
    expect(last.prompt).toContain('merhaba');
    const msgs = await t.messages(thread.id);
    // The new session can read any handed message whole by its id.
    const hello = msgs.find((m) => m.role === 'user' && m.text === 'merhaba')!;
    expect(last.prompt).toContain(`[${hello.id}]: merhaba`);
    expect(msgs.some((m) => m.props.kind === 'contextHandoff')).toBe(true);
    expect(msgs.some((m) => m.role === 'error')).toBe(false);
    expect(msgs.at(-1)!.role).toBe('assistant');
  });

  it('Claude botun özetleme sınırı ayardan gelir; 200 binle başlar, geçersiz değer reddedilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    expect((await t.api('GET', '/api/settings')).body).toMatchObject({ claudeCompactWindow: 200_000 });
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.compactWindow).toBe(200_000);
    expect((await t.api('PATCH', '/api/settings', { claudeCompactWindow: 0 })).status).toBe(200);
    await t.send(thread.id, 'tekrar');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.compactWindow).toBe(0);
    expect((await t.api('PATCH', '/api/settings', { claudeCompactWindow: 50_000 })).status).toBe(400);
  });

  it('Claude botun danışman modeli ayardan gelir; kapalı başlar, geçersiz değer reddedilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    expect((await t.api('GET', '/api/settings')).body).toMatchObject({ claudeAdvisorModel: '' });
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!).not.toHaveProperty('advisorModel');

    expect((await t.api('PATCH', '/api/settings', { claudeAdvisorModel: 'opus' })).status).toBe(200);
    await t.send(thread.id, 'tekrar');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.advisorModel).toBe('opus');

    expect((await t.api('PATCH', '/api/settings', { claudeAdvisorModel: 'haiku' })).status).toBe(400);
    expect((await t.api('PATCH', '/api/settings', { claudeAdvisorModel: 'openrouter/x' })).status).toBe(400);
  });

  it('danışman, zaten o modelde çalışan bota ve yedek modelle süren işe gönderilmez', async () => {
    await t.api('PATCH', '/api/settings', { claudeAdvisorModel: 'opus', backupModel: 'openrouter/yedek' });
    // The same family under its full id is the same model.
    const same = await t.bot({ model: 'claude-opus-5-5' });
    await t.send((await main(same.id)).id, 'merhaba');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.model).toBe('claude-opus-5-5');
    expect(t.engine.requests.at(-1)!).not.toHaveProperty('advisorModel');

    const pi = await t.bot({ engine: 'pi', model: 'openrouter/baska' });
    await t.send((await main(pi.id)).id, 'merhaba');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.model).toBe('openrouter/baska');
    expect(t.engine.requests.at(-1)!).not.toHaveProperty('advisorModel');

    const bot = await t.bot();
    await t.send((await main(bot.id)).id, '[meşgul] bak');
    await t.services.turns.idle();
    // The bot's own run had the advisor; the backup, on another provider, has none.
    expect(t.engine.requests.at(-2)!.advisorModel).toBe('opus');
    expect(t.engine.requests.at(-1)!.model).toBe('openrouter/yedek');
    expect(t.engine.requests.at(-1)!).not.toHaveProperty('advisorModel');
  });

  it('Pi botun danışmanı kendi ayarından gelir; Claude ayarı ona geçmez, geçersiz değer reddedilir', async () => {
    expect((await t.api('GET', '/api/settings')).body).toMatchObject({ piAdvisorModel: '' });
    await t.api('PATCH', '/api/settings', { claudeAdvisorModel: 'opus' });
    const pi = await t.bot({ engine: 'pi', model: 'openrouter/baska' });
    const thread = await main(pi.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!).not.toHaveProperty('advisorModel');

    expect((await t.api('PATCH', '/api/settings', { piAdvisorModel: 'openai/gpt-x' })).status).toBe(200);
    await t.send(thread.id, 'tekrar');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.advisorModel).toBe('openai/gpt-x');

    // A bot already on the advisor's model has nobody stronger to ask.
    const same = await t.bot({ engine: 'pi', model: 'openai/gpt-x' });
    await t.send((await main(same.id)).id, 'merhaba');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!).not.toHaveProperty('advisorModel');

    expect((await t.api('PATCH', '/api/settings', { piAdvisorModel: 'opus' })).status).toBe(400);
  });

  it('motor bağlamın dolduğunu kendi bildirince de son konuşma yeni oturuma aktarılır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    await t.send(thread.id, '[bağlam-bayrak] devam');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.sessionId).toBeNull();
    // What the old session had summarised goes to the new one.
    expect(t.engine.requests.at(-1)!.prompt).toContain('ÖZET: devredilen konuşma');
    const msgs = await t.messages(thread.id);
    expect(msgs.some((m) => m.props.kind === 'contextHandoff')).toBe(true);
    expect(msgs.some((m) => m.role === 'error')).toBe(false);
  });

  it('model aşırı yüklüyse yedek model işi sürdürür', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.api('PATCH', '/api/settings', { backupModel: 'openrouter/yedek' });
    await t.send(thread.id, '[meşgul] bak');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.model).toBe('openrouter/yedek');
    const msgs = await t.messages(thread.id);
    expect(msgs.find((m) => m.props.kind === 'backupModel')!.text).toContain('yanıt veremiyor');
    expect(msgs.some((m) => m.role === 'error')).toBe(false);
  });

  it('Claude girişi geçersizse yedek model işi sürdürür ve yeniden girişi söyler', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.api('PATCH', '/api/settings', { backupModel: 'openrouter/yedek' });
    await t.send(thread.id, '[giriş-yok] bak');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.model).toBe('openrouter/yedek');
    const msgs = await t.messages(thread.id);
    expect(msgs.find((m) => m.props.kind === 'backupModel')!.text).toContain('yeniden giriş');
    expect(msgs.some((m) => m.role === 'error')).toBe(false);
    // The backup carried the turn, yet the account is still shown as signed out.
    expect(t.info().claude.status).toBe('logged-out');
  });

  it('bakiyesi biten sağlayıcıda yedek model işi sürdürür ve bakiyeyi söyler', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.api('PATCH', '/api/settings', { backupModel: 'openrouter/yedek' });
    await t.send(thread.id, '[bakiye] bak');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.model).toBe('openrouter/yedek');
    const msgs = await t.messages(thread.id);
    expect(msgs.find((m) => m.props.kind === 'backupModel')!.text).toContain('bakiyesi bitti');
    expect(msgs.some((m) => m.role === 'error')).toBe(false);
  });

  it('modeli artık sunulmayan botun işini yedek model sürdürür ve model seçmeyi söyler', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.api('PATCH', '/api/settings', { backupModel: 'openrouter/yedek' });
    await t.send(thread.id, '[model-yok] bak');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.model).toBe('openrouter/yedek');
    const msgs = await t.messages(thread.id);
    expect(msgs.find((m) => m.props.kind === 'backupModel')!.text).toContain('artık sunulmuyor');
    expect(msgs.some((m) => m.role === 'error')).toBe(false);
  });

  it('sağlayıcı isteği reddederse yedek model işi sürdürür ve aynı model yeniden denenmez', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.api('PATCH', '/api/settings', { backupModel: 'openrouter/yedek' });
    await t.send(thread.id, '[reddedildi] bak');
    await t.services.turns.idle();
    expect(t.engine.requests.map((r) => r.model)).toEqual([bot.model, 'openrouter/yedek']);
    const msgs = await t.messages(thread.id);
    expect(msgs.find((m) => m.props.kind === 'backupModel')!.text).toContain('reddetti');
    expect(msgs.some((m) => m.role === 'error')).toBe(false);
  });

  it('sağlayıcı isteği reddedip yedek model yoksa tur hatayla biter', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[reddedildi] bak');
    await t.services.turns.idle();
    expect(t.engine.requests).toHaveLength(1);
    const msgs = await t.messages(thread.id);
    expect(msgs.at(-1)!.role).toBe('error');
  });

  it('bakiye bitince yedek model yoksa tur hatayla biter', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[bakiye] bak');
    await t.services.turns.idle();
    const msgs = await t.messages(thread.id);
    expect(msgs.some((m) => m.props.kind === 'backupModel')).toBe(false);
    expect(msgs.at(-1)!.role).toBe('error');
  });

  it('Claude Code işlemi çökerse aynı model bir kez daha denenir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[çöktü] dükkan nasıl');
    await t.services.turns.idle();
    const [first, second] = t.engine.requests.slice(-2);
    expect(second!.turnId).toBe(first!.turnId);
    expect(second!.model).toBe(first!.model);
    const msgs = await t.messages(thread.id);
    expect(msgs.find((m) => m.props.kind === 'retryCut')!.text).toContain('beklenmedik');
    expect(msgs.some((m) => m.role === 'error')).toBe(false);
  });

  it('işlem iki kez çökerse yedek modele geçilir; bir şey değiştirmiş tur yeniden denenmez', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.api('PATCH', '/api/settings', { backupModel: 'openrouter/yedek' });
    await t.send(thread.id, '[çöktü-hep] bak');
    await t.services.turns.idle();
    const turnId = t.engine.requests.at(-1)!.turnId;
    const models = t.engine.requests.filter((r) => r.turnId === turnId).map((r) => r.model);
    expect(models).toHaveLength(3);
    expect(models[2]).toBe('openrouter/yedek');

    await t.send(thread.id, '[izin:Write {"file_path":"a"}] [çöktü-hep]');
    await t.services.turns.idle();
    const acted = t.engine.requests.at(-1)!.turnId;
    expect(t.engine.requests.filter((r) => r.turnId === acted)).toHaveLength(1);
  });

  it('botun başlattığı alt ajan sohbette tek bir kartta izlenir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[alt-ajan] araştır');
    await t.services.turns.idle();
    const cards = (await t.messages(thread.id)).filter((m) => m.props.subagent);
    expect(cards).toHaveLength(1);
    await waitFor(async () => {
      const [card] = (await t.messages(thread.id)).filter((m) => m.props.subagent);
      return (card!.props.subagent as { state: string }).state === 'done' ? card : null;
    });
    const [card] = (await t.messages(thread.id)).filter((m) => m.props.subagent);
    const sub = card!.props.subagent as Record<string, unknown>;
    expect(sub).toMatchObject({
      description: 'Kaynakları tara',
      state: 'done',
      steps: 2,
      tool: 'WebSearch',
      result: 'Üç kaynak bulundu.',
    });
    // It says how long the helper worked.
    expect(Date.parse(sub.endedAt as string)).toBeGreaterThanOrEqual(Date.parse(sub.startedAt as string));
  });

  it('birlikte başlayan alt ajanlar tek bir grup kartında izlenir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[alt-ajanlar] daireleri incele');
    await t.services.turns.idle();
    const group = await waitFor(async () => {
      const cards = (await t.messages(thread.id)).filter((m) => m.props.subagents);
      const list = cards[0]?.props.subagents as { state: string }[] | undefined;
      return list?.every((s) => s.state !== 'running' && s.state !== 'waiting') ? cards : null;
    });
    expect(group).toHaveLength(1);
    const list = group[0]!.props.subagents as Record<string, unknown>[];
    expect(list.map((s) => [s.description, s.state, s.result])).toEqual([
      ['Birinci daireyi incele', 'done', 'Kira uygun.'],
      ['İkinci daireyi incele', 'done', 'Evcil hayvan yasak.'],
      ['Üçüncü daireyi incele', 'failed', 'Sayfa açılmadı.'],
    ]);
    // Apps that show one card see the group summed up.
    expect(group[0]!.props.subagent).toMatchObject({ state: 'failed' });
    expect(String((group[0]!.props.subagent as { description: string }).description)).toContain(
      '3 alt görev',
    );
  });

  it('aynı hatayı tekrar tekrar alan tur durdurulur ve nedeni yazılır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[döngü] ara');
    await t.services.turns.idle();
    const last = (await t.messages(thread.id)).at(-1)!;
    expect(last.role).toBe('error');
    expect(last.text).toContain('search');
    expect(last.text).toContain('5 kez');
  });

  it('sunucu hatası (500, 502, 504) geçici sayılır', () => {
    for (const raw of [
      'API Error: 500 {"type":"error","error":{"type":"api_error"}}',
      '502 Bad Gateway',
      'Gateway Timeout',
    ])
      expect(OVERLOADED.test(raw)).toBe(true);
    expect(OVERLOADED.test('400 invalid_request_error')).toBe(false);
    // The same numbers in another error are not a server's.
    expect(OVERLOADED.test('max_tokens: 500 is more than this model allows')).toBe(false);
    expect(OVERLOADED.test('the file has more than 500 lines')).toBe(false);
    expect(OVERLOADED.test('HTTP 504 from the provider')).toBe(true);
    expect(OVERLOADED.test('request failed with status code 502')).toBe(true);
  });

  it('bir şey değiştirmiş tur yedek modelde baştan çalıştırılmaz', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.api('PATCH', '/api/settings', { backupModel: 'openrouter/yedek' });
    await t.send(thread.id, '[izin:Write {"file_path":"a"}] [meşgul-sonra]');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.model).not.toBe('openrouter/yedek');
    const msgs = await t.messages(thread.id);
    expect(msgs.some((m) => m.props.kind === 'backupModel')).toBe(false);
    expect(msgs.at(-1)!.role).toBe('error');
    expect(CONTEXT_FULL.test('400 {"error":{"code":"context_length_exceeded"}}')).toBe(true);
  });

  it('yarıda kesilen yanıt aynı modelle bir kez daha denenir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[kesik] dükkan nasıl');
    await t.services.turns.idle();
    const [first, second] = t.engine.requests.slice(-2);
    expect(second!.turnId).toBe(first!.turnId);
    expect(second!.model).toBe(first!.model);
    expect(second!.prompt).toBe(first!.prompt);
    const msgs = await t.messages(thread.id);
    expect(msgs.find((m) => m.props.kind === 'retryCut')!.text).toContain('bir kez daha');
    expect(msgs.some((m) => m.role === 'error')).toBe(false);
    expect(msgs.at(-1)!.role).toBe('assistant');
  });

  it('kesilen yanıtın ikinci denemesi araya alınmış mesajı da taşır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[bekle:800] [araç:memory_search {"query":"x"}] [kesik] dükkan nasıl');
    await waitFor(async () => t.services.turns.isRunning(thread.id));
    const extra = await t.send(thread.id, 'faturayı da ekle');
    expect((await t.api('POST', `/api/messages/${extra.id}/steer`)).status).toBe(200);
    await t.services.turns.idle();
    const [first, second] = t.engine.requests.slice(-2);
    expect(second!.turnId).toBe(first!.turnId);
    expect(first!.prompt).not.toContain('faturayı da ekle');
    expect(second!.prompt).toContain('faturayı da ekle');
  });

  it('ikinci deneme de kesilirse iş yedek modele geçer', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.api('PATCH', '/api/settings', { backupModel: 'openrouter/yedek' });
    await t.send(thread.id, '[kesik-hep] bak');
    await t.services.turns.idle();
    const turnId = t.engine.requests.at(-1)!.turnId;
    const models = t.engine.requests.filter((r) => r.turnId === turnId).map((r) => r.model);
    expect(models).toHaveLength(3);
    expect(models[0]).toBe(models[1]);
    expect(models[2]).toBe('openrouter/yedek');
    const kinds = (await t.messages(thread.id)).map((m) => m.props.kind);
    expect(kinds).toContain('retryCut');
    expect(kinds).toContain('backupModel');
  });

  it('bir şey değiştirmiş tur kesilince yeniden denenmez', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:Write {"file_path":"a"}] [kesik]');
    await t.services.turns.idle();
    const turnId = t.engine.requests.at(-1)!.turnId;
    expect(t.engine.requests.filter((r) => r.turnId === turnId)).toHaveLength(1);
    const msgs = await t.messages(thread.id);
    expect(msgs.some((m) => m.props.kind === 'retryCut')).toBe(false);
    expect(msgs.at(-1)!.role).toBe('error');
  });

  it('sınıra takılan mesaj sınır kalkınca bir kez kendiliğinden yeniden gönderilir', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[sınır-bir-kez] rapor');
    await t.services.turns.idle();
    const note = (await t.messages(thread.id)).find((m) => m.role === 'error')!;
    expect(note.text).toContain('kendiliğinden yeniden gönderilecek');
    expect(note.props.retryAt).toBeTruthy();
    await waitFor(async () => (await t.messages(thread.id)).at(-1)!.role === 'assistant');
    await t.services.turns.idle();
    expect(t.engine.requests.filter((r) => r.prompt === '[sınır-bir-kez] rapor')).toHaveLength(2);
    const after = (await t.messages(thread.id)).find((m) => m.id === note.id)!;
    expect(after.props).toMatchObject({ retried: true });
    expect(after.props.retryAt).toBeUndefined();
  });

  it('yedek model seçilmemişse sınırda başka modele geçilmez; iş sıfırlanmayı bekler', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    expect((await t.api<{ backupModel: string }>('GET', '/api/settings')).body.backupModel).toBe('');
    await t.send(thread.id, '[sınır] rapor');
    await t.services.turns.idle();
    expect(new Set(t.engine.requests.map((r) => r.model)).size).toBe(1);
    expect(t.engine.requests.some((r) => r.model.includes('/'))).toBe(false);
    const msgs = await t.messages(thread.id);
    expect(msgs.some((m) => m.props.kind === 'backupModel')).toBe(false);
    const note = msgs.find((m) => m.role === 'error')!;
    expect(note.props.kind).toBe('limit');
    expect(note.props.retryAt).toBeTruthy();
  });

  it('bir şeyi değiştirdikten sonra sınıra takılan tur kendiliğinden yeniden gönderilmez', async () => {
    const bot = await t.bot({ permissionMode: 'auto' });
    const thread = await main(bot.id);
    await t.send(thread.id, '[izin:Write {"file_path":"a.txt"}] [sınır-sonra] yaz');
    await t.services.turns.idle();
    const acted = (await t.messages(thread.id)).filter((m) => m.role === 'error').at(-1)!;
    expect(acted.props.retryAt).toBeUndefined();
    expect(acted.text).toContain('kendiliğinden yeniden gönderilmeyecek');

    // Only reading leaves nothing to repeat: that message is still sent again.
    await t.send(thread.id, '[izin:Read {"file_path":"a.txt"}] [sınır-sonra] oku');
    await t.services.turns.idle();
    const read = (await t.messages(thread.id)).filter((m) => m.role === 'error').at(-1)!;
    expect(read.id).not.toBe(acted.id);
    expect(read.props.retryAt).toBeTruthy();
  });

  it('silinen sınır satırı yeniden göndermeyi iptal eder', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[sınır-bir-kez] iptal');
    await t.services.turns.idle();
    const note = (await t.messages(thread.id)).find((m) => m.role === 'error')!;
    expect((await t.api('DELETE', `/api/messages/${note.id}`)).status).toBe(200);
    await new Promise((r) => setTimeout(r, 600));
    await t.services.turns.idle();
    expect(t.engine.requests.filter((r) => r.prompt === '[sınır-bir-kez] iptal')).toHaveLength(1);
  });

  it('kullanım sınırı yaklaşınca dönem başına bir kez uyarır', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, '[sınır-yakın] bir');
    await t.services.turns.idle();
    await t.send(thread.id, '[sınır-yakın] iki');
    await t.services.turns.idle();
    const warnings = (await t.messages(thread.id)).filter((m) => m.props.kind === 'limitNear');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.text).toContain('%92');
    expect(warnings[0]!.text).toContain('12:00');
  });

  it('sınır dolunca yedek model işi yeni oturumla sürdürür, sohbetin oturumu korunur', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    const before = (await t.services.threads.row(thread.id)).engineSessionId;
    expect(before).toBeTruthy();
    await t.api('PATCH', '/api/settings', { backupModel: 'openrouter/yedek' });
    await t.send(thread.id, '[sınır] devam');
    const req = t.engine.requests.at(-1)!;
    expect(req.model).toBe('openrouter/yedek');
    expect(req.sessionId).toBeNull();
    expect(req.prompt).toContain('merhaba');
    const msgs = await t.messages(thread.id);
    expect(msgs.some((m) => m.role === 'error')).toBe(false);
    expect(msgs.find((m) => m.props.kind === 'backupModel')!.text).toContain('openrouter/yedek');
    expect(msgs.at(-1)!.role).toBe('assistant');
    const after = (await t.services.threads.row(thread.id)).engineSessionId;
    expect(after).toBe(before);
    // The turns and runs above were stamped by the real clock, so the report must count from it too.
    t.now.value = new Date();
    const turns = await t.api<{ models: { model: string }[] }>('GET', '/api/usage');
    expect(JSON.stringify(turns.body)).toContain('openrouter/yedek');
  });

  it('kullanıcıdan gelmeyen tur aynı araçları ve kuralları görür; tepki aracı orada emoji bırakmaz', async () => {
    const bot = await t.bot();
    const thread = await main(bot.id);
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    await t.services.turns.enqueue({
      threadId: thread.id,
      botId: bot.id,
      source: 'routine',
      prompt: '[araç:react {"emoji":"👍"}]',
    });
    await t.services.turns.idle();
    const [user, routine] = t.engine.requests.slice(-2);
    // The same tools and system prompt keep the conversation's prompt cache.
    expect(routine!.tools.map((x) => x.name)).toEqual(user!.tools.map((x) => x.name));
    expect(routine!.systemPrompt).toBe(user!.systemPrompt);
    const msgs = await t.messages(thread.id);
    expect(msgs.at(-1)!.text).toContain('emoji bırakılmadı');
    expect(msgs.some((m) => m.props.reaction)).toBe(false);
  });
});
