# Photography storage foundation (Phase 1.5)

Code: `server/src/shared/storage/` (+ `photographyImageKey` in `shared/objectKey.ts`). No endpoints yet.

## Layers
`CompanyStorage(companyId from tenant context)` → `StorageProvider` (`MinioStorageProvider` | `MemoryStorageProvider`).
Business code calls `storageForCompany(ctx.companyId)`; only `minioProvider.ts` imports the `minio` SDK
(enforced by the guard in `test/namespaces.test.ts`).

## Config (env)
`STORAGE_PROVIDER` (`minio` default; `memory` refused in production), `MINIO_ENDPOINT/PORT/USE_SSL/ACCESS_KEY/
SECRET_KEY/BUCKET_NAME` (names kept; address any S3-compatible endpoint, e.g. R2), `STORAGE_REGION`,
`STORAGE_SIGNED_URL_TTL_SECONDS` (default 300, hard max 900), `PHOTO_MAX_UPLOAD_BYTES` (default 25 MB).
Production bucket must be private; no public URL is ever stored in `TagImage`.

## Failure / retry boundary
Never touch storage inside a Prisma transaction. Sequence: (1) DB row PENDING, committed → (2) `putImage`
(size/format/SHA-256 verified, `head` confirms stored size) → (3) DB update with keys/size/sha256 → UPLOADED.
`putImage` is safe to retry: keys are deterministic per (tag, image, variant), so a retry overwrites.

## Reconciliation (design only; no job built)
| Situation | Handling |
|---|---|
| Row exists, object missing | `verifyObject` → `MISSING`; mark `uploadStatus` FAILED/PENDING, client re-uploads by idempotencyKey |
| Object exists, no row | Orphan under `companies/<c>/photography/tags/<t>/images/<i>/`; a sweeper lists the prefix, deletes objects with no matching `TagImage` older than a grace period |
| Upload ok, DB update failed | Same as orphan until retry; retry recomputes the same key and finishes step 3 |
| Row soft-deleted, object remains | Intentional (restore needs it); purge object only on an explicit hard purge / retention policy, via `deleteObject` |

## Supported formats
JPEG, PNG, WebP, by magic bytes. Sony RAW (ARW), HEIC: **not supported** until real samples are inspected.
