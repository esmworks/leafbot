/**
 * Reads an Excel workbook (.xlsx, .xlsm) in the browser so the preview can show its sheets. It
 * unzips with the browser's own DecompressionStream and reads the XML with DOMParser, so no
 * spreadsheet library comes into the app for it. It reads values only: cell text, numbers and
 * dates as their formats say, not styling, merged cells or charts.
 */

/** One sheet as rows of cell text, the first row being the sheet's row 1. */
export interface Sheet {
  name: string;
  rows: string[][];
  /** Rows or columns past the limits were left out. */
  cut: boolean;
}

export interface WorkbookLimits {
  rows: number;
  cols: number;
  /** The most one part of the file may unpack to; a file claiming less can still try more. */
  partBytes: number;
}

export const WORKBOOK_LIMITS: WorkbookLimits = { rows: 2000, cols: 200, partBytes: 64 * 1024 * 1024 };

/** How a date or time cell is written; the preview passes one in the person's language. */
export type DateFormat = (ms: number, show: 'date' | 'time' | 'both') => string;

export class WorkbookError extends Error {}

export async function readWorkbook(
  bytes: Uint8Array<ArrayBuffer>,
  {
    formatDate = isoDate,
    limits = WORKBOOK_LIMITS,
  }: { formatDate?: DateFormat; limits?: WorkbookLimits } = {},
): Promise<Sheet[]> {
  const zip = openZip(bytes);
  const text = async (path: string) => {
    const entry = zip.get(path);
    if (!entry) return null;
    return new TextDecoder('utf-8').decode(await entry(limits.partBytes));
  };
  const xml = async (path: string) => {
    const source = await text(path);
    if (source == null) return null;
    const doc = new DOMParser().parseFromString(source, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new WorkbookError(`bad xml: ${path}`);
    return doc;
  };

  // The package says where its workbook is; Excel and openpyxl put it at xl/workbook.xml.
  const rootRels = relationships(await xml('_rels/.rels'), '');
  const bookPath = rootRels.find((r) => r.type.endsWith('/officeDocument'))?.target ?? 'xl/workbook.xml';
  const book = await xml(bookPath);
  if (!book) throw new WorkbookError('no workbook');
  const bookDir = bookPath.slice(0, bookPath.lastIndexOf('/') + 1);
  const rels = relationships(await xml(relsPathOf(bookPath)), bookDir);
  const relById = new Map(rels.map((r) => [r.id, r]));
  const relOfType = (type: string) => rels.find((r) => r.type.endsWith(`/${type}`))?.target;

  const pr = all(book, 'workbookPr')[0];
  const date1904 = /^(1|true)$/i.test(pr?.getAttribute('date1904') ?? '');
  const strings = readSharedStrings(await xml(relOfType('sharedStrings') ?? `${bookDir}sharedStrings.xml`));
  const styles = readStyles(await xml(relOfType('styles') ?? `${bookDir}styles.xml`));

  const listed = all(book, 'sheet').map((s) => ({
    name: s.getAttribute('name') ?? '',
    target: relById.get(relId(s) ?? '')?.target,
    hidden: /hidden/i.test(s.getAttribute('state') ?? ''),
  }));
  // Hidden sheets stay hidden, as in Excel, unless there is nothing else to show.
  const shown = listed.some((s) => !s.hidden) ? listed.filter((s) => !s.hidden) : listed;
  const sheets: Sheet[] = [];
  for (const s of shown) {
    // A chart sheet or a missing part has no cells to show; it is still named, empty.
    const doc = s.target ? await xml(s.target) : null;
    sheets.push({
      name: s.name,
      ...(doc ? readSheet(doc, { strings, styles, date1904, formatDate, limits }) : { rows: [], cut: false }),
    });
  }
  return sheets;
}

// ---- Zip ----

type Entry = (max: number) => Promise<Uint8Array>;

/**
 * The files of a zip by name, each unpacked on demand. Sizes and offsets come from the central
 * directory at the end, since writers that stream leave them out of the headers before the data.
 */
function openZip(bytes: Uint8Array<ArrayBuffer>): Map<string, Entry> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u16 = (at: number) => view.getUint16(at, true);
  const u32 = (at: number) => view.getUint32(at, true);
  // The end record sits in the last 22 bytes plus a comment of up to 64 KB.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 22 - 0xffff); i--)
    if (u32(i) === 0x06054b50) {
      end = i;
      break;
    }
  if (end < 0) throw new WorkbookError('not a zip');
  const count = u16(end + 10);
  let at = u32(end + 16);
  const entries = new Map<string, Entry>();
  const names = new TextDecoder('utf-8');
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || u32(at) !== 0x02014b50) throw new WorkbookError('bad zip directory');
    const method = u16(at + 10);
    const packed = u32(at + 20);
    const nameLen = u16(at + 28);
    const extraLen = u16(at + 30);
    const commentLen = u16(at + 32);
    const local = u32(at + 42);
    const name = names.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    entries.set(name, async (max) => {
      if (local + 30 > bytes.length || u32(local) !== 0x04034b50) throw new WorkbookError('bad zip entry');
      const start = local + 30 + u16(local + 26) + u16(local + 28);
      if (start + packed > bytes.length) throw new WorkbookError('zip entry runs past the end');
      const data = bytes.subarray(start, start + packed);
      if (method === 0) {
        if (data.length > max) throw new WorkbookError('part too large');
        return data;
      }
      if (method === 8) return inflate(data, max);
      throw new WorkbookError(`zip method ${method}`);
    });
  }
  return entries;
}

