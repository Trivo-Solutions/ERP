import { describe, it, expect, beforeAll } from 'vitest';
import sharp from 'sharp';
import { createHash } from 'crypto';
import { processImage, MAX_ENCODE_ATTEMPTS } from './imageProcessor';
import { DEFAULT_PHOTOGRAPHY_SETTINGS, type PhotographySettings } from './photographySettings';

// Pure processor tests — no DB, no storage. Images are synthetic but photo-like (blurred noise compresses
// gradually, so the size search has something real to search).
const S = (over: Partial<PhotographySettings> = {}): PhotographySettings => ({ ...DEFAULT_PHOTOGRAPHY_SETTINGS, ...over });
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

async function photo(w: number, h: number, fmt: 'jpeg' | 'png' = 'jpeg', orientation?: number): Promise<Buffer> {
  const noise = await sharp({ create: { width: w, height: h, channels: 3, background: '#c08040', noise: { type: 'gaussian', mean: 128, sigma: 40 } } })
    .blur(1.2).png().toBuffer();
  let p = sharp(noise);
  if (orientation) p = p.withMetadata({ orientation });
  return fmt === 'jpeg' ? p.jpeg({ quality: 92 }).toBuffer() : p.png().toBuffer();
}

describe('imageProcessor — size targeting', () => {
  let big: Buffer; let small: Buffer;
  beforeAll(async () => { big = await photo(3200, 2400); small = await photo(400, 300); }, 60_000);

  it('source already below target: kept at maximum quality, full size, target reached', async () => {
    const r = await processImage(small, S({ generateThumbnail: false }));
    expect(r.optimized!.targetReached).toBe(true);
    expect(r.optimized!.quality).toBe(85);
    expect(r.optimized!.scale).toBe(1);
    expect(r.optimized!.encodeAttempts).toBe(1);
    expect(r.optimized!.width).toBe(400); // never enlarged
  });

  it('much larger than target: result <= target, valid image, correct sha256/dimensions/format', async () => {
    expect(big.length).toBeGreaterThan(500 * 1024);
    const r = await processImage(big, S({ generateThumbnail: false }));
    const o = r.optimized!;
    expect(o.targetReached).toBe(true);
    expect(o.sizeBytes).toBeLessThanOrEqual(500 * 1024);
    expect(o.sizeBytes).toBe(o.buffer.length);
    expect(o.sha256).toBe(sha(o.buffer));
    const meta = await sharp(o.buffer).metadata();
    expect(meta.format).toBe('webp');
    expect([meta.width, meta.height]).toEqual([o.width, o.height]);
    expect(o.width).toBeLessThanOrEqual(2400); expect(o.height).toBeLessThanOrEqual(2400);
    expect(o.encodeAttempts).toBeLessThanOrEqual(MAX_ENCODE_ATTEMPTS);
    expect(o.mimeType).toBe('image/webp');
  });

  it('a tighter target is honoured and yields a smaller file than a looser one (the setting drives behaviour)', async () => {
    const loose = (await processImage(big, S({ generateThumbnail: false, targetOptimizedSizeKB: 500 }))).optimized!;
    const tight = (await processImage(big, S({ generateThumbnail: false, targetOptimizedSizeKB: 300 }))).optimized!;
    expect(tight.targetReached).toBe(true);
    expect(tight.sizeBytes).toBeLessThanOrEqual(300 * 1024);
    expect(tight.sizeBytes).toBeLessThan(loose.sizeBytes);
  });

  it('requires quality reduction: stays at full size and lands between min and max quality', async () => {
    const r = (await processImage(big, S({ generateThumbnail: false, maximumWidth: 3200, maximumHeight: 3200, targetOptimizedSizeKB: 900, minimumQuality: 20, maximumQuality: 95 }))).optimized!;
    expect(r.targetReached).toBe(true);
    expect(r.scale).toBe(1);
    expect(r.quality).toBeLessThan(95);
    expect(r.quality).toBeGreaterThanOrEqual(20);
    expect(r.sizeBytes).toBeLessThanOrEqual(900 * 1024);
  });

  it('requires dimension reduction when even the minimum quality is too big', async () => {
    const r = (await processImage(big, S({ generateThumbnail: false, maximumWidth: 3200, maximumHeight: 3200, targetOptimizedSizeKB: 60, minimumQuality: 80, maximumQuality: 85, minimumLongEdge: 300 }))).optimized!;
    expect(r.targetReached).toBe(true);
    expect(r.scale).toBeLessThan(1);
    expect(r.width).toBeLessThan(3200);
    expect(r.sizeBytes).toBeLessThanOrEqual(60 * 1024);
    expect(Math.abs(r.width / r.height - 3200 / 2400)).toBeLessThan(0.02); // aspect preserved
  });

  it('target unreachable inside the bounds: best valid result kept, flagged, bounded attempts', async () => {
    const r = (await processImage(big, S({ generateThumbnail: false, targetOptimizedSizeKB: 50, minimumQuality: 90, maximumQuality: 95, minimumLongEdge: 2000 }))).optimized!;
    expect(r.targetReached).toBe(false);
    expect(r.sizeBytes).toBeGreaterThan(50 * 1024);
    expect(r.encodeAttempts).toBeLessThanOrEqual(MAX_ENCODE_ATTEMPTS);
    expect(Math.max(r.width, r.height)).toBeGreaterThanOrEqual(1990);
    expect((await sharp(r.buffer).metadata()).width).toBe(r.width); // still a valid image
  });

  it('JPEG output format is honoured', async () => {
    const r = (await processImage(big, S({ generateThumbnail: false, optimizedFormat: 'JPEG' }))).optimized!;
    expect(r.mimeType).toBe('image/jpeg');
    expect((await sharp(r.buffer).metadata()).format).toBe('jpeg');
    expect(r.sizeBytes).toBeLessThanOrEqual(500 * 1024);
  });

  it('never modifies the source buffer', async () => {
    const before = sha(big);
    await processImage(big, S());
    expect(sha(big)).toBe(before);
  });
});

