import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { provisionCompany } from '../modules/platform/provisioning.service';
import { apiWith, purgeCompany, uniqueCompanyCode } from './fixtures';

// HTTP-contract regressions found by running the real staging stack (not by service-level tests, which pass Date
// objects and well-formed ids straight in):
//   1. JSON dates. `payments[].paymentDate` arrives as an ISO STRING; it was never turned back into a Date, so
//      bill-and-collect (POST /sales/invoices with payments) crashed with a 500 in getFullYear().
//   2. A missing / non-string foreign id reached Prisma as-is: a 500 for `undefined`, and a JSON object such as
//      {"not":""} would have been read as a FILTER instead of an id.
//   3. tag.manufacturerId was never ownership-checked in the app (the composite FK stopped it, but as a 500).

const DOMAIN = '@httpcontract.example.com';
const PASSWORD = 'Contract-Passw0rd-123';

describe('HTTP contract: dates, malformed ids and foreign references', () => {
  const created: string[] = [];
  const A: Record<string, any> = {}; const B: Record<string, any> = {};
  let a: ReturnType<typeof apiWith>; let b: ReturnType<typeof apiWith>;

  async function bringUp(into: Record<string, any>, tag: string) {
    const code = uniqueCompanyCode(tag);
    const email = `${code.toLowerCase()}${DOMAIN}`;
    const r = await provisionCompany({ code, name: `Contract ${tag}`, admin: { email, name: 'Owner Person', password: PASSWORD } });
    created.push(r.company.id);
    const login = await request(app).post('/api/v1/auth/login').send({ companyCode: code, identifier: email, password: PASSWORD });
    expect(login.status).toBe(200);
    into.token = login.body.data.accessToken; into.companyId = r.company.id; into.branchId = r.branch.id;
    const api = apiWith(into.token, app);
    into.category = (await api.get('/masters/categories')).body.data[0].id;
    into.stockType = (await api.get('/masters/stock-types')).body.data[0].id;
    into.client = (await api.post('/orders/clients', { name: `Client ${tag}`, type: 'RETAIL' })).body.data.id;
    return api;
  }

  const tagBody = (o: Record<string, any>, over: Record<string, unknown> = {}) => ({
    branchId: o.branchId, name: 'Contract tag', metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5,
    costPrice: 100, sellingPrice: 200, stockTypeId: o.stockType, categoryId: o.category, ...over,
  });
  const newTag = async (api: ReturnType<typeof apiWith>, o: Record<string, any>) => (await api.post('/tagging/tags', tagBody(o))).body.data;
  const invoiceBody = (o: Record<string, any>, tag: any, over: Record<string, unknown> = {}) => ({
    clientId: o.client, branchId: o.branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
    items: [{ productCode: tag.tagNumber, description: 'x', quantity: 1, grossWeight: 5, netGoldWeight: 5, rateType: 'FIXED', goldRate: 200, makingCharge: 0, tagId: tag.id }],
    ...over,
  });

  beforeAll(async () => { a = await bringUp(A, 'HCA'); b = await bringUp(B, 'HCB'); }, 120_000);
  afterAll(async () => {
    const members = await prisma.companyUser.findMany({ where: { user: { email: { endsWith: DOMAIN } } }, select: { companyId: true } });
    for (const id of new Set([...created, ...members.map((m) => m.companyId)])) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.$disconnect();
  });

  describe('JSON dates', () => {
    it('bill-and-collect: a payment split whose paymentDate is an ISO string is accepted and recorded', async () => {
      const tag = await newTag(a, A);
      const r = await a.post('/sales/invoices', invoiceBody(A, tag, { payments: [{ mode: 'CASH', amount: 50, paymentDate: '2026-03-15T00:00:00.000Z' }] }));
      expect(r.status).toBe(201);
      const pays = await prisma.invoicePayment.findMany({ where: { invoiceId: r.body.data.id } });
      expect(pays).toHaveLength(1);
      expect(pays[0].paymentDate.toISOString()).toBe('2026-03-15T00:00:00.000Z');
      expect(pays[0].paymentNumber).toMatch(/^PMT-2026-/); // numbered from the payment's own year
    });

    it('a payment split with NO paymentDate defaults to now instead of crashing', async () => {
      const tag = await newTag(a, A);
      const r = await a.post('/sales/invoices', invoiceBody(A, tag, { payments: [{ mode: 'UPI', amount: 10 }] }));
      expect(r.status).toBe(201);
    });

    it('a garbage date is a 400, not a 500 and not an "Invalid Date" document number', async () => {
      const tag = await newTag(a, A);
      expect((await a.post('/sales/invoices', invoiceBody(A, tag, { invoiceDate: 'not-a-date' }))).status).toBe(400);
      expect((await a.post('/sales/invoices', invoiceBody(A, tag, { payments: [{ mode: 'CASH', amount: 1, paymentDate: 'garbage' }] }))).status).toBe(400);
      expect((await a.post('/sales/invoices', invoiceBody(A, tag, { invoiceDate: undefined }))).status).toBe(400);
      // and the tag was NOT consumed by any of those refused sales
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');
    });

    it('the standalone payment endpoints coerce the same way', async () => {
      const tag = await newTag(a, A);
      const inv = await a.post('/sales/invoices', invoiceBody(A, tag));
      expect(inv.status).toBe(201);
      expect((await a.post(`/sales/invoices/${inv.body.data.id}/payment`, { amount: 5, mode: 'CASH', paymentDate: '2026-04-01' })).status).toBe(200);
      expect((await a.post(`/sales/clients/${A.client}/payments`, { amount: 5, mode: 'CASH', paymentDate: '2026-04-02' })).status).toBe(201);
      expect((await a.post(`/sales/clients/${A.client}/payments`, { amount: 5, mode: 'CASH', paymentDate: 'nope' })).status).toBe(400);
    });
  });

  describe('invoice list date range (GET /sales/invoices?from&to)', () => {
    it('filters by invoice date, both ends inclusive, and rejects a garbage date with a 400', async () => {
      const jan = (await a.post('/sales/invoices', invoiceBody(A, await newTag(a, A), { invoiceDate: '2026-01-10T00:00:00.000Z' }))).body.data;
      const feb = (await a.post('/sales/invoices', invoiceBody(A, await newTag(a, A), { invoiceDate: '2026-02-20T00:00:00.000Z' }))).body.data;
      const ids = async (qs: string) => ((await a.get(`/sales/invoices${qs}`)).body.data as any[]).map((i) => i.id);

      expect(await ids('?from=2026-01-01&to=2026-01-31')).toEqual([jan.id]);
      expect(await ids('?from=2026-02-01&to=2026-02-28')).toEqual([feb.id]);
      expect(await ids('?from=2026-01-10&to=2026-01-10')).toEqual([jan.id]); // a single day is inclusive
      expect(new Set(await ids('?from=2026-01-01&to=2026-02-28'))).toEqual(new Set([jan.id, feb.id]));
      expect(await ids('?from=2026-03-01')).not.toContain(jan.id); // open-ended
      expect(await ids('?to=2026-01-31')).toContain(jan.id);
      expect((await a.get('/sales/invoices?from=garbage')).status).toBe(400);
      // another company never sees them, range or not
      expect(((await b.get('/sales/invoices?from=2026-01-01&to=2026-12-31')).body.data as any[]).map((i) => i.id)).not.toContain(jan.id);
    });
  });

  describe('invoice list optional columns (GET /sales/invoices)', () => {
    it('carries piece/weight totals, branch, GST split and payment modes without shipping the lines', async () => {
      const tag = await newTag(a, A);
      const two = { productCode: 'X2', description: 'two pcs', quantity: 2, grossWeight: 3, netGoldWeight: 2.5, stoneWeight: 0.5, rateType: 'FIXED', goldRate: 100, makingCharge: 0 };
      const inv = (await a.post('/sales/invoices', invoiceBody(A, tag, {
        items: [invoiceBody(A, tag).items[0], two], payments: [{ mode: 'UPI', amount: 10 }, { mode: 'CASH', amount: 5 }],
      }))).body.data;

      const row = ((await a.get('/sales/invoices')).body.data as any[]).find((i) => i.id === inv.id);
      expect(row.totals).toEqual({ quantity: 3, grossWeight: 5 + 3 * 2, netWeight: 5 + 2.5 * 2, stoneWeight: 0.5 * 2 });
      expect(row.items).toBeUndefined();
      expect(row.payments).toBeUndefined();
      expect([...row.paymentModes].sort()).toEqual(['CASH', 'UPI']);
      expect(row.branch.name).toBeTruthy();
      expect(row.taxDetails.totalTax).toBeDefined();
      expect(row.salesPerson).toBeNull();
      expect(row._count.items).toBe(2);
    });
  });

  describe('amend an issued invoice (PUT /sales/invoices/:id)', () => {
    it('the company admin can reprice a line over HTTP; a garbage date is a 400; another company gets a 404', async () => {
      const tag = await newTag(a, A);
      const inv = (await a.post('/sales/invoices', invoiceBody(A, tag))).body.data; // FIXED line at 200
      const line = inv.items[0];
      const lineBody = { id: line.id, productCode: line.productCode, description: 'x', quantity: 1, grossWeight: 5, netGoldWeight: 5, rateType: 'FIXED', goldRate: 300, makingCharge: 0, tagId: tag.id };

      const ok = await a.put(`/sales/invoices/${inv.id}`, { items: [lineBody], dueDate: '2026-12-31', notes: 'fixed price', reason: 'price change' });
      expect(ok.status).toBe(200);
      expect(Number(ok.body.data.subtotal)).toBe(300);
      expect(ok.body.data.notes).toBe('fixed price');
      expect(ok.body.data.dueDate).toContain('2026-12-31');

      expect((await a.put(`/sales/invoices/${inv.id}`, { items: [lineBody], invoiceDate: 'garbage' })).status).toBe(400);
      expect((await b.put(`/sales/invoices/${inv.id}`, { items: [lineBody] })).status).toBe(404);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('SOLD');
    });
  });

  describe('malformed ids are a 4xx, never a 500 and never a Prisma filter', () => {
    it('a missing branchId is a 400', async () => {
      const tag = await newTag(a, A);
      expect((await a.post('/sales/invoices', invoiceBody(A, tag, { branchId: undefined }))).status).toBe(400);
    });

    it('an OBJECT where an id belongs ({"not":""}) is rejected, not interpreted as a filter', async () => {
      expect((await a.post('/tagging/tags', tagBody(A, { categoryId: { not: '' } }))).status).toBe(400);
      expect((await a.post('/tagging/tags', tagBody(A, { branchId: { contains: '' } }))).status).toBe(400);
      expect((await a.post('/tagging/tags', tagBody(A, { stockTypeId: ['x'] }))).status).toBe(400);
    });
  });

  describe('operator-injection guard (middleware/inputGuard.ts)', () => {
    it('an id-named field holding an object/array is refused before any handler runs', async () => {
      for (const key of ['clientId', 'branchId', 'tagId', 'roleId', 'id', 'salesPersonId']) {
        const r = await a.post('/sales/invoices', { [key]: { not: '' }, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', items: [] });
        expect(r.status, key).toBe(400);
        expect(JSON.stringify(r.body)).toMatch(/must be an id string/);
      }
      // nested inside a line item too
      const nested = await a.post('/sales/invoices', { clientId: A.client, branchId: A.branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL', items: [{ productCode: 'X', tagId: { contains: '' } }] });
      expect(nested.status).toBe(400);
    });

    it('a *Ids field must be a list of strings', async () => {
      expect((await a.post('/sales/memos/x/return', { tagIds: [{ not: '' }] })).status).toBe(400);
      expect((await a.post('/sales/memos/x/return', { tagIds: 'abc' })).status).toBe(400);
    });

    it('query strings may not carry nested objects (?status[not]=x) — flat strings and repeated keys still work', async () => {
      expect((await a.get('/tagging/tags?status[not]=SOLD')).status).toBe(400);
      expect((await a.get('/orders/clients?type[contains]=x')).status).toBe(400);
      expect((await a.get('/tagging/tags?status=IN_STOCK&limit=5')).status).toBe(200);
      expect((await a.get('/tagging/tags?status=IN_STOCK&status=SOLD')).status).not.toBe(400);
    });

    it('null / omitted ids are still fine (optional references stay optional)', async () => {
      const r = await a.post('/tagging/tags', tagBody(A, { collectionId: null, subCategoryId: null, manufacturerId: null }));
      expect(r.status).toBe(201);
    });
  });

  describe('foreign references', () => {
    it("a tag's manufacturer must be the caller's own client — another company's is a 404 (create and edit)", async () => {
      const own = await a.post('/tagging/tags', tagBody(A, { manufacturerId: A.client }));
      expect(own.status).toBe(201);
      expect((await a.post('/tagging/tags', tagBody(A, { manufacturerId: B.client }))).status).toBe(404);
      const tag = await newTag(a, A);
      expect((await a.patch(`/tagging/tags/${tag.id}`, { manufacturerId: B.client })).status).toBe(404);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).manufacturerId).toBeNull();
    });

    it('everything else that names the other company is a 404 and changes nothing', async () => {
      const bTag = await newTag(b, B);
      expect((await a.post('/tagging/tags', tagBody(A, { categoryId: B.category }))).status).toBe(404);
      expect((await a.post('/sales/invoices', invoiceBody(A, bTag))).status).toBe(404); // B's client-less tag on A's invoice
      expect((await a.post('/sales/invoices', invoiceBody(A, await newTag(a, A), { clientId: B.client }))).status).toBe(404);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: bTag.id } })).status).toBe('IN_STOCK');
    });
  });
});
