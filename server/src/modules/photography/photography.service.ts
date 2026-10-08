// Photography backend (Phase 2). Everything runs as
//   authenticate → resolveTenantContext → service(ctx) → tenantQuery / tenantTransaction → CompanyStorage
// The company ALWAYS comes from ctx; tag and station come from the database (lookup / capture ticket), never from
// a request-supplied company or key. Object storage is never touched inside a DB transaction.
//
// Upload sequence (see shared/storage/companyStorage.ts for the rationale):
//   1. validate ticket + bytes (size / magic bytes / declared type) — nothing is written yet
//   2. DB:      find-or-create the TagImage row by (companyId, idempotencyKey) as PENDING / not primary  [own tx]
//   3. storage: putImage → key built from server ids, SHA-256 verified, stored size verified            [no DB handle]
//   4. DB:      ONE transaction under a tag row lock: demote the old live PRIMARY (if any), mark this row
//               CONFIRMED with key / size / sha256 / dimensions                                          [own tx]
// Failure states (all recoverable by retrying with the SAME idempotencyKey):
//   • crash after 2, before 3   → PENDING row, no object          → retry uploads and confirms
//   • storage put failed        → row set FAILED, no/partial obj  → retry uploads and confirms
//   • crash/DB error after 3    → PENDING row + ORPHAN OBJECT     → retry re-puts the same key and confirms
//   If the client never retries, the PENDING/FAILED row (and any object) stay until the reconciliation phase
//   (verifyObject / orphan sweep — design in docs/photography-storage-foundation.md; no job exists yet).
import { Prisma } from '@prisma/client';
import { env } from '../../config/env';
import { AppError } from '../../middleware/error';
import { createAuditEntry } from '../../middleware/audit';
import { tenantQuery, tenantBatch, tenantTransaction, canAccessBranch, type TenantContext } from '../../shared/tenantContext';
import {
  MAX_SIGNED_URL_TTL_SECONDS, SNIFF_BYTES, assertImageContent, assertSizeWithin, sha256Hex, storageForCompany,
} from '../../shared/storage';
import { CAPTURE_SOURCES, TICKET_TTL_SECONDS, issueCaptureTicket, verifyCaptureTicket, type CaptureSource } from './captureTicket';
import { readImageDimensions } from './imageDimensions';
import { processTagImage } from './imageProcessing.service';
import { toCameraDto } from './stationCameras';

export const IMAGE_TYPES = ['PRIMARY', 'SIDE', 'BACK', 'DETAIL', 'OTHER'] as const;
export type ImageType = (typeof IMAGE_TYPES)[number];
export const IMAGE_VARIANTS = ['original', 'optimized', 'thumbnail'] as const;
export type ImageVariant = (typeof IMAGE_VARIANTS)[number];

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{8,128}$/;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

const imageSelect = {
  id: true, tagId: true, imageType: true, isPrimary: true, reviewStatus: true, uploadStatus: true, processingStatus: true,
  originalFilename: true, mimeType: true, width: true, height: true, sizeBytes: true, sha256: true,
  captureSource: true, cameraLabel: true, capturedAt: true, createdAt: true,
  storageKeyOriginal: true, storageKeyOptimized: true, storageKeyThumbnail: true,
  station: { select: { id: true, name: true } },
} satisfies Prisma.TagImageSelect;
type ImageRow = Prisma.TagImageGetPayload<{ select: typeof imageSelect }>;

