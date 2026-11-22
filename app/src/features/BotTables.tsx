import { INTL_LOCALE, type Bot, type BotTable, type TableColumn, type TableRow } from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronRight, Download, Plus, Search, Table2, Trash2 } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { useLocale, useT } from '@/i18n';
import { api } from '@/lib/api';
import { cellDraft, cellLabel, filterRows, SHOWN_ROWS } from '@/lib/tableView';
import { cn } from '@/lib/utils';

/** The bot's tables in its panel; the section stays out of the way until the bot makes one. */
export function BotTables({ bot }: { bot: Bot }) {
  const t = useT();
  const { data: tables = [] } = useQuery({
    queryKey: ['tables', bot.id],
    queryFn: () => api.botTables(bot.id),
  });
  const [openId, setOpenId] = useState<string | null>(null);
  const open = tables.find((x) => x.id === openId) ?? null;
  if (!tables.length) return null;
  return (
    <section>
      <h4 className="mb-2 text-sm font-semibold">{t('tables.title')}</h4>
      <div className="space-y-2">
        {tables.map((x) => (
          <button
            key={x.id}
            onClick={() => setOpenId(x.id)}
            className="flex w-full items-center gap-3 rounded-2xl bg-secondary/60 px-3 py-2.5 text-start hover:bg-secondary"
          >
            <Table2 className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-medium">{x.name}</span>
              <span className="block truncate text-[13px] text-muted-foreground">
                {t('tables.rows', { count: x.rowCount })}
              </span>
            </span>
            <ChevronRight className="size-4 shrink-0 text-muted-foreground rtl:-scale-x-100" />
          </button>
        ))}
      </div>
      {open && <TableDialog table={open} onClose={() => setOpenId(null)} />}
    </section>
  );
}

type Editing = { rowId: string; column: string } | null;

