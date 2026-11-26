import type { BotTable, TableRow, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Define } from '../src/tools';
import { tableTools } from '../src/tools/tables';
import type { Services } from '../src/services';
import { AUTH, testServer, type TestServer } from './helpers';

describe('botun tabloları', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const tables = async (botId: string) => (await t.api<BotTable[]>('GET', `/api/bots/${botId}/tables`)).body;
  const rows = async (tableId: string) =>
    (await t.api<TableRow[]>('GET', `/api/tables/${tableId}/rows`)).body;
  const say = async (threadId: string, text: string) => {
    await t.send(threadId, text);
    await t.services.turns.idle();
    return (await t.messages(threadId)).at(-1)!.text;
  };

  it('bot tablo kurar, türlerine göre satır ekler ve süzerek okur', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    await say(
      th.id,
      '[araç:table_define {"name":"Adaylar","columns":[{"name":"Ad"},{"name":"Bütçe","type":"number"},{"name":"Arandı","type":"bool"},{"name":"Tarih","type":"date"},{"name":"Site","type":"url"}]}]',
    );
    await say(
      th.id,
      '[araç:table_add {"table":"adaylar","rows":[{"Ad":"Ayşe","bütçe":"1.250,5","Arandı":"evet","Tarih":"2026-11-17","Site":"ornek.com"},{"Ad":"Can","Bütçe":300,"Arandı":false}]}]',
    );
    const [table] = await tables(a.id);
    expect(table).toMatchObject({ name: 'Adaylar', rowCount: 2 });
    const list = await rows(table!.id);
    expect(list.map((r) => r.values)).toEqual([
      { Ad: 'Ayşe', Bütçe: 1250.5, Arandı: true, Tarih: '2026-11-17', Site: 'https://ornek.com/' },
      { Ad: 'Can', Bütçe: 300, Arandı: false },
    ]);
    const read = await say(th.id, '[araç:table_rows {"table":"Adaylar","where":{"arandı":"evet"}}]');
    expect(read).toContain('Ayşe');
    expect(read).not.toContain('Can');
    expect(read).toContain(list[0]!.id);
  });

  it('türüne uymayan değer ya da olmayan sütun hiçbir satır yazdırmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    await say(
      th.id,
      '[araç:table_define {"name":"Fiyatlar","columns":[{"name":"Ürün"},{"name":"Fiyat","type":"number"}]}]',
    );
    const bad = await say(
      th.id,
      '[araç:table_add {"table":"Fiyatlar","rows":[{"Ürün":"Çay","Fiyat":"40"},{"Ürün":"Kahve","Fiyat":"pahalı"}]}]',
    );
    expect(bad).toContain('"Fiyat" sütunu bir sayı bekliyor');
    const unknown = await say(th.id, '[araç:table_add {"table":"Fiyatlar","rows":[{"Renk":"mavi"}]}]');
    expect(unknown).toContain('"Renk" diye bir sütun yok');
    const missing = await say(th.id, '[araç:table_rows {"table":"Siparişler"}]');
    expect(missing).toContain('Fiyatlar');
    expect((await tables(a.id))[0]!.rowCount).toBe(0);
  });

  it('geçersiz sütun adı bota kendi dilinde anlatılır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    const reply = await say(th.id, '[araç:table_define {"name":"X","columns":[{"name":"a\\tb"}]}]');
    expect(reply).toContain('satır sonu ya da sekme');
    expect(await tables(a.id)).toEqual([]);
  });

  it('aynı adla yeniden kurmak yalnız eksik sütunları ekler, satırlar kalır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    await say(th.id, '[araç:table_define {"name":"Notlar","columns":[{"name":"Konu"}]}]');
    await say(th.id, '[araç:table_add {"table":"Notlar","rows":[{"Konu":"ilk"}]}]');
    await say(
      th.id,
      '[araç:table_define {"name":"notlar","columns":[{"name":"konu","type":"number"},{"name":"Önem","type":"number"}]}]',
    );
    const [table] = await tables(a.id);
    expect(table!.columns).toEqual([
      { name: 'Konu', type: 'text' },
      { name: 'Önem', type: 'number' },
    ]);
    expect((await rows(table!.id)).map((r) => r.values)).toEqual([{ Konu: 'ilk' }]);
  });

  it('bot satırı günceller ve siler', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    await say(
      th.id,
      '[araç:table_define {"name":"İşler","columns":[{"name":"İş"},{"name":"Bitti","type":"bool"}]}]',
    );
    await say(th.id, '[araç:table_add {"table":"İşler","rows":[{"İş":"a"},{"İş":"b"}]}]');
    const [table] = await tables(a.id);
    const [first, second] = await rows(table!.id);
    await say(th.id, `[araç:table_update {"table":"İşler","id":"${first!.id}","values":{"Bitti":"evet"}}]`);
    await say(th.id, `[araç:table_delete_rows {"table":"İşler","ids":["${second!.id}"]}]`);
    expect((await rows(table!.id)).map((r) => r.values)).toEqual([{ İş: 'a', Bitti: true }]);
  });

  it('bir bot başka botun tablosuna ulaşamaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const b = await t.bot({ name: 'Veli' });
    await say((await main(a.id)).id, '[araç:table_define {"name":"Gizli","columns":[{"name":"x"}]}]');
    const thB = await main(b.id);
    // With no table of its own it is not even given the list; the other bot's never shows.
    expect(await say(thB.id, '[araç:tables_list {}]')).not.toContain('Gizli');
    expect(await say(thB.id, '[araç:table_add {"table":"Gizli","rows":[{"x":"1"}]}]')).toContain(
      'Henüz tablon yok',
    );
    expect(await tables(b.id)).toEqual([]);
  });

  it('kişi satır ekler, düzeltir, siler ve tabloyu kaldırır', async () => {
    const a = await t.bot({ name: 'Ali' });
    const { table } = await t.services.tables.define(a.id, 'Liste', [
      { name: 'Ad', type: 'text' },
      { name: 'Adet', type: 'number' },
    ]);
    const added = await t.api<TableRow>('POST', `/api/tables/${table.id}/rows`, { Ad: 'kalem', Adet: '3' });
    expect(added.body.values).toEqual({ Ad: 'kalem', Adet: 3 });
    const wrong = await t.api('PATCH', `/api/tables/${table.id}/rows/${added.body.id}`, { Adet: 'çok' });
    expect(wrong.status).toBe(400);
    await t.api('PATCH', `/api/tables/${table.id}/rows/${added.body.id}`, { Adet: '' });
    expect((await rows(table.id))[0]!.values).toEqual({ Ad: 'kalem', Adet: null });
    await t.api('DELETE', `/api/tables/${table.id}/rows/${added.body.id}`);
    expect(await rows(table.id)).toEqual([]);
    await t.api('DELETE', `/api/tables/${table.id}`);
    expect(await tables(a.id)).toEqual([]);
    expect((await t.api('DELETE', `/api/tables/${table.id}`)).status).toBe(404);
  });

  it('tablo CSV olarak iner: sayılar düz, evet/hayır kişinin dilinde, formül gibi metin etkisiz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const { table } = await t.services.tables.define(a.id, 'Fiyat, Liste', [
      { name: 'Ürün', type: 'text' },
      { name: 'Fiyat', type: 'number' },
      { name: 'Var', type: 'bool' },
    ]);
    await t.services.tables.addRows(table.id, [
      { Ürün: 'Çay, siyah', Fiyat: -2.5, Var: true },
      { Ürün: '=1+1', Var: false },
    ]);
    const res = await t.app.inject({
      method: 'GET',
      url: `/api/tables/${table.id}/rows.csv`,
      headers: { ...AUTH, host: 'localhost' },
    });
    expect(res.headers['content-disposition']).toContain(encodeURIComponent('Fiyat, Liste.csv'));
    expect(res.body).toBe('\uFEFFÜrün,Fiyat,Var\r\n"Çay, siyah",-2.5,evet\r\n\'=1+1,,hayır\r\n');
  });

  it('görünüm tabloyla saklanır: kişi ya da bot seçer, olmayan sütunla pano kurulmaz', async () => {
    const a = await t.bot({ name: 'Ali' });
    const th = await main(a.id);
    const said = await say(
      th.id,
      '[araç:table_define {"name":"İşler","columns":[{"name":"İş"},{"name":"Durum"}],"view":{"kind":"board","group":"durum"}}]',
    );
    expect(said).toContain('Görünüm: pano, gruplama: Durum');
    const [table] = await tables(a.id);
    expect(table!.view).toEqual({ kind: 'board', group: 'Durum' });

    const put = (view: object) => t.api<BotTable>('PUT', `/api/tables/${table!.id}/view`, view);
    expect((await put({ kind: 'gallery', group: null })).body.view).toEqual({ kind: 'gallery', group: null });
    expect((await put({ kind: 'board' })).status).toBe(400);
    expect((await put({ kind: 'list', group: 'Öncelik' })).status).toBe(400);
    expect((await tables(a.id))[0]!.view).toEqual({ kind: 'gallery', group: null });

    // Someone who may only talk to the bot reads the table but does not lay it out for everyone.
    const ayse = await t.person('ayse');
    await t.api('PUT', `/api/bots/${a.id}/access`, { everyone: 'chat', people: {} });
    expect((await ayse.api('GET', `/api/tables/${table!.id}/rows`)).status).toBe(200);
    expect(
      (await ayse.api('PUT', `/api/tables/${table!.id}/view`, { kind: 'list', group: null })).status,
    ).toBe(403);
  });

  it('tablosu olmayan bot yalnız tablo kurup doldurmanın araçlarını alır', () => {
    const names = (hasTables: boolean) =>
      tableTools({
        def: ((name: string) => ({ name })) as unknown as Define,
        services: {} as Services,
        botId: 'b',
        t: ((k: string) => k) as never,
        note: async () => undefined,
        hasTables,
        shared: true,
      }).map((x) => x.name);
    expect(names(false)).toEqual(['table_define', 'table_add']);
    expect(names(true)).toHaveLength(6);
  });
});
