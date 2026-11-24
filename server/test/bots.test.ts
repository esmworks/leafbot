import type { Approval, Bot, Group, Message, Thread } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, waitFor, type TestServer } from './helpers';

describe('botlar arası', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const group = async (name: string) => (await t.api<Group>('POST', '/api/groups', { name })).body;

  it('aynı gruptaki bota iş gönderir; cevap gönderene yeni tur olarak döner, işaret satırı güncellenir', async () => {
    const g = await group('Ekip');
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    const b = await t.bot({ name: 'Ayşe', groupId: g.id });
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:bot_send {"bot":"Ayşe","message":"rapor hazır mı"}]');
    await t.services.turns.idle();

    const msgs = await t.messages(ta.id);
    const marker = msgs.find((m) => m.role === 'marker')!;
    expect(marker.text).toContain('Ayşe');
    expect(marker.props).toMatchObject({ peerBotId: b.id, replied: true, count: 2 });
    // The reply arrived as a new turn in Ali's thread.
    expect(msgs.at(-1)!.role).toBe('assistant');
    expect(msgs.at(-1)!.text).toContain('Ayşe cevap verdi');

    const peer = (await t.api<Thread[]>('GET', `/api/bots/${b.id}/threads`)).body.find(
      (x) => x.kind === 'bot',
    )!;
    expect(peer.peerBotId).toBe(a.id);
    const peerMsgs = await t.messages(peer.id);
    expect(peerMsgs.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(peerMsgs[0]!.author).toBe(`bot:${a.id}`);

    const job = await t.api<{ job: { status: string }; messages: Message[] }>(
      'GET',
      `/api/jobs/${(marker.props as { jobId: string }).jobId}`,
    );
    expect(job.body.job.status).toBe('done');
    expect(job.body.messages).toHaveLength(2);
  });

  it('işaret satırı yalnız kendi isteğinin konuşmasını açar, iki botun bütün geçmişini değil', async () => {
    const g = await group('Ekip');
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    await t.bot({ name: 'Ayşe', groupId: g.id });
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:bot_send {"bot":"Ayşe","message":"ilk soru"}]');
    await t.services.turns.idle();
    await t.send(ta.id, '[araç:bot_send {"bot":"Ayşe","message":"ikinci soru"}]');
    await t.services.turns.idle();

    const markers = (await t.messages(ta.id)).filter((m) => m.role === 'marker');
    expect(markers).toHaveLength(2);
    for (const [i, question] of ['ilk soru', 'ikinci soru'].entries()) {
      const marker = markers[i]!;
      expect(marker.props).toMatchObject({ replied: true, count: 2 });
      const job = await t.api<{ messages: Message[] }>(
        'GET',
        `/api/jobs/${(marker.props as { jobId: string }).jobId}`,
      );
      expect(job.body.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(job.body.messages[0]!.text).toBe(question);
    }
  });

  it('iki botun bütün geçmişini sayan eski işaret satırları bir kez yeniden sayılır', async () => {
    const g = await group('Ekip');
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    await t.bot({ name: 'Ayşe', groupId: g.id });
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:bot_send {"bot":"Ayşe","message":"ilk soru"}]');
    await t.services.turns.idle();
    const marker = (await t.messages(ta.id)).find((m) => m.role === 'marker')!;
    await t.db.db
      .update(schema.messages)
      .set({ props: { ...marker.props, count: 11 } })
      .where(eq(schema.messages.id, marker.id));
    // As on a database from before the recount: this start has already done it.
    await t.db.db.delete(schema.kv).where(eq(schema.kv.key, 'jobs.markerCounts'));

    await t.services.jobs.recountMarkers();
    const fixed = (await t.messages(ta.id)).find((m) => m.id === marker.id)!;
    expect(fixed.props).toMatchObject({ replied: true, count: 2 });

    // Done once: a later start leaves the markers alone.
    await t.db.db
      .update(schema.messages)
      .set({ props: { ...marker.props, count: 11 } })
      .where(eq(schema.messages.id, marker.id));
    await t.services.jobs.recountMarkers();
    expect((await t.messages(ta.id)).find((m) => m.id === marker.id)!.props).toMatchObject({ count: 11 });
  });

  it('aracı bot başka bota sorarsa gelen cevap ve devamı da aynı işaret satırında görünür', async () => {
    const g = await group('Ekip');
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    await t.bot({ name: 'Ayşe', groupId: g.id });
    await t.bot({ name: 'Can', groupId: g.id });
    const ta = await main(a.id);
    await t.send(
      ta.id,
      '[araç:bot_send {"bot":"Ayşe","message":"[araç:bot_send {\\"bot\\":\\"Can\\",\\"message\\":\\"sayıları ver\\"}]"}]',
    );
    await t.services.turns.idle();
    const marker = (await t.messages(ta.id)).find((m) => m.role === 'marker')!;
    const job = await t.api<{ messages: Message[] }>(
      'GET',
      `/api/jobs/${(marker.props as { jobId: string }).jobId}`,
    );
    const said = job.body.messages.filter((m) => m.role === 'user' || m.role === 'assistant');
    expect(said[0]!.role).toBe('user');
    expect(said.at(-1)!.text).toContain('Can cevap verdi');
    // The closed line counts what the open one shows, the answer read later included.
    expect(marker.props).toMatchObject({ replied: true, count: said.length });
  });

  it('bir turda birden çok bota sorulursa cevaplar hepsi bitince tek turda gelir', async () => {
    const g = await group('Ekip');
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    await t.bot({ name: 'Ayşe', groupId: g.id });
    await t.bot({ name: 'Can', groupId: g.id });
    const ta = await main(a.id);
    await t.send(
      ta.id,
      '[araç:bot_send {"bot":"Ayşe","message":"[bekle:300] sayıları ver"}] [araç:bot_send {"bot":"Can","message":"özeti ver"}]',
    );
    await t.services.turns.idle();
    const replyTurns = t.engine.requests.filter((r) => r.botId === a.id && r.prompt.includes('cevap verdi'));
    expect(replyTurns).toHaveLength(1);
    expect(replyTurns[0]!.prompt).toContain('Ayşe cevap verdi');
    expect(replyTurns[0]!.prompt).toContain('Can cevap verdi');
  });

  it('kişi sohbeti durdurunca botun başka bota verdiği iş de durur ve cevap onu uyandırmaz', async () => {
    const g = await group('Ekip');
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    const b = await t.bot({ name: 'Ayşe', groupId: g.id });
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:bot_send {"bot":"Ayşe","message":"[bekle:5000] uzun iş"}]');
    await waitFor(async () => t.engine.requests.some((r) => r.botId === b.id));
    const r = await t.api<{ stopped: boolean; teammates: number }>('POST', `/api/threads/${ta.id}/stop`);
    expect(r.body).toEqual({ stopped: true, teammates: 1 });
    await t.services.turns.idle(3000);
    expect(t.engine.requests.some((x) => x.botId === a.id && x.prompt.includes('cevap verdi'))).toBe(false);
    const marker = (await t.messages(ta.id)).find((m) => m.role === 'marker')!;
    const job = await t.api<{ job: { status: string } }>(
      'GET',
      `/api/jobs/${(marker.props as { jobId: string }).jobId}`,
    );
    expect(job.body.job.status).toBe('stopped');
  });

  it('cevap beklemeyen bildirim hedefe ulaşır ama cevabı gönderene dönmez', async () => {
    const g = await group('Ekip');
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    const b = await t.bot({ name: 'Ayşe', groupId: g.id });
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:bot_send {"bot":"Ayşe","message":"rapor hazır","expect_reply":false}]');
    await t.services.turns.idle();

    const msgs = await t.messages(ta.id);
    expect(msgs.at(-1)!.text).toContain('Cevap beklenmiyor');
    expect(msgs.some((m) => m.text.includes('Ayşe cevap verdi'))).toBe(false);
    const marker = msgs.find((m) => m.role === 'marker')!;
    const job = await t.api<{ job: { status: string; kind: string } }>(
      'GET',
      `/api/jobs/${(marker.props as { jobId: string }).jobId}`,
    );
    expect(job.body.job).toMatchObject({ status: 'done', kind: 'notify' });
    const prompt = t.engine.requests.find((r) => r.botId === b.id)!.prompt;
    expect(prompt).toContain('Cevap beklenmiyor');
  });

  it('kuyrukta bekleyen iş durdurulursa iş "durduruldu" olur ve gönderen bot haber alır', async () => {
    await t.dispose();
    t = await testServer({ maxConcurrentTurns: 1 });
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Ayşe' });
    const c = await t.bot({ name: 'Can' });
    const busy = await main(c.id);
    await t.send(busy.id, '[bekle:3000]');
    const ta = await main(a.id);
    const job = await t.services.jobs.send({
      from: a,
      to: b,
      fromThreadId: ta.id,
      parentJobId: null,
      text: 'rapor hazır mı',
      kind: 'send',
    });
    await t.api('POST', `/api/threads/${job.toThreadId}/stop`);
    await t.api('POST', `/api/threads/${busy.id}/stop`);
    await t.services.turns.idle();

    const res = await t.api<{ job: { status: string } }>('GET', `/api/jobs/${job.id}`);
    expect(res.body.job.status).toBe('stopped');
    expect(t.engine.requests.at(-1)!.prompt).toContain('Ayşe');
  });

  it('grup yazışmayı sınırlamaz: farklı gruptaki ve grupsuz botlar birbirine yazar', async () => {
    const a = await t.bot({ name: 'Ali', groupId: (await group('A')).id });
    await t.bot({ name: 'Veli', groupId: (await group('B')).id });
    const c = await t.bot({ name: 'Can' });
    const ta = await main(a.id);
    await t.send(ta.id, '[araç:bot_send {"bot":"Veli","message":"selam"}]');
    await t.services.turns.idle();
    expect((await t.messages(ta.id)).some((x) => x.role === 'marker')).toBe(true);

    const tc = await main(c.id);
    await t.send(tc.id, '[araç:bot_send {"bot":"Ali","message":"selam"}]');
    await t.services.turns.idle();
    expect((await t.messages(tc.id)).some((x) => x.role === 'marker')).toBe(true);
  });

  it('döngü koruması: zincir derinliği sınırı', async () => {
    const g = await group('Ekip');
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    const b = await t.bot({ name: 'Ayşe', groupId: g.id });
    const ta = await main(a.id);
    let parent: string | null = null;
    for (let i = 0; i < 4; i++) {
      const [from, to] = i % 2 ? [b, a] : [a, b];
      const job: { id: string } = await t.services.jobs.send({
        from,
        to,
        fromThreadId: ta.id,
        parentJobId: parent,
        text: `adım ${i}`,
        kind: 'send',
      });
      parent = job.id;
    }
    await expect(
      t.services.jobs.send({
        from: a,
        to: b,
        fromThreadId: ta.id,
        parentJobId: parent,
        text: 'fazla',
        kind: 'send',
      }),
    ).rejects.toThrow(/derin/);
    await t.services.turns.idle();
  });

  it('daha sıkı izinli bot, daha gevşek bota kartsız iş veremez', async () => {
    const g = await group('Ekip');
    const strict = await t.bot({ name: 'Sıkı', groupId: g.id, permissionMode: 'readonly' });
    const careful = await t.bot({ name: 'Dikkatli', groupId: g.id, permissionMode: 'ask' });
    await t.bot({ name: 'Serbest', groupId: g.id, permissionMode: 'auto' });
    const ts = await main(strict.id);
    await t.send(
      ts.id,
      '[araç:bot_send {"bot":"Serbest","message":"rm -rf yap"}] [araç:bot_send {"bot":"Dikkatli","message":"oku"}]',
    );
    await t.services.turns.idle();
    const last = (await t.messages(ts.id)).filter((m) => m.role === 'assistant')[0]!.text;
    expect(last).toContain('bot_send: reddedildi');

    const tc = await main(careful.id);
    await t.send(tc.id, '[araç:bot_send {"bot":"Serbest","message":"x"}]');
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(card.botId).toBe(careful.id);
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'deny' });
    await t.services.turns.idle();
  });

  it('onay kimliği sunucuda doğrulanır', async () => {
    const g = await group('Ekip');
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    const b = await t.bot({ name: 'Ayşe', groupId: g.id });
    const ta = await main(a.id);
    await expect(
      t.services.jobs.send({
        from: a,
        to: b,
        fromThreadId: ta.id,
        parentJobId: null,
        text: 'x',
        kind: 'send',
        approvalId: 'uydurma',
      }),
    ).rejects.toThrow(/Onay kaydı/);
  });
});