/** One table: search it, correct a cell in place, add and delete rows, download it, delete it. */
function TableDialog({ table, onClose }: { table: BotTable; onClose(): void }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['table-rows', table.id],
    queryFn: () => api.tableRows(table.id),
  });
  const number = useMemo(() => new Intl.NumberFormat(INTL_LOCALE[locale]), [locale]);
  const yes = t('tables.yes');
  const no = t('tables.no');
  const found = useMemo(
    () =>
      filterRows(rows, search, INTL_LOCALE[locale], (r) =>
        table.columns.map((c) => cellLabel(r.values[c.name], c, number, yes, no)),
      ),
    [rows, search, locale, table.columns, number, yes, no],
  );
  // A long table shows its newest rows, where a row just added lands.
  const shown = found.slice(-SHOWN_ROWS);
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['table-rows', table.id] });
    void qc.invalidateQueries({ queryKey: ['tables', table.botId] });
  };
  const fail = (e: unknown) => toast.error((e as Error).message);
  const save = useMutation({
    mutationFn: (v: { rowId: string; column: string; value: string | boolean }) =>
      api.updateTableRow(table.id, v.rowId, { [v.column]: v.value }),
    onSuccess: refresh,
    onError: fail,
  });
  const add = useMutation({
    mutationFn: () => api.addTableRow(table.id),
    onSuccess: (row) => {
      refresh();
      setSearch('');
      const first = table.columns[0];
      // A yes/no cell flips on a click and has no edit box to start in.
      if (first && first.type !== 'bool') setEditing({ rowId: row.id, column: first.name });
    },
    onError: fail,
  });
  const removeRow = useMutation({
    mutationFn: (rowId: string) => api.deleteTableRow(table.id, rowId),
    onSuccess: refresh,
    onError: fail,
  });
  const removeTable = useMutation({
    mutationFn: () => api.removeTable(table.id),
    onSuccess: () => {
      onClose();
      void qc.invalidateQueries({ queryKey: ['tables', table.botId] });
    },
    onError: fail,
  });

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent
        // Escape in a cell's edit box leaves the cell, not the table.
        onEscapeKeyDown={(e) => (e.target as HTMLElement | null)?.dataset?.cellEditor && e.preventDefault()}
        className="screen-edges flex h-[min(720px,90vh)] flex-col gap-3 overflow-hidden rounded-3xl sm:max-w-5xl phone:h-dvh phone:max-h-none phone:max-w-full phone:rounded-none"
      >
        <DialogHeader>
          <DialogTitle>{table.name}</DialogTitle>
          <DialogDescription>{t('tables.hint')}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-40 flex-1">
            <Search className="absolute top-1/2 start-3 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('tables.search')}
              aria-label={t('tables.search')}
              className="h-9 rounded-full ps-9"
            />
          </div>
          <Button size="sm" variant="secondary" disabled={add.isPending} onClick={() => add.mutate()}>
            <Plus /> {t('tables.addRow')}
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a href={api.tableCsvUrl(table.id)} download>
              <Download /> {t('tables.download')}
            </a>
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            disabled={removeTable.isPending}
            onClick={() => confirm(t('tables.deleteConfirm', { name: table.name })) && removeTable.mutate()}
          >
            <Trash2 /> {t('tables.delete')}
          </Button>
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-auto rounded-2xl border">
          <table className="w-full border-collapse text-sm">
            <thead className="sticky top-0 z-10 bg-background">
              <tr className="border-b">
                {table.columns.map((c) => (
                  <th key={c.name} className="px-3 py-2 text-start font-medium whitespace-nowrap">
                    {c.name}
                    <span className="ms-1.5 text-xs font-normal text-muted-foreground">
                      {t(`tables.type.${c.type}`)}
                    </span>
                  </th>
                ))}
                <th className="w-10" aria-label={t('tables.actions')} />
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="group border-b last:border-b-0 hover:bg-accent/40">
                  {table.columns.map((c) => (
                    <Cell
                      key={c.name}
                      row={r}
                      column={c}
                      label={cellLabel(r.values[c.name], c, number, yes, no)}
                      editing={editing?.rowId === r.id && editing.column === c.name}
                      onEdit={() => setEditing({ rowId: r.id, column: c.name })}
                      onDone={(value) => {
                        setEditing(null);
                        if (value !== undefined) save.mutate({ rowId: r.id, column: c.name, value });
                      }}
                    />
                  ))}
                  <td className="px-1 text-end">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-8 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
                      aria-label={t('tables.deleteRow')}
                      onClick={() => removeRow.mutate(r.id)}
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!isLoading && !found.length && (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              {rows.length ? t('tables.noMatch') : t('tables.empty')}
            </p>
          )}
        </div>
        {found.length > SHOWN_ROWS && (
          <p className="text-xs text-muted-foreground">
            {t('tables.more', { shown: SHOWN_ROWS, total: found.length })}
          </p>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A cell: a yes/no flips on a click; any other opens an edit box that saves on Enter or on leaving
 * it, and Escape leaves it as it was. `onDone` gets nothing when there is nothing to save.
 */
function Cell({
  row,
  column,
  label,
  editing,
  onEdit,
  onDone,
}: {
  row: TableRow;
  column: TableColumn;
  label: string;
  editing: boolean;
  onEdit(): void;
  onDone(value?: string | boolean): void;
}) {
  const t = useT();
  const value = row.values[column.name];
  const start = cellDraft(value);
  const [draft, setDraft] = useState(start);
  // Escape ends the edit; the blur that follows must not save it.
  const dropped = useRef(false);
  if (column.type === 'bool') {
    return (
      <td className="px-3 py-1.5">
        <button
          onClick={() => onDone(value !== true)}
          className={cn('rounded-lg px-1.5 py-0.5 hover:bg-accent', !label && 'text-muted-foreground')}
          aria-label={t('tables.toggle', { column: column.name })}
        >
          {label || '—'}
        </button>
      </td>
    );
  }
  if (editing) {
    return (
      <td className="px-1.5 py-1">
        <Input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => e.target.select()}
          placeholder={column.type === 'date' ? t('tables.datePlaceholder') : undefined}
          aria-label={column.name}
          data-cell-editor
          className="h-8 min-w-32 rounded-lg"
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              dropped.current = true;
              onDone();
            }
          }}
          onBlur={() => {
            if (dropped.current) return;
            onDone(draft === start ? undefined : draft);
          }}
        />
      </td>
    );
  }
  return (
    <td
      className="max-w-72 cursor-text truncate px-3 py-1.5"
      title={label}
      onClick={() => {
        dropped.current = false;
        setDraft(start);
        onEdit();
      }}
    >
      {column.type === 'url' && typeof value === 'string' ? (
        <a
          href={value}
          target="_blank"
          rel="noreferrer"
          className="text-primary underline-offset-2 hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          {label}
        </a>
      ) : (
        label
      )}
    </td>
  );
}
