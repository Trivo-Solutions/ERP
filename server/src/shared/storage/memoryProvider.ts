// In-memory provider for unit tests (and a stand-in where no object store is configured). Not for production.
import { Readable } from 'stream';
import type { ObjectStat, StorageProvider } from './types';

export class MemoryStorageProvider implements StorageProvider {
  readonly objects = new Map<string, { data: Buffer; contentType: string }>();

  async put(key: string, body: Readable, opts: { contentType: string }): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    this.objects.set(key, { data: Buffer.concat(chunks), contentType: opts.contentType });
  }
  async stream(key: string): Promise<Readable | null> {
    const o = this.objects.get(key);
    return o ? Readable.from([o.data]) : null;
  }
  async head(key: string): Promise<ObjectStat | null> {
    const o = this.objects.get(key);
    return o ? { sizeBytes: o.data.length, contentType: o.contentType } : null;
  }
  async delete(key: string): Promise<void> { this.objects.delete(key); }
  async signedReadUrl(key: string, ttlSeconds: number): Promise<string> {
    return `memory://signed/${encodeURIComponent(key)}?expires=${ttlSeconds}`;
  }
}
