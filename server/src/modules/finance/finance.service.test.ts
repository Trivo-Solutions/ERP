import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { getDealerAging, getClientLedger, getDayBook, getGstSummary } from './finance.service';
import { createInvoice, voidInvoice } from '../sales/sales.service';
import { cleanupJournalEntries } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';

// F3: aging of every client's unpaid balance, bucketed by how overdue each invoice is (from
// dueDate), plus an overLimit flag for clients currently past their own Client.creditLimit.
// SalesInvoice rows are created directly (not via createInvoice) so dueDate/balanceDue can be
// controlled precisely per bucket, independent of the pricing/tax machinery this doesn't test.
describe('getDealerAging (F3)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const asOf = new Date('2026-06-30T00:00:00Z');
  const daysAgo = (n: number) => new Date(asOf.getTime() - n * 86_400_000);

  let tenant: TestTenant;
  let clientAId: string; // over its own credit limit
  let clientBId: string; // no credit limit set
  const invoiceIds: string[] = [];

  async function makeInvoice(clientId: string, dueDaysAgo: number, balanceDue: number) {
    const inv = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId: tenant.branch.id,
        invoiceNumber: `TSTINV-AGE-${suffix}-${invoiceIds.length}`,
        clientId, invoiceDate: daysAgo(dueDaysAgo), dueDate: daysAgo(dueDaysAgo),
        invoiceType: 'RETAIL', subtotal: balanceDue, totalAmount: balanceDue,
        balanceDue, status: 'PARTIALLY_PAID',
      },
    });
    invoiceIds.push(inv.id);
    return inv;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`AGE${suffix}`, []);

    const clientA = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-AGE-A-${suffix}`, name: 'Aging Dealer A', type: 'WHOLESALE', creditLimit: 100000, currentBalance: 150000 },
    });
    clientAId = clientA.id;

    const clientB = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-AGE-B-${suffix}`, name: 'Aging Client B', type: 'RETAIL' },
    });
    clientBId = clientB.id;

    await makeInvoice(clientAId, 10, 40000);  // bucket0to30
    await makeInvoice(clientAId, 45, 60000);  // bucket31to60
    await makeInvoice(clientAId, 75, 30000);  // bucket61to90
    await makeInvoice(clientAId, 120, 20000); // bucket90plus

    await makeInvoice(clientBId, 5, 5000);    // bucket0to30, unlimited client
  });

  afterAll(async () => {
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.client.deleteMany({ where: { id: { in: [clientAId, clientBId] } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('buckets outstanding balance by age from dueDate, per client', async () => {
    const result = await getDealerAging(tenant.company.id, asOf);
    const rowA = result.rows.find((r) => r.clientId === clientAId)!;

    expect(rowA.bucket0to30).toBeCloseTo(40000);
    expect(rowA.bucket31to60).toBeCloseTo(60000);
    expect(rowA.bucket61to90).toBeCloseTo(30000);
    expect(rowA.bucket90plus).toBeCloseTo(20000);
    expect(rowA.total).toBeCloseTo(150000);
  });

  it('flags a client currently over their own credit limit', async () => {
    const result = await getDealerAging(tenant.company.id, asOf);
    const rowA = result.rows.find((r) => r.clientId === clientAId)!;

    expect(rowA.overLimit).toBe(true);
    expect(rowA.creditLimit).toBeCloseTo(100000);
  });

  it('does not flag a client with no credit limit set (regression)', async () => {
    const result = await getDealerAging(tenant.company.id, asOf);
    const rowB = result.rows.find((r) => r.clientId === clientBId)!;

    expect(rowB.overLimit).toBe(false);
    expect(rowB.creditLimit).toBeNull();
  });

  it('excludes fully-paid invoices (balanceDue = 0) from every bucket', async () => {
    const paid = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId: tenant.branch.id,
        invoiceNumber: `TSTINV-AGE-${suffix}-paid`, clientId: clientBId,
        invoiceDate: daysAgo(10), dueDate: daysAgo(10), invoiceType: 'RETAIL',
        subtotal: 9999, totalAmount: 9999, paidAmount: 9999, balanceDue: 0, status: 'PAID',
      },
    });
    invoiceIds.push(paid.id);

    const result = await getDealerAging(tenant.company.id, asOf);
    const rowB = result.rows.find((r) => r.clientId === clientBId)!;
    expect(rowB.total).toBeCloseTo(5000); // unchanged — the paid invoice contributes nothing
  });

  it('sorts rows by total outstanding, descending', async () => {
    const result = await getDealerAging(tenant.company.id, asOf);
    const idxA = result.rows.findIndex((r) => r.clientId === clientAId);
    const idxB = result.rows.findIndex((r) => r.clientId === clientBId);
    expect(idxA).toBeLessThan(idxB); // A owes 150000, B owes 5000
  });

  // J3.5 Finding 1: a VOID invoice keeps balanceDue == totalAmount (voidInvoice never zeroes it —
  // eligibility already required zero payments) but is not a live receivable and must not age.
  it('excludes a VOID invoice, even though its balanceDue is still positive', async () => {
    const voided = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId: tenant.branch.id,
        invoiceNumber: `TSTINV-AGE-${suffix}-void`, clientId: clientBId,
        invoiceDate: daysAgo(50), dueDate: daysAgo(50), invoiceType: 'RETAIL',
        subtotal: 77777, totalAmount: 77777, balanceDue: 77777, status: 'VOID',
      },
    });
    invoiceIds.push(voided.id);

    const result = await getDealerAging(tenant.company.id, asOf);
    const rowB = result.rows.find((r) => r.clientId === clientBId)!;
    expect(rowB.total).toBeCloseTo(5000); // unchanged — the voided invoice contributes nothing
  });
});

