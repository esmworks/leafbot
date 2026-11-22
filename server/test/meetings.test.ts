import type { Bot, Meeting, MeetingMinutes, Memory, MemoryChange, Message, Room } from '@leafbot/shared';
import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { translator } from '../src/i18n';
import { meetingNote, parseMinutes } from '../src/services/meetings';
import { testServer, type TestServer } from './helpers';

describe('toplantı tutanağı', () => {
  let t: TestServer;
  let ada: Bot;
  let bora: Bot;
  beforeEach(async () => {
    t = await testServer();
    ada = await t.bot({ name: 'Ada' });
    bora = await t.bot({ name: 'Bora' });
  });
  afterEach(() => t.dispose());

  const room = async (extra: object = {}) => {
    const r = await t.api<Room>('POST', '/api/rooms', {
      title: 'Planlama',
      botIds: [ada.id, bora.id],
      ...extra,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const say = async (roomId: string, text: string) => {
    const r = await t.api<Message>('POST', `/api/rooms/${roomId}/messages`, {
      clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
      text,
    });
    expect(r.status).toBe(201);
    await t.services.turns.idle();
    return r.body;
  };
  const meetings = async (roomId: string) =>
    (await t.api<Meeting[]>('GET', `/api/rooms/${roomId}/meetings`)).body;
  const call = (roomId: string, meetingId: string, what: string, body?: unknown) =>
    t.api<Meeting>('POST', `/api/rooms/${roomId}/meetings/${meetingId}/${what}`, body);
  /** Everything said in the room so far happened long ago: the next message comes after a pause. */
  const longAgo = (roomId: string) =>
    t.db.db
      .update(schema.messages)
      .set({ createdAt: sql`${schema.messages.createdAt} - interval '3 hours'` })
      .where(eq(schema.messages.threadId, roomId));
  const minutes = (o: Partial<Record<string, unknown>> = {}) =>
    JSON.stringify({
      title: 'Lansman',
      summary: 'Lansman tarihi konuşuldu.',
      decisions: ['Lansman 1 Aralık’ta'],
      tasks: [
        { text: 'Basın bültenini yaz', owner: 'ada', due: '2026-11-25' },
        { text: 'Bütçeyi çıkar', owner: 'Kullanıcı', due: 'cuma' },
      ],
      questions: ['Davetli listesi?'],
      ...o,
    });
  const written = async () => {
    await t.services.meetings.idle();
  };

  it('ilk konuşmada sorar; evet denince tutar, bitince tutanağı yazar', async () => {
    const r = await room();
    expect(r.minutes).toBe('ask');
    await say(r.id, 'Lansmanı konuşalım');
    const [m] = await meetings(r.id);
    expect(m).toMatchObject({ status: 'asked' });
    // The question is a line of the room's own: the app draws it as a card; the bots never read it.
    const card = (await t.messages(r.id)).find((x) => x.props.meeting);
    expect(card).toMatchObject({
      role: 'system',
      author: 'meeting',
      props: { meeting: { id: m!.id, stage: 'start' } },
    });
    expect(t.engine.requests.some((q) => q.prompt.includes('toplantı mı'))).toBe(false);
    expect((await t.api<Room>('GET', `/api/rooms/${r.id}`)).body.meeting).toEqual({
      id: m!.id,
      status: 'asked',
    });

    expect((await call(r.id, m!.id, 'answer', { answer: 'yes' })).body.status).toBe('active');
    await say(r.id, 'Ada basın bültenini yazsın');
    // A message while the meeting goes on asks nothing more.
    expect(await meetings(r.id)).toHaveLength(1);

    t.engine.completer = () => `İşte tutanak:\n${minutes()}`;
    expect((await call(r.id, m!.id, 'end')).body.status).toBe('writing');
    await written();
    const [done] = await meetings(r.id);
    expect(done!.status).toBe('draft');
    expect(done!.minutes).toEqual({
      title: 'Lansman',
      summary: 'Lansman tarihi konuşuldu.',
      decisions: ['Lansman 1 Aralık’ta'],
      tasks: [
        // A member's name, in any case, becomes the bot; a person's stays a name; an odd day is dropped.
        { text: 'Basın bültenini yaz', owner: 'Ada', botId: ada.id, due: '2026-11-25' },
        { text: 'Bütçeyi çıkar', owner: 'Kullanıcı', botId: null, due: null },
      ],
      questions: ['Davetli listesi?'],
    });
    const asked = t.engine.completions.at(-1)!;
    expect(asked.system).toContain('<meeting>');
    expect(asked.user).toContain('<people>\n- Kullanıcı\n- Ada\n- Bora\n</people>');
    expect(asked.user).toContain('<m from="Kullanıcı">Lansmanı konuşalım</m>');
    expect(asked.user).toContain('<m from="Kullanıcı">Ada basın bültenini yazsın</m>');
    expect(asked.user).toMatch(/<m from="Ada">Yankı:/);
    // The room's own lines are not part of the meeting.
    expect(asked.user).not.toContain('toplantı mı');
    const end = (await t.messages(r.id)).filter((x) => x.props.meeting).at(-1);
    expect(end!.props.meeting).toEqual({ id: m!.id, stage: 'end' });
  });

  it('“hiç sorma” odayı kapatır; “hep tut” sormadan tutar', async () => {
    const r = await room();
    await say(r.id, 'Merhaba');
    const [m] = await meetings(r.id);
    await call(r.id, m!.id, 'answer', { answer: 'never' });
    // A declined meeting is not listed.
    expect(await meetings(r.id)).toEqual([]);
    expect((await t.api<Room>('GET', `/api/rooms/${r.id}`)).body.minutes).toBe('never');
    await longAgo(r.id);
    await say(r.id, 'Yeni konu');
    expect(await meetings(r.id)).toEqual([]);

    await t.api('PATCH', `/api/rooms/${r.id}`, { minutes: 'always' });
    await longAgo(r.id);
    await say(r.id, 'Haftalık toplantı');
    const [kept] = await meetings(r.id);
    expect(kept!.status).toBe('active');
    const startCard = (await t.messages(r.id)).filter((x) => x.props.meeting).at(-1)!;
    expect(startCard.text).toBe('Toplantı tutanağı tutuluyor.');
  });

  it('ara vermeden süren konuşma yeniden sorulmaz; uzun bir aradan sonra sorulur', async () => {
    const r = await room();
    await say(r.id, 'Bir');
    const [m] = await meetings(r.id);
    await call(r.id, m!.id, 'answer', { answer: 'no' });
    await say(r.id, 'İki');
    expect(await t.db.db.select().from(schema.meetings)).toHaveLength(1);
    await longAgo(r.id);
    await say(r.id, 'Üç');
    const rows = await t.db.db.select().from(schema.meetings);
    expect(rows.map((x) => x.status).sort()).toEqual(['asked', 'declined']);
  });

  it('sessiz kalan toplantı kendiliğinden biter; cevapsız soru düşer', async () => {
    const r = await room();
    await say(r.id, 'Başlayalım');
    const [m] = await meetings(r.id);
    await call(r.id, m!.id, 'answer', { answer: 'yes' });
    t.engine.completer = () => minutes();
    t.now.value = new Date(Date.now() + 10 * 60_000);
    await t.services.meetings.sweep();
    expect((await meetings(r.id))[0]!.status).toBe('active');
    t.now.value = new Date(Date.now() + 31 * 60_000);
    await t.services.meetings.sweep();
    await written();
    const [ended] = await meetings(r.id);
    expect(ended!.status).toBe('draft');
    // Its lines end with the last one written, not with the quiet after it.
    expect(new Date(ended!.endedAt!).getTime()).toBeLessThan(Date.now() + 60_000);

    const other = await room({ title: 'Diğer' });
    await say(other.id, 'Selam');
    await t.services.meetings.sweep();
    const [q] = await t.db.db.select().from(schema.meetings).where(eq(schema.meetings.roomId, other.id));
    expect(q!.status).toBe('declined');
  });

  it('yazılamayan tutanak yeniden denenir; taslaktan toplantıya dönülür', async () => {
    const r = await room();
    const m = (await t.api<Meeting>('POST', `/api/rooms/${r.id}/meetings`)).body;
    expect(m.status).toBe('active');
    await say(r.id, 'Elle başlatılan toplantı');
    t.engine.completer = () => 'anlamadım';
    await call(r.id, m.id, 'end');
    await written();
    let [now] = await meetings(r.id);
    expect(now).toMatchObject({
      status: 'failed',
      error: 'Model tutanağı okunabilir bir biçimde yazmadı. Yeniden dene.',
    });

    t.engine.completer = () => minutes();
    expect((await call(r.id, m.id, 'retry')).body.status).toBe('writing');
    await written();
    [now] = await meetings(r.id);
    expect(now!.status).toBe('draft');
    expect((await call(r.id, m.id, 'resume')).body).toMatchObject({
      status: 'active',
      minutes: null,
      endedAt: null,
    });
    // An answer at the wrong step is refused.
    expect((await call(r.id, m.id, 'answer', { answer: 'yes' })).status).toBe(409);
  });

  it('uzun toplantı parça parça okunur, sonra birleştirilir', async () => {
    const r = await room();
    const m = (await t.api<Meeting>('POST', `/api/rooms/${r.id}/meetings`)).body;
    // Lines written straight into the room, so no bot answers them.
    for (let i = 0; i < 60; i++) {
      await t.services.threads.addMessage({
        threadId: r.id,
        role: 'user',
        author: 'user',
        text: `${i}. madde ${'x'.repeat(1400)}`,
      });
    }
    t.engine.completer = (req) =>
      req.user.includes('<parts>') ? minutes({ title: 'Birleşik' }) : minutes({ title: 'Parça' });
    await call(r.id, m.id, 'end');
    await written();
    const parts = t.engine.completions.filter((c) => c.user.includes('<meeting>'));
    expect(parts.length).toBe(3);
    expect(parts[0]!.system).toContain('3 parçanın 1. parçası');
    expect(t.engine.completions.at(-1)!.user).toContain('<parts>');
    expect((await meetings(r.id))[0]!.minutes!.title).toBe('Birleşik');
  });

  it('onaylanan tutanak seçilen botlara not olarak gider; işi üstlenenin işi en başta', async () => {
    const r = await room();
    const m = (await t.api<Meeting>('POST', `/api/rooms/${r.id}/meetings`)).body;
    await say(r.id, 'Konuşalım');
    t.engine.completer = () => minutes();
    await call(r.id, m.id, 'end');
    await written();
    const draft = (await meetings(r.id))[0]!.minutes!;
    const approved: MeetingMinutes = { ...draft, decisions: [...draft.decisions, 'Bütçe 10 bin'] };
    const cem = await t.bot({ name: 'Cem', memory: false });
    const saved = await call(r.id, m.id, 'save', { minutes: approved, botIds: [ada.id, bora.id, cem.id] });
    expect(saved.status).toBe(200);
    expect(saved.body.status).toBe('saved');
    expect(saved.body.minutes).toEqual(approved);
    // A bot without memory keeps no notes.
    expect(saved.body.sentTo).toEqual([
      { botId: ada.id, waiting: false },
      { botId: bora.id, waiting: false },
    ]);
    const notes = (await t.api<Memory[]>('GET', '/api/memory')).body;
    const forAda = notes.find((n) => n.botId === ada.id)!;
    expect(forAda).toMatchObject({ scope: 'bot', source: 'user', threadId: r.id });
    expect(forAda.content.split('\n\n')[1]).toBe(
      'Senin üstlendiğin işler:\n- Basın bültenini yaz (son gün 2026-11-25)',
    );
    expect(forAda.content).toContain('- Bütçe 10 bin');
    const forBora = notes.find((n) => n.botId === bora.id)!;
    expect(forBora.content).not.toContain('Senin üstlendiğin');
    expect(forBora.content).toContain('Diğer işler:\n- Ada: Basın bültenini yaz');
    // Saved once: it is not sent again.
    expect((await call(r.id, m.id, 'save', { minutes: approved, botIds: [ada.id] })).status).toBe(409);
  });

  it('yalnızca konuşabildiği botun notu hemen botun kendi notu olur; başkası odanın tutanaklarını göremez', async () => {
    await t.api('PUT', `/api/bots/${ada.id}/access`, { everyone: 'chat', people: {} });
    const ayse = await t.person('ayse');
    const r = await ayse.api<Room>('POST', '/api/rooms', { title: 'Ayşe', botIds: [ada.id] });
    expect(r.status).toBe(200);
    const m = (await ayse.api<Meeting>('POST', `/api/rooms/${r.body.id}/meetings`)).body;
    await ayse.api('POST', `/api/rooms/${r.body.id}/messages`, { clientId: 'c-ayse-0001', text: 'Plan' });
    await t.services.turns.idle();
    t.engine.completer = () => minutes();
    await ayse.api('POST', `/api/rooms/${r.body.id}/meetings/${m.id}/end`);
    await written();
    const draft = (await ayse.api<Meeting[]>('GET', `/api/rooms/${r.body.id}/meetings`)).body[0]!;
    const saved = await ayse.api<Meeting>('POST', `/api/rooms/${r.body.id}/meetings/${m.id}/save`, {
      minutes: draft.minutes,
      botIds: [ada.id],
    });
    expect(saved.body.sentTo).toEqual([{ botId: ada.id, waiting: false }]);
    expect((await t.api<MemoryChange[]>('GET', '/api/memory-changes')).body).toEqual([]);
    // Kept as the bot's own note, not as words the owner wrote: a bot note may be wrong.
    const [note] = await t.services.memory.list({ scope: 'bot', botId: ada.id });
    expect(note).toMatchObject({ source: `bot:${ada.id}` });
    const hist = (await t.api<{ actor: string; action: string }[]>('GET', '/api/memory-history')).body;
    expect(hist).toContainEqual(expect.objectContaining({ actor: 'user:ayse', action: 'create' }));

    const ali = await t.person('ali');
    expect((await ali.api('GET', `/api/rooms/${r.body.id}/meetings`)).status).toBeGreaterThanOrEqual(403);
    expect(
      (await ali.api('POST', `/api/rooms/${r.body.id}/meetings/${m.id}/end`)).status,
    ).toBeGreaterThanOrEqual(403);
  });

  /** Moves a room's lines, and its meetings' times, this far into the past. */
  const shift = async (roomId: string, minutesBack: number) => {
    const back = sql.raw(`interval '${minutesBack} minutes'`);
    await t.db.db
      .update(schema.messages)
      .set({ createdAt: sql`${schema.messages.createdAt} - ${back}` })
      .where(eq(schema.messages.threadId, roomId));
    await t.db.db
      .update(schema.meetings)
      .set({
        fromAt: sql`${schema.meetings.fromAt} - ${back}`,
        toAt: sql`${schema.meetings.toAt} - ${back}`,
        updatedAt: sql`${schema.meetings.updatedAt} - ${back}`,
      })
      .where(eq(schema.meetings.roomId, roomId));
  };

  it('sessizlikle biten toplantıya dönülünce sayaç baştan başlar', async () => {
    const r = await room();
    await say(r.id, 'Başlayalım');
    const [m] = await meetings(r.id);
    await call(r.id, m!.id, 'answer', { answer: 'yes' });
    t.engine.completer = () => minutes();
    await shift(r.id, 40);
    t.now.value = new Date();
    await t.services.meetings.sweep();
    await written();
    expect((await meetings(r.id))[0]!.status).toBe('draft');

    // Resumed after a long quiet: the next look finds it taken up a moment ago, not quiet.
    expect((await call(r.id, m!.id, 'resume')).body.status).toBe('active');
    t.now.value = new Date(Date.now() + 60_000);
    await t.services.meetings.sweep();
    expect((await meetings(r.id))[0]!.status).toBe('active');
    expect((await t.messages(r.id)).filter((x) => x.props.meeting)).toHaveLength(2);

    // A question accepted late counts from the answer too.
    const other = await room({ title: 'Geç cevap' });
    await say(other.id, 'Selam');
    const [q] = await meetings(other.id);
    await shift(other.id, 29);
    await call(other.id, q!.id, 'answer', { answer: 'yes' });
    t.now.value = new Date(Date.now() + 5 * 60_000);
    await t.services.meetings.sweep();
    expect((await meetings(other.id))[0]!.status).toBe('active');
  });

  it('bitir dendiğinde botların yazmakta olduğu cevaplar da tutanağa girer', async () => {
    const r = await room();
    const m = (await t.api<Meeting>('POST', `/api/rooms/${r.id}/meetings`)).body;
    t.engine.completer = () => minutes();
    // Ended while both bots are still answering.
    const sent = await t.api('POST', `/api/rooms/${r.id}/messages`, {
      clientId: 'c-busy-000001',
      text: '[bekle:300] Sürümü kim üstleniyor?',
    });
    expect(sent.status).toBe(201);
    const ended = (await call(r.id, m.id, 'end')).body;
    expect(ended).toMatchObject({ status: 'writing', endedAt: null });
    await t.services.turns.idle();
    await written();
    const [done] = await meetings(r.id);
    expect(done!.status).toBe('draft');
    const asked = t.engine.completions.at(-1)!.user;
    expect(asked).toMatch(/<m from="Ada">Yankı:/);
    expect(asked).toMatch(/<m from="Bora">Yankı:/);
  });

  it('bir toplantıyı silmek başka odanın yazılmakta olan tutanağını durdurmaz', async () => {
    const a = await room({ title: 'A' });
    const b = await room({ title: 'B' });
    const ma = (await t.api<Meeting>('POST', `/api/rooms/${a.id}/meetings`)).body;
    const mb = (await t.api<Meeting>('POST', `/api/rooms/${b.id}/meetings`)).body;
    await say(a.id, 'A konusu');
    await say(b.id, 'B konusu');
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    t.engine.completer = async (req) => {
      if (req.user.includes('A konusu')) await held;
      return minutes();
    };
    await call(a.id, ma.id, 'end');
    await call(b.id, mb.id, 'end');
    // A is being written, B waits behind it; B is deleted.
    expect((await t.api('DELETE', `/api/rooms/${b.id}/meetings/${mb.id}`)).status).toBe(200);
    release();
    await written();
    expect((await meetings(a.id))[0]!.status).toBe('draft');
    expect(await meetings(b.id)).toEqual([]);
  });

  it('“bugün” ve notun günü kişinin saat diliminde', async () => {
    // 23:30 in UTC is already the next day in Istanbul.
    t.now.value = new Date('2026-11-19T23:30:00Z');
    const r = await room();
    const m = (await t.api<Meeting>('POST', `/api/rooms/${r.id}/meetings`)).body;
    await say(r.id, 'Yarın konuşalım');
    t.engine.completer = () => minutes();
    await call(r.id, m.id, 'end');
    await written();
    expect(t.engine.completions.at(-1)!.system).toContain('2026-11-20');
    await t.db.db
      .update(schema.meetings)
      .set({ fromAt: new Date('2026-11-19T22:30:00Z') })
      .where(eq(schema.meetings.id, m.id));
    const draft = (await meetings(r.id))[0]!.minutes!;
    await call(r.id, m.id, 'save', { minutes: draft, botIds: [ada.id] });
    const note = (await t.api<Memory[]>('GET', '/api/memory')).body.find((n) => n.botId === ada.id)!;
    expect(note.content).toContain('(2026-11-20, “Planlama” odası)');
  });

  it('“hep tut” odasında toplantı sessizlikle bitince sonra gelen konuşma da tutulur', async () => {
    const r = await room({ minutes: 'always' });
    await say(r.id, 'Birinci toplantı');
    const [first] = await meetings(r.id);
    t.engine.completer = () => minutes();
    await call(r.id, first!.id, 'end');
    await written();
    // Right after the end, a word of thanks starts nothing.
    await say(r.id, 'Teşekkürler');
    expect(await meetings(r.id)).toHaveLength(1);
    // Back after 45 minutes: well short of two hours, but the meeting before it is over.
    await shift(r.id, 45);
    await say(r.id, 'İkinci konu');
    const all = await meetings(r.id);
    expect(all).toHaveLength(2);
    expect(all[0]!.status).toBe('active');
  });

  it('“sor” odasında sessizlikle biten toplantıdan sonra dönülünce yeniden sorar', async () => {
    const r = await room();
    await say(r.id, 'Konuşalım');
    const [m] = await meetings(r.id);
    await call(r.id, m!.id, 'answer', { answer: 'yes' });
    t.engine.completer = () => minutes();
    await shift(r.id, 40);
    t.now.value = new Date();
    await t.services.meetings.sweep();
    await written();
    await shift(r.id, 45);
    await say(r.id, 'Kaldığımız yerden');
    expect((await meetings(r.id)).map((x) => x.status)).toEqual(['asked', 'draft']);
  });

  it('odanın üst satırı bekleyen taslağı yeni sorunun önünde gösterir', async () => {
    const r = await room();
    const m = (await t.api<Meeting>('POST', `/api/rooms/${r.id}/meetings`)).body;
    await say(r.id, 'Dünkü toplantı');
    t.engine.completer = () => minutes();
    await call(r.id, m.id, 'end');
    await written();
    await longAgo(r.id);
    await say(r.id, 'Yeni gün');
    expect((await meetings(r.id)).map((x) => x.status)).toEqual(['asked', 'draft']);
    expect((await t.api<Room>('GET', `/api/rooms/${r.id}`)).body.meeting).toEqual({
      id: m.id,
      status: 'draft',
    });
  });

  /** A meeting of the room, written and waiting for approval. */
  const drafted = async (roomId: string) => {
    const m = (await t.api<Meeting>('POST', `/api/rooms/${roomId}/meetings`)).body;
    await say(roomId, 'Görevleri dağıtalım');
    t.engine.completer = () => minutes();
    await call(roomId, m.id, 'end');
    await written();
    return m;
  };
  const tasks: MeetingMinutes['tasks'] = [
    { text: 'Basın bültenini yaz', owner: 'Ada', botId: '', due: '2026-11-25' },
    { text: 'Bütçeyi onayla', owner: 'Erhan', botId: null, due: '2026-11-27' },
    { text: 'Eski iş', owner: 'Bora', botId: '', due: '2026-11-10' },
    { text: 'Günsüz iş', owner: 'Bora', botId: '', due: null },
  ];
  const approved = (): MeetingMinutes => ({
    title: 'Lansman',
    summary: '',
    decisions: [],
    questions: [],
    tasks: tasks.map((x) => ({
      ...x,
      botId: x.owner === 'Ada' ? ada.id : x.owner === 'Bora' ? bora.id : null,
    })),
  });
  const routines = () => t.db.db.select().from(schema.routines);

  it('son günü olan işlere hatırlatma kurulur: işi üstlenen bot kendi işine, kişinin işine odanın botu bakar', async () => {
    const r = await room();
    const m = await drafted(r.id);
    const saved = await call(r.id, m.id, 'save', {
      minutes: approved(),
      botIds: [ada.id],
      reminders: [0, 1, 2, 3],
      remindAt: '08:30',
    });
    expect(saved.status).toBe(200);
    // A day already past and a task with no day get none.
    expect(saved.body.reminders).toEqual([
      expect.objectContaining({
        botId: ada.id,
        task: 'Basın bültenini yaz',
        date: '2026-11-25',
        time: '08:30',
      }),
      expect.objectContaining({ botId: ada.id, task: 'Bütçeyi onayla', date: '2026-11-27', time: '08:30' }),
    ]);
    const made = await routines();
    expect(made).toHaveLength(2);
    const own = made.find((x) => x.id === saved.body.reminders[0]!.routineId)!;
    expect(own).toMatchObject({
      botId: ada.id,
      name: 'Hatırlatma: Basın bültenini yaz',
      schedule: { type: 'once', date: '2026-11-25', time: '08:30' },
      timezone: 'Europe/Istanbul',
      inMain: true,
      enabled: true,
    });
    expect(own.prompt).toContain('şu işi üstlendin: Basın bültenini yaz');
    const other = made.find((x) => x.id === saved.body.reminders[1]!.routineId)!;
    expect(other.prompt).toContain('bu işi Erhan üstlendi: Bütçeyi onayla');
    expect(other.prompt).toContain('Kişiye bu işi kısaca hatırlat');
  });

  it('çalışıp kapanmış eski hatırlatmalar yenisi kurulurken silinir', async () => {
    const r = await room();
    const first = await drafted(r.id);
    const one = await call(r.id, first.id, 'save', { minutes: approved(), botIds: [], reminders: [0] });
    const spent = one.body.reminders[0]!.routineId;
    await t.db.db
      .update(schema.routines)
      .set({ enabled: false, lastRunAt: new Date() })
      .where(eq(schema.routines.id, spent));
    await longAgo(r.id);
    const [asked] = await meetings(r.id).then((all) => all.filter((x) => x.status === 'asked'));
    if (asked) await call(r.id, asked.id, 'answer', { answer: 'no' });
    const second = await drafted(r.id);
    const two = await call(r.id, second.id, 'save', { minutes: approved(), botIds: [], reminders: [1] });
    const left = (await routines()).map((x) => x.id);
    expect(left).toEqual([two.body.reminders[0]!.routineId]);
    expect(left).not.toContain(spent);
  });

  it('değiştiremediği botlar için hatırlatma kurulmaz', async () => {
    await t.api('PUT', `/api/bots/${ada.id}/access`, { everyone: 'chat', people: {} });
    const ayse = await t.person('ayse');
    const r = await ayse.api<Room>('POST', '/api/rooms', { title: 'Ayşe', botIds: [ada.id] });
    const m = (await ayse.api<Meeting>('POST', `/api/rooms/${r.body.id}/meetings`)).body;
    await ayse.api('POST', `/api/rooms/${r.body.id}/messages`, { clientId: 'c-ayse-remind', text: 'Plan' });
    await t.services.turns.idle();
    t.engine.completer = () => minutes();
    await ayse.api('POST', `/api/rooms/${r.body.id}/meetings/${m.id}/end`);
    await written();
    const saved = await ayse.api<Meeting>('POST', `/api/rooms/${r.body.id}/meetings/${m.id}/save`, {
      minutes: approved(),
      botIds: [],
      reminders: [0, 1],
    });
    expect(saved.status).toBe(200);
    expect(saved.body.reminders).toEqual([]);
    expect(await routines()).toEqual([]);
  });

  it('modelin cevabı hoşgörüyle okunur', () => {
    expect(parseMinutes('yok')).toBe(null);
    expect(
      parseMinutes('{"title": 3, "decisions": ["a", 2, ""], "tasks": [{"text": "x"}, {"owner": "y"}]}'),
    ).toEqual({
      title: '',
      summary: '',
      decisions: ['a'],
      tasks: [{ text: 'x', owner: '', due: null }],
      questions: [],
    });
  });

  it('bota giden not sınırı aşmaz ve botun kendi işiyle başlar', () => {
    const tr = translator('tr');
    const long: MeetingMinutes = {
      title: 'Uzun',
      summary: 'ö'.repeat(5000),
      decisions: ['Karar'],
      tasks: [{ text: 'Benim işim', owner: 'Ada', botId: 'a1', due: null }],
      questions: [],
    };
    const note = meetingNote(long, { id: 'a1', name: 'Ada' }, { t: tr, day: '2026-11-19', room: 'Oda' });
    expect(note.length).toBeLessThanOrEqual(2000);
    expect(
      note.startsWith(
        'Toplantı tutanağı: Uzun (2026-11-19, “Oda” odası)\n\nSenin üstlendiğin işler:\n- Benim işim',
      ),
    ).toBe(true);
  });
});
