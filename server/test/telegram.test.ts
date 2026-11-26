import { createServer as httpServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Approval, TelegramStatus, Thread } from '@leafbot/shared';
import { telegramToken } from '@leafbot/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  discordMessages,
  slackMessages,
  slackPlain,
  telegramMessages,
  whatsappMessages,
} from '../src/channels/format';
import { schema } from '../src/db';
import { translator } from '../src/i18n';
import { testServer, waitFor, type TestServer } from './helpers';

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const PERSON = { id: 4242, is_bot: false, first_name: 'Ayşe', username: 'ayse' };

interface Call {
  method: string;
  body: Record<string, unknown>;
}

/** Telegram's Bot API, enough of it for one bot: updates are queued by the test, calls recorded. */
async function fakeTelegram() {
  const calls: Call[] = [];
  const updates: Record<string, unknown>[] = [];
  let nextUpdate = 1;
  let nextMessage = 1000;
  const files = new Map<string, Buffer>();
  // Refusals the test asks for: the next `times` calls that match are answered with an error.
  const faults: {
    match: (c: Call) => boolean;
    times: number;
    code: number;
    description: string;
    retryAfter?: number;
  }[] = [];
  const read = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  };
  const server: Server = httpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const file = /^\/file\/bot[^/]+\/(.+)$/.exec(url.pathname);
      if (file) {
        const data = files.get(file[1]!);
        res.writeHead(data ? 200 : 404).end(data);
        return;
      }
      const m = /^\/bot([^/]+)\/(\w+)$/.exec(url.pathname);
      const raw = await read(req);
      const type = req.headers['content-type'] ?? '';
      const body = type.includes('json')
        ? (JSON.parse(raw.toString() || '{}') as Record<string, unknown>)
        : { multipart: true };
      const reply = (result: unknown) =>
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, result }));
      if (!m || m[1] !== TOKEN) {
        res
          .writeHead(401, { 'content-type': 'application/json' })
          .end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }));
        return;
      }
      const method = m[2]!;
      if (method !== 'getUpdates') calls.push({ method, body });
      const fault =
        method === 'getUpdates' ? undefined : faults.find((f) => f.times > 0 && f.match(calls.at(-1)!));
      if (fault) {
        fault.times--;
        res.writeHead(fault.code, { 'content-type': 'application/json' }).end(
          JSON.stringify({
            ok: false,
            error_code: fault.code,
            description: fault.description,
            ...(fault.retryAfter !== undefined && { parameters: { retry_after: fault.retryAfter } }),
          }),
        );
        return;
      }
      if (method === 'getMe')
        return reply({ id: 777, is_bot: true, first_name: 'Araştırmacı', username: 'arastirma_bot' });
      if (method === 'getUpdates') {
        const offset = Number(body.offset ?? 0);
        const until = Date.now() + 300;
        while (Date.now() < until && !updates.some((u) => (u.update_id as number) >= offset)) {
          await new Promise((r) => setTimeout(r, 10));
        }
        return reply(updates.filter((u) => (u.update_id as number) >= offset));
      }
      if (method === 'getFile')
        return reply({ file_id: body.file_id, file_path: `docs/${String(body.file_id)}` });
      if (method === 'sendMessage' && String(body.text).includes('<b>bozuk')) {
        res
          .writeHead(400, { 'content-type': 'application/json' })
          .end(
            JSON.stringify({ ok: false, error_code: 400, description: "Bad Request: can't parse entities" }),
          );
        return;
      }
      if (method === 'sendMessage' || method === 'sendDocument')
        return reply({ message_id: nextMessage++, chat: { id: PERSON.id, type: 'private' }, date: 0 });
      return reply(true);
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    calls,
    files,
    /** A message from someone, as Telegram would hand it over. */
    write(text: string, from = PERSON, extra: Record<string, unknown> = {}) {
      const id = nextMessage++;
      updates.push({
        update_id: nextUpdate++,
        message: { message_id: id, from, chat: { id: from.id, type: 'private' }, date: 0, text, ...extra },
      });
      return id;
    },
    /** Answers the next `times` calls of `method` (whose text holds `text`, when given) with an error. */
    fail(method: string, code: number, description: string, times = 1, text = '', retryAfter?: number) {
      faults.push({
        match: (c) => c.method === method && String(c.body.text ?? '').includes(text),
        times,
        code,
        description,
        retryAfter,
      });
    },
    /** An update of any kind, as Telegram would hand it over. */
    push(update: Record<string, unknown>) {
      updates.push({ update_id: nextUpdate++, ...update });
    },
    press(data: string, messageId: number, from = PERSON) {
      updates.push({
        update_id: nextUpdate++,
        callback_query: {
          id: `cb${nextUpdate}`,
          from,
          data,
          message: { message_id: messageId, chat: { id: from.id } },
        },
      });
    },
    sent: (method = 'sendMessage') => calls.filter((c) => c.method === method),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe('Telegram', () => {
  let t: TestServer;
  let tg: Awaited<ReturnType<typeof fakeTelegram>>;
  afterEach(async () => {
    await t?.dispose();
    await tg?.close();
  });

  const setUp = async () => {
    tg = await fakeTelegram();
    t = await testServer({ telegramApi: tg.base, telegramPollSeconds: 0 });
    const bot = await t.bot({ name: 'Araştırmacı' });
    const r = await t.api<TelegramStatus>('PUT', `/api/bots/${bot.id}/telegram`, {
      token: `Done! Use this token to access the HTTP API:\n${TOKEN}\nKeep your token secure`,
    });
    expect(r.status).toBe(200);
    const code = new URL(r.body.pairLink!).searchParams.get('start')!;
    return { bot, status: r.body, code };
  };
  const pair = async (code: string) => {
    tg.write(`/start ${code}`);
    await waitFor(
      async () =>
        (
          await t.api<TelegramStatus>(
            'GET',
            `/api/bots/${(await t.api<{ id: string }[]>('GET', '/api/bots')).body[0]!.id}/telegram`,
          )
        ).body.owner,
    );
  };
  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;

  it("anahtarı BotFather'ın yanıtından bulur, Telegram'a sorar ve eşleşme bağlantısı verir", async () => {
    const { status } = await setUp();
    expect(status).toMatchObject({
      connected: true,
      bot: { username: 'arastirma_bot' },
      owner: null,
      error: null,
    });
    expect(status.pairLink).toMatch(/^https:\/\/t\.me\/arastirma_bot\?start=[\w-]{16,}$/);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
    expect(tg.calls.map((c) => c.method)).toEqual(
      expect.arrayContaining(['getMe', 'deleteWebhook', 'setMyCommands']),
    );
    expect(telegramToken('merhaba')).toBeNull();
    const bad = await t.api('PUT', `/api/bots/${(await t.bot()).id}/telegram`, {
      token: '999999:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(bad.status).toBe(400);
  });

  it("yalnızca eşleşen hesabı dinler; mesajı ana konuşmaya yazar ve yanıtı Telegram'a gönderir", async () => {
    const { bot, code } = await setUp();
    // Before pairing, and from a stranger after it, nothing is read.
    tg.write('merhaba yabancı', { id: 99, is_bot: false, first_name: 'X', username: 'x' });
    tg.write('/start yanlış-kod', { id: 99, is_bot: false, first_name: 'X', username: 'x' });
    await pair(code);
    expect((await t.api<TelegramStatus>('GET', `/api/bots/${bot.id}/telegram`)).body).toMatchObject({
      owner: { name: 'Ayşe (@ayse)' },
      pairLink: null,
    });
    tg.write('/start başkası', { id: 99, is_bot: false, first_name: 'X', username: 'x' });
    tg.write('Bugün **neler** var?');
    const thread = await main(bot.id);
    const reply = await waitFor(async () =>
      (await t.messages(thread.id)).find((m) => m.role === 'assistant'),
    );
    const person = (await t.messages(thread.id)).filter((m) => m.role === 'user');
    expect(person.map((m) => m.text)).toEqual(['Bugün **neler** var?']);
    expect(person[0]!.props.via).toBe('telegram');
    const out = await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('neler')));
    expect(out.body).toMatchObject({ chat_id: String(PERSON.id), parse_mode: 'HTML' });
    expect(out.body.text).toContain('<b>neler</b>');
    expect(reply.text).toContain('neler');
    // The stranger only ever heard that the code was wrong, while nobody had paired.
    const toStranger = tg.calls.filter((c) => String(c.body.chat_id) === '99');
    expect(toStranger.map((c) => c.body.text)).toEqual([expect.stringContaining('bağlantı kodu geçersiz')]);
  });

  it('iletilen mesaj kişinin sözü sayılmaz: komut olmaz, bota dış veri olarak gider', async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.write('/stop ve şunu yap', PERSON, {
      forward_origin: { type: 'user', sender_user: { first_name: 'Mehmet' } },
      forward_date: 1,
    });
    const thread = await main(bot.id);
    const said = await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'user'));
    expect(said.text).toBe('/stop ve şunu yap');
    expect(said.props).toMatchObject({ via: 'telegram', outside: 'forward', forwardedFrom: 'Mehmet' });
    const req = await waitFor(async () => t.engine.requests.find((r) => r.prompt.includes('/stop')));
    expect(req.prompt).toContain('Mehmet kaynağından iletilmiş bir mesaj');
    expect(req.prompt).toContain('<outside-data');
    await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'assistant'));
    const [turn] = await t.db.db.select().from(schema.turns);
    expect(turn!.outside).toBe('forward');
  });

  it('burada bilinmeyen bir mesaja verilen yanıt o mesajı alıntılayarak bota götürür', async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.write('bunu özetle', PERSON, {
      reply_to_message: {
        message_id: 777,
        chat: { id: PERSON.id, type: 'private' },
        date: 1,
        text: 'Toplantı perşembe 14:00\nGündem: bütçe',
        forward_origin: { type: 'user', sender_user: { first_name: 'Mehmet' } },
        forward_date: 1,
      },
    });
    const thread = await main(bot.id);
    const said = await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'user'));
    expect(said.text).toBe('> Toplantı perşembe 14:00\n> Gündem: bütçe\n\nbunu özetle');
    expect(said.props).toMatchObject({ via: 'telegram', outside: 'forward', forwardedFrom: 'Mehmet' });
    await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'assistant'));
  });

  it("kişi uygulamadan yazınca yanıt Telegram'a gitmez", async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.write('ilk');
    const thread = await main(bot.id);
    await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('ilk')));
    await t.services.turns.idle();
    await t.send(thread.id, 'uygulamadan yazdım');
    await t.services.turns.idle();
    await new Promise((r) => setTimeout(r, 100));
    expect(tg.sent().some((c) => String(c.body.text).includes('uygulamadan'))).toBe(false);
  });

  it("rutin raporu Telegram'a bir kez gider; diğer konuşmalardan haber kapalıyken gitmez", async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.write('ilk');
    await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('ilk')));
    await t.services.turns.idle();
    const r = (
      await t.api<{ id: string }>('POST', '/api/routines', {
        botId: bot.id,
        name: 'Akşam Ciro',
        prompt: 'ciroyu yaz',
        schedule: { type: 'interval', minutes: 60 },
      })
    ).body;
    const reports = () => tg.sent().filter((c) => String(c.body.text).includes('ciroyu yaz'));
    await t.api('POST', `/api/routines/${r.id}/run`, {});
    await t.services.turns.idle();
    await waitFor(async () => reports().length > 0);
    await new Promise((res) => setTimeout(res, 100));
    expect(reports()).toHaveLength(1);
    expect(String(reports()[0]!.body.text)).toContain('Akşam Ciro');

    await t.api('PATCH', `/api/bots/${bot.id}/telegram`, { notices: false });
    t.now.value = new Date(t.now.value.getTime() + 60 * 60_000);
    await t.api('POST', `/api/routines/${r.id}/run`, {});
    await t.services.turns.idle();
    await new Promise((res) => setTimeout(res, 100));
    expect(reports()).toHaveLength(1);
  });

  it("takip zamanı gelince haber kişi en son uygulamadan yazmış olsa da Telegram'a bir kez gider", async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.write('ilk');
    await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('ilk')));
    await t.services.turns.idle();
    // The person then writes in the app, not in Telegram.
    const main = (await t.api<{ id: string }>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(main.id, 'uygulamadan selam');
    await t.services.turns.idle();
    await t.services.followUps.add({
      bot,
      userId: 'owner',
      threadId: main.id,
      text: 'Öztürk Bey yarın fabrikaya geliyor',
      eventAt: new Date(t.now.value.getTime() + 26 * 3600_000),
      eventHasTime: true,
      dueAt: new Date(t.now.value.getTime() + 60_000),
      t: translator('tr'),
    });
    t.now.value = new Date(t.now.value.getTime() + 2 * 60_000);
    await t.services.followUps.tick();
    await t.services.turns.idle();
    const told = () => tg.sent().filter((c) => String(c.body.text).includes('Öztürk Bey yarın'));
    await waitFor(async () => told().length > 0);
    await new Promise((res) => setTimeout(res, 100));
    expect(told()).toHaveLength(1);
    expect(String(told()[0]!.body.text)).toContain('🔔');
  });

  it('izin kartını düğmelerle gönderir; düğmeye basmak kartı yanıtlar', async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.write('[izin:Write {"file_path":"a.txt"}]');
    const card = await waitFor(async () =>
      tg
        .sent()
        .find((c) => (c.body.reply_markup as { inline_keyboard?: unknown[] } | undefined)?.inline_keyboard),
    );
    const buttons = (
      card.body.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] }
    ).inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(['İzin ver', 'Hep izin ver (tam yetki)', 'Reddet']);
    const [pending] = (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body;
    expect(buttons[0]!.callback_data).toBe(`a:${pending!.id}:y`);
    // A stranger's press does nothing.
    tg.press(buttons[0]!.callback_data, 1000, { id: 99, is_bot: false, first_name: 'X', username: 'x' });
    tg.press(buttons[0]!.callback_data, 1000);
    await waitFor(
      async () => (await t.api<Approval>('GET', `/api/approvals/${pending!.id}`)).body.status === 'allowed',
    );
    await t.services.turns.idle();
    const thread = await main(bot.id);
    expect((await t.messages(thread.id)).at(-1)!.text).toContain('Write: izin verildi');
    await waitFor(async () => tg.sent('editMessageReplyMarkup').length > 0);
  });

  it('soruyu seçeneklerle gönderir; yazılan cevap da kartı yanıtlar', async () => {
    const { code } = await setUp();
    await pair(code);
    const call = { questions: [{ question: 'Hangisi?', options: ['Kırmızı', 'Mavi'] }] };
    tg.write(`[araç:ask_user ${JSON.stringify(call)}]`);
    const card = await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('Hangisi?')));
    const buttons = (
      card.body.reply_markup as { inline_keyboard: { text: string }[][] }
    ).inline_keyboard.flat();
    expect(buttons.map((b) => b.text)).toEqual(['Kırmızı', 'Mavi']);
    tg.write('Yeşil');
    await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('Yeşil')));
  });

  it('/stop çalışan işi durdurur; Telegram biçimi reddederse düz metin gönderir', async () => {
    const { code } = await setUp();
    await pair(code);
    tg.write('[bekle:5000]');
    await waitFor(async () => tg.sent('sendChatAction').length > 0);
    tg.write('/stop');
    await waitFor(async () => tg.sent().find((c) => c.body.text === 'Durdurdum.'));
    // The fake Telegram refuses HTML that holds "<b>bozuk".
    tg.write('**bozuk** metin');
    await waitFor(async () =>
      tg.sent().find((c) => String(c.body.text).includes('**bozuk** metin') && !c.body.parse_mode),
    );
  });

  it("gelen dosyayı konuşmaya ekler, botun gönderdiği dosyayı Telegram'a yollar", async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.files.set('docs/f1', Buffer.from('fatura içeriği'));
    tg.write('', PERSON, {
      caption: 'şuna bak',
      document: { file_id: 'f1', file_name: 'fatura.txt', file_size: 15 },
    });
    const thread = await main(bot.id);
    const person = await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'user'));
    expect(person.text).toBe('şuna bak');
    expect((person.props.files as { name: string }[]).map((f) => f.name)).toEqual(['fatura.txt']);
    await t.services.turns.idle();
    tg.write('[araç:send_file {"paths":["fatura.txt"]}]');
    await waitFor(async () => tg.sent('sendDocument').length > 0);
  });

  it('Telegram yavaşla (429) deyince bekleyip yeniden dener ve cevap tamam gider', async () => {
    const { code } = await setUp();
    await pair(code);
    tg.fail('sendMessage', 429, 'Too Many Requests: retry after 0', 1, 'merhaba', 0);
    tg.write('merhaba dünya');
    await waitFor(async () => tg.sent().filter((c) => String(c.body.text).includes('merhaba')).length >= 2);
    expect(tg.sent().some((c) => String(c.body.text).includes('uygulamada duruyor'))).toBe(false);
  });

  it('cevap denemelerden sonra da gitmezse kişiye bir kısmının iletilemediğini söyler', async () => {
    const { code } = await setUp();
    await pair(code);
    tg.fail('sendMessage', 429, 'Too Many Requests: retry after 0', 99, 'merhaba', 0);
    tg.write('merhaba dünya');
    const note = await waitFor(async () =>
      tg.sent().find((c) => String(c.body.text).includes('tamamı uygulamada duruyor')),
    );
    expect(note.body.chat_id).toBe(String(PERSON.id));
    expect(tg.sent().filter((c) => String(c.body.text).includes('merhaba'))).toHaveLength(3);
  });

  it('sunucu yarıda kalan isteği bırakırsa açılışta kişiye haber verir ve kaydı siler', async () => {
    const { bot, code } = await setUp();
    await pair(code);
    const thread = await main(bot.id);
    const [channel] = await t.db.db.select().from(schema.channels);
    await t.db.db
      .insert(schema.channelRequests)
      .values({ channelId: channel!.id, threadId: thread.id, place: { chat: String(PERSON.id) } });
    await t.services.telegram.start();
    await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('yarıda kaldı')));
    await waitFor(async () => (await t.db.db.select().from(schema.channelRequests)).length === 0);
  });

  it('bot engellenince kanalda hata görünür, geri alınınca silinir', async () => {
    const { bot, code } = await setUp();
    await pair(code);
    const change = (status: string) =>
      tg.push({
        my_chat_member: {
          chat: { id: PERSON.id, type: 'private' },
          from: PERSON,
          new_chat_member: { status },
        },
      });
    const error = async () => (await t.api<TelegramStatus>('GET', `/api/bots/${bot.id}/telegram`)).body.error;
    change('kicked');
    await waitFor(async () => (await error())?.includes('engelledin'));
    // Telegram answering the next poll does not clear it.
    await new Promise((r) => setTimeout(r, 400));
    expect(await error()).toContain('engelledin');
    change('member');
    await waitFor(async () => (await error()) === null);
  });

  it('gönderim 403 ile reddedilirse hata görünür; kişi yazınca silinir', async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.fail('sendMessage', 403, 'Forbidden: bot was blocked by the user', 1, 'merhaba');
    tg.write('merhaba dünya');
    const error = async () => (await t.api<TelegramStatus>('GET', `/api/bots/${bot.id}/telegram`)).body.error;
    await waitFor(async () => (await error())?.includes('engelledin'));
    expect(tg.sent().some((c) => String(c.body.text).includes('uygulamada duruyor'))).toBe(false);
    await t.services.turns.idle();
    tg.write('tekrar');
    await waitFor(async () => (await error()) === null);
    await t.services.turns.idle();
    await waitFor(async () => tg.sent().some((c) => String(c.body.text).includes('tekrar')));
    // Blocked again later: the note comes back, it was not left half-cleared by the message.
    tg.push({
      my_chat_member: {
        chat: { id: PERSON.id, type: 'private' },
        from: PERSON,
        new_chat_member: { status: 'kicked' },
      },
    });
    await waitFor(async () => (await error())?.includes('engelledin'));
  });

  it('onay işlenirken beklenmedik hata olsa da düğmeye basış yanıtlanır', async () => {
    const { code } = await setUp();
    await pair(code);
    tg.write('[izin:Write {"file_path":"a.txt"}]');
    const card = await waitFor(async () =>
      tg
        .sent()
        .find((c) => (c.body.reply_markup as { inline_keyboard?: unknown[] } | undefined)?.inline_keyboard),
    );
    const buttons = (
      card.body.reply_markup as { inline_keyboard: { callback_data: string }[][] }
    ).inline_keyboard.flat();
    t.services.approvals.answer = () => Promise.reject(new Error('beklenmedik'));
    tg.press(buttons[0]!.callback_data, 1000);
    const answered = await waitFor(async () => tg.sent('answerCallbackQuery')[0]);
    expect(answered.body.text).toBe('Bu işlem yapılamadı.');
    await new Promise((r) => setTimeout(r, 200));
    expect(tg.sent('answerCallbackQuery')).toHaveLength(1);
  });

  it('alınamayan dosya bota da söylenir', async () => {
    const { bot, code } = await setUp();
    await pair(code);
    tg.write('', PERSON, {
      caption: 'şuna bak',
      document: { file_id: 'yok', file_name: 'fatura.txt', file_size: 15 },
    });
    await waitFor(async () => tg.sent().find((c) => String(c.body.text).includes('alınamadı')));
    const thread = await main(bot.id);
    const said = await waitFor(async () => (await t.messages(thread.id)).find((m) => m.role === 'user'));
    expect(said.text).toContain('şuna bak');
    expect(said.text).toContain('Ulaşmayan dosyalar: fatura.txt');
    const req = await waitFor(async () => t.engine.requests.find((r) => r.prompt.includes('şuna bak')));
    expect(req.prompt).toContain('Ulaşmayan dosyalar');
  });

  it('bağlantı kesilince anahtar unutulur', async () => {
    const { bot } = await setUp();
    expect((await t.api('DELETE', `/api/bots/${bot.id}/telegram`)).status).toBe(200);
    expect((await t.api<TelegramStatus>('GET', `/api/bots/${bot.id}/telegram`)).body.connected).toBe(false);
  });
});

