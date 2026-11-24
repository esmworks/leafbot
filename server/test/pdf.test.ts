import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { translator } from '../src/i18n';
import { pageRange, PdfError, readPdf, type PdfRun } from '../src/engine/pdf';
import { fileTools } from '../src/engine/pi-files';
import type { ToolResult } from '../src/engine/types';

const t = translator('tr');
const JPEG = Buffer.from('jpeg-bytes');

/** Stands in for poppler: a PDF of `count` pages whose texts are given, scanned pages empty. */
function fakePoppler(count: number, texts: string[], calls: string[][] = []): PdfRun {
  return async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'pdfinfo') return `Title: irsaliye\nPages:          ${count}\nEncrypted: no\n`;
    const from = Number(args[args.indexOf('-f') + 1]);
    const to = Number(args[args.indexOf('-l') + 1]);
    if (cmd === 'pdftotext')
      return texts
        .slice(from - 1, to)
        .map((x) => `${x}\f`)
        .join('');
    // pdftoppm pads the page number to the width of the last page's.
    const prefix = args.at(-1)!;
    const width = String(count).length;
    for (let p = from; p <= to; p++) writeFileSync(`${prefix}-${String(p).padStart(width, '0')}.jpg`, JPEG);
    return '';
  };
}

describe('pageRange', () => {
  it('reads a short PDF whole and asks for a range on a long one', () => {
    expect(pageRange(undefined, 3)).toEqual({ from: 1, to: 3 });
    expect(() => pageRange(undefined, 11)).toThrow(PdfError);
  });

  it('takes one page or a range and stops at the last page', () => {
    expect(pageRange('4', 30)).toEqual({ from: 4, to: 4 });
    expect(pageRange(' 2 - 6 ', 30)).toEqual({ from: 2, to: 6 });
    expect(pageRange('28-40', 30)).toEqual({ from: 28, to: 30 });
  });

  it('refuses a range it cannot read', () => {
    for (const spec of ['0', '31', '5-3', '1-21', 'ilk sayfa', '1,3']) {
      expect(() => pageRange(spec, 30), spec).toThrow(PdfError);
    }
  });
});

describe('readPdf', () => {
  it('gives each page its text and its picture, in page order', async () => {
    const calls: string[][] = [];
    const run = fakePoppler(
      12,
      Array.from({ length: 12 }, (_, i) => (i === 9 ? '' : `sayfa ${i + 1}`)),
      calls,
    );
    const pdf = await readPdf('/x/irsaliye.pdf', { pages: '9-11', images: true, run });
    expect(pdf).toMatchObject({ count: 12, from: 9, to: 11, texts: ['sayfa 9', '', 'sayfa 11'] });
    expect(pdf.images).toHaveLength(3);
    expect(pdf.images[0]).toEqual({ data: JPEG.toString('base64'), mimeType: 'image/jpeg' });
    const ppm = calls.find((c) => c[0] === 'pdftoppm')!;
    expect(ppm).toEqual(expect.arrayContaining(['-f', '9', '-l', '11', '-scale-to', '1568', '-jpeg']));
  });

  it('draws no pictures for a model that cannot see them', async () => {
    const calls: string[][] = [];
    const pdf = await readPdf('/x/a.pdf', { images: false, run: fakePoppler(2, ['bir', 'iki'], calls) });
    expect(pdf.texts).toEqual(['bir', 'iki']);
    expect(calls.map((c) => c[0])).not.toContain('pdftoppm');
  });
});

describe('read_file on a PDF', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'leafbot-pdf-test-'));
    writeFileSync(join(dir, 'irsaliye.pdf'), '%PDF-1.4 sahte');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const readTool = (seesImages: boolean, run: PdfRun) =>
    fileTools({ cwd: dir, additionalDirectories: [], writable: [dir], internet: false, readOnly: false }, t, {
      seesImages,
      pdfRun: run,
    }).find((f) => f.name === 'read_file')!;
  const read = (tool: ReturnType<typeof readTool>, args: Record<string, unknown>) =>
    tool.run({ path: 'irsaliye.pdf', ...args }, new AbortController().signal) as Promise<ToolResult>;

  it('shows a scanned page as a picture beside the text of the others', async () => {
    const r = await read(readTool(true, fakePoppler(2, ['DEVKAR 40x10 YAN 20', ''])), {});
    expect(typeof r).toBe('object');
    const { text, images } = r as Exclude<ToolResult, string>;
    expect(images).toHaveLength(2);
    expect(text).toContain('DEVKAR 40x10 YAN 20');
    expect(text).toContain(t('files.pdfNoText'));
    expect(text).toContain(t('files.pdfPictures'));
  });

  it('draws no more pages than the pictures a request keeps', async () => {
    const tool = fileTools(
      { cwd: dir, additionalDirectories: [], writable: [dir], internet: false, readOnly: false },
      t,
      { seesImages: true, pictures: 3, pdfRun: fakePoppler(5, ['a', 'b', 'c', 'd', 'e']) },
    ).find((f) => f.name === 'read_file')!;
    const run = (args: Record<string, unknown>) =>
      tool.run({ path: 'irsaliye.pdf', ...args }, new AbortController().signal) as Promise<ToolResult>;
    await expect(run({})).rejects.toThrow(t('files.pdfTooLong', { count: 5, max: 3 }));
    await expect(run({ pages: '1-4' })).rejects.toThrow(badRangeText(5, '1-4', 3));
    expect((await run({ pages: '3-5' })) as Exclude<ToolResult, string>).toMatchObject({
      images: [{}, {}, {}],
    });
  });

  it('tells a model without pictures that a scanned page cannot be read', async () => {
    const r = await read(readTool(false, fakePoppler(1, [''])), {});
    expect(r).toContain(t('files.pdfUnseen'));
  });

  it('asks for a range on a long PDF and says why a read failed', async () => {
    await expect(read(readTool(true, fakePoppler(40, [])), {})).rejects.toThrow(
      t('files.pdfTooLong', { count: 40, max: 20 }),
    );
    const missing: PdfRun = () => Promise.reject(new PdfError('noPoppler'));
    await expect(read(readTool(true, missing), {})).rejects.toThrow(t('files.pdfNoPoppler'));
  });
});

const badRangeText = (count: number, pages: string, max: number) =>
  t('files.pdfBadRange', { count, pages, max });

/** A one-page PDF with a line of text, written by hand so the test needs nothing to make it. */
function tinyPdf(words: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${words}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const hasPoppler = (() => {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!hasPoppler)('readPdf with poppler', () => {
  it('reads a real PDF page as text and as a picture', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'leafbot-pdf-real-'));
    try {
      const path = join(dir, 'irsaliye.pdf');
      writeFileSync(path, tinyPdf('Devkar 40x10 YAN 20'));
      const pdf = await readPdf(path, { images: true });
      expect(pdf).toMatchObject({ count: 1, from: 1, to: 1 });
      expect(pdf.texts[0]).toContain('Devkar 40x10 YAN 20');
      expect(pdf.images).toHaveLength(1);
      expect(Buffer.from(pdf.images[0]!.data, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
