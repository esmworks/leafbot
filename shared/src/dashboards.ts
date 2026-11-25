import { z } from 'zod';
import { CARD_LIMITS, cardText, parseCard, type Card, type CardNode } from './card';
import { wallClock } from './schedule';
import { cellText, cellValue, findColumn, type BotTable, type CellValue, type TableRow } from './tables';
import { parseFilter } from './webhook-filter';

/**
 * Dashboards: pages of tiles that bots keep filled and people and bots follow. A dashboard is
 * known by its name across the server, so several bots can put tiles on the same page; each tile
 * belongs to the bot that wrote it. A tile either reads that bot's table (a count, a sum, a chart
 * over time, the latest rows), worked out again each time it is looked at so it never goes stale
 * between the bot's turns, or holds a card the bot wrote for what lives outside its tables.
 * Tiles only show: nothing on a dashboard asks anyone anything.
 */

/** At most this many dashboards on a server and tiles on one dashboard. */
export const MAX_DASHBOARDS = 50;
export const MAX_TILES = 24;
/** Rows a `rows` tile lists, by default and at most. */
export const TILE_ROWS = 8;
export const MAX_TILE_ROWS = 20;
/** Categories a bar chart shows before the rest go into "Other", and groups a chart over time splits into. */
const TOP_CATEGORIES = 12;
const TOP_SERIES = 5;

export const DASHBOARD_PERIODS = ['today', '7d', '30d', '90d', 'month', 'quarter', 'year', 'all'] as const;
export type DashboardPeriod = (typeof DASHBOARD_PERIODS)[number];
export const TILE_SHOWS = ['number', 'bar', 'line', 'area', 'progress', 'rows', 'card'] as const;
export type TileShow = (typeof TILE_SHOWS)[number];
export const TILE_MEASURES = ['count', 'sum', 'avg', 'min', 'max'] as const;
export type TileMeasure = (typeof TILE_MEASURES)[number];
export const TILE_BUCKETS = ['day', 'week', 'month'] as const;
export type TileBucket = (typeof TILE_BUCKETS)[number];

export const DashboardName = z.string().trim().min(1).max(80);
export const TileTitle = z.string().trim().min(1).max(80);

/** What a tile shows and, for all but `card`, which of its bot's rows it reads and how. */
export const TileSpec = z.object({
  title: TileTitle,
  show: z.enum(TILE_SHOWS),
  table: z.string().trim().max(80).optional(),
  filter: z.string().max(2000).optional(),
  period: z.enum(DASHBOARD_PERIODS).optional(),
  dateColumn: z.string().trim().max(60).optional(),
  measure: z.enum(TILE_MEASURES).optional(),
  column: z.string().trim().max(60).optional(),
  groupBy: z.string().trim().max(60).optional(),
  bucket: z.enum(TILE_BUCKETS).optional(),
  goal: z.number().finite().positive().optional(),
  ring: z.boolean().optional(),
  columns: z.array(z.string().trim().max(60)).max(6).optional(),
  limit: z.number().int().min(1).max(MAX_TILE_ROWS).optional(),
  wide: z.boolean().optional(),
});
export type TileSpec = z.infer<typeof TileSpec>;

/** A dashboard in the list: who fills it and when it last changed. */
export interface DashboardSummary {
  id: string;
  name: string;
  /** The bots with a tile on it that the viewer reaches, in the order their first tile stands. */
  botIds: string[];
  tileCount: number;
  updatedAt: string;
}

/** A tile as the viewer sees it: the card worked out for it, or why there is none. */
export interface DashboardTileView {
  id: string;
  botId: string;
  title: string;
  show: TileShow;
  wide: boolean;
  /** When the bot last wrote the tile; a table tile's numbers are as of the moment it was read. */
  updatedAt: string;
  card: Card | null;
  /** Why the tile shows nothing, in the viewer's words: its table is gone, a column was renamed. */
  error: string | null;
}

export interface DashboardView {
  id: string;
  name: string;
  updatedAt: string;
  tiles: DashboardTileView[];
}

/** Words the server gives in the viewer's language, by key; the shared code writes none itself. */
export type DashboardWord =
  | 'dashboard.other'
  | 'dashboard.empty'
  | 'dashboard.noRows'
  | 'dashboard.moreRows'
  | 'dashboard.count'
  | `dashboard.period.${DashboardPeriod}`
  | `dashboard.measure.${Exclude<TileMeasure, 'count'>}`;
export type DashboardSay = (key: DashboardWord, vars?: Record<string, string | number>) => string;

