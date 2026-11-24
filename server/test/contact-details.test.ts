import type { ContactDetails } from '@leafbot/shared';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schema } from '../src/db';
import { testServer, type Person, type TestServer } from './helpers';

// Made-up details for the tests; no real person's.
const HOME = {
  label: 'Ev',
  givenName: 'Ayşe',
  familyName: 'Yılmaz',
  email: 'ayse@ornek.test',
  phone: '+90 555 000 00 00',
  address1: 'Deneme Sokak No 1',
  city: 'Kadıköy',
  region: 'İstanbul',
  postalCode: '34000',
  country: 'Türkiye',
};

describe('iletişim bilgileri', () => {
  let t: TestServer;
  let ayse: Person;
  let mehmet: Person;
  beforeEach(async () => {
    t = await testServer();
    ayse = await t.person('ayse');
    mehmet = await t.person('mehmet');
  });
  afterEach(() => t.dispose());
  const db = () => t.services.ctx.db;

  it('bilgileri mühürler; sahibine bütün gösterir, başkasına göstermez', async () => {
    const made = await ayse.api<ContactDetails>('POST', '/api/contacts', HOME);
    expect(made.status).toBe(200);
    expect(made.body).toMatchObject({ ...HOME, address2: '', organization: '', userId: 'ayse', sites: [] });
    const [row] = await db()
      .select()
      .from(schema.contactDetails)
      .where(eq(schema.contactDetails.id, made.body.id));
    expect(row!.secret.startsWith('v2:')).toBe(true);
    for (const value of ['Yılmaz', 'ornek.test', 'Kadıköy']) expect(row!.secret).not.toContain(value);

    // Someone else's details are neither listed nor changed.
    expect((await mehmet.api<ContactDetails[]>('GET', '/api/contacts')).body).toEqual([]);
    expect((await mehmet.api('PATCH', `/api/contacts/${made.body.id}`, { label: 'x' })).status).toBe(404);
    expect((await mehmet.api('DELETE', `/api/contacts/${made.body.id}`)).status).toBe(404);
    // Only those who look after the server add details for the whole team.
    expect((await ayse.api('POST', '/api/contacts', { ...HOME, team: true })).status).toBe(403);
    // Nothing to fill, or an email that is not one, is refused.
    expect((await ayse.api('POST', '/api/contacts', { label: 'Boş' })).status).toBe(400);
    expect((await ayse.api('POST', '/api/contacts', { email: 'olmaz' })).status).toBe(400);
    expect(
      (
        await ayse.api('PATCH', `/api/contacts/${made.body.id}`, {
          ...Object.fromEntries(Object.keys(HOME).map((k) => [k, ''])),
        })
      ).status,
    ).toBe(400);

    // Changing one part keeps the others.
    const changed = await ayse.api<ContactDetails>('PATCH', `/api/contacts/${made.body.id}`, {
      phone: '+90 555 111 11 11',
    });
    expect(changed.body).toMatchObject({ ...HOME, phone: '+90 555 111 11 11' });
  });

  it('bot bilgileri yalnız sahibi için ve seçilen botlarla açar; onaylı siteler satıra bağlıdır', async () => {
    const bot = await t.bot({ name: 'Alışveriş' });
    const other = await t.bot({ name: 'Başka' });
    const contacts = t.services.contacts;
    const mine = (await ayse.api<ContactDetails>('POST', '/api/contacts', HOME)).body;
    const team = (
      await t.api<ContactDetails>('POST', '/api/contacts', {
        label: 'Ofis',
        organization: 'Deneme Ltd',
        team: true,
        botIds: [bot.id],
      })
    ).body;
    expect(team.userId).toBeNull();

    expect((await contacts.forBot(bot.id, 'ayse')).map((c) => c.label)).toEqual(['Ev', 'Ofis']);
    expect((await contacts.forBot(other.id, 'ayse')).map((c) => c.label)).toEqual(['Ev']);
    expect((await contacts.forBot(bot.id, 'mehmet')).map((c) => c.label)).toEqual(['Ofis']);
    expect((await contacts.forBot(bot.id, 'ayse'))[0]!.city).toBe('Kadıköy');

    await contacts.allowSite(mine.id, 'magaza.example');
    await contacts.allowSite(mine.id, 'kitap.example');
    expect((await contacts.get(mine.id)).sites).toEqual(['kitap.example', 'magaza.example']);
    const after = await ayse.api<ContactDetails>('PATCH', `/api/contacts/${mine.id}`, {
      forgetSites: ['kitap.example'],
    });
    expect(after.body.sites).toEqual(['magaza.example']);
    // Copied to another row, the approved sites and the values do not open there.
    const [row] = await db()
      .select()
      .from(schema.contactDetails)
      .where(eq(schema.contactDetails.id, mine.id));
    await db()
      .update(schema.contactDetails)
      .set({ sites: row!.sites, secret: row!.secret })
      .where(eq(schema.contactDetails.id, team.id));
    expect((await contacts.get(team.id)).sites).toEqual([]);
    expect((await contacts.forBot(bot.id, 'mehmet')).map((c) => c.label)).toEqual([]);

    // A bot that is deleted leaves the list of those the details are kept for.
    await t.api('POST', `/api/bots/${bot.id}/archive`);
    await t.api('DELETE', `/api/bots/${bot.id}`);
    expect((await contacts.get(team.id)).botIds).toEqual([]);
  });
});