// F4: one client's statement — every SalesInvoice (debit), InvoicePayment (credit), SalesReturn
// (credit), and OldGoldExchange (credit) merged into one chronological list with a running
// balance. Rows are created directly against each table (not via createInvoice/createSalesReturn/
// etc.) so the date sequence is controlled precisely, independent of the pricing/tax/tag machinery
// this doesn't test — getClientLedger only reads what's already there.
describe('getClientLedger (F4)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const d = (s: string) => new Date(s);

  let tenant: TestTenant;
  let clientId: string;
  let emptyClientId: string;
  let invoiceId: string;

  beforeAll(async () => {
    tenant = await createTestTenant(`LEDGER${suffix}`, []);

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-LEDGER-${suffix}`, name: 'Ledger Test Client', type: 'WHOLESALE', currentBalance: 35000 },
    });
    clientId = client.id;

    const empty = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-LEDGER-EMPTY-${suffix}`, name: 'No Activity Client', type: 'RETAIL' },
    });
    emptyClientId = empty.id;

    const invoice = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId: tenant.branch.id,
        invoiceNumber: `TSTINV-LEDGER-${suffix}`, clientId, invoiceDate: d('2026-01-01'),
        invoiceType: 'WHOLESALE', subtotal: 100000, totalAmount: 100000, balanceDue: 70000, status: 'PARTIALLY_PAID',
      },
    });
    invoiceId = invoice.id;

    await prisma.invoicePayment.create({
      data: {
        companyId: tenant.company.id,
        paymentNumber: `TSTPMT-LEDGER-${suffix}`, clientId, invoiceId, paymentDate: d('2026-01-05'),
        amount: 30000, mode: 'CASH',
      },
    });

    await prisma.salesReturn.create({
      data: {
        companyId: tenant.company.id,
        returnNumber: `TSTRTN-LEDGER-${suffix}`, invoiceId, clientId, returnDate: d('2026-01-10'), totalAmount: 20000,
      },
    });

    await prisma.oldGoldExchange.create({
      data: {
        companyId: tenant.company.id,
        exchangeNumber: `TSTEXG-LEDGER-${suffix}`, clientId, exchangeDate: d('2026-01-15'),
        description: 'Old bangle', karat: '22K', grossWeight: 10, netWeight: 10, ratePerGram: 6000,
        valuedAmount: 15000,
      },
    });
  });

  afterAll(async () => {
    await prisma.oldGoldExchange.deleteMany({ where: { clientId } });
    await prisma.salesReturn.deleteMany({ where: { clientId } });
    await prisma.invoicePayment.deleteMany({ where: { clientId } });
    await prisma.salesInvoice.deleteMany({ where: { id: invoiceId } });
    await prisma.client.deleteMany({ where: { id: { in: [clientId, emptyClientId] } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('merges all four sources chronologically with a running balance', async () => {
    const result = await getClientLedger(tenant.ctx, clientId);

    expect(result.rows.map((r) => r.type)).toEqual(['INVOICE', 'PAYMENT', 'RETURN', 'EXCHANGE']);
    expect(result.rows[0].balance).toBeCloseTo(100000);
    expect(result.rows[1].balance).toBeCloseTo(70000);
    expect(result.rows[2].balance).toBeCloseTo(50000);
    expect(result.rows[3].balance).toBeCloseTo(35000);
  });

  it('closing balance matches Client.currentBalance over the full history', async () => {
    const result = await getClientLedger(tenant.ctx, clientId);
    expect(result.openingBalance).toBe(0);
    expect(result.closingBalance).toBeCloseTo(result.client.currentBalance);
    expect(result.closingBalance).toBeCloseTo(35000);
  });

  it('computes a non-zero opening balance and slices rows for a from/to range', async () => {
    const result = await getClientLedger(tenant.ctx, clientId, d('2026-01-04'), d('2026-01-12'));

    expect(result.openingBalance).toBeCloseTo(100000); // invoice only, before the range
    expect(result.rows.map((r) => r.type)).toEqual(['PAYMENT', 'RETURN']);
    expect(result.closingBalance).toBeCloseTo(50000);
  });

  it('returns an empty ledger with zero balances for a client with no activity', async () => {
    const result = await getClientLedger(tenant.ctx, emptyClientId);
    expect(result.rows).toEqual([]);
    expect(result.openingBalance).toBe(0);
    expect(result.closingBalance).toBe(0);
  });

  // J3.5 Finding 1: a VOID invoice's debit was already reversed (client.currentBalance decremented
  // in the same transaction as the void) — without this exclusion the statement would show an
  // extra, un-offset debit and closingBalance would stop matching Client.currentBalance (the
  // exact reconciliation break the safety audit found).
  it('excludes a VOID invoice so the statement keeps reconciling to Client.currentBalance', async () => {
    const voided = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId: tenant.branch.id,
        invoiceNumber: `TSTINV-LEDGER-${suffix}-void`, clientId, invoiceDate: d('2026-01-20'),
        invoiceType: 'WHOLESALE', subtotal: 99999, totalAmount: 99999, balanceDue: 99999, status: 'VOID',
      },
    });

    const result = await getClientLedger(tenant.ctx, clientId);
    expect(result.rows.some((r) => r.refNumber === voided.invoiceNumber)).toBe(false);
    expect(result.closingBalance).toBeCloseTo(35000); // unchanged from the earlier test — still reconciles
    expect(result.closingBalance).toBeCloseTo(result.client.currentBalance);

    await prisma.salesInvoice.deleteMany({ where: { id: voided.id } });
  });
});

