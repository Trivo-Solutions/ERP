// ImageProcessor — pure image encoding. Bytes + explicit settings in, bytes + facts out.
// It knows nothing about companies, users, permissions, HTTP, Prisma or storage: the caller (the processing
// service) supplies the source buffer and the settings, and persists whatever comes back. It never touches the
// filesystem — sharp works on in-memory buffers — so there is no path a request could steer it to.
//
// Library: sharp (Apache-2.0; bundles libvips under LGPL-3.0, dynamically linked prebuilt binaries per platform).
//
// Size targeting (optimized image) — `targetOptimizedSizeKB` is honoured by search, not by guessing a quality:
//   1. decode ONCE (auto-orient, fit inside maximumWidth × maximumHeight, never enlarge) into raw pixels
//   2. encode at maximumQuality — if it is already ≤ target we are done (a small source stays high quality)
//   3. otherwise encode at minimumQuality at full size:
//        ≤ target → binary-search the HIGHEST quality in (min, max) that still fits
//        > target → shrink the dimensions (step estimated from the size ratio) and re-encode at minimumQuality
//                   until it fits, then binary-search quality upward at that size; the long edge never goes below
//                   minimumLongEdge
//   4. the whole search is capped at MAX_ENCODE_ATTEMPTS encodes
//   5. if the target cannot be reached inside those bounds, the SMALLEST valid result is returned with
//      targetReached = false — never a corrupt file, never an endless retry.
import { createHash } from 'crypto';
import sharp from 'sharp';
import type { OutputFormat, PhotographySettings } from './photographySettings';

/** Technical cap on encodes per image — bounds CPU for one image no matter what the settings are. */
export const MAX_ENCODE_ATTEMPTS = 14;
/** Smallest shrink step per round / largest, as a fraction of the previous size (keeps the search converging). */
const MIN_STEP = 0.5;
const MAX_STEP = 0.9;

export type ProcessingErrorCode = 'UNREADABLE_IMAGE' | 'SOURCE_TOO_LARGE' | 'ENCODE_FAILED';
/** Carries only a code and a fixed, non-sensitive message — never library internals or file content. */
export class ImageProcessingError extends Error {
  constructor(readonly code: ProcessingErrorCode, message: string) { super(message); this.name = 'ImageProcessingError'; }
}

export interface EncodedImage {
  buffer: Buffer;
  format: OutputFormat;
  mimeType: string;
  width: number;
  height: number;
  sizeBytes: number;
  sha256: string;
}
export interface OptimizedResult extends EncodedImage {
  quality: number;
  targetBytes: number;
  targetReached: boolean;
  encodeAttempts: number;
  /** 1 = full (max-bounded) size; <1 = the dimensions had to be reduced to approach the target. */
  scale: number;
}
export interface ProcessResult {
  optimized: OptimizedResult | null;
  thumbnail: EncodedImage | null;
  /** Set when the optimized image succeeded but the thumbnail did not — the two fail independently. */
  thumbnailError?: ProcessingErrorCode;
}

const MIME: Record<OutputFormat, string> = { WEBP: 'image/webp', JPEG: 'image/jpeg' };

interface Raw { data: Buffer; width: number; height: number; channels: 1 | 2 | 3 | 4 }

function sha256(b: Buffer) { return createHash('sha256').update(b).digest('hex'); }

async function decode(source: Buffer, s: PhotographySettings): Promise<Raw> {
  try {
    let p = sharp(source, { limitInputPixels: s.maxInputWidth * s.maxInputHeight, failOn: 'error' });
    if (s.autoOrient) p = p.rotate(); // applies the EXIF orientation, then the tag is dropped from the output
    const { data, info } = await p
      .resize({ width: s.maximumWidth, height: s.maximumHeight, fit: 'inside', withoutEnlargement: true })
      .raw().toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height, channels: info.channels as Raw['channels'] };
  } catch (e) {
    const m = e instanceof Error ? e.message : '';
    if (/pixel limit/i.test(m)) throw new ImageProcessingError('SOURCE_TOO_LARGE', 'Source image exceeds the configured maximum input dimensions');
    throw new ImageProcessingError('UNREADABLE_IMAGE', 'Source image could not be decoded');
  }
}

