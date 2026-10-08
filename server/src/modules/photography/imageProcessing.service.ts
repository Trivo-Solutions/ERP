// Orchestrates image processing for one TagImage:
//   settings (DB) → original (StorageProvider) → ImageProcessor (pure) → variants (StorageProvider) → TagImage row.
// The original object is only ever READ here — never overwritten or deleted, whatever happens. Storage is not
// touched inside a DB transaction. The same function serves first-time processing, retry after FAILED and a
// future "reprocess with the current settings": it always works from the stored original and the settings in force
// NOW, so changing a setting affects new/re-processed images only — existing variants are never silently rewritten.
//
// processingStatus (existing column, CHECK PENDING | READY | FAILED — there is no PROCESSING value, so a run in
// flight is simply still PENDING):
//   READY  — every enabled variant was produced and recorded
//   FAILED — decode/encode/storage error, or the thumbnail failed after the optimized image succeeded (the optimized
//            key is kept, the row stays FAILED so it is retried). The reason is a short code in the audit trail, never
//            library text. Retry = call processTagImage again.
// "Target size not reached" is NOT a failure: the best valid result is stored, status READY, and the fact is
// recorded in the PROCESS audit entry (targetReached: false).
import { createAuditEntry } from '../../middleware/audit';
import { env } from '../../config/env';
import { logger } from '../../config/logger';
import { AppError } from '../../middleware/error';
import { tenantQuery } from '../../shared/tenantContext';
import { sha256Hex, storageForCompany } from '../../shared/storage';
import { ImageProcessingError, processImage, type EncodedImage } from './imageProcessor';
import { loadPhotographySettings, type PhotographySettings } from './photographySettings';

/** Who is processing — only used for the audit entry. Deliberately not a TenantContext: no permissions involved. */
export interface ProcessingActor { companyId: string; userId: string }

export interface ProcessingOutcome {
  imageId: string;
  status: 'READY' | 'FAILED';
  failureCode?: string;
  optimized?: { sizeBytes: number; width: number; height: number; quality: number; targetReached: boolean; targetBytes: number; sha256: string };
  thumbnail?: { sizeBytes: number; width: number; height: number; sha256: string };
}

// ── concurrency: an operational limit (env), not a company setting; no queue, callers simply wait their turn ──
let running = 0;
const waiting: Array<() => void> = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  const limit = Math.max(1, Math.floor(env.PHOTO_PROCESSING_CONCURRENCY) || 1);
  if (running >= limit) await new Promise<void>((r) => waiting.push(r));
  running++;
  try { return await fn(); } finally { running--; waiting.shift()?.(); }
}

