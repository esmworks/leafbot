import {
  findColumn,
  groupRows,
  INTL_LOCALE,
  TABLE_VIEW_KINDS,
  tableView,
  type Bot,
  type BotTable,
  type RowGroup,
  type TableColumn,
  type TableRow,
  type TableView,
  type TableViewKind,
} from '@leafbot/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  Columns3,
  Download,
  LayoutGrid,
  List,
  Plus,
  Search,
  Table2,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
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

const VIEW_ICONS: Record<TableViewKind, LucideIcon> = {
  grid: Table2,
  board: Columns3,
  gallery: LayoutGrid,
  list: List,
};

/** The choice of no grouping: a select item needs a value, and no column name is blank. */
const NO_GROUP = ' ';

/** The column a board takes its lanes from when none is chosen: a status-like text or yes/no column. */
const laneColumn = (columns: readonly TableColumn[]) =>
  columns.find((c) => c.type === 'text' || c.type === 'bool') ?? columns[0];

/**
 * One table: search it, correct a cell in place, add and delete rows, download it, delete it, and
 * lay it out as a grid, a board, a gallery or a list, grouped by a column.
 */
function TableDialog({ table, onClose }: { table: BotTable; onClose(): void }) {
  const t = useT();
  const locale = useLocale((s) => s.locale);
  const qc = useQueryClient();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<Editing>(null);
  // A view just chosen shows at once; the saved one takes over once the table comes back with it.
  const [chosen, setChosen] = useState<TableView | null>(null);
  const saved = tableView(table);
  const view = chosen ?? saved;
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
  const group = view.group ? findColumn(table.columns, view.group) : undefined;
  const groups: RowGroup[] = group ? groupRows(shown, group) : [{ key: '', value: null, rows: shown }];
  // Only a board keeps a lane with nothing in it, to move a row into.
  const filled = groups.filter((g) => g.rows.length);
  const groupLabel = (g: RowGroup) =>
    g.key && group ? cellLabel(g.value, group, number, yes, no) : t('tables.noValue');
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
  const saveView = useMutation({
    mutationFn: (v: TableView) => api.setTableView(table.id, v),
    onSuccess: (next) => {
      qc.setQueryData<BotTable[]>(['tables', table.botId], (list) =>
        list?.map((x) => (x.id === next.id ? { ...x, view: next.view } : x)),
      );
      setChosen(null);
    },
    onError: (e) => {
      setChosen(null);
      fail(e);
    },
  });
  const choose = (next: TableView) => {
    const v = tableView({ columns: table.columns, view: next });
    setChosen(v);
    saveView.mutate(v);
  };
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

  const cell = (r: TableRow, c: TableColumn, as: 'td' | 'div' = 'td') => (
    <Cell
      key={c.name}
      as={as}
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
  );
  const deleteButton = (r: TableRow) => (
    <Button
      size="icon"
      variant="ghost"
      className="size-8 shrink-0 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      aria-label={t('tables.deleteRow')}
      onClick={() => removeRow.mutate(r.id)}
    >
      <Trash2 className="size-4" />
    </Button>
  );
  const [title, ...rest] = table.columns;
  /** A row as a card: its first column as the title, then every other column, each editable. */
  const card = (r: TableRow, extra?: { draggable: boolean }) => (
    <div
      key={r.id}
      draggable={extra?.draggable}
      onDragStart={(e) => e.dataTransfer.setData('text/plain', r.id)}
      className={cn(
        'group rounded-2xl border bg-background p-2 text-sm',
        extra?.draggable && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <div className="flex items-start gap-1 font-medium">
        {title && cell(r, title, 'div')}
        {deleteButton(r)}
      </div>
      {rest.map((c) => (
        <div key={c.name} className="flex items-baseline gap-2">
          <span className="w-24 shrink-0 truncate ps-1.5 text-xs text-muted-foreground">{c.name}</span>
          {cell(r, c, 'div')}
        </div>
      ))}
    </div>
  );
  const heading = (g: RowGroup, className?: string) => (
    <div className={cn('flex items-center gap-2 text-xs font-medium text-muted-foreground', className)}>
      <span className="truncate">{groupLabel(g)}</span>
      <span>{g.rows.length}</span>
    </div>
  );
  /** Rows split under their group's heading; one unnamed group when the table is not grouped. */
  const grouped = (body: (rows: TableRow[]) => ReactNode) =>
    filled.map((g) => (
      <div key={g.key} className="space-y-2">
        {group && heading(g, 'px-1 pt-1')}
        {body(g.rows)}
      </div>
    ));

  let content: ReactNode;
  if (view.kind === 'board' && group) {
    content = (
      <div className="flex h-full gap-3 p-2">
        {groups.map((g) => (
          <div
            key={g.key}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const id = e.dataTransfer.getData('text/plain');
              const row = rows.find((r) => r.id === id);
              if (!row || groupRows([row], group)[0]?.key === g.key) return;
              const value = g.value === null ? '' : typeof g.value === 'boolean' ? g.value : String(g.value);
              save.mutate({ rowId: id, column: group.name, value });
            }}
            className="flex w-72 shrink-0 flex-col gap-2 rounded-2xl bg-secondary/50 p-2"
          >
            {heading(g, 'px-1')}
            <div className="scroll-thin min-h-0 flex-1 space-y-2 overflow-y-auto">
              {g.rows.map((r) => card(r, { draggable: true }))}
            </div>
          </div>
        ))}
      </div>
    );
  } else if (view.kind === 'gallery') {
    content = (
      <div className="space-y-4 p-2">
        {grouped((list) => (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">{list.map((r) => card(r))}</div>
        ))}
      </div>
    );
  } else if (view.kind === 'list') {
    content = (
      <div className="space-y-3 p-2">
        {grouped((list) => (
          <div className="divide-y rounded-2xl border">
            {list.map((r) => (
              <div key={r.id} className="group flex items-center gap-3 px-2 py-1 text-sm">
                <div className="min-w-0 basis-1/3 font-medium">{title && cell(r, title, 'div')}</div>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {rest
                    // A yes reads as its column's name, as a bare "Yes" says nothing in a line.
                    .map((c) =>
                      c.type === 'bool'
                        ? r.values[c.name] === true
                          ? c.name
                          : ''
                        : cellLabel(r.values[c.name], c, number, yes, no),
                    )
                    .filter(Boolean)
                    .join(' · ')}
                </span>
                {deleteButton(r)}
              </div>
            ))}
          </div>
        ))}
      </div>
    );
  } else {
    content = (
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
        {filled.map((g) => (
          <tbody key={g.key}>
            {group && (
              <tr className="border-b bg-secondary/50">
                <td colSpan={table.columns.length + 1} className="px-3 py-1.5">
                  {heading(g)}
                </td>
              </tr>
            )}
            {g.rows.map((r) => (
              <tr key={r.id} className="group border-b last:border-b-0 hover:bg-accent/40">
                {table.columns.map((c) => cell(r, c))}
                <td className="px-1 text-end">{deleteButton(r)}</td>
              </tr>
            ))}
          </tbody>
        ))}
      </table>
    );
  }

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
        <div className="flex flex-wrap items-center gap-2">
          <div
            role="radiogroup"
            aria-label={t('tables.view')}
            className="flex rounded-full bg-secondary/60 p-0.5"
          >
            {TABLE_VIEW_KINDS.map((kind) => {
              const Icon = VIEW_ICONS[kind];
              const on = view.kind === kind;
              return (
                <button
                  key={kind}
                  role="radio"
                  aria-checked={on}
                  onClick={() =>
                    !on &&
                    choose({
                      kind,
                      group:
                        kind === 'board'
                          ? (view.group ?? laneColumn(table.columns)?.name ?? null)
                          : view.group,
                    })
                  }
                  className={cn(
                    'flex items-center gap-1.5 rounded-full px-3 py-1 text-sm',
                    on
                      ? 'bg-background font-medium shadow-sm'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  {t(`tables.view.${kind}`)}
                </button>
              );
            })}
          </div>
          <Select
            value={view.group ?? NO_GROUP}
            onValueChange={(v) => choose({ kind: view.kind, group: v === NO_GROUP ? null : v })}
          >
            <SelectTrigger className="h-8 w-48 rounded-full" aria-label={t('tables.groupBy')}>
              <SelectValue placeholder={t('tables.noGroup')} />
            </SelectTrigger>
            <SelectContent>
              {view.kind !== 'board' && <SelectItem value={NO_GROUP}>{t('tables.noGroup')}</SelectItem>}
              {table.columns.map((c) => (
                <SelectItem key={c.name} value={c.name}>
                  {t('tables.groupByColumn', { column: c.name })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {view.kind === 'board' && group && (
            <span className="text-xs text-muted-foreground">
              {t('tables.boardHint', { column: group.name })}
            </span>
          )}
        </div>
        <div className="scroll-thin min-h-0 flex-1 overflow-auto rounded-2xl border">
          {content}
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
 * it, and Escape leaves it as it was. `onDone` gets nothing when there is nothing to save. `as`:
 * a grid's cell, or a field on a card.
 */
function Cell({
  as: Wrap = 'td',
  row,
  column,
  label,
  editing,
  onEdit,
  onDone,
}: {
  as?: 'td' | 'div';
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
  const field = Wrap === 'div' && 'min-w-0 flex-1';
  if (column.type === 'bool') {
    return (
      <Wrap className={cn('px-3 py-1.5', field, Wrap === 'div' && 'px-0 py-0.5')}>
        <button
          onClick={() => onDone(value !== true)}
          className={cn('rounded-lg px-1.5 py-0.5 hover:bg-accent', !label && 'text-muted-foreground')}
          aria-label={t('tables.toggle', { column: column.name })}
        >
          {label || '—'}
        </button>
      </Wrap>
    );
  }
  if (editing) {
    return (
      <Wrap className={cn('px-1.5 py-1', field, Wrap === 'div' && 'px-0')}>
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
      </Wrap>
    );
  }
  return (
    <Wrap
      className={cn(
        'cursor-text truncate',
        Wrap === 'td' ? 'max-w-72 px-3 py-1.5' : 'min-h-7 rounded-lg px-1.5 py-1 hover:bg-accent',
        field,
      )}
      title={label}
      tabIndex={Wrap === 'div' ? 0 : undefined}
      onKeyDown={
        Wrap === 'div'
          ? (e) => {
              if (e.key !== 'Enter' || e.target !== e.currentTarget) return;
              dropped.current = false;
              setDraft(start);
              onEdit();
            }
          : undefined
      }
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
        label || (Wrap === 'div' ? <span className="text-muted-foreground">—</span> : null)
      )}
    </Wrap>
  );
}
