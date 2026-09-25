import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { cache, companyCacheKey, platformCacheKey } from '../config/redis';
import { companyObjectKey, companyObjectPrefix, assertObjectKeyBelongsToCompany } from '../shared/objectKey';
import { provisionCompany } from '../modules/platform/provisioning.service';
import { purgeCompany, uniqueCompanyCode } from './fixtures';

const CID_A = 'cabcdefghijklmnopqrstuvwx';
const CID_B = 'czyxwvutsrqponmlkjihgfedc';

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sourceFiles(p, out);
    else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p);
  }
  return out;
}
const SRC = path.resolve(__dirname, '..');

describe('Redis key namespace: trivo:<companyId>:…', () => {
  it('every company key carries the company prefix; two companies can never share a key', () => {
    expect(companyCacheKey(CID_A, 'dashboard', 'summary')).toBe(`trivo:${CID_A}:dashboard:summary`);
    expect(companyCacheKey(CID_B, 'dashboard', 'summary')).toBe(`trivo:${CID_B}:dashboard:summary`);
    expect(companyCacheKey(CID_A, 'x')).not.toBe(companyCacheKey(CID_B, 'x'));
  });

  it('refuses a missing/invalid company, an empty key, and wildcard / injection characters in a part', () => {
    for (const bad of ['', 'short', 'UPPERCASE00000000000000000', 'has space 0000000000000000', undefined as any]) {
      expect(() => companyCacheKey(bad, 'k')).toThrow(/companyId/);
    }
    expect(() => companyCacheKey(CID_A)).toThrow(/at least one part/);
    for (const part of ['*', 'a*b', 'a b', 'a/b', '', 'x\n', '[abc]', '?']) expect(() => companyCacheKey(CID_A, part), part).toThrow(/invalid cache key part/);
  });

  it('platform-level keys live under their own trivo:platform: prefix (never a company id)', () => {
    expect(platformCacheKey('hsn', '7113')).toBe('trivo:platform:hsn:7113');
  });

  it('the cache API has NO raw get/set/del — company data can only be cached through forCompany()', () => {
    expect(Object.keys(cache).sort()).toEqual(['forCompany', 'platform']);
    expect(() => cache.forCompany('nope')).toThrow(/companyId/);
    expect(Object.keys(cache.forCompany(CID_A)).sort()).toEqual(['del', 'delPrefix', 'get', 'set']);
  });

  it('no application code touches the Redis client or key-less cache primitives directly (only config/redis.ts)', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const rel = path.relative(SRC, f).replace(/\\/g, '/');
      if (rel === 'config/redis.ts') continue;
      const text = fs.readFileSync(f, 'utf8');
      // `redis` (the raw client) may be imported for graceful shutdown in index.ts only.
      if (rel !== 'index.ts' && /\bredisClient\b|from ['"].*config\/redis['"]/.test(text) && /\bredis\b\s*[.?]/.test(text)) offenders.push(`${rel}: uses the raw redis client`);
      if (/\bioredis\b/.test(text)) offenders.push(`${rel}: imports ioredis directly`);
      if (/cache\.(get|set|del|delPattern)\s*\(/.test(text)) offenders.push(`${rel}: raw cache.get/set/del — use cache.forCompany(companyId)`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('Object storage key: companies/<companyId>/…', () => {
  it('builds keys only inside the company\'s own prefix', () => {
    expect(companyObjectPrefix(CID_A)).toBe(`companies/${CID_A}/`);
    expect(companyObjectKey(CID_A, 'tags', '123.jpg')).toBe(`companies/${CID_A}/tags/123.jpg`);
  });

  it('refuses traversal, empty, slash and odd segments when building', () => {
    for (const bad of ['..', '../x', 'a/b', '', '.hidden/..', 'a\\b', 'x'.repeat(200)]) {
      expect(() => companyObjectKey(CID_A, bad), bad).toThrow(/invalid object key segment/);
    }
    expect(() => companyObjectKey(CID_A)).toThrow(/at least one segment/);
    expect(() => companyObjectKey('bad-id', 'x')).toThrow(/companyId/);
  });

  it('a key a client/database hands us is accepted only if it is under the caller\'s OWN prefix', () => {
    const own = companyObjectKey(CID_A, 'designs', 'ring.png');
    expect(assertObjectKeyBelongsToCompany(CID_A, own)).toBe(own);
  });

  it('another company\'s key, a bare "uploads/…" key, traversal and prefix tricks are all the same 404 — guessing a key gets nothing', () => {
    const theirs = companyObjectKey(CID_B, 'designs', 'ring.png');
    for (const bad of [
      theirs,                                             // another company's object
      'uploads/tags/123.jpg',                             // no company namespace at all
      `companies/${CID_A}/../${CID_B}/designs/ring.png`,  // traversal into the other company
      `companies/${CID_A}//designs/x`, `companies/${CID_A}/`, `companies/${CID_A}`,
      `companies/${CID_A}x/designs/x`,                    // prefix look-alike
      `companies/${CID_A}/a\0b`, `companies/${CID_A}\\..\\x`, '', undefined as any,
    ]) {
      expect(() => assertObjectKeyBelongsToCompany(CID_A, bad), String(bad)).toThrowError(expect.objectContaining({ statusCode: 404 }));
    }
  });

  it('no application code builds an object key by hand or talks to MinIO/S3 outside the helper', () => {
    const offenders: string[] = [];
    for (const f of sourceFiles(SRC)) {
      const rel = path.relative(SRC, f).replace(/\\/g, '/');
      if (rel === 'shared/objectKey.ts' || rel === 'config/env.ts') continue;
      const text = fs.readFileSync(f, 'utf8');
      if (/from ['"]minio['"]|@aws-sdk\/client-s3|['"]uploads\//.test(text)) offenders.push(`${rel}: storage access / bare uploads path — use shared/objectKey.ts`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('the DATABASE holds the same boundary for stored file paths', () => {
  const created: string[] = [];
  afterAll(async () => {
    // Discover every company these tests created via their admins' e-mails (not just the ids tracked), so a
    // leftover from an aborted earlier run can never block cleanup.
    const members = await prisma.companyUser.findMany({ where: { user: { email: { endsWith: '@objkey.example.com' } } }, select: { companyId: true } });
    for (const id of new Set([...created, ...members.map((m) => m.companyId)])) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: '@objkey.example.com' } } });
  });

  it('design_files.filePath must sit under its own company\'s prefix (CHECK constraint)', async () => {
    const mk = async () => {
      const code = uniqueCompanyCode('OK');
      const r = await provisionCompany({ code, name: 'Obj Key Co', admin: { email: `${code.toLowerCase()}@objkey.example.com`, name: 'Owner Person', password: 'ObjKey-Passw0rd-123' } });
      created.push(r.company.id);
      const cat = await prisma.designCategory.findFirstOrThrow({ where: { companyId: r.company.id } });
      const design = await prisma.design.create({ data: { companyId: r.company.id, designCode: 'D1', name: 'D', categoryId: cat.id, metalKarat: '22K', grossWeightMin: 1, grossWeightMax: 2, netWeightMin: 1, netWeightMax: 2 } });
      return { id: r.company.id, designId: design.id };
    };
    const a = await mk(); const b = await mk();
    const base = (c: { id: string; designId: string }, filePath: string) => ({ companyId: c.id, designId: c.designId, fileType: 'IMAGE', fileName: 'x.png', filePath });

    await expect(prisma.designFile.create({ data: base(a, `companies/${a.id}/designs/x.png`) })).resolves.toBeTruthy();
    await expect(prisma.designFile.create({ data: base(a, `companies/${b.id}/designs/x.png`) })).rejects.toThrow(/check constraint/i);
    await expect(prisma.designFile.create({ data: base(a, 'uploads/designs/x.png') })).rejects.toThrow(/check constraint/i);
    await expect(prisma.designFile.create({ data: base(a, `companies/${a.id}/../${b.id}/x.png`) })).rejects.toThrow(/check constraint/i);
  });
});
