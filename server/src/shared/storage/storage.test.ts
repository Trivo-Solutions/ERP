import { describe, it, expect, beforeEach } from 'vitest';
import { Readable } from 'stream';
import { photographyImageKey, PHOTO_VARIANTS, assertObjectKeyBelongsToCompany } from '../objectKey';
import { CompanyStorage } from './companyStorage';
import { MemoryStorageProvider } from './memoryProvider';
import { sha256Hex } from './hashing';
import { sniffImageType } from './validation';

const CO_A = 'cabcdefghijklmnopqrstuvwx1';
const CO_B = 'cbbcdefghijklmnopqrstuvwx2';
const TAG = 'ctagabcdefghijklmnopqrst1';
const IMG = 'cimgabcdefghijklmnopqrst1';

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP'), Buffer.alloc(20, 3)]);

describe('photography object keys', () => {
  it('are company-scoped and deterministic, one distinct key per variant', () => {
    const keys = PHOTO_VARIANTS.map((v) => photographyImageKey(CO_A, TAG, IMG, v, 'jpg'));
    expect(keys[0]).toBe(`companies/${CO_A}/photography/tags/${TAG}/images/${IMG}/original.jpg`);
    expect(new Set(keys).size).toBe(3);
    for (const k of keys) expect(k.startsWith(`companies/${CO_A}/`)).toBe(true);
  });
  it('carry no branch, no filename; reject traversal and odd ids/variants/extensions', () => {
    const k = photographyImageKey(CO_A, TAG, IMG, 'thumbnail', 'webp');
    expect(k).not.toMatch(/branch/i);
    expect(() => photographyImageKey(CO_A, '../x', IMG, 'original', 'jpg')).toThrow();
    expect(() => photographyImageKey(CO_A, TAG, 'a/b', 'original', 'jpg')).toThrow();
    expect(() => photographyImageKey(CO_A, TAG, IMG, 'original', '../jpg' as never)).toThrow();
    expect(() => photographyImageKey(CO_A, TAG, IMG, 'raw' as never, 'jpg')).toThrow();
    expect(() => photographyImageKey('bad..co', TAG, IMG, 'original', 'jpg')).toThrow();
    expect(() => assertObjectKeyBelongsToCompany(CO_A, `companies/${CO_A}/photography/../../${CO_B}/x`)).toThrow();
  });
});

