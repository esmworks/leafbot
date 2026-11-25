import { z } from 'zod';

/**
 * A bot's tables: records it keeps in rows and columns (leads to follow up, prices it watches,
 * orders it tracks), which the person can read, correct and export. Each table belongs to one bot.
 */

export const TABLE_COLUMN_TYPES = ['text', 'number', 'date', 'bool', 'url'] as const;
export type TableColumnType = (typeof TABLE_COLUMN_TYPES)[number];

/** At most this many tables per bot, columns per table and rows per table. */
export const MAX_TABLES = 20;
export const MAX_COLUMNS = 30;
export const MAX_ROWS = 5000;
/** The longest text a cell holds. */
export const MAX_CELL = 2000;

export const TableName = z.string().trim().min(1).max(80);
export const ColumnName = z
  .string()
  .trim()
  .min(1)
  .max(60)
  .refine((v) => !/[\n\r\t]/.test(v), 'validation.columnName');

export const TableColumn = z.object({ name: ColumnName, type: z.enum(TABLE_COLUMN_TYPES).default('text') });
export type TableColumn = z.infer<typeof TableColumn>;

export type CellValue = string | number | boolean | null;

/**
 * How a table is laid out on screen: the grid of rows and columns, a board with a lane for each
 * value of a column (a status, a stage), a gallery of cards or a plain list. The view belongs to
 * the table, so everyone who opens it, and the bot, sees the same.
 */
export const TABLE_VIEW_KINDS = ['grid', 'board', 'gallery', 'list'] as const;
export type TableViewKind = (typeof TABLE_VIEW_KINDS)[number];

export const TableView = z.object({
  kind: z.enum(TABLE_VIEW_KINDS).default('grid'),
  /** Rows grouped by this column's value; a board's lanes. */
  group: ColumnName.nullable().default(null),
});
export type TableView = z.infer<typeof TableView>;

export const DEFAULT_TABLE_VIEW: TableView = { kind: 'grid', group: null };

export const BotTable = z.object({
  id: z.string(),
  botId: z.string(),
  name: z.string(),
  columns: z.array(TableColumn),
  view: TableView,
  rowCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BotTable = z.infer<typeof BotTable>;

export interface TableRow {
  id: string;
  values: Record<string, CellValue>;
  createdAt: string;
  updatedAt: string;
}

/** A row's values as the person or a bot gives them; each is checked against its column's type. */
export const RowValues = z.record(
  z.string().max(60),
  z.union([z.string(), z.number(), z.boolean(), z.null()]),
);
export type RowValues = z.infer<typeof RowValues>;

/** Why a value does not fit its column, as a message key. */
export type CellProblem =
  'table.badNumber' | 'table.badDate' | 'table.badBool' | 'table.badUrl' | 'table.tooLong';

const YES = new Set(['true', 'yes', 'y', 'evet', 'e', '1', 'on', 'x', '✓']);
const NO = new Set(['false', 'no', 'n', 'hayır', 'h', '0', 'off', '']);

/**
 * A value made to fit its column: a number from "1.250,5" or "1,250.5", a date as YYYY-MM-DD (a
 * time of day kept when given, without a time zone), yes or no in either language, a web address with its scheme. An empty
 * value clears the cell.
 */
export function cellValue(
  type: TableColumnType,
  raw: CellValue | undefined,
): { ok: true; value: CellValue } | { ok: false; problem: CellProblem } {
  if (raw === null || raw === undefined || (typeof raw === 'string' && !raw.trim()))
    return { ok: true, value: null };
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  switch (type) {
    case 'number': {
      if (typeof raw === 'number')
        return Number.isFinite(raw) ? { ok: true, value: raw } : bad('table.badNumber');
      const n = Number(normalNumber(text));
      return Number.isFinite(n) ? { ok: true, value: n } : bad('table.badNumber');
    }
    case 'bool': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const k = text.toLocaleLowerCase('tr');
      if (YES.has(k)) return { ok: true, value: true };
      if (NO.has(k)) return { ok: true, value: false };
      return bad('table.badBool');
    }
    case 'date': {
      // A wall-clock time, as the person reads it: a time zone would make it a moment, which has
      // a different time on each clock, so one is not taken.
      const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?)?$/.exec(text);
      if (!m) return bad('table.badDate');
      const day = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
      if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== `${m[1]}-${m[2]}-${m[3]}`)
        return bad('table.badDate');
      if (!m[4]) return { ok: true, value: `${m[1]}-${m[2]}-${m[3]}` };
      if (Number(m[4]) > 23 || Number(m[5]) > 59) return bad('table.badDate');
      return { ok: true, value: `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}` };
    }
    case 'url': {
      try {
        const url = new URL(text.includes('://') ? text : `https://${text}`);
        if (url.protocol !== 'https:' && url.protocol !== 'http:') return bad('table.badUrl');
        if (!url.hostname.includes('.') && url.hostname !== 'localhost') return bad('table.badUrl');
        return text.length > MAX_CELL ? bad('table.tooLong') : { ok: true, value: url.toString() };
      } catch {
        return bad('table.badUrl');
      }
    }
    default:
      return text.length > MAX_CELL ? bad('table.tooLong') : { ok: true, value: text };
  }
}

