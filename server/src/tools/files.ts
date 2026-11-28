import { constants, existsSync, realpathSync, statSync } from 'node:fs';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { MAX_UPLOAD_BYTES, type Bot, type MessageFile, type Thread } from '@leafbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { safeFileName } from '../uploads';
import { workspacePaths } from '../workspace';
import type { Define } from './index';
import {
  FRAME_MS,
  MAX_RENDER_SIDE,
  MAX_VIDEO_FRAMES,
  MAX_VIDEO_PIXELS,
  MAX_VIDEO_SECONDS,
  MAX_VIDEO_SIZE,
  renderPage,
  renderVideo,
  VIDEO_MS,
  VideoError,
} from '../browser/render';
import { bundlePage } from './page-bundle';
import { isJsxPage, isPageFile } from '../page-kit';

const real = (p: string) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);

/**
 * A file in the bot's own folders, by the path the bot gave (relative to its working folder or
 * absolute): its own folder, its group's and its project folder. Anything else is refused.
 * `served` says whether the library can serve it as it is.
 */
export function botFile(
  dataDir: string,
  bot: Pick<Bot, 'id' | 'groupId' | 'projectDir'>,
  threadId: string,
  rawPath: string,
  t: T,
): { full: string; size: number; served: boolean } {
  const paths = workspacePaths(dataDir, bot.id, threadId, bot.groupId);
  const cwd = bot.projectDir ?? paths.threadDir;
  const workspaces = real(resolve(dataDir, 'workspaces'))!;
  const served = [join(workspaces, 'bots', bot.id), ...(bot.groupId ? [real(paths.groupFiles!)!] : [])];
  const readable = [
    ...served,
    ...(bot.projectDir ? [real(bot.projectDir)].filter((p) => !!p) : []),
  ] as string[];

  if (!rawPath.trim()) throw new Error(t('files.emptyPath'));
  const full = real(isAbsolute(rawPath) ? rawPath : resolve(cwd, rawPath));
  if (!full || !readable.some((r) => inside(full, r))) throw new Error(t('files.outside', { path: rawPath }));
  const st = statSync(full);
  if (!st.isFile()) throw new Error(t('files.notAFile'));
  return { full, size: st.size, served: served.some((r) => inside(full, r)) };
}

/**
 * Where a file the bot sends must be, and where the person can download it from. The library
 * serves the bot's own folder and its group's; a file elsewhere (its project folder) is copied
 * into the conversation folder first.
 */
export async function shareableFile(
  dataDir: string,
  bot: Pick<Bot, 'id' | 'groupId' | 'projectDir'>,
  threadId: string,
  rawPath: string,
  t: T,
): Promise<MessageFile> {
  const paths = workspacePaths(dataDir, bot.id, threadId, bot.groupId);
  const workspaces = real(resolve(dataDir, 'workspaces'))!;
  const { full, size, served } = botFile(dataDir, bot, threadId, rawPath, t);

  let file = full;
  if (!served) {
    // From the project folder: a copy in the conversation folder, under a free name.
    const base = safeFileName(basename(full));
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : base.replace(/(\.[^.]*)?$/, ` (${n})$1`);
      const target = join(real(paths.threadDir)!, name);
      try {
        // A copy, not a link: later edits to the project file must not change what was sent.
        await copyFile(full, target, constants.COPYFILE_EXCL);
        file = target;
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw err;
      }
    }
  }
  return { name: basename(file), size, path: relative(workspaces, file) };
}

/** Files one bot handed another: as the receiver's messages show them, and where it finds them. */
export interface HandedFiles {
  files: MessageFile[];
  /** Each copy as the receiver names it: relative to its working folder, or absolute when that is a project folder. */
  shown: string[];
}

/**
 * Copies files from one bot's folders into another bot's conversation folder, under
 * `received/<sender>/`, so the receiver works on its own copies and the sender's later edits do
 * not change what was handed over. Each file must be one the sender may send.
 */
