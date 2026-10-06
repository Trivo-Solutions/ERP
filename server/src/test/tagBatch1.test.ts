import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, tokenFor, apiWith, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';
import { createTag, updateTag, getTagPrintTspl } from '../modules/tagging/tagging.service';
import { resolveMetalRate } from '../shared/metalRate';

// Tagging & Inward batch 1: Size master, No. of Pcs on a tag, the one-date-every-purity rate sheet,
// and SOLD / RETIRED (purchase-returned) tag protection — through the real routes where it matters.
describe('Tagging batch 1', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const PERMS = ['masters:view', 'masters:create', 'masters:edit', 'masters:delete', 'tag:create', 'tag:view', 'system:config', 'design:view'];
  let A: TestTenant, B: TestTenant;
  let api: ReturnType<typeof apiWith>;
  let stockTypeId: string, ringCatId: string, chainCatId: string;
  const tagIds: string[] = [];

  const base = () => ({
    branchId: A.branch.id, name: 'T', metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5,
    stockTypeId, categoryId: ringCatId,
  });
  const mk = async (extra: object = {}) => {
    const t = await createTag(A.ctx, { ...base(), ...extra } as any, A.user.id);
    tagIds.push(t.id);
    return t;
  };

  beforeAll(async () => {
    A = await createTestTenant(`TB1A${suffix}`, PERMS);
    B = await createTestTenant(`TB1B${suffix}`, PERMS);
    api = apiWith(tokenFor(A), app);
    stockTypeId = (await prisma.stockType.create({ data: { companyId: A.company.id, code: 'R', name: 'Ready' } })).id;
    ringCatId = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'RNG', name: 'Ring' } })).id;
    chainCatId = (await prisma.productCategory.create({ data: { companyId: A.company.id, code: 'CHN', name: 'Chain' } })).id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(tagIds);
    await prisma.jewelryTagMaterial.deleteMany({ where: { tagId: { in: tagIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
  });

  describe('Size master', () => {
    it('create / edit / deactivate / list / delete over HTTP', async () => {
      const c = await api.post('/masters/sizes', { code: 'r12', name: '12', categoryId: ringCatId });
      expect(c.status).toBe(201);
      expect(c.body.data.code).toBe('R12');
      const id = c.body.data.id;

      const e = await api.patch(`/masters/sizes/${id}`, { name: '12.0' });
      expect(e.status).toBe(200);
      expect(e.body.data.name).toBe('12.0');

      const all = await api.post('/masters/sizes', { code: 'FREE', name: 'Free size', categoryId: '' });
      expect(all.body.data.categoryId).toBeNull();

      // category filter: the ring's own + category-less
      const forRing = await api.get(`/masters/sizes?categoryId=${ringCatId}`);
      expect(forRing.body.data.map((s: any) => s.code).sort()).toEqual(['FREE', 'R12']);
      const forChain = await api.get(`/masters/sizes?categoryId=${chainCatId}`);
      expect(forChain.body.data.map((s: any) => s.code)).toEqual(['FREE']);

      const off = await api.patch(`/masters/sizes/${id}`, { isActive: false });
      expect(off.body.data.isActive).toBe(false);
      const active = await api.get(`/masters/sizes?active=true&categoryId=${ringCatId}`);
      expect(active.body.data.map((s: any) => s.code)).toEqual(['FREE']);

      expect((await api.del(`/masters/sizes/${id}`)).status).toBe(200);
      expect((await api.del(`/masters/sizes/${all.body.data.id}`)).status).toBe(200);
    });

    it('an in-use size cannot be deleted (409)', async () => {
      const s = await prisma.size.create({ data: { companyId: A.company.id, code: 'USED', name: 'Used' } });
      await mk({ sizeId: s.id });
      expect((await api.del(`/masters/sizes/${s.id}`)).status).toBe(409);
    });

    it('403 without the permission, and another company cannot see/touch it', async () => {
      const s = await prisma.size.create({ data: { companyId: A.company.id, code: 'ISO', name: 'Iso' } });
      const noPerm = await createTestTenant(`TB1N${suffix}`, ['masters:view']);
      try {
        const lim = apiWith(tokenFor(noPerm), app);
        expect((await lim.post('/masters/sizes', { code: 'X', name: 'x' })).status).toBe(403);
        expect((await lim.patch(`/masters/sizes/${s.id}`, { name: 'y' })).status).toBe(403);
      } finally { await cleanupTestTenant(noPerm); }

      const other = apiWith(tokenFor(B), app);
      expect((await other.patch(`/masters/sizes/${s.id}`, { name: 'hack' })).status).toBe(404);
      expect((await other.del(`/masters/sizes/${s.id}`)).status).toBe(404);
      expect((await other.get('/masters/sizes')).body.data.find((x: any) => x.id === s.id)).toBeUndefined();
      // a category from another company can't be attached
      const bad = await other.post('/masters/sizes', { code: 'Z', name: 'z', categoryId: ringCatId });
      expect(bad.status).toBe(404);
    });
  });

  describe('New Tag: Size and No. of Pcs', () => {
    it('persists size + noOfPcs; both optional (existing behaviour unchanged)', async () => {
      const s = await prisma.size.create({ data: { companyId: A.company.id, code: 'S1', name: 'Size 1', categoryId: ringCatId } });
      const withBoth = await mk({ sizeId: s.id, noOfPcs: 2 });
      const row = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: withBoth.id } });
      expect(row.sizeId).toBe(s.id);
      expect(row.noOfPcs).toBe(2);

      const without = await mk();
      const row2 = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: without.id } });
      expect(row2.sizeId).toBeNull();
      expect(row2.noOfPcs).toBeNull();
    });

    it('rejects a size for the wrong category, an inactive size, a foreign size and a bad piece count', async () => {
      const ringOnly = await prisma.size.create({ data: { companyId: A.company.id, code: 'RO', name: 'Ring only', categoryId: ringCatId } });
      await expect(mk({ sizeId: ringOnly.id, categoryId: chainCatId })).rejects.toMatchObject({ statusCode: 400 });

      const off = await prisma.size.create({ data: { companyId: A.company.id, code: 'OFF', name: 'Off', isActive: false } });
      await expect(mk({ sizeId: off.id })).rejects.toMatchObject({ statusCode: 400 });

      const foreign = await prisma.size.create({ data: { companyId: B.company.id, code: 'FOR', name: 'Foreign' } });
      await expect(mk({ sizeId: foreign.id })).rejects.toMatchObject({ statusCode: 404 });
      await prisma.size.delete({ where: { id: foreign.id } });

      await expect(mk({ noOfPcs: 0 })).rejects.toMatchObject({ statusCode: 400 });
      await expect(mk({ noOfPcs: 1.5 })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('update can change and clear size / noOfPcs', async () => {
      const s = await prisma.size.create({ data: { companyId: A.company.id, code: 'UP', name: 'Up' } });
      const t = await mk();
      const u1 = await updateTag(t.id, { sizeId: s.id, noOfPcs: 4 }, A.ctx, A.user.id);
      expect(u1.sizeId).toBe(s.id);
      expect(u1.noOfPcs).toBe(4);
      const u2 = await updateTag(t.id, { sizeId: null, noOfPcs: null }, A.ctx, A.user.id);
      expect(u2.sizeId).toBeNull();
      expect(u2.noOfPcs).toBeNull();
    });
  });

  describe('Tag lifecycle protection', () => {
    for (const status of ['SOLD', 'RETIRED']) {
      it(`${status} tag cannot be edited or reprinted — service and direct API`, async () => {
        const t = await mk();
        await prisma.jewelryTag.update({ where: { id: t.id }, data: { status } });

        await expect(updateTag(t.id, { notes: 'x' }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 409 });
        await expect(getTagPrintTspl(A.ctx, t.id)).rejects.toMatchObject({ statusCode: 409 });
        expect((await api.patch(`/tagging/tags/${t.id}`, { notes: 'x' })).status).toBe(409);
        expect((await api.get(`/tagging/tags/${t.id}/print`)).status).toBe(409);
        expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: t.id } })).notes).toBeNull();
      });
    }

    it('IN_STOCK / ON_APPROVAL tags still edit and pass the print lock', async () => {
      for (const status of ['IN_STOCK', 'ON_APPROVAL']) {
        const t = await mk();
        await prisma.jewelryTag.update({ where: { id: t.id }, data: { status } });
        const r = await api.patch(`/tagging/tags/${t.id}`, { notes: 'ok' });
        expect(r.status).toBe(200);
        // no default template in this tenant → 404 from the template lookup, i.e. past the lock (not 409)
        expect((await api.get(`/tagging/tags/${t.id}/print`)).status).not.toBe(409);
      }
    });
  });

  describe('Gold rate sheet (one date, every purity)', () => {
    const d1 = '2026-10-03', d2 = '2026-10-04';

    it('lists every active purity for a date, saves a batch, keeps dates separate', async () => {
      const empty = await api.get(`/designs/rates/sheet?date=${d1}`);
      expect(empty.status).toBe(200);
      const codes = empty.body.data.map((r: any) => r.karat);
      expect(codes).toEqual(expect.arrayContaining(['24K', '22K', '18K']));
      expect(empty.body.data.every((r: any) => r.ratePerGram === null)).toBe(true);

      const save = await api.post('/designs/rates/batch', { date: d1, rates: [{ karat: '24K', ratePerGram: 15028 }] });
      expect(save.status).toBe(200);

      const sheet = await api.get(`/designs/rates/sheet?date=${d1}`);
      const by = Object.fromEntries(sheet.body.data.map((r: any) => [r.karat, r.ratePerGram]));
      expect(Number(by['24K'])).toBe(15028);
      expect(Number(by['22K'])).toBe(13765.65); // 15028 x 0.9160, derived on the server
      expect(Number(by['18K'])).toBe(11271);   // 15028 x 0.7500

      // next day: nothing saved yet, but the earlier rate is offered as a hint
      const next = await api.get(`/designs/rates/sheet?date=${d2}`);
      const n22 = next.body.data.find((r: any) => r.karat === '22K');
      expect(n22.ratePerGram).toBeNull();
      expect(Number(n22.previousRate)).toBe(13765.65);

      // editing d2 leaves d1 alone; re-saving d1 edits it in place (no duplicate row)
      await api.post('/designs/rates/batch', { date: d2, rates: [{ karat: '24K', ratePerGram: 15283.5 }] });
      await api.post('/designs/rates/batch', { date: d1, rates: [{ karat: '24K', ratePerGram: 15066 }] });
      const rows = await prisma.metalRate.findMany({ where: { companyId: A.company.id, karat: '22K' }, orderBy: { date: 'asc' } });
      expect(rows.map((r) => Number(r.ratePerGram))).toEqual([13800.46, 13999.69]);
    });

    it('existing consumers still get the right rate (resolveMetalRate, /rates/latest, single POST /rates)', async () => {
      const r = await resolveMetalRate(A.company.id, '22K', new Date(`${d1}T00:00:00Z`));
      expect(Number(r?.ratePerGram)).toBe(13800.46);
      expect((await api.get('/designs/rates/latest')).status).toBe(200);
      const single = await api.post('/designs/rates', { date: '2026-10-05T00:00:00.000Z', karat: '24K', ratePerGram: 11414 });
      expect(single.status).toBe(200);
      expect((await api.post('/designs/rates', { date: '2026-10-05T00:00:00.000Z', karat: '18K', ratePerGram: 1 })).status).toBe(400);
      const after = await api.get('/designs/rates/sheet?date=2026-10-05');
      expect(Number(after.body.data.find((x: any) => x.karat === '24K').ratePerGram)).toBe(11414);
    });

    it('gold: only 24K Gold / 24K Old Gold are entered; other karats derive from KaratMaster purity, independently per family', async () => {
      const d = '2026-11-01';
      const by = async () => Object.fromEntries((await api.get(`/designs/rates/sheet?date=${d}`)).body.data.map((r: any) => [r.karat, r]));
      expect((await api.post('/designs/rates/batch', { date: d, rates: [{ karat: '24K', ratePerGram: 15000, ogRatePerGram: 14000 }] })).status).toBe(200);
      let rows = await by();
      expect(Number(rows['24K'].ratePerGram)).toBe(15000);       // base is stored as typed, not x0.9999
      expect(Number(rows['24K'].ogRatePerGram)).toBe(14000);
      expect(Number(rows['22K'].ratePerGram)).toBe(13740);       // 91.60%, not 22/24
      expect(Number(rows['22K'].ogRatePerGram)).toBe(12824);
      expect(Number(rows['18K'].ratePerGram)).toBe(11250);
      expect(Number(rows['18K'].ogRatePerGram)).toBe(10500);
      expect(Number(rows['14K'].ratePerGram)).toBe(8775);
      expect(Number(rows['14K'].ogRatePerGram)).toBe(8190);
      expect(Number(rows['10K'].ratePerGram)).toBe(6255);        // 41.70%
      expect(rows['22K'].isDerived).toBe(true);
      expect(rows['24K'].isDerived).toBe(false);

      // changing only the normal 24K leaves the old-gold family alone (OG not sent -> untouched)
      await api.post('/designs/rates/batch', { date: d, rates: [{ karat: '24K', ratePerGram: 16000 }] });
      rows = await by();
      expect(Number(rows['22K'].ratePerGram)).toBe(14656);
      expect(Number(rows['24K'].ogRatePerGram)).toBe(14000);
      expect(Number(rows['22K'].ogRatePerGram)).toBe(12824);

      // changing only OG leaves normal rates alone
      await api.post('/designs/rates/batch', { date: d, rates: [{ karat: '24K', ratePerGram: 16000, ogRatePerGram: 13000 }] });
      rows = await by();
      expect(Number(rows['22K'].ratePerGram)).toBe(14656);
      expect(Number(rows['22K'].ogRatePerGram)).toBe(11908);
      expect(Number(rows['18K'].ogRatePerGram)).toBe(9750);

      // clearing the base OG clears every derived OG
      await api.post('/designs/rates/batch', { date: d, rates: [{ karat: '24K', ratePerGram: 16000, ogRatePerGram: null }] });
      rows = await by();
      expect(rows['22K'].ogRatePerGram).toBeNull();
      expect(Number(rows['22K'].ratePerGram)).toBe(14656);

      // a derived karat cannot be set directly (batch or single endpoint) and nothing is persisted
      expect((await api.post('/designs/rates/batch', { date: d, rates: [{ karat: '24K', ratePerGram: 1 }, { karat: '22K', ratePerGram: 5 }] })).status).toBe(400);
      expect(Number((await by())['24K'].ratePerGram)).toBe(16000);
    });

    it('rounds half-up to 2 decimals and skips inactive karats', async () => {
      const d = '2026-11-02';
      const k14 = await prisma.karatMaster.findFirstOrThrow({ where: { companyId: A.company.id, code: '14K' } });
      await prisma.karatMaster.update({ where: { id: k14.id }, data: { isActive: false } });
      try {
        // 15001.01 x 0.9160 = 13740.92516 -> 13740.93 ; 15001.01 x 0.7500 = 11250.7575 -> 11250.76
        expect((await api.post('/designs/rates/batch', { date: d, rates: [{ karat: '24K', ratePerGram: 15001.01 }] })).status).toBe(200);
        const rows = Object.fromEntries((await api.get(`/designs/rates/sheet?date=${d}`)).body.data.map((r: any) => [r.karat, r]));
        expect(Number(rows['22K'].ratePerGram)).toBe(13740.93);
        expect(Number(rows['18K'].ratePerGram)).toBe(11250.76);
        expect(rows['14K']).toBeUndefined();
        expect(await prisma.metalRate.count({ where: { companyId: A.company.id, date: new Date(`${d}T00:00:00Z`), karat: '14K' } })).toBe(0);
      } finally { await prisma.karatMaster.update({ where: { id: k14.id }, data: { isActive: true } }); }
    });

    it('silver / platinum stay manually entered (no 24K base concept)', async () => {
      const d = '2026-11-03';
      expect((await api.post('/designs/rates/batch', { date: d, rates: [{ karat: 'SILVER', ratePerGram: 90, ogRatePerGram: 80 }] })).status).toBe(200);
      const rows = Object.fromEntries((await api.get(`/designs/rates/sheet?date=${d}`)).body.data.map((r: any) => [r.karat, r]));
      expect(Number(rows['SILVER'].ratePerGram)).toBe(90);
      expect(rows['SILVER'].isDerived).toBe(false);
      expect(rows['925'].ratePerGram).toBeNull();
    });

    it('validates input and is gated by permission; a batch is all-or-nothing', async () => {
      expect((await api.post('/designs/rates/batch', { date: d1, rates: [] })).status).toBe(400);
      expect((await api.post('/designs/rates/batch', { date: d1, rates: [{ karat: '24K', ratePerGram: -1 }] })).status).toBe(400);
      expect((await api.post('/designs/rates/batch', { date: 'nope', rates: [{ karat: '22K', ratePerGram: 1 }] })).status).toBe(400);
      const before = await prisma.metalRate.count({ where: { companyId: A.company.id } });
      const bad = await api.post('/designs/rates/batch', { date: '2026-10-09', rates: [{ karat: '24K', ratePerGram: 100 }, { karat: 'NOPE', ratePerGram: 5 }] });
      expect(bad.status).toBe(400);
      expect(await prisma.metalRate.count({ where: { companyId: A.company.id } })).toBe(before);

      const viewer = await createTestTenant(`TB1V${suffix}`, ['design:view']);
      try {
        expect((await apiWith(tokenFor(viewer), app).post('/designs/rates/batch', { date: d1, rates: [{ karat: '22K', ratePerGram: 1 }] })).status).toBe(403);
      } finally { await cleanupTestTenant(viewer); }
    });

    it("another company's rates are never shown or touched", async () => {
      const other = await apiWith(tokenFor(B), app).get(`/designs/rates/sheet?date=${d1}`);
      expect(other.body.data.every((r: any) => r.ratePerGram === null)).toBe(true);
    });
  });
});