/** API shape: metadata only — storage keys are reduced to "which variants exist", never returned. */
export function toDto(r: ImageRow) {
  const { storageKeyOriginal, storageKeyOptimized, storageKeyThumbnail, sizeBytes, ...rest } = r;
  return {
    ...rest,
    sizeBytes: sizeBytes === null ? null : Number(sizeBytes),
    variants: { original: !!storageKeyOriginal, optimized: !!storageKeyOptimized, thumbnail: !!storageKeyThumbnail },
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function str(v: unknown, label: string, max: number, required = false): string | undefined {
  if (v === undefined || v === null || v === '') {
    if (required) throw new AppError(`${label} is required`, 400);
    return undefined;
  }
  if (typeof v !== 'string') throw new AppError(`${label} must be a string`, 400);
  const s = v.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (required && !s) throw new AppError(`${label} is required`, 400);
  if (s.length > max) throw new AppError(`${label} is too long (max ${max})`, 400);
  return s || undefined;
}

/** A tag of this company the caller's branch grants reach. Anything else — missing, other company, other branch — is the same 404. */
export async function loadTag(ctx: TenantContext, where: { id?: string; tagNumber?: string }) {
  const tag = await tenantQuery(ctx.companyId, (tx) => tx.jewelryTag.findFirst({
    where: { companyId: ctx.companyId, ...where },
    select: {
      id: true, tagNumber: true, name: true, status: true, branchId: true, metalType: true, metalKarat: true,
      grossWeight: true, netWeight: true, branch: { select: { id: true, name: true } },
      category: { select: { id: true, name: true } },
    },
  }));
  if (!tag || !canAccessBranch(ctx, tag.branchId)) throw new AppError('Tag not found', 404);
  return tag;
}

export async function loadStation(ctx: TenantContext, id: unknown) {
  if (typeof id !== 'string' || !id) throw new AppError('stationId is required', 400);
  const st = await tenantQuery(ctx.companyId, (tx) => tx.photographyStation.findFirst({
    where: { id, companyId: ctx.companyId }, select: { id: true, name: true, branchId: true, isActive: true },
  }));
  // Missing, other company, or a branch the caller has no grant for — all the same 404 (matches what listStations shows).
  if (!st || !canAccessBranch(ctx, st.branchId)) throw new AppError('Station not found', 404);
  if (!st.isActive) throw new AppError('Station is inactive', 409);
  return st;
}

/** V1 rule: a piece is photographed at a station of the branch it is currently in. The caller can already see both
 *  (loadTag / loadStation passed), so naming the mismatch discloses nothing about another branch or company. */
export function assertSameBranch(tag: { branchId: string }, station: { branchId: string }) {
  if (tag.branchId !== station.branchId) throw new AppError('This station is in a different branch from the tag', 409);
}

// ── 0. station list ──────────────────────────────────────────────────────────

/** Active stations of this company in the caller's branches. DTO only: no credentials, hashes or registrant.
 *  `lastSeenAt` is set only by an authenticated Camera Bridge heartbeat (null until one arrives); never infer "online" from anything else. */
export async function listStations(ctx: TenantContext) {
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.photographyStation.findMany({
    where: { companyId: ctx.companyId, isActive: true, ...(ctx.branchAccess.allBranches ? {} : { branchId: { in: ctx.branchAccess.branchIds } }) },
    select: {
      id: true, name: true, branchId: true, isActive: true, lastSeenAt: true, branch: { select: { name: true } },
      reportedCameras: true, camerasReportedAt: true, requestedCameraId: true, cameraRequestedAt: true,
    },
    orderBy: { name: 'asc' },
  }));
  return rows.map((r) => ({ id: r.id, name: r.name, branchId: r.branchId, branchName: r.branch.name, isActive: r.isActive, lastSeenAt: r.lastSeenAt, cameras: toCameraDto(r) }));
}

function findImageByKey(ctx: TenantContext, idempotencyKey: string) {
  return tenantQuery(ctx.companyId, (tx) => tx.tagImage.findFirst({
    where: { companyId: ctx.companyId, idempotencyKey },
    select: { id: true, tagId: true, uploadStatus: true, sha256: true, deletedAt: true },
  }));
}

function isUniqueViolation(e: unknown): boolean {
  return e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002';
}

export function getImage(ctx: TenantContext, id: string) {
  return tenantQuery(ctx.companyId, (tx) => tx.tagImage.findFirst({ where: { id, companyId: ctx.companyId }, select: imageSelect }));
}

/** A live (not soft-deleted) image of this company on a tag the caller's branch grants reach — else the same 404. */
async function loadLiveImage(ctx: TenantContext, imageId: unknown) {
  if (typeof imageId !== 'string' || !imageId) throw new AppError('Image not found', 404);
  const row = await tenantQuery(ctx.companyId, (tx) => tx.tagImage.findFirst({
    where: { id: imageId, companyId: ctx.companyId, deletedAt: null },
    select: { ...imageSelect, tag: { select: { branchId: true } } },
  }));
  if (!row || !canAccessBranch(ctx, row.tag.branchId)) throw new AppError('Image not found', 404);
  return row;
}

// ── 1. tag lookup ────────────────────────────────────────────────────────────

export async function lookupTagForPhotography(ctx: TenantContext, tagNumber: string) {
  const n = str(tagNumber, 'Tag number', 100, true)!;
  const tag = await loadTag(ctx, { tagNumber: n });
  const live = await tenantQuery(ctx.companyId, (tx) => tx.tagImage.findMany({
    where: { companyId: ctx.companyId, tagId: tag.id, deletedAt: null, uploadStatus: 'CONFIRMED' },
    select: { id: true, isPrimary: true, capturedAt: true },
  }));
  const primary = live.find((i) => i.isPrimary);
  return {
    id: tag.id, tagNumber: tag.tagNumber, name: tag.name, status: tag.status,
    metalType: tag.metalType, metalKarat: tag.metalKarat,
    grossWeight: tag.grossWeight.toString(), netWeight: tag.netWeight.toString(),
    branch: tag.branch, category: tag.category,
    photography: {
      imageCount: live.length,
      hasPrimary: !!primary,
      primaryImageId: primary?.id ?? null,
      lastCapturedAt: live.reduce<Date | null>((m, i) => (!m || i.capturedAt > m ? i.capturedAt : m), null),
    },
  };
}

// ── 2. capture session ───────────────────────────────────────────────────────

export async function startCaptureSession(ctx: TenantContext, input: { tagId?: unknown; stationId?: unknown; captureSource?: unknown }) {
  if (typeof input.tagId !== 'string' || !input.tagId) throw new AppError('tagId is required', 400);
  const source = (input.captureSource ?? 'DEVICE_CAMERA') as CaptureSource;
  if (!CAPTURE_SOURCES.includes(source)) throw new AppError(`captureSource must be one of ${CAPTURE_SOURCES.join(', ')}`, 400);
  const tag = await loadTag(ctx, { id: input.tagId });
  const station = await loadStation(ctx, input.stationId);
  assertSameBranch(tag, station);
  // lastSeenAt is deliberately NOT touched: it is reserved for the Camera Bridge heartbeat, and a user starting a
  // session says nothing about whether the station is online.
  const t = issueCaptureTicket({ cid: ctx.companyId, tid: tag.id, sid: station.id, uid: ctx.userId, src: source });
  return {
    sessionId: t.sessionId, ticket: t.ticket, expiresAt: t.expiresAt, expiresInSeconds: TICKET_TTL_SECONDS,
    stationId: station.id, tagId: tag.id, tagNumber: tag.tagNumber,
    operations: ['upload'], captureSource: source,
    tag: { id: tag.id, tagNumber: tag.tagNumber }, station: { id: station.id, name: station.name },
  };
}

// ── 3. upload ────────────────────────────────────────────────────────────────

export interface UploadInput {
  ticket: unknown; tagId?: unknown; stationId?: unknown;
  imageType: unknown; idempotencyKey: unknown; cameraLabel?: unknown; capturedAt?: unknown;
  /** Set only by the station upload path (Phase 5D): recorded in the audit entry, never an authority. */
  commandId?: string;
  file?: { buffer: Buffer; originalname?: string; mimetype?: string };
}

export interface UploadResult {
  image: ReturnType<typeof toDto>;
  /** true when an earlier request with the same idempotencyKey had already completed — nothing new was written. */
  idempotentReplay: boolean;
  /** The previous live PRIMARY that this upload replaced (now imageType OTHER, still stored and listed). */
  replacedPrimaryImageId: string | null;
}

type Claim = { kind: 'REPLAY'; imageId: string } | { kind: 'WORK'; imageId: string };

export async function uploadImage(ctx: TenantContext, input: UploadInput): Promise<UploadResult> {
  // — ticket: must be ours (company + user), and for the tag/station the caller names, if it names any —
  const claims = verifyCaptureTicket(input.ticket);
  if (claims.cid !== ctx.companyId || claims.uid !== ctx.userId) throw new AppError('Invalid capture ticket', 401);
  if (input.tagId !== undefined && input.tagId !== claims.tid) throw new AppError('Capture ticket was not issued for this tag', 403);
  if (input.stationId !== undefined && input.stationId !== claims.sid) throw new AppError('Capture ticket was not issued for this station', 403);

  const imageType = input.imageType as ImageType;
  if (!IMAGE_TYPES.includes(imageType)) throw new AppError(`imageType must be one of ${IMAGE_TYPES.join(', ')}`, 400);
  const idempotencyKey = str(input.idempotencyKey, 'idempotencyKey', 128, true)!;
  if (!IDEMPOTENCY_KEY.test(idempotencyKey)) throw new AppError('idempotencyKey must be 8-128 characters of letters, digits, . _ : -', 400);
  const cameraLabel = str(input.cameraLabel, 'cameraLabel', 100);
  let capturedAt = new Date();
  if (input.capturedAt !== undefined && input.capturedAt !== '') {
    const d = new Date(String(input.capturedAt));
    if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + MAX_CLOCK_SKEW_MS) throw new AppError('capturedAt is not a valid past timestamp', 400);
    capturedAt = d;
  }

  // — bytes: size + real format + declared type/extension, before anything is written anywhere —
  const file = input.file;
  if (!file || !file.buffer) throw new AppError('An image file is required', 400);
  assertSizeWithin(file.buffer.length, env.PHOTO_MAX_UPLOAD_BYTES);
  const declaredMime = file.mimetype && file.mimetype !== 'application/octet-stream' ? file.mimetype : undefined;
  const originalFilename = str((file.originalname ?? '').split(/[\\/]/).pop(), 'filename', 255);
  const declared = { mimeType: declaredMime, filename: originalFilename };
  const sniffed = assertImageContent(file.buffer.subarray(0, SNIFF_BYTES), declared);
  const sha256 = sha256Hex(file.buffer);

  // — re-validate the ticket's subjects NOW (a station can be deactivated, a tag moved, mid-session) —
  const tag = await loadTag(ctx, { id: claims.tid });
  const station = await loadStation(ctx, claims.sid);
  assertSameBranch(tag, station); // the tag may have moved branch since the session started

  // — step 2: find-or-create the PENDING row —
  const claim = await claimRow();
  if (claim.kind === 'REPLAY') {
    const done = await getImage(ctx, claim.imageId);
    return { image: toDto(done!), idempotentReplay: true, replacedPrimaryImageId: null };
  }
  const imageId = claim.imageId;

  // — step 3: storage (no DB handle held) —
  let stored: { key: string; sizeBytes: number; sha256: string; contentType: string };
  try {
    stored = await storageForCompany(ctx.companyId).putImage({
      tagId: tag.id, imageId, variant: 'original', body: file.buffer, declared, expectedSha256: sha256,
    });
  } catch (e) {
    await tenantQuery(ctx.companyId, (tx) => tx.tagImage.updateMany({
      where: { id: imageId, companyId: ctx.companyId, uploadStatus: { not: 'CONFIRMED' } }, data: { uploadStatus: 'FAILED' },
    })).catch(() => undefined); // best effort — a stale PENDING row is retried the same way
    throw e instanceof AppError ? e : new AppError('Image storage is unavailable; retry with the same idempotencyKey', 502);
  }

  // — step 4: confirm (+ atomic primary replacement) in one transaction, serialised per tag —
  const dims = readImageDimensions(file.buffer, stored.contentType);
  const outcome = await tenantTransaction(ctx.companyId, async (tx) => {
    await tx.$queryRaw`SELECT id FROM jewelry_tags WHERE id = ${tag.id} AND "companyId" = ${ctx.companyId} FOR UPDATE`;
    const row = await tx.tagImage.findFirst({ where: { id: imageId, companyId: ctx.companyId }, select: { uploadStatus: true } });
    if (!row) throw new AppError('Upload row disappeared; retry with the same idempotencyKey', 409);
    if (row.uploadStatus === 'CONFIRMED') return { replacedId: null as string | null, replacedType: null as string | null, raced: true };

    let replacedId: string | null = null;
    let replacedType: string | null = null;
    if (imageType === 'PRIMARY') {
      const old = await tx.tagImage.findFirst({
        where: { companyId: ctx.companyId, tagId: tag.id, isPrimary: true, deletedAt: null, id: { not: imageId } },
        select: { id: true, imageType: true },
      });
      if (old) {
        // The old primary is kept (and its object untouched); it just stops being THE primary. isPrimary and
        // imageType are tied by a CHECK, so "not primary" necessarily means a non-PRIMARY type — OTHER.
        await tx.tagImage.update({ where: { id: old.id }, data: { imageType: 'OTHER', isPrimary: false } });
        replacedId = old.id; replacedType = old.imageType;
      }
    }
    await tx.tagImage.update({
      where: { id: imageId },
      data: {
        imageType, isPrimary: imageType === 'PRIMARY', uploadStatus: 'CONFIRMED',
        storageKeyOriginal: stored.key, mimeType: stored.contentType, sizeBytes: BigInt(stored.sizeBytes), sha256: stored.sha256,
        width: dims?.width ?? null, height: dims?.height ?? null,
        originalFilename, captureSource: claims.src, cameraLabel: cameraLabel ?? null, stationId: station.id,
        capturedById: ctx.userId, capturedAt,
      },
    });
    return { replacedId, replacedType, raced: false };
  });

  if (!outcome.raced) {
    await createAuditEntry('tag_images', imageId, ctx.userId, 'CAPTURE', undefined, {
      tagId: tag.id, imageType, stationId: station.id, captureSource: claims.src, sizeBytes: stored.sizeBytes, sha256: stored.sha256, sessionId: claims.sess,
      ...(input.commandId ? { commandId: input.commandId } : {}),
    }, ctx.companyId);
    if (outcome.replacedId) {
      await createAuditEntry('tag_images', outcome.replacedId, ctx.userId, 'REPLACE', { imageType: outcome.replacedType, isPrimary: true },
        { imageType: 'OTHER', isPrimary: false, replacedBy: imageId }, ctx.companyId);
    }
  }
  // — step 5: derive the optimized image + thumbnail from the stored original, using the company's current settings.
  // The upload is already durable and confirmed; a processing failure is recorded on the row (processingStatus
  // FAILED, retriable) and must never fail or undo the upload itself. —
  if (!outcome.raced) await processTagImage({ companyId: ctx.companyId, userId: ctx.userId }, imageId).catch(() => undefined);
  const final = await getImage(ctx, imageId);
  return { image: toDto(final!), idempotentReplay: outcome.raced, replacedPrimaryImageId: outcome.replacedId };

  async function claimRow(): Promise<Claim> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const existing = await findImageByKey(ctx, idempotencyKey);
      if (existing) {
        if (existing.tagId !== tag.id) throw new AppError('idempotencyKey was already used for a different request', 409);
        if (existing.deletedAt) throw new AppError('This upload was deleted; use a new idempotencyKey to upload again', 409);
        if (existing.uploadStatus === 'CONFIRMED') {
          if (existing.sha256 !== sha256) throw new AppError('idempotencyKey was already used for a different image', 409);
          return { kind: 'REPLAY', imageId: existing.id };
        }
        return { kind: 'WORK', imageId: existing.id }; // PENDING / FAILED → resume
      }
      try {
        const row = await tenantQuery(ctx.companyId, (tx) => tx.tagImage.create({
          data: {
            companyId: ctx.companyId, tagId: tag.id, idempotencyKey,
            // Provisional: never PRIMARY until confirmed (a PENDING primary would hold the one-live-primary slot).
            imageType: 'OTHER', isPrimary: false, uploadStatus: 'PENDING', processingStatus: 'PENDING',
            mimeType: sniffed.contentType, originalFilename, captureSource: claims.src, cameraLabel,
            stationId: station.id, capturedById: ctx.userId, capturedAt,
          },
          select: { id: true },
        }));
        return { kind: 'WORK', imageId: row.id };
      } catch (e) {
        if (!isUniqueViolation(e)) throw e; // lost a race on the idempotency key → loop and re-read it
      }
    }
    throw new AppError('Could not reserve the upload; please retry', 409);
  }
}

