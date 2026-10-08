// CompanyStorage — the ONLY object-storage API business code (Photography) should call.
//
//   authenticate → resolveTenantContext → tenant-aware service → CompanyStorage(ctx.companyId) → provider
//
// The company is bound at construction from the server-side tenant context; no method accepts a companyId, and
// no method accepts a free-form key to WRITE — put keys are built from ids here. Keys that arrive from a DB row
// (read / delete / sign) are checked against the bound company AND the namespace, so a key from another company
// (or from outside the namespace) is the same 404 as a missing object.
//
// OBJECT STORAGE vs DATABASE — never call these inside a Prisma transaction (different failure semantics: a
// rolled-back transaction cannot un-upload, and a slow upload would hold the transaction open). Intended order:
//   1. DB: create/prepare the row (uploadStatus PENDING)                  — own transaction, committed
//   2. storage: putImage(...)                                              — no DB handle held
//   3. DB: record keys / sizeBytes / sha256, uploadStatus UPLOADED         — own transaction
// A crash between 2 and 3 leaves an orphan OBJECT (harmless, private, found by reconciliation); a crash between
// 1 and 2 leaves a PENDING row with no object (retryable by idempotencyKey). See docs/photography-storage-foundation.md.
import { Readable, pipeline } from 'stream';
import { AppError } from '../../middleware/error';
import {
  assertObjectKeyBelongsToCompany, companyObjectPrefix, photographyImageKey,
  type PhotoExtension, type PhotoVariant,
} from '../objectKey';
import { UploadInspector } from './hashing';
import type { PutResult, StorageProvider } from './types';

export const MAX_SIGNED_URL_TTL_SECONDS = 900;

export interface CompanyStorageOptions {
  /** Hard cap per uploaded object. */
  maxUploadBytes: number;
  /** Default signed-URL lifetime (clamped to 1..MAX_SIGNED_URL_TTL_SECONDS). */
  signedUrlTtlSeconds: number;
}

export interface PutImageInput {
  tagId: string;
  imageId: string;
  variant: PhotoVariant;
  body: Buffer | Readable;
  /** What the client CLAIMED — checked against the real content, never trusted. */
  declared?: { mimeType?: string; filename?: string };
  /** If supplied, the stored bytes must hash to this; a mismatch deletes the object and throws. */
  expectedSha256?: string;
}

export type ObjectVerification = 'OK' | 'MISSING' | 'SIZE_MISMATCH';

export class CompanyStorage {
  private readonly namespacePrefix: string;

  constructor(
    private readonly provider: StorageProvider,
    readonly companyId: string,
    private readonly opts: CompanyStorageOptions,
  ) {
    this.namespacePrefix = `${companyObjectPrefix(companyId)}photography/`; // also validates companyId
  }

  /** Uploads one variant of a tag image. The key is generated here from server-held ids. */
  async putImage(input: PutImageInput): Promise<PutResult> {
    const body = Buffer.isBuffer(input.body) ? Readable.from([input.body]) : input.body;
    const inspector = new UploadInspector(this.opts.maxUploadBytes, input.declared);
    const failure: { error: Error | null } = { error: null };
    inspector.on('error', (e) => { failure.error ??= e; });
    pipeline(body, inspector, (e) => { if (e) failure.error ??= e; });

    // The key's extension comes from the sniffed content, so it is only known after inspection. Uploads are
    // capped (maxUploadBytes, enforced mid-stream), so collect the inspected bytes, then put under the final key.
    const chunks: Buffer[] = [];
    try {
      for await (const c of inspector) chunks.push(c as Buffer);
    } catch { /* surfaced below as the inspector's own AppError */ }
    if (failure.error) throw failure.error instanceof AppError ? failure.error : new AppError('Upload failed', 400);

    const { sizeBytes, sha256, contentType, ext } = inspector.result();
    if (input.expectedSha256 !== undefined && input.expectedSha256.toLowerCase() !== sha256) {
      throw new AppError('Checksum mismatch', 422);
    }
    const key = photographyImageKey(this.companyId, input.tagId, input.imageId, input.variant, ext as PhotoExtension);

    try {
      await this.provider.put(key, Readable.from([Buffer.concat(chunks)]), { contentType });
      const stat = await this.provider.head(key);
      if (!stat || stat.sizeBytes !== sizeBytes) throw new AppError('Stored object failed verification', 502);
    } catch (e) {
      await this.provider.delete(key).catch(() => undefined); // best effort; an orphan is harmless and private
      throw e;
    }
    return { key, sizeBytes, sha256, contentType };
  }

  async streamObject(key: string): Promise<Readable> {
    const s = await this.provider.stream(this.own(key));
    if (!s) throw new AppError('File not found', 404);
    return s;
  }

  async headObject(key: string): Promise<{ sizeBytes: number; contentType?: string } | null> {
    return this.provider.head(this.own(key));
  }

  /** Idempotent: a missing object is not an error. Foreign / malformed keys are a 404. */
  async deleteObject(key: string): Promise<void> {
    await this.provider.delete(this.own(key));
  }

  /** Short-lived server-generated read URL for a private object. */
  async createSignedReadUrl(key: string, ttlSeconds?: number): Promise<string> {
    const ttl = Math.min(Math.max(Math.floor(ttlSeconds ?? this.opts.signedUrlTtlSeconds), 1), MAX_SIGNED_URL_TTL_SECONDS);
    return this.provider.signedReadUrl(this.own(key), ttl);
  }

  /** Reconciliation primitive: does the object a DB row points at exist, and is it the size the row recorded? */
  async verifyObject(key: string, expectedSizeBytes?: number): Promise<ObjectVerification> {
    const stat = await this.provider.head(this.own(key));
    if (!stat) return 'MISSING';
    if (expectedSizeBytes !== undefined && stat.sizeBytes !== expectedSizeBytes) return 'SIZE_MISMATCH';
    return 'OK';
  }

  private own(key: string): string {
    const k = assertObjectKeyBelongsToCompany(this.companyId, key);
    if (!k.startsWith(this.namespacePrefix)) throw new AppError('File not found', 404);
    return k;
  }
}
