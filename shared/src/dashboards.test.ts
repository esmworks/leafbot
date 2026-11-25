import { describe, expect, it } from 'vitest';
import type { CardNode } from './card';
import {
  periodDays,
  tableTileCard,
  tileCard,
  tileProblem,
  type DashboardSay,
  type TileContext,
  type TileSpec,
} from './dashboards';
import type { BotTable, TableRow } from './tables';

const table: BotTable = {
  id: 't1',
  botId: 'b1',
  name: 'Teklifler',
  columns: [
    { name: 'Firma', type: 'text' },
    { name: 'Tutar', type: 'number' },
    { name: 'Durum', type: 'text' },
    { name: 'Tarih', type: 'date' },
    { name: 'Onaylı', type: 'bool' },
  ],
  rowCount: 0,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

let n = 0;
const row = (values: TableRow['values'], createdAt = '2026-11-20T09:00:00Z'): TableRow => ({
  id: `r${++n}`,
  values,
  createdAt,
  updatedAt: createdAt,
});

const say: DashboardSay = (key, vars) => (vars ? `${key}(${Object.values(vars).join(',')})` : key);
const cx: TileContext = {
  now: new Date('2026-11-25T10:00:00Z'),
  timeZone: 'Europe/Istanbul',
  locale: 'en',
  say,
  yes: 'yes',
  no: 'no',
};

const spec = (s: Partial<TileSpec>): TileSpec => ({ title: 'T', show: 'number', table: 'Teklifler', ...s });

function find(node: CardNode, type: string): CardNode | undefined {
  if (node.type === type) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, type);
    if (hit) return hit;
  }
  return undefined;
}

function made(s: Partial<TileSpec>, rows: TableRow[]) {
  const r = tableTileCard(spec(s), table, rows, cx);
  if (!r.ok) throw new Error(r.problem.key);
  return r.card.root;
}

describe('periodDays', () => {
  const day = (ymd: string) =>
    Date.UTC(+ymd.slice(0, 4), +ymd.slice(5, 7) - 1, +ymd.slice(8, 10)) / 86_400_000;
  it('reads a month to its end, with the month before up to the same day', () => {
    const p = periodDays('month', day('2026-11-25'))!;
    expect([p.from, p.to]).toEqual([day('2026-11-01'), day('2026-11-30')]);
    expect([p.before.from, p.before.to]).toEqual([day('2026-10-01'), day('2026-10-25')]);
  });
  it('reads the last 7 days with the 7 before them', () => {
    const p = periodDays('7d', day('2026-11-25'))!;
    expect([p.from, p.to, p.before.from, p.before.to]).toEqual([
      day('2026-11-19'),
      day('2026-11-25'),
      day('2026-11-12'),
      day('2026-11-18'),
    ]);
  });
  it('never reaches into this month from a shorter one before it', () => {
    const p = periodDays('month', day('2026-03-31'))!;
    expect([p.before.from, p.before.to]).toEqual([day('2026-02-01'), day('2026-02-28')]);
  });
  it('has nothing to cut for all time', () => {
    expect(periodDays('all', 1)).toBeNull();
  });
});

describe('tileProblem', () => {
  it('names a missing column with the ones there are', () => {
    expect(tileProblem(spec({ groupBy: 'Şehir' }), table)).toEqual({
      key: 'dashboard.problem.noColumn',
      vars: { column: 'Şehir', columns: 'Firma, Tutar, Durum, Tarih, Onaylı' },
    });
  });
  it('wants a number column to add up', () => {
    expect(tileProblem(spec({ measure: 'sum', column: 'Firma' }), table)?.key).toBe(
      'dashboard.problem.notNumber',
    );
    expect(tileProblem(spec({ measure: 'sum' }), table)?.key).toBe('dashboard.problem.needsColumn');
  });
  it('wants a chart to have an axis and a meter a goal', () => {
    expect(tileProblem(spec({ show: 'bar' }), table)?.key).toBe('dashboard.problem.needsAxis');
    expect(tileProblem(spec({ show: 'progress' }), table)?.key).toBe('dashboard.problem.needsGoal');
    expect(tileProblem(spec({ show: 'number', bucket: 'day' }), table)?.key).toBe(
      'dashboard.problem.bucketChart',
    );
  });
  it('checks the columns a filter names', () => {
    expect(tileProblem(spec({ filter: 'Durum=açık\nYok=1' }), table)?.vars?.column).toBe('Yok');
  });
  it('wants a date column for the day', () => {
    expect(tileProblem(spec({ dateColumn: 'Firma' }), table)?.key).toBe('dashboard.problem.notDate');
  });
});

describe('tileCard', () => {
  it('keeps a card that only shows', () => {
    const r = tileCard({ type: 'Card', children: [{ type: 'Stat', label: 'Ciro', value: '12' }] });
    expect(r.ok).toBe(true);
  });
  it('refuses a card that asks something', () => {
    const r = tileCard({
      type: 'Card',
      children: [{ type: 'Button', label: 'Tamam', onClickAction: { type: 'ok' } }],
    });
    expect(r.ok ? null : r.problem).toEqual({
      key: 'dashboard.problem.notDisplay',
      vars: { what: 'Button' },
    });
    const field = tileCard({ type: 'Card', children: [{ type: 'Checkbox', name: 'x', label: 'X' }] });
    expect(field.ok).toBe(false);
  });
  it('wants a card at all', () => {
    expect(tileCard(undefined).ok).toBe(false);
  });
});