async function encode(raw: Raw, format: OutputFormat, quality: number, outWidth?: number, fit?: { w: number; h: number; crop: boolean }): Promise<EncodedImage> {
  try {
    let p = sharp(raw.data, { raw: { width: raw.width, height: raw.height, channels: raw.channels } });
    if (fit) p = p.resize({ width: fit.w, height: fit.h, fit: fit.crop ? 'cover' : 'inside', withoutEnlargement: !fit.crop });
    else if (outWidth !== undefined && outWidth !== raw.width) p = p.resize({ width: outWidth });
    if (format === 'JPEG') p = p.flatten({ background: '#ffffff' }).jpeg({ quality, mozjpeg: true });
    else p = p.webp({ quality, effort: 4 });
    const { data, info } = await p.toBuffer({ resolveWithObject: true });
    return { buffer: data, format, mimeType: MIME[format], width: info.width, height: info.height, sizeBytes: data.length, sha256: sha256(data) };
  } catch {
    throw new ImageProcessingError('ENCODE_FAILED', 'Image could not be encoded');
  }
}

async function optimize(raw: Raw, s: PhotographySettings): Promise<OptimizedResult> {
  const targetBytes = s.targetOptimizedSizeKB * 1024;
  let attempts = 0;
  let smallest: { img: EncodedImage; quality: number; scale: number } | null = null;
  const run = async (scale: number, quality: number) => {
    attempts++;
    const img = await encode(raw, s.optimizedFormat, quality, Math.max(1, Math.round(raw.width * scale)));
    if (!smallest || img.sizeBytes < smallest.img.sizeBytes) smallest = { img, quality, scale };
    return img;
  };
  const done = (img: EncodedImage, quality: number, scale: number, reached: boolean): OptimizedResult =>
    ({ ...img, quality, scale, targetBytes, targetReached: reached, encodeAttempts: attempts });

  /** Highest quality in [lo, hi] that fits at this scale. `lo` is known to fit; `hi` is known not to (or is the cap). */
  const climb = async (scale: number, fits: { img: EncodedImage; quality: number }, hi: number) => {
    let best = fits;
    let lo = fits.quality;
    while (hi - lo > 1 && attempts < MAX_ENCODE_ATTEMPTS) {
      const mid = Math.floor((lo + hi) / 2);
      const img = await run(scale, mid);
      if (img.sizeBytes <= targetBytes) { best = { img, quality: mid }; lo = mid; } else hi = mid;
    }
    return done(best.img, best.quality, scale, true);
  };

  // 2 — top quality first
  const top = await run(1, s.maximumQuality);
  if (top.sizeBytes <= targetBytes) return done(top, s.maximumQuality, 1, true);

  // 3 — floor quality at full size
  let last = await run(1, s.minimumQuality);
  if (last.sizeBytes <= targetBytes) return climb(1, { img: last, quality: s.minimumQuality }, s.maximumQuality);

  // 3b — shrink the dimensions at floor quality
  const longEdge = Math.max(raw.width, raw.height);
  let scale = 1;
  const floorScale = Math.min(1, s.minimumLongEdge / longEdge);
  while (scale > floorScale && attempts < MAX_ENCODE_ATTEMPTS) {
    const step = Math.min(MAX_STEP, Math.max(MIN_STEP, Math.sqrt(targetBytes / last.sizeBytes) * 0.95));
    scale = Math.max(floorScale, scale * step);
    last = await run(scale, s.minimumQuality);
    if (last.sizeBytes <= targetBytes) return climb(scale, { img: last, quality: s.minimumQuality }, s.maximumQuality);
  }

  // 5 — target unreachable inside the configured bounds: keep the best (smallest) valid result
  const best = smallest!;
  return done(best.img, best.quality, best.scale, false);
}

/**
 * Produces the enabled variants from the ORIGINAL bytes. The source buffer is never modified.
 * Throws ImageProcessingError (safe code/message) if the source cannot be decoded or encoded.
 */
export async function processImage(source: Buffer, s: PhotographySettings): Promise<ProcessResult> {
  if (!s.generateOptimized && !s.generateThumbnail) return { optimized: null, thumbnail: null };
  const raw = await decode(source, s);
  const optimized = s.generateOptimized ? await optimize(raw, s) : null;
  let thumbnail: EncodedImage | null = null;
  let thumbnailError: ProcessingErrorCode | undefined;
  if (s.generateThumbnail) {
    try {
      thumbnail = await encode(raw, s.thumbnailFormat, s.thumbnailQuality, undefined, { w: s.thumbnailWidth, h: s.thumbnailHeight, crop: s.thumbnailCrop });
    } catch (e) {
      thumbnailError = e instanceof ImageProcessingError ? e.code : 'ENCODE_FAILED';
    }
  }
  return { optimized, thumbnail, thumbnailError };
}
