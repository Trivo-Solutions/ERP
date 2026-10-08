// MinIO / S3-compatible provider (MinIO in dev, Cloudflare R2 or any S3 endpoint in production — the `minio` SDK
// speaks to all of them; see .env.production.template). Endpoint, bucket and credentials come from config only.
import { Client } from 'minio';
import type { Readable } from 'stream';
import type { ObjectStat, StorageProvider } from './types';

export interface MinioProviderConfig {
  endPoint: string; port: number; useSSL: boolean; accessKey: string; secretKey: string; bucket: string; region?: string;
}

const MISSING = new Set(['NoSuchKey', 'NotFound', 'NoSuchObject']);
const isMissing = (e: unknown) => MISSING.has((e as { code?: string })?.code ?? '');

export class MinioStorageProvider implements StorageProvider {
  private client: Client;
  private bucket: string;

  constructor(cfg: MinioProviderConfig) {
    this.bucket = cfg.bucket;
    this.client = new Client({
      endPoint: cfg.endPoint, port: cfg.port, useSSL: cfg.useSSL,
      accessKey: cfg.accessKey, secretKey: cfg.secretKey, region: cfg.region,
    });
  }

  async put(key: string, body: Readable, opts: { contentType: string }): Promise<void> {
    await this.client.putObject(this.bucket, key, body, undefined, { 'Content-Type': opts.contentType });
  }
  async stream(key: string): Promise<Readable | null> {
    try { await this.client.statObject(this.bucket, key); } catch (e) { if (isMissing(e)) return null; throw e; }
    return this.client.getObject(this.bucket, key);
  }
  async head(key: string): Promise<ObjectStat | null> {
    try {
      const s = await this.client.statObject(this.bucket, key);
      return { sizeBytes: s.size, contentType: s.metaData?.['content-type'] };
    } catch (e) { if (isMissing(e)) return null; throw e; }
  }
  async delete(key: string): Promise<void> {
    try { await this.client.removeObject(this.bucket, key); } catch (e) { if (!isMissing(e)) throw e; }
  }
  async signedReadUrl(key: string, ttlSeconds: number): Promise<string> {
    return this.client.presignedGetObject(this.bucket, key, ttlSeconds);
  }
}