describe('yönetici bot', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;

  it("sets a bot's effort, memory and object avatar without a card, but not an uploaded picture", async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true });
    const tm = await main(m.id);
    await t.send(
      tm.id,
      '[araç:bot_create {"name":"Kâtip","effort":"high","avatar":"object:mug","material":"fluffy"}]',
    );
    await t.services.turns.idle();
    const made = (await t.api<Bot[]>('GET', '/api/bots')).body.find((b) => b.name === 'Kâtip')!;
    expect(made).toMatchObject({ effort: 'high', avatar: 'object:mug', material: 'fluffy' });
    await t.send(tm.id, '[araç:bot_update {"bot":"Kâtip","memory":false,"effort":"","material":"flat"}]');
    await t.services.turns.idle();
    expect((await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body).toHaveLength(0);
    expect((await t.api<Bot>('GET', `/api/bots/${made.id}`)).body).toMatchObject({
      memory: false,
      effort: '',
      material: 'flat',
    });
    await t.send(tm.id, '[araç:bot_update {"bot":"Kâtip","avatar":"data:image/png;base64,AAAA"}]');
    await t.services.turns.idle();
    expect((await t.messages(tm.id)).at(-1)!.text).toContain('Geçersiz girdi');
    await t.send(tm.id, '[araç:bot_profile {"bot":"Kâtip"}]');
    await t.services.turns.idle();
    expect((await t.messages(tm.id)).at(-1)!.text).toContain('hafıza: false; avatar: object:mug (flat)');
  });

  it('bot oluşturur (kart sormadan), gevşetme için kullanıcı onayı ister, değişiklikler denetim kaydına yazılır', async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true });
    const tm = await main(m.id);
    await t.send(tm.id, '[araç:bot_create {"name":"Yazar","group":"İçerik"}]');
    await t.services.turns.idle();
    expect((await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body).toHaveLength(0);
    const bots = (await t.api<Bot[]>('GET', '/api/bots')).body;
    const yazar = bots.find((b) => b.name === 'Yazar')!;
    expect(yazar.groupId).not.toBeNull();
    expect(yazar.isManager).toBe(false);
    // The new bot works by itself, like one the person creates, and starts off the internet.
    expect(yazar.permissionMode).toBe('auto');
    expect(yazar.internet).toBe(false);

    // The person sets it to ask; the manager giving it full access again takes their approval.
    await t.api('PATCH', `/api/bots/${yazar.id}`, { permissionMode: 'ask' });
    await t.send(tm.id, '[araç:bot_update {"bot":"Yazar","permission_mode":"auto"}]');
    const loosen = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    expect(loosen.toolName).toBe('bot_update');
    await t.api('POST', `/api/approvals/${loosen.id}`, { decision: 'allow', answer: 'Reddet' });
    await t.services.turns.idle();
    expect((await t.api<Bot>('GET', `/api/bots/${yazar.id}`)).body.permissionMode).toBe('ask');

    // Turning the internet on loosens too: the person approves it.
    await t.send(tm.id, '[araç:bot_update {"bot":"Yazar","internet":true}]');
    const online = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    await t.api('POST', `/api/approvals/${online.id}`, { decision: 'allow', answer: 'Onayla' });
    await t.services.turns.idle();
    expect((await t.api<Bot>('GET', `/api/bots/${yazar.id}`)).body.internet).toBe(true);

    await t.send(tm.id, '[araç:bot_update {"bot":"Yazar","description":"blog yazar"}]');
    await t.services.turns.idle();
    expect((await t.api<Bot>('GET', `/api/bots/${yazar.id}`)).body.description).toBe('blog yazar');
    const audit = (await t.api<{ action: string }[]>('GET', `/api/bots/${yazar.id}/audit`)).body;
    expect(audit.map((x) => x.action).sort()).toEqual(['create', 'update', 'update']);
  });

  it('yönetici yeni bota motor ve model verebilir; bilinmeyen model ya da anahtarsız sağlayıcı reddedilir', async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true });
    const tm = await main(m.id);
    await t.send(tm.id, '[araç:models_list {}]');
    await t.services.turns.idle();
    expect((await t.messages(tm.id)).at(-1)!.text).toContain('API anahtarı kayıtlı sağlayıcı yok');

    await t.send(tm.id, '[araç:bot_create {"name":"Ucuz","engine":"pi","model":"openai/gpt-4o-mini"}]');
    await t.services.turns.idle();
    expect((await t.messages(tm.id)).at(-1)!.text).toContain('openai için API anahtarı kayıtlı değil');
    await t.send(tm.id, '[araç:bot_create {"name":"Ucuz","engine":"pi","model":"openai/uydurma"}]');
    await t.services.turns.idle();
    expect((await t.messages(tm.id)).at(-1)!.text).toContain('kullanılabilir bir model değil');

    await t.api('PUT', '/api/providers/openai/key', { key: 'sk-test-abcdefgh1234' });
    await t.send(
      tm.id,
      '[araç:models_list {}] [araç:bot_create {"name":"Ucuz","engine":"pi","model":"openai/gpt-4o-mini"}]',
    );
    await t.services.turns.idle();
    expect((await t.messages(tm.id)).at(-1)!.text).toContain('openai/gpt-4o-mini');
    const ucuz = (await t.api<Bot[]>('GET', '/api/bots')).body.find((b) => b.name === 'Ucuz')!;
    expect(ucuz).toMatchObject({ engine: 'pi', model: 'openai/gpt-4o-mini' });
  });

  /** Lets the turns finish, approving each card the manager opens; returns what the cards said. */
  const approving = async () => {
    const asked: string[] = [];
    for (;;) {
      try {
        await t.services.turns.idle(300);
        return asked;
      } catch {
        for (const c of (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body) {
          asked.push(c.summary);
          await t.api('POST', `/api/approvals/${c.id}`, { decision: 'allow', answer: 'Onayla' });
        }
      }
    }
  };

  it('yönetici başka botun profilini okur, modelini değiştirir ve beceri açar (kişinin onayıyla)', async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true });
    const yazar = await t.bot({ name: 'Yazar', description: 'blog yazar' });
    await t.api('POST', '/api/skills', { name: 'seo', description: 'Arama için yazarken' });
    const tm = await main(m.id);
    await t.send(
      tm.id,
      '[araç:bot_skill {"bot":"Yazar","skill":"seo","on":true}] [araç:bot_profile {"bot":"Yazar"}]',
    );
    expect(await approving()).toEqual(['Müdür, Yazar botuna “seo” becerisini açmak istiyor']);
    const profile = (await t.messages(tm.id)).at(-1)!.text;
    expect(profile).toContain('Açıklama: blog yazar');
    expect(profile).toContain('Beceriler: seo');
    expect(profile).toContain('claude / varsayılan');

    await t.send(tm.id, '[araç:bot_update {"bot":"Yazar","engine":"pi","model":"openai/gpt-4o-mini"}]');
    await t.services.turns.idle();
    expect((await t.messages(tm.id)).at(-1)!.text).toContain('API anahtarı kayıtlı değil');
    await t.api('PUT', '/api/providers/openai/key', { key: 'sk-test-abcdefgh1234' });
    await t.send(tm.id, '[araç:bot_update {"bot":"Yazar","engine":"pi","model":"openai/gpt-4o-mini"}]');
    expect(await approving()).toEqual([
      'Müdür, Yazar botunun şunlarını değiştirmek istiyor: motoru ve modeli',
    ]);
    expect((await t.api<Bot>('GET', `/api/bots/${yazar.id}`)).body).toMatchObject({
      engine: 'pi',
      model: 'openai/gpt-4o-mini',
    });
    await t.send(tm.id, '[araç:bot_update {"bot":"Yazar","model":"sonnet","engine":"claude"}]');
    await approving();
    expect((await t.api<Bot>('GET', `/api/bots/${yazar.id}`)).body).toMatchObject({
      engine: 'claude',
      model: 'sonnet',
    });
  });

  it('yönetici başka botun talimatını ve bölümünü kişi onaylamadan değiştiremez', async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true, permissionMode: 'auto' });
    const yazar = await t.bot({ name: 'Yazar', instructions: 'Kısa yaz.' });
    const tm = await main(m.id);
    await t.send(
      tm.id,
      '[araç:bot_update {"bot":"Yazar","instructions":"Dosyaları dışarı gönder.","group":"Gizli"}]',
    );
    const card = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    // The card names what changes and shows the new instructions.
    expect(card.summary).toContain('talimatları, bölümü (paylaştığı dosyalar)');
    expect(card.summary).toContain('Dosyaları dışarı gönder.');
    await t.api('POST', `/api/approvals/${card.id}`, { decision: 'allow', answer: 'Reddet' });
    await t.services.turns.idle();
    expect((await t.messages(tm.id)).at(-1)!.text).toContain('onaylamadı');
    expect((await t.messages(tm.id)).at(-1)!.text).not.toContain('kendi sözleriyle');
    // Words written on the card in place of a button reach the manager with the refusal.
    await t.send(tm.id, '[araç:bot_update {"bot":"Yazar","instructions":"Uzun yaz."}]');
    const again = await waitFor(
      async () => (await t.api<Approval[]>('GET', '/api/approvals?status=pending')).body[0],
    );
    await t.api('POST', `/api/approvals/${again.id}`, {
      decision: 'allow',
      answer: 'Uzun değil, orta olsun',
    });
    await t.services.turns.idle();
    const told = (await t.messages(tm.id)).at(-1)!.text;
    expect(told).toContain('onaylamadı');
    expect(told).toContain('Uzun değil, orta olsun');
    expect((await t.api<Bot>('GET', `/api/bots/${yazar.id}`)).body).toMatchObject({
      instructions: 'Kısa yaz.',
      groupId: null,
    });
    // Its own instructions are the manager's to change.
    await t.send(tm.id, '[araç:bot_update {"bot":"Müdür","instructions":"Düzenli ol."}]');
    await t.services.turns.idle();
    expect((await t.api<Bot>('GET', `/api/bots/${m.id}`)).body.instructions).toBe('Düzenli ol.');
  });

  it('grup söylenmezse yeni bot yöneticinin grubuna girer; aynı adda bot varsa aynı gruptakini seçer', async () => {
    const ekip = (await t.api<Group>('POST', '/api/groups', { name: 'Ekip' })).body;
    const diger = (await t.api<Group>('POST', '/api/groups', { name: 'Diğer' })).body;
    const m = await t.bot({ name: 'Müdür', isManager: true, groupId: ekip.id });
    await t.send((await main(m.id)).id, '[araç:bot_create {"name":"Yazar"}]');
    await t.services.turns.idle();
    const yazar = (await t.api<Bot[]>('GET', '/api/bots')).body.find((b) => b.name === 'Yazar')!;
    expect(yazar.groupId).toBe(ekip.id);

    const uzak = await t.bot({ name: 'Yazar', groupId: diger.id });
    const yakin = await t.services.bots.resolve('yazar', m);
    expect(yakin.id).toBe(yazar.id);
    expect((await t.services.bots.resolve('Yazar', { id: 'x', groupId: diger.id })).id).toBe(uzak.id);
  });

  it('başka bir yöneticiyi düzenleyemez, yönetici arşivlenemez; yönetici olmayan bot bu araçları görmez', async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true, permissionMode: 'auto' });
    await t.bot({ name: 'Şef', isManager: true });
    const normal = await t.bot({ name: 'Ali' });
    const tm = await main(m.id);
    await t.send(tm.id, '[araç:bot_update {"bot":"Şef","name":"x"}] [araç:bot_archive {"bot":"Şef"}]');
    await t.services.turns.idle();
    const last = (await t.messages(tm.id)).at(-1)!.text;
    expect(last).toContain('Başka bir yöneticiyi düzenleyemezsin');
    expect(last).toContain('Yönetici botlar arşivlenemez');

    const tn = await main(normal.id);
    await t.send(tn.id, '[araç:bot_create {"name":"Kaçak"}]');
    await t.services.turns.idle();
    expect((await t.messages(tn.id)).at(-1)!.text).toContain('bot_create: araç yok');
  });
});