// ── 4. list / signed URL / delete ────────────────────────────────────────────

export async function listTagImages(ctx: TenantContext, tagId: string) {
  const tag = await loadTag(ctx, { id: tagId });
  const rows = await tenantQuery(ctx.companyId, (tx) => tx.tagImage.findMany({
    where: { companyId: ctx.companyId, tagId: tag.id, deletedAt: null, uploadStatus: 'CONFIRMED' },
    select: imageSelect,
    orderBy: [{ isPrimary: 'desc' }, { capturedAt: 'desc' }],
  }));
  return rows.map(toDto);
}

export async function getImageSignedUrl(ctx: TenantContext, imageId: string, variant: unknown = 'original') {
  if (!IMAGE_VARIANTS.includes(variant as ImageVariant)) throw new AppError(`variant must be one of ${IMAGE_VARIANTS.join(', ')}`, 400);
  const row = await loadLiveImage(ctx, imageId);
  const key = variant === 'original' ? row.storageKeyOriginal : variant === 'optimized' ? row.storageKeyOptimized : row.storageKeyThumbnail;
  if (row.uploadStatus !== 'CONFIRMED' || !key) throw new AppError('Image not available', 404);
  const url = await storageForCompany(ctx.companyId).createSignedReadUrl(key);
  const ttl = Math.min(Math.max(Math.floor(env.STORAGE_SIGNED_URL_TTL_SECONDS), 1), MAX_SIGNED_URL_TTL_SECONDS);
  return { imageId: row.id, variant, url, expiresInSeconds: ttl, mimeType: row.mimeType };
}

