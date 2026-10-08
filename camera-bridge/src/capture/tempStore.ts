import { randomUUID } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { Logger } from '../logger';

// The bridge's only on-disk image area. Rules: one dedicated directory; every file name is GENERATED here (a UUID +
// a fixed extension from an allow-list) — nothing is derived from the camera, the command or the ERP; nothing outside
// the directory is ever touched; and nothing is kept for good: a file lives only until its upload is confirmed, or,
// after a recoverable failure, until the bounded retention window passes. The ticket is never written to disk.
const MIME_EXT: Record<string, string> = { 'image/png': '.png', 'image/jpeg': '.jpg' };
const FILE_RE = /^cap-[0-9a-f-]{36}\.(png|jpg|json)$/;

export interface TempMeta {
  commandId: string; correlationId: string; idempotencyKey: string; imageType: string; capturedAt: string; mimeType: string;
  reason?: string; recoverable?: boolean;
}
export interface TempHandle { id: string; imagePath: string; metaPath: string; mimeType: string }

export class TempStore {
  constructor(
    private readonly dir: string, private readonly retentionMs: number, private readonly log: Logger,
    private readonly now: () => number = Date.now, private readonly maxBytes: number = Infinity,
  ) {}

  async write(data: Buffer, meta: TempMeta): Promise<TempHandle> {
    const ext = MIME_EXT[meta.mimeType];
    if (!ext) throw new Error('Unsupported image type');
    await fs.mkdir(this.dir, { recursive: true });
    if (data.length > this.maxBytes) throw new Error('Image larger than the temp area');
    await this.enforceCap(data.length);
    const id = randomUUID();
    const imagePath = path.join(this.dir, `cap-${id}${ext}`);
    const metaPath = path.join(this.dir, `cap-${id}.json`);
    await fs.writeFile(imagePath, data, { flag: 'wx' });
    await fs.writeFile(metaPath, JSON.stringify(meta), { flag: 'wx' });
    return { id, imagePath, metaPath, mimeType: meta.mimeType };
  }

  read(h: TempHandle): Promise<Buffer> { return fs.readFile(h.imagePath); }

  async remove(h: TempHandle): Promise<void> {
    await Promise.all([h.imagePath, h.metaPath].map((p) => fs.rm(p, { force: true })));
  }

  /** Records why an image is being kept (sidecar only). */
  async annotate(h: TempHandle, meta: TempMeta): Promise<void> { await fs.writeFile(h.metaPath, JSON.stringify(meta)); }

  /** Discards the oldest retained images until `incoming` more bytes fit under the cap. Only bridge-named files. */
  private async enforceCap(incoming: number): Promise<void> {
    if (this.maxBytes === Infinity) return;
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return; }
    const images: { name: string; size: number; mtime: number }[] = [];
    let total = 0;
    for (const name of names) {
      if (!FILE_RE.test(name) || name.endsWith('.json')) continue;
      try { const st = await fs.stat(path.join(this.dir, name)); images.push({ name, size: st.size, mtime: st.mtimeMs }); total += st.size; } catch { /* gone */ }
    }
    images.sort((a, b) => a.mtime - b.mtime);
    for (const img of images) {
      if (total + incoming <= this.maxBytes) break;
      await fs.rm(path.join(this.dir, img.name), { force: true });
      await fs.rm(path.join(this.dir, img.name.replace(/.(png|jpg)$/, '.json')), { force: true });
      total -= img.size;
      this.log.warn('temp.evicted', { file: img.name, reason: 'SIZE_CAP' });
    }
  }

  /** Deletes our own files older than the retention window, then enforces the size cap. Returns how many images were discarded. */
  async sweep(): Promise<number> {
    let names: string[];
    try { names = await fs.readdir(this.dir); } catch { return 0; }
    let discarded = 0;
    for (const name of names) {
      if (!FILE_RE.test(name)) continue; // never touch anything we did not create
      const p = path.join(this.dir, name);
      try {
        const st = await fs.stat(p);
        if (this.now() - st.mtimeMs < this.retentionMs) continue;
        await fs.rm(p, { force: true });
        if (!name.endsWith('.json')) { discarded += 1; this.log.warn('temp.expired', { file: name }); }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn('temp.cleanup_failed', { file: name }); // a concurrent removal is fine
      }
    }
    await this.enforceCap(0).catch(() => undefined);
    return discarded;
  }
}
