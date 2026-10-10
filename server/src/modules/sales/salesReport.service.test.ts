import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { createInvoice, amendInvoice, createSalesReturn } from './sales.service';
import { getSalesSummary, getSalesDetailed } from './salesReport.service';
import { seedMetalRate, createTestTenant, cleanupTestTenant, createMember, addBranch, TestTenant } from '../../test/fixtures';

// Sales Report: Summary = one row per invoice; Detailed = one row per line, credited to the employee who made that sale.
describe('Sales Report (summary + detailed, per-line salesperson attribution)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant, B: TestTenant;
  let ravi: string, suresh: string, outsider: string; // outsider = a member of company B only
  let clientA: string, clientB: string, branch2: string;
  let inv1: any, inv2: any, inv3: any, invRet: any, invB: any, legacy: any;
  const extraUsers: string[] = [];

  const line = (price: number, o: Record<string, unknown> = {}) => ({
    productCode: 'LN', description: 'Line', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: price, ...o,
  });
  const make = (data: any, tenant = A, branchId = tenant.branch.id) =>
    createInvoice({ invoiceType: 'RETAIL', invoiceDate: new Date('2026-03-10'), branchId, ...data }, tenant.ctx, tenant.user.id);
  const range = { from: new Date('2026-03-01'), to: new Date('2026-03-31') };

  beforeAll(async () => {
    A = await createTestTenant(`SRA${suffix}`, ['invoice:create']);
    await seedMetalRate(A.company.id, '22K', 6000);
    B = await createTestTenant(`SRB${suffix}`, ['invoice:create']);
    const mk = async (t: TestTenant, name: string) => {
      const m = await createMember({ companyId: t.company.id, roleId: t.role.id, email: `${name}-${suffix}@example.com`, name });
      extraUsers.push(m.user.id);
      return m.user.id;
    };
    ravi = await mk(A, 'Ravi'); suresh = await mk(A, 'Suresh'); outsider = await mk(B, 'Outsider');
    clientA = (await prisma.client.create({ data: { companyId: A.company.id, clientCode: `CA-${suffix}`, name: 'Client A', type: 'RETAIL', panNumber: 'ABCDE1234F' } })).id;
    clientB = (await prisma.client.create({ data: { companyId: B.company.id, clientCode: `CB-${suffix}`, name: 'Client B', type: 'RETAIL', panNumber: 'ABCDE1234F' } })).id;
    branch2 = (await addBranch(A.company.id, suffix)).id;

    // INV1: header Ravi; Ravi 2 lines, Suresh 2 lines; other charges + discount so non-line amounts exist.
    inv1 = await make({
      clientId: clientA, salesPersonId: ravi, otherCharges: 100, discountAmount: 500,
      items: [line(120000, { salesPersonId: ravi, description: 'Ring' }), line(90000, { salesPersonId: ravi, description: 'Chain' }),
        line(200000, { salesPersonId: suresh, description: 'Necklace' }), line(115000, { salesPersonId: suresh, description: 'Bangle' })],
    });
    // INV2: header Ravi, every line blank -> inherits Ravi.
    inv2 = await make({ clientId: clientA, salesPersonId: ravi, items: [line(10000), line(20000)] });
    // INV3: other branch, header Suresh, one line blank (inherits) and one Ravi.
    inv3 = await make({ clientId: clientA, salesPersonId: suresh, items: [line(5000), line(7000, { salesPersonId: ravi })] }, A, branch2);
    // Returned line keeps its attribution.
    const tag = await prisma.jewelryTag.create({ data: {
      tagNumber: `SRTAG-${suffix}`, companyId: A.company.id, branchId: A.branch.id, name: 'Returned ring', metalType: 'GOLD', metalKarat: '22K',
      grossWeight: 5, netWeight: 5, stoneWeight: 0, costPrice: 1, sellingPrice: 2, createdById: A.user.id,
    } });
    invRet = await make({ clientId: clientA, salesPersonId: ravi, items: [line(30000, { tagId: tag.id, salesPersonId: suresh, productCode: tag.tagNumber })] });
    await createSalesReturn({ invoiceId: invRet.id, items: [{ invoiceItemId: invRet.items[0].id }] }, A.ctx, A.user.id);
    // Company B invoice, billed by B's own employee.
    invB = await make({ clientId: clientB, salesPersonId: outsider, items: [line(999000, { salesPersonId: outsider })] }, B);

    // Old invoice: pre-attribution, pre-G1 line values (taxableValue 0), header Suresh only.
    legacy = await prisma.salesInvoice.create({ data: {
      companyId: A.company.id, branchId: A.branch.id, invoiceNumber: `LEG-${suffix}`, clientId: clientA, invoiceDate: new Date('2026-03-12'),
      invoiceType: 'RETAIL', salesPersonId: suresh, subtotal: 40000, taxAmount: 1200, totalAmount: 41200, balanceDue: 41200, status: 'ISSUED',
      items: { createMany: { data: [
        { productCode: 'L1', description: 'Old 1', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 10000, makingCharge: 0, unitPrice: 10000, totalPrice: 10000, taxRate: 0.03 },
        { productCode: 'L2', description: 'Old 2', quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED', goldRate: 30000, makingCharge: 0, unitPrice: 30000, totalPrice: 30000, taxRate: 0.03 },
      ] } },
    } });
  }, 120000);

  afterAll(async () => {
    // The fixture cleanup removes invoices but not clients (company delete is RESTRICTed by them): clear them, then finish.
    for (const t of [A, B]) {
      await cleanupTestTenant(t).catch(() => undefined);
      await prisma.client.deleteMany({ where: { companyId: t.company.id } });
      await cleanupTestTenant(t);
    }
    await prisma.companyUser.deleteMany({ where: { userId: { in: extraUsers } } });
    await prisma.user.deleteMany({ where: { id: { in: extraUsers } } });
    await prisma.$disconnect();
  });

  describe('attribution on the invoice (prerequisite)', () => {
    it('stores a per-line salesPersonId and leaves blank lines null', async () => {
      const rows = await prisma.invoiceItem.findMany({ where: { invoiceId: inv1.id } });
      expect(rows.filter((r) => r.salesPersonId === suresh)).toHaveLength(2);
      const rows2 = await prisma.invoiceItem.findMany({ where: { invoiceId: inv2.id } });
      expect(rows2.every((r) => r.salesPersonId === null)).toBe(true);
      expect(inv2.salesPersonId).toBe(ravi);
    });

    it("rejects another company's employee on a line or the header (404) and persists nothing", async () => {
      const before = await prisma.salesInvoice.count({ where: { companyId: A.company.id } });
      await expect(make({ clientId: clientA, items: [line(100, { salesPersonId: outsider })] })).rejects.toMatchObject({ statusCode: 404 });
      await expect(make({ clientId: clientA, salesPersonId: outsider, items: [line(100)] })).rejects.toMatchObject({ statusCode: 404 });
      expect(await prisma.salesInvoice.count({ where: { companyId: A.company.id } })).toBe(before);
    });

    it('amend keeps lines\' employees when omitted and validates a newly named one', async () => {
      const items = inv2.items.map((i: any) => ({ id: i.id, productCode: i.productCode, description: i.description, quantity: 1, grossWeight: 1,
        netGoldWeight: 1, rateType: 'FIXED', goldRate: Number(i.goldRate), salesPersonId: suresh }));
      await expect(amendInvoice(inv2.id, { items: items.map((i: any) => ({ ...i, salesPersonId: outsider })) }, A.ctx, A.user.id)).rejects.toMatchObject({ statusCode: 404 });
      await amendInvoice(inv2.id, { items }, A.ctx, A.user.id);
      expect((await prisma.invoiceItem.findMany({ where: { invoiceId: inv2.id } })).every((r) => r.salesPersonId === suresh)).toBe(true);
      // put it back so the other tests keep their fixture meaning
      await amendInvoice(inv2.id, { items: items.map((i: any) => ({ ...i, salesPersonId: null })) }, A.ctx, A.user.id);
      expect((await prisma.invoiceItem.findMany({ where: { invoiceId: inv2.id } })).every((r) => r.salesPersonId === null)).toBe(true);
    });
  });

  describe('Summary — 1 invoice = 1 row', () => {
    it('one invoice with two employees is ONE row listing both', async () => {
      const r = await getSalesSummary(A.ctx, range);
      const rows = r.rows.filter((x) => x.id === inv1.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].salesEmployees).toEqual(['Ravi', 'Suresh']);
      expect(r.rows.find((x) => x.id === inv2.id)!.salesEmployees).toEqual(['Ravi']); // single employee, single row
    });

    it('employee filter matches header OR any line, and the invoice still appears once', async () => {
      const r = await getSalesSummary(A.ctx, { ...range, salesPersonId: suresh });
      const ids = r.rows.map((x) => x.id);
      expect(ids.filter((i) => i === inv1.id)).toHaveLength(1); // Suresh only via lines
      expect(ids).toContain(inv3.id);   // Suresh via the header
      expect(ids).toContain(legacy.id); // header only, old invoice
      expect(ids).not.toContain(inv2.id);
    });

    it('totals reconcile with the invoices (no duplication from multi-employee invoices)', async () => {
      const r = await getSalesSummary(A.ctx, range);
      expect(r.totals.invoiceCount).toBe(r.rows.length);
      expect(r.totals.invoiceTotal).toBeCloseTo(r.rows.reduce((s, x) => s + x.invoiceTotal, 0), 2);
      expect(r.totals.gstTotal).toBeCloseTo(r.rows.reduce((s, x) => s + x.gstTotal, 0), 2);
      expect(r.totals.taxableAmount).toBeCloseTo(r.rows.reduce((s, x) => s + x.taxableAmount, 0), 2);
      const stored = await prisma.salesInvoice.aggregate({ where: { companyId: A.company.id, invoiceDate: { gte: range.from, lte: range.to } }, _sum: { totalAmount: true } });
      expect(r.totals.invoiceTotal).toBeCloseTo(Number(stored._sum.totalAmount), 2);
    });

    it('filters: invoice no, customer, payment status, invoice status', async () => {
      expect((await getSalesSummary(A.ctx, { ...range, invoiceNo: inv1.invoiceNumber.slice(-4) })).rows.some((x) => x.id === inv1.id)).toBe(true);
      expect((await getSalesSummary(A.ctx, { ...range, customer: 'nobody-here' })).rows).toHaveLength(0);
      expect((await getSalesSummary(A.ctx, { ...range, paymentStatus: 'UNPAID' })).rows.length).toBeGreaterThan(0);
      expect((await getSalesSummary(A.ctx, { ...range, paymentStatus: 'PAID' })).rows).toHaveLength(0);
      expect((await getSalesSummary(A.ctx, { ...range, status: 'ISSUED' })).rows.map((x) => x.id)).toEqual([legacy.id]);
      await expect(getSalesSummary(A.ctx, { ...range, paymentStatus: 'BOGUS' })).rejects.toMatchObject({ statusCode: 400 });
    });

    it('is company-isolated: neither company sees the other\'s invoices or employees', async () => {
      const a = await getSalesSummary(A.ctx, range);
      const b = await getSalesSummary(B.ctx, range);
      expect(a.rows.some((x) => x.id === invB.id)).toBe(false);
      expect(JSON.stringify(a)).not.toContain('Outsider');
      expect(b.rows.map((x) => x.id)).toEqual([invB.id]);
      expect(b.employeeOptions.map((e) => e.name)).toEqual(['Outsider', 'Test User'].sort());
    });

    it('respects branch access', async () => {
      const restricted = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [branch2] } };
      const r = await getSalesSummary(restricted, range);
      expect(r.rows.map((x) => x.id)).toEqual([inv3.id]);
      await expect(getSalesSummary(restricted, { ...range, branchId: A.branch.id })).rejects.toBeTruthy();
    });
  });

  describe('Detailed — invoice → employee → line', () => {
    it('credits each line to its own employee; a blank line falls back to the invoice employee', async () => {
      const r = await getSalesDetailed(A.ctx, range);
      const l1 = r.rows.filter((x) => x.invoiceId === inv1.id);
      expect(l1).toHaveLength(4);
      expect(l1.filter((x) => x.salesEmployee === 'Ravi').map((x) => x.description).sort()).toEqual(['Chain', 'Ring']);
      expect(l1.filter((x) => x.salesEmployee === 'Suresh').map((x) => x.description).sort()).toEqual(['Bangle', 'Necklace']);
      const l2 = r.rows.filter((x) => x.invoiceId === inv2.id);
      expect(l2.every((x) => x.salesEmployee === 'Ravi' && x.attributedBy === 'INVOICE')).toBe(true);
      const l3 = r.rows.filter((x) => x.invoiceId === inv3.id);
      expect(l3.find((x) => x.jewelCode === 'LN' && x.attributedBy === 'INVOICE')!.salesEmployee).toBe('Suresh');
      expect(l3.find((x) => x.attributedBy === 'LINE')!.salesEmployee).toBe('Ravi');
    });

    it('employee totals count an invoice once per employee and reconcile with the lines', async () => {
      const r = await getSalesDetailed(A.ctx, range);
      const e = (n: string) => r.employees.find((x) => x.salesEmployee === n)!;
      expect(e('Ravi').invoiceCount).toBe(3); // inv1, inv2, inv3 (one Ravi line)
      expect(e('Suresh').invoiceCount).toBe(4); // inv1, inv3, invRet, legacy
      expect(r.employees.reduce((s, x) => s + x.salesAmount, 0)).toBeCloseTo(r.totals.salesAmount, 2);
      expect(r.totals.invoiceCount).toBe(new Set(r.rows.map((x) => x.invoiceId)).size);
    });

    it('invoice-level reconciliation: lines + non-line charges account for the whole total (difference 0)', async () => {
      const r = await getSalesDetailed(A.ctx, range);
      const rec = r.reconciliation.find((x) => x.invoiceId === inv1.id)!;
      expect(rec.invoiceTotal).toBeCloseTo(Number(inv1.totalAmount), 2);
      expect(rec.nonLineAmount).toBeGreaterThan(100); // other charges + their GST + round-off
      expect(rec.difference).toBeCloseTo(0, 1);
      expect(r.reconciliation.every((x) => !x.hasDiscrepancy)).toBe(true);
      expect(r.totals.discrepancyCount).toBe(0);
    });

    it('a discrepancy is surfaced, not hidden', async () => {
      await prisma.invoiceItem.updateMany({ where: { invoiceId: inv3.id, productCode: 'LN' }, data: { taxableValue: 1 } }); // corrupt one line's stored value
      const r = await getSalesDetailed(A.ctx, range);
      const rec = r.reconciliation.find((x) => x.invoiceId === inv3.id)!;
      expect(rec.hasDiscrepancy).toBe(true);
      expect(Math.abs(rec.difference)).toBeGreaterThan(1000);
      expect(r.totals.discrepancyCount).toBeGreaterThan(0);
    });

    it('employee filter returns only that employee\'s lines (own line, or blank line inheriting the header)', async () => {
      const r = await getSalesDetailed(A.ctx, { ...range, salesPersonId: suresh });
      expect(r.rows.every((x) => x.salesEmployeeId === suresh)).toBe(true);
      expect(r.rows.some((x) => x.invoiceId === inv2.id)).toBe(false);
      expect(r.rows.some((x) => x.invoiceId === inv1.id)).toBe(true);
    });

    it('carries the tag-level money split: metal, MC, VA, stone cost, taxable, GST parts', async () => {
      const inv = await make({ clientId: clientA, salesPersonId: ravi, invoiceDate: new Date('2026-03-20'), items: [{
        productCode: 'PG', description: 'Per gram ring', quantity: 1, grossWeight: 11, netGoldWeight: 10, stoneWeight: 1, rateType: 'PER_GRAM',
        goldRate: 6000, makingCharge: 1000, wastagePercent: 10, stoneValue: 500, karat: '22K',
      }] });
      const r = await getSalesDetailed(A.ctx, { from: new Date('2026-03-20'), to: new Date('2026-03-20') });
      const row = r.rows.find((x) => x.invoiceId === inv.id)!;
      expect(row.metalRate).toBe(6000);
      expect(row.metalValue).toBe(60000);
      expect(row.mcAmount).toBe(1000);
      expect(row.vaPercent).toBe(10);
      expect(row.vaAmount).toBe(6000); // 10% of the 60000 metal value
      expect(row.stoneValue).toBe(500);
      expect(row.grossAmount).toBe(67500); // 60000 metal + 1000 MC + 6000 VA (10% of metal) + 500 stone
      expect(row.taxableAmount).toBe(67500);
      expect(row.taxRate).toBe(3);
      expect(row.cgst + row.sgst + row.igst).toBeCloseTo(row.gst, 2);
      expect(row.karat).toBe('22K');
    });

    it('a returned line keeps its employee and shows the return', async () => {
      const r = await getSalesDetailed(A.ctx, range);
      const row = r.rows.find((x) => x.invoiceId === invRet.id)!;
      expect(row.salesEmployee).toBe('Suresh');
      expect(row.lineStatus).toBe('RETURNED');
      expect(row.returnedAmount).toBeGreaterThan(0);
      expect(row.netTotal).toBeCloseTo(row.lineTotal - row.returnedAmount, 2);
    });

    it('backward compatible: an old invoice with null line salesperson and no stored tax split reports under the invoice employee, and reconciles', async () => {
      const r = await getSalesDetailed(A.ctx, range);
      const rows = r.rows.filter((x) => x.invoiceId === legacy.id);
      expect(rows).toHaveLength(2);
      expect(rows.every((x) => x.salesEmployee === 'Suresh' && x.attributedBy === 'INVOICE')).toBe(true);
      expect(rows.reduce((s, x) => s + x.lineTotal, 0)).toBeCloseTo(41200, 1);
      expect(r.reconciliation.find((x) => x.invoiceId === legacy.id)!.difference).toBeCloseTo(0, 1);
    });

    it('is company-isolated and honours branch access', async () => {
      const a = await getSalesDetailed(A.ctx, range);
      expect(a.rows.some((x) => x.invoiceId === invB.id)).toBe(false);
      expect(JSON.stringify(a)).not.toContain('Outsider');
      const b = await getSalesDetailed(B.ctx, range);
      expect(b.rows.map((x) => x.salesEmployee)).toEqual(['Outsider']);
      const restricted = { ...A.ctx, branchAccess: { allBranches: false, branchIds: [branch2] } };
      expect((await getSalesDetailed(restricted, range)).rows.every((x) => x.invoiceId === inv3.id)).toBe(true);
    });
  });
});
