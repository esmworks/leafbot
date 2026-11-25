import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cellAt, columnName, readWorkbook, serialToMs, WORKBOOK_LIMITS } from './xlsx';

/**
 * openpyxl.xlsx was saved by openpyxl, which the bots' computers write spreadsheets with: inline
 * strings, a formula with no saved result, dates, a sparse row and a hidden sheet.
 * streamed.xlsx is Excel's own layout (shared strings with rich text and phonetic guides, custom
 * number formats, the 1904 date system, an absolute part path) zipped by Python's zipfile to a
 * stream, so the sizes before each part's data are zero and only the directory at the end has them.
 */
const fixture = (name: string) =>
  new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name)));

describe('reading a workbook', () => {
  it('reads what openpyxl writes', async () => {
    const sheets = await readWorkbook(fixture('openpyxl.xlsx'));
    // The hidden sheet stays hidden, as in Excel.
    expect(sheets.map((s) => s.name)).toEqual(['Plan', 'İkinci sayfa']);
    const plan = sheets[0]!;
    expect(plan.cut).toBe(false);
    expect(plan.rows).toEqual([
      ['Firma', 'Tarih', 'Tutar', 'Oran', ''],
      ['Dere Mutfak', '2026-11-25', '88.2', '37.5%', ''],
      ['', '', '', '', ''],
      ['', '', '1500', '', ''],
      ['Toplam', '', '=SUM(C2:C4)', '', ''],
      ['', '2026-11-25 17:10', '', '', '09:30'],
      ['TRUE', '', '', '', ''],
    ]);
    expect(sheets[1]!.rows).toEqual([['Özdemir', 'çğıöşü']]);
  });

  it('reads Excel’s layout from a streamed zip', async () => {
    const [sheet, ...rest] = await readWorkbook(fixture('streamed.xlsx'));
    expect(rest).toEqual([]);
    expect(sheet!.name).toBe('Teklifler');
    expect(sheet!.rows).toEqual([
      // Phonetic guides are left out; rich text runs are joined.
      ['Müşteri', '', '東京', '', '', ''],
      ['', '', '', '', '', ''],
      // 1904 dates; a money format that is not a date leaves the number as it is.
      ['Vizyon Makina', '2026-11-26', '1234.5', '1904-01-01', '#DIV/0!', 'Vizyon Makina'],
    ]);
  });

  it('writes dates the way it is told', async () => {
    const [plan] = await readWorkbook(fixture('openpyxl.xlsx'), {
      formatDate: (ms, show) => `${show}:${new Date(ms).toISOString()}`,
    });
    expect(plan!.rows[1]![1]).toBe('date:2026-11-25T00:00:00.000Z');
    expect(plan!.rows[5]![4]).toBe('time:1899-12-30T09:30:00.000Z');
  });

  it('stops at its limits and says so', async () => {
    const [plan] = await readWorkbook(fixture('openpyxl.xlsx'), {
      limits: { ...WORKBOOK_LIMITS, rows: 2, cols: 3 },
    });
    expect(plan!.cut).toBe(true);
    expect(plan!.rows).toEqual([
      ['Firma', 'Tarih', 'Tutar'],
      ['Dere Mutfak', '2026-11-25', '88.2'],
    ]);
  });

  it('refuses a part that unpacks past the limit', async () => {
    await expect(
      readWorkbook(fixture('openpyxl.xlsx'), { limits: { ...WORKBOOK_LIMITS, partBytes: 100 } }),
    ).rejects.toThrow('part too large');
  });

  it('refuses a file that is not a zip', async () => {
    await expect(readWorkbook(new TextEncoder().encode('Firma;Tarih\n'))).rejects.toThrow('not a zip');
  });

  it('names cells and columns as Excel does', () => {
    expect(cellAt('A1')).toEqual([0, 0]);
    expect(cellAt('$AB$12')).toEqual([27, 11]);
    expect(cellAt('nope')).toBeNull();
    expect(
      ['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA'].map((_, i) => columnName([0, 25, 26, 51, 52, 701, 702][i]!)),
    ).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('counts serial dates from the right day', () => {
    expect(new Date(serialToMs(1)).toISOString().slice(0, 10)).toBe('1900-01-01');
    expect(new Date(serialToMs(61)).toISOString().slice(0, 10)).toBe('1900-03-01');
    expect(new Date(serialToMs(46351)).toISOString().slice(0, 10)).toBe('2026-11-25');
    expect(new Date(serialToMs(0, true)).toISOString().slice(0, 10)).toBe('1904-01-01');
  });
});
