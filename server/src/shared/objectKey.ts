// ═══════════════════════════════════════════════════════════════════════════
// OBJECT STORAGE KEY RULE (MinIO / S3-compatible). Object storage is not wired up yet — nothing uploads
// or downloads a file today — so this establishes the boundary BEFORE the first upload exists:
//
//     companies/<companyId>/<segment>/<segment>/...
//
// Never a bare `uploads/tags/123.jpg`. Every object is stored under, and only ever served from, its own
// company's prefix:
//   - keys are BUILT here (companyObjectKey), never concatenated by hand;
//   - any key that arrives from a client or a database row is CHECKED here (assertObjectKeyBelongsToCompany)
//     before it is used to read/sign/delete — guessing another company's key gets a 404, not the object;
//   - design_files.filePath carries a database CHECK that it starts with its own company's prefix.
// Bucket policy in production should additionally deny access outside the runtime identity's prefix.
// ═══════════════════════════════════════════════════════════════════════════

import { AppError } from '../middleware/error';

const COMPANY_ID = /^[a-z0-9]{20,32}$/;
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function companyObjectPrefix(companyId: string): string {
  if (!COMPANY_ID.test(companyId)) throw new Error('object key requires a valid companyId');
  return `companies/${companyId}/`;
}

/** Builds a key inside the company's own prefix. Rejects traversal, empty and odd segments. */
export function companyObjectKey(companyId: string, ...segments: string[]): string {
  if (segments.length === 0) throw new Error('object key requires at least one segment');
  for (const s of segments) {
    if (!SEGMENT.test(s) || s.includes('..')) throw new Error(`invalid object key segment: ${JSON.stringify(s)}`);
  }
  return companyObjectPrefix(companyId) + segments.join('/');
}

/**
 * Validates a key received from outside (request, database row) against the caller's company.
 * A key under another company's prefix, a bare/unprefixed key, or a traversal attempt is the same 404
 * as a missing object — it must not reveal that the object exists.
 */
export function assertObjectKeyBelongsToCompany(companyId: string, key: string): string {
  const prefix = companyObjectPrefix(companyId);
  const normalized = String(key ?? '');
  const ok =
    normalized.startsWith(prefix) &&
    normalized.length > prefix.length &&
    !normalized.includes('..') && !normalized.includes('//') && !normalized.includes('\\') && !normalized.includes('\0') &&
    normalized.slice(prefix.length).split('/').every((s) => SEGMENT.test(s));
  if (!ok) throw new AppError('File not found', 404);
  return normalized;
}

// ── Photography (TagImage) keys ──────────────────────────────────────────────────────────────────────────
//   companies/<companyId>/photography/tags/<tagId>/images/<imageId>/<variant>.<ext>
// Built ONLY from server-held ids + a fixed variant/extension vocabulary — never from a client filename or
// key, and never from a branch (a photo belongs to its tag; the tag branch can change).
export const PHOTO_VARIANTS = ['original', 'optimized', 'thumbnail'] as const;
export type PhotoVariant = (typeof PHOTO_VARIANTS)[number];
export const PHOTO_EXTENSIONS = ['jpg', 'png', 'webp'] as const;
export type PhotoExtension = (typeof PHOTO_EXTENSIONS)[number];

const ENTITY_ID = /^[a-z0-9]{20,32}$/; // cuid, same shape as companyId

export function photographyImageKey(
  companyId: string, tagId: string, imageId: string, variant: PhotoVariant, ext: PhotoExtension,
): string {
  if (!ENTITY_ID.test(tagId)) throw new Error('photography key requires a valid tagId');
  if (!ENTITY_ID.test(imageId)) throw new Error('photography key requires a valid imageId');
  if (!(PHOTO_VARIANTS as readonly string[]).includes(variant)) throw new Error(`invalid photo variant: ${variant}`);
  if (!(PHOTO_EXTENSIONS as readonly string[]).includes(ext)) throw new Error(`invalid photo extension: ${ext}`);
  return companyObjectKey(companyId, 'photography', 'tags', tagId, 'images', imageId, `${variant}.${ext}`);
}