/** Unpacks deflated data, stopping once it passes `max` bytes whatever the header said. */
async function inflate(data: Uint8Array<ArrayBuffer>, max: number): Promise<Uint8Array> {
  const source = new ReadableStream<Uint8Array<ArrayBuffer>>({
    start(c) {
      c.enqueue(data);
      c.close();
    },
  });
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new WorkbookError('part too large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// ---- Package parts ----

/** Elements by their local name, whatever prefix the writer gave the namespace. */
const all = (node: Document | Element, name: string) => [...node.getElementsByTagNameNS('*', name)];

const relsPathOf = (path: string) => {
  const cut = path.lastIndexOf('/') + 1;
  return `${path.slice(0, cut)}_rels/${path.slice(cut)}.rels`;
};

/** The r:id of a sheet, read by its local name so any prefix for the namespace works. */
function relId(el: Element): string | null {
  for (const a of el.attributes) if (a.localName === 'id' && a.prefix) return a.value;
  return null;
}

function relationships(doc: Document | null, dir: string) {
  if (!doc) return [];
  return all(doc, 'Relationship')
    .filter((r) => r.getAttribute('TargetMode') !== 'External')
    .map((r) => ({
      id: r.getAttribute('Id') ?? '',
      type: r.getAttribute('Type') ?? '',
      target: resolve(dir, r.getAttribute('Target') ?? ''),
    }));
}

/** A part's path in the zip: an absolute target from the root, a relative one from `dir`. */
function resolve(dir: string, target: string): string {
  const parts = (target.startsWith('/') ? target.slice(1) : dir + target).split('/');
  const out: string[] = [];
  for (const p of parts) {
    if (p === '..') out.pop();
    else if (p && p !== '.') out.push(p);
  }
  return out.join('/');
}

/** The text of a string item: its runs joined, leaving out the phonetic guides Japanese adds. */
function itemText(el: Element): string {
  return all(el, 't')
    .filter((t) => !hasAncestor(t, 'rPh', el))
    .map((t) => t.textContent ?? '')
    .join('');
}

function hasAncestor(el: Element, name: string, stop: Element): boolean {
  for (let p = el.parentElement; p && p !== stop; p = p.parentElement) if (p.localName === name) return true;
  return false;
}

function readSharedStrings(doc: Document | null): string[] {
  if (!doc) return [];
  return all(doc, 'si').map(itemText);
}

/** How each cell style shows a number: as a date or time, a percentage, or as it is. */
type NumberLook = 'date' | 'time' | 'both' | 'percent' | null;

/** Excel's built-in formats that show dates and times, which a file names by number alone. */
const BUILTIN_LOOK: Record<number, NumberLook> = {
  9: 'percent',
  10: 'percent',
  14: 'date',
  15: 'date',
  16: 'date',
  17: 'date',
  18: 'time',
  19: 'time',
  20: 'time',
  21: 'time',
  22: 'both',
  45: 'time',
  46: 'time',
  47: 'time',
};

function lookOf(code: string): NumberLook {
  // Quoted text, escaped characters and [colour] or [$-locale] tags say nothing of dates; an
  // elapsed-time tag like [h] does.
  const bare = code
    .replace(/"[^"]*"/g, '')
    .replace(/\\./g, '')
    .replace(/\[(?![hms]+\])[^\]]*\]/gi, '')
    .replace(/AM\/PM|A\/P/gi, '')
    .split(';')[0]!;
  // An m after an hour or before seconds is minutes; any other m is a month.
  const months = bare.replace(/(h+[^a-z]*)m+/gi, '$1').replace(/m+([^a-z]*s)/gi, '$1');
  const date = /[dy]/i.test(bare) || /m/i.test(months);
  const time = /[hs]/i.test(bare);
  if (date && time) return 'both';
  if (date) return 'date';
  if (time) return 'time';
  if (bare.includes('%')) return 'percent';
  return null;
}

function readStyles(doc: Document | null): NumberLook[] {
  if (!doc) return [];
  const custom = new Map<number, string>();
  for (const f of all(doc, 'numFmt'))
    custom.set(Number(f.getAttribute('numFmtId')), f.getAttribute('formatCode') ?? '');
  const xfs = all(doc, 'cellXfs')[0];
  if (!xfs) return [];
  return [...xfs.children]
    .filter((x) => x.localName === 'xf')
    .map((x) => {
      const id = Number(x.getAttribute('numFmtId') ?? 0);
      const code = custom.get(id);
      return code != null ? lookOf(code) : (BUILTIN_LOOK[id] ?? null);
    });
}

