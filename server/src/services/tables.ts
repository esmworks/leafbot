import {
  cellText,
  cellValue,
  findColumn,
  MAX_COLUMNS,
  MAX_ROWS,
  MAX_TABLES,
  type BotTable,
  type CellValue,
  type RowValues,
  type TableColumn,
  type TableRow,
} from '@leafbot/shared';
import { and, asc, count, eq, inArray } from 'drizzle-orm';
import type { Ctx } from '../context';
import { schema } from '../db';
import { HttpError, isUniqueViolation, newId, notFound } from '../util';
import { csvCell } from './usage';

type TableRowDb = typeof schema.botTables.$inferSelect;
type RowDb = typeof schema.botTableRows.$inferSelect;

const toRow = (r: RowDb): TableRow => ({
  id: r.id,
  values: r.values,
  createdAt: r.createdAt.toISOString(),
  updatedAt: r.updatedAt.toISOString(),
});

/**
 * Bots' tables. A bot defines a table by name with typed columns, then adds, changes and removes
 * rows; the person sees the same tables in the bot's panel and can correct or export them. Every
 * value is checked against its column's type, so a number column only ever holds numbers.
 */
export class TableService {
  constructor(private ctx: Ctx) {}

  private changed(botId: string) {
    this.ctx.bus.refresh({ scope: 'tables', botId });
  }

