import type { Bot, Message, Room, Thread } from '@leafbot/shared';
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';

describe('odalar', () => {
  let t: TestServer;
  let ada: Bot;
  let bora: Bot;
  let cem: Bot;
  beforeEach(async () => {
    t = await testServer();
    ada = await t.bot({ name: 'Ada' });
    bora = await t.bot({ name: 'Bora' });
    cem = await t.bot({ name: 'Cem' });
  });
  afterEach(() => t.dispose());

  const room = async (opts: Partial<{ botIds: string[]; rounds: number; responders: string }> = {}) => {
    const r = await t.api<Room>('POST', '/api/rooms', {
      title: 'Planlama',
      botIds: [ada.id, bora.id, cem.id],
      ...opts,
    });
    expect(r.status).toBe(200);
    return r.body;
  };
  const say = async (roomId: string, text: string, replyTo?: string) => {
    const r = await t.api<Message>('POST', `/api/rooms/${roomId}/messages`, {
      clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
      text,
      ...(replyTo ? { replyTo } : {}),
    });
    expect(r.status).toBe(201);
    return r.body;
  };
  const replies = async (roomId: string) => (await t.messages(roomId)).filter((m) => m.role === 'assistant');
  const turnsOf = (roomId: string) =>
    t.db.db.select().from(schema.turns).where(eq(schema.turns.threadId, roomId));

  it('üyeler sırayla cevap verir; sonraki, öncekinin söylediğini görür', async () => {
    const r = await room();
    expect(r.members).toEqual([ada.id, bora.id, cem.id]);
    await say(r.id, 'Haftaya ne yapalım?');
    await t.services.turns.idle();

    const said = await replies(r.id);
    expect(said.map((m) => m.author)).toEqual([`bot:${ada.id}`, `bot:${bora.id}`, `bot:${cem.id}`]);
    const asked = t.engine.requests.slice(-3);
    expect(asked[0]!.prompt).toContain('Haftaya ne yapalım?');
    // Bora's prompt holds what Ada said before it, under Ada's name.
    expect(asked[1]!.prompt).toContain('Ada: Yankı:');
    expect(asked[2]!.prompt).toContain('Bora: Yankı:');
    // Each member has its own session in the room, and knows who else is there.
    expect(new Set(asked.map((a) => a.sessionId)).size).toBe(1); // all new
    const sessions = await t.db.db
      .select()
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.roomId, r.id));
    expect(new Set(sessions.map((m) => m.engineSessionId)).size).toBe(3);
    expect(asked[0]!.systemPrompt).toContain('"Planlama"');
    expect(asked[0]!.systemPrompt).toContain('- Bora');
    expect(asked[0]!.systemPrompt).not.toContain('- Ada');

    // The next message resumes each member's own session with only what is new to it.
    await say(r.id, 'İkinci soru');
    await t.services.turns.idle();
    const next = t.engine.requests.slice(-3);
    const own = new Map(sessions.map((m) => [m.botId, m.engineSessionId]));
    expect(next.map((a) => a.sessionId)).toEqual([own.get(ada.id), own.get(bora.id), own.get(cem.id)]);
    // Ada is shown what Bora and Cem said after it last spoke, then the new message; not its own
    // words, nor the first message it already answered. (Their echoed answers quote older lines.)
    expect(next[0]!.prompt.startsWith('Odada yeni mesajlar:\n\nBora: Yankı:')).toBe(true);
    expect(next[0]!.prompt).toContain('\n\nCem: Yankı:');
    expect(next[0]!.prompt).toContain('\n\nKullanıcı: İkinci soru\n\nAda olarak odaya cevabını yaz.');
  });

  it('adı anılan bot cevap verir; odayı herkese kapatınca yalnız anılanlar', async () => {
    const r = await room();
    await say(r.id, '@Bora sen ne dersin?');
    await t.services.turns.idle();
    expect((await replies(r.id)).map((m) => m.author)).toEqual([`bot:${bora.id}`]);

    await t.api('PATCH', `/api/rooms/${r.id}`, { responders: 'mentions' });
    await say(r.id, 'kimseyi anmadan');
    await t.services.turns.idle();
    expect(await replies(r.id)).toHaveLength(1);

    await say(r.id, '@herkes toplanın');
    await t.services.turns.idle();
    const after = (await replies(r.id)).slice(1);
    expect(after.slice(0, 3).map((m) => m.author)).toEqual([
      `bot:${ada.id}`,
      `bot:${bora.id}`,
      `bot:${cem.id}`,
    ]);
    // The test engine echoes "@herkes" back, so each answer names everyone again: the budget of
    // turns bots start for one another is what ends it.
    expect(after.length).toBeLessThanOrEqual(3 + 4);
  });

  it('bir botun mesajına yanıt vermek o botu anmaktır', async () => {
    const r = await room({ responders: 'mentions' });
    await say(r.id, '@Cem başla');
    await t.services.turns.idle();
    const [cemSaid] = await replies(r.id);
    await say(r.id, 'devam et', cemSaid!.id);
    await t.services.turns.idle();
    expect((await replies(r.id)).map((m) => m.author)).toEqual([`bot:${cem.id}`, `bot:${cem.id}`]);
  });

  it('bir bot başka bir üyeyi anınca o üye sıra alır, bütçe yettiğince', async () => {
    const r = await room({ responders: 'mentions' });
    await say(r.id, '@Ada başla');
    await t.services.turns.idle();
    const [adaTurn] = (await turnsOf(r.id)).filter((x) => x.botId === ada.id);
    await t.services.rooms.onTurnFinished(adaTurn!, {
      ok: true,
      text: '@Bora sen bak, @Cem sen de',
      sessionId: null,
      costUsd: 0,
    });
    await t.services.turns.idle();
    // (Bora and Cem then echo "@Ada" back, which gives Ada a turn too.)
    expect((await replies(r.id)).map((m) => m.author).slice(0, 3)).toEqual([
      `bot:${ada.id}`,
      `bot:${bora.id}`,
      `bot:${cem.id}`,
    ]);
    const mentioned = t.engine.requests.filter((q) => q.prompt.includes('Ada seni andı.'));
    expect(mentioned.map((q) => q.botId).slice(0, 2)).toEqual([bora.id, cem.id]);
    const before = (await replies(r.id)).length;

    // With one turn left in the budget, only the first one named gets it.
    await t.db.db.update(schema.rooms).set({ botTurnsLeft: 1 }).where(eq(schema.rooms.id, r.id));
    await t.services.rooms.onTurnFinished(adaTurn!, {
      ok: true,
      text: '@Cem ve @Bora',
      sessionId: null,
      costUsd: 0,
    });
    await t.services.turns.idle();
    expect((await replies(r.id)).map((m) => m.author).slice(before)).toEqual([`bot:${cem.id}`]);
  });

  it('tartışma turları sürer, sonra durur; sessiz bir tur tartışmayı bitirir', async () => {
    const r = await room({ rounds: 2 });
    await say(r.id, 'Fikirler?');
    await t.services.turns.idle();
    // One answer each, then two rounds of the three.
    expect(await replies(r.id)).toHaveLength(9);
    expect(t.engine.requests.at(-1)!.prompt).toContain('Tartışma turu 2/2');
    const turns = await turnsOf(r.id);
    expect(turns.filter((x) => x.source === 'bot')).toHaveLength(6);

    const before = t.engine.requests.length;
    await say(r.id, 'Hepiniz susun [sessiz]');
    await t.services.turns.idle();
    // Everyone passed, so no round follows and nothing shows in the room.
    expect(t.engine.requests.length - before).toBe(3);
    expect(await replies(r.id)).toHaveLength(9);
  });

  it('durdur konuşanı keser ve sıradakileri bırakır', async () => {
    const r = await room({ rounds: 3 });
    await say(r.id, 'Uzun düşün [bekle:2000]');
    await waitFor(async () => (await turnsOf(r.id)).some((x) => x.status === 'running'));
    const stop = await t.api<{ stopped: boolean }>('POST', `/api/rooms/${r.id}/stop`);
    expect(stop.body.stopped).toBe(true);
    await t.services.turns.idle();
    const turns = await turnsOf(r.id);
    expect(turns.every((x) => x.status === 'interrupted')).toBe(true);
    expect(await replies(r.id)).toHaveLength(0);
    const [row] = await t.db.db.select().from(schema.rooms).where(eq(schema.rooms.id, r.id));
    expect(row!.roundsLeft).toBe(0);
  });

  it('baştan başlayan odada botlar yeni oturum açar ve yalnızca sıfırlamadan sonrasını okur', async () => {
    const r = await room({ botIds: [ada.id, bora.id] });
    await say(r.id, 'Eski konu: bütçe');
    await t.services.turns.idle();

    expect((await t.api('POST', `/api/rooms/${r.id}/reset`)).status).toBe(200);
    const members = await t.db.db
      .select()
      .from(schema.roomMembers)
      .where(eq(schema.roomMembers.roomId, r.id));
    expect(members.every((m) => m.engineSessionId === null && m.seenAt === null)).toBe(true);
    const line = (await t.messages(r.id)).at(-1)!;
    expect(line).toMatchObject({ role: 'system', props: { kind: 'contextReset' } });

    const before = t.engine.requests.length;
    await say(r.id, 'Yeni konu: tatil');
    await t.services.turns.idle();
    const asked = t.engine.requests.slice(before);
    expect(asked).toHaveLength(2);
    for (const a of asked) {
      expect(a.sessionId).toBeFalsy();
      expect(a.prompt).toContain('Yeni konu: tatil');
      expect(a.prompt).not.toContain('bütçe');
    }
    // The second member still hears the first one's answer given after the reset.
    expect(asked[1]!.prompt).toContain('Ada: Yankı:');
  });

  it('konuşan ya da bekleyen varken oda baştan başlamaz', async () => {
    const r = await room({ botIds: [ada.id] });
    await say(r.id, 'Uzun düşün [bekle:2000]');
    await waitFor(async () => (await turnsOf(r.id)).some((x) => x.status === 'running'));
    expect((await t.api('POST', `/api/rooms/${r.id}/reset`)).status).toBe(409);
    await t.api('POST', `/api/rooms/${r.id}/stop`);
    await t.services.turns.idle();
    expect((await t.messages(r.id)).some((m) => m.props?.kind === 'contextReset')).toBe(false);
  });

  it('yeni mesaj sırada bekleyenleri bırakır, herkes yenisine cevap verir', async () => {
    const r = await room();
    await say(r.id, 'İlk [bekle:300]');
    await waitFor(async () => (await turnsOf(r.id)).some((x) => x.status === 'running'));
    await say(r.id, 'Vazgeçtim, şunu konuşalım');
    await t.services.turns.idle();
    const said = await replies(r.id);
    // Ada was already answering the first; then all three answer the second.
    expect(said.map((m) => m.author)).toEqual([
      `bot:${ada.id}`,
      `bot:${ada.id}`,
      `bot:${bora.id}`,
      `bot:${cem.id}`,
    ]);
    const dropped = (await turnsOf(r.id)).filter((x) => x.status === 'interrupted');
    expect(dropped).toHaveLength(2);
  });

  it('yeni mesaj başka bir botun cevabını getiren turu bırakmaz', async () => {
    const r = await room({ botIds: [ada.id, bora.id] });
    await say(r.id, 'İlk [bekle:300]');
    await waitFor(async () => (await turnsOf(r.id)).some((x) => x.status === 'running'));
    await t.services.turns.enqueue({
      threadId: r.id,
      botId: bora.id,
      source: 'bot',
      prompt: 'Cem cevap verdi: tamam',
      jobId: 'job-1',
    });
    await say(r.id, 'Yeni konu');
    await t.services.turns.idle();
    const [delivery] = (await turnsOf(r.id)).filter((x) => x.jobId === 'job-1');
    expect(delivery!.status).toBe('done');
  });

  it('odada bot tepki bırakmaz: herkes aynı mesaja cevap veriyor', async () => {
    const r = await room({ botIds: [ada.id, bora.id] });
    await say(r.id, 'Selam [araç:react {"emoji":"👍"}]');
    await t.services.turns.idle();
    const [mine] = (await t.messages(r.id)).filter((m) => m.role === 'user');
    expect(mine!.props?.reaction).toBeUndefined();
    // The tool ran and said no, rather than never being called.
    expect((await replies(r.id))[0]!.text).toContain('emoji bırakılmadı');
  });

  it('oda botun sohbet listesinde görünmez; listelenir, güncellenir, silinir', async () => {
    const r = await room();
    const threads = (await t.api<Thread[]>('GET', `/api/bots/${ada.id}/threads`)).body;
    expect(threads.some((x) => x.id === r.id)).toBe(false);
    expect((await t.api<Room[]>('GET', '/api/rooms')).body.map((x) => x.id)).toEqual([r.id]);

    const updated = await t.api<Room>('PATCH', `/api/rooms/${r.id}`, {
      title: 'Toplantı',
      botIds: [cem.id, ada.id],
      rounds: 1,
    });
    expect(updated.body).toMatchObject({ title: 'Toplantı', members: [cem.id, ada.id], rounds: 1 });

    expect((await t.api('DELETE', `/api/rooms/${r.id}`)).status).toBe(200);
    expect((await t.api<Room[]>('GET', '/api/rooms')).body).toEqual([]);
  });

  it('kalıcı silinen bot odadan çıkar, oda kalır', async () => {
    const r = await room({ botIds: [ada.id, bora.id] });
    await t.api('POST', `/api/bots/${ada.id}/archive`);
    expect((await t.api('DELETE', `/api/bots/${ada.id}`)).status).toBe(200);
    const after = await t.api<Room>('GET', `/api/rooms/${r.id}`);
    expect(after.body.members).toEqual([bora.id]);
    const [thread] = await t.db.db
      .select()
      .from(schema.threads)
      .where(and(eq(schema.threads.id, r.id), eq(schema.threads.kind, 'room')));
    expect(thread!.botId).toBe(bora.id);
  });

  it('arşivlenmiş bot odaya eklenemez', async () => {
    await t.api('POST', `/api/bots/${cem.id}/archive`);
    const r = await t.api('POST', '/api/rooms', { title: 'X', botIds: [ada.id, cem.id] });
    expect(r.status).toBe(400);
  });
});