/** Why a tile cannot be kept or worked out, as a message key with what it is about. */
export interface TileProblem {
  key:
    | 'dashboard.problem.noTable'
    | 'dashboard.problem.noColumn'
    | 'dashboard.problem.notNumber'
    | 'dashboard.problem.notDate'
    | 'dashboard.problem.needsColumn'
    | 'dashboard.problem.needsAxis'
    | 'dashboard.problem.needsGoal'
    | 'dashboard.problem.bucketChart'
    | 'dashboard.problem.needsCard'
    | 'dashboard.problem.cardOnly'
    | 'dashboard.problem.notDisplay'
    | 'dashboard.problem.tooBig';
  vars?: Record<string, string>;
}

const columnList = (t: BotTable) => t.columns.map((c) => c.name).join(', ');

/**
 * Whether a tile can be worked out from the table it names: every column it names is there and of
 * a type that fits what it does with it. Checked when the bot writes the tile, so a mistake comes
 * back to the bot at once, and again when it is shown, since the table may have changed since.
 */
export function tileProblem(spec: TileSpec, table: BotTable | undefined): TileProblem | null {
  if (spec.show === 'card') return null;
  if (!table) return { key: 'dashboard.problem.noTable', vars: { table: spec.table ?? '' } };
  const missing = (name: string): TileProblem => ({
    key: 'dashboard.problem.noColumn',
    vars: { column: name, columns: columnList(table) },
  });
  const named = [spec.groupBy, spec.dateColumn, spec.column, ...(spec.columns ?? [])];
  for (const name of named) if (name && !findColumn(table.columns, name)) return missing(name);
  for (const rule of parseFilter(spec.filter ?? '')) {
    const name = rule.path.join('.');
    if (!findColumn(table.columns, name)) return missing(name);
  }
  if (spec.dateColumn && findColumn(table.columns, spec.dateColumn)?.type !== 'date')
    return { key: 'dashboard.problem.notDate', vars: { column: spec.dateColumn } };
  const measure = spec.measure ?? 'count';
  if (measure !== 'count' && spec.show !== 'rows') {
    if (!spec.column) return { key: 'dashboard.problem.needsColumn', vars: { measure } };
    if (findColumn(table.columns, spec.column)?.type !== 'number')
      return { key: 'dashboard.problem.notNumber', vars: { column: spec.column } };
  }
  const chart = spec.show === 'bar' || spec.show === 'line' || spec.show === 'area';
  if (chart && !spec.bucket && !spec.groupBy) return { key: 'dashboard.problem.needsAxis' };
  if (spec.bucket && !chart) return { key: 'dashboard.problem.bucketChart' };
  if (spec.show === 'progress' && !spec.goal) return { key: 'dashboard.problem.needsGoal' };
  return null;
}

/** Components that ask something of the person; a dashboard only shows. */
const ASKING = new Set([
  'Form',
  'Button',
  'Select',
  'RadioGroup',
  'Checkbox',
  'Input',
  'Textarea',
  'DatePicker',
]);

/**
 * The card a bot wrote for a tile, checked as any card is and then held to showing only: nobody
 * answers a dashboard, so a field or a button on it would wait forever.
 */
export function tileCard(input: unknown): { ok: true; card: Card } | { ok: false; problem: TileProblem } {
  if (input === undefined || input === null)
    return { ok: false, problem: { key: 'dashboard.problem.needsCard' } };
  const parsed = parseCard(input);
  if (!parsed.ok)
    return {
      ok: false,
      problem: {
        key: 'dashboard.problem.notDisplay',
        vars: {
          what: `${parsed.error.path}: ${parsed.error.issue}${parsed.error.detail ? ` (${parsed.error.detail})` : ''}`,
        },
      },
    };
  let asking: string | undefined;
  const visit = (n: CardNode) => {
    if (asking) return;
    if (ASKING.has(n.type) || n.onClickAction || n.asForm) asking = n.type;
    for (const c of n.children ?? []) visit(c);
  };
  visit(parsed.card.root);
  if (asking) return { ok: false, problem: { key: 'dashboard.problem.notDisplay', vars: { what: asking } } };
  return parsed;
}

// Days are counted from 1970-01-01 in the server's time zone, so a period never splits a day.
const DAY_MS = 86_400_000;
const dayOf = (ymd: string): number | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(t) ? null : Math.floor(t / DAY_MS);
};
const parts = (day: number) => {
  const d = new Date(day * DAY_MS);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay() };
};
const dayFrom = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m, d) / DAY_MS);