// ---- Sheets ----

/** A cell reference's column and row, from 0: "B3" is [1, 2]. */
export function cellAt(ref: string): [number, number] | null {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(ref);
  if (!m) return null;
  let col = 0;
  for (const ch of m[1]!.toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return [col - 1, Number(m[2]) - 1];
}

/** A column's letters, as Excel heads it: 0 is A, 26 is AA. */
export function columnName(col: number): string {
  let name = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26))
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function readSheet(
  doc: Document,
  ctx: {
    strings: string[];
    styles: NumberLook[];
    date1904: boolean;
    formatDate: DateFormat;
    limits: WorkbookLimits;
  },
): { rows: string[][]; cut: boolean } {
  const { limits } = ctx;
  const rows: string[][] = [];
  let cut = false;
  let rowAt = -1;
  for (const row of all(doc, 'row')) {
    const r = Number(row.getAttribute('r'));
    rowAt = Number.isInteger(r) && r > 0 ? r - 1 : rowAt + 1;
    if (rowAt >= limits.rows) {
      cut = true;
      break;
    }
    let colAt = -1;
    for (const c of row.children) {
      if (c.localName !== 'c') continue;
      const at = cellAt(c.getAttribute('r') ?? '');
      colAt = at ? at[0] : colAt + 1;
      if (colAt >= limits.cols) {
        cut = true;
        break;
      }
      const value = cellText(c, ctx);
      if (value === '') continue;
      (rows[rowAt] ??= [])[colAt] = value;
    }
  }
  // Sparse rows and cells become empty ones, every row as wide as the widest.
  const width = rows.reduce((w, r) => Math.max(w, r?.length ?? 0), 0);
  const dense = Array.from(rows, (r) => Array.from({ length: width }, (_, i) => r?.[i] ?? ''));
  return { rows: dense, cut };
}

function child(el: Element, name: string): Element | undefined {
  for (const c of el.children) if (c.localName === name) return c;
  return undefined;
}

function cellText(
  c: Element,
  ctx: { strings: string[]; styles: NumberLook[]; date1904: boolean; formatDate: DateFormat },
): string {
  const type = c.getAttribute('t') ?? 'n';
  const raw = child(c, 'v')?.textContent ?? null;
  if (type === 'inlineStr') {
    const is = child(c, 'is');
    return is ? itemText(is) : '';
  }
  // openpyxl writes a formula's result as an empty <v/>; only a text result can truly be empty.
  const v = raw === '' && type !== 'str' ? null : raw;
  if (v == null) {
    // A formula saved without its result, as some writers do: its text is the best there is.
    const f = child(c, 'f')?.textContent;
    return f ? `=${f}` : '';
  }
  switch (type) {
    case 's':
      return ctx.strings[Number(v)] ?? '';
    case 'str':
    case 'e':
      return v;
    case 'b':
      return v === '1' ? 'TRUE' : 'FALSE';
    case 'd': {
      // Read as written, not shifted by this device's time zone.
      const ms = Date.parse(/T\d.*(Z|[+-]\d\d:?\d\d)$/i.test(v) || !/T\d/.test(v) ? v : `${v}Z`);
      return Number.isNaN(ms) ? v : ctx.formatDate(ms, /T\d/.test(v) ? 'both' : 'date');
    }
  }
  const n = Number(v);
  if (!Number.isFinite(n)) return v;
  const look = ctx.styles[Number(c.getAttribute('s') ?? 0)] ?? null;
  if (look === 'percent') return `${clean(n * 100)}%`;
  if (look) {
    const ms = serialToMs(n, ctx.date1904);
    // A time alone has no day; a whole-day date has no time worth showing.
    const show = look === 'both' && Number.isInteger(n) ? 'date' : look;
    return ctx.formatDate(ms, show);
  }
  return clean(n);
}

/** Leaves off the binary noise of stored decimals: 88.200000000000003 reads 88.2. */
const clean = (n: number) => String(Number(n.toPrecision(15)));

/**
 * A spreadsheet date serial as a UTC moment. Day 1 of the 1900 system is 1900-01-01, counted as if
 * 1900 had a 29 February, so from March 1900 on the days run from 1899-12-30.
 */
export function serialToMs(serial: number, date1904 = false): number {
  // Below 1 is a time of day alone, with no day to correct.
  const days = date1904 ? serial + 1462 : serial >= 1 && serial < 60 ? serial + 1 : serial;
  return Math.round((days - 25569) * 86_400_000);
}

function isoDate(ms: number, show: 'date' | 'time' | 'both'): string {
  const iso = new Date(ms).toISOString();
  if (show === 'date') return iso.slice(0, 10);
  if (show === 'time') return iso.slice(11, 16);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}
