// Temporary integration smoke test: real MinioStorageProvider against the dev MinIO (docker compose up -d minio).
// Run: npx tsx scripts/minioSmoke.ts   — creates the bucket if absent, removes every object it writes.
import { Client } from 'minio';
import { randomBytes } from 'crypto';
import { CompanyStorage } from '../src/shared/storage/companyStorage';
import { MinioStorageProvider } from '../src/shared/storage/minioProvider';
import { sha256Hex } from '../src/shared/storage/hashing';
import { photographyImageKey } from '../src/shared/objectKey';

const cfg = {
  endPoint: process.env.MINIO_ENDPOINT ?? 'localhost', port: Number(process.env.MINIO_PORT ?? 9000), useSSL: false,
  accessKey: process.env.MINIO_ACCESS_KEY ?? 'minioadmin', secretKey: process.env.MINIO_SECRET_KEY ?? 'minioadmin',
  bucket: process.env.MINIO_BUCKET_NAME ?? 'sea-erp-files',
};
const CO_A = 'csmokea' + 'a'.repeat(18), CO_B = 'csmokeb' + 'b'.repeat(18);
const TAG = 'ctagsmoke' + 'x'.repeat(16), IMG = 'cimgsmoke' + 'y'.repeat(16);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2000)]);

let failed = 0;
const check = async (name: string, fn: () => Promise<unknown>) => {
  try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failed++; console.log(`FAIL  ${name}: ${(e as Error).message}`); }
};
const ok = (c: unknown, m: string) => { if (!c) throw new Error(m); };
const rejects = async (p: Promise<unknown>, m: string) => { try { await p; } catch { return; } throw new Error(m); };

(async () => {
  const raw = new Client({ endPoint: cfg.endPoint, port: cfg.port, useSSL: false, accessKey: cfg.accessKey, secretKey: cfg.secretKey });
  const existed = await raw.bucketExists(cfg.bucket);
  if (!existed) await raw.makeBucket(cfg.bucket);
  console.log(`bucket ${cfg.bucket}: ${existed ? 'already existed' : 'created'}`);

  const provider = new MinioStorageProvider(cfg);
  const opts = { maxUploadBytes: 1_000_000, signedUrlTtlSeconds: 60 };
  const a = new CompanyStorage(provider, CO_A, opts), b = new CompanyStorage(provider, CO_B, opts);
  let key = '';

  await check('company-bound storage instance', async () => ok(a.companyId === CO_A, 'companyId'));
  await check('upload + SHA-256 + size + content type returned', async () => {
    const r = await a.putImage({ tagId: TAG, imageId: IMG, variant: 'original', body: JPEG, declared: { mimeType: 'image/jpeg' } });
    key = r.key;
    ok(r.key.startsWith(`companies/${CO_A}/`), 'key prefix');
    ok(r.sha256 === sha256Hex(JPEG), 'sha mismatch');
    ok(r.sizeBytes === JPEG.length, 'size mismatch');
    ok(r.contentType === 'image/jpeg', 'content type');
  });
  await check('head: size + content type from MinIO', async () => {
    const h = await a.headObject(key);
    ok(h && h.sizeBytes === JPEG.length && h.contentType === 'image/jpeg', JSON.stringify(h));
  });
  await check('signed read URL retrieves identical bytes over HTTP', async () => {
    const url = await a.createSignedReadUrl(key, 60);
    const res = await fetch(url);
    ok(res.status === 200, `status ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    ok(sha256Hex(buf) === sha256Hex(JPEG), 'bytes differ');
    ok((await fetch(url.replace(/X-Amz-Signature=[0-9a-f]+/, 'X-Amz-Signature=' + '0'.repeat(64)))).status === 403, 'tampered URL accepted');
  });
  await check('stream returns identical bytes', async () => {
    const chunks: Buffer[] = [];
    for await (const c of await a.streamObject(key)) chunks.push(c as Buffer);
    ok(sha256Hex(Buffer.concat(chunks)) === sha256Hex(JPEG), 'bytes differ');
  });
  await check('cross-company head/stream/delete/sign rejected; object untouched', async () => {
    await rejects(b.headObject(key), 'head');
    await rejects(b.streamObject(key), 'stream');
    await rejects(b.deleteObject(key), 'delete');
    await rejects(b.createSignedReadUrl(key), 'sign');
    ok((await a.headObject(key)) !== null, 'object vanished');
  });
  await check('invalid / traversal keys rejected', async () => {
    for (const k of [`companies/${CO_A}/photography/../../${CO_B}/x`, '../etc/passwd', `companies/${CO_A}/other/x.jpg`, '', `/companies/${CO_A}/photography/x`])
      await rejects(a.headObject(k), `accepted ${k}`);
  });
  await check('delete removes object', async () => {
    await a.deleteObject(key);
    ok((await a.headObject(key)) === null, 'still present');
    ok((await a.verifyObject(key)) === 'MISSING', 'verify');
  });
  await check('delete of missing object is idempotent', async () => { await a.deleteObject(key); });
  await check('no leftover objects under smoke prefixes', async () => {
    for (const co of [CO_A, CO_B]) {
      const left: string[] = [];
      const s = raw.listObjectsV2(cfg.bucket, `companies/${co}/`, true);
      await new Promise<void>((res, rej) => { s.on('data', (o) => left.push(o.name ?? '')); s.on('end', () => res()); s.on('error', rej); });
      ok(left.length === 0, `leftover: ${left.join(',')}`);
    }
    void photographyImageKey;
  });
  console.log(failed ? `\n${failed} FAILED` : '\nALL PASS');
  process.exit(failed ? 1 : 0);
})();