/** The days a period covers, with as many days of the one before it, up to the same point. */
export function periodDays(
  period: DashboardPeriod,
  today: number,
): { from: number; to: number; before: { from: number; to: number } } | null {
  const { y, m } = parts(today);
  const span = (from: number, to: number, prevFrom: number) => ({
    from,
    to,
    before: { from: prevFrom, to: prevFrom + (today - from) },
  });
  switch (period) {
    case 'all':
      return null;
    case 'today':
      return span(today, today, today - 1);
    case '7d':
    case '30d':
    case '90d': {
      const n = Number.parseInt(period, 10);
      return span(today - n + 1, today, today - 2 * n + 1);
    }
    case 'month':
      return span(dayFrom(y, m, 1), dayFrom(y, m + 1, 0), dayFrom(y, m - 1, 1));
    case 'quarter': {
      const q = m - (m % 3);
      return span(dayFrom(y, q, 1), dayFrom(y, q + 3, 0), dayFrom(y, q - 3, 1));
    }
    case 'year':
      return span(dayFrom(y, 0, 1), dayFrom(y, 11, 31), dayFrom(y - 1, 0, 1));
  }
}

/** The first day of the bucket a day falls in: itself, its week's Monday, its month's first. */
function bucketStart(bucket: TileBucket, day: number): number {
  if (bucket === 'day') return day;
  const p = parts(day);
  if (bucket === 'week') return day - ((p.wd + 6) % 7);
  return dayFrom(p.y, p.m, 1);
}
function nextBucket(bucket: TileBucket, start: number): number {
  if (bucket === 'day') return start + 1;
  if (bucket === 'week') return start + 7;
  const p = parts(start);
  return dayFrom(p.y, p.m + 1, 1);
}

function aggregate(measure: TileMeasure, rows: TableRow[], column: string | undefined): number | null {
  if (measure === 'count') return rows.length;
  const values = rows.flatMap((r) => {
    const v = column ? r.values[column] : null;
    return typeof v === 'number' && Number.isFinite(v) ? [v] : [];
  });
  if (measure === 'sum') return values.reduce((a, b) => a + b, 0);
  if (!values.length) return null;
  if (measure === 'avg') return values.reduce((a, b) => a + b, 0) / values.length;
  return measure === 'min' ? Math.min(...values) : Math.max(...values);
}

const round = (n: number) => Math.round(n * 100) / 100;

export interface TileContext {
  now: Date;
  /** The server's time zone: a row written at 01:00 in Istanbul counts on that Istanbul day. */
  timeZone: string;
  locale: string;
  say: DashboardSay;
  /** Words for yes and no in the viewer's language, as a table shows them. */
  yes: string;
  no: string;
}

/**
 * Works a table tile out from its table's rows into a card the apps draw as any other: one number,
 * a chart, a meter or a short list. Rows are filtered as a routine's table filter reads them, with
 * each value written as the column would take it, so `Durum=evet` finds a yes.
 */
