import type { BotTable, TableRow, TableShare, Thread } from '@leafbot/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolResult } from '../src/engine/types';
import { translator } from '../src/i18n';
import type { Define } from '../src/tools';
import { tableTools } from '../src/tools/tables';
import { testServer, type Person, type TestServer } from './helpers';

describe('başka botla paylaşılan tablo', () => {
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
  const tool = (name: string, input: object) => `[araç:${name} ${JSON.stringify(input)}]`;
  const rows = async (tableId: string) =>
    (await t.api<TableRow[]>('GET', `/api/tables/${tableId}/rows`)).body;
  const shareAs = (who: { api: TestServer['api'] }, tableId: string, botId: string, write = false) =>
    who.api<TableShare>('PUT', `/api/tables/${tableId}/shares/${botId}`, { write });

  /** Ali keeps the customers; Veli is let into them. */
  const setUp = async () => {
    const ali = await t.bot({ name: 'Ali', permissionMode: 'auto' });
    const veli = await t.bot({ name: 'Veli', permissionMode: 'auto' });
    const { table } = await t.services.tables.define(ali.id, 'Müşteriler', [
      { name: 'Ad', type: 'text' },
      { name: 'Şehir', type: 'text' },
    ]);
    await t.services.tables.addRows(table.id, [{ Ad: 'Ayşe', Şehir: 'İzmir' }]);
    return { ali, veli, table };
  };

  it('okumaya paylaşılan tabloyu bot listeler ve okur ama yazamaz; yazma izniyle yazar', async () => {
    const { veli, table } = await setUp();
    expect((await shareAs(t, table.id, veli.id)).status).toBe(200);
    const th = await main(veli.id);

    const list = await say(th.id, tool('tables_list', {}));
    expect(list).toContain('Ali / Müşteriler (Ali paylaştı, yalnızca okursun)');
    expect(await say(th.id, tool('table_rows', { table: 'Müşteriler' }))).toContain(
      'Ad: Ayşe · Şehir: İzmir',
    );
    const refused = await say(th.id, tool('table_add', { table: 'Müşteriler', rows: [{ Ad: 'Can' }] }));
    expect(refused).toContain('yalnızca okuman için paylaşıldı');
    expect(await rows(table.id)).toHaveLength(1);

    await shareAs(t, table.id, veli.id, true);
    await say(th.id, tool('table_add', { table: 'ali / müşteriler', rows: [{ Ad: 'Can', Şehir: 'Bursa' }] }));
    expect((await rows(table.id)).map((r) => r.values.Ad)).toEqual(['Ayşe', 'Can']);
    // The table stays Ali's: Veli's define makes a table of its own, and the person sees it under Ali.
    await say(th.id, tool('table_define', { name: 'Müşteriler', columns: [{ name: 'Not' }] }));
    expect((await t.services.tables.get(table.id)).columns.map((c) => c.name)).toEqual(['Ad', 'Şehir']);
    expect((await t.api<BotTable[]>('GET', `/api/bots/${veli.id}/tables`)).body.map((x) => x.name)).toEqual([
      'Müşteriler',
    ]);
    // Now its own one wins the bare name; the owner's name reaches Ali's.
    expect(await say(th.id, tool('table_rows', { table: 'Müşteriler' }))).toContain('satır yok');
    expect(await say(th.id, tool('table_rows', { table: 'Ali / Müşteriler' }))).toContain('Bursa');
  });

  it('geri alınan paylaşım bir sonraki adımdan itibaren geçer', async () => {
    const { veli, table } = await setUp();
    await shareAs(t, table.id, veli.id);
    const th = await main(veli.id);
    expect(await say(th.id, tool('table_rows', { table: 'Müşteriler' }))).toContain('Ayşe');
    expect((await t.api<TableShare[]>('GET', `/api/tables/${table.id}/shares`)).body).toEqual([
      { botId: veli.id, write: false },
    ]);
    expect((await t.api('DELETE', `/api/tables/${table.id}/shares/${veli.id}`)).status).toBe(200);
    // With no table left it is given only what starts one, which no longer finds Ali's.
    const after = await say(th.id, tool('table_add', { table: 'Müşteriler', rows: [{ Ad: 'Can' }] }));
    expect(after).toContain('Henüz tablon yok');
    expect(await rows(table.id)).toHaveLength(1);
  });

  it('paylaşmak iki botu da değiştirebilmeyi ister; paylaşılan botla konuşan sahibin satırlarını HTTP ile okuyamaz', async () => {
    const { ali, veli, table } = await setUp();
    const gizli = await t.bot({ name: 'Gizli' });
    const ayse: Person = await t.person('ayse');
    await t.api('PUT', `/api/bots/${ali.id}/access`, { everyone: 'none', people: { [ayse.id]: 'edit' } });
    await t.api('PUT', `/api/bots/${veli.id}/access`, { everyone: 'chat', people: {} });

    // She may change Ali but only talk to Veli; a bot she cannot see is not even named.
    expect((await shareAs(ayse, table.id, veli.id)).status).toBe(403);
    expect((await shareAs(ayse, table.id, gizli.id)).status).toBe(404);
    // A bot's own table needs no sharing.
    expect((await shareAs(ayse, table.id, ali.id)).status).toBe(400);

    // Shared by someone who may change both, the rows still answer only those who reach Ali.
    await shareAs(t, table.id, veli.id);
    const can = await t.person('can');
    expect((await can.api('GET', `/api/tables/${table.id}/rows`)).status).toBe(404);
    expect((await can.api('GET', `/api/tables/${table.id}/shares`)).status).toBe(404);
    expect((await can.api('DELETE', `/api/tables/${table.id}/shares/${veli.id}`)).status).toBe(404);
  });

  it('misafirin ya da WhatsApp kişisinin turunda paylaşılan tablo yok', async () => {
    const { veli, table } = await setUp();
    await shareAs(t, table.id, veli.id);
    const def = ((name: string, _input: unknown, handler: (a: unknown) => Promise<ToolResult>) => ({
      name,
      handler,
    })) as unknown as Define;
    const list = async (shared: boolean) => {
      const tools = tableTools({
        def,
        services: t.services,
        botId: veli.id,
        t: translator('tr'),
        note: async () => undefined,
        hasTables: true,
        shared,
      });
      return tools.find((x) => x.name === 'tables_list')!.handler({});
    };
    expect(await list(true)).toContain('Ali / Müşteriler');
    expect(await list(false)).toContain('Henüz tablon yok');
  });

  it('tablo ya da içine alınan bot silinince paylaşım da gider', async () => {
    const { veli, table } = await setUp();
    await shareAs(t, table.id, veli.id);
    expect(await t.services.tables.any(veli.id)).toBe(true);
    await t.api('DELETE', `/api/tables/${table.id}`);
    expect(await t.services.tables.any(veli.id)).toBe(false);
    expect(await t.services.tables.sharedWith(veli.id)).toEqual([]);
  });
});