const bad = (problem: CellProblem) => ({ ok: false as const, problem });

/**
 * "1.250,5" and "1,250.5" both as 1250.5; a lone separator with three digits after it marks
 * thousands. Spaces (no-break ones too) and apostrophes that group digits are dropped.
 */
function normalNumber(s: string): string {
  const t = s.replace(/[\s']/g, '');
  const comma = t.lastIndexOf(',');
  const dot = t.lastIndexOf('.');
  if (comma >= 0 && dot >= 0) {
    return comma > dot ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  }
  const sep = comma >= 0 ? ',' : dot >= 0 ? '.' : null;
  if (!sep) return t;
  const parts = t.split(sep);
  // "1.250.000" or "1,250": thousands; "12,5" or "3.75": a decimal.
  if (
    parts.length > 2 ||
    (parts.length === 2 && parts[1]!.length === 3 && parts[0] !== '0' && parts[0] !== '-0')
  )
    return parts.join('');
  return parts.join('.');
}

/** A cell as text, for a CSV file or a bot reading the table: yes/no as given, empty as nothing. */
export function cellText(value: CellValue | undefined, yes = 'true', no = 'false'): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? yes : no;
  return String(value);
}

/** The column a name means, ignoring case and spaces at its ends. */
export function findColumn(columns: readonly TableColumn[], name: string): TableColumn | undefined {
  const key = name.trim().toLocaleLowerCase('tr');
  return columns.find((c) => c.name.toLocaleLowerCase('tr') === key);
}

/**
 * The view a table is drawn with: a group column it no longer has is dropped, and a board with
 * nothing to make lanes of falls back to the grid, so a view saved before a change still draws.
 */
export function tableView(table: { columns: readonly TableColumn[]; view?: TableView | null }): TableView {
  const v = table.view ?? DEFAULT_TABLE_VIEW;
  const kind = (TABLE_VIEW_KINDS as readonly string[]).includes(v.kind) ? v.kind : 'grid';
  const group = v.group ? (findColumn(table.columns, v.group)?.name ?? null) : null;
  return { kind: kind === 'board' && !group ? 'grid' : kind, group };
}

/** Rows that share a value in the group column; `key` is that value as text, "" for an empty cell. */
export interface RowGroup {
  key: string;
  value: CellValue;
  rows: TableRow[];
}

/**
 * The rows split by a column's value, in the order each value first appears and with the empty
 * cells last. A yes/no column always has both of its groups, so a board has a lane to move a row
 * into.
 */
export function groupRows(rows: readonly TableRow[], column: TableColumn): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  if (column.type === 'bool') {
    groups.set('true', { key: 'true', value: true, rows: [] });
    groups.set('false', { key: 'false', value: false, rows: [] });
  }
  let empty: RowGroup | null = null;
  for (const r of rows) {
    const value = r.values[column.name] ?? null;
    const key = cellText(value);
    if (!key) {
      empty ??= { key: '', value: null, rows: [] };
      empty.rows.push(r);
      continue;
    }
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { key, value, rows: [] }));
    g.rows.push(r);
  }
  return [...groups.values(), ...(empty ? [empty] : [])];
}