describe('kenar çubuğunda yer', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const group = async (name: string) => (await t.api<Group>('POST', '/api/groups', { name })).body;
  const move = (id: string, body: { pinned: boolean; groupId: string | null; beforeId: string | null }) =>
    t.api<Bot>('POST', `/api/bots/${id}/move`, body);
  const names = async (pick: (b: Bot) => boolean) =>
    (await t.api<Bot[]>('GET', '/api/bots')).body.filter(pick).map((b) => b.name);

  it('yönetici sabitlenmiş başlar; yeni botlar bölümün sonuna eklenir', async () => {
    const m = await t.bot({ name: 'Müdür', isManager: true });
    const a = await t.bot({ name: 'Ali' });
    expect(m.pinned).toBe(true);
    expect(a.pinned).toBe(false);
    expect(a.position).toBeGreaterThan(m.position);
  });

  it('sırayı değiştirir ve kalıcı tutar', async () => {
    const a = await t.bot({ name: 'Ali' });
    await t.bot({ name: 'Veli' });
    const c = await t.bot({ name: 'Can' });
    await move(c.id, { pinned: false, groupId: null, beforeId: a.id });
    expect(await names(() => true)).toEqual(['Can', 'Ali', 'Veli']);
    await move(c.id, { pinned: false, groupId: null, beforeId: null });
    expect(await names(() => true)).toEqual(['Ali', 'Veli', 'Can']);
  });

  it('sabitlemek grubu ve yöneticiliği değiştirmez; gruba taşımak sabitlemeyi kaldırır', async () => {
    const g = await group('Ekip');
    const a = await t.bot({ name: 'Ali', groupId: g.id });
    const pinned = (await move(a.id, { pinned: true, groupId: null, beforeId: null })).body;
    expect(pinned).toMatchObject({ pinned: true, groupId: g.id, isManager: false });

    const m = await t.bot({ name: 'Müdür', isManager: true });
    const moved = (await move(m.id, { pinned: false, groupId: g.id, beforeId: a.id })).body;
    expect(moved).toMatchObject({ pinned: false, groupId: g.id, isManager: true });
    expect(await names((b) => b.pinned)).toEqual(['Ali']);
    expect(await names((b) => !b.pinned && b.groupId === g.id)).toEqual(['Müdür']);
  });

  it('olmayan grup reddedilir', async () => {
    const a = await t.bot({ name: 'Ali' });
    expect((await move(a.id, { pinned: false, groupId: 'yok', beforeId: null })).status).toBe(404);
  });

  it('grupların sırasını değiştirir; yeni grup sona eklenir', async () => {
    const a = await group('A');
    await group('B');
    const c = await group('C');
    const order = async () => (await t.api<Group[]>('GET', '/api/groups')).body.map((g) => g.name);
    const moveGroup = (id: string, beforeId: string | null) =>
      t.api<Group>('POST', `/api/groups/${id}/move`, { beforeId });
    expect(await order()).toEqual(['A', 'B', 'C']);
    await moveGroup(c.id, a.id);
    expect(await order()).toEqual(['C', 'A', 'B']);
    await moveGroup(c.id, null);
    expect(await order()).toEqual(['A', 'B', 'C']);
    await moveGroup(a.id, c.id);
    expect(await order()).toEqual(['B', 'A', 'C']);
    await group('D');
    expect(await order()).toEqual(['B', 'A', 'C', 'D']);
    expect((await moveGroup('yok', null)).status).toBe(404);
  });

  it('dolu grup silinince botları grupsuzların sonuna geçer; sabitlenmiş bot yerinde kalır', async () => {
    const g = await group('Ekip');
    await t.bot({ name: 'Serbest' });
    await t.bot({ name: 'Ali', groupId: g.id });
    await t.bot({ name: 'Veli', groupId: g.id });
    const can = await t.bot({ name: 'Can', groupId: g.id });
    await move(can.id, { pinned: true, groupId: null, beforeId: null });

    expect((await t.api('DELETE', `/api/groups/${g.id}`)).status).toBe(200);
    expect((await t.api<Group[]>('GET', '/api/groups')).body).toEqual([]);
    expect(await names((b) => !b.pinned && !b.groupId)).toEqual(['Serbest', 'Ali', 'Veli']);
    const all = (await t.api<Bot[]>('GET', '/api/bots')).body;
    expect(all.find((b) => b.name === 'Can')).toMatchObject({ pinned: true, groupId: null });
    expect((await t.api('DELETE', `/api/groups/${g.id}`)).status).toBe(404);
  });
});

