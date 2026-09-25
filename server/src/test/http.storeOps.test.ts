import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { app } from '../app';
import { platformPrisma as prisma } from '../config/database';
import { provisionCompany } from '../modules/platform/provisioning.service';
import { apiWith, purgeCompany, uniqueCompanyCode } from './fixtures';

// The store-operations loop (Phase I) driven over REAL HTTP, the way the browser drives it — JSON dates as
// strings, ids as strings, real permission checks — because the service-level tests pass Date objects straight in
// and never touch the routers. (That is exactly how PO/GRN creation shipped with a 500 on `orderDate`.)
//
//   supplier -> PO (finished piece, GST) -> GRN (receiving branch) -> tag from the GRN -> pay the supplier
//   -> estimate -> send to billing -> find it by customer name -> bill it -> PAN / cash rules -> isolation

const DOMAIN = '@httpstoreops.example.com';
const PASSWORD = 'StoreOps-Passw0rd-123';

describe('HTTP: the store-operations loop (Phase I)', () => {
  const created: string[] = [];
  const A: Record<string, any> = {}; const B: Record<string, any> = {};
  let a: ReturnType<typeof apiWith>; let b: ReturnType<typeof apiWith>;

  async function bringUp(into: Record<string, any>, tag: string) {
    const code = uniqueCompanyCode(tag);
    const email = `${code.toLowerCase()}${DOMAIN}`;
    const r = await provisionCompany({ code, name: `StoreOps ${tag}`, admin: { email, name: 'Owner Person', password: PASSWORD } });
    created.push(r.company.id);
    const login = await request(app).post('/api/v1/auth/login').send({ companyCode: code, identifier: email, password: PASSWORD });
    expect(login.status).toBe(200);
    into.token = login.body.data.accessToken; into.companyId = r.company.id; into.branchId = r.branch.id; into.userId = login.body.data.user?.id;
    const api = apiWith(into.token, app);
    into.category = (await api.get('/masters/categories')).body.data[0].id;
    into.stockType = (await api.get('/masters/stock-types')).body.data[0].id;
    return api;
  }

  beforeAll(async () => { a = await bringUp(A, 'SOA'); b = await bringUp(B, 'SOB'); }, 120_000);
  afterAll(async () => {
    const members = await prisma.companyUser.findMany({ where: { user: { email: { endsWith: DOMAIN } } }, select: { companyId: true } });
    for (const id of new Set([...created, ...members.map((m) => m.companyId)])) await purgeCompany(id);
    await prisma.user.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.$disconnect();
  });

  // ── the buy side ─────────────────────────────────────────────────────────────
  describe('inward: supplier -> PO -> GRN -> tag -> pay', () => {
    it('runs end to end, with JSON dates', async () => {
      // A GST-registered supplier in the company's own state is not known here, so the split may be CGST/SGST or IGST —
      // what matters is that the tax is booked and reversible; the split itself is covered in the service tests.
      const sup = await a.post('/procurement/suppliers', { name: 'Ornament House', type: 'OTHER', gstNumber: '27AAAAA0000A1Z5', state: 'Maharashtra' });
      expect(sup.status).toBe(201);
      A.supplierId = sup.body.data.id;

      const po = await a.post('/procurement/orders', {
        supplierId: A.supplierId, poType: 'OUTRIGHT', orderDate: '2026-09-01T00:00:00.000Z',
        items: [{ materialCode: 'R1', materialName: 'Temple ring', materialType: 'FINISHED_GOODS', quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: 40000 }],
      });
      expect(po.status).toBe(201);
      expect(Number(po.body.data.poItems[0].taxRate)).toBeCloseTo(0.03);
      expect(Number(po.body.data.taxAmount)).toBeCloseTo(1200);
      expect(Number(po.body.data.totalAmount)).toBeCloseTo(41200);

      // a quantity-3 finished line is refused (one line = one piece)
      const bad = await a.post('/procurement/orders', {
        supplierId: A.supplierId, poType: 'OUTRIGHT', orderDate: '2026-09-01',
        items: [{ materialCode: 'R2', materialName: 'Bulk', materialType: 'FINISHED_GOODS', quantity: 3, weight: 8, unit: 'PC', ratePerUnit: 100 }],
      });
      expect(bad.status).toBe(400);

      // garbage date -> 400, not a 500
      expect((await a.post('/procurement/orders', { supplierId: A.supplierId, poType: 'OUTRIGHT', orderDate: 'nope', items: [] })).status).toBe(400);

      // GRN without a receiving branch is refused; with one it is created
      const item = po.body.data.poItems[0];
      const grnItems = [{ poItemId: item.id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }];
      expect((await a.post('/procurement/grn', { poId: po.body.data.id, receivedDate: '2026-09-02T00:00:00.000Z', items: grnItems })).status).toBe(400);
      const grn = await a.post('/procurement/grn', {
        poId: po.body.data.id, branchId: A.branchId, receivedDate: '2026-09-02T00:00:00.000Z', invoiceNumber: 'OH/26/118', invoiceDate: '2026-09-02', items: grnItems,
      });
      expect(grn.status).toBe(201);
      expect(grn.body.data.branchId).toBe(A.branchId);
      A.grnId = grn.body.data.id;
      A.grnItemId = grn.body.data.grnItems[0].id;

      // the GRN list shows the finished line and that it is not tagged yet — what the Tag button is driven by
      const list = await a.get('/procurement/grn');
      const row = list.body.data.find((g: any) => g.id === A.grnId);
      expect(row.branch.id).toBe(A.branchId);
      expect(row.grnItems[0].poItem.materialType).toBe('FINISHED_GOODS');
      expect(row.grnItems[0].jewelryTag).toBeNull();

      // tag it — no branchId in the body: it falls back to the GRN's receiving branch
      const tag = await a.post('/tagging/tags/from-grn-item', {
        grnItemId: A.grnItemId, name: 'Temple ring', metalType: 'GOLD', metalKarat: '22K', stockTypeId: A.stockType, categoryId: A.category,
        grossWeight: 8, sellingPrice: 52000,
      });
      expect(tag.status).toBe(201);
      expect(tag.body.data.branchId).toBe(A.branchId);
      expect(tag.body.data.status).toBe('IN_STOCK');
      expect(Number(tag.body.data.costPrice)).toBe(40000);
      A.tagId = tag.body.data.id;
      A.tagNumber = tag.body.data.tagNumber;

      // ...and the GRN list now shows the tag against that line
      const after = (await a.get('/procurement/grn')).body.data.find((g: any) => g.id === A.grnId);
      expect(after.grnItems[0].jewelryTag.tagNumber).toBe(A.tagNumber);
      // a second tag for the same line is refused
      expect((await a.post('/tagging/tags/from-grn-item', { grnItemId: A.grnItemId, name: 'dup', metalType: 'GOLD', stockTypeId: A.stockType, categoryId: A.category })).status).toBe(409);

      // supplier now owed goods + GST
      const sups = (await a.get('/procurement/suppliers')).body.data;
      expect(Number(sups.find((s: any) => s.id === A.supplierId).currentDue)).toBeCloseTo(41200);
    });

    it('pays the supplier over HTTP and the statement, payable and ITC report all agree', async () => {
      const pay = await a.post(`/procurement/suppliers/${A.supplierId}/payments`, { amount: 10000, mode: 'UPI', paymentDate: '2026-09-05', referenceNo: 'UTR9' });
      expect(pay.status).toBe(201);
      expect(pay.body.data.paymentNumber).toMatch(/^SPMT-2026-/);
      expect((await a.post(`/procurement/suppliers/${A.supplierId}/payments`, { amount: 5, mode: 'CASH', paymentDate: 'garbage' })).status).toBe(400);
      expect((await a.post(`/procurement/suppliers/${A.supplierId}/payments`, { amount: 0, mode: 'CASH' })).status).toBe(400);

      const list = await a.get(`/procurement/suppliers/${A.supplierId}/payments`);
      expect(list.body.data).toHaveLength(1);

      const ledger = await a.get(`/finance/reports/supplier-ledger/${A.supplierId}`);
      expect(ledger.status).toBe(200);
      expect(ledger.body.data.closingBalance).toBeCloseTo(31200);
      expect(ledger.body.data.supplier.currentDue).toBeCloseTo(31200);

      const gst = await a.get('/finance/reports/purchase-gst-summary?from=2026-04-01&to=2026-12-31');
      expect(gst.status).toBe(200);
      expect(gst.body.data.totals.taxableValue).toBeCloseTo(40000);
      expect(gst.body.data.totals.totalTax).toBeCloseTo(1200);
      expect(gst.body.data.bills[0]).toMatchObject({ invoiceNumber: 'OH/26/118', supplierGstin: '27AAAAA0000A1Z5' });
    });
  });

  // ── estimate -> billing ──────────────────────────────────────────────────────
  describe('estimate -> send to billing -> find by name -> bill', () => {
    it('is not offered until sent, then found by customer name, and billing it marks it INVOICED', async () => {
      A.client = (await a.post('/orders/clients', { name: 'Walk-in Ramesh', type: 'RETAIL', panNumber: 'abcde1234f' })).body.data.id;
      const estBody = { items: [{ code: 'GOLD-22K', materialType: 'METAL', name: 'Gold 22K', weight: 8, saleRate: 6000 }], saleMcRate: 400, saleVaPercent: 8 };

      const plain = await a.post(`/estimation/tags/${A.tagId}/estimates`, estBody);
      expect(plain.status).toBe(201);
      expect(plain.body.data.status).toBe('OPEN');
      expect((await a.get('/sales/estimates?q=Ramesh')).body.data).toHaveLength(0);

      const sent = await a.post(`/estimation/estimates/${plain.body.data.id}/send-to-billing`, { customerName: 'Ramesh Kumar', customerPhone: '9000000001' });
      expect(sent.status).toBe(200);
      expect(sent.body.data.status).toBe('SENT');

      for (const q of ['ramesh', plain.body.data.estimateNumber, 'temple', '9000000001']) {
        const found = await a.get(`/sales/estimates?q=${encodeURIComponent(q)}`);
        expect(found.body.data.map((e: any) => e.id), q).toContain(plain.body.data.id);
      }
      const [est] = (await a.get('/sales/estimates?q=ramesh')).body.data;
      expect(JSON.stringify(est)).not.toMatch(/costRate|costAmount|totalCostAmount|costPrice/);

      // branches the biller may bill from
      const branches = await a.get('/sales/branches');
      expect(branches.body.data.map((x: any) => x.id)).toContain(A.branchId);

      // bill it with an edited price
      const inv = await a.post('/sales/invoices', {
        clientId: A.client, branchId: A.branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
        estimateIds: [plain.body.data.id],
        items: [{ productCode: A.tagNumber, description: 'Temple ring', quantity: 1, grossWeight: 8, netGoldWeight: 8, rateType: 'FIXED', goldRate: 50000, tagId: A.tagId }],
      });
      expect(inv.status).toBe(201);
      const after = await prisma.tagEstimate.findUniqueOrThrow({ where: { id: plain.body.data.id } });
      expect(after.status).toBe('INVOICED');
      expect(after.invoiceId).toBe(inv.body.data.id);
      expect((await a.get('/sales/estimates?q=ramesh')).body.data).toHaveLength(0);
    });
  });

  // ── PAN and cash ─────────────────────────────────────────────────────────────
  describe('PAN and cash limits over HTTP', () => {
    it('validates PAN on the client endpoints, and a big sale needs one', async () => {
      expect((await a.post('/orders/clients', { name: 'Bad PAN', type: 'RETAIL', panNumber: 'not-a-pan' })).status).toBe(400);
      const c = await a.post('/orders/clients', { name: 'No PAN Customer', type: 'RETAIL' });
      expect(c.status).toBe(201);
      const tag = (await a.post('/tagging/tags', {
        branchId: A.branchId, name: 'Big piece', metalType: 'GOLD', metalKarat: '22K', grossWeight: 50, netWeight: 50,
        costPrice: 100, sellingPrice: 300000, stockTypeId: A.stockType, categoryId: A.category,
      })).body.data;
      const body = (clientId: string) => ({
        clientId, branchId: A.branchId, invoiceDate: new Date().toISOString(), invoiceType: 'RETAIL',
        items: [{ productCode: tag.tagNumber, description: 'Big piece', quantity: 1, grossWeight: 50, netGoldWeight: 50, rateType: 'FIXED', goldRate: 300000, tagId: tag.id }],
      });

      const refused = await a.post('/sales/invoices', body(c.body.data.id));
      expect(refused.status).toBe(400);
      expect(refused.body.error).toMatch(/PAN required/);
      expect((await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } })).status).toBe('IN_STOCK');

      // add the PAN (lower-case in, upper-case stored) and it goes through
      const patched = await a.patch(`/orders/clients/${c.body.data.id}`, { panNumber: 'abcde1234f' });
      expect(patched.body.data.panNumber).toBe('ABCDE1234F');
      expect((await a.post('/sales/invoices', body(c.body.data.id))).status).toBe(201);
    });

    it('refuses cash of ₹2,00,000 or more from one client in a day, over HTTP', async () => {
      const c = (await a.post('/orders/clients', { name: 'Cash Customer', type: 'RETAIL', panNumber: 'ABCDE1234F' })).body.data;
      const r = await a.post(`/sales/clients/${c.id}/payments`, { amount: 200000, mode: 'CASH', paymentDate: '2026-05-05' });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(/Sec 269ST/);
      expect((await a.post(`/sales/clients/${c.id}/payments`, { amount: 199999, mode: 'CASH', paymentDate: '2026-05-05' })).status).toBe(201);
      expect((await a.post(`/sales/clients/${c.id}/payments`, { amount: 500000, mode: 'BANK_TRANSFER', paymentDate: '2026-05-05' })).status).toBe(201);
    });

    it('a client body cannot set the balance', async () => {
      const c = await a.post('/orders/clients', { name: 'Sneaky', type: 'RETAIL', currentBalance: 12345 });
      expect(Number(c.body.data.currentBalance)).toBe(0);
      const p = await a.patch(`/orders/clients/${c.body.data.id}`, { currentBalance: 99, name: 'Renamed' });
      expect(Number(p.body.data.currentBalance)).toBe(0);
    });
  });

  // ── isolation ────────────────────────────────────────────────────────────────
  describe("another company sees none of it", () => {
    it("cannot pay, statement, or read A's supplier / estimates, and its billing search is empty", async () => {
      expect((await b.post(`/procurement/suppliers/${A.supplierId}/payments`, { amount: 1, mode: 'CASH', paymentDate: '2026-09-05' })).status).toBe(404);
      expect((await b.get(`/procurement/suppliers/${A.supplierId}/payments`)).status).toBe(404);
      expect((await b.get(`/finance/reports/supplier-ledger/${A.supplierId}`)).status).toBe(404);
      expect((await b.get('/sales/estimates?q=ramesh')).body.data).toHaveLength(0);
      expect((await b.get('/procurement/grn')).body.data).toHaveLength(0);
      expect((await b.get('/sales/branches')).body.data.map((x: any) => x.id)).not.toContain(A.branchId);
      // A's GRN line cannot be tagged from B
      expect((await b.post('/tagging/tags/from-grn-item', { grnItemId: A.grnItemId, name: 'x', metalType: 'GOLD', stockTypeId: B.stockType, categoryId: B.category })).status).toBe(404);
    });
  });
});