export async function handFiles(opts: {
  dataDir: string;
  from: Pick<Bot, 'id' | 'name' | 'groupId' | 'projectDir'>;
  fromThreadId: string;
  to: Pick<Bot, 'id' | 'groupId' | 'projectDir'>;
  toThreadId: string;
  paths: string[];
  t: T;
}): Promise<HandedFiles> {
  const { dataDir, from, to, t } = opts;
  const sources = opts.paths.map((p) => botFile(dataDir, from, opts.fromThreadId, p, t));
  const big = sources.find((s) => s.size > MAX_UPLOAD_BYTES);
  if (big)
    throw new Error(t('tool.handFileTooBig', { name: basename(big.full), mb: MAX_UPLOAD_BYTES / 1_048_576 }));
  const threadDir = real(workspacePaths(dataDir, to.id, opts.toThreadId, to.groupId).threadDir)!;
  const dir = join(threadDir, 'received', safeFileName(from.name) || from.id);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const workspaces = real(resolve(dataDir, 'workspaces'))!;
  const out: HandedFiles = { files: [], shown: [] };
  for (const { full, size } of sources) {
    const target = await copyFree(full, dir);
    out.files.push({ name: basename(target), size, path: relative(workspaces, target) });
    out.shown.push(to.projectDir ? target : relative(threadDir, target));
  }
  return out;
}

/** Copies a file into `dir` under its own name, or `name (2).ext` and on when that is taken. */
async function copyFree(file: string, dir: string): Promise<string> {
  const base = safeFileName(basename(file));
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : base.replace(/(\.[^.]*)?$/, ` (${n})$1`);
    const target = join(dir, name);
    try {
      await copyFile(file, target, constants.COPYFILE_EXCL);
      return target;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw err;
    }
  }
}

/** What a card's conversation needs to be known by. */
type ThreadRef = Pick<Thread, 'id' | 'kind' | 'botId'> & { userId?: string | null };

/**
 * The conversation the person reads for a card the bot hands over. A conversation with another bot
 * is between the two bots: the person does not follow it, so a file or page meant for them goes to
 * the bot's own conversation with them.
 */
async function personThread(services: Services, bot: Bot, thread: ThreadRef) {
  if (thread.kind !== 'bot') return { id: thread.id, moved: false };
  // Work between two bots is the bot's own: its card goes to the bot's owner.
  return {
    id: (await services.threads.main(bot.id, await services.access.personOf(thread))).id,
    moved: true,
  };
}

/**
 * Puts files from the bot's folders on a card for the person, in the conversation they read.
 * `moved` says the card went to the bot's own conversation with them instead of this one.
 */
export async function postFiles(opts: {
  services: Services;
  dataDir: string;
  bot: Bot;
  thread: ThreadRef;
  paths: string[];
  caption?: string;
  t: T;
}): Promise<{ files: MessageFile[]; moved: boolean }> {
  const { services, dataDir, bot, thread, t } = opts;
  const to = await personThread(services, bot, thread);
  const files: MessageFile[] = [];
  // Relative paths are read from this conversation's folder; a copy lands where the card goes.
  for (const p of opts.paths) {
    files.push(await shareableFile(dataDir, bot, to.id, botFile(dataDir, bot, thread.id, p, t).full, t));
  }
  await services.threads.addMessage({
    threadId: to.id,
    role: 'assistant',
    author: `bot:${bot.id}`,
    text: opts.caption?.trim() ?? '',
    // No turn id: the streaming reply of the same turn stays on screen until it is saved.
    props: { files },
  });
  return { files, moved: to.moved };
}

