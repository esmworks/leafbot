import { INTL_LOCALE, type TableColumn, type TableRow } from '@leafbot/shared';
import { cellDraft, cellLabel, filterRows, SHOWN_ROWS } from '@leafbot/app/src/lib/tableView';
import Feather from '@expo/vector-icons/Feather';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { askText, confirm, toastError } from '@/components/overlay';
import { back, Empty, IconButton, Loading, Page, PillButton, Sheet } from '@/components/page';
import { locale, t } from '@/i18n';
import { useBotTables, useTableRows } from '@/lib/queries';
import { useApi, useServer } from '@/lib/server';
import { useColors } from '@/lib/theme';

/**
 * One of a bot's tables: search it, correct a cell, add and delete rows, delete the table. Each
 * row is a card of its cells, as a grid of many columns does not fit a phone's width.
 */
export default function Screen() {
  const { botId, tableId } = useLocalSearchParams<{ botId: string; tableId: string }>();
  const c = useColors();
  const api = useApi();
  const qc = useQueryClient();
  const { origin } = useServer();
  const { data: tables, isLoading: tablesLoading } = useBotTables(botId);
  const table = tables?.find((x) => x.id === tableId);
  const { data: rows = [], isLoading } = useTableRows(tableId);
  const [search, setSearch] = useState('');
  const [menu, setMenu] = useState(false);
  const number = useMemo(() => new Intl.NumberFormat(INTL_LOCALE[locale]), []);
  const yes = t('tables.yes');
  const no = t('tables.no');
  const columns = useMemo(() => table?.columns ?? [], [table]);
  const found = useMemo(
    () =>
      filterRows(rows, search, INTL_LOCALE[locale], (r) =>
        columns.map((col) => cellLabel(r.values[col.name], col, number, yes, no)),
      ),
    [rows, search, columns, number, yes, no],
  );
  // A long table shows its newest rows, where a row just added lands; the newest first on a phone.
  const shown = found.slice(-SHOWN_ROWS).reverse();
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['table-rows', origin, tableId] });
    void qc.invalidateQueries({ queryKey: ['tables', origin, botId] });
  };
  const save = useMutation({
    mutationFn: (v: { rowId: string; column: string; value: string | boolean }) =>
      api.updateTableRow(tableId, v.rowId, { [v.column]: v.value }),
    onSuccess: refresh,
    onError: toastError,
  });
  const add = useMutation({
    mutationFn: () => api.addTableRow(tableId),
    onSuccess: () => {
      setSearch('');
      refresh();
    },
    onError: toastError,
  });
  const removeRow = useMutation({
    mutationFn: (rowId: string) => api.deleteTableRow(tableId, rowId),
    onSuccess: refresh,
    onError: toastError,
  });
  const removeTable = useMutation({
    mutationFn: () => api.removeTable(tableId),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['tables', origin, botId] });
      back();
    },
    onError: toastError,
  });

  const edit = async (row: TableRow, col: TableColumn) => {
    const value = row.values[col.name];
    // A yes/no cell flips on a tap and has no box to type in.
    if (col.type === 'bool') return save.mutate({ rowId: row.id, column: col.name, value: value !== true });
    const next = await askText({
      title: col.name,
      initial: cellDraft(value),
      placeholder: col.type === 'date' ? t('tables.datePlaceholder') : undefined,
      multiline: col.type === 'text',
      confirmLabel: t('common.save'),
    });
    if (next === null || next === cellDraft(value)) return;
    save.mutate({ rowId: row.id, column: col.name, value: next });
  };

  if (tablesLoading) {
    return (
      <Page title="">
        <Loading />
      </Page>
    );
  }
  if (!table) {
    return (
      <Page title="">
        <Empty icon="alert-circle" text={t('tables.empty')} />
      </Page>
    );
  }
  return (
    <Page
      title={table.name}
      right={<IconButton icon="more-horizontal" label={t('tables.actions')} onPress={() => setMenu(true)} />}
    >
      <Text style={[styles.hint, { color: c.mutedForeground }]}>{t('tables.phoneHint')}</Text>
      <View style={styles.bar}>
        <View style={[styles.search, { backgroundColor: c.card, borderColor: c.border }]}>
          <Feather name="search" size={18} color={c.mutedForeground} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder={t('tables.search')}
            placeholderTextColor={c.mutedForeground}
            accessibilityLabel={t('tables.search')}
            style={[styles.searchInput, { color: c.foreground }]}
            autoCorrect={false}
          />
        </View>
        <PillButton
          icon="plus"
          label={t('tables.addRow')}
          busy={add.isPending}
          size="large"
          onPress={() => add.mutate()}
        />
      </View>
      {isLoading ? (
        <Loading />
      ) : !rows.length ? (
        <Empty icon="grid" text={t('tables.empty')} />
      ) : !found.length ? (
        <Empty icon="search" text={t('tables.noMatch')} />
      ) : (
        <View style={styles.list}>
          {found.length > SHOWN_ROWS ? (
            <Text style={[styles.hint, { color: c.mutedForeground }]}>
              {t('tables.more', { shown: SHOWN_ROWS, total: found.length })}
            </Text>
          ) : null}
          {shown.map((row) => (
            <View key={row.id} style={[styles.card, { backgroundColor: c.card, borderColor: c.border }]}>
              {columns.map((col) => {
                const label = cellLabel(row.values[col.name], col, number, yes, no);
                return (
                  <Pressable
                    key={col.name}
                    accessibilityRole="button"
                    accessibilityLabel={
                      col.type === 'bool' ? t('tables.toggle', { column: col.name }) : `${col.name}: ${label}`
                    }
                    onPress={() => void edit(row, col)}
                    style={({ pressed }) => [styles.cell, pressed && { backgroundColor: c.accent }]}
                  >
                    <Text style={[styles.column, { color: c.mutedForeground }]} numberOfLines={1}>
                      {col.name}
                    </Text>
                    <Text style={[styles.value, { color: c.foreground }]}>{label}</Text>
                  </Pressable>
                );
              })}
              <View style={styles.rowEnd}>
                <PillButton
                  icon="trash-2"
                  label={t('tables.deleteRow')}
                  variant="ghost"
                  disabled={removeRow.isPending}
                  onPress={() => removeRow.mutate(row.id)}
                />
              </View>
            </View>
          ))}
        </View>
      )}
      <Sheet
        open={menu}
        onClose={() => setMenu(false)}
        title={table.name}
        items={[
          {
            icon: 'trash-2',
            label: t('tables.delete'),
            destructive: true,
            onPress: () =>
              void confirm({
                title: t('tables.deleteConfirm', { name: table.name }),
                confirmLabel: t('common.delete'),
                destructive: true,
              }).then((ok) => ok && removeTable.mutate()),
          },
        ]}
      />
    </Page>
  );
}

const styles = StyleSheet.create({
  hint: { fontSize: 15, lineHeight: 20 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  search: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    height: 44,
    borderRadius: 22,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 14,
  },
  searchInput: { flex: 1, fontSize: 16 },
  list: { gap: 10 },
  card: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', paddingVertical: 4 },
  cell: { paddingHorizontal: 14, paddingVertical: 8, gap: 2 },
  column: { fontSize: 13 },
  value: { fontSize: 16, lineHeight: 22, minHeight: 22 },
  rowEnd: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 8 },
});
