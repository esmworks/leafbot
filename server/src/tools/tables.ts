import {
  cellText,
  cellValue,
  findColumn,
  MAX_COLUMNS,
  RowValues,
  TableColumn,
  TableName,
  TableView,
  type BotTable,
  type TableRow,
} from '@leafbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import type { ChangeNote } from '../services/turn-changes';
import type { Define } from './index';

/** Rows a bot reads in one call, at most. */
const PAGE = 200;

/**
 * A bot's tables, for the bot: define one with typed columns, read its rows (filtered and in
 * pages), add, change and delete rows. A bot reaches only its own tables; the person sees them in
 * the bot's panel. Deleting a whole table is left to the person.
 */
export function tableTools(opts: {
  def: Define;
  services: Services;
  botId: string;
  t: T;
  /** Puts a change into the journal that takes the turn back. */
  note: (c: ChangeNote) => Promise<void>;
  /** False for a bot with no table yet: it gets only what starts one, not six tools every turn. */
  hasTables: boolean;
}): AppTool[] {
  const { def, services: s, botId, t, note } = opts;
  const yes = t('tool.tableYes');
  const no = t('tool.tableNo');
  /** The bot's table by name, or the reason it has none, listing those it has. */
  const table = async (name: string): Promise<BotTable | string> => {
    const { found, names } = await s.tables.find(botId, name);
    if (found) return found;
    return names.length
      ? t('tool.tableMissing', { table: name, tables: names.join(', ') })
      : t('tool.tablesNone');
  };
  const columnsLine = (x: BotTable) =>
    x.columns.map((c) => `${c.name} (${t(`tool.tableType.${c.type}`)})`).join(', ');
  /** What a row is called in the list of a turn's changes: its table and its first cell. */
  const rowLabel = (x: BotTable, r: TableRow) => {
    const first = x.columns[0];
    return `${x.name}: ${first ? cellText(r.values[first.name], yes, no) || r.id : r.id}`;
  };
  const rowLine = (x: BotTable, r: TableRow) =>
    `- [${r.id}] ${x.columns
      .map((c) => `${c.name}: ${cellText(r.values[c.name], yes, no) || '—'}`)
      .join(' · ')}`;

  const tools = [
    def(
      'tables_list',
      {},
      async () => {
        const all = await s.tables.list(botId);
        if (!all.length) return t('tool.tablesNone');
        return all
          .map((x) => `- ${x.name}: ${t('tool.tableRowCount', { count: x.rowCount })} · ${columnsLine(x)}`)
          .join('\n');
      },
      'read',
    ),
    def(
      'table_define',
      {
        name: TableName,
        columns: z.array(TableColumn).min(1).max(MAX_COLUMNS),
        view: TableView.optional(),
      },
      async ({ name, columns, view }) => {
        const { table: x, added } = await s.tables.define(botId, name, columns);
        const said = added.length
          ? t('tool.tableDefined', { table: x.name, columns: columnsLine(x) })
          : t('tool.tableUnchanged', { table: x.name, columns: columnsLine(x) });
        if (!view) return said;
        const v = (await s.tables.setView(x.id, view)).view;
        return `${said}\n${t('tool.tableView', { view: t(`tool.tableViewKind.${v.kind}`), group: v.group ?? '—' })}`;
      },
      'internal',
    ),
    def(
      'table_rows',
      {
        table: z.string(),
        where: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
        search: z.string().max(200).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(PAGE).optional(),
      },
      async (a) => {
        const x = await table(a.table);
        if (typeof x === 'string') return x;
        let rows = await s.tables.rows(x.id);
        for (const [name, wanted] of Object.entries(a.where ?? {})) {
          const column = findColumn(x.columns, name);
          if (!column)
            return t('error.tableNoColumn', {
              column: name,
              columns: x.columns.map((c) => c.name).join(', '),
            });
          // "evet", "1.250,5" or a date match as they would be written into the column.
          const fit = cellValue(column.type, wanted);
          const key = cellText(fit.ok ? fit.value : wanted).toLocaleLowerCase('tr');
          rows = rows.filter((r) => cellText(r.values[column.name]).toLocaleLowerCase('tr') === key);
        }
        const search = a.search?.trim().toLocaleLowerCase('tr');
        if (search) {
          // As stored or in words, so "evet" finds a yes as "true" does.
          rows = rows.filter((r) =>
            Object.values(r.values).some((v) =>
              [cellText(v), cellText(v, yes, no)].some((x) => x.toLocaleLowerCase('tr').includes(search)),
            ),
          );
        }
        if (!rows.length) return t('tool.tableNoRows', { table: x.name });
        const offset = a.offset ?? 0;
        const page = rows.slice(offset, offset + (a.limit ?? 50));
        const more = rows.length - offset - page.length;
        return [
          t('tool.tableRowsHeader', { table: x.name, shown: page.length, total: rows.length }),
          ...page.map((r) => rowLine(x, r)),
          ...(more > 0 ? [t('tool.tableMore', { count: more, offset: offset + page.length })] : []),
        ].join('\n');
      },
      'read',
    ),
    def(
      'table_add',
      { table: z.string(), rows: z.array(RowValues).min(1).max(100) },
      async (a) => {
        const x = await table(a.table);
        if (typeof x === 'string') return x;
        const added = await s.tables.addRows(x.id, a.rows);
        for (const r of added) {
          await note({
            kind: 'table_row',
            op: 'create',
            targetId: r.id,
            label: rowLabel(x, r),
            after: { tableId: x.id, updatedAt: r.updatedAt },
          });
        }
        return t('tool.tableAdded', {
          table: x.name,
          count: added.length,
          ids: added.map((r) => r.id).join(', '),
        });
      },
      'internal',
    ),
    def(
      'table_update',
      { table: z.string(), id: z.string(), values: RowValues },
      async (a) => {
        const x = await table(a.table);
        if (typeof x === 'string') return x;
        const prev = await s.tables.rowById(x.id, a.id);
        const row = await s.tables.updateRow(x.id, a.id, a.values);
        if (prev) {
          await note({
            kind: 'table_row',
            op: 'update',
            targetId: row.id,
            label: rowLabel(x, row),
            before: {
              tableId: x.id,
              values: prev.values,
              updatedAt: prev.updatedAt,
              createdAt: prev.createdAt,
            },
            after: { tableId: x.id, updatedAt: row.updatedAt },
          });
        }
        return `${t('tool.tableUpdated', { table: x.name })}\n${rowLine(x, row)}`;
      },
      'internal',
    ),
    def(
      'table_delete_rows',
      { table: z.string(), ids: z.array(z.string()).min(1).max(200) },
      async (a) => {
        const x = await table(a.table);
        if (typeof x === 'string') return x;
        const prev = (await Promise.all(a.ids.map((id) => s.tables.rowById(x.id, id)))).filter(
          (r): r is TableRow => !!r,
        );
        const n = await s.tables.deleteRows(x.id, a.ids);
        for (const r of prev) {
          await note({
            kind: 'table_row',
            op: 'delete',
            targetId: r.id,
            label: rowLabel(x, r),
            before: { tableId: x.id, values: r.values, updatedAt: r.updatedAt, createdAt: r.createdAt },
          });
        }
        return t('tool.tableDeleted', { table: x.name, count: n });
      },
      'internal',
    ),
  ];
  // A bot with no table yet can start one and fill it in the same turn; the rest come with it.
  return opts.hasTables ? tools : tools.filter((x) => x.name === 'table_define' || x.name === 'table_add');
}
