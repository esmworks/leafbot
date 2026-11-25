import type { BotTable, DashboardSummary, DashboardView, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { testServer, type TestServer } from './helpers';

describe('gösterge panelleri', () => {
  let t: TestServer;
  beforeEach(async () => {
    t = await testServer();
  });
  afterEach(() => t.dispose());

  const main = async (botId: string) => (await t.api<Thread>('GET', `/api/bots/${botId}/main-thread`)).body;
  const say = async (threadId: string, text: string) => {
    await t.send(threadId, text);
    await t.services.turns.idle();
    return (await t.messages(threadId)).at(-1)!.text;
  };
  const tool = (name: string, args: unknown) => `[araç:${name} ${JSON.stringify(args)}]`;
  const pages = async () => (await t.api<DashboardSummary[]>('GET', '/api/dashboards')).body;
  const view = async (id: string) => (await t.api<DashboardView>('GET', `/api/dashboards/${id}`)).body;
  const stat = (v: DashboardView, title: string) =>
    v.tiles.find((x) => x.title === title)?.card?.root.children?.find((c) => c.type === 'Stat')?.value;

  /** A bot with a table of quotes and two rows in it. */
  async function quoting(name: string) {
    const bot = await t.bot({ name });
    const th = await main(bot.id);
    await say(
      th.id,
      tool('table_define', {
        name: 'Teklifler',
        columns: [{ name: 'Firma' }, { name: 'Tutar', type: 'number' }, { name: 'Durum' }],
      }),
    );
    await say(
      th.id,
      tool('table_add', {
        table: 'Teklifler',
        rows: [
          { Firma: 'Koç', Tutar: 1000, Durum: 'açık' },
          { Firma: 'Ak', Tutar: 500, Durum: 'kapalı' },
        ],
      }),
    );
    return { bot, th };
  }

  it('bot tablodan kutucuk kurar; satır eklendikçe değer kendiliğinden güncellenir', async () => {
    const { bot, th } = await quoting('Satış');
    const reply = await say(
      th.id,
      tool('dashboard_define', {
        name: '3E Satış',
        tiles: [
          { title: 'Açık teklif', show: 'number', table: 'teklifler', filter: 'Durum=açık' },
          { title: 'Toplam tutar', show: 'number', table: 'Teklifler', measure: 'sum', column: 'tutar' },
          { title: 'Firmalara göre', show: 'bar', table: 'Teklifler', group_by: 'Firma', wide: true },
          {
            title: 'CRM',
            show: 'card',
            card: { type: 'Card', children: [{ type: 'Stat', label: 'Ziyaret', value: '7' }] },
          },
        ],
      }),
    );
    expect(reply).toContain('“3E Satış” gösterge paneli güncellendi');
    const [page] = await pages();
    expect(page).toMatchObject({ name: '3E Satış', botIds: [bot.id], tileCount: 4 });
    let v = await view(page!.id);
    expect(v.tiles.map((x) => x.title)).toEqual(['Açık teklif', 'Toplam tutar', 'Firmalara göre', 'CRM']);
    expect(stat(v, 'Açık teklif')).toBe('1');
    expect(stat(v, 'Toplam tutar')).toBe('1.500');
    expect(v.tiles[2]).toMatchObject({ wide: true, error: null });
    expect(stat(v, 'CRM')).toBe('7');

    // The person adds a row in the app: the tiles read it the next time they are looked at.
    const [table] = (await t.api<BotTable[]>('GET', `/api/bots/${bot.id}/tables`)).body;
    await t.api('POST', `/api/tables/${table!.id}/rows`, { Firma: 'Ege', Tutar: 250, Durum: 'açık' });
    v = await view(page!.id);
    expect(stat(v, 'Açık teklif')).toBe('2');
    expect(stat(v, 'Toplam tutar')).toBe('1.750');
  });

  it('hatalı bir kutucuk hiçbir şey yazdırmaz ve bota nedenini söyler', async () => {
    const { th } = await quoting('Satış');
    const reply = await say(
      th.id,
      tool('dashboard_define', {
        name: 'Panel',
        tiles: [
          { title: 'İyi', show: 'number', table: 'Teklifler' },
          { title: 'Kötü', show: 'number', table: 'Teklifler', measure: 'sum', column: 'Firma' },
          {
            title: 'Soru',
            show: 'card',
            card: { type: 'Card', children: [{ type: 'Button', label: 'Tamam' }] },
          },
          { title: 'Yok', show: 'number', table: 'Siparişler' },
        ],
      }),
    );
    expect(reply).toContain('Gösterge paneline hiçbir şey yazılmadı');
    expect(reply).toContain('“Firma” bir sayı sütunu değil');
    expect(reply).toContain('form, düğme ya da alan içeremez');
    expect(reply).toContain('Tabloların: Teklifler');
    expect(await pages()).toEqual([]);
  });

  it('aynı başlık kutucuğu yerinde değiştirir, remove kaldırır', async () => {
    const { th } = await quoting('Satış');
    const define = (tiles: unknown[], remove: string[] = []) =>
      say(th.id, tool('dashboard_define', { name: 'Panel', tiles, remove }));
    await define([
      { title: 'A', show: 'number', table: 'Teklifler' },
      { title: 'B', show: 'rows', table: 'Teklifler' },
    ]);
    await define([{ title: 'a', show: 'progress', table: 'Teklifler', goal: 4 }], ['B']);
    const [page] = await pages();
    const v = await view(page!.id);
    expect(v.tiles.map((x) => [x.title, x.show])).toEqual([['a', 'progress']]);
  });

  it('herkes yalnızca konuşabildiği botların kutucuklarını görür; paneli yalnızca hepsini değiştirebilen siler', async () => {
    const { th: a } = await quoting('Satış');
    const { bot: depo, th: b } = await quoting('Depo');
    await say(
      a.id,
      tool('dashboard_define', {
        name: '3E',
        tiles: [{ title: 'Satış', show: 'number', table: 'Teklifler' }],
      }),
    );
    await say(
      b.id,
      tool('dashboard_define', {
        name: '3e',
        tiles: [{ title: 'Depo', show: 'number', table: 'Teklifler' }],
      }),
    );
    const [page] = await pages();
    expect((await view(page!.id)).tiles.map((x) => x.title)).toEqual(['Satış', 'Depo']);

    const mert = await t.person('mert');
    expect((await mert.api<DashboardSummary[]>('GET', '/api/dashboards')).body).toEqual([]);
    expect((await mert.api('GET', `/api/dashboards/${page!.id}`)).status).toBe(404);
    await t.api('PUT', `/api/bots/${depo.id}/access`, { everyone: 'none', people: { mert: 'chat' } });
    const seen = (await mert.api<DashboardView>('GET', `/api/dashboards/${page!.id}`)).body;
    expect(seen.tiles.map((x) => x.title)).toEqual(['Depo']);
    // Talking with a bot is not changing it: its tiles and the page stay.
    expect((await mert.api('DELETE', `/api/dashboard-tiles/${seen.tiles[0]!.id}`)).status).toBe(403);
    expect((await mert.api('DELETE', `/api/dashboards/${page!.id}`)).status).toBe(403);

    // A bot working for the owner reads the other bot's tile too.
    const read = await say(a.id, tool('dashboards', { name: '3E' }));
    expect(read).toContain('## Depo (Depo)');
    expect(read).toContain('2');

    expect((await t.api('DELETE', `/api/dashboards/${page!.id}`)).status).toBe(200);
    expect(await pages()).toEqual([]);
  });

  it('tablosu silinen kutucuk nedenini söyler, öteki kutucuklar çizilir', async () => {
    const { bot, th } = await quoting('Satış');
    await say(
      th.id,
      tool('dashboard_define', {
        name: 'Panel',
        tiles: [
          { title: 'Sayı', show: 'number', table: 'Teklifler' },
          {
            title: 'Not',
            show: 'card',
            card: { type: 'Card', children: [{ type: 'Text', value: 'merhaba' }] },
          },
        ],
      }),
    );
    const [table] = (await t.api<BotTable[]>('GET', `/api/bots/${bot.id}/tables`)).body;
    await t.api('DELETE', `/api/tables/${table!.id}`);
    const [page] = await pages();
    const v = await view(page!.id);
    expect(v.tiles[0]).toMatchObject({ card: null, error: '“Teklifler” tablosu yok.' });
    expect(v.tiles[1]!.card).not.toBeNull();
  });

  it('kişi kutucukları yer değiştirerek sıralar', async () => {
    const { th } = await quoting('Satış');
    await say(
      th.id,
      tool('dashboard_define', {
        name: 'Panel',
        tiles: ['A', 'B', 'C'].map((title) => ({ title, show: 'number', table: 'Teklifler' })),
      }),
    );
    const [page] = await pages();
    const [, b] = (await view(page!.id)).tiles;
    await t.api('POST', `/api/dashboard-tiles/${b!.id}/move`, { direction: 'earlier' });
    expect((await view(page!.id)).tiles.map((x) => x.title)).toEqual(['B', 'A', 'C']);
    await t.api('POST', `/api/dashboard-tiles/${b!.id}/move`, { direction: 'earlier' });
    expect((await view(page!.id)).tiles.map((x) => x.title)).toEqual(['B', 'A', 'C']);
  });
});
