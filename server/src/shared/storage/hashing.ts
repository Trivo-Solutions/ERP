// Single-pass upload inspector: counts bytes (enforcing the size cap mid-stream), sniffs the format from the
// first bytes, and computes SHA-256 — all while the data flows to the provider, so no second full read is needed.
import { createHash } from 'crypto';
import { Transform, type TransformCallback } from 'stream';
import { AppError } from '../../middleware/error';
import { SNIFF_BYTES, assertImageContent } from './validation';
import type { PhotoExtension } from '../objectKey';

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export interface InspectResult { sizeBytes: number; sha256: string; contentType: string; ext: PhotoExtension }

export class UploadInspector extends Transform {
  private hash = createHash('sha256');
  private size = 0;
  private head: Buffer[] = [];
  private headLen = 0;
  private sniffed: { contentType: string; ext: PhotoExtension } | null = null;

  constructor(private maxBytes: number, private declared?: { mimeType?: string; filename?: string }) { super(); }

  _transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback): void {
    try {
      this.size += chunk.length;
      if (this.size > this.maxBytes) throw new AppError(`File too large (max ${this.maxBytes} bytes)`, 413);
      this.hash.update(chunk);
      if (!this.sniffed) {
        this.head.push(chunk); this.headLen += chunk.length;
        if (this.headLen >= SNIFF_BYTES) this.sniffed = assertImageContent(Buffer.concat(this.head), this.declared);
      }
      cb(null, chunk);
    } catch (e) { cb(e as Error); }
  }

  _flush(cb: TransformCallback): void {
    try {
      if (this.size === 0) throw new AppError('Empty file', 400);
      if (!this.sniffed) this.sniffed = assertImageContent(Buffer.concat(this.head), this.declared); // tiny file
      cb();
    } catch (e) { cb(e as Error); }
  }

  result(): InspectResult {
    if (!this.sniffed) throw new Error('inspector has not finished');
    return { sizeBytes: this.size, sha256: this.hash.digest('hex'), ...this.sniffed };
  }
}