/** `send_file`: hands a file from the bot's folders to the person, as a card in the conversation. */
export function sendFileTool(opts: {
  def: Define;
  services: Services;
  dataDir: string;
  bot: Bot;
  thread: ThreadRef;
  t: T;
}): AppTool {
  const { def, services, dataDir, bot, thread, t } = opts;
  return def(
    'send_file',
    {
      paths: z.array(z.string().max(2000)).min(1).max(10),
      caption: z.string().max(2000).optional(),
    },
    async ({ paths, caption }) => {
      const { files, moved } = await postFiles({ services, dataDir, bot, thread, paths, caption, t });
      const names = files.map((f) => f.name).join(', ');
      // The bot must know where it went, or it tells the other bot the file is somewhere it is not.
      return t(moved ? 'tool.fileSentMain' : 'tool.fileSent', { names });
    },
    'internal',
  );
}

/** A folder in the bot's folders, by the same rules as its files. */
function botFolder(
  dataDir: string,
  bot: Pick<Bot, 'id' | 'groupId' | 'projectDir'>,
  threadId: string,
  rawPath: string,
) {
  const paths = workspacePaths(dataDir, bot.id, threadId, bot.groupId);
  const full = real(isAbsolute(rawPath) ? rawPath : resolve(bot.projectDir ?? paths.threadDir, rawPath));
  if (!full || !statSync(full).isDirectory()) throw new Error('not a folder');
  const workspaces = real(resolve(dataDir, 'workspaces'))!;
  const roots = [join(workspaces, 'bots', bot.id), ...(bot.groupId ? [real(paths.groupFiles!)!] : [])];
  if (!roots.some((r) => inside(full, r))) throw new Error('outside');
  return { full };
}

/**
 * The page file a bot means: a folder stands for its index.html, with the scripts, styles,
 * pictures and data beside it. Null when it is not an HTML page.
 */
function pageFile(
  dataDir: string,
  bot: Pick<Bot, 'id' | 'groupId' | 'projectDir'>,
  threadId: string,
  path: string,
  t: T,
): string | null {
  let page = path;
  try {
    const folder = botFolder(dataDir, bot, threadId, path).full;
    page = join(folder, existsSync(join(folder, 'index.jsx')) ? 'index.jsx' : 'index.html');
  } catch {
    // Not a folder: a page file.
  }
  return isPageFile(page) ? botFile(dataDir, bot, threadId, page, t).full : null;
}

/** Writes a new file in `dir` under a free name (`afiş.png`, `afiş-2.png`…) and returns its path. */
export async function writeNewFile(dir: string, base: string, ext: string, data: Buffer): Promise<string> {
  for (let n = 1; ; n++) {
    const path = join(dir, `${base}${n === 1 ? '' : `-${n}`}.${ext}`);
    try {
      await writeFile(path, data, { flag: 'wx', mode: 0o600 });
      return path;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST' || n >= 1000) throw err;
    }
  }
}

/** The largest page a bot may show in the conversation. */
const MAX_PAGE = 2 * 1024 * 1024;

/**
 * `show_page`: shows an HTML page the bot made (a chart, a map, a small tool) in the conversation,
 * running in an isolated frame: its scripts run, but it cannot reach the app, its data or the
 * network beyond the libraries it loads. The card always shows the file as it is now, so the bot
 * updates a page by writing the file again and showing it once more.
 */
