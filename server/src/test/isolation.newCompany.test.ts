import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import {
  apiWith, purgeCompany, enumerateRoutes, allCompanyRowIds, crossCompanyForeignKeyViolations,
} from './fixtures';
import { provisionCompany } from '../modules/platform/provisioning.service';

// ═══════════════════════════════════════════════════════════════════════════
// The acceptance test for the whole multi-company architecture:
//
//   A company is provisioned AFTER Vasavi has real, varied data — and must start with its own
//   Starter Package and zero ability to see or modify anything belonging to Vasavi. Then the reverse.
//
// Everything is exercised over real HTTP, and the sweep covers EVERY route the application serves
// (discovered from Express itself), so an endpoint added later is covered automatically.
// ═══════════════════════════════════════════════════════════════════════════

const PASSWORD = 'Accept-Passw0rd-123';
const DOMAIN = '@acceptance.example.com';
const CUID = /\bc[a-z0-9]{24}\b/g;

interface Co {
  id: string; code: string; api: ReturnType<typeof apiWith>; token: string;
  ids: Record<string, string>; rowIds: Set<string>; markers: string[]; branchId: string;
}

describe('Acceptance: a new company after Vasavi has substantial data', () => {
  const vasavi = {} as Co;
  const shree = {} as Co;

  async function bringUp(co: Co, code: string, name: string, marker: string) {
    const admin = { email: `${marker.toLowerCase()}-owner${DOMAIN}`, name: `${marker} Owner`, password: PASSWORD };
    const r = await provisionCompany({ code, name, admin, stateCode: '24' });
    co.id = r.company.id; co.code = code; co.branchId = r.branch.id; co.ids = {};
    const login = await apiWith(undefined, app).post('/auth/login', { companyCode: code, identifier: admin.email, password: PASSWORD });
    expect(login.status, JSON.stringify(login.body)).toBe(200);
    co.token = login.body.data.accessToken;
    co.api = apiWith(co.token, app);
  }

  /** Real business data, entered through the API exactly as a user would. Every string carries `marker`. */
  async function populate(co: Co, marker: string) {
    const ok = (r: any, what: string) => { expect(r.status, `${what}: ${JSON.stringify(r.body)}`).toBeLessThan(300); return r.body.data; };
    const api = co.api; const ids = co.ids;
    // Each company writes its OWN internal note. (Vasavi's is the one from the requirement.)
    const note = marker === 'Vasavi' ? 'call customer after 6 PM' : `${marker} note: hold delivery till Friday`;
    co.markers = [marker, note];

    ids.category = ok(await api.post('/masters/categories', { code: `${marker.slice(0, 3).toUpperCase()}BRD`, name: `${marker} Bridal Category` }), 'category').id;
    ids.collection = ok(await api.post('/masters/collections', {
      code: 'BRIDAL', name: `${marker} Bridal Special Collection`, description: note,
    }), 'collection').id;
    ids.materialCode = ok(await api.post('/masters/material-codes', { code: `${marker.slice(0, 3).toUpperCase()}MAT`, name: `${marker} Custom Alloy`, materialType: 'METAL', karat: '22K' }), 'material').id;
    ids.stockType = ok(await api.post('/masters/stock-types', { code: 'V', name: `${marker} Showroom Stock` }), 'stock type').id;
    ids.stoneType = ok(await api.post('/masters/stone-types', { code: `${marker.slice(0, 3).toUpperCase()}GEM`, name: `${marker} Special Gem`, itemType: 'STONE' }), 'stone type').id;
    ids.client = ok(await api.post('/orders/clients', { name: `${marker} Customer Lakshmi`, type: 'RETAIL', phone: '+91-90000-11111', city: `${marker}pur` }), 'client').id;
    ids.supplier = ok(await api.post('/procurement/suppliers', { name: `${marker} Bullion Supplier`, type: 'METAL_REFINER', city: `${marker}nagar` }), 'supplier').id;
    ids.branch = ok(await api.post('/tagging/branches', { name: `${marker} Bandra Showroom`, branchCode: 'BND' }), 'branch').id;
    ok(await api.put(`/settings/config/${marker.toUpperCase()}_INTERNAL_NOTE`, { value: note, category: 'GENERAL' }), 'config');
    ids.tagTemplate = ok(await api.post('/tagging/templates', {
      name: `${marker} Special Tag`, widthMm: 50, heightMm: 30, gapMm: 2, isDefault: false,
      layout: { elements: [{ id: 't1', wing: 'front', type: 'text', xMm: 2, yMm: 2, literalText: `${marker} Bridal`, fontSize: 8 }] },
    }), 'tag template').id;
    ids.estimateTemplate = ok(await api.post('/estimation/templates', {
      name: `${marker} Estimate Layout`, widthMm: 80, heightMm: 150, isDefault: false,
      layout: { elements: [{ id: 'e1', type: 'text', xMm: 2, yMm: 2, literalText: `${marker} Estimate`, fontSize: 10 }] },
    }), 'estimate template').id;

    const tag = ok(await api.post('/tagging/tags', {
      branchId: co.branchId, stockTypeId: ids.stockType, categoryId: ids.category, collectionId: ids.collection,
      name: `${marker} Bridal Necklace`, metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, sellingPrice: 90000,
      notes: note,
      materials: [{ code: 'MAT1', materialType: 'METAL', materialCodeId: ids.materialCode, weight: 10 }],
    }), 'tag');
    ids.tag = tag.id;
    // (Tag / invoice NUMBERS are per-company sequences — both companies legitimately have an INV-…-000001 —
    // so they are not leak markers; row ids and the free-text strings are.)

    const inv = ok(await api.post('/sales/invoices', {
      clientId: ids.client, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', branchId: co.branchId, currency: 'INR',
      notes: note,
      items: [{ productCode: 'V1', description: `${marker} Bridal Necklace`, quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 90000, karat: '22K', tagId: tag.id }],
    }), 'invoice');
    ids.invoice = inv.id;

    // Volume — a real business has far more than one of anything.
    const admin = await prisma.companyUser.findFirstOrThrow({ where: { companyId: co.id }, select: { userId: true } });
    await prisma.client.createMany({ data: Array.from({ length: 60 }, (_, i) => ({ companyId: co.id, clientCode: `${marker.slice(0, 2)}C${i}`, name: `${marker} Bulk Customer ${i}`, type: 'RETAIL' })) });
    await prisma.supplier.createMany({ data: Array.from({ length: 30 }, (_, i) => ({ companyId: co.id, supplierCode: `${marker.slice(0, 2)}S${i}`, name: `${marker} Bulk Supplier ${i}`, type: 'OTHER' })) });
    await prisma.jewelryTag.createMany({
      data: Array.from({ length: 120 }, (_, i) => ({
        companyId: co.id, tagNumber: `${marker.slice(0, 2)}-BULK-${i}`, branchId: co.branchId, name: `${marker} Bulk Piece ${i}`,
        metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5, createdById: admin.userId,
      })),
    });
    await prisma.productCategory.createMany({ data: Array.from({ length: 15 }, (_, i) => ({ companyId: co.id, code: `${marker.slice(0, 2)}B${i}`, name: `${marker} Bulk Category ${i}` })) });
    co.rowIds = await allCompanyRowIds(co.id);
  }

  beforeAll(async () => {
    // Fixed, human codes as in the requirement. Clear any leftovers from an earlier aborted run.
    for (const code of ['VASAVI', 'SHREE']) {
      const old = await prisma.company.findUnique({ where: { code } });
      if (old) await purgeCompany(old.id);
    }
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });

    await bringUp(vasavi, 'VASAVI', 'Vasavi Gold & Diamonds', 'Vasavi');
    await populate(vasavi, 'Vasavi');
    // Shree is provisioned only AFTER Vasavi is fully populated.
    await bringUp(shree, 'SHREE', 'Shree Silver Palace', 'Shree');
  }, 120_000);

  afterAll(async () => {
    for (const co of [vasavi, shree]) if (co.id) await purgeCompany(co.id);
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.$disconnect();
  });

  // The whole response, however nested, must contain none of the other company's markers or row ids.
  const leaks = (body: unknown, other: Co): string[] => {
    const text = JSON.stringify(body ?? '');
    const found: string[] = [];
    for (const m of other.markers) if (text.includes(m)) found.push(`marker "${m}"`);
    for (const id of text.match(CUID) ?? []) if (other.rowIds.has(id)) found.push(`id ${id}`);
    return found;
  };

  // ─── 1. The new company gets its own Starter Package ─────────────────────────
  describe('SHREE (provisioned after Vasavi) has its own Starter Package and nothing of Vasavi', () => {
    it('its starter data exists: categories, karats, stock types, templates, chart of accounts, roles', async () => {
      const cats = (await shree.api.get('/masters/categories')).body.data as any[];
      expect(cats.map((c) => c.code)).toEqual(expect.arrayContaining(['RNG', 'NKL', 'CHN', 'BNG']));
      expect((await shree.api.get('/masters/karats')).body.data.map((k: any) => k.code)).toEqual(expect.arrayContaining(['22K', '18K', 'SILVER', 'PT']));
      expect((await shree.api.get('/masters/stock-types')).body.data.map((s: any) => s.code)).toEqual(expect.arrayContaining(['R', 'S', 'C']));
      expect((await shree.api.get('/tagging/templates')).body.data.map((t: any) => t.name)).toContain('Default Jewelry Tag');
      expect((await shree.api.get('/estimation/templates')).body.data.map((t: any) => t.name)).toContain('Default Estimate (80mm roll)');
      expect((await shree.api.get('/settings/config')).body.data.map((c: any) => c.key)).toEqual(['DEFAULT_GOLD_MARGIN']);
      expect((await shree.api.get('/settings/roles')).body.data.length).toBe(6);
    });

    it('none of Vasavi\'s customers, suppliers, tags, invoices, branches, categories, collections, templates, config or notes exist for Shree', async () => {
      const shreeView: Array<[string, any]> = [
        ['clients', (await shree.api.get('/orders/clients')).body],
        ['suppliers', (await shree.api.get('/procurement/suppliers')).body],
        ['tags', (await shree.api.get('/tagging/tags')).body],
        ['invoices', (await shree.api.get('/sales/invoices')).body],
        ['branches', (await shree.api.get('/tagging/branches')).body],
        ['categories', (await shree.api.get('/masters/categories')).body],
        ['collections', (await shree.api.get('/masters/collections')).body],
        ['material codes', (await shree.api.get('/masters/material-codes')).body],
        ['stock types', (await shree.api.get('/masters/stock-types')).body],
        ['stone types', (await shree.api.get('/masters/stone-types')).body],
        ['tag templates', (await shree.api.get('/tagging/templates')).body],
        ['estimate templates', (await shree.api.get('/estimation/templates')).body],
        ['config', (await shree.api.get('/settings/config')).body],
        ['users', (await shree.api.get('/auth/users')).body],
      ];
      for (const [what, body] of shreeView) expect(leaks(body, vasavi), what).toEqual([]);
      // and the volume Vasavi holds is invisible: Shree has one branch, one member, and no clients/suppliers
      expect((await shree.api.get('/tagging/branches')).body.data).toHaveLength(1);
      expect((await shree.api.get('/auth/users')).body.data).toHaveLength(1);
      expect((await shree.api.get('/masters/collections')).body.data).toEqual([]);
    });
  });

  // ─── 2. Sweep EVERY GET route ────────────────────────────────────────────────
  describe('every GET endpoint in the application', () => {
    const routes = () => enumerateRoutes(app).filter((r) => r.method === 'GET' && r.path.startsWith('/api/v1/'));

    it('Shree calling every list/report endpoint never receives a Vasavi string or Vasavi row id', async () => {
      const list = routes().filter((r) => !r.path.includes(':'));
      expect(list.length).toBeGreaterThan(40);
      const problems: string[] = [];
      for (const r of list) {
        const res = await shree.api.get(r.path.replace('/api/v1', ''));
        expect(res.status, `${r.path} must not crash`).toBeLessThan(500);
        const l = leaks(res.body, vasavi);
        if (l.length) problems.push(`${r.path}: ${l.join(', ')}`);
      }
      expect(problems).toEqual([]);
    });

    it('…and the reverse: Vasavi never receives a Shree string or row id (checked after Shree has data too)', async () => {
      await populate(shree, 'Shree');
      const list = routes().filter((r) => !r.path.includes(':'));
      const problems: string[] = [];
      for (const r of list) {
        const res = await vasavi.api.get(r.path.replace('/api/v1', ''));
        expect(res.status, r.path).toBeLessThan(500);
        const l = leaks(res.body, shree);
        if (l.length) problems.push(`${r.path}: ${l.join(', ')}`);
      }
      expect(problems).toEqual([]);
    }, 120_000);
  });

  // ─── 3. Direct ID attacks on every route that takes an id ────────────────────
  describe('direct ID attacks', () => {
    const paramRoutes = () => enumerateRoutes(app).filter((r) => r.method === 'GET' && r.path.startsWith('/api/v1/') && r.path.includes(':'));

    it('Shree requesting any of Vasavi\'s records by id — on every id-taking GET route — is never served, never crashes', async () => {
      const targets = Object.values(vasavi.ids);
      expect(paramRoutes().length).toBeGreaterThan(10);
      const bad: string[] = [];
      for (const r of paramRoutes()) {
        for (const id of targets) {
          const path = r.path.replace('/api/v1', '').replace(/:[A-Za-z]+/g, id);
          const res = await shree.api.get(path);
          const l = leaks(res.body, vasavi);
          if (res.status >= 500) bad.push(`${path} -> ${res.status}`);
          else if (res.status === 200 && l.length) bad.push(`${path} -> 200 leaking ${l.join(', ')}`);
          else if (l.length) bad.push(`${path} -> ${res.status} leaking ${l.join(', ')}`);
        }
      }
      expect(bad).toEqual([]);
    }, 120_000);

    it('Shree cannot modify Vasavi\'s records (404 each), and nothing changed', async () => {
      const before = await prisma.client.findUniqueOrThrow({ where: { id: vasavi.ids.client } });
      expect((await shree.api.patch(`/orders/clients/${vasavi.ids.client}`, { name: 'HACKED' })).status).toBe(404);
      expect((await shree.api.patch(`/masters/categories/${vasavi.ids.category}`, { name: 'HACKED' })).status).toBe(404);
      expect((await shree.api.patch(`/masters/collections/${vasavi.ids.collection}`, { name: 'HACKED' })).status).toBe(404);
      expect((await shree.api.patch(`/tagging/branches/${vasavi.ids.branch}`, { name: 'HACKED' })).status).toBe(404);
      expect((await shree.api.put(`/tagging/templates/${vasavi.ids.tagTemplate}`, { name: 'HACKED', widthMm: 1, heightMm: 1, layout: { elements: [] } })).status).toBe(404);
      expect((await shree.api.put(`/estimation/templates/${vasavi.ids.estimateTemplate}`, { name: 'HACKED', widthMm: 1, heightMm: 1, layout: { elements: [] } })).status).toBe(404);
      expect(await prisma.client.findUniqueOrThrow({ where: { id: vasavi.ids.client } })).toEqual(before);
      expect((await prisma.productCategory.findUniqueOrThrow({ where: { id: vasavi.ids.category } })).name).toBe('Vasavi Bridal Category');
      expect((await prisma.collection.findUniqueOrThrow({ where: { id: vasavi.ids.collection } })).name).toBe('Vasavi Bridal Special Collection');
    });
  });

  // ─── 4. Forged relationships ────────────────────────────────────────────────
  describe('forged foreign keys', () => {
    it('Shree cannot build a tag or an invoice on Vasavi\'s category, stock type, collection, material, client, branch or tag', async () => {
      const v = vasavi.ids;
      const tag = (over: object) => shree.api.post('/tagging/tags', {
        branchId: shree.branchId, name: 'Forged', metalType: 'GOLD', grossWeight: 1, netWeight: 1,
        stockTypeId: shree.ids.stockType, categoryId: shree.ids.category, ...over,
      });
      expect((await tag({ categoryId: v.category })).status).toBe(404);
      expect((await tag({ stockTypeId: v.stockType })).status).toBe(404);
      expect((await tag({ collectionId: v.collection })).status).toBe(404);
      expect((await tag({ branchId: vasavi.branchId })).status).toBe(404);
      expect((await tag({ materials: [{ code: 'X', materialType: 'METAL', materialCodeId: v.materialCode, weight: 1 }] })).status).toBe(404);

      const inv = (over: object, item: object = {}) => shree.api.post('/sales/invoices', {
        clientId: shree.ids.client, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', branchId: shree.branchId, currency: 'INR',
        items: [{ productCode: 'F', description: 'Forged', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 1000, ...item }], ...over,
      });
      expect((await inv({ clientId: v.client })).status).toBe(404);
      expect((await inv({ branchId: vasavi.branchId })).status).toBe(404);
      expect((await inv({}, { tagId: v.tag })).status).toBeGreaterThanOrEqual(400);
      expect((await inv({}, { categoryId: v.category })).status).toBe(404);
    });

    it('the database holds ZERO cross-company references — across every foreign key between company-owned tables', async () => {
      expect(await crossCompanyForeignKeyViolations()).toEqual([]);
    });
  });

  // ─── 5. Independence ────────────────────────────────────────────────────────
  describe('the two companies are fully independent', () => {
    it('Shree changing its own starter data does not touch Vasavi\'s copy, and vice versa', async () => {
      const vasNkl = await prisma.productCategory.findUniqueOrThrow({ where: { companyId_code: { companyId: vasavi.id, code: 'NKL' } } });
      const shrNkl = await prisma.productCategory.findUniqueOrThrow({ where: { companyId_code: { companyId: shree.id, code: 'NKL' } } });
      expect(vasNkl.id).not.toBe(shrNkl.id);
      expect((await shree.api.patch(`/masters/categories/${shrNkl.id}`, { name: 'Shree Chains & Necklaces' })).status).toBe(200);
      expect((await prisma.productCategory.findUniqueOrThrow({ where: { id: vasNkl.id } })).name).toBe('Necklaces');
      expect((await vasavi.api.patch(`/masters/categories/${vasNkl.id}`, { name: 'Vasavi Necklaces' })).status).toBe(200);
      expect((await prisma.productCategory.findUniqueOrThrow({ where: { id: shrNkl.id } })).name).toBe('Shree Chains & Necklaces');
    });

    it('each company\'s own data is fully visible to itself (control — isolation is not "hide everything")', async () => {
      expect(JSON.stringify((await vasavi.api.get('/orders/clients')).body)).toContain('Vasavi Customer Lakshmi');
      expect(JSON.stringify((await shree.api.get('/orders/clients')).body)).toContain('Shree Customer Lakshmi');
      expect(JSON.stringify((await vasavi.api.get('/masters/collections')).body)).toContain('Vasavi Bridal Special Collection');
      expect(JSON.stringify((await shree.api.get('/masters/collections')).body)).toContain('Shree Bridal Special Collection');
    });
  });
});