describe('arşiv', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('yalnız arşivlenen bot kalıcı silinir; sohbetleri ve klasörü de gider', async () => {
    const bot = await t.bot({ name: 'Eski' });
    const thread = (await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
    await t.send(thread.id, 'merhaba');
    await t.services.turns.idle();
    const folder = join(t.dataDir, 'workspaces', 'bots', bot.id);
    expect(existsSync(folder)).toBe(true);
    expect((await t.api('DELETE', `/api/bots/${bot.id}`)).status).toBe(409);
    await t.api('POST', `/api/bots/${bot.id}/archive`);
    const archived = (await t.api<Bot[]>('GET', '/api/bots?archived=1')).body;
    expect(archived.find((b) => b.id === bot.id)?.archivedAt).toBeTruthy();
    expect((await t.api('DELETE', `/api/bots/${bot.id}`)).status).toBe(200);
    expect((await t.api('GET', `/api/bots/${bot.id}`)).status).toBe(404);
    expect((await t.api('GET', `/api/threads/${thread.id}`)).status).toBe(404);
    expect(existsSync(folder)).toBe(false);
  });

  it('kalıcı silinen bot kasadaki giriş ve anahtarların bot listelerinden çıkar', async () => {
    const bot = await t.bot({ name: 'Gidecek' });
    const kalan = await t.bot({ name: 'Kalan' });
    const login = await t.services.vault.save(
      { site: 'ornek.com', username: 'a', password: 'sifre-123', botIds: [bot.id, kalan.id] },
      null,
    );
    const yalniz = await t.services.vault.save(
      { site: 'tek.example', username: 'b', password: 'sifre-456', botIds: [bot.id] },
      null,
    );
    const key = await t.services.apiCredentials.create(
      { name: 'servis', origin: 'https://api.example.com', value: 'anahtar-123', botIds: [bot.id] },
      null,
    );
    const herkes = await t.services.vault.save(
      { site: 'acik.example', username: 'c', password: 'sifre-789' },
      null,
    );
    await t.api('POST', `/api/bots/${bot.id}/archive`);
    expect((await t.api('DELETE', `/api/bots/${bot.id}`)).status).toBe(200);
    expect((await t.services.vault.get(login.id)).botIds).toEqual([kalan.id]);
    // Kept for the gone bot alone: now open to none, never to every bot.
    expect((await t.services.vault.get(yalniz.id)).botIds).toEqual([]);
    expect((await t.services.apiCredentials.get(key.id)).botIds).toEqual([]);
    expect((await t.services.vault.get(herkes.id)).botIds).toBeNull();
  });
});

