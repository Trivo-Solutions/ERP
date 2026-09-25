import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import fs from 'fs';
import path from 'path';
import { app } from '../app';
import { env } from '../config/env';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createTestTenant, cleanupTestTenant, TestTenant, REAL_ROLE_SPLIT, rlsClient } from './fixtures';
import { createTag } from '../modules/tagging/tagging.service';
import { createInvoice } from '../modules/sales/sales.service';
import { createDesign } from '../modules/product-design/design.service';

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1 of full company isolation: the tenant-editable masters (categories, sub-categories,
// collections, material codes, stock types, stone types, stone grades, karats, design categories)
// are company-owned, and so is everything hung off them (price master, making charges).
//
// The scenario mirrors the security model exactly:
//   Vasavi (Company A) is populated FIRST, then Shree Silver Palace (Company B) is created —
//   B must see nothing of A, not even a single word. Then the reverse. Then direct-ID attacks,
//   forged relations, and the database-level guarantee (RLS) for when application code forgets
//   its company filter.
//
// Every string Vasavi types contains the marker "Vasavi" so a leak anywhere in a response body is
// caught by one substring check, not just by comparing known ids.
// ═══════════════════════════════════════════════════════════════════════════

const PERMS = ['masters:view', 'masters:manage', 'system:config', 'tag:create', 'tag:view', 'invoice:create'];

const NINE_MASTER_TABLES = [
  'design_categories', 'karat_master', 'product_categories', 'sub_categories', 'collections',
  'material_codes', 'stock_types', 'stone_types', 'stone_grades',
];

// The read endpoints for every master + the two master-backed rate tables.
const LIST_ENDPOINTS = [
  '/masters/categories', '/masters/subcategories', '/masters/collections', '/masters/material-codes',
  '/masters/stock-types', '/masters/stone-types', '/masters/stone-grades', '/masters/karats',
  '/masters/price-master', '/masters/making-charges', '/settings/design-categories',
];

function tokenFor(t: TestTenant): string {
  return jwt.sign(
    {
      userId: t.user.id, email: t.user.email, companyId: t.company.id, companyUserId: t.companyUser.id,
      roleId: t.role.id, roleName: t.role.name, permissions: t.role.permissions, branchAccess: t.ctx.branchAccess,
    },
    env.JWT_SECRET,
    { expiresIn: '1h' },
  );
}

function client(t: TestTenant) {
  const auth = { Authorization: `Bearer ${tokenFor(t)}` };
  return {
    get: (p: string) => request(app).get(`/api/v1${p}`).set(auth),
    post: (p: string, body: object) => request(app).post(`/api/v1${p}`).set(auth).send(body),
    patch: (p: string, body: object) => request(app).patch(`/api/v1${p}`).set(auth).send(body),
    del: (p: string) => request(app).delete(`/api/v1${p}`).set(auth),
  };
}

describe('Phase 1: company-owned masters — Vasavi vs Shree Silver Palace', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let vasavi: TestTenant; // Company A
  let shree: TestTenant;  // Company B
  let vas: ReturnType<typeof client>;
  let shr: ReturnType<typeof client>;

  // Vasavi's ids
  const A: Record<string, string> = {};
  // Shree Silver Palace's ids
  const B: Record<string, string> = {};
  let shreeClientId: string;

  async function seedCompany(api: ReturnType<typeof client>, who: 'Vasavi' | 'Shree', ids: Record<string, string>) {
    const expectCreated = (r: request.Response) => { expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.data; };
    ids.cat = expectCreated(await api.post('/masters/categories', { code: 'NKL', name: `${who} Necklaces` })).id;
    ids.sub = expectCreated(await api.post('/masters/subcategories', { code: 'CHK', name: `${who} Choker`, categoryId: ids.cat })).id;
    ids.col = expectCreated(await api.post('/masters/collections', {
      code: 'BRIDAL', name: `${who} Bridal Special Collection`, description: `${who} internal note: call customer after 6 PM`,
    })).id;
    ids.mat = expectCreated(await api.post('/masters/material-codes', { code: 'G22', name: `${who} Gold 22`, materialType: 'METAL', karat: '22K' })).id;
    ids.stock = expectCreated(await api.post('/masters/stock-types', { code: 'V', name: `${who} Ready Stock`, description: `${who} shelf stock` })).id;
    ids.sty = expectCreated(await api.post('/masters/stone-types', { code: 'DIA', name: `${who} Diamond`, itemType: 'DIAMOND' })).id;
    ids.sg = expectCreated(await api.post('/masters/stone-grades', { stoneTypeId: ids.sty, shape: 'ROUND', clarity: 'VVS1' })).id;
    ids.karat = expectCreated(await api.post('/masters/karats', { code: `${who.slice(0, 3).toUpperCase()}22`, metalType: 'GOLD', purity: 0.9 })).id;
    ids.dcat = expectCreated(await api.post('/settings/design-categories', { code: `${who.slice(0, 3).toUpperCase()}RNG`, name: `${who} Rings` })).id;
    ids.mcg = expectCreated(await api.post('/masters/making-charges', {
      materialCodeId: ids.mat, categoryId: ids.cat, karat: '22K', makingCharge: 500, notes: `${who} making charge note`,
    })).id;
    ids.pm = expectCreated(await api.post('/masters/price-master', { stoneGradeId: ids.sg, pricePerCarat: 1000, notes: `${who} price note` })).id;
  }

  beforeAll(async () => {
    vasavi = await createTestTenant(`VAS${suffix}`, PERMS);
    vas = client(vasavi);

    await seedCompany(vas, 'Vasavi', A);

    // Volume: a real business has plenty of masters, not one of each.
    await prisma.productCategory.createMany({
      data: Array.from({ length: 20 }, (_, i) => ({ companyId: vasavi.company.id, code: `BULK${i}`, name: `Vasavi Bulk Category ${i}` })),
    });
    await prisma.collection.createMany({
      data: Array.from({ length: 10 }, (_, i) => ({ companyId: vasavi.company.id, code: `BULKC${i}`, name: `Vasavi Bulk Collection ${i}` })),
    });

    // A real piece of Vasavi stock built on Vasavi's masters.
    const tag = await createTag(vasavi.ctx, {
      branchId: vasavi.branch.id, stockTypeId: A.stock, categoryId: A.cat, subCategoryId: A.sub, collectionId: A.col,
      name: 'Vasavi Bridal Necklace', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, sellingPrice: 90000,
      materials: [{ code: 'G22', materialType: 'METAL', materialCodeId: A.mat, weight: 10 }],
    }, vasavi.user.id);
    A.tag = tag.id;
    A.tagNumber = tag.tagNumber;
  });

  afterAll(async () => {
    // Tags (and their material rows) are removed by cleanupTestTenant in dependency order; clients
    // are the only thing it doesn't know about.
    for (const t of [vasavi, shree]) {
      if (!t) continue;
      await prisma.client.deleteMany({ where: { companyId: t.company.id } });
    }
    if (shree) await cleanupTestTenant(shree);
    await cleanupTestTenant(vasavi);
    await prisma.$disconnect();
  });

  // ─── 1. A brand-new company sees NOTHING of Vasavi ──────────────────────────
  describe('new-company cleanliness: Shree Silver Palace is created AFTER Vasavi is fully populated', () => {
    beforeAll(async () => {
      shree = await createTestTenant(`SSP${suffix}`, PERMS);
      shr = client(shree);
    });

    it('every master/rate list returns 200 and contains not a single Vasavi word or Vasavi id', async () => {
      const vasaviIds = Object.values(A);
      for (const ep of LIST_ENDPOINTS) {
        const res = await shr.get(ep);
        expect(res.status, ep).toBe(200);
        const body = JSON.stringify(res.body);
        expect(body, `${ep} leaked the marker`).not.toContain('Vasavi');
        expect(body, `${ep} leaked a Vasavi note`).not.toContain('6 PM');
        for (const id of vasaviIds) expect(body, `${ep} leaked id ${id}`).not.toContain(id);
      }
    });

    it('the lists Vasavi populated are EMPTY for Shree (categories, collections, stock types, ...)', async () => {
      for (const ep of [
        '/masters/categories', '/masters/subcategories', '/masters/collections', '/masters/material-codes',
        '/masters/stock-types', '/masters/stone-types', '/masters/stone-grades', '/masters/price-master', '/masters/making-charges',
      ]) {
        const res = await shr.get(ep);
        expect(res.body.data, ep).toEqual([]);
      }
    });

    it('Shree starts with only the standard starter set (karats + design categories), none of Vasavi\'s custom ones', async () => {
      const karats = (await shr.get('/masters/karats')).body.data.map((k: { code: string }) => k.code);
      expect(karats).toEqual(expect.arrayContaining(['24K', '22K', '18K', 'SILVER', 'PT']));
      expect(karats).not.toContain('VAS22');
      const dcats = (await shr.get('/settings/design-categories')).body.data.map((c: { code: string }) => c.code);
      expect(dcats).not.toContain('VASRNG');
    });

    it('Shree cannot see Vasavi\'s tag, and Vasavi\'s row counts are untouched by Shree existing', async () => {
      const res = await shr.get('/tagging/tags');
      expect(res.status).toBe(200);
      expect(JSON.stringify(res.body)).not.toContain(A.tagNumber);
      expect(JSON.stringify(res.body)).not.toContain('Vasavi');
      // 20 bulk + 1 explicit category, 10 bulk + 1 explicit collection
      expect((await vas.get('/masters/categories')).body.data).toHaveLength(21);
      expect((await vas.get('/masters/collections')).body.data).toHaveLength(11);
    });
  });

  // ─── 2. The reverse: Shree populates, Vasavi must not see it; same codes are fine ──────
  describe('the reverse direction: Shree populates, Vasavi sees none of it', () => {
    beforeAll(async () => {
      // Deliberately the SAME codes Vasavi used (NKL, CHK, BRIDAL, G22, V, DIA) — codes are unique
      // per company, not globally, so this must succeed.
      await seedCompany(shr, 'Shree', B);
      shreeClientId = (await prisma.client.create({
        data: { companyId: shree.company.id, clientCode: `SSPCL-${suffix}`, name: 'Shree Client', type: 'RETAIL' },
      })).id;
    });

    it('Shree reused Vasavi\'s codes with different ids — independent records, not shared ones', () => {
      for (const k of ['cat', 'sub', 'col', 'mat', 'stock', 'sty', 'sg', 'dcat', 'mcg', 'pm']) {
        expect(B[k], k).toBeTruthy();
        expect(B[k], `${k} must be a separate row`).not.toBe(A[k]);
      }
    });

    it('no Vasavi list contains a Shree word or id', async () => {
      const shreeIds = Object.values(B);
      for (const ep of LIST_ENDPOINTS) {
        const res = await vas.get(ep);
        expect(res.status, ep).toBe(200);
        const body = JSON.stringify(res.body);
        expect(body, `${ep} leaked the marker`).not.toContain('Shree');
        for (const id of shreeIds) expect(body, `${ep} leaked id ${id}`).not.toContain(id);
      }
    });

    it('no Shree list contains a Vasavi word or id (after Shree also populated)', async () => {
      const vasaviIds = Object.values(A);
      for (const ep of LIST_ENDPOINTS) {
        const body = JSON.stringify((await shr.get(ep)).body);
        expect(body, ep).not.toContain('Vasavi');
        for (const id of vasaviIds) expect(body, `${ep} leaked id ${id}`).not.toContain(id);
      }
    });

    it('editing Shree\'s "NKL" category leaves Vasavi\'s "NKL" category exactly as it was', async () => {
      const r = await shr.patch(`/masters/categories/${B.cat}`, { name: 'Shree Renamed' });
      expect(r.status).toBe(200);
      const vasaviCat = await prisma.productCategory.findUniqueOrThrow({ where: { id: A.cat } });
      expect(vasaviCat.name).toBe('Vasavi Necklaces');
    });

    it('a duplicate code WITHIN one company is still rejected (409)', async () => {
      const r = await vas.post('/masters/categories', { code: 'NKL', name: 'Vasavi Duplicate' });
      expect(r.status).toBe(409);
    });
  });

  // ─── 3. Direct-ID attacks: Shree's token, Vasavi's ids ──────────────────────
  describe('direct ID attacks: Shree uses Vasavi\'s row ids', () => {
    const patches: Array<[string, string, object]> = [
      ['categories', 'cat', { name: 'HACKED' }],
      ['subcategories', 'sub', { name: 'HACKED' }],
      ['collections', 'col', { name: 'HACKED' }],
      ['material-codes', 'mat', { name: 'HACKED' }],
      ['stock-types', 'stock', { name: 'HACKED' }],
      ['stone-types', 'sty', { name: 'HACKED' }],
      ['stone-grades', 'sg', { shape: 'HACKED' }],
      ['karats', 'karat', { purity: 0.1 }],
      ['making-charges', 'mcg', { makingCharge: 0 }],
      ['price-master', 'pm', { pricePerCarat: 1 }],
    ];

    it.each(patches)('PATCH /masters/%s/<Vasavi id> as Shree → 404', async (route, key, body) => {
      const r = await shr.patch(`/masters/${route}/${A[key]}`, body);
      expect(r.status, JSON.stringify(r.body)).toBe(404);
    });

    it('DELETE of Vasavi\'s making charge / price entry as Shree → 404, and both are still active', async () => {
      expect((await shr.del(`/masters/making-charges/${A.mcg}`)).status).toBe(404);
      expect((await shr.del(`/masters/price-master/${A.pm}`)).status).toBe(404);
      expect((await prisma.makingCharge.findUniqueOrThrow({ where: { id: A.mcg } })).isActive).toBe(true);
      expect((await prisma.priceMaster.findUniqueOrThrow({ where: { id: A.pm } })).isActive).toBe(true);
    });

    it('none of the attempted edits changed a single Vasavi value', async () => {
      expect((await prisma.productCategory.findUniqueOrThrow({ where: { id: A.cat } })).name).toBe('Vasavi Necklaces');
      expect((await prisma.collection.findUniqueOrThrow({ where: { id: A.col } })).name).toBe('Vasavi Bridal Special Collection');
      expect((await prisma.stoneGrade.findUniqueOrThrow({ where: { id: A.sg } })).shape).toBe('ROUND');
      expect(Number((await prisma.karatMaster.findUniqueOrThrow({ where: { id: A.karat } })).purity)).toBeCloseTo(0.9);
      expect(Number((await prisma.makingCharge.findUniqueOrThrow({ where: { id: A.mcg } })).makingCharge)).toBe(500);
      expect(Number((await prisma.priceMaster.findUniqueOrThrow({ where: { id: A.pm } })).pricePerCarat)).toBe(1000);
    });

    it('a client-supplied companyId in a PATCH body is rejected outright (400), not silently applied', async () => {
      const r = await vas.patch(`/masters/categories/${A.cat}`, { name: 'x', companyId: shree.company.id });
      expect(r.status).toBe(400);
      expect((await prisma.productCategory.findUniqueOrThrow({ where: { id: A.cat } })).companyId).toBe(vasavi.company.id);
    });

    it('PATCH only writes whitelisted fields (an unexpected field is dropped, never persisted)', async () => {
      const r = await vas.patch(`/masters/categories/${A.cat}`, { name: 'Vasavi Necklaces', createdAt: '2000-01-01T00:00:00Z' });
      expect(r.status).toBe(200);
      const row = await prisma.productCategory.findUniqueOrThrow({ where: { id: A.cat } });
      expect(row.createdAt.getFullYear()).toBeGreaterThan(2000);
    });
  });

  // ─── 4. Forged relationships: Shree's request referencing Vasavi's master ─────
  describe('forged relations: a Shree request that references a Vasavi master must be rejected', () => {
    it('HTTP: sub-category under Vasavi\'s category → 404', async () => {
      expect((await shr.post('/masters/subcategories', { code: 'FORGE', name: 'x', categoryId: A.cat })).status).toBe(404);
    });
    it('HTTP: moving Shree\'s own sub-category under Vasavi\'s category → 404', async () => {
      expect((await shr.patch(`/masters/subcategories/${B.sub}`, { categoryId: A.cat })).status).toBe(404);
    });
    it('HTTP: stone grade under Vasavi\'s stone type → 404', async () => {
      expect((await shr.post('/masters/stone-grades', { stoneTypeId: A.sty, shape: 'x' })).status).toBe(404);
    });
    it('HTTP: making charge naming Vasavi\'s material code or category → 404', async () => {
      expect((await shr.post('/masters/making-charges', { materialCodeId: A.mat, makingCharge: 1 })).status).toBe(404);
      expect((await shr.post('/masters/making-charges', { categoryId: A.cat, makingCharge: 1 })).status).toBe(404);
    });
    it('HTTP: price master entry pointing at Vasavi\'s stone grade → 404', async () => {
      expect((await shr.post('/masters/price-master', { stoneGradeId: A.sg, pricePerCarat: 1 })).status).toBe(404);
    });

    const shreeTag = (over: Record<string, unknown>) => createTag(shree.ctx, {
      branchId: shree.branch.id, stockTypeId: B.stock, categoryId: B.cat, name: 'Forged Tag',
      metalType: 'GOLD', grossWeight: 1, netWeight: 1, ...over,
    } as Parameters<typeof createTag>[1], shree.user.id);

    it('createTag: Vasavi\'s stock type / category / sub-category / collection → 404', async () => {
      await expect(shreeTag({ stockTypeId: A.stock })).rejects.toMatchObject({ statusCode: 404 });
      await expect(shreeTag({ categoryId: A.cat })).rejects.toMatchObject({ statusCode: 404 });
      await expect(shreeTag({ subCategoryId: A.sub })).rejects.toMatchObject({ statusCode: 404 });
      await expect(shreeTag({ collectionId: A.col })).rejects.toMatchObject({ statusCode: 404 });
    });
    it('createTag: a material row naming Vasavi\'s material code or stone grade → 404', async () => {
      await expect(shreeTag({ materials: [{ code: 'X', materialType: 'METAL', materialCodeId: A.mat, weight: 1 }] })).rejects.toMatchObject({ statusCode: 404 });
      await expect(shreeTag({ materials: [{ code: 'X', materialType: 'DIAMOND', stoneGradeId: A.sg, weight: 1 }] })).rejects.toMatchObject({ statusCode: 404 });
    });
    it('createTag with Shree\'s OWN masters succeeds (control — the rejections above are about ownership, not a broken path)', async () => {
      const ok = await shreeTag({
        subCategoryId: B.sub, collectionId: B.col,
        materials: [{ code: 'G22', materialType: 'METAL', materialCodeId: B.mat, weight: 1 }],
      });
      expect(ok.companyId).toBe(shree.company.id);
    });
    it('updateTag path is guarded too (Shree editing its own tag to use a Vasavi category → 404)', async () => {
      const { updateTag } = await import('../modules/tagging/tagging.service');
      const own = await shreeTag({ name: 'Shree Edit Me' });
      await expect(updateTag(own.id, { categoryId: A.cat }, shree.ctx, shree.user.id)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('createInvoice: a line carrying Vasavi\'s category → 404', async () => {
      await expect(createInvoice({
        clientId: shreeClientId, invoiceDate: new Date(), invoiceType: 'RETAIL', branchId: shree.branch.id,
        items: [{
          productCode: 'X', description: 'forged', quantity: 1, grossWeight: 1, netGoldWeight: 1,
          rateType: 'FIXED', goldRate: 1000, categoryId: A.cat,
        }],
      }, shree.ctx, shree.user.id)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('createDesign: Vasavi\'s design category → 404', async () => {
      await expect(createDesign({
        name: 'Forged Design', categoryId: A.dcat, metalKarat: '22K',
        grossWeightMin: 1, grossWeightMax: 2, netWeightMin: 1, netWeightMax: 2,
      }, shree.company.id, shree.user.id)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('karat validation reads the caller\'s OWN list: Vasavi\'s custom "VAS22" is unknown to Shree', async () => {
      await expect(shreeTag({ metalKarat: 'VAS22' })).rejects.toMatchObject({ statusCode: 400 });
      const vasTag = await createTag(vasavi.ctx, {
        branchId: vasavi.branch.id, stockTypeId: A.stock, categoryId: A.cat, name: 'Vasavi Custom Karat',
        metalType: 'GOLD', metalKarat: 'VAS22', grossWeight: 1, netWeight: 1,
      }, vasavi.user.id);
      expect(vasTag.metalKarat).toBe('VAS22');
    });
  });

  // ─── 5. The database enforces it even if application code forgets the filter ──
  describe('database level (RLS): the app "forgets" its company filter — Postgres still refuses', () => {
    const ROLLBACK = new Error('__deliberate_rollback__');

    // The dev/test role owns these tables, and an owner bypasses RLS unless FORCEd — same proof
    // technique as the other rls.*.test.ts files: FORCE inside a transaction that is always rolled
    // back, so it is never persisted.
    async function asTenantWithForcedRls<T>(companyId: string, tables: string[], fn: (tx: any) => Promise<T>): Promise<T> {
      let out!: T;
      try {
        await rlsClient.$transaction(async (tx) => {
          for (const t of tables) if (!REAL_ROLE_SPLIT) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
          await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyId}, true)`;
          out = await fn(tx);
          throw ROLLBACK;
        });
      } catch (e) {
        if (e !== ROLLBACK) throw e;
      }
      return out;
    }

    it('precondition: both companies really do have rows in all nine master tables (so the test isn\'t vacuous)', async () => {
      for (const t of NINE_MASTER_TABLES) {
        const rows: Array<{ n: number }> = await prisma.$queryRawUnsafe(
          `SELECT count(DISTINCT "companyId")::int n FROM "${t}" WHERE "companyId" IN ('${vasavi.company.id}', '${shree.company.id}')`);
        expect(rows[0].n, t).toBe(2);
      }
    });

    it('a bare `SELECT ... FROM <master>` with NO company filter returns only the session company\'s rows — all nine tables', async () => {
      const seen = await asTenantWithForcedRls(shree.company.id, NINE_MASTER_TABLES, async (tx) => {
        const out: Record<string, string[]> = {};
        for (const t of NINE_MASTER_TABLES) {
          const rows: Array<{ companyId: string }> = await tx.$queryRawUnsafe(`SELECT DISTINCT "companyId" FROM "${t}"`);
          out[t] = rows.map((r) => r.companyId);
        }
        return out;
      });
      for (const t of NINE_MASTER_TABLES) expect(seen[t], t).toEqual([shree.company.id]);
    });

    it('with no tenant session variable at all, the policy fails closed: zero rows', async () => {
      const counts = await (async () => {
        let out: Record<string, number> = {};
        try {
          await rlsClient.$transaction(async (tx) => {
            for (const t of NINE_MASTER_TABLES) if (!REAL_ROLE_SPLIT) await tx.$executeRawUnsafe(`ALTER TABLE "${t}" FORCE ROW LEVEL SECURITY`);
            for (const t of NINE_MASTER_TABLES) {
              const r: Array<{ n: number }> = await tx.$queryRawUnsafe(`SELECT count(*)::int n FROM "${t}"`);
              out[t] = r[0].n;
            }
            throw ROLLBACK;
          });
        } catch (e) { if (e !== ROLLBACK) throw e; }
        return out;
      })();
      for (const t of NINE_MASTER_TABLES) expect(counts[t], t).toBe(0);
    });

    it('a session scoped to Shree cannot INSERT a master row owned by Vasavi (WITH CHECK)', async () => {
      await expect(
        asTenantWithForcedRls(shree.company.id, ['product_categories'], (tx) =>
          tx.$executeRaw`INSERT INTO product_categories (id, "companyId", code, name, "isActive", "createdAt")
            VALUES (gen_random_uuid()::text, ${vasavi.company.id}, ${'FORGED-' + suffix}, 'Forged', true, now())`),
      ).rejects.toThrow(/row-level security/i);
    });

    it('a session scoped to Shree cannot UPDATE Vasavi\'s row (it is invisible — zero rows affected)', async () => {
      const affected = await asTenantWithForcedRls(shree.company.id, ['product_categories'], (tx) =>
        tx.$executeRaw`UPDATE product_categories SET name = 'HACKED' WHERE id = ${A.cat}`);
      expect(affected).toBe(0);
      expect((await prisma.productCategory.findUniqueOrThrow({ where: { id: A.cat } })).name).toBe('Vasavi Necklaces');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Schema guard — the rule for the whole data model, enforced mechanically so a future model can't
// quietly reintroduce shared client data:
//
//   Every client-owned record must be unambiguously associated with exactly one company, either
//   directly through companyId or through a strictly company-owned parent. Only explicitly
//   approved TRIVO platform records may exist outside a company.
//
// A model with no companyId column must be on this allow-list, with the reason. Adding a model
// to the list is a deliberate, reviewable act; forgetting companyId on a new client-data model
// fails this test.
// ═══════════════════════════════════════════════════════════════════════════
describe('schema guard: nothing client-owned exists outside a company', () => {
  const APPROVED_WITHOUT_COMPANY_ID: Record<string, string> = {
    Company: 'the tenant itself',
    User: 'global LOGIN identity only (email, password hash, name); every per-company fact about the person lives on CompanyUser',
    HsnCode: 'statutory GST reference data owned by the platform; read-only to every company',
    StateMaster: 'statutory GST state-code reference data owned by the platform; read-only to every company',
    PlatformAuditLog: 'TRIVO platform events (operator actions, unattributable legacy audit rows) — a separate table by design, never exposed to a company; a company event goes in AuditLog',
  };

  it('every model has companyId, or is on the approved platform/child allow-list', () => {
    const schema = fs.readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map((m) => ({ name: m[1], body: m[2] }));
    expect(models.length).toBeGreaterThan(50);

    const unscoped = models.filter((m) => !/^\s+companyId\s/m.test(m.body)).map((m) => m.name).sort();
    const unapproved = unscoped.filter((n) => !(n in APPROVED_WITHOUT_COMPANY_ID));
    expect(unapproved, `models with no companyId that are not on the approved list: ${unapproved.join(', ')}`).toEqual([]);

    // ...and the allow-list must not go stale (a listed model that gained companyId or vanished).
    const stale = Object.keys(APPROVED_WITHOUT_COMPANY_ID).filter((n) => !unscoped.includes(n));
    expect(stale, `allow-list entries that are no longer unscoped: ${stale.join(', ')}`).toEqual([]);
  });

  it('every model that has a companyId column also has a tenant_isolation RLS policy in the database', async () => {
    const schema = fs.readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
    const scoped = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)]
      .filter((m) => /^\s+companyId\s/m.test(m[2]))
      .map((m) => ({ name: m[1], table: /@@map\("(\w+)"\)/.exec(m[2])?.[1] }));
    const withPolicy: Array<{ tablename: string }> = await prisma.$queryRawUnsafe(
      `SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation'`);
    const have = new Set(withPolicy.map((r) => r.tablename));
    const missing = scoped.filter((s) => s.table && !have.has(s.table)).map((s) => s.name);
    expect(missing, `company-scoped tables with no RLS policy: ${missing.join(', ')}`).toEqual([]);
  });
});
