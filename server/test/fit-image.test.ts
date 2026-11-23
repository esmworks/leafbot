import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { fitImage, fitResult, IMAGE_MAX_SIDE, screenshotImage } from '../src/engine/fit-image';

const picture = async (width: number, height: number, format: 'jpeg' | 'png') =>
  (
    await sharp({ create: { width, height, channels: 3, background: '#3a7' } })
      [format]()
      .toBuffer()
  ).toString('base64');

describe('modele giden resim', () => {
  it('büyük fotoğraf en uzun kenarı sınıra inecek biçimde küçülür', async () => {
    const big = { data: await picture(4000, 3000, 'jpeg'), mimeType: 'image/jpeg' };
    const fit = await fitImage(big);
    const meta = await sharp(Buffer.from(fit.data, 'base64')).metadata();
    expect(Math.max(meta.width!, meta.height!)).toBe(IMAGE_MAX_SIDE);
    expect(meta.width! / meta.height!).toBeCloseTo(4 / 3, 1);
    expect(fit.mimeType).toBe('image/jpeg');
  });

  it('küçük resim, animasyon ve okunamayan veri olduğu gibi kalır', async () => {
    const small = { data: await picture(800, 600, 'png'), mimeType: 'image/png' };
    expect(await fitImage(small)).toBe(small);
    const gif = { data: 'R0lGODlh', mimeType: 'image/gif' };
    expect(await fitImage(gif)).toBe(gif);
    const broken = { data: Buffer.from('resim değil').toString('base64'), mimeType: 'image/png' };
    expect(await fitImage(broken)).toBe(broken);
  });

  it('araç sonucunun yalnızca resimlerine dokunur', async () => {
    expect(await fitResult('metin')).toBe('metin');
    const r = await fitResult({
      text: 'ekran',
      images: [{ data: await picture(3200, 1800, 'png'), mimeType: 'image/png' }],
    });
    expect(typeof r !== 'string' && r.text).toBe('ekran');
    const meta = await sharp(
      Buffer.from(typeof r !== 'string' ? r.images[0]!.data : '', 'base64'),
    ).metadata();
    expect(meta.width).toBe(IMAGE_MAX_SIDE);
  });
});

describe('ekran görüntüsü', () => {
  it('modele JPEG gider ve ölçüsü aynı kalır', async () => {
    const png = await picture(1280, 800, 'png');
    const shot = await screenshotImage(png);
    expect(shot.mimeType).toBe('image/jpeg');
    const meta = await sharp(Buffer.from(shot.data, 'base64')).metadata();
    expect([meta.format, meta.width, meta.height]).toEqual(['jpeg', 1280, 800]);
  });

  it('okunamayan veri olduğu gibi PNG kalır', async () => {
    const broken = Buffer.from('resim değil').toString('base64');
    expect(await screenshotImage(broken)).toEqual({ data: broken, mimeType: 'image/png' });
  });
});
