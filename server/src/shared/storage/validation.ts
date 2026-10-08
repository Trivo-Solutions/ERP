// Upload validation. The browser-supplied MIME type and filename are never trusted: the format comes from the
// file's own magic bytes, and must agree with whatever the caller claimed. Deliberately small policy —
// JPEG/PNG/WebP only. Sony RAW (ARW) and HEIC are NOT supported until real sample files have been inspected.
import { AppError } from '../../middleware/error';
import type { PhotoExtension } from '../objectKey';

export const ALLOWED_IMAGE_TYPES: Record<string, PhotoExtension> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};
/** Bytes needed to identify every supported format. */
export const SNIFF_BYTES = 12;

export function sniffImageType(head: Buffer): string | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 12 && head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Validates the first bytes against the policy (and the declared type/extension, when given). Returns the real type. */
export function assertImageContent(head: Buffer, declared?: { mimeType?: string; filename?: string }): { contentType: string; ext: PhotoExtension } {
  if (head.length === 0) throw new AppError('Empty file', 400);
  const contentType = sniffImageType(head);
  if (!contentType) throw new AppError('Unsupported image format (JPEG, PNG or WebP only)', 415);
  if (declared?.mimeType !== undefined && declared.mimeType.toLowerCase().split(';')[0].trim() !== contentType) {
    throw new AppError('File content does not match its declared type', 415);
  }
  const ext = ALLOWED_IMAGE_TYPES[contentType];
  if (declared?.filename) {
    const m = /\.([A-Za-z0-9]{1,8})$/.exec(declared.filename);
    const claimed = m?.[1].toLowerCase().replace('jpeg', 'jpg');
    if (claimed !== undefined && claimed !== ext) throw new AppError('File extension does not match its content', 415);
  }
  return { contentType, ext };
}

export function assertSizeWithin(sizeBytes: number, maxBytes: number): void {
  if (sizeBytes === 0) throw new AppError('Empty file', 400);
  if (sizeBytes > maxBytes) throw new AppError(`File too large (max ${maxBytes} bytes)`, 413);
}
