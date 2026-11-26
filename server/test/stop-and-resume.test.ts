import type { Room, Routine, RoutineRun, Thread } from '@leafbot/shared';
import { and, desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';

describe('durdurma ve kaldığı yerden sürdürme', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const jobStatus = async (id: string) =>
    (await t.api<{ job: { status: string } }>('GET', `/api/jobs/${id}`)).body.job.status;
  /** The server starting again on the same database, after `shutdown` stopped it. */
  const restart = async () => {
    (t.services.turns as unknown as { stopped: boolean }).stopped = false;
    await t.services.turns.recover();
    await t.services.routines.recover();
  };
  const routineRuns = async (id: string) =>
    (await t.api<RoutineRun[]>('GET', `/api/routines/${id}/runs`)).body;

  it('sunucu çöküp açılınca yarıda kalan kişi turu kendiliğinden sürer; bot önce yapılanlara bakar', async () => {
    const a = await t.bot({ name: 'Ali' });
    const thread = await main(a.id);
    await t.send(thread.id, 'raporu hazırla');
    await t.services.turns.idle();
    const [turn] = await t.db.db.select().from(schema.turns).where(eq(schema.turns.threadId, thread.id));
    const { engineSessionId } = await t.services.threads.row(thread.id);
    // As if the server stopped while the turn ran.
    await t.db.db.update(schema.turns).set({ status: 'running' }).where(eq(schema.turns.id, turn!.id));
    await t.services.turns.recover();
    await t.services.turns.idle();

    const req = t.engine.requests.at(-1)!;
    expect(req.prompt).toContain('önceki denemen yarıda kaldı');
    expect(req.prompt).toContain('raporu hazırla');
    expect(req.sessionId).toBe(engineSessionId);
    const note = (await t.messages(thread.id)).find((m) => m.text.includes('yeniden başladığı'))!;
    expect(note.text).toContain('kaldığı yerden');
    expect(note.props.retried).toBe(true);
    expect(note.props.resume).toBeUndefined();
    // It went on once; the note offers it no more.
    expect((await t.api('POST', `/api/messages/${note.id}/retry`)).status).toBe(409);
  });

  it('sunucu kapanırken yarıda kalan kişi turu açılışta aynı oturumda sürer', async () => {
    const a = await t.bot({ name: 'Ali' });
    const thread = await main(a.id);
    await t.send(thread.id, '[bekle:5000] siparişleri eşle');
    await waitFor(async () => (await t.services.threads.row(thread.id)).engineSessionId);
    const { engineSessionId } = await t.services.threads.row(thread.id);

    // A deploy stops the server while the bot works.
    await t.services.turns.shutdown();
    const note = (await t.messages(thread.id)).filter((m) => m.role === 'system').at(-1)!;
    expect(note.props.resume).toBe(true);
    expect(note.text).toContain('kaldığı yerden');

    await restart();
    await t.services.turns.idle(15_000);
    const req = t.engine.requests.at(-1)!;
    expect(req.prompt).toContain('önceki denemen yarıda kaldı');
    expect(req.prompt).toContain('siparişleri eşle');
    expect(req.sessionId).toBe(engineSessionId);
    expect(t.engine.requests).toHaveLength(2);
  });

  it('sunucu kapanırken yarıda kalan rutin, bir şey değiştirmiş olsa da aynı çalıştırmada sürer', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Sipariş Senkronu',
        prompt: '[bekle:5000] siparişleri eşle',
        schedule: { type: 'interval', minutes: 60 },
        inMain: false,
      })
    ).body;
    const run = (await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`)).body;
    await waitFor(async () => (await t.services.threads.row(run.threadId!)).engineSessionId);
    // It has already written something: run again from the start, it would do that twice.
    await t.db.db.update(schema.turns).set({ changed: true }).where(eq(schema.turns.routineRunId, run.id));

    await t.services.turns.shutdown();
    expect((await routineRuns(r.id))[0]!.status).toBe('running');
    const note = (await t.messages(run.threadId!)).filter((m) => m.role === 'system').at(-1)!;
    // Only a person's request is run again from the note.
    expect(note.props.kind).toBeUndefined();

    await restart();
    await t.services.turns.idle(15_000);
    const all = await routineRuns(r.id);
    expect(all).toHaveLength(1);
    expect(all[0]!.status).toBe('done');
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt).toContain('önceki denemen yarıda kaldı');
    expect(prompt).toContain('siparişleri eşle');
  });

  it('sürdürülen rutin turu da yarıda kalırsa bir daha sürmez, çalıştırma kapanır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const r = (
      await t.api<Routine>('POST', '/api/routines', {
        botId: a.id,
        name: 'Rapor',
        prompt: 'Raporu yaz',
        schedule: { type: 'interval', minutes: 60 },
        inMain: false,
      })
    ).body;
    const run = (await t.api<RoutineRun>('POST', `/api/routines/${r.id}/run`)).body;
    await t.services.turns.idle();
    const crash = async () => {
      const [last] = await t.db.db
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.routineRunId, run.id))
        .orderBy(desc(schema.turns.createdAt))
        .limit(1);
      await t.db.db.update(schema.turns).set({ status: 'running' }).where(eq(schema.turns.id, last!.id));
      await t.db.db
        .update(schema.routineRuns)
        .set({ status: 'running', finishedAt: null })
        .where(eq(schema.routineRuns.id, run.id));
      await t.services.turns.recover();
      await t.services.routines.recover();
      await t.services.turns.idle();
    };
    const before = t.engine.requests.length;
    await crash();
    expect(t.engine.requests).toHaveLength(before + 1);
    expect(t.engine.requests.at(-1)!.prompt).toContain('önceki denemen yarıda kaldı');
    expect((await routineRuns(r.id))[0]!.status).toBe('done');

    // A turn that stops the server each time is not run again and again.
    await crash();
    expect(t.engine.requests).toHaveLength(before + 1);
    expect((await routineRuns(r.id))[0]!.status).toBe('error');
  });

  it('sunucu kapanırken yarıda kalan iş, sorana yeniden başlatma olarak ve yeniden sorulsun diye bildirilir', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const ta = await main(a.id);
    const job = await t.services.jobs.send({
      from: a,
      to: b,
      fromThreadId: ta.id,
      parentJobId: null,
      text: '[bekle:5000] portföy çeklerini oku',
      kind: 'send',
    });
    await waitFor(async () => t.engine.requests.some((r) => r.botId === b.id));

    // A deploy stops the server while the target is still answering.
    await t.services.turns.shutdown();

    const [row] = await t.db.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(row!.status).toBe('stopped');
    expect(row!.reply).toContain('sunucu yeniden başladığı için');
    expect(row!.reply).toContain('yeniden gönder');
    const [turn] = await t.db.db.select().from(schema.turns).where(eq(schema.turns.jobId, job.id));
    expect(turn!.error).toBe('Sunucu yeniden başladı');
    const note = (await t.messages(turn!.threadId)).find((m) => m.turnId === turn!.id && m.role === 'system');
    expect(note!.text).toContain('yeniden başladığı');
    // Its sender asks again: the target does not go on with it by itself too.
    expect(note!.props.resume).toBeUndefined();
  });

  it('bot_stop yalnız o işi durdurur; aynı bota gönderilen öteki iş sürer', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const ta = await main(a.id);
    const send = (text: string) =>
      t.services.jobs.send({ from: a, to: b, fromThreadId: ta.id, parentJobId: null, text, kind: 'send' });
    const long = await send('[bekle:5000] uzun iş');
    const short = await send('kısa iş');
    await waitFor(async () => t.engine.requests.some((r) => r.botId === b.id));

    await t.services.jobs.stop(long.id, a);
    await t.services.turns.idle(5000);
    expect(await jobStatus(long.id)).toBe('stopped');
    expect(await jobStatus(short.id)).toBe('done');
  });

  it('bot_stop hedefin o iş için başka bota verdiği işi de durdurur', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const c = await t.bot({ name: 'Can' });
    const ta = await main(a.id);
    const job = await t.services.jobs.send({
      from: a,
      to: b,
      fromThreadId: ta.id,
      parentJobId: null,
      text: '[araç:bot_send {"bot":"Can","message":"[bekle:5000] sayıları ver"}]',
      kind: 'send',
    });
    await waitFor(async () => t.engine.requests.some((r) => r.botId === c.id));

    await t.services.jobs.stop(job.id, a);
    await t.services.turns.idle(5000);
    const [child] = await t.db.db.select().from(schema.jobs).where(eq(schema.jobs.toBotId, c.id));
    expect(child!.status).toBe('stopped');
    // The stopped bot is not woken by its helper's answer.
    expect(t.engine.requests.filter((r) => r.botId === b.id)).toHaveLength(1);
  });

  it('oda durdurulunca üyelerin başka botlara verdiği iş de durur', async () => {
    const ada = await t.bot({ name: 'Ada' });
    const bora = await t.bot({ name: 'Bora' });
    const can = await t.bot({ name: 'Can' });
    const room = (await t.api<Room>('POST', '/api/rooms', { title: 'Planlama', botIds: [ada.id, bora.id] }))
      .body;
    const job = await t.services.jobs.send({
      from: ada,
      to: can,
      fromThreadId: room.id,
      parentJobId: null,
      text: '[bekle:5000] uzun iş',
      kind: 'send',
    });
    await waitFor(async () => t.engine.requests.some((r) => r.botId === can.id));

    const stop = await t.api<{ stopped: boolean }>('POST', `/api/rooms/${room.id}/stop`);
    expect(stop.body.stopped).toBe(true);
    await t.services.turns.idle(5000);
    expect(await jobStatus(job.id)).toBe('stopped');
  });

  it('turu kuyruğa girmeden kalan iş açılışta kapanır; aynı turun öteki cevabı gönderene ulaşır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const c = await t.bot({ name: 'Can' });
    const ta = await main(a.id);
    await t.send(ta.id, 'başla');
    await t.services.turns.idle();
    const [fromTurn] = await t.db.db.select().from(schema.turns).where(eq(schema.turns.threadId, ta.id));
    // A request recorded as the server stopped, before its turn was queued.
    const peer = await t.services.threads.peerThread(b.id, a.id, await t.services.access.botOwner(a.id));
    const lost = {
      id: 'kayip-is',
      rootId: 'kayip-kok',
      depth: 1,
      kind: 'send' as const,
      fromBotId: a.id,
      toBotId: b.id,
      fromThreadId: ta.id,
      fromTurnId: fromTurn!.id,
      toThreadId: peer.id,
      approvalId: null,
      request: 'rapor',
      reply: null,
      status: 'pending' as const,
      createdAt: new Date(),
      finishedAt: null,
      deliveredAt: null,
    };
    await t.db.db.insert(schema.jobs).values(lost);
    await t.services.jobs.send({
      from: a,
      to: c,
      fromThreadId: ta.id,
      fromTurnId: fromTurn!.id,
      parentJobId: null,
      text: 'özet',
      kind: 'send',
    });
    await t.services.turns.idle();
    // Can's answer waits for its sibling, which nothing will answer.
    expect(t.engine.requests.some((r) => r.botId === a.id && r.prompt.includes('Can'))).toBe(false);

    await t.services.jobs.recover();
    await t.services.turns.idle();
    expect(await jobStatus(lost.id)).toBe('error');
    const back = t.engine.requests.filter((r) => r.botId === a.id).at(-1)!.prompt;
    expect(back).toContain('Can');
    expect(back).toContain('Ayşe');
    const [left] = await t.db.db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.fromThreadId, ta.id), eq(schema.jobs.status, 'pending')));
    expect(left).toBeUndefined();
  });

  it('bot_stop sonrası, hedefin öteki yardımcısından gelmiş cevap durdurulan botu uyandırmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const c = await t.bot({ name: 'Can' });
    const d = await t.bot({ name: 'Deniz' });
    const ta = await main(a.id);
    const job = await t.services.jobs.send({
      from: a,
      to: b,
      fromThreadId: ta.id,
      parentJobId: null,
      text: '[araç:bot_send {"bot":"Can","message":"[bekle:5000] uzun"}] [araç:bot_send {"bot":"Deniz","message":"kısa"}]',
      kind: 'send',
    });
    await waitFor(async () => {
      const [done] = await t.db.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.toBotId, d.id), eq(schema.jobs.status, 'done')));
      return done ?? null;
    });

    await t.services.jobs.stop(job.id, a);
    await t.services.turns.idle(5000);
    expect(t.engine.requests.filter((r) => r.botId === b.id)).toHaveLength(1);
    expect(t.engine.requests.some((r) => r.botId === c.id)).toBe(true);
  });

  it('sohbet durunca, cevabını vermiş botun hâlâ çalışan yardımcısı da durur', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const c = await t.bot({ name: 'Can' });
    const ta = await main(a.id);
    await t.send(
      ta.id,
      '[araç:bot_send {"bot":"Ayşe","message":"[araç:bot_send {\\"bot\\":\\"Can\\",\\"message\\":\\"[bekle:5000] sayıları ver\\"}]"}]',
    );
    await waitFor(async () => {
      const [first] = await t.db.db.select().from(schema.jobs).where(eq(schema.jobs.toBotId, b.id));
      return first?.status === 'done' ? first : null;
    });
    await waitFor(async () => t.engine.requests.some((r) => r.botId === c.id));

    const r = await t.api<{ stopped: boolean }>('POST', `/api/threads/${ta.id}/stop`);
    expect(r.body.stopped).toBe(true);
    await t.services.turns.idle(5000);
    const [helper] = await t.db.db.select().from(schema.jobs).where(eq(schema.jobs.toBotId, c.id));
    expect(helper!.status).toBe('stopped');
    expect(t.engine.requests.filter((x) => x.botId === b.id)).toHaveLength(1);
  });

  it('sohbet durunca, aynı turda sorulan botun bekletilen cevabı da onu uyandırmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    await t.bot({ name: 'Ayşe' });
    const c = await t.bot({ name: 'Can' });
    const ta = await main(a.id);
    await t.send(
      ta.id,
      '[araç:bot_send {"bot":"Ayşe","message":"[bekle:5000] uzun"}] [araç:bot_send {"bot":"Can","message":"kısa"}]',
    );
    await waitFor(async () => {
      const [done] = await t.db.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.toBotId, c.id), eq(schema.jobs.status, 'done')));
      return done ?? null;
    });

    await t.api('POST', `/api/threads/${ta.id}/stop`);
    await t.services.turns.idle(5000);
    expect(t.engine.requests.filter((r) => r.botId === a.id)).toHaveLength(1);
  });

  it('açılışta gönderenin sohbeti silinmiş ya da çok eski iş kimseyi uyandırmadan kapanır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const ta = await main(a.id);
    const peer = await t.services.threads.peerThread(b.id, a.id, await t.services.access.botOwner(a.id));
    const row = (id: string, fromThreadId: string, createdAt: Date) => ({
      id,
      rootId: `${id}-kok`,
      depth: 1,
      kind: 'send' as const,
      fromBotId: a.id,
      toBotId: b.id,
      fromThreadId,
      fromTurnId: null,
      toThreadId: peer.id,
      approvalId: null,
      request: 'rapor',
      reply: null,
      status: 'pending' as const,
      createdAt,
      finishedAt: null,
      deliveredAt: null,
    });
    await t.db.db
      .insert(schema.jobs)
      .values([
        row('silinmis', 'olmayan-sohbet', new Date()),
        row('eski', ta.id, new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)),
      ]);

    await t.services.jobs.recover();
    await t.services.turns.idle();
    expect(await jobStatus('silinmis')).toBe('error');
    expect(await jobStatus('eski')).toBe('error');
    expect(t.engine.requests.some((r) => r.botId === a.id)).toBe(false);
  });

  it('yeniden başlatma notu yalnız kişinin turunda yeniden denenir; önek dil değişse de bir kez eklenir', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const thread = await main(a.id);
    await t.send(thread.id, 'raporu hazırla');
    await t.services.turns.idle();
    const cut = async (threadId: string) => {
      const [last] = await t.db.db
        .select()
        .from(schema.turns)
        .where(eq(schema.turns.threadId, threadId))
        .orderBy(desc(schema.turns.createdAt))
        .limit(1);
      await t.db.db.update(schema.turns).set({ status: 'running' }).where(eq(schema.turns.id, last!.id));
      await t.services.turns.recover();
      return (await t.messages(threadId)).filter((m) => m.role === 'system').at(-1)!;
    };
    // The first cut goes on by itself; the run again, cut short too, is left for the person.
    const first = await cut(thread.id);
    expect(first.props.retried).toBe(true);
    await t.services.turns.idle();
    await t.api('PATCH', '/api/settings', { language: 'en' });
    const second = await cut(thread.id);
    expect(second.props.retried).toBeUndefined();
    expect(second.props.kind).toBe('interrupted');
    expect((await t.api('POST', `/api/messages/${second.id}/retry`)).status).toBe(200);
    await t.services.turns.idle();
    const prompt = t.engine.requests.at(-1)!.prompt;
    expect(prompt.match(/önceki denemen yarıda kaldı/g)).toHaveLength(1);
    expect(prompt).not.toContain('previous attempt');

    // Another bot's request cut short is not offered again from its note.
    const job = await t.services.jobs.send({
      from: a,
      to: b,
      fromThreadId: thread.id,
      parentJobId: null,
      text: 'rapor',
      kind: 'send',
    });
    await t.services.turns.idle();
    const note = await cut(job.toThreadId);
    expect(note.props.kind).toBeUndefined();
  });

  it('açılışta, cevabı bitmiş ama iletilmemiş işin gerçek cevabı gönderene ulaşır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const ta = await main(a.id);
    const job = await t.services.jobs.send({
      from: a,
      to: b,
      fromThreadId: ta.id,
      parentJobId: null,
      text: 'rapor hazır mı',
      kind: 'send',
    });
    await t.services.turns.idle();
    const answered = t.engine.requests.filter((r) => r.botId === a.id).length;
    // As if the server stopped after the target's turn ended but before its answer was passed on.
    await t.db.db
      .update(schema.jobs)
      .set({ status: 'pending', reply: null, finishedAt: null, deliveredAt: null })
      .where(eq(schema.jobs.id, job.id));

    await t.services.jobs.recover();
    await t.services.turns.idle();
    expect(await jobStatus(job.id)).toBe('done');
    const [row] = await t.db.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(row!.reply).not.toContain('yeniden başladı');
    expect(t.engine.requests.filter((r) => r.botId === a.id)).toHaveLength(answered + 1);
  });
});
