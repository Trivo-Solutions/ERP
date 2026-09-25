import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { provisionCompany } from '../modules/platform/provisioning.service';
import { apiWith, purgeCompany, uniqueCompanyCode } from './fixtures';

// Purchase lots (bags) driven over REAL HTTP, the way the browser drives them: JSON numbers and dates, ids as
// strings, real permission checks. The service tests pass typed values straight in and never touch a router.
//
//   supplier -> PO (one FINISHED_LOT bag line with category rows) -> GRN (opens the lot) -> tag pieces with
//   purchaseLotId -> close -> another company cannot see, tag from, or close it

const DOMAIN = '@httppurchaselots.example.com';
const PASSWORD = 'PurchaseLots-Passw0rd-123';

describe('HTTP: purchase lots (bags)', () => {
  const created: string[] = [];
  const A: Record<string, any> = {}; const B: Record<string, any> = {};
  let a: ReturnType<typeof apiWith>; let b: ReturnType<typeof apiWith>;

  async function bringUp(into: Record<string, any>, tag: string) {
    const code = uniqueCompanyCode(tag);
    const email = `${code.toLowerCase()}${DOMAIN}`;
    const r = await provisionCompany({ code, name: `Lots ${tag}`, admin: { email, name: 'Owner Person', password: PASSWORD } });
    created.push(r.company.id);
    const login = await request(app).post('/api/v1/auth/login').send({ companyCode: code, identifier: email, password: PASSWORD });
    expect(login.status).toBe(200);
    into.token = login.body.data.accessToken; into.companyId = r.company.id; into.branchId = r.branch.id;
    const api = apiWith(into.token, app);
    const cats = (await api.get('/masters/categories')).body.data;
    expect(cats.length).toBeGreaterThanOrEqual(2);
    into.category = cats[0].id; into.category2 = cats[1].id;
    into.stockType = (await api.get('/masters/stock-types')).body.data[0].id;
    return api;
  }

  const tagBody = (o: Record<string, any>, extra: Record<string, unknown> = {}) => ({
    branchId: o.branchId, name: 'Lot piece', metalType: 'GOLD', metalKarat: '22K', grossWeight: 20, netWeight: 18,
    stockTypeId: o.stockType, categoryId: o.category, ...extra,
  });

  beforeAll(async () => { a = await bringUp(A, 'PLA'); b = await bringUp(B, 'PLB'); }, 120_000);
  afterAll(async () => {
    const members = await prisma.companyUser.findMany({ where: { user: { email: { endsWith: DOMAIN } } }, select: { companyId: true } });
    for (const id of new Set([...created, ...members.map((m) => m.companyId)])) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.$disconnect();
  });

  // ₹60,000 bag: 2 categories — 40 g of rings (net 36, 2 pieces) and 20 g of a second category (stone 2, no count).
  const bagLine = (o: Record<string, any>, extra: Record<string, unknown> = {}) => ({
    materialCode: 'BAG', materialName: '22K Bag', materialType: 'FINISHED_LOT', quantity: 1, weight: 60, unit: 'BAG', ratePerUnit: 0, lotAmount: 60000,
    categories: [
      { categoryId: o.category, karat: '22K', grossWeight: 40, netWeight: 36, pieces: 2 },
      { categoryId: o.category2, karat: '22K', grossWeight: 20, stoneWeight: 2 },
    ], ...extra,
  });

  it('PO bag line -> GRN opens the lot -> pieces tagged over HTTP carry their share of the bag cost', async () => {
    const sup = await a.post('/procurement/suppliers', { name: 'Bag Supplier', type: 'OTHER', gstNumber: '27AAAAA0000A1Z5', state: 'Maharashtra' });
    expect(sup.status).toBe(201);
    A.supplierId = sup.body.data.id;

    const po = await a.post('/procurement/orders', {
      supplierId: A.supplierId, poType: 'OUTRIGHT', orderDate: '2026-09-01T00:00:00.000Z', items: [bagLine(A)],
    });
    expect(po.status).toBe(201);
    const line = po.body.data.poItems[0];
    expect(Number(line.totalAmount)).toBe(60000);
    expect(Number(line.netWeight)).toBe(54);                       // 36 + 18, worked out from the rows
    expect(line.categories).toHaveLength(2);
    A.poItemId = line.id;

    // an incomplete bag line is a 400, not a 500
    const noRows = await a.post('/procurement/orders', {
      supplierId: A.supplierId, poType: 'OUTRIGHT', orderDate: '2026-09-01', items: [bagLine(A, { categories: [] })],
    });
    expect(noRows.status).toBe(400);
    const wrongSum = await a.post('/procurement/orders', {
      supplierId: A.supplierId, poType: 'OUTRIGHT', orderDate: '2026-09-01', items: [bagLine(A, { weight: 90 })],
    });
    expect(wrongSum.status).toBe(400);
    // a category id that isn't a string must not be read as a Prisma filter
    const forged = await a.post('/procurement/orders', {
      supplierId: A.supplierId, poType: 'OUTRIGHT', orderDate: '2026-09-01',
      items: [bagLine(A, { categories: [{ categoryId: { not: '' }, karat: '22K', grossWeight: 60, netWeight: 54 }] })],
    });
    expect(forged.status).toBe(400);

    const grn = await a.post('/procurement/grn', {
      poId: po.body.data.id, branchId: A.branchId, receivedDate: '2026-09-02T00:00:00.000Z', invoiceNumber: 'BAG/26/1', invoiceDate: '2026-09-02',
      items: [{ poItemId: A.poItemId, invoiceQty: 1, invoiceWeight: 60, scaleWeight: 60 }],
    });
    expect(grn.status).toBe(201);

    // the GRN list says which lot each bag line opened
    const list = await a.get('/procurement/grn');
    const grnLine = list.body.data.flatMap((g: any) => g.grnItems).find((i: any) => i.poItemId === A.poItemId);
    expect(grnLine.purchaseLot.status).toBe('OPEN');
    A.lotId = grnLine.purchaseLot.id;

    const lots = await a.get('/tagging/lots?status=OPEN');
    expect(lots.status).toBe(200);
    const lot = lots.body.data.find((l: any) => l.id === A.lotId);
    expect(lot.remainingNet).toBe(54);
    expect(lot.remainingCost).toBe(60000);
    expect(lot.supplier.name).toBe('Bag Supplier');
    expect(lot.categories.map((c: any) => c.categoryId).sort()).toEqual([A.category, A.category2].sort());

    // two rings (the row states 2 pieces). The first is priced from the rates the tag screen pre-filled (₹21,000);
    // the second enters nothing, so it takes its share of what is left of the bag by net weight: 39000 x 18/36
    const t1 = await a.post('/tagging/tags', tagBody(A, { purchaseLotId: A.lotId, costPrice: 21000 }));
    expect(t1.status).toBe(201);
    expect(Number(t1.body.data.costPrice)).toBe(21000);
    const t2 = await a.post('/tagging/tags', tagBody(A, { purchaseLotId: A.lotId }));
    expect(Number(t2.body.data.costPrice)).toBe(19500);
    // a third ring is refused (the invoice said 2), and so is a category the bag doesn't hold
    expect((await a.post('/tagging/tags', tagBody(A, { purchaseLotId: A.lotId }))).status).toBe(409);
    expect((await a.post('/tagging/tags', tagBody(A, { purchaseLotId: A.lotId, categoryId: B.category }))).status).toBe(404);
    // the second category completes the bag's net weight, so it takes the remainder and closes the lot
    const t3 = await a.post('/tagging/tags', tagBody(A, { purchaseLotId: A.lotId, categoryId: A.category2 }));
    expect(t3.status).toBe(201);
    expect(Number(t3.body.data.costPrice)).toBe(19500);        // the last piece: whatever is left

    const one = await a.get(`/tagging/lots/${A.lotId}`);
    expect(one.body.data.taggedPieces).toBe(3);
    expect(one.body.data.status).toBe('CLOSED');
    expect(one.body.data.closeNote).toBe('All pieces tagged');
    expect(one.body.data.costVariance).toBe(0);
    expect(one.body.data.tags).toHaveLength(3);
    A.tagId = t1.body.data.id;
  });

  it('a forged or malformed lot id is refused, never a 500', async () => {
    // an object where an id belongs must not be read as a Prisma filter
    expect((await a.post('/tagging/tags', tagBody(A, { purchaseLotId: { not: '' } }))).status).toBe(400);
    expect((await a.post('/tagging/tags', tagBody(A, { purchaseLotId: 'no-such-lot' }))).status).toBe(404);
  });

  it("another company cannot see, tag from, or close this company's lot", async () => {
    expect((await b.get(`/tagging/lots/${A.lotId}`)).status).toBe(404);
    expect((await b.get('/tagging/lots')).body.data.find((l: any) => l.id === A.lotId)).toBeUndefined();
    expect((await b.post('/tagging/tags', tagBody(B, { purchaseLotId: A.lotId }))).status).toBe(404);
    expect((await b.post(`/tagging/lots/${A.lotId}/close`, {})).status).toBe(404);
    // ...and the lot is untouched
    const still = await a.get(`/tagging/lots/${A.lotId}`);
    expect(still.body.data.taggedPieces).toBe(3);
    expect(still.body.data.closeNote).toBe('All pieces tagged');
  });

  it('an unfinished bag is closed by hand over HTTP — once only — and then leaves the open list', async () => {
    const po = await a.post('/procurement/orders', {
      supplierId: A.supplierId, poType: 'OUTRIGHT', orderDate: '2026-09-03T00:00:00.000Z',
      items: [bagLine(A, { materialName: '22K Chains', weight: 50, lotAmount: 90000, categories: [{ categoryId: A.category, karat: '22K', grossWeight: 50, netWeight: 45, pieces: 5 }] })],
    });
    expect(po.status).toBe(201);
    const grn = await a.post('/procurement/grn', {
      poId: po.body.data.id, branchId: A.branchId, receivedDate: '2026-09-04T00:00:00.000Z',
      items: [{ poItemId: po.body.data.poItems[0].id, invoiceQty: 1, invoiceWeight: 50, scaleWeight: 50 }],
    });
    expect(grn.status).toBe(201);
    const lot = await prisma.purchaseLot.findFirstOrThrow({ where: { companyId: A.companyId, label: '22K Chains' } });
    expect((await a.post('/tagging/tags', tagBody(A, { purchaseLotId: lot.id, grossWeight: 10, netWeight: 9 }))).status).toBe(201);

    const closed = await a.post(`/tagging/lots/${lot.id}/close`, { note: 'Four chains short' });
    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe('CLOSED');
    expect(closed.body.data.closeNote).toBe('Four chains short');
    expect(closed.body.data.remainingPieces).toBe(4);       // reported, never written off
    expect((await a.post(`/tagging/lots/${lot.id}/close`, {})).status).toBe(409);
    expect((await a.post('/tagging/tags', tagBody(A, { purchaseLotId: lot.id }))).status).toBe(409);
    expect((await a.get('/tagging/lots?status=OPEN')).body.data.some((l: any) => l.id === lot.id)).toBe(false);
  });

  it('a bag piece goes back to the supplier through the normal purchase return, GST included', async () => {
    const returnable = await a.get(`/procurement/suppliers/${A.supplierId}/returnable-tags`);
    expect(returnable.body.data.some((t: any) => t.id === A.tagId)).toBe(true);
    const ret = await a.post('/procurement/returns', { items: [{ tagId: A.tagId }], reason: 'Defective' });
    expect(ret.status).toBe(201);
    expect(Number(ret.body.data.totalAmount)).toBe(21000);
    expect(Number(ret.body.data.taxAmount)).toBeCloseTo(630);                // 3% of 21,000
  });
});