export function showPageTool(opts: {
  def: Define;
  services: Services;
  dataDir: string;
  bot: Bot;
  thread: ThreadRef;
  t: T;
}): AppTool {
  const { def, services, dataDir, bot, thread, t } = opts;
  const threadId = thread.id;
  return def(
    'show_page',
    {
      path: z.string().max(2000),
      title: z.string().max(120).optional(),
      height: z.number().int().min(200).max(1200).optional(),
    },
    async ({ path, title, height }) => {
      const full = pageFile(dataDir, bot, threadId, path, t);
      if (!full) return t('tool.pageNotHtml');
      const to = await personThread(services, bot, thread);
      const file = await shareableFile(dataDir, bot, to.id, full, t);
      if (file.size > MAX_PAGE) return t('tool.pageTooLarge');
      // A React page brings nothing from its folder; an HTML one carries the files it uses.
      const { leftOut } = isJsxPage(full) ? { leftOut: [] } : await bundlePage(full);
      await services.threads.addMessage({
        threadId: to.id,
        role: 'assistant',
        author: `bot:${bot.id}`,
        text: title?.trim() ?? '',
        props: { page: { path: file.path, name: file.name, ...(height && { height }) } },
      });
      const shown = t(to.moved ? 'tool.pageShownMain' : 'tool.pageShown', { name: file.name });
      if (!leftOut.length) return shown;
      const names = leftOut.slice(0, 10).map((l) => `${l.name} (${t(`tool.pageLeftOut.${l.why}`)})`);
      return `${shown} ${t('tool.pageLeftOut', { files: names.join(', ') })}`;
    },
    'internal',
  );
}

/**
 * `page_to_image`: turns a page the bot made into a PNG of the size it asks for (a banner, a
 * poster, a social card) and hands it to the person as a card. Pages draw text and layout far
 * better than picture models, and this costs nothing. The page runs as it would in the chat:
 * its libraries and fonts from the usual CDNs, and nothing else.
 */
export function pageImageTool(opts: {
  def: Define;
  services: Services;
  dataDir: string;
  bot: Bot;
  thread: ThreadRef;
  browser: { executable: string; sandbox: boolean };
  signal: AbortSignal;
  t: T;
}): AppTool {
  const { def, services, dataDir, bot, thread, signal, t } = opts;
  const side = z.number().int().min(16).max(MAX_RENDER_SIDE);
  return def(
    'page_to_image',
    {
      path: z.string().max(2000),
      width: side,
      height: side.optional(),
      scale: z.union([z.literal(1), z.literal(2)]).optional(),
      caption: z.string().max(2000).optional(),
    },
    async ({ path, width, height, scale, caption }) => {
      const full = pageFile(dataDir, bot, thread.id, path, t);
      if (!full) return t('tool.pageNotHtml');
      // A React page loads its libraries from this server, which the picture's browser does not reach.
      if (isJsxPage(full)) return t('tool.pageImageNotJsx');
      if (statSync(full).size > MAX_PAGE) return t('tool.pageTooLarge');
      const { html, leftOut } = await bundlePage(full);
      const png = await renderPage({
        ...opts.browser,
        html,
        width,
        height,
        scale,
        // A bot kept off the internet does not reach it through its page either.
        libraries: bot.internet,
        signal,
      });
      const named = basename(full, extname(full));
      const base = named === 'index' ? basename(join(full, '..')) : named;
      const dir = workspacePaths(dataDir, bot.id, thread.id, bot.groupId).threadDir;
      const file = await writeNewFile(dir, safeFileName(base), 'png', png);
      const { files, moved } = await postFiles({ services, dataDir, bot, thread, paths: [file], caption, t });
      const sent = t(moved ? 'tool.pageImageSentMain' : 'tool.pageImageSent', {
        name: files[0]!.name,
        path: file,
      });
      if (!leftOut.length) return sent;
      const names = leftOut.slice(0, 10).map((l) => `${l.name} (${t(`tool.pageLeftOut.${l.why}`)})`);
      return `${sent} ${t('tool.pageLeftOut', { files: names.join(', ') })}`;
    },
    'internal',
  );
}

/** Page videos one turn may make: each films its page frame by frame, which takes a while. */
export const MAX_PAGE_VIDEOS_PER_TURN = 2;

/**
 * `page_to_video`: films a page the bot made into an MP4 (an animated post, a product demo, a
 * title card) and hands it to the person as a card. The page animates with CSS, the Web Animations
 * API, its own script or a `window.render(t)` that draws each moment; the browser's clock stands
 * still and moves on frame by frame, so the video is smooth however slow the computer. It costs
 * nothing, unlike `video_create`, and its text comes out exact.
 */