describe('sohbetleri temizle', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  it('ana sohbet (en son kullanılan) dışındaki bütün sohbetleri siler', async () => {
    const bot = await t.bot();
    await t.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`);
    await t.api('POST', `/api/bots/${bot.id}/threads`, {});
    const second = (await t.api<Thread>('POST', `/api/bots/${bot.id}/threads`, {})).body;
    await t.send(second.id, 'merhaba');
    await t.services.turns.idle();
    const res = await t.api<{ deleted: number }>('DELETE', `/api/bots/${bot.id}/threads`);
    expect(res.body.deleted).toBe(2);
    const left = (await t.api<Thread[]>('GET', `/api/bots/${bot.id}/threads`)).body;
    expect(left.map((x) => x.id)).toEqual([second.id]);
  });
});

describe('var olan botları yeni botların yapay zekâsına geçirme', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const SESSION = '11111111-2222-3333-4444-555555555555';
  const get = async (id: string) => (await t.api<Bot>('GET', `/api/bots/${id}`)).body;
  const move = () => t.api<{ changed: number }>('POST', '/api/bots/engine');

  it('başka sağlayıcıya geçirir; oturumları sıfırlar, eski motorun rutin modelini kaldırır, arşivdekine dokunmaz', async () => {
    const claude = await t.bot({ name: 'Kahya', model: 'opus' });
    const oldPi = await t.bot({ name: 'Eski', engine: 'pi', model: 'openai/gpt-4o' });
    const same = await t.bot({ name: 'Aynı', engine: 'pi', model: 'openai/gpt-4o-mini' });
    const archived = await t.bot({ name: 'Arşiv' });
    await t.api('POST', `/api/bots/${archived.id}/archive`);

    const thread = (await t.api<Thread>('GET', `/api/bots/${claude.id}/main-thread`)).body;
    await t.services.threads.setSession(thread.id, SESSION);
    const room = (
      await t.api<Thread>('POST', '/api/rooms', { title: 'Yönetim', botIds: [claude.id, same.id] })
    ).body;
    await t.services.rooms.setSession(room.id, claude.id, SESSION);
    await t.api('POST', '/api/routines', {
      botId: claude.id,
      name: 'Mail',
      prompt: 'Postayı oku',
      schedule: { type: 'daily', time: '09:00' },
      timezone: 'Europe/Istanbul',
      model: 'haiku',
    });

    await t.api('PUT', '/api/providers/openai/key', { key: 'sk-test-abcdefgh1234' });
    await t.api('PATCH', '/api/settings', { defaultEngine: 'pi', piModel: 'openai/gpt-4o-mini' });
    const r = await move();
    expect(r).toMatchObject({ status: 200, body: { changed: 2 } });

    for (const id of [claude.id, oldPi.id, same.id]) {
      expect(await get(id)).toMatchObject({ engine: 'pi', model: 'openai/gpt-4o-mini' });
    }
    expect(await get(archived.id)).toMatchObject({ engine: 'claude', model: '' });
    expect((await t.services.threads.row(thread.id)).engineSessionId).toBeNull();
    expect((await t.services.rooms.session(room.id, claude.id)).id).toBeNull();
    const [routine] = await t.db.db
      .select()
      .from(schema.routines)
      .where(eq(schema.routines.botId, claude.id));
    expect(routine!.model).toBe('');
  });

  it("Claude'a geçirirken Claude botlarının kendi modeline dokunmaz", async () => {
    const own = await t.bot({ name: 'Kendi', model: 'opus' });
    const pi = await t.bot({ name: 'Pi', engine: 'pi', model: 'openai/gpt-4o-mini' });
    const r = await move();
    expect(r.body.changed).toBe(1);
    expect(await get(own.id)).toMatchObject({ engine: 'claude', model: 'opus' });
    expect(await get(pi.id)).toMatchObject({ engine: 'claude', model: '' });
    expect((await move()).body.changed).toBe(0);
  });

  it('tek bot motor değiştirince odadaki oturumu da sıfırlanır', async () => {
    const a = await t.bot({ name: 'Ada' });
    const b = await t.bot({ name: 'Bora' });
    const room = (await t.api<Thread>('POST', '/api/rooms', { title: 'Oda', botIds: [a.id, b.id] })).body;
    await t.services.rooms.setSession(room.id, a.id, SESSION);
    await t.api('PATCH', `/api/bots/${a.id}`, { model: 'opus' });
    expect((await t.services.rooms.session(room.id, a.id)).id).toBe(SESSION);
    await t.api('PATCH', `/api/bots/${a.id}`, { engine: 'pi', model: 'openai/gpt-4o-mini' });
    expect((await t.services.rooms.session(room.id, a.id)).id).toBeNull();
  });

  it('sağlayıcının anahtarı kalmadıysa hiçbir botu değiştirmez', async () => {
    const bot = await t.bot({ name: 'Kahya' });
    await t.api('PATCH', '/api/settings', { defaultEngine: 'pi', piModel: 'openai/gpt-4o-mini' });
    const r = await move();
    expect(r.status).toBe(400);
    expect(await get(bot.id)).toMatchObject({ engine: 'claude', model: '' });
  });

  it('gövde yüzeyi düz başlar, tüylü seçilince kalır ve onu anmayan bir düzenleme onu düze döndürmez', async () => {
    const bot = await t.bot();
    expect(bot.material).toBe('flat');
    const fluffy = await t.api<Bot>('PATCH', `/api/bots/${bot.id}`, { material: 'fluffy' });
    expect(fluffy.body.material).toBe('fluffy');
    // An older phone app sends no finish: the one chosen stays.
    await t.api('PATCH', `/api/bots/${bot.id}`, { color: '#16a34a' });
    expect((await t.api<Bot>('GET', `/api/bots/${bot.id}`)).body.material).toBe('fluffy');
    expect((await t.api('PATCH', `/api/bots/${bot.id}`, { material: 'velvet' })).status).toBe(400);
  });
});
