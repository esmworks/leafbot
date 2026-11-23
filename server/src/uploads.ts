import { createHash } from 'node:crypto';
import { constants, createReadStream, lstatSync, mkdirSync } from 'node:fs';
import {
  copyFile,
  link,
  lstat,
  open,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { FileName, MAX_UPLOAD_BYTES } from '@leafbot/shared';
import type { T } from './i18n';
import { HttpError } from './util';

/**
 * Uploads wait outside the bots' folders until their message is sent: a file the person takes
 * back, or leaves behind by closing the page, is never seen by the bot or listed in the library.
 */
export function stagingDir(dataDir: string, threadId: string): string {
  const dir = join(dataDir, 'uploads', threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** How long an upload may wait for its message before the sweep removes it. */
export const STAGED_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Turns a name from the person's computer into one plain file name: no folders, no control
 * characters, no leading dots (hidden files are left out of the library), at most 120 characters.
 */
export function safeFileName(raw: string): string {
  const last = raw.split(/[/\\]/).pop() ?? '';
  let name = last
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim()
    .replace(/^\.+/, '');
  if (name.length > 120) {
    const ext = extname(name).slice(0, 20);
    name = name.slice(0, 120 - ext.length) + ext;
  }
  return name || 'file';
}

/** `rapor.pdf`, `rapor (2).pdf`, `rapor (3).pdf`, … */
function numbered(name: string, n: number) {
  if (n === 1) return name;
  const ext = extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
}

/**
 * Writes an upload into `dir` under a free name; an existing file is never replaced and a link
 * is never followed. A body over the limit is cut off and the partial file removed; an empty one
 * is refused.
 */
export async function saveUpload(
  dir: string,
  rawName: string,
  body: Readable,
  max = MAX_UPLOAD_BYTES,
): Promise<{ name: string; size: number; hash: string }> {
  const base = safeFileName(rawName);
  let fh;
  let name = base;
  for (let n = 1; !fh; n++) {
    name = numbered(base, n);
    try {
      fh = await open(
        join(dir, name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o644,
      );
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw err;
    }
  }
  let size = 0;
  const hash = createHash('sha256');
  try {
    for await (const chunk of body) {
      const buf = chunk as Buffer;
      size += buf.length;
      if (size > max) throw new HttpError(413, 'error.fileTooLarge', { max: Math.round(max / 1024 / 1024) });
      hash.update(buf);
      await fh.write(buf);
    }
    // An empty file gives the bot nothing to read, and is more often a failed copy than a wish.
    if (size === 0) throw new HttpError(400, 'error.fileEmpty');
    await fh.close();
  } catch (err) {
    await fh.close().catch(() => {});
    await rm(join(dir, name), { force: true });
    body.resume();
    throw err;
  }
  return { name, size, hash: hash.digest('hex') };
}

/** The SHA-256 of a file's bytes, or null when it cannot be read. */
async function fileHash(path: string): Promise<string | null> {
  const hash = createHash('sha256');
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  } catch {
    return null;
  }
  return hash.digest('hex');
}

/**
 * What the server knows of each upload id of a conversation, kept beside (not in) its staging
 * folder so that one holds only the waiting files: `<id>.json` names the file a try saved and
 * how to know it again, `<id>.cancel` says the person took the file off while it was going up.
 * They are on disk so a repeat after a restart is still recognised.
 */
export function uploadIdsDir(dataDir: string, threadId: string): string {
  const dir = join(dataDir, 'upload-ids', threadId);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A saved try: its file's name in the staging folder, and what makes that file itself. */
interface UploadRecord {
  name: string;
  size: number;
  hash: string;
  /** The file's inode and modification time, when known: the same file without reading it again. */
  ino?: number;
  mtimeMs?: number;
}

async function readRecord(ids: string, uploadId: string): Promise<UploadRecord | null> {
  try {
    const r = JSON.parse(await readFile(join(ids, `${uploadId}.json`), 'utf8')) as Partial<UploadRecord>;
    if (typeof r.name === 'string' && typeof r.size === 'number' && typeof r.hash === 'string')
      return r as UploadRecord;
  } catch {
    // No record, or one that cannot be read: the try is treated as the first.
  }
  return null;
}

const writeRecord = (ids: string, uploadId: string, r: UploadRecord) =>
  writeFile(join(ids, `${uploadId}.json`), JSON.stringify(r), { mode: 0o600 });

const cancelled = (ids: string, uploadId: string) =>
  lstat(join(ids, `${uploadId}.cancel`)).then(
    () => true,
    () => false,
  );

/**
 * Whether the staging folder's `name` is still the file the record was written for: by its inode
 * and modification time when the record has them, otherwise by reading its bytes.
 */
async function stillSame(dir: string, r: UploadRecord): Promise<boolean> {
  const st = await lstat(join(dir, r.name)).catch(() => null);
  if (!st?.isFile() || st.size !== r.size) return false;
  if (r.ino !== undefined && r.mtimeMs !== undefined) return st.ino === r.ino && st.mtimeMs === r.mtimeMs;
  return (await fileHash(join(dir, r.name))) === r.hash;
}

/**
 * Saves an attached file in the staging folder `dir`. The app tries a file once more when its
 * first try got no answer, and that first try may have been saved all the same: with the same
 * `uploadId` and the same bytes, the repeat is dropped and the earlier file answered, so the bot
 * does not get the file twice under two names. A file taken off while it was going up (see
 * {@link cancelStagedUpload}) is removed as soon as it is saved.
 *
 * With an id, the bytes first go to a file beside the records, and the record is written before
 * the file appears in the staging folder: whenever the server stops, a file there has its record.
 */
export async function saveStagedUpload(
  dataDir: string,
  threadId: string,
  rawName: string,
  body: Readable,
  uploadId?: string,
): Promise<{ name: string; size: number }> {
  const dir = stagingDir(dataDir, threadId);
  if (!uploadId) {
    const saved = await saveUpload(dir, rawName, body);
    return { name: saved.name, size: saved.size };
  }
  const ids = uploadIdsDir(dataDir, threadId);
  const part = await saveUpload(ids, `${uploadId}.part`, body);
  const partPath = join(ids, part.name);
  try {
    const earlier = await readRecord(ids, uploadId);
    let answer: { name: string; size: number };
    if (
      earlier &&
      earlier.hash === part.hash &&
      earlier.size === part.size &&
      (await stillSame(dir, earlier))
    ) {
      // The earlier try is still waiting there: this repeat is the same file.
      answer = { name: earlier.name, size: earlier.size };
    } else {
      const st = await lstat(partPath);
      const base = safeFileName(rawName);
      for (let n = 1; ; n++) {
        const name = numbered(base, n);
        try {
          // A hard link keeps the inode the record names; across file systems, an exclusive copy.
          await writeRecord(ids, uploadId, { ...part, name, ino: st.ino, mtimeMs: st.mtimeMs });
          await link(partPath, join(dir, name)).catch(async (err: NodeJS.ErrnoException) => {
            if (err.code !== 'EXDEV') throw err;
            await writeRecord(ids, uploadId, { ...part, name });
            await copyFile(partPath, join(dir, name), constants.COPYFILE_EXCL);
          });
          answer = { name, size: part.size };
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw err;
        }
      }
    }
    // The record is written before the cancel is looked for, as the cancel writes its mark before
    // it looks for the record: whichever comes second sees the other, so nothing is left behind.
    if (await cancelled(ids, uploadId)) {
      const record = await readRecord(ids, uploadId);
      if (record && (await stillSame(dir, record))) await rm(join(dir, record.name), { force: true });
      throw new HttpError(404, 'error.fileMissing');
    }
    return answer;
  } finally {
    await rm(partPath, { force: true });
  }
}

/**
 * The person took a file off while it was going up. Whether its upload has been saved already or
 * is still on its way, it ends up removed: a saved one now, one still coming once it is saved.
 */
export async function cancelStagedUpload(dataDir: string, threadId: string, uploadId: string): Promise<void> {
  const ids = uploadIdsDir(dataDir, threadId);
  await writeFile(join(ids, `${uploadId}.cancel`), '', { mode: 0o600 });
  const record = await readRecord(ids, uploadId);
  const dir = stagingDir(dataDir, threadId);
  if (record && (await stillSame(dir, record))) await rm(join(dir, record.name), { force: true });
}

/** The attached files as they are in `dir`: each must be a plain file there (not a link). */
export function attachedFiles(dir: string, names: string[]): { name: string; size: number }[] {
  return [...new Set(names)].map((name) => {
    if (!FileName.safeParse(name).success) throw new HttpError(400, 'validation.fileName');
    let st;
    try {
      st = lstatSync(join(dir, name));
    } catch {
      throw new HttpError(404, 'error.fileMissing');
    }
    if (!st.isFile()) throw new HttpError(404, 'error.fileMissing');
    return { name, size: st.size };
  });
}

/** The prompt the bot gets: the person's text, then where the attached files are. */
/** The person's message with the bot message it answers quoted above it. */
export function promptWithReply(text: string, quoted: string | undefined, t: T): string {
  if (quoted === undefined) return text;
  const lines = quoted.split('\n').map((l) => `> ${l}`);
  return `${t('prompt.replyTo')}\n${lines.join('\n')}\n\n${text}`;
}

/** What the bot is told when the person leaves an emoji on one of its messages. */
export function reactionPrompt(emoji: string, quoted: string, t: T, silent: string): string {
  const lines = quoted.split('\n').map((l) => `> ${l}`);
  return `${t('prompt.reaction', { emoji })}\n${lines.join('\n')}\n\n${t('prompt.reactionHint', { silent })}`;
}

export function promptWithFiles(text: string, dir: string, files: { name: string }[], t: T): string {
  if (!files.length) return text;
  const list = [t('prompt.attached'), ...files.map((f) => `- ${join(dir, f.name)}`)].join('\n');
  return text ? `${text}\n\n${list}` : list;
}

/**
 * Moves sent files from the staging folder into the conversation folder. A file there with the
 * same name (the bot's own, say) is kept: the new one takes the next free name.
 */
export async function moveIntoThread(
  from: string,
  to: string,
  files: { name: string; size: number }[],
): Promise<{ name: string; size: number }[]> {
  const moved: { name: string; size: number }[] = [];
  for (const f of files) {
    const src = join(from, f.name);
    for (let n = 1; ; n++) {
      const name = numbered(f.name, n);
      try {
        // A hard link never replaces an existing file; across file systems, an exclusive copy.
        await link(src, join(to, name)).catch(async (err: NodeJS.ErrnoException) => {
          if (err.code !== 'EXDEV') throw err;
          await copyFile(src, join(to, name), constants.COPYFILE_EXCL);
        });
        await unlink(src);
        moved.push({ name, size: f.size });
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw err;
      }
    }
  }
  return moved;
}

/**
 * Removes uploads older than `maxAgeMs` whose message was never sent, and empty folders; the
 * upload ids' records (and bytes a stopped server left half-way) go by the same age. The count
 * is of staged files only.
 */
export async function sweepUploads(dataDir: string, maxAgeMs = STAGED_MAX_AGE_MS, now = Date.now()) {
  const removed = await sweepFolders(join(dataDir, 'uploads'), maxAgeMs, now);
  await sweepFolders(join(dataDir, 'upload-ids'), maxAgeMs, now);
  return removed;
}

/** In each folder under `root`, removes entries older than `maxAgeMs`, then the folder once empty. */
async function sweepFolders(root: string, maxAgeMs: number, now: number) {
  let removed = 0;
  let threads: string[];
  try {
    threads = await readdir(root);
  } catch {
    return 0;
  }
  for (const thread of threads) {
    const dir = join(root, thread);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const file = join(dir, name);
      const st = await stat(file).catch(() => null);
      if (st && now - st.mtimeMs > maxAgeMs) {
        await rm(file, { force: true, recursive: true });
        removed++;
      }
    }
    // Only succeeds once the folder is empty.
    await rmdir(dir).catch(() => {});
  }
  return removed;
}