describe('tableTileCard', () => {
  it('counts the rows that pass the filter, in words as the column takes them', () => {
    const rows = [
      row({ Firma: 'A', Durum: 'açık', Onaylı: true }),
      row({ Firma: 'B', Durum: 'Açık', Onaylı: false }),
      row({ Firma: 'C', Durum: 'kapalı', Onaylı: true }),
    ];
    expect(find(made({ filter: 'Durum=açık' }, rows), 'Stat')?.value).toBe('2');
    expect(find(made({ filter: 'Onaylı=evet' }, rows), 'Stat')?.value).toBe('2');
    expect(find(made({ filter: 'Durum!=kapalı\nOnaylı=yes' }, rows), 'Stat')?.value).toBe('1');
  });

  it('adds up a number column and shows how it moved against the same span before', () => {
    const rows = [
      row({ Tutar: 100, Tarih: '2026-11-03' }),
      row({ Tutar: 50, Tarih: '2026-11-20' }),
      row({ Tutar: 100, Tarih: '2026-10-10' }),
      // After 25 October: past the point this month has reached, so not compared.
      row({ Tutar: 999, Tarih: '2026-10-28' }),
    ];
    const stat = find(
      made({ measure: 'sum', column: 'Tutar', period: 'month', dateColumn: 'Tarih' }, rows),
      'Stat',
    );
    expect(stat).toMatchObject({ value: '150', delta: '+50%', trend: 'up' });
    expect(stat?.caption).toBe('dashboard.period.month · dashboard.measure.sum(Tutar)');
  });

  it('counts a row on the day it was written in the server time zone', () => {
    // 22:30 UTC on 24 November is 01:30 on the 25th in Istanbul: today there.
    const rows = [row({ Firma: 'A' }, '2026-11-24T22:30:00Z'), row({ Firma: 'B' }, '2026-11-24T20:00:00Z')];
    expect(find(made({ period: 'today' }, rows), 'Stat')?.value).toBe('1');
  });

  it('draws days with nothing in them as zero', () => {
    const rows = [row({ Tarih: '2026-11-20' }), row({ Tarih: '2026-11-22' }), row({ Tarih: '2026-11-22' })];
    const chart = find(
      made({ show: 'bar', bucket: 'day', period: '7d', dateColumn: 'Tarih' }, rows),
      'Chart',
    )!;
    expect((chart.data as { s0: number }[]).map((p) => p.s0)).toEqual([0, 1, 0, 2, 0, 0, 0]);
  });

  it('keeps the largest groups and puts the rest into Other', () => {
    const rows = Array.from({ length: 15 }, (_, i) =>
      Array.from({ length: 15 - i }, () => row({ Firma: `F${i}` })),
    ).flat();
    const chart = find(made({ show: 'bar', groupBy: 'Firma' }, rows), 'Chart')!;
    const data = chart.data as { x: string; v: number }[];
    expect(data).toHaveLength(12);
    expect(data[0]).toEqual({ x: 'F0', v: 15 });
    expect(data[11]).toEqual({ x: 'dashboard.other', v: 4 + 3 + 2 + 1 });
  });

  it('splits a chart over time into a series per group, stacked as bars', () => {
    const rows = [
      row({ Durum: 'açık', Tarih: '2026-11-24' }),
      row({ Durum: 'kapalı', Tarih: '2026-11-24' }),
      row({ Durum: 'açık', Tarih: '2026-11-25' }),
    ];
    const chart = find(
      made({ show: 'bar', bucket: 'day', groupBy: 'Durum', period: 'today', dateColumn: 'Tarih' }, rows),
      'Chart',
    )!;
    expect(chart.series).toEqual([expect.objectContaining({ dataKey: 's0', label: 'açık', stack: 'all' })]);
    expect(chart.data).toEqual([{ x: 'Nov 25', s0: 1 }]);
  });

  it('lists the latest rows first with the columns asked for', () => {
    const rows = [
      row({ Firma: 'Eski', Tarih: '2026-11-01', Tutar: 5 }),
      row({ Firma: 'Yeni', Tarih: '2026-11-24', Tutar: 1250.5 }),
    ];
    const root = made({ show: 'rows', dateColumn: 'Tarih', columns: ['Firma', 'Tutar'], limit: 1 }, rows);
    expect(find(root, 'Text')?.value).toBe('T');
    const col = find(root, 'Col')!;
    expect(col.children?.[0]?.children?.map((c) => c.value)).toEqual(['Yeni', undefined, '1,250.5']);
    expect(root.children?.at(-1)?.value).toBe('dashboard.moreRows(1)');
  });

  it('cuts a long cell so the tile stays within the card limit', () => {
    const rows = Array.from({ length: 20 }, () => row({ Firma: 'x'.repeat(2000), Durum: 'y'.repeat(2000) }));
    const root = made({ show: 'rows', columns: ['Firma', 'Durum'], limit: 20 }, rows);
    const first = find(root, 'Col')!.children![0]!.children![0]!;
    expect(String(first.value)).toHaveLength(120);
  });

  it('shows how far along a goal is', () => {
    const p = find(made({ show: 'progress', goal: 10, ring: true }, [row({}), row({})]), 'Progress');
    expect(p).toMatchObject({ value: 2, max: 10, variant: 'ring', label: 'T' });
  });
});
