import type { Bot, Thread } from '@leafbot/shared';
import { z } from 'zod';
import type { AppTool } from '../engine/types';
import type { T } from '../i18n';
import type { Services } from '../services';
import { ImageError } from '../services/images';
import { workspacePaths } from '../workspace';
import { postFiles, writeNewFile } from './files';
import type { Define } from './index';

/** Pictures one turn may make: each one is paid for, and a looping bot must not run up a bill. */
export const MAX_IMAGES_PER_TURN = 4;

/** `2026-11-17-153045`: a name that sorts by when the picture was made. */
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', '-').replace(/:/g, '');

/**
 * `image_create`: makes a picture from a description with a provider whose key the person saved,
 * keeps it in the conversation's folder and hands it to the person as a card, in one step.
 */
export function imageTool(opts: {
  def: Define;
  services: Services;
  dataDir: string;
  bot: Bot;
  thread: Pick<Thread, 'id' | 'kind' | 'botId'> & { userId?: string | null };
  signal: AbortSignal;
  t: T;
}): AppTool {
  const { def, services, dataDir, bot, thread, signal, t } = opts;
  let made = 0;
  return def(
    'image_create',
    {
      prompt: z.string().trim().min(1).max(4000),
      shape: z.enum(['square', 'landscape', 'portrait']).optional(),
      caption: z.string().max(2000).optional(),
    },
    async ({ prompt, shape, caption }) => {
      if (made >= MAX_IMAGES_PER_TURN) return t('tool.imageLimit', { max: MAX_IMAGES_PER_TURN });
      made++;
      // The provider the bot already runs on goes first, so the person pays a single account.
      const prefer = bot.engine === 'pi' ? bot.model.split('/')[0] : undefined;
      // The model chosen for pictures in the settings comes before that.
      const { imageModel } = await services.settings.all();
      let image;
      try {
        image = await services.images.create(prompt, { shape, model: imageModel, prefer, signal });
      } catch (err) {
        if (!(err instanceof ImageError)) throw err;
        if (err.reason === 'noKey') {
          made--;
          return t('tool.imageNoKey');
        }
        return t(`tool.imageFailed.${err.reason}`, { provider: err.provider, message: err.message });
      }
      const dir = workspacePaths(dataDir, bot.id, thread.id, bot.groupId).threadDir;
      const path = await writeNewFile(
        dir,
        `${t('tool.imageFileBase')}-${stamp(new Date())}`,
        image.ext,
        image.data,
      );
      const { files, moved } = await postFiles({ services, dataDir, bot, thread, paths: [path], caption, t });
      return t(moved ? 'tool.imageCreatedMain' : 'tool.imageCreated', {
        name: files[0]!.name,
        path,
        provider: image.provider,
      });
    },
  );
}