export function pageVideoTool(opts: {
  def: Define;
  services: Services;
  dataDir: string;
  bot: Bot;
  thread: ThreadRef;
  browser: { executable: string; sandbox: boolean };
  ffmpeg: string;
  signal: AbortSignal;
  t: T;
}): AppTool {
  const { def, services, dataDir, bot, thread, signal, t } = opts;
  const side = z.number().int().min(16).max(MAX_RENDER_SIDE);
  let made = 0;
  const tool = def(
    'page_to_video',
    {
      path: z.string().max(2000),
      width: side,
      height: side,
      seconds: z.number().positive().max(MAX_VIDEO_SECONDS),
      fps: z.number().int().min(1).max(60).optional(),
      scale: z.number().min(1).max(3).optional(),
      caption: z.string().max(2000).optional(),
    },
    async ({ path, width, height, seconds, fps = 30, scale = 1, caption }) => {
      if (made >= MAX_PAGE_VIDEOS_PER_TURN)
        return t('tool.pageVideoLimit', { max: MAX_PAGE_VIDEOS_PER_TURN });
      const full = pageFile(dataDir, bot, thread.id, path, t);
      if (!full) return t('tool.pageNotHtml');
      // A React page loads its libraries from this server, which the video's browser does not reach.
      if (isJsxPage(full)) return t('tool.pageVideoNotJsx');
      if (statSync(full).size > MAX_PAGE) return t('tool.pageTooLarge');
      const frames = Math.round(seconds * fps);
      if (frames < 1) return t('tool.pageVideoTooShort');
      if (frames > MAX_VIDEO_FRAMES) return t('tool.pageVideoTooLong', { frames: MAX_VIDEO_FRAMES });
      if (width * scale * height * scale > MAX_VIDEO_PIXELS)
        return t('tool.pageVideoTooLarge', MAX_VIDEO_SIZE);
      made++;
      const { html, leftOut } = await bundlePage(full);
      let mp4: Buffer;
      try {
        mp4 = await renderVideo({
          ...opts.browser,
          ffmpeg: opts.ffmpeg,
          html,
          width,
          height,
          scale,
          seconds,
          fps,
          // A bot kept off the internet does not reach it through its page either.
          libraries: bot.internet,
          signal,
        });
      } catch (err) {
        if (!(err instanceof VideoError)) throw err;
        return t(`tool.pageVideoFailed.${err.reason}`, {
          seconds: FRAME_MS / 1000,
          minutes: VIDEO_MS / 60_000,
          message: err.message,
        });
      }
      const named = basename(full, extname(full));
      const base = named === 'index' ? basename(join(full, '..')) : named;
      const dir = workspacePaths(dataDir, bot.id, thread.id, bot.groupId).threadDir;
      const file = await writeNewFile(dir, safeFileName(base), 'mp4', mp4);
      const { files, moved } = await postFiles({ services, dataDir, bot, thread, paths: [file], caption, t });
      const sent = t(moved ? 'tool.pageVideoSentMain' : 'tool.pageVideoSent', {
        name: files[0]!.name,
        path: file,
        seconds: Math.round(seconds * 10) / 10,
      });
      if (!leftOut.length) return sent;
      const names = leftOut.slice(0, 10).map((l) => `${l.name} (${t(`tool.pageLeftOut.${l.why}`)})`);
      return `${sent} ${t('tool.pageLeftOut', { files: names.join(', ') })}`;
    },
    'internal',
  );
  // The limits are the code's, put into the description rather than written into its text.
  return {
    ...tool,
    description: t('tool.page_to_video', {
      seconds: MAX_VIDEO_SECONDS,
      fastSeconds: MAX_VIDEO_FRAMES / 60,
      width: MAX_VIDEO_SIZE.width,
      height: MAX_VIDEO_SIZE.height,
      max: MAX_PAGE_VIDEOS_PER_TURN,
    }),
  };
}