  async list(botId: string): Promise<BotTable[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.botTables)
      .where(eq(schema.botTables.botId, botId))
      .orderBy(asc(schema.botTables.createdAt));
    if (!rows.length) return [];
    const counts = await this.ctx.db
      .select({ tableId: schema.botTableRows.tableId, n: count() })
      .from(schema.botTableRows)
      .where(
        inArray(
          schema.botTableRows.tableId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(schema.botTableRows.tableId);
    const by = new Map(counts.map((c) => [c.tableId, Number(c.n)]));
    return rows.map((r) => this.toTable(r, by.get(r.id) ?? 0));
  }

  private toTable(r: TableRowDb, rowCount: number): BotTable {
    return {
      id: r.id,
      botId: r.botId,
      name: r.name,
      columns: r.columns,
      rowCount,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  async get(id: string): Promise<BotTable> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.botTables)
      .where(eq(schema.botTables.id, id))
      .limit(1);
    if (!row) throw notFound('table');
    return this.toTable(row, await this.rowCount(id));
  }

  private async rowCount(tableId: string): Promise<number> {
    const [c] = await this.ctx.db
      .select({ n: count() })
      .from(schema.botTableRows)
      .where(eq(schema.botTableRows.tableId, tableId));
    return Number(c?.n ?? 0);
  }

  /** Whether the bot keeps any table at all. */
  async any(botId: string): Promise<boolean> {
    const [row] = await this.ctx.db
      .select({ id: schema.botTables.id })
      .from(schema.botTables)
      .where(eq(schema.botTables.botId, botId))
      .limit(1);
    return !!row;
  }

  /**
   * The bot's table of this name, ignoring case, with the names of all its tables for when there
   * is none. Only the table found has its rows counted.
   */
  async find(botId: string, name: string): Promise<{ found: BotTable | undefined; names: string[] }> {
    const key = name.trim().toLocaleLowerCase('tr');
    const rows = await this.ctx.db
      .select()
      .from(schema.botTables)
      .where(eq(schema.botTables.botId, botId))
      .orderBy(asc(schema.botTables.createdAt));
    const row = rows.find((r) => r.name.toLocaleLowerCase('tr') === key);
    return {
      found: row ? this.toTable(row, await this.rowCount(row.id)) : undefined,
      names: rows.map((r) => r.name),
    };
  }

  /**
   * Makes the table, or adds the columns it does not have yet to one of that name. Columns are
   * never taken away or retyped here, so rows already written keep their meaning.
   */
  async define(
    botId: string,
    name: string,
    columns: TableColumn[],
  ): Promise<{ table: BotTable; added: string[] }> {
    const unique: TableColumn[] = [];
    for (const c of columns)
      if (!findColumn(unique, c.name)) unique.push({ name: c.name.trim(), type: c.type });
    const { found: existing, names } = await this.find(botId, name);
    if (existing) {
      const added = unique.filter((c) => !findColumn(existing.columns, c.name));
      if (!added.length) return { table: existing, added: [] };
      const next = [...existing.columns, ...added];
      if (next.length > MAX_COLUMNS) throw new HttpError(400, 'error.tableColumns');
      await this.ctx.db
        .update(schema.botTables)
        .set({ columns: next, updatedAt: new Date() })
        .where(eq(schema.botTables.id, existing.id));
      this.changed(botId);
      return { table: { ...existing, columns: next }, added: added.map((c) => c.name) };
    }
    if (!unique.length) throw new HttpError(400, 'error.tableNoColumns');
    if (unique.length > MAX_COLUMNS) throw new HttpError(400, 'error.tableColumns');
    if (names.length >= MAX_TABLES) throw new HttpError(400, 'error.tableCount');
    try {
      const [row] = await this.ctx.db
        .insert(schema.botTables)
        .values({ id: newId(), botId, name: name.trim(), columns: unique })
        .returning();
      this.changed(botId);
      return { table: this.toTable(row!, 0), added: unique.map((c) => c.name) };
    } catch (err) {
      if (isUniqueViolation(err)) throw new HttpError(409, 'error.tableExists');
      throw err;
    }
  }

  /** Every row, oldest first. */
  async rows(tableId: string): Promise<TableRow[]> {
    const rows = await this.ctx.db
      .select()
      .from(schema.botTableRows)
      .where(eq(schema.botTableRows.tableId, tableId))
      .orderBy(asc(schema.botTableRows.createdAt), asc(schema.botTableRows.id));
    return rows.map(toRow);
  }

  /**
   * Values checked against the table's columns: names matched ignoring case, each value made to
   * fit its type. An unknown column or a value that does not fit stops the whole write.
   */
  private check(table: BotTable, values: RowValues): Record<string, CellValue> {
    const out: Record<string, CellValue> = {};
    for (const [name, raw] of Object.entries(values)) {
      const column = findColumn(table.columns, name);
      if (!column)
        throw new HttpError(400, 'error.tableNoColumn', {
          column: name,
          columns: table.columns.map((c) => c.name).join(', '),
        });
      const v = cellValue(column.type, raw);
      if (!v.ok) throw new HttpError(400, v.problem, { column: column.name });
      out[column.name] = v.value;
    }
    return out;
  }

  /** `by`: the person adding the rows in the app; null for a bot. */
  async addRows(tableId: string, list: RowValues[], by: string | null = null): Promise<TableRow[]> {
    const table = await this.get(tableId);
    if (table.rowCount + list.length > MAX_ROWS) throw new HttpError(400, 'error.tableRows');
    const checked = list.map((v) => this.check(table, v));
    if (!checked.length) return [];
    // Rows written together keep their order: each a moment after the one before.
    const now = Date.now();
    const rows = await this.ctx.db
      .insert(schema.botTableRows)
      .values(
        checked.map((values, i) => ({
          id: newId(),
          tableId,
          values,
          writtenBy: by,
          createdAt: new Date(now + i),
        })),
      )
      .returning();
    await this.touch(table);
    return rows.map(toRow);
  }

  /**
   * Changes the given cells of a row; the others stay as they were. `by`: the person changing it in
   * the app; null for a bot. The row stays one person's own only while nobody else writes in it.
   */
  async updateRow(
    tableId: string,
    rowId: string,
    values: RowValues,
    by: string | null = null,
  ): Promise<TableRow> {
    const table = await this.get(tableId);
    const [current] = await this.ctx.db
      .select()
      .from(schema.botTableRows)
      .where(and(eq(schema.botTableRows.id, rowId), eq(schema.botTableRows.tableId, tableId)))
      .limit(1);
    if (!current) throw notFound('tableRow');
    const [row] = await this.ctx.db
      .update(schema.botTableRows)
      .set({
        values: { ...current.values, ...this.check(table, values) },
        writtenBy: by !== null && current.writtenBy === by ? by : null,
        updatedAt: new Date(),
      })
      .where(eq(schema.botTableRows.id, rowId))
      .returning();
    await this.touch(table);
    return toRow(row!);
  }

  /** Who alone wrote each of these rows in the app, by row id; rows anyone else wrote in are left out. */
  async writers(rowIds: string[]): Promise<Map<string, string>> {
    if (!rowIds.length) return new Map();
    const rows = await this.ctx.db
      .select({ id: schema.botTableRows.id, by: schema.botTableRows.writtenBy })
      .from(schema.botTableRows)
      .where(inArray(schema.botTableRows.id, rowIds));
    return new Map(rows.flatMap((r) => (r.by ? [[r.id, r.by] as const] : [])));
  }

  /** One row, or null when there is none. */
  async rowById(tableId: string, rowId: string): Promise<TableRow | null> {
    const [row] = await this.ctx.db
      .select()
      .from(schema.botTableRows)
      .where(and(eq(schema.botTableRows.id, rowId), eq(schema.botTableRows.tableId, tableId)))
      .limit(1);
    return row ? toRow(row) : null;
  }

  /**
   * A row's cells set back exactly as they were, with the time they were last changed; for taking
   * a turn back, which must leave the row looking as it did before that turn.
   */
  async putRowBack(tableId: string, rowId: string, values: Record<string, CellValue>, updatedAt: string) {
    const table = await this.get(tableId);
    await this.ctx.db
      .update(schema.botTableRows)
      .set({ values, writtenBy: null, updatedAt: new Date(updatedAt) })
      .where(and(eq(schema.botTableRows.id, rowId), eq(schema.botTableRows.tableId, tableId)));
    await this.touch(table);
  }

  /** A deleted row written again under its own id and dates. */
  async reinsertRow(
    tableId: string,
    row: { id: string; values: Record<string, CellValue>; createdAt: string; updatedAt: string },
  ) {
    const table = await this.get(tableId);
    if (table.rowCount >= MAX_ROWS) throw new HttpError(400, 'error.tableRows');
    await this.ctx.db.insert(schema.botTableRows).values({
      id: row.id,
      tableId,
      values: row.values,
      createdAt: new Date(row.createdAt),
      updatedAt: new Date(row.updatedAt),
    });
    await this.touch(table);
  }

  async deleteRows(tableId: string, ids: string[]): Promise<number> {
    const table = await this.get(tableId);
    if (!ids.length) return 0;
    const gone = await this.ctx.db
      .delete(schema.botTableRows)
      .where(and(eq(schema.botTableRows.tableId, tableId), inArray(schema.botTableRows.id, ids)))
      .returning({ id: schema.botTableRows.id });
    await this.touch(table);
    return gone.length;
  }

  /**
   * The table as a CSV file: a header of column names, then one line per row. Numbers stay plain
   * so a spreadsheet reads them as numbers; the byte-order mark makes it read Turkish letters.
   */
  async csv(tableId: string, yes: string, no: string): Promise<{ name: string; text: string }> {
    const table = await this.get(tableId);
    const lines = [table.columns.map((c) => csvCell(c.name)).join(',')];
    for (const r of await this.rows(tableId)) {
      lines.push(
        table.columns
          .map((c) => {
            const v = r.values[c.name];
            return typeof v === 'number' ? String(v) : csvCell(cellText(v, yes, no));
          })
          .join(','),
      );
    }
    return { name: table.name, text: `\uFEFF${lines.join('\r\n')}\r\n` };
  }

  async remove(tableId: string) {
    const table = await this.get(tableId);
    await this.ctx.db.delete(schema.botTables).where(eq(schema.botTables.id, tableId));
    this.changed(table.botId);
  }

  private async touch(table: BotTable) {
    await this.ctx.db
      .update(schema.botTables)
      .set({ updatedAt: new Date() })
      .where(eq(schema.botTables.id, table.id));
    this.changed(table.botId);
  }
}