async function readAll(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function markFailed(actor: ProcessingActor, imageId: string, code: string, extra: Record<string, unknown> = {}) {
  await tenantQuery(actor.companyId, (tx) => tx.tagImage.updateMany({
    where: { id: imageId, companyId: actor.companyId, deletedAt: null }, data: { processingStatus: 'FAILED', ...extra },
  })).catch(() => undefined);
  await createAuditEntry('tag_images', imageId, actor.userId, 'PROCESS_FAILED', undefined, { code }, actor.companyId).catch(() => undefined);
  logger.warn(`photography: processing failed image=${imageId} code=${code}`);
}

/** Processes (or re-processes) one confirmed image of the actor's company using that company's CURRENT settings. */
export async function processTagImage(actor: ProcessingActor, imageId: string): Promise<ProcessingOutcome> {
  const row = await tenantQuery(actor.companyId, (tx) => tx.tagImage.findFirst({
    where: { id: imageId, companyId: actor.companyId, deletedAt: null },
    select: { id: true, tagId: true, uploadStatus: true, storageKeyOriginal: true, sha256: true, storageKeyOptimized: true, storageKeyThumbnail: true },
  }));
  if (!row) throw new AppError('Image not found', 404);
  if (row.uploadStatus !== 'CONFIRMED' || !row.storageKeyOriginal) throw new AppError('Image has no stored original to process', 409);

  const settings = await loadPhotographySettings(actor.companyId);
  const storage = storageForCompany(actor.companyId);

  return withSlot(async () => {
    // 1. the original — read only, and verified against the hash recorded at upload
    let source: Buffer;
    try {
      source = await readAll(await storage.streamObject(row.storageKeyOriginal!));
    } catch {
      await markFailed(actor, row.id, 'ORIGINAL_UNAVAILABLE');
      return { imageId: row.id, status: 'FAILED', failureCode: 'ORIGINAL_UNAVAILABLE' };
    }
    if (row.sha256 && sha256Hex(source) !== row.sha256) {
      await markFailed(actor, row.id, 'ORIGINAL_CHECKSUM_MISMATCH');
      return { imageId: row.id, status: 'FAILED', failureCode: 'ORIGINAL_CHECKSUM_MISMATCH' };
    }

    // 2. pure processing
    let result;
    try {
      result = await processImage(source, settings);
    } catch (e) {
      const code = e instanceof ImageProcessingError ? e.code : 'PROCESSING_ERROR';
      await markFailed(actor, row.id, code);
      return { imageId: row.id, status: 'FAILED', failureCode: code };
    }

    // 3. variants → storage (no DB handle held). A failed put leaves the original and the row's old keys untouched.
    const put = async (variant: 'optimized' | 'thumbnail', img: EncodedImage) =>
      (await storage.putImage({ tagId: row.tagId, imageId: row.id, variant, body: img.buffer, expectedSha256: img.sha256 })).key;
    let optimizedKey: string | undefined;
    let thumbnailKey: string | undefined;
    try {
      if (result.optimized) optimizedKey = await put('optimized', result.optimized);
      if (result.thumbnail) thumbnailKey = await put('thumbnail', result.thumbnail);
    } catch {
      // keep whatever was already stored for the OTHER variant so a retry is cheap, but record the failure
      await markFailed(actor, row.id, 'VARIANT_STORAGE_FAILED', optimizedKey ? { storageKeyOptimized: optimizedKey } : {});
      return { imageId: row.id, status: 'FAILED', failureCode: 'VARIANT_STORAGE_FAILED' };
    }

    // 4. record it. Thumbnail failing independently still keeps the optimized image but leaves the row retriable.
    const thumbFailed = !!result.thumbnailError;
    const status = thumbFailed ? 'FAILED' : 'READY';
    const n = await tenantQuery(actor.companyId, (tx) => tx.tagImage.updateMany({
      where: { id: row.id, companyId: actor.companyId, deletedAt: null },
      data: {
        processingStatus: status,
        ...(optimizedKey && { storageKeyOptimized: optimizedKey }),
        ...(thumbnailKey && { storageKeyThumbnail: thumbnailKey }),
      },
    }));
    if (n.count !== 1) throw new AppError('Image not found', 404); // deleted while processing

    // A format change (WEBP→JPEG) leaves the previous variant object behind under a different extension: remove it.
    for (const [old, now] of [[row.storageKeyOptimized, optimizedKey], [row.storageKeyThumbnail, thumbnailKey]] as const) {
      if (old && now && old !== now) await storage.deleteObject(old).catch(() => undefined);
    }

    const o = result.optimized;
    const outcome: ProcessingOutcome = {
      imageId: row.id, status,
      ...(thumbFailed && { failureCode: result.thumbnailError }),
      ...(o && { optimized: { sizeBytes: o.sizeBytes, width: o.width, height: o.height, quality: o.quality, targetReached: o.targetReached, targetBytes: o.targetBytes, sha256: o.sha256 } }),
      ...(result.thumbnail && { thumbnail: { sizeBytes: result.thumbnail.sizeBytes, width: result.thumbnail.width, height: result.thumbnail.height, sha256: result.thumbnail.sha256 } }),
    };
    await createAuditEntry('tag_images', row.id, actor.userId, thumbFailed ? 'PROCESS_FAILED' : 'PROCESS', undefined,
      { ...outcome, settings: settingsSnapshot(settings) }, actor.companyId).catch(() => undefined);
    return outcome;
  });
}

/** The settings that shaped this run — kept in the audit entry so a later "why is this 300 KB?" is answerable. */
function settingsSnapshot(s: PhotographySettings) {
  return {
    targetOptimizedSizeKB: s.targetOptimizedSizeKB, minimumQuality: s.minimumQuality, maximumQuality: s.maximumQuality,
    maximumWidth: s.maximumWidth, maximumHeight: s.maximumHeight, optimizedFormat: s.optimizedFormat,
    thumbnailWidth: s.thumbnailWidth, thumbnailHeight: s.thumbnailHeight, thumbnailFormat: s.thumbnailFormat, autoOrient: s.autoOrient,
  };
}

/** Future "reprocess" entry point: same pipeline, current settings, from the stored original. Not routed yet. */
export const reprocessTagImage = processTagImage;
