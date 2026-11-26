import type SharpModule from 'sharp';
import type { ToolImage, ToolResult } from './types';

/**
 * The longest side a picture keeps when it goes to a model. Models see little more detail above
 * it, while each extra pixel costs tokens, and some providers refuse much larger pictures.
 */
export const IMAGE_MAX_SIDE = 1568;
/** A picture at or under this many bytes and side goes as it is. */
const SMALL_BYTES = 1024 * 1024;

type Sharp = typeof SharpModule;
let loaded: Promise<Sharp | null> | null = null;

/** The image library, loaded once; null where it cannot load, and pictures then go as they are. */
export function library(): Promise<Sharp | null> {
  loaded ??= import('sharp')
    .then((m) => m.default)
    .catch((err: unknown) => {
      console.warn(`Pictures go to models at full size: ${String(err)}`);
      return null;
    });
  return loaded;
}

/** Whether pictures can be made smaller here; without the library they go at full size. */
export async function canFitImages(): Promise<boolean> {
  return (await library()) !== null;
}

/**
 * A picture made small enough for a model: no side over {@link IMAGE_MAX_SIDE}, a photo as JPEG.
 * A small picture, an animation and one the library cannot read are returned unchanged.
 */
export async function fitImage(image: ToolImage): Promise<ToolImage> {
  if (image.mimeType === 'image/gif') return image;
  const sharp = await library();
  if (!sharp) return image;
  try {
    const input = Buffer.from(image.data, 'base64');
    const meta = await sharp(input).metadata();
    const side = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (!side || (side <= IMAGE_MAX_SIDE && input.length <= SMALL_BYTES)) return image;
    const resized = sharp(input)
      .rotate()
      .resize({ width: IMAGE_MAX_SIDE, height: IMAGE_MAX_SIDE, fit: 'inside', withoutEnlargement: true });
    // A screenshot with sharp edges stays PNG while that keeps it small; a photo goes as JPEG.
    if (image.mimeType === 'image/png') {
      const png = await resized.clone().png({ compressionLevel: 9 }).toBuffer();
      if (png.length <= SMALL_BYTES * 1.5) return { data: png.toString('base64'), mimeType: 'image/png' };
    }
    const jpeg = await resized.flatten({ background: '#ffffff' }).jpeg({ quality: 82 }).toBuffer();
    return jpeg.length < input.length ? { data: jpeg.toString('base64'), mimeType: 'image/jpeg' } : image;
  } catch {
    return image;
  }
}

/**
 * A screenshot of a desktop for the model as JPEG: it is a photo of a screen, and a PNG of one
 * costs several times the bytes for no more that the model can read. The size is kept exactly,
 * because the bot clicks by coordinates in this picture. Where the library cannot load, or
 * cannot read it, it goes as the PNG it was.
 */
export async function screenshotImage(
  data: string,
  mimeType: 'image/png' | 'image/jpeg' = 'image/png',
): Promise<ToolImage> {
  const png: ToolImage = { data, mimeType };
  // A picture that is JPEG already is sent as it is.
  if (mimeType === 'image/jpeg') return png;
  const sharp = await library();
  if (!sharp) return png;
  try {
    const jpeg = await sharp(Buffer.from(data, 'base64'))
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { data: jpeg.toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return png;
  }
}

/** A tool's result with its pictures made to fit; text is left alone. */
export async function fitResult(r: ToolResult): Promise<ToolResult> {
  if (typeof r === 'string' || !r.images.length) return r;
  return { text: r.text, images: await Promise.all(r.images.map(fitImage)) };
}
