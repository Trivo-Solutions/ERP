// Provider-agnostic object storage contract. Business code (Photography) depends on CompanyStorage
// (companyStorage.ts), which depends on this — never on MinIO/S3 directly. A provider deals in RAW keys and is
// deliberately dumb: company isolation, validation and hashing live one layer up so every provider gets them.
import type { Readable } from 'stream';

export interface ObjectStat { sizeBytes: number; contentType?: string }

export interface StorageProvider {
  put(key: string, body: Readable, opts: { contentType: string }): Promise<void>;
  /** null when the object does not exist. */
  stream(key: string): Promise<Readable | null>;
  /** null when the object does not exist. */
  head(key: string): Promise<ObjectStat | null>;
  /** Idempotent: deleting a missing object is not an error. */
  delete(key: string): Promise<void>;
  /** Short-lived GET URL for a PRIVATE object. Never a public bucket URL. */
  signedReadUrl(key: string, ttlSeconds: number): Promise<string>;
}

export interface PutResult { key: string; sizeBytes: number; sha256: string; contentType: string }
