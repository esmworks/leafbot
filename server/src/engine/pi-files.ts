import { constants, existsSync, lstatSync, realpathSync } from 'node:fs';
import { mkdir, open, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { DEFAULT_LOCALE } from '@leafbot/shared';
import { z } from 'zod';
import { translator, type T } from '../i18n';
import { canFitImages } from './fit-image';
import { PDF_MAX_PAGES, PdfError, readPdf, type PdfRun } from './pdf';
import type { Sandbox, ToolResult } from './types';

/**
 * File tools for API-key models. There is no shell: every path is resolved, symlinks
 * included, and must stay inside the bot's folders.
 */
export interface FileTool {
  /** Name the model sees. */
  name: string;
  /** Name used for permission checks and approval cards. */
  permissionName: string;
  description: string;
  input: z.ZodRawShape;
  /** Turns the model's arguments into the input shown on approval cards. */
  cardInput(args: Record<string, unknown>, abs: string): Record<string, unknown>;
  run(args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult>;
  /** Resolved target path, checked before the permission step. */
  target(args: Record<string, unknown>): string;
  /**
   * A check that needs to wait (a name lookup), before the permission step: a call that cannot
   * succeed throws a PathError and opens no card.
   */
  check?(args: Record<string, unknown>): Promise<void>;
}

const MAX_READ = 256 * 1024;
/** Pictures the model is shown rather than read as text; providers take these four. */
const IMAGE_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};
/**
 * A phone's photo is larger than providers take; it is made smaller before it goes (see fitImage).
 * Where it cannot be made smaller, only what providers take is read.
 */
const MAX_IMAGE = 25 * 1024 * 1024;
const MAX_IMAGE_UNFITTED = 5 * 1024 * 1024;
/** A PDF larger than this is not opened: a mail or a chat app brings nothing bigger. */
const MAX_PDF = 100 * 1024 * 1024;
const MAX_LIST = 500;
const MAX_MATCHES = 200;

export class PathError extends Error {}

/** Exists as a directory entry, even when it is a link whose target is missing. */
function present(p: string) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Real path of `p`, or of its nearest existing parent with the rest appended. A link whose
 * target is missing is refused: writing through it would create the target wherever it points.
 */
function realish(p: string, t: T): string {
  let cur = p;
  const rest: string[] = [];
  while (!present(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break;
    rest.unshift(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    cur = parent;
  }
  try {
    return join(realpathSync(cur), ...rest);
  } catch {
    throw new PathError(t('files.brokenLink'));
  }
}

/** Writes without following a link at the final path component. */
async function writeNoFollow(abs: string, data: string, t: T) {
  let fh;
  try {
    fh = await open(
      abs,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      0o644,
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ELOOP') throw new PathError(t('files.noWriteThroughLink'));
    throw err;
  }
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}

function inside(p: string, root: string) {
  const r = relative(root, p);
  return r === '' || (!r.startsWith('..') && !isAbsolute(r));
}

/**
 * `seesImages`: the model takes pictures, so read_file shows it one instead of its bytes.
 * `pictures`: how many pictures a request keeps; a PDF read draws no more pages than that, or the
 * first pages' pictures would be left out of the request unseen. `pdfRun`: what runs poppler's
 * programs, for tests.
 */
export function fileTools(
  sb: Sandbox,
  t: T = translator(DEFAULT_LOCALE),
  { seesImages = false, pictures, pdfRun }: { seesImages?: boolean; pictures?: number; pdfRun?: PdfRun } = {},
): FileTool[] {
  const pdfPages = seesImages && pictures ? Math.min(pictures, PDF_MAX_PAGES) : PDF_MAX_PAGES;
  const readRoots = [sb.cwd, ...sb.additionalDirectories].filter(existsSync).map((d) => realpathSync(d));
  const writeRoots = sb.writable.filter(existsSync).map((d) => realpathSync(d));

  const resolvePath = (raw: unknown, write: boolean) => {
    if (typeof raw !== 'string' || !raw.trim()) throw new PathError(t('files.emptyPath'));
    const abs = realish(resolve(sb.cwd, raw), t);
    const roots = write ? writeRoots : readRoots;
    if (!roots.some((root) => inside(abs, root))) {
      throw new PathError(t(write ? 'files.noWriteAccess' : 'files.outside', { path: raw }));
    }
    return abs;
  };

  /**
   * A PDF as its pages' text and, for a model that sees pictures, the pages themselves: a scanned
   * delivery note has no text layer and is read from its picture.
   */
  const readPdfFile = async (
    abs: string,
    a: Record<string, unknown>,
    size: number,
    signal: AbortSignal,
  ): Promise<ToolResult> => {
    if (size > MAX_PDF) throw new PathError(t('files.tooLarge'));
    let pdf;
    try {
      pdf = await readPdf(abs, {
        pages: typeof a.pages === 'string' ? a.pages : undefined,
        images: seesImages,
        maxPages: pdfPages,
        signal,
        run: pdfRun,
      });
    } catch (err) {
      if (!(err instanceof PdfError)) throw err;
      const vars = { count: err.count, max: pdfPages, pages: String(a.pages ?? '') };
      const key = {
        noPoppler: 'files.pdfNoPoppler',
        locked: 'files.pdfLocked',
        broken: 'files.pdfBroken',
        tooLong: 'files.pdfTooLong',
        badRange: 'files.pdfBadRange',
      } as const;
      throw new PathError(t(key[err.problem], vars));
    }
    const pages = pdf.texts.map(
      (text, i) => `${t('files.pdfPage', { page: pdf.from + i })}\n${text || t('files.pdfNoText')}`,
    );
    const lead = t('files.pdf', { path: String(a.path), from: pdf.from, to: pdf.to, count: pdf.count });
    const tail = pdf.images.length
      ? `\n\n${t('files.pdfPictures')}`
      : pdf.texts.some((x) => !x)
        ? `\n\n${t('files.pdfUnseen')}`
        : '';
    let text = `${lead}\n\n${pages.join('\n\n')}`;
    if (text.length > MAX_READ) text = `${text.slice(0, MAX_READ)}\n… (kesildi)`;
    text += tail;
    return pdf.images.length ? { text, images: pdf.images } : text;
  };

  const read: FileTool = {
    name: 'read_file',
    permissionName: 'Read',
    description: t('files.read'),
    input: {
      path: z.string().describe(t('files.readPath')),
      offset: z.number().int().min(1).optional(),
      limit: z.number().int().min(1).max(5000).optional(),
      pages: z
        .string()
        .optional()
        .describe(t('files.readPages', { max: pdfPages })),
    },
    target: (a) => resolvePath(a.path, false),
    cardInput: (_a, abs) => ({ file_path: abs }),
    async run(a, signal) {
      const abs = resolvePath(a.path, false);
      const info = await stat(abs);
      if (!info.isFile()) throw new PathError(t('files.notAFile'));
      // A picture (one the person attached, a screenshot) is shown to the model, not read as text.
      const mimeType = IMAGE_TYPES[abs.split('.').pop()?.toLowerCase() ?? ''];
      if (mimeType) {
        if (!seesImages) return t('files.imageUnseen');
        if (info.size > ((await canFitImages()) ? MAX_IMAGE : MAX_IMAGE_UNFITTED)) {
          throw new PathError(t('files.tooLarge'));
        }
        return {
          text: t('files.image', { path: String(a.path) }),
          images: [{ data: (await readFile(abs)).toString('base64'), mimeType }],
        };
      }
      if (abs.toLowerCase().endsWith('.pdf')) return readPdfFile(abs, a, info.size, signal);
      if (info.size > MAX_READ * 8) throw new PathError(t('files.tooLarge'));
      const lines = (await readFile(abs, 'utf8')).split('\n');
      const from = ((a.offset as number | undefined) ?? 1) - 1;
      const to = a.limit ? from + (a.limit as number) : lines.length;
      let out = lines
        .slice(from, to)
        .map((l, i) => `${String(from + i + 1).padStart(5)}\t${l}`)
        .join('\n');
      if (out.length > MAX_READ) out = `${out.slice(0, MAX_READ)}\n… (kesildi)`;
      return out || t('files.emptyFile');
    },
  };

  const write: FileTool = {
    name: 'write_file',
    permissionName: 'Write',
    description: t('files.write'),
    input: { path: z.string(), content: z.string() },
    target: (a) => resolvePath(a.path, true),
    cardInput: (a, abs) => ({ file_path: abs, content: a.content }),
    async run(a) {
      const abs = resolvePath(a.path, true);
      await mkdir(dirname(abs), { recursive: true });
      // Recheck after creating parents: a parent could have been swapped for a link.
      resolvePath(a.path, true);
      await writeNoFollow(abs, String(a.content), t);
      return t('files.written', { path: abs });
    },
  };

  const edit: FileTool = {
    name: 'edit_file',
    permissionName: 'Edit',
    description: t('files.edit'),
    input: {
      path: z.string(),
      old_text: z.string().min(1),
      new_text: z.string(),
      replace_all: z.boolean().optional(),
    },
    target: (a) => resolvePath(a.path, true),
    cardInput: (a, abs) => ({ file_path: abs, old_string: a.old_text, new_string: a.new_text }),
    async run(a) {
      const abs = resolvePath(a.path, true);
      const text = await readFile(abs, 'utf8');
      const oldText = String(a.old_text);
      const count = text.split(oldText).length - 1;
      if (count === 0) throw new PathError(t('files.notFoundText'));
      if (count > 1 && !a.replace_all) {
        throw new PathError(t('files.ambiguous', { count }));
      }
      const next = a.replace_all
        ? text.split(oldText).join(String(a.new_text))
        : text.replace(oldText, () => String(a.new_text));
      await writeNoFollow(abs, next, t);
      return t('files.edited', { path: abs, count: a.replace_all ? count : 1 });
    },
  };

  const list: FileTool = {
    name: 'list_files',
    permissionName: 'LS',
    description: t('files.list'),
    input: { path: z.string().optional(), recursive: z.boolean().optional() },
    target: (a) => resolvePath(a.path ?? '.', false),
    cardInput: (_a, abs) => ({ path: abs }),
    async run(a, signal) {
      const root = resolvePath(a.path ?? '.', false);
      const out: string[] = [];
      const walk = async (dir: string) => {
        for (const e of await readdir(dir, { withFileTypes: true })) {
          if (signal.aborted || out.length >= MAX_LIST) return;
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const p = join(dir, e.name);
          const rel = relative(root, p);
          if (e.isSymbolicLink()) continue;
          out.push(e.isDirectory() ? `${rel}/` : rel);
          if (e.isDirectory() && a.recursive) await walk(p);
        }
      };
      await walk(root);
      if (out.length >= MAX_LIST) out.push(t('files.listCapped', { max: MAX_LIST }));
      return out.join('\n') || t('files.emptyDir');
    },
  };

  const grep: FileTool = {
    name: 'grep',
    permissionName: 'Grep',
    description: t('files.grep'),
    input: { pattern: z.string().min(1), path: z.string().optional(), ignore_case: z.boolean().optional() },
    target: (a) => resolvePath(a.path ?? '.', false),
    cardInput: (a, abs) => ({ pattern: a.pattern, path: abs }),
    async run(a, signal) {
      const root = resolvePath(a.path ?? '.', false);
      let re: RegExp;
      try {
        re = new RegExp(String(a.pattern), a.ignore_case ? 'i' : '');
      } catch {
        throw new PathError(t('files.badRegex'));
      }
      const out: string[] = [];
      const scan = async (p: string) => {
        const info = await stat(p);
        if (info.isDirectory()) {
          for (const e of await readdir(p, { withFileTypes: true })) {
            if (signal.aborted || out.length >= MAX_MATCHES) return;
            if (e.isSymbolicLink() || e.name === 'node_modules' || e.name === '.git') continue;
            await scan(join(p, e.name));
          }
          return;
        }
        if (!info.isFile() || info.size > MAX_READ * 4) return;
        const text = await readFile(p, 'utf8');
        if (text.includes('\u0000')) return;
        text.split('\n').forEach((line, i) => {
          if (out.length < MAX_MATCHES && re.test(line)) {
            out.push(`${relative(sb.cwd, p) || p}:${i + 1}: ${line.slice(0, 300)}`);
          }
        });
      };
      await scan(root);
      return out.join('\n') || t('files.noMatch');
    },
  };

  return sb.readOnly ? [read, list, grep] : [read, write, edit, list, grep];
}