/** Soft delete. The object is NOT removed — physical cleanup belongs to the storage-maintenance phase. */
export async function deleteImage(ctx: TenantContext, imageId: string, reason: unknown) {
  const why = str(reason, 'reason', 500, true)!;
  if (why.length < 3) throw new AppError('reason is too short', 400);
  const row = await loadLiveImage(ctx, imageId);
  const now = new Date();
  const n = await tenantTransaction(ctx.companyId, (tx) => tx.tagImage.updateMany({
    where: { id: row.id, companyId: ctx.companyId, deletedAt: null },
    data: { deletedAt: now, deletedById: ctx.userId, deleteReason: why },
  }));
  if (n.count !== 1) throw new AppError('Image not found', 404); // lost a race with another delete
  await createAuditEntry('tag_images', row.id, ctx.userId, 'DELETE',
    { imageType: row.imageType, isPrimary: row.isPrimary, deletedAt: null },
    { deletedAt: now.toISOString(), deletedById: ctx.userId, reason: why }, ctx.companyId);
  return { id: row.id, deleted: true };
}

// ── 5. dashboard contract ────────────────────────────────────────────────────
// Pure aggregation over existing rows (no counters stored anywhere). Branch-scoped like every other read: an image's
// branch is its tag's CURRENT branch. "Today" is the server's local calendar day.
// Storage usage is deliberately NOT reported: only the original's size is recorded on TagImage (variant sizes are not),
// and summing the object store would mean scanning it — a future storage-metrics feature, so it says so explicitly.
export async function getDashboard(ctx: TenantContext) {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const branchScope: Prisma.TagImageWhereInput = ctx.branchAccess.allBranches ? {} : { tag: { branchId: { in: ctx.branchAccess.branchIds } } };
  const live: Prisma.TagImageWhereInput = { companyId: ctx.companyId, deletedAt: null, uploadStatus: 'CONFIRMED', ...branchScope };
  const [today, pending, failed, reviewed, deletedToday, stations] = await tenantBatch(ctx.companyId, (tx) => [
    tx.tagImage.count({ where: { ...live, capturedAt: { gte: startOfDay } } }),
    tx.tagImage.count({ where: { ...live, processingStatus: 'PENDING' } }),
    tx.tagImage.count({ where: { ...live, processingStatus: 'FAILED' } }),
    tx.tagImage.count({ where: { ...live, reviewStatus: { in: ['APPROVED', 'REJECTED'] } } }),
    tx.tagImage.count({ where: { companyId: ctx.companyId, deletedAt: { gte: startOfDay }, ...branchScope } }),
    tx.photographyStation.count({ where: { companyId: ctx.companyId, isActive: true, ...(ctx.branchAccess.allBranches ? {} : { branchId: { in: ctx.branchAccess.branchIds } }) } }),
  ]);
  return {
    todaysPhotos: today, pendingProcessing: pending, processingFailed: failed, imagesReviewed: reviewed,
    imagesDeletedToday: deletedToday, activeStations: stations,
    storageUsage: { available: false, reason: 'Variant sizes are not recorded and the object store is not scanned; planned as a storage-metrics feature.' },
  };
}