export function tableTileCard(
  spec: TileSpec,
  table: BotTable,
  allRows: TableRow[],
  cx: TileContext,
): { ok: true; card: Card } | { ok: false; problem: TileProblem } {
  const problem = tileProblem(spec, table);
  if (problem) return { ok: false, problem };
  const col = (name: string | undefined) => (name ? findColumn(table.columns, name) : undefined);
  const lower = (v: string) => v.toLocaleLowerCase('tr');

  const rules = parseFilter(spec.filter ?? '').map((r) => {
    const c = col(r.path.join('.'))!;
    const fit = r.op === 'eq' || r.op === 'ne' ? cellValue(c.type, r.value) : null;
    return { ...r, column: c.name, want: lower(fit?.ok ? cellText(fit.value) : r.value) };
  });
  let rows = allRows.filter((row) =>
    rules.every((r) => {
      const v = row.values[r.column];
      if (r.op === 'has') return v !== null && v !== undefined && v !== false && v !== '';
      if (r.op === 'contains')
        return [cellText(v), cellText(v, cx.yes, cx.no)].some((x) => lower(x).includes(r.want));
      const same = lower(cellText(v)) === r.want;
      return r.op === 'eq' ? same : !same;
    }),
  );

  // Each row's day: its date column's, or the day it was written, in the server's time zone.
  const dateColumn = col(spec.dateColumn)?.name;
  const written = (iso: string) => {
    const w = wallClock(new Date(iso), cx.timeZone);
    return dayFrom(w.year, w.month - 1, w.day);
  };
  const dayAt = (r: TableRow): number | null => {
    if (!dateColumn) return written(r.createdAt);
    const v = r.values[dateColumn];
    return typeof v === 'string' ? dayOf(v) : null;
  };
  const nowClock = wallClock(cx.now, cx.timeZone);
  const today = dayFrom(nowClock.year, nowClock.month - 1, nowClock.day);
  const period = spec.period ?? 'all';
  const span = periodDays(period, today);
  const within = (from: number, to: number) => (r: TableRow) => {
    const d = dayAt(r);
    return d !== null && d >= from && d <= to;
  };
  const before = span ? rows.filter(within(span.before.from, span.before.to)) : [];
  if (span) rows = rows.filter(within(span.from, span.to));
  const periodWord = period === 'all' ? undefined : cx.say(`dashboard.period.${period}`);

  const measure = spec.measure ?? 'count';
  const column = col(spec.column)?.name;
  const number = new Intl.NumberFormat(cx.locale, { maximumFractionDigits: 2 });
  const shown = (n: number | null) => (n === null ? '—' : number.format(round(n)));
  const what =
    measure === 'count'
      ? cx.say('dashboard.count')
      : cx.say(`dashboard.measure.${measure}`, { column: column ?? '' });

  let root: Record<string, unknown>;
  switch (spec.show) {
    case 'number': {
      const value = aggregate(measure, rows, column);
      const stat: Record<string, unknown> = { type: 'Stat', label: spec.title, value: shown(value) };
      const was = span ? aggregate(measure, before, column) : null;
      if (value !== null && was !== null && was !== 0) {
        const change = ((value - was) / Math.abs(was)) * 100;
        stat.delta = `${change > 0 ? '+' : ''}${number.format(Math.round(change))}%`;
        stat.trend = change > 0.5 ? 'up' : change < -0.5 ? 'down' : 'flat';
      }
      stat.caption = [periodWord, measure === 'count' ? undefined : what].filter(Boolean).join(' · ');
      if (!stat.caption) delete stat.caption;
      root = { type: 'Card', children: [stat] };
      break;
    }
    case 'progress': {
      const value = aggregate(measure, rows, column) ?? 0;
      root = {
        type: 'Card',
        children: [
          {
            type: 'Progress',
            value: round(value),
            max: spec.goal,
            label: spec.title,
            ...(periodWord && { caption: periodWord }),
            variant: spec.ring ? 'ring' : 'bar',
          },
        ],
      };
      break;
    }
    case 'rows': {
      const shownColumns = (
        spec.columns?.length ? spec.columns.map((c) => col(c)!) : table.columns.slice(0, 3)
      ).map((c) => c.name);
      const order = [...rows].sort(
        (a, b) => (dayAt(b) ?? -Infinity) - (dayAt(a) ?? -Infinity) || b.createdAt.localeCompare(a.createdAt),
      );
      const limit = spec.limit ?? TILE_ROWS;
      const text = (r: TableRow, name: string) => {
        const v: CellValue | undefined = r.values[name];
        if (typeof v === 'number') return number.format(v);
        return cellText(v, cx.yes, cx.no);
      };
      const lines = order.slice(0, limit).map((r) => {
        const [first, ...rest] = shownColumns;
        const others = rest.map((n) => text(r, n)).filter(Boolean);
        return {
          type: 'Row',
          gap: 3,
          children: [
            { type: 'Text', value: (first && text(r, first)) || '—', size: 'sm', truncate: true },
            { type: 'Spacer' },
            ...(others.length ? [{ type: 'Caption', value: others.join(' · '), maxLines: 1 }] : []),
          ],
        };
      });
      const more = order.length - lines.length;
      root = {
        type: 'Card',
        children: [
          { type: 'Text', value: spec.title, weight: 'semibold' },
          ...(periodWord ? [{ type: 'Caption', value: periodWord }] : []),
          ...(lines.length
            ? [{ type: 'Col', gap: 2, children: lines }]
            : [{ type: 'Caption', value: cx.say('dashboard.noRows') }]),
          ...(more > 0 ? [{ type: 'Caption', value: cx.say('dashboard.moreRows', { count: more }) }] : []),
        ],
      };
      break;
    }
    default: {
      const type = spec.show as 'bar' | 'line' | 'area';
      const group = col(spec.groupBy)?.name;
      const groupKey = (r: TableRow) => (group ? cellText(r.values[group], cx.yes, cx.no) : '');
      const groupWord = (k: string) => k || cx.say('dashboard.empty');
      // Groups by how much they weigh in the whole period, so the largest keep their own bar or line.
      const ranked = (limit: number) => {
        const by = new Map<string, TableRow[]>();
        for (const r of rows) {
          const k = groupKey(r);
          const list = by.get(k);
          if (list) list.push(r);
          else by.set(k, [r]);
        }
        const order = [...by.entries()].sort(
          (a, b) =>
            (aggregate(measure, b[1], column) ?? -Infinity) - (aggregate(measure, a[1], column) ?? -Infinity),
        );
        if (order.length <= limit) return { top: order.map(([k]) => k), other: false };
        return { top: order.slice(0, limit - 1).map(([k]) => k), other: true };
      };
      const fill = (n: number | null) => (n === null && (measure === 'count' || measure === 'sum') ? 0 : n);
      let data: Record<string, string | number | null>[];
      let series: Record<string, unknown>[];
      if (spec.bucket) {
        const bucket = spec.bucket;
        const days = rows.map(dayAt).filter((d): d is number => d !== null);
        const from = bucketStart(bucket, span ? span.from : days.length ? Math.min(...days) : today);
        const to = span ? Math.min(span.to, Math.max(today, ...days)) : Math.max(today, ...days);
        const starts: number[] = [];
        for (let s = from; s <= to; s = nextBucket(bucket, s)) starts.push(s);
        const kept = starts.slice(-CARD_LIMITS.chartPoints);
        const label = bucketLabel(bucket, cx.locale, kept);
        const inBucket = (s: number) => (r: TableRow) => {
          const d = dayAt(r);
          return d !== null && bucketStart(bucket, d) === s;
        };
        const groups = group ? ranked(TOP_SERIES) : { top: [''], other: false };
        const keys = groups.top.map((_, i) => `s${i}`);
        if (groups.other) keys.push('other');
        data = kept.map((s) => {
          const here = rows.filter(inBucket(s));
          const point: Record<string, string | number | null> = { x: label(s) };
          groups.top.forEach((g, i) => {
            const v = aggregate(measure, group ? here.filter((r) => groupKey(r) === g) : here, column);
            point[`s${i}`] = fill(v === null ? null : round(v));
          });
          if (groups.other) {
            const v = aggregate(
              measure,
              here.filter((r) => !groups.top.includes(groupKey(r))),
              column,
            );
            point.other = fill(v === null ? null : round(v));
          }
          return point;
        });
        const stack = group && type !== 'line' ? 'all' : undefined;
        series = keys.map((key, i) => ({
          type,
          dataKey: key,
          label: key === 'other' ? cx.say('dashboard.other') : group ? groupWord(groups.top[i]!) : what,
          ...(stack && { stack }),
        }));
      } else {
        const groups = ranked(TOP_CATEGORIES);
        data = groups.top.map((g) => {
          const v = aggregate(
            measure,
            rows.filter((r) => groupKey(r) === g),
            column,
          );
          return { x: groupWord(g), v: v === null ? null : round(v) };
        });
        if (groups.other) {
          const v = aggregate(
            measure,
            rows.filter((r) => !groups.top.includes(groupKey(r))),
            column,
          );
          data.push({ x: cx.say('dashboard.other'), v: v === null ? null : round(v) });
        }
        series = [{ type, dataKey: 'v', label: what }];
      }
      if (!data.length)
        data = [{ x: '', ...Object.fromEntries(series.map((s) => [s.dataKey as string, 0])) }];
      root = {
        type: 'Card',
        children: [
          { type: 'Text', value: spec.title, weight: 'semibold' },
          ...(periodWord ? [{ type: 'Caption', value: periodWord }] : []),
          { type: 'Chart', data, series, xAxis: { dataKey: 'x' }, showLegend: series.length > 1 },
        ],
      };
    }
  }
  const parsed = parseCard(root);
  if (!parsed.ok) return { ok: false, problem: { key: 'dashboard.problem.tooBig' } };
  return parsed;
}

/** How a bucket is named on the chart's axis: a day and month, a week by its Monday, a month. */
function bucketLabel(bucket: TileBucket, locale: string, starts: number[]): (start: number) => string {
  const years = new Set(starts.map((s) => parts(s).y));
  const format =
    bucket === 'month'
      ? new Intl.DateTimeFormat(locale, {
          month: 'short',
          ...(years.size > 1 && { year: '2-digit' }),
          timeZone: 'UTC',
        })
      : new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return (s) => format.format(new Date(s * DAY_MS));
}

/** A dashboard as text, for a bot that follows it: each tile's title and what it shows. */
export function dashboardText(view: DashboardView, botName: (id: string) => string): string {
  const lines = [`# ${view.name}`];
  for (const tile of view.tiles) {
    lines.push('', `## ${tile.title} (${botName(tile.botId)})`);
    lines.push(tile.card ? cardText(tile.card) : `⚠ ${tile.error ?? ''}`);
  }
  return lines.join('\n');
}