describe('imageProcessor — variants, orientation, failures', () => {
  it('thumbnail keeps aspect ratio (fit inside) by default and crops only when asked', async () => {
    const src = await photo(1600, 800);
    const fit = (await processImage(src, S({ generateOptimized: false }))).thumbnail!;
    expect([fit.width, fit.height]).toEqual([300, 150]);
    const crop = (await processImage(src, S({ generateOptimized: false, thumbnailCrop: true }))).thumbnail!;
    expect([crop.width, crop.height]).toEqual([300, 300]);
    expect(fit.sha256).toBe(sha(fit.buffer));
  });

  it('disabled variants are not generated', async () => {
    const src = await photo(800, 600);
    expect(await processImage(src, S({ generateOptimized: false, generateThumbnail: false }))).toEqual({ optimized: null, thumbnail: null });
    const onlyThumb = await processImage(src, S({ generateOptimized: false }));
    expect(onlyThumb.optimized).toBeNull(); expect(onlyThumb.thumbnail).not.toBeNull();
    const onlyOpt = await processImage(src, S({ generateThumbnail: false }));
    expect(onlyOpt.thumbnail).toBeNull(); expect(onlyOpt.optimized).not.toBeNull();
  });

  it('EXIF orientation: auto-orient rotates a portrait-tagged landscape file; off leaves it as stored', async () => {
    const src = await photo(800, 400, 'jpeg', 6); // stored landscape, tagged rotate-90-CW, so it displays as portrait
    expect((await sharp(src).metadata()).orientation).toBe(6);
    const on = (await processImage(src, S({ generateThumbnail: false }))).optimized!;
    expect([on.width, on.height]).toEqual([400, 800]);
    expect((await sharp(on.buffer).metadata()).orientation ?? 1).toBe(1);
    const off = (await processImage(src, S({ generateThumbnail: false, autoOrient: false }))).optimized!;
    expect([off.width, off.height]).toEqual([800, 400]);
  });

  it('PNG source is accepted', async () => {
    const r = await processImage(await photo(600, 400, 'png'), S());
    expect(r.optimized!.width).toBe(600);
  });

  it('undecodable bytes give a safe UNREADABLE_IMAGE error (no library text)', async () => {
    const fake = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('not really an image')]);
    await expect(processImage(fake, S())).rejects.toMatchObject({ code: 'UNREADABLE_IMAGE', message: 'Source image could not be decoded' });
  });

  it('source over the configured input pixel limit gives SOURCE_TOO_LARGE', async () => {
    const src = await photo(1200, 1200);
    await expect(processImage(src, S({ maxInputWidth: 1000, maxInputHeight: 1000, maximumWidth: 1000, maximumHeight: 1000 }))).rejects.toMatchObject({ code: 'SOURCE_TOO_LARGE' });
  });
});
