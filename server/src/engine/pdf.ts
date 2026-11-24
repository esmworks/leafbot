import { execFile } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IMAGE_MAX_SIDE } from './fit-image';
import type { ToolImage } from './types';

/**
 * A PDF read for a model that takes only text and pictures: each page's text layer, and each page
 * as a picture, so a scanned page with no text can still be read. The pages are drawn by poppler
 * (pdfinfo, pdftotext, pdftoppm), the same programs Claude's own Read tool uses for PDF pages.
 */

/** A PDF up to this many pages is read whole when no pages are named. */
export const PDF_WHOLE_PAGES = 10;
/** The most pages one read returns: each page is a picture, and a request takes only so many. */
export const PDF_MAX_PAGES = 20;
/** A damaged or hostile PDF must not hold the turn. */
const PDF_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 32 * 1024 * 1024;

export type PdfProblem = 'noPoppler' | 'locked' | 'broken' | 'tooLong' | 'badRange';

export class PdfError extends Error {
  constructor(
    readonly problem: PdfProblem,
    readonly count = 0,
  ) {
    super(problem);
  }
}

/** Runs a poppler program and gives its standard output. */
export type PdfRun = (cmd: string, args: string[], signal?: AbortSignal) => Promise<string>;

const popplerRun: PdfRun = (cmd, args, signal) =>
  new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout: PDF_TIMEOUT_MS, maxBuffer: MAX_OUTPUT, encoding: 'utf8', signal },
      (err, stdout, stderr) => {
        if (!err) return resolve(stdout);
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new PdfError('noPoppler'));
        if (/password/i.test(stderr)) return reject(new PdfError('locked'));
        reject(err.name === 'AbortError' ? err : new PdfError('broken'));
      },
    );
  });

/** `"3"` or `"2-5"` within a PDF of `count` pages; a range past the end stops at the last page. */
export function pageRange(
  spec: string | undefined,
  count: number,
  max = PDF_MAX_PAGES,
): { from: number; to: number } {
  if (spec === undefined || !spec.trim()) {
    if (count > Math.min(PDF_WHOLE_PAGES, max)) throw new PdfError('tooLong', count);
    return { from: 1, to: Math.max(count, 1) };
  }
  const m = /^\s*(\d+)\s*(?:-\s*(\d+)\s*)?$/.exec(spec);
  const from = m ? Number(m[1]) : 0;
  const to = m ? Math.min(Number(m[2] ?? m[1]), count) : 0;
  if (!m || from < 1 || from > count || to < from || to - from + 1 > max) {
    throw new PdfError('badRange', count);
  }
  return { from, to };
}

export interface PdfPages {
  count: number;
  from: number;
  to: number;
  /** Each page's text layer, trimmed; empty for a scanned page. */
  texts: string[];
  /** Each page as a picture, when asked for. */
  images: ToolImage[];
}

export async function readPdf(
  path: string,
  opts: {
    pages?: string;
    images: boolean;
    /** The most pages one read gives; fewer than {@link PDF_MAX_PAGES} where fewer pictures fit. */
    maxPages?: number;
    signal?: AbortSignal;
    run?: PdfRun;
  },
): Promise<PdfPages> {
  const run = opts.run ?? popplerRun;
  const info = await run('pdfinfo', [path], opts.signal);
  const count = Number(/^Pages:\s+(\d+)/m.exec(info)?.[1] ?? 0);
  if (!count) throw new PdfError('broken');
  const { from, to } = pageRange(opts.pages, count, opts.maxPages);
  const range = ['-f', String(from), '-l', String(to)];
  const text = await run('pdftotext', [...range, '-layout', '-enc', 'UTF-8', path, '-'], opts.signal);
  // pdftotext ends every page with a form feed.
  const texts = text
    .split('\f')
    .slice(0, to - from + 1)
    .map((p) => p.trim());
  while (texts.length < to - from + 1) texts.push('');
  if (!opts.images) return { count, from, to, texts, images: [] };
  const dir = await mkdtemp(join(tmpdir(), 'leafbot-pdf-'));
  try {
    await run(
      'pdftoppm',
      [
        ...range,
        '-scale-to',
        String(IMAGE_MAX_SIDE),
        '-jpeg',
        '-jpegopt',
        'quality=82',
        path,
        join(dir, 'p'),
      ],
      opts.signal,
    );
    // p-1.jpg … or p-01.jpg …: the number is padded to the width of the last page's.
    const files = (await readdir(dir))
      .filter((f) => f.endsWith('.jpg'))
      .sort((a, b) => Number(/(\d+)\.jpg$/.exec(a)?.[1]) - Number(/(\d+)\.jpg$/.exec(b)?.[1]));
    const images: ToolImage[] = [];
    for (const f of files) {
      images.push({ data: (await readFile(join(dir, f))).toString('base64'), mimeType: 'image/jpeg' });
    }
    return { count, from, to, texts, images };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