describe('Telegram biçimi', () => {
  it("Markdown'u Telegram HTML'ine çevirir, tabloyu satır satır listeler", () => {
    const [m] = telegramMessages(
      '# Başlık\n\n**kalın** ve _eğik_, `kod <x>` ve [bağlantı](https://ornek.com/a_b_c)\n\n| Ad | Fiyat |\n|---|---|\n| Masa | 100 |\n\n```js\nlet a = 1 < 2;\n```',
    );
    expect(m!.html).toContain('<b>Başlık</b>');
    expect(m!.html).toContain('<b>kalın</b> ve <i>eğik</i>');
    expect(m!.html).toContain('<code>kod &lt;x&gt;</code>');
    expect(m!.html).toContain('<a href="https://ornek.com/a_b_c">bağlantı</a>');
    expect(m!.html).toContain('<b>Masa</b>\nFiyat: 100');
    expect(m!.html).toContain('<pre><code class="language-js">let a = 1 &lt; 2;</code></pre>');
  });

  it('kesişen kalın ve eğik aralıkları iç içe kapatıp yeniden açarak ikisini de korur', () => {
    const html = (md: string) => telegramMessages(md)[0]!.html;
    expect(html('**kalın _ikisi** eğik_')).toBe('<b>kalın <i>ikisi</i></b> <i>eğik</i>');
    expect(html('_eğik **ikisi_ kalın**')).toBe('<i>eğik <b>ikisi</b></i> <b>kalın</b>');
    // Spaces at the crossing stay outside the reopened mark, where chat apps still read it. Three crossing in a row stay valid too.
    expect(html('**a _b ~~c** d_ e~~')).toBe('<b>a <i>b <s>c</s></i></b> <i><s>d</s></i> <s>e</s>');
    // Nesting, bold-italic and other cases written before keep their shape.
    expect(html('**kalın _eğik_ yine**')).toBe('<b>kalın <i>eğik</i> yine</b>');
    expect(html('***ikisi***')).toBe('<b><i>ikisi</i></b>');
    expect(html('~~silik~~ ve *yıldız*')).toBe('<s>silik</s> ve <i>yıldız</i>');
    expect(html('**a *b** c')).toBe('<b>a *b</b> c');
  });

  it('sözcük içindeki alt çizgiler ve e-posta adresleri biçim sayılmaz', () => {
    const html = (md: string) => telegramMessages(md)[0]!.html;
    expect(html('snake_case ve first_last@x.com yazdı')).toBe('snake_case ve first_last@x.com yazdı');
    expect(html('first__last@x.com ile a__b ve c__d')).toBe('first__last@x.com ile a__b ve c__d');
    expect(html('2*3*4 işlemi')).toBe('2*3*4 işlemi');
    expect(html('_eğik_ ve my_var_name')).toBe('<i>eğik</i> ve my_var_name');
    // Code spans and links are never read as marks.
    expect(html('`a_b_c` ve [x_y](https://a.co/_k_)')).toBe(
      '<code>a_b_c</code> ve <a href="https://a.co/_k_">x_y</a>',
    );
  });

  it('Slack ve Discord da kesişen biçimi geçerli iç içe işaretlerle yazar', () => {
    expect(slackMessages('**kalın _ikisi** eğik_')[0]).toBe('*kalın _ikisi_* _eğik_');
    expect(discordMessages('**kalın _ikisi** eğik_')[0]).toBe('**kalın *ikisi*** *eğik*');
  });

  it('sohbet uygulamasına giden cevapta bilinen biçimli anahtarları maskeler, sıradan metne dokunmaz', () => {
    const reply =
      'Anahtarın: sk-ant-api03-abcdefghijklmnopqrstuvwx\n\n```\nexport GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789\n```\n\nPIN: 1234, şifre: kedi';
    const outs = [
      telegramMessages(reply)[0]!.html,
      telegramMessages(reply)[0]!.plain,
      whatsappMessages(reply)[0]!,
      slackMessages(reply)[0]!,
      discordMessages(reply)[0]!,
      slackPlain(reply),
    ];
    for (const out of outs) {
      expect(out).not.toContain('sk-ant-api03');
      expect(out).not.toContain('ghp_abc');
      expect(out).toContain('••••••');
      // A labelled value is the reply's own words; only keys of a known shape are taken out.
      expect(out).toContain('PIN: 1234, şifre: kedi');
    }
  });

  it("uzun yanıtı Telegram'ın sınırını aşmayan parçalara böler", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Satır ${i} biraz uzunca bir metin.`).join('\n');
    const parts = telegramMessages(long);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.html.length).toBeLessThanOrEqual(4096);
  });

  // The pieces set aside while marking are NUL-delimited numbers; text that writes such a marker
  // itself once made the restoring loop run for ever and froze the whole server.
  it('metindeki NUL işaretleri sunucuyu kilitlemez', () => {
    const [m] = telegramMessages('ok [a\u00000\u0000](https://x.y)');
    expect(m!.html).toBe('ok <a href="https://x.y">a0</a>');
    const nested = telegramMessages('**`\u00001\u0000` [\u00000\u0000](https://x.y)** \u00002\u0000')[0]!;
    expect(nested.html).not.toContain('\u0000');
    expect(nested.html).toContain('<code>1</code>');
    // A real mark inside another still comes back whole.
    expect(telegramMessages('**kalın `kod`**')[0]!.html).toBe('<b>kalın <code>kod</code></b>');
  });
});