describe('CompanyStorage', () => {
  let provider: MemoryStorageProvider;
  let a: CompanyStorage;
  let b: CompanyStorage;
  const opts = { maxUploadBytes: 1000, signedUrlTtlSeconds: 300 };
  beforeEach(() => {
    provider = new MemoryStorageProvider();
    a = new CompanyStorage(provider, CO_A, opts);
    b = new CompanyStorage(provider, CO_B, opts);
  });
  const put = (s: CompanyStorage, body: Buffer | Readable, extra = {}) =>
    s.putImage({ tagId: TAG, imageId: IMG, variant: 'original', body, ...extra });

  it('stores under the company key with a correct SHA-256 and size', async () => {
    const r = await put(a, JPEG, { declared: { mimeType: 'image/jpeg', filename: 'DSC0001.JPG' } });
    expect(r.key).toBe(`companies/${CO_A}/photography/tags/${TAG}/images/${IMG}/original.jpg`);
    expect(r.sha256).toBe(sha256Hex(JPEG));
    expect(r.sizeBytes).toBe(JPEG.length);
    expect(r.key).not.toMatch(/DSC0001/);
    expect(provider.objects.get(r.key)?.contentType).toBe('image/jpeg');
  });
  it('hashes a streamed upload identically', async () => {
    const r = await put(a, Readable.from([PNG.subarray(0, 5), PNG.subarray(5)]));
    expect(r.sha256).toBe(sha256Hex(PNG));
    expect(r.key.endsWith('original.png')).toBe(true);
  });
  it('enforces the size limit', async () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(2000)]);
    await expect(put(a, big)).rejects.toMatchObject({ statusCode: 413 });
    await expect(put(a, Readable.from([JPEG, Buffer.alloc(2000)]))).rejects.toMatchObject({ statusCode: 413 });
    expect(provider.objects.size).toBe(0);
  });
  it('rejects empty files', async () => {
    await expect(put(a, Buffer.alloc(0))).rejects.toMatchObject({ statusCode: 400 });
  });
  it('validates by content, not by claimed type or extension', async () => {
    expect(sniffImageType(WEBP)).toBe('image/webp');
    await expect(put(a, Buffer.from('<?php echo 1; ?>'.padEnd(40)))).rejects.toMatchObject({ statusCode: 415 });
    await expect(put(a, Buffer.from('II*\0' + 'x'.repeat(30)), { declared: { mimeType: 'image/jpeg' } })).rejects.toMatchObject({ statusCode: 415 }); // TIFF/ARW-like
    await expect(put(a, PNG, { declared: { mimeType: 'image/jpeg' } })).rejects.toMatchObject({ statusCode: 415 });
    await expect(put(a, JPEG, { declared: { filename: 'x.png' } })).rejects.toMatchObject({ statusCode: 415 });
    await expect(put(a, WEBP)).resolves.toBeTruthy();
    expect(provider.objects.size).toBe(1);
  });
  it('verifies an expected checksum and stores nothing on mismatch', async () => {
    await expect(put(a, JPEG, { expectedSha256: 'a'.repeat(64) })).rejects.toMatchObject({ statusCode: 422 });
    expect(provider.objects.size).toBe(0);
    await expect(put(a, JPEG, { expectedSha256: sha256Hex(JPEG).toUpperCase() })).resolves.toBeTruthy();
  });
  it('keeps original / optimized / thumbnail as separate objects', async () => {
    const keys = [];
    for (const variant of PHOTO_VARIANTS) keys.push((await a.putImage({ tagId: TAG, imageId: IMG, variant, body: JPEG })).key);
    expect(new Set(keys).size).toBe(3);
    expect(provider.objects.size).toBe(3);
  });

  it('refuses another company\'s key for every read/delete/sign operation (404, object untouched)', async () => {
    const { key } = await put(a, JPEG);
    await expect(b.streamObject(key)).rejects.toMatchObject({ statusCode: 404 });
    await expect(b.deleteObject(key)).rejects.toMatchObject({ statusCode: 404 });
    await expect(b.headObject(key)).rejects.toMatchObject({ statusCode: 404 });
    await expect(b.createSignedReadUrl(key)).rejects.toMatchObject({ statusCode: 404 });
    await expect(b.verifyObject(key)).rejects.toMatchObject({ statusCode: 404 });
    expect(provider.objects.has(key)).toBe(true);
  });
  it('rejects arbitrary client-supplied keys, even inside the company prefix', async () => {
    await expect(a.deleteObject('uploads/tags/1.jpg')).rejects.toMatchObject({ statusCode: 404 });
    await expect(a.deleteObject(`companies/${CO_A}/designs/ring.png`)).rejects.toMatchObject({ statusCode: 404 }); // outside photography/
    await expect(a.streamObject(`companies/${CO_A}/photography/../designs/x.png`)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('delete is idempotent for a missing object', async () => {
    const { key } = await put(a, JPEG);
    await a.deleteObject(key);
    await expect(a.deleteObject(key)).resolves.toBeUndefined();
    await expect(a.streamObject(key)).rejects.toMatchObject({ statusCode: 404 });
  });
  it('signed read URLs come from the provider, not a public bucket URL, and the TTL is clamped', async () => {
    const { key } = await put(a, JPEG);
    const url = await a.createSignedReadUrl(key, 999999);
    expect(url).toMatch(/^memory:\/\/signed\//);
    expect(url).toContain('expires=900');
    expect(await a.createSignedReadUrl(key)).toContain('expires=300');
  });
  it('verifyObject reports OK / MISSING / SIZE_MISMATCH', async () => {
    const { key } = await put(a, JPEG);
    expect(await a.verifyObject(key, JPEG.length)).toBe('OK');
    expect(await a.verifyObject(key, 1)).toBe('SIZE_MISMATCH');
    await a.deleteObject(key);
    expect(await a.verifyObject(key)).toBe('MISSING');
  });
  it('rejects an invalid companyId at construction', () => {
    expect(() => new CompanyStorage(provider, '../evil', opts)).toThrow();
  });
});
