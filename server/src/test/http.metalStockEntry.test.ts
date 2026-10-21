import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';

// Hand-entered Metal Vault stock (POST /inventory/metals): the lot's metal is the Karat master's, never the client's, and the
// stock listing (GET /inventory/metals?metalType=) applies the very rule a material sale draws with.
describe('HTTP: Metal Vault stock entry and the metal-eligibility filter', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
  let A: TestTenant;
  let B: TestTenant;
  let viewOnly: TestTenant;
  let api: ReturnType<typeof apiWith>;

  const body = (over: Record<string, unknown> = {}) => ({
    materialName: 'Lot', karat: '22K', purity: 0.916, grossWeight: 10, netWeight: 9.9, location: 'VAULT', sourceType: 'PURCHASE', avgCostPerGram: 5000, ...over,
  });
  const lotCount = () => prisma.metalStock.count({ where: { companyId: A.company.id } });

  beforeAll(async () => {
    A = await createTestTenant(`MSE${suffix}A`, ['stock:adjust', 'stock:view']);
    B = await createTestTenant(`MSE${suffix}B`, ['stock:adjust', 'stock:view']);
    viewOnly = await createTestTenant(`MSE${suffix}V`, ['stock:view']);
    api = apiWith(tokenFor(A), app);
    for (const t of [A, viewOnly]) {
      await prisma.karatMaster.upsert({
        where: { companyId_code: { companyId: t.company.id, code: '925' } },
        create: { companyId: t.company.id, code: '925', metalType: 'SILVER', purity: 0.925 }, update: { metalType: 'SILVER', purity: 0.925, isActive: true },
      });
    }
    await prisma.karatMaster.upsert({
      where: { companyId_code: { companyId: A.company.id, code: 'PT' } },
      create: { companyId: A.company.id, code: 'PT', metalType: 'PLATINUM', purity: 0.95 }, update: { metalType: 'PLATINUM', purity: 0.95, isActive: true },
    });
    // a karat that exists ONLY in company B's master
    await prisma.karatMaster.upsert({
      where: { companyId_code: { companyId: B.company.id, code: 'BONLY' } },
      create: { companyId: B.company.id, code: 'BONLY', metalType: 'SILVER', purity: 0.8 }, update: { metalType: 'SILVER', purity: 0.8, isActive: true },
    });
  });

  afterAll(async () => {
    for (const t of [A, B, viewOnly]) await cleanupTestTenant(t);
    await prisma.$disconnect();
  });

  describe('gold and silver stock entry', () => {
    it('a gold karat is stored as GOLD (explicit, not NULL), with or without the client stating it', async () => {
      const stated = await api.post('/inventory/metals', body({ metalType: 'GOLD' }));
      expect(stated.status).toBe(201);
      expect(stated.body.data.metalType).toBe('GOLD');
      const omitted = await api.post('/inventory/metals', body());
      expect(omitted.status).toBe(201);
      expect(omitted.body.data.metalType).toBe('GOLD');
      expect(omitted.body.data.companyId).toBe(A.company.id);
    });

    it('a silver karat is stored as SILVER; the master purity fills in when none is sent', async () => {
      const res = await api.post('/inventory/metals', body({ karat: '925', metalType: 'SILVER', purity: undefined }));
      expect(res.status).toBe(201);
      expect(res.body.data.metalType).toBe('SILVER');
      expect(Number(res.body.data.purity)).toBeCloseTo(0.925);
    });

    it('the metal is normalized for case: "silver" on a silver karat is accepted', async () => {
      const res = await api.post('/inventory/metals', body({ karat: '925', metalType: ' silver ' }));
      expect(res.status).toBe(201);
      expect(res.body.data.metalType).toBe('SILVER');
    });
  });

  describe('the metal must match the Karat master (400, nothing written)', () => {
    it('refuses a metal that disagrees with the karat, in both directions', async () => {
      const before = await lotCount();
      expect((await api.post('/inventory/metals', body({ karat: '22K', metalType: 'SILVER' }))).status).toBe(400);
      expect((await api.post('/inventory/metals', body({ karat: '925', metalType: 'GOLD' }))).status).toBe(400);
      expect(await lotCount()).toBe(before);
    });

    it.each([5, true, {}, [], 'COPPER', 'PLATINUM', ''])('refuses an invalid metalType (%j) with 400, not a server error', async (bad) => {
      const before = await lotCount();
      const res = await api.post('/inventory/metals', body({ metalType: bad }));
      expect(res.status).toBe(400);
      expect(await lotCount()).toBe(before);
    });

    it('refuses a karat the master does not have, a platinum karat, and another company\'s karat', async () => {
      const before = await lotCount();
      expect((await api.post('/inventory/metals', body({ karat: 'NOPE' }))).status).toBe(400);
      expect((await api.post('/inventory/metals', body({ karat: 'PT' }))).status).toBe(400); // the vault is gold and silver only
      expect((await api.post('/inventory/metals', body({ karat: 'BONLY' }))).status).toBe(400); // exists only in company B
      expect(await lotCount()).toBe(before);
      expect(await prisma.metalStock.count({ where: { companyId: B.company.id } })).toBe(0);
    });

    it('refuses nonsense weights', async () => {
      const before = await lotCount();
      for (const over of [{ grossWeight: 0 }, { netWeight: 0 }, { grossWeight: 'abc' }, { netWeight: 11 }, { avgCostPerGram: -1 }, { materialName: '' }]) {
        expect((await api.post('/inventory/metals', body(over))).status).toBe(400);
      }
      expect(await lotCount()).toBe(before);
    });
  });

  describe('the request is validated and whitelisted, never spread into the row', () => {
    it('a body naming a companyId is refused at the edge (400) and writes nothing - the tenant comes from authentication only', async () => {
      const before = await lotCount();
      const res = await api.post('/inventory/metals', body({ companyId: B.company.id }));
      expect(res.status).toBe(400);
      expect(await lotCount()).toBe(before);
      expect(await prisma.metalStock.count({ where: { companyId: B.company.id } })).toBe(0);
    });

    it('other row fields in the body (id / stockCode / availableWt / isActive) are ignored, never spread into the row', async () => {
      const res = await api.post('/inventory/metals', body({ id: 'forged-id', stockCode: 'HACK', availableWt: 9999, isActive: false, netWeight: 9.9 }));
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const row = await prisma.metalStock.findUniqueOrThrow({ where: { id: res.body.data.id } });
      expect(row.companyId).toBe(A.company.id);
      expect(row.id).not.toBe('forged-id');
      expect(row.stockCode).not.toBe('HACK');
      expect(Number(row.availableWt)).toBeCloseTo(9.9);
      expect(row.isActive).toBe(true);
    });

    it('stock:adjust is required - a stock:view-only user gets 403 and nothing is written', async () => {
      const denied = await apiWith(tokenFor(viewOnly), app).post('/inventory/metals', body({ karat: '925' }));
      expect(denied.status).toBe(403);
      expect(await prisma.metalStock.count({ where: { companyId: viewOnly.company.id } })).toBe(0);
    });
  });

  describe('GET /inventory/metals?metalType= applies the same eligibility rule a sale draws with', () => {
    it('SILVER lists SILVER lots only; GOLD lists GOLD plus legacy NULL lots; no filter lists everything; junk is a 400', async () => {
      const mk = (karat: string, metalType: string | null, stockCode: string, wt: number) => prisma.metalStock.create({
        data: { companyId: A.company.id, stockCode: `${stockCode}-${suffix}`, materialName: stockCode, karat, purity: 0.9, grossWeight: wt, netWeight: wt, availableWt: wt, sourceType: 'PURCHASE', avgCostPerGram: 1, metalType },
      });
      await mk('FLT', 'SILVER', 'S1', 11);
      await mk('FLT', 'GOLD', 'G1', 12);
      await mk('FLT', null, 'N1', 13); // legacy: no stored metal
      const codes = async (q: string) => ((await api.get(`/inventory/metals?karat=FLT${q}`)).body.data as Array<{ stockCode: string }>).map((l) => l.stockCode.split('-')[0]).sort();

      expect(await codes('&metalType=SILVER')).toEqual(['S1']); // a NULL lot is never silver
      expect(await codes('&metalType=GOLD')).toEqual(['G1', 'N1']);
      expect(await codes('&metalType=silver')).toEqual(['S1']);
      expect(await codes('')).toEqual(['G1', 'N1', 'S1']); // unchanged without the filter
      expect((await api.get('/inventory/metals?karat=FLT&metalType=COPPER')).status).toBe(400);
    });
  });

  describe('GET /inventory/metals/karats (vault karat lookup)', () => {
    it('a stock:view user with no masters:view gets the active gold and silver karats of its own company only', async () => {
      const r = await apiWith(tokenFor(viewOnly), app).get('/inventory/metals/karats');
      expect(r.status).toBe(200);
      const codes = r.body.data.map((k: any) => k.code);
      expect(codes).toContain('925');
      expect(r.body.data.every((k: any) => ['GOLD', 'SILVER'].includes(k.metalType))).toBe(true);
      expect(Object.keys(r.body.data[0]).sort()).toEqual(['code', 'metalType', 'purity']);
    });
    it('excludes platinum and other companies karats', async () => {
      const codes = (await api.get('/inventory/metals/karats')).body.data.map((k: any) => k.code);
      expect(codes).not.toContain('PT');
      expect(codes).not.toContain('BONLY');
    });
    it('a user without stock:view is refused (403)', async () => {
      const none = await createTestTenant(`MSE${suffix}N`, ['client:view']);
      try { expect((await apiWith(tokenFor(none), app).get('/inventory/metals/karats')).status).toBe(403); } finally { await cleanupTestTenant(none); }
    });
    it('the masters route itself is still gated by masters:view', async () => {
      expect((await apiWith(tokenFor(viewOnly), app).get('/masters/karats')).status).toBe(403);
    });
  });
});
