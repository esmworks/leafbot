import type { Bot, Message, Skill, SkillChange, Thread, TodayReport } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { taggedSkill } from '../src/runtime/turns';
import { testServer, type Person, type TestServer } from './helpers';

describe('beceriler', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;

  it('oluşturulur, adı tekildir, bota açılıp kapanır ve silinir', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const add = await t.api<Skill>('POST', '/api/skills', {
      name: 'haftalik-rapor',
      description: 'Haftalık raporu yazar',
      body: 'Önce satışları topla.',
    });
    expect(add.status).toBe(200);
    expect(add.body).toMatchObject({ name: 'haftalik-rapor', botIds: [] });
    const again = await t.api('POST', '/api/skills', { name: 'haftalik-rapor', description: 'x' });
    expect(again.status).toBe(409);
    expect((await t.api('POST', '/api/skills', { name: 'Büyük Harf', description: 'x' })).status).toBe(400);

    const on = await t.api<Skill>('PUT', `/api/skills/${add.body.id}/bots/${bot.id}`, { on: true });
    expect(on.body.botIds).toEqual([bot.id]);
    const off = await t.api<Skill>('PUT', `/api/skills/${add.body.id}/bots/${bot.id}`, { on: false });
    expect(off.body.botIds).toEqual([]);
    expect((await t.api('PUT', `/api/skills/${add.body.id}/bots/yok`, { on: true })).status).toBe(404);

    const edited = await t.api<Skill>('PATCH', `/api/skills/${add.body.id}`, {
      description: 'Pazartesi raporu',
    });
    expect(edited.body.description).toBe('Pazartesi raporu');
    expect((await t.api('DELETE', `/api/skills/${add.body.id}`)).status).toBe(200);
    expect((await t.api<Skill[]>('GET', '/api/skills')).body).toEqual([]);
  });

  it('açık becerinin adı istemde görünür, gövdesi araçla okunur; kapalı bota hiçbiri gelmez', async () => {
    const bot = await t.bot({ name: 'Katip' });
    const other = await t.bot({ name: 'Gezgin' });
    await t.api<Skill>('POST', '/api/skills', {
      name: 'fatura',
      description: 'Fatura keserken',
      body: 'KDV oranını sor.',
      botIds: [bot.id],
    });

    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:skill_read {"name":"fatura"}] [araç:skill_read {"name":"yok"}]');
    await t.services.turns.idle();
    const req = t.engine.requests.at(-1)!;
    expect(req.systemPrompt).toContain('- fatura: Fatura keserken');
    expect(req.systemPrompt).not.toContain('KDV oranını');
    const reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('KDV oranını sor.');
    expect(reply).toContain('yok adında bir becerin yok. Becerilerin: fatura');

    await t.send((await main(other.id)).id, 'merhaba');
    await t.services.turns.idle();
    const plain = t.engine.requests.at(-1)!;
    expect(plain.tools.some((x) => x.name === 'skill_read')).toBe(false);
    expect(plain.systemPrompt).not.toContain('fatura');
  });

  it('bot öğrendiği yöntemi beceri olarak kaydeder ve kendi becerisini düzeltir; başkasınınkine dokunmaz', async () => {
    const bot = await t.bot({ name: 'Katip', permissionMode: 'auto' });
    await t.api('POST', '/api/skills', { name: 'baskasi', description: 'x' });
    const thread = await main(bot.id);
    await t.send(
      thread.id,
      '[araç:skill_save {"name":"Fatura Kesme","description":"Fatura keserken","body":"KDV sor"}] [araç:skill_save {"name":"baskasi","description":"y","body":"z"}]',
    );
    await t.services.turns.idle();
    let reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('"fatura-kesme" becerisi kaydedildi');
    expect(reply).toContain('"baskasi" adında başka bir beceri var');
    await t.send(
      thread.id,
      '[araç:skill_save {"name":"fatura-kesme","description":"Fatura keserken","body":"Önce KDV oranını sor"}]',
    );
    await t.services.turns.idle();
    reply = (await t.messages(thread.id)).at(-1)!.text;
    expect(reply).toContain('güncellendi');
    const saved = (await t.api<Skill[]>('GET', '/api/skills')).body.find((k) => k.name === 'fatura-kesme')!;
    expect(saved).toMatchObject({ body: 'Önce KDV oranını sor', botIds: [bot.id] });
  });

  it('okunan beceri sayılır', async () => {
    const bot = await t.bot({ name: 'Katip' });
    await t.api('POST', '/api/skills', { name: 'fatura', description: 'Fatura', botIds: [bot.id] });
    const thread = await main(bot.id);
    await t.send(thread.id, '[araç:skill_read {"name":"fatura"}] [araç:skill_read {"name":"fatura"}]');
    await t.services.turns.idle();
    const [skill] = (await t.api<Skill[]>('GET', '/api/skills')).body;
    expect(skill).toMatchObject({ name: 'fatura', uses: 2 });
    expect(skill!.lastUsedAt).not.toBeNull();
  });

  describe('başkasının becerisi', () => {
    let ayse: Person;
    let mert: Person;
    let bot: Bot;
    let skill: Skill;
    const say = async (p: Person, text: string) => {
      const thread = (await p.api<Thread>('GET', `/api/bots/${bot.id}/main-thread`)).body;
      await p.api('POST', `/api/threads/${thread.id}/messages`, {
        clientId: `c-${Math.random().toString(36).slice(2, 12)}`,
        text,
      });
      await t.services.turns.idle();
      return (await p.api<Message[]>('GET', `/api/threads/${thread.id}/messages`)).body.at(-1)!.text;
    };
    const save = (body: string, reason = 'Son fiyat listesine bakmayı ekledim') =>
      `[araç:skill_save ${JSON.stringify({ name: 'teklif', description: 'Teklif hazırlarken', body, reason })}]`;

    beforeEach(async () => {
      ayse = await t.person('ayse');
      mert = await t.person('mert');
      bot = await t.bot({ name: 'Satış', permissionMode: 'auto' });
      await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: {} });
      skill = (
        await t.api<Skill>('POST', '/api/skills', {
          name: 'teklif',
          description: 'Teklif hazırlarken',
          body: 'Müşteriye sor.',
          botIds: [bot.id],
        })
      ).body;
    });

    it('üyenin botu bulduğu düzeltmeyi sahibine önerir; sahibi kabul edince beceri değişir', async () => {
      const reply = await say(ayse, save('Önce son fiyat listesine bak, sonra müşteriye sor.'));
      expect(reply).toContain('öneri olarak gitti');
      expect((await t.api<Skill[]>('GET', '/api/skills')).body[0]!.body).toBe('Müşteriye sor.');

      // Only the skill's owner (and the admins) read it; the member who asked does not decide.
      expect((await ayse.api<SkillChange[]>('GET', '/api/skill-changes')).body).toEqual([]);
      const [change, ...rest] = (await t.api<SkillChange[]>('GET', '/api/skill-changes')).body;
      expect(rest).toEqual([]);
      expect(change).toMatchObject({
        skillName: 'teklif',
        body: 'Önce son fiyat listesine bak, sonra müşteriye sor.',
        reason: 'Son fiyat listesine bakmayı ekledim',
        proposedBy: bot.id,
        userId: 'ayse',
        userName: 'ayse',
      });
      expect((await t.api<TodayReport>('GET', '/api/today')).body.pendingSkills).toBe(1);

      // The bot's newer version for the same person takes the waiting one's place.
      await say(ayse, save('Önce güncel fiyat listesine bak.'));
      const waiting = (await t.api<SkillChange[]>('GET', '/api/skill-changes')).body;
      expect(waiting.map((c) => c.body)).toEqual(['Önce güncel fiyat listesine bak.']);

      expect((await mert.api('POST', `/api/skill-changes/${waiting[0]!.id}/accept`)).status).toBe(404);
      expect((await ayse.api('POST', `/api/skill-changes/${waiting[0]!.id}/accept`)).status).toBe(404);
      const accepted = await t.api<Skill>('POST', `/api/skill-changes/${waiting[0]!.id}/accept`);
      expect(accepted.body).toMatchObject({ id: skill.id, body: 'Önce güncel fiyat listesine bak.' });
      expect((await t.api<SkillChange[]>('GET', '/api/skill-changes')).body).toEqual([]);
    });

    it('reddedilen öneri beceriyi değiştirmez; yönetici de karar verir', async () => {
      const admin = await t.person('yonetici', 'admin');
      await say(ayse, save('Hiç sorma.'));
      const [change] = (await admin.api<SkillChange[]>('GET', '/api/skill-changes')).body;
      expect((await admin.api('POST', `/api/skill-changes/${change!.id}/reject`)).status).toBe(200);
      expect((await t.api<SkillChange[]>('GET', '/api/skill-changes')).body).toEqual([]);
      expect((await t.api<Skill[]>('GET', '/api/skills')).body[0]!.body).toBe('Müşteriye sor.');
    });

    it('yalnızca konuşabilen üye yeni beceri açtıramaz; botu değiştirebilenin kaydettiği beceri onundur', async () => {
      expect(await say(ayse, '[araç:skill_save {"name":"yeni","description":"x","body":"y"}]')).not.toContain(
        'kaydedildi',
      );
      // The bot is told it can only suggest fixes for her, so it does not offer a new skill.
      const offered = t.engine.requests.at(-1)!.tools.find((x) => x.name === 'skill_save')!;
      expect(offered.description).toContain('yeni beceri kaydedemezsin');
      await t.api('PUT', `/api/bots/${bot.id}/access`, { everyone: 'chat', people: { ayse: 'edit' } });
      expect(await say(ayse, '[araç:skill_save {"name":"yeni","description":"x","body":"y"}]')).toContain(
        'kaydedildi',
      );
      const mine = (await t.api<Skill[]>('GET', '/api/skills')).body.find((k) => k.name === 'yeni')!;
      expect((await ayse.api('PATCH', `/api/skills/${mine.id}`, { body: 'z' })).status).toBe(200);
      // Her own skill she fixes at once; the owner's still waits for the owner.
      expect(await say(ayse, '[araç:skill_save {"name":"yeni","description":"x","body":"w"}]')).toContain(
        'güncellendi',
      );
      expect(await say(ayse, save('Başka yol.'))).toContain('öneri olarak gitti');
    });
  });

  it('mesajda $ad ile anılan beceri için bot önce okumaya yönlendirilir', async () => {
    const bot = await t.bot({ name: 'Katip' });
    await t.api('POST', '/api/skills', { name: 'fatura', description: 'Fatura', botIds: [bot.id] });
    const thread = await main(bot.id);
    await t.send(thread.id, '$fatura ile Ayşe için kes');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).toMatch(/^\(Kullanıcı şu beceriyi kullanmanı istiyor: fatura\./);
    await t.send(thread.id, 'fiyat $5 ve $faturax');
    await t.services.turns.idle();
    expect(t.engine.requests.at(-1)!.prompt).toBe('fiyat $5 ve $faturax');
    expect(taggedSkill('(bkz. $fatura)', 'fatura')).toBe(true);
    expect(taggedSkill('a$fatura', 'fatura')).toBe(false);
  });
});
