// Storage factory. Provider + limits come from config/env.ts (MINIO_* keep their names — they address any
// S3-compatible endpoint, e.g. R2 in production). Nothing here reads a client request.
import { env } from '../../config/env';
import { CompanyStorage } from './companyStorage';
import { MemoryStorageProvider } from './memoryProvider';
import { MinioStorageProvider } from './minioProvider';
import type { StorageProvider } from './types';

export * from './types';
export * from './validation';
export * from './hashing';
export * from './companyStorage';
export { MemoryStorageProvider } from './memoryProvider';

let provider: StorageProvider | null = null;

function buildProvider(): StorageProvider {
  if (env.STORAGE_PROVIDER === 'memory') {
    if (env.NODE_ENV === 'production') throw new Error('STORAGE_PROVIDER=memory is not allowed in production');
    return new MemoryStorageProvider();
  }
  return new MinioStorageProvider({
    endPoint: env.MINIO_ENDPOINT, port: env.MINIO_PORT, useSSL: env.MINIO_USE_SSL,
    accessKey: env.MINIO_ACCESS_KEY, secretKey: env.MINIO_SECRET_KEY, bucket: env.MINIO_BUCKET_NAME,
    region: env.STORAGE_REGION,
  });
}

/** Company-bound storage. Pass ctx.companyId from the tenant context — never a request value. */
export function storageForCompany(companyId: string): CompanyStorage {
  provider ??= buildProvider();
  return new CompanyStorage(provider, companyId, {
    maxUploadBytes: env.PHOTO_MAX_UPLOAD_BYTES,
    signedUrlTtlSeconds: env.STORAGE_SIGNED_URL_TTL_SECONDS,
  });
}

/** Test seam. */
export function setStorageProviderForTests(p: StorageProvider | null): void { provider = p; }