// H4: one day's company-wide rollup — sales/payments/returns/exchanges. Rows are created directly
// against each table so the date can be pinned exactly to (or just outside) the target day,
// independent of the pricing/tax machinery this report doesn't touch.
describe('getDayBook (H4)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const targetDate = new Date('2026-04-10T12:00:00Z');
  const outsideDate = new Date('2026-04-11T12:00:00Z');

  let tenant: TestTenant;
  let clientId: string;
  let invoiceId: string;
  const otherIds: { salesInvoice: string[]; invoicePayment: string[]; salesReturn: string[]; oldGoldExchange: string[] } = {
    salesInvoice: [], invoicePayment: [], salesReturn: [], oldGoldExchange: [],
  };

  beforeAll(async () => {
    tenant = await createTestTenant(`DAYBOOK${suffix}`, []);

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-DAYBOOK-${suffix}`, name: 'Day-book Test Client', type: 'RETAIL' },
    });
    clientId = client.id;

    const invoice = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId: tenant.branch.id,
        invoiceNumber: `TSTINV-DAYBOOK-${suffix}`, clientId, invoiceDate: targetDate,
        invoiceType: 'RETAIL', subtotal: 20000, totalAmount: 20000, balanceDue: 10000, status: 'PARTIALLY_PAID',
      },
    });
    invoiceId = invoice.id;
    otherIds.salesInvoice.push(invoice.id);

    // Outside-the-day invoice — proves the date filter actually excludes it.
    const outside = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId: tenant.branch.id,
        invoiceNumber: `TSTINV-DAYBOOK-OUT-${suffix}`, clientId, invoiceDate: outsideDate,
        invoiceType: 'RETAIL', subtotal: 99999, totalAmount: 99999, balanceDue: 99999, status: 'ISSUED',
      },
    });
    otherIds.salesInvoice.push(outside.id);

    const [cashPmt, upiPmt] = await Promise.all([
      prisma.invoicePayment.create({
        data: { companyId: tenant.company.id, paymentNumber: `TSTPMT-DAYBOOK-CASH-${suffix}`, clientId, invoiceId, paymentDate: targetDate, amount: 6000, mode: 'CASH' },
      }),
      prisma.invoicePayment.create({
        data: { companyId: tenant.company.id, paymentNumber: `TSTPMT-DAYBOOK-UPI-${suffix}`, clientId, invoiceId, paymentDate: targetDate, amount: 4000, mode: 'UPI' },
      }),
    ]);
    otherIds.invoicePayment.push(cashPmt.id, upiPmt.id);

    const ret = await prisma.salesReturn.create({
      data: { companyId: tenant.company.id, returnNumber: `TSTRTN-DAYBOOK-${suffix}`, invoiceId, clientId, returnDate: targetDate, totalAmount: 2000 },
    });
    otherIds.salesReturn.push(ret.id);

    const exg = await prisma.oldGoldExchange.create({
      data: {
        companyId: tenant.company.id,
        exchangeNumber: `TSTEXG-DAYBOOK-${suffix}`, clientId, exchangeDate: targetDate,
        description: 'Old chain', karat: '22K', grossWeight: 4, netWeight: 4, ratePerGram: 6000, valuedAmount: 24000,
      },
    });
    otherIds.oldGoldExchange.push(exg.id);
  });

  afterAll(async () => {
    await prisma.oldGoldExchange.deleteMany({ where: { id: { in: otherIds.oldGoldExchange } } });
    await prisma.salesReturn.deleteMany({ where: { id: { in: otherIds.salesReturn } } });
    await prisma.invoicePayment.deleteMany({ where: { id: { in: otherIds.invoicePayment } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: otherIds.salesInvoice } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('rolls up sales, payments (by mode), returns, and exchanges for exactly one day', async () => {
    const result = await getDayBook(tenant.company.id, targetDate);

    expect(result.sales.count).toBe(1);
    expect(result.sales.totalAmount).toBeCloseTo(20000);

    expect(result.payments.count).toBe(2);
    expect(result.payments.total).toBeCloseTo(10000);
    const cashMode = result.payments.byMode.find((m) => m.mode === 'CASH')!;
    expect(cashMode.total).toBeCloseTo(6000);

    expect(result.returns.count).toBe(1);
    expect(result.returns.totalAmount).toBeCloseTo(2000);

    expect(result.exchanges.count).toBe(1);
    expect(result.exchanges.totalAmount).toBeCloseTo(24000);
  });

  it('excludes activity outside the target day', async () => {
    const result = await getDayBook(tenant.company.id, targetDate);
    expect(result.sales.rows.some((r) => r.amount === 99999)).toBe(false);
  });

  // J3.5 Finding 1: a voided invoice keeps its original invoiceDate — without this exclusion it
  // would inflate this day's sales total forever, however long after this day it was voided.
  it('excludes a VOID invoice from the sales rollup', async () => {
    const voided = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId: tenant.branch.id,
        invoiceNumber: `TSTINV-DAYBOOK-${suffix}-void`, clientId, invoiceDate: targetDate,
        invoiceType: 'RETAIL', subtotal: 55555, totalAmount: 55555, balanceDue: 55555, status: 'VOID',
      },
    });
    otherIds.salesInvoice.push(voided.id);

    const result = await getDayBook(tenant.company.id, targetDate);
    expect(result.sales.count).toBe(1); // unchanged — still just the one active invoice
    expect(result.sales.totalAmount).toBeCloseTo(20000);
    expect(result.sales.rows.some((r) => r.amount === 55555)).toBe(false);
  });
});

// H5: GST HSN-wise summary for a period. Uses real createInvoice() runs (not direct rows) because
// this report reads InvoiceItem.hsnCodeId/taxRate and TaxInvoice.igst, which only a real invoice
// creation populates correctly.
describe('getGstSummary (H5)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const invoiceDate = new Date('2026-05-15T00:00:00Z');

  let tenant: TestTenant;
  let userId: string;
  let intraClientId: string;
  let interClientId: string;
  let altHsnId: string;
  const invoiceIds: string[] = [];

  function baseItem(overrides: Record<string, any> = {}) {
    return {
      productCode: 'MISC', description: 'Test line', quantity: 1,
      grossWeight: 10, netGoldWeight: 10, rateType: 'PER_GRAM',
      goldRate: 5000, makingCharge: 0,
      ...overrides,
    };
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`GST${suffix}`, ['invoice:create']);
    userId = tenant.user.id;

    const [intraClient, interClient] = await Promise.all([
      prisma.client.create({ data: { companyId: tenant.company.id, clientCode: `TSTCL-GST-INTRA-${suffix}`, name: 'Intra Client', type: 'RETAIL', state: 'Gujarat' } }),
      prisma.client.create({ data: { companyId: tenant.company.id, clientCode: `TSTCL-GST-INTER-${suffix}`, name: 'Inter Client', type: 'RETAIL', state: 'Maharashtra' } }),
    ]);
    intraClientId = intraClient.id;
    interClientId = interClient.id;

    const altHsn = await prisma.hsnCode.create({
      data: { code: `TSTHSN-${suffix}`, description: 'Test alt HSN', gstRate: 0.05, isActive: true },
    });
    altHsnId = altHsn.id;
  });

  afterAll(async () => {
    await cleanupJournalEntries(invoiceIds);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    // NB: guarded — Prisma treats `where: { id: undefined }` as NO filter, so if the create above ever
    // failed this would otherwise delete EVERY HSN code (platform reference data every test relies on).
    if (altHsnId) await prisma.hsnCode.deleteMany({ where: { id: altHsnId } });
    await prisma.client.deleteMany({ where: { id: { in: [intraClientId, interClientId] } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  it('splits intra-state tax into CGST+SGST and groups by HSN + rate', async () => {
    const invoice = await createInvoice(
      { clientId: intraClientId, invoiceDate, invoiceType: 'RETAIL', branchId: tenant.branch.id, items: [baseItem()] },
      tenant.ctx, userId
    );
    invoiceIds.push(invoice.id);

    const result = await getGstSummary(tenant.company.id, new Date('2026-05-01'), new Date('2026-05-31'));
    const row = result.rows.find((r) => r.hsnCode === '7113' && r.taxRate === 0.03)!;
    expect(row.igst).toBe(0);
    expect(row.cgst).toBeGreaterThan(0);
    expect(row.sgst).toBeCloseTo(row.cgst);
  });

  it('puts inter-state tax entirely into IGST', async () => {
    const invoice = await createInvoice(
      { clientId: interClientId, invoiceDate, invoiceType: 'RETAIL', branchId: tenant.branch.id, items: [baseItem()] },
      tenant.ctx, userId
    );
    invoiceIds.push(invoice.id);

    const result = await getGstSummary(tenant.company.id, new Date('2026-05-01'), new Date('2026-05-31'));
    const row = result.rows.find((r) => r.hsnCode === '7113' && r.taxRate === 0.03)!;
    expect(row.igst).toBeGreaterThan(0);
  });

  it('keeps a different HSN/rate in its own group', async () => {
    const invoice = await createInvoice(
      { clientId: intraClientId, invoiceDate, invoiceType: 'RETAIL', branchId: tenant.branch.id, items: [baseItem()] },
      tenant.ctx, userId
    );
    invoiceIds.push(invoice.id);

    const altInvoice = await createInvoice(
      {
        clientId: intraClientId, invoiceDate, invoiceType: 'RETAIL', branchId: tenant.branch.id,
        items: [baseItem({ hsnCode: `TSTHSN-${suffix}` })],
      },
      tenant.ctx, userId
    );
    invoiceIds.push(altInvoice.id);

    const result = await getGstSummary(tenant.company.id, new Date('2026-05-01'), new Date('2026-05-31'));
    const altRow = result.rows.find((r) => r.hsnCode === `TSTHSN-${suffix}`)!;
    expect(altRow.taxRate).toBeCloseTo(0.05);
    expect(altRow.taxableValue).toBeGreaterThan(0);
  });

  // J3.5 Finding 1: a voided invoice's lines were never actually a taxable sale — this uses the
  // real voidInvoice() flow (not a direct row edit) to prove the end-to-end interaction, not just
  // the query's own status filter in isolation.
  it('excludes a voided invoice\'s lines from the GST summary', async () => {
    const before = await getGstSummary(tenant.company.id, new Date('2026-05-01'), new Date('2026-05-31'));
    const taxableBefore = before.rows.find((r) => r.hsnCode === '7113' && r.taxRate === 0.03)!.taxableValue;

    const invoice = await createInvoice(
      { clientId: intraClientId, invoiceDate, invoiceType: 'RETAIL', branchId: tenant.branch.id, items: [baseItem()] },
      tenant.ctx, userId
    );
    invoiceIds.push(invoice.id);

    const afterCreate = await getGstSummary(tenant.company.id, new Date('2026-05-01'), new Date('2026-05-31'));
    const taxableAfterCreate = afterCreate.rows.find((r) => r.hsnCode === '7113' && r.taxRate === 0.03)!.taxableValue;
    expect(taxableAfterCreate).toBeGreaterThan(taxableBefore); // sanity: the fresh invoice did contribute

    await voidInvoice(invoice.id, tenant.ctx, userId, 'test reason');

    const afterVoid = await getGstSummary(tenant.company.id, new Date('2026-05-01'), new Date('2026-05-31'));
    const taxableAfterVoid = afterVoid.rows.find((r) => r.hsnCode === '7113' && r.taxRate === 0.03)?.taxableValue ?? 0;
    expect(taxableAfterVoid).toBeCloseTo(taxableBefore); // back to what it was before this invoice existed
  });
});
