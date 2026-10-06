import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { getDealerAging, getClientLedger, getDayBook, getGstSummary, getPurchaseGstSummary } from './finance.service';
import { createInvoice, voidInvoice, createSalesReturn } from '../sales/sales.service';
import { createStandaloneCreditNote, cancelCreditNote } from '../sales/creditNote.service';
import { createGstRegistration } from '../company/company.service';
import { cleanupJournalEntries } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../test/fixtures';
import { tenantQuery } from '../../shared/tenantContext';

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
    await prisma.repairCase.deleteMany({ where: { salesReturnItem: { return: { clientId } } } }); // returned-jewellery register rows reference the return lines
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
    await prisma.repairCase.deleteMany({ where: { salesReturnItem: { return: { id: { in: otherIds.salesReturn } } } } }); // returned-jewellery register rows reference the return lines
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

// G2c follow-up: a standalone Credit Note (Path B) is a fifth table that moves Client.currentBalance
// which getClientLedger/getDayBook did not know about when G2c shipped — this closes that reporting
// gap. Real createInvoice/createSalesReturn/createStandaloneCreditNote/cancelCreditNote runs (not
// direct rows) because the point of these tests IS the currentBalance side effect each one produces,
// and only the real services move that column correctly.
describe('Credit Note reporting (G2c follow-up: getClientLedger / getDayBook)', () => {
  const suffix = `cnrep-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let clientId: string;
  const invoiceIds: string[] = [];
  const salesReturnIds: string[] = [];
  const creditNoteIds: string[] = [];
  const tagIds: string[] = [];

  async function makeTag(price: number) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-${suffix}-${tagIds.length}`, companyId: tenant.company.id, branchId,
        name: 'Ring', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, stoneWeight: 0,
        costPrice: price * 0.8, sellingPrice: price, createdById: userId,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }

  // A single-line, FIXED-rate, same-state (client.state = Gujarat = company stateCode '24') INR
  // sale — a clean, predictable 3% CGST+SGST split (DEFAULT_HSN_CODE), same fixture shape as
  // creditNote.service.test.ts's own makeSoldInvoice.
  async function makeSoldInvoice(price: number) {
    const tag = await makeTag(price);
    const invoice = await createInvoice({
      branchId, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: price, tagId: tag.id }],
    }, tenant.ctx, userId);
    invoiceIds.push(invoice.id);
    return invoice;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(suffix, [
      'invoice:create', 'return:create', 'creditNote:view', 'creditNote:create', 'creditNote:cancel',
    ]);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${suffix}`, name: 'CN Report Client', type: 'RETAIL', state: 'Gujarat' },
    });
    clientId = client.id;
  });

  afterAll(async () => {
    // CreditNote/CreditNoteItem are FORCE-RLS tables in this single-role test DB (same note as
    // creditNote.service.test.ts) — a bare deleteMany silently matches zero rows here.
    await tenantQuery(tenant.company.id, (tx) => tx.creditNote.deleteMany({ where: { companyId: tenant.company.id } }));

    await cleanupJournalEntries([...invoiceIds, ...salesReturnIds, ...creditNoteIds]);
    await prisma.repairCase.deleteMany({ where: { salesReturnItem: { return: { invoiceId: { in: invoiceIds } } } } }); // returned-jewellery register rows reference the return lines
    await prisma.salesReturn.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  // Test A
  it('getClientLedger includes an active standalone Credit Note and reconciles to currentBalance', async () => {
    const invoice = await makeSoldInvoice(10000);
    const balanceAfterInvoice = Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance);

    const cn = await createStandaloneCreditNote(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 1030 }], reasonCode: 'POST_SALE_DISCOUNT' },
      tenant.ctx, userId,
    );
    creditNoteIds.push(cn.id);

    const clientAfterCn = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(Number(clientAfterCn.currentBalance)).toBeCloseTo(balanceAfterInvoice - 1030, 2);

    const ledger = await getClientLedger(tenant.ctx, clientId);
    const cnRow = ledger.rows.find((r) => r.refNumber === cn.creditNoteNumber);
    expect(cnRow).toBeTruthy();
    expect(cnRow!.type).toBe('CREDIT_NOTE');
    expect(cnRow!.debit).toBe(0);
    expect(cnRow!.credit).toBeCloseTo(1030, 2);
    expect(ledger.closingBalance).toBeCloseTo(Number(clientAfterCn.currentBalance), 2);
  });

  // Test B
  it('cancelling a standalone Credit Note restores currentBalance and drops it from the active ledger', async () => {
    const invoice = await makeSoldInvoice(5000);
    const cn = await createStandaloneCreditNote(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 515 }], reasonCode: 'POST_SALE_DISCOUNT' },
      tenant.ctx, userId,
    );
    creditNoteIds.push(cn.id);
    const balanceBeforeCancel = Number((await prisma.client.findUniqueOrThrow({ where: { id: clientId } })).currentBalance);

    await cancelCreditNote(cn.id, tenant.ctx, userId, 'Issued in error');

    const clientAfterCancel = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(Number(clientAfterCancel.currentBalance)).toBeCloseTo(balanceBeforeCancel + 515, 2);

    const ledger = await getClientLedger(tenant.ctx, clientId);
    expect(ledger.rows.some((r) => r.refNumber === cn.creditNoteNumber)).toBe(false);
    expect(ledger.closingBalance).toBeCloseTo(Number(clientAfterCancel.currentBalance), 2);
  });

  // Test C
  it('does not double-count a return-linked (Path A) Credit Note — only the SalesReturn row appears', async () => {
    const invoice = await makeSoldInvoice(6000);
    const result = await createSalesReturn(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }], reason: 'Damaged' },
      tenant.ctx, userId, { issueCreditNote: true },
    );
    salesReturnIds.push(result.id);
    expect(result.creditNote).toBeTruthy();
    creditNoteIds.push(result.creditNote!.id);

    const ledger = await getClientLedger(tenant.ctx, clientId);
    const returnRow = ledger.rows.find((r) => r.refNumber === result.returnNumber);
    expect(returnRow).toBeTruthy();
    expect(returnRow!.type).toBe('RETURN');

    // The linked credit note must not create a second, separate ledger event.
    expect(ledger.rows.some((r) => r.refNumber === result.creditNote!.creditNoteNumber)).toBe(false);

    const client = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
    expect(ledger.closingBalance).toBeCloseTo(Number(client.currentBalance), 2);
  });

  // Test D
  it('getDayBook includes an active standalone Credit Note, excludes a cancelled one, and does not duplicate a return-linked one', async () => {
    const today = new Date();

    const inv1 = await makeSoldInvoice(4000);
    const activeCn = await createStandaloneCreditNote(
      { invoiceId: inv1.id, items: [{ invoiceItemId: inv1.items[0].id, amount: 412 }], reasonCode: 'POST_SALE_DISCOUNT' },
      tenant.ctx, userId,
    );
    creditNoteIds.push(activeCn.id);

    const inv2 = await makeSoldInvoice(3000);
    const cancelledCn = await createStandaloneCreditNote(
      { invoiceId: inv2.id, items: [{ invoiceItemId: inv2.items[0].id, amount: 309 }], reasonCode: 'POST_SALE_DISCOUNT' },
      tenant.ctx, userId,
    );
    creditNoteIds.push(cancelledCn.id);
    await cancelCreditNote(cancelledCn.id, tenant.ctx, userId, 'Issued in error');

    const inv3 = await makeSoldInvoice(2000);
    const returnResult = await createSalesReturn(
      { invoiceId: inv3.id, items: [{ invoiceItemId: inv3.items[0].id }], reason: 'Damaged' },
      tenant.ctx, userId, { issueCreditNote: true },
    );
    salesReturnIds.push(returnResult.id);
    creditNoteIds.push(returnResult.creditNote!.id);

    const dayBook = await getDayBook(tenant.company.id, today);

    expect(dayBook.creditNotes.rows.some((r) => r.creditNoteNumber === activeCn.creditNoteNumber)).toBe(true);
    expect(dayBook.creditNotes.rows.some((r) => r.creditNoteNumber === cancelledCn.creditNoteNumber)).toBe(false);
    expect(dayBook.creditNotes.rows.some((r) => r.creditNoteNumber === returnResult.creditNote!.creditNoteNumber)).toBe(false);
    // The return-linked note's value is represented once, via the SalesReturn row, not the credit-note rollup.
    expect(dayBook.returns.rows.some((r) => r.returnNumber === returnResult.returnNumber)).toBe(true);
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
  // G2g-1: Sales Return / Credit Note netting fixtures — a wide date range (returnDate/
  // creditNoteDate default to real now(), unlike invoiceDate above which these tests fully
  // control) plus a dedicated HSN code per scenario so each test's bucket is isolated from every
  // other test's accumulating activity in this shared describe block.
  const wideFrom = new Date('2020-01-01');
  const wideTo = new Date('2030-12-31');
  const tagIds: string[] = [];
  const salesReturnIds: string[] = [];
  const creditNoteIds: string[] = [];
  const extraHsnIds: string[] = [];

  function baseItem(overrides: Record<string, any> = {}) {
    return {
      productCode: 'MISC', description: 'Test line', quantity: 1,
      grossWeight: 10, netGoldWeight: 10, rateType: 'PER_GRAM',
      goldRate: 5000, makingCharge: 0,
      ...overrides,
    };
  }

  async function makeTag(price: number) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-GST-${suffix}-${tagIds.length}`, companyId: tenant.company.id, branchId: tenant.branch.id,
        name: 'Ring', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, stoneWeight: 0,
        costPrice: price * 0.8, sellingPrice: price, createdById: userId,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }

  // A single-line, FIXED-rate, tagged, same-state (intraClientId = Gujarat = company stateCode
  // '24') INR sale under its own HSN code — the shape createSalesReturn/createStandaloneCreditNote
  // both need (a real tag to flip, a real InvoiceItem to credit).
  async function makeSoldInvoice(price: number, hsnCode: string) {
    const tag = await makeTag(price);
    const invoice = await createInvoice({
      branchId: tenant.branch.id, clientId: intraClientId, invoiceDate, invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: price, tagId: tag.id, hsnCode }],
    }, tenant.ctx, userId);
    invoiceIds.push(invoice.id);
    return invoice;
  }

  async function makeHsn(code: string) {
    const hsn = await prisma.hsnCode.create({ data: { code, description: `Test HSN ${code}`, gstRate: 0.03, isActive: true } });
    extraHsnIds.push(hsn.id);
    return hsn.code;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`GST${suffix}`, ['invoice:create', 'return:create', 'creditNote:create', 'creditNote:cancel']);
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
    // CreditNote/CreditNoteItem are FORCE-RLS tables in this single-role test DB (same note as
    // creditNote.service.test.ts) — a bare deleteMany silently matches zero rows here.
    await tenantQuery(tenant.company.id, (tx) => tx.creditNote.deleteMany({ where: { companyId: tenant.company.id } }));
    await cleanupJournalEntries([...invoiceIds, ...salesReturnIds, ...creditNoteIds]);
    await prisma.repairCase.deleteMany({ where: { salesReturnItem: { return: { invoiceId: { in: invoiceIds } } } } }); // returned-jewellery register rows reference the return lines
    await prisma.salesReturn.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    // NB: guarded — Prisma treats `where: { id: undefined }` as NO filter, so if the create above ever
    // failed this would otherwise delete EVERY HSN code (platform reference data every test relies on).
    if (altHsnId) await prisma.hsnCode.deleteMany({ where: { id: altHsnId } });
    if (extraHsnIds.length > 0) await prisma.hsnCode.deleteMany({ where: { id: { in: extraHsnIds } } });
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

  // G2g-1: the engine must read InvoiceItem's own persisted G1-Part-D snapshot
  // (taxableValue/cgstAmount/sgstAmount) rather than recomputing totalPrice * taxRate. A raw row
  // with a deliberately mismatched totalPrice (100000) vs. taxableValue (1000) makes the two
  // approaches diverge by two orders of magnitude — if the summary ever regresses to the old
  // recalculation, this fails loudly instead of by a rounding-sized margin.
  it('uses the invoice item\'s persisted tax snapshot, not a totalPrice * taxRate recalculation', async () => {
    const rawInvoice = await prisma.salesInvoice.create({
      data: {
        companyId: tenant.company.id, branchId: tenant.branch.id,
        invoiceNumber: `TSTINV-GST-RAW-${suffix}`,
        clientId: intraClientId, invoiceDate, invoiceType: 'RETAIL',
        subtotal: 100000, totalAmount: 100000, balanceDue: 0, taxAmount: 30, status: 'PAID',
      },
    });
    invoiceIds.push(rawInvoice.id);

    await prisma.invoiceItem.create({
      data: {
        companyId: tenant.company.id, invoiceId: rawInvoice.id,
        productCode: 'RAW', description: 'Persisted-snapshot test line', quantity: 1,
        grossWeight: 10, netGoldWeight: 10, stoneWeight: 0,
        rateType: 'FIXED', goldRate: 100000, makingCharge: 0, wastagePercent: 0, stoneValue: 0,
        unitPrice: 100000, totalPrice: 100000,
        taxRate: 0.11, taxableValue: 1000, lineDiscountAmount: 0,
        cgstAmount: 15, sgstAmount: 15, igstAmount: 0, lineTotalTax: 30,
      },
    });
    await prisma.taxInvoice.create({
      data: {
        companyId: tenant.company.id, invoiceId: rawInvoice.id,
        gstin: 'TESTGSTIN', placeOfSupply: '24',
        taxableAmount: 1000, cgst: 15, sgst: 15, igst: 0, totalTax: 30,
      },
    });

    const result = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const row = result.rows.find((r) => r.hsnCode === 'UNKNOWN' && r.taxRate === 0.11)!;
    expect(row).toBeTruthy();
    expect(row.taxableValue).toBeCloseTo(1000, 2);
    expect(row.cgst).toBeCloseTo(15, 2);
    expect(row.sgst).toBeCloseTo(15, 2);
    // Sanity: the old (wrong) formula would have reported taxableValue = totalPrice = 100000.
    expect(row.taxableValue).toBeLessThan(100000);
  });

  // G2g-1 #2: an invoice-level discount is already folded into each line's persisted
  // taxableValue/lineTotalTax at sale time (G1 Part D's allocateLineTax) — the summary must read
  // that discount-scaled snapshot, never the undiscounted totalPrice * taxRate.
  it('an invoice-level discount does not cause the GST summary to overstate tax', async () => {
    const discHsnCode = await makeHsn(`TSTHSN-DISC-${suffix}`);
    const invoice = await createInvoice(
      {
        clientId: intraClientId, invoiceDate, invoiceType: 'RETAIL', branchId: tenant.branch.id,
        discountAmount: 2000,
        items: [baseItem({ hsnCode: discHsnCode })],
      },
      tenant.ctx, userId
    );
    invoiceIds.push(invoice.id);

    const result = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const row = result.rows.find((r) => r.hsnCode === discHsnCode)!;
    const totalTax = row.cgst + row.sgst + row.igst;

    // Matches the invoice's own persisted, discount-scaled tax exactly...
    expect(totalTax).toBeCloseTo(Number(invoice.taxAmount), 2);
    // ...and is strictly less than what the undiscounted subtotal * rate would have produced.
    expect(totalTax).toBeLessThan(Number(invoice.subtotal) * 0.03);
  });

  // G2g-1 #3/#4: a Sales Return reverses the GST/taxable value its own returned line originally
  // contributed, and — since this invoice's only line is fully returned — nets back to exactly
  // zero: proof it's deducted exactly once (not partially, not doubly).
  it('a Sales Return reduces taxable value/GST for its own line, deducted exactly once', async () => {
    const returnHsnCode = await makeHsn(`TSTHSN-RET-${suffix}`);
    const invoice = await makeSoldInvoice(10000, returnHsnCode);

    const afterSale = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const rowAfterSale = afterSale.rows.find((r) => r.hsnCode === returnHsnCode)!;
    expect(rowAfterSale.taxableValue).toBeGreaterThan(0);

    const ret = await createSalesReturn(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }], reason: 'Wrong size' },
      tenant.ctx, userId,
    );
    salesReturnIds.push(ret.id);

    const afterReturn = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const rowAfterReturn = afterReturn.rows.find((r) => r.hsnCode === returnHsnCode)!;
    expect(rowAfterReturn.taxableValue).toBeCloseTo(0, 2);
    expect(rowAfterReturn.cgst + rowAfterReturn.sgst + rowAfterReturn.igst).toBeCloseTo(0, 2);
  });

  // G2g-1 #5: a Path A (return-linked) Credit Note must NOT be separately subtracted on top of its
  // own SalesReturn's reversal — the net effect of a fully-returned line must still be exactly
  // zero, not negative (which would prove double-deduction).
  it('a Sales Return with a Path A (return-linked) Credit Note is still deducted exactly once', async () => {
    const returnCnHsnCode = await makeHsn(`TSTHSN-RETCN-${suffix}`);
    const invoice = await makeSoldInvoice(8000, returnCnHsnCode);

    const ret = await createSalesReturn(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }], reason: 'Damaged' },
      tenant.ctx, userId, { issueCreditNote: true },
    );
    salesReturnIds.push(ret.id);
    expect(ret.creditNote).toBeTruthy();
    creditNoteIds.push(ret.creditNote!.id);

    const result = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const row = result.rows.find((r) => r.hsnCode === returnCnHsnCode)!;
    expect(row.taxableValue).toBeCloseTo(0, 2);
    expect(row.cgst + row.sgst + row.igst).toBeCloseTo(0, 2);
  });

  // G2g-1 #6: a standalone (Path B) Credit Note — no SalesReturn behind it — nets its own persisted
  // taxableValue/cgstAmount/sgstAmount off the invoice's contribution.
  it('a standalone (Path B) Credit Note reduces taxable value and GST', async () => {
    const cnHsnCode = await makeHsn(`TSTHSN-CNB-${suffix}`);
    const invoice = await makeSoldInvoice(6000, cnHsnCode);

    const beforeCn = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const rowBeforeCn = beforeCn.rows.find((r) => r.hsnCode === cnHsnCode)!;

    const cn = await createStandaloneCreditNote(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 618 }], reasonCode: 'POST_SALE_DISCOUNT' },
      tenant.ctx, userId,
    );
    creditNoteIds.push(cn.id);

    const afterCn = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const rowAfterCn = afterCn.rows.find((r) => r.hsnCode === cnHsnCode)!;

    expect(rowAfterCn.taxableValue).toBeLessThan(rowBeforeCn.taxableValue);
    expect(rowAfterCn.cgst + rowAfterCn.sgst).toBeLessThan(rowBeforeCn.cgst + rowBeforeCn.sgst);
    // Nets exactly by the credit note's own persisted taxableAmount/totalTax.
    expect(rowBeforeCn.taxableValue - rowAfterCn.taxableValue).toBeCloseTo(Number(cn.taxableAmount), 2);
  });

  // G2g-1 #7: a CANCELLED standalone Credit Note's reversal was already undone at cancellation
  // (cancelCreditNote posts the exact inverse journal + restores currentBalance) — it must not
  // also net anything out of the GST summary.
  it('a cancelled standalone Credit Note is excluded from the GST summary', async () => {
    const cnHsnCode = await makeHsn(`TSTHSN-CNCANCEL-${suffix}`);
    const invoice = await makeSoldInvoice(4000, cnHsnCode);

    const beforeCn = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const rowBeforeCn = beforeCn.rows.find((r) => r.hsnCode === cnHsnCode)!;

    const cn = await createStandaloneCreditNote(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 412 }], reasonCode: 'POST_SALE_DISCOUNT' },
      tenant.ctx, userId,
    );
    creditNoteIds.push(cn.id);

    const afterCn = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const rowAfterCn = afterCn.rows.find((r) => r.hsnCode === cnHsnCode)!;
    expect(rowAfterCn.taxableValue).toBeLessThan(rowBeforeCn.taxableValue);

    await cancelCreditNote(cn.id, tenant.ctx, userId, 'Issued in error');

    const afterCancel = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const rowAfterCancel = afterCancel.rows.find((r) => r.hsnCode === cnHsnCode)!;
    expect(rowAfterCancel.taxableValue).toBeCloseTo(rowBeforeCn.taxableValue, 2);
  });

  // G2g-1 #8: two standalone Credit Notes against the same invoice both net off, additively —
  // proof the deduction isn't capped at "one credit note per invoice" or overwritten by the second.
  it('multiple standalone Credit Notes against one invoice net correctly', async () => {
    const cnHsnCode = await makeHsn(`TSTHSN-CNMULTI-${suffix}`);
    const invoice = await makeSoldInvoice(20000, cnHsnCode);

    const before = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const rowBefore = before.rows.find((r) => r.hsnCode === cnHsnCode)!;

    // Amounts follow the same ~10.3% convention already proven elsewhere in this suite (e.g. the
    // "Credit Note reporting" describe block's 1030/10000, 515/5000) — a round 1000 against a 3%
    // rate hits an unrelated, pre-existing penny-rounding edge case in buildLineFromInvoiceItem's
    // journal balance check (frozen G2c code, not in scope for G2g-1).
    const cn1 = await createStandaloneCreditNote(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 2060 }], reasonCode: 'POST_SALE_DISCOUNT' },
      tenant.ctx, userId,
    );
    creditNoteIds.push(cn1.id);
    const cn2 = await createStandaloneCreditNote(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 1030 }], reasonCode: 'POST_SALE_DISCOUNT' },
      tenant.ctx, userId,
    );
    creditNoteIds.push(cn2.id);

    const after = await getGstSummary(tenant.company.id, wideFrom, wideTo);
    const rowAfter = after.rows.find((r) => r.hsnCode === cnHsnCode)!;

    const expectedTaxable = rowBefore.taxableValue - Number(cn1.taxableAmount) - Number(cn2.taxableAmount);
    expect(rowAfter.taxableValue).toBeCloseTo(expectedTaxable, 2);
  });

  // G2g-1 #12: company-scoped tenant isolation — a second company's invoice must never appear in
  // this company's summary, and must appear in its own.
  it('keeps company-scoped tenant isolation for GST reporting', async () => {
    const isoHsnCode = `TSTHSN-ISO-${suffix}`;
    const otherTenant = await createTestTenant(`GSTISO${suffix}`, ['invoice:create']);
    try {
      const otherClient = await prisma.client.create({
        data: { companyId: otherTenant.company.id, clientCode: `TSTCL-ISO-${suffix}`, name: 'Other Co Client', type: 'RETAIL', state: 'Gujarat' },
      });
      const otherHsn = await prisma.hsnCode.create({ data: { code: isoHsnCode, description: 'Isolation test HSN', gstRate: 0.03, isActive: true } });
      let otherInvoiceId: string | null = null;
      try {
        const otherInvoice = await createInvoice(
          { clientId: otherClient.id, invoiceDate, invoiceType: 'RETAIL', branchId: otherTenant.branch.id, items: [baseItem({ hsnCode: isoHsnCode })] },
          otherTenant.ctx, otherTenant.user.id,
        );
        otherInvoiceId = otherInvoice.id;

        const ownSummary = await getGstSummary(tenant.company.id, wideFrom, wideTo);
        expect(ownSummary.rows.some((r) => r.hsnCode === isoHsnCode)).toBe(false);

        const otherSummary = await getGstSummary(otherTenant.company.id, wideFrom, wideTo);
        expect(otherSummary.rows.some((r) => r.hsnCode === isoHsnCode)).toBe(true);
      } finally {
        if (otherInvoiceId) {
          await cleanupJournalEntries([otherInvoiceId]);
          await prisma.taxInvoice.deleteMany({ where: { invoiceId: otherInvoiceId } });
          await prisma.salesInvoice.deleteMany({ where: { id: otherInvoiceId } });
        }
        await prisma.hsnCode.deleteMany({ where: { id: otherHsn.id } });
        await prisma.client.deleteMany({ where: { id: otherClient.id } });
      }
    } finally {
      await cleanupTestTenant(otherTenant);
    }
  });

  // G2g-4a.2: SalesInvoice.otherCharges reconciliation.
  it('reconciliation is null when no invoice in the period carries otherCharges', async () => {
    const result = await getGstSummary(tenant.company.id, new Date('2026-05-01'), new Date('2026-05-31'));
    // Every other test in this block creates its own invoice with otherCharges defaulting to 0 —
    // proves the diagnostic stays silent (no false positive) absent a real reconciliation gap.
    expect(result.reconciliation).toBeNull();
  });

  it('an invoice with otherCharges is excluded from the HSN rows/totals but surfaces an explicit OTHER_CHARGES_NOT_REPRESENTED diagnostic, never a fabricated HSN row', async () => {
    const before = await getGstSummary(tenant.company.id, new Date('2026-05-01'), new Date('2026-05-31'));
    const rowBefore = before.rows.find((r) => r.hsnCode === '7113' && r.taxRate === 0.03);
    const taxableBefore = rowBefore?.taxableValue ?? 0;
    const taxBefore = (rowBefore?.cgst ?? 0) + (rowBefore?.sgst ?? 0) + (rowBefore?.igst ?? 0);
    const rowCountBefore = before.rows.length;

    // baseItem(): netGoldWeight 10 * goldRate 5000 = totalPrice 50,000, taxed at 7113's 3% = 1,500.
    // otherCharges 1,000 is taxed separately (also at the 3% default HSN rate, per priceInvoice())
    // = 30 — that ₹30 has no InvoiceItem/HSN line of its own.
    const invoice = await createInvoice(
      {
        clientId: intraClientId, invoiceDate, invoiceType: 'RETAIL', branchId: tenant.branch.id,
        items: [baseItem()], otherCharges: 1000,
      },
      tenant.ctx, userId,
    );
    invoiceIds.push(invoice.id);
    expect(Number(invoice.otherCharges)).toBe(1000);

    const after = await getGstSummary(tenant.company.id, new Date('2026-05-01'), new Date('2026-05-31'));
    const rowAfter = after.rows.find((r) => r.hsnCode === '7113' && r.taxRate === 0.03)!;
    const taxAfter = rowAfter.cgst + rowAfter.sgst + rowAfter.igst;

    // The line itself (50,000 taxable / 1,500 tax) is fully represented...
    expect(rowAfter.taxableValue).toBeCloseTo(taxableBefore + 50_000, 2);
    expect(taxAfter).toBeCloseTo(taxBefore + 1_500, 2);
    // ...but otherCharges (1,000 taxable / 30 tax) never silently inflates that same HSN row, and
    // never fabricates a new one — the row/rate bucket count is unchanged by this invoice alone.
    expect(after.rows.length).toBe(rowCountBefore);

    // The reconciliation diagnostic makes the excluded amount explicit instead of a silent gap.
    expect(after.reconciliation).not.toBeNull();
    expect(after.reconciliation!.diagnostic).toBe('OTHER_CHARGES_NOT_REPRESENTED');
    expect(after.reconciliation!.otherChargesTaxableValue).toBeGreaterThanOrEqual(1_000);
    expect(after.reconciliation!.otherChargesTax).toBeGreaterThanOrEqual(30);

    // Mathematical consistency: rows.taxableValue (line-only) + reconciliation.otherChargesTaxableValue
    // reconstructs the true combined taxable base this invoice added — nothing double-counted,
    // nothing missing, across the two figures together.
    expect(
      (after.totals.taxableValue + after.reconciliation!.otherChargesTaxableValue) -
      (before.totals.taxableValue + (before.reconciliation?.otherChargesTaxableValue ?? 0)),
    ).toBeCloseTo(50_000 + 1_000, 2);
  });
});

// G2g-2: gstRegistrationId filtering (sales side) + server-side branch access enforcement, for
// both getGstSummary and getPurchaseGstSummary. A separate tenant/describe block from the H5 one
// above so its own second branch + GST registrations can't interact with any of that block's
// company-wide totals.
describe('getGstSummary — G2g-2 registration + branch filtering', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const invoiceDate = new Date('2026-06-15T00:00:00Z');
  const wideFrom = new Date('2020-01-01');
  const wideTo = new Date('2030-12-31');

  let tenant: TestTenant;
  let userId: string;
  let clientId: string;
  let branch2Id: string;
  let regAId: string;
  let regBId: string;
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];
  const creditNoteIds: string[] = [];
  const salesReturnIds: string[] = [];
  const hsnCodes: string[] = [];

  async function makeHsn(code: string) {
    await prisma.hsnCode.create({ data: { code, description: `G2g-2 test ${code}`, gstRate: 0.03, isActive: true } });
    hsnCodes.push(code);
    return code;
  }

  async function makeTag(branchId: string, price: number) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-GSTFLT-${suffix}-${tagIds.length}`, companyId: tenant.company.id, branchId,
        name: 'Ring', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, stoneWeight: 0,
        costPrice: price * 0.8, sellingPrice: price, createdById: userId,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }

  // A single-line, FIXED-rate, tagged, same-state (client is in Gujarat = both branches' home
  // state) INR sale at the given branch, under its own HSN — same shape as the H5 block's
  // makeSoldInvoice, but branch-parameterized so a line can be placed at either registration.
  async function makeInvoiceAt(branchId: string, price: number, hsnCode: string) {
    const tag = await makeTag(branchId, price);
    const invoice = await createInvoice({
      branchId, clientId, invoiceDate, invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: price, tagId: tag.id, hsnCode }],
    }, tenant.ctx, userId);
    invoiceIds.push(invoice.id);
    return invoice;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`GSTFLT${suffix}`, ['invoice:create', 'return:create', 'creditNote:create']);
    userId = tenant.user.id;

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-GSTFLT-${suffix}`, name: 'Filter Test Client', type: 'RETAIL', state: 'Gujarat' },
    });
    clientId = client.id;

    const branch2 = await addBranch(tenant.company.id, `GSTFLT2-${suffix}`);
    branch2Id = branch2.id;

    // Two distinct, active registrations, each bound to a different branch — resolveSellerRegistration
    // (sales.service.ts) picks a branch's own registration first, falling back to the company's primary
    // only when the branch has none, so an invoice at tenant.branch always resolves to regA and one at
    // branch2Id always resolves to regB. company_gst_registrations is FORCE-RLS even for the
    // platform/owner test role (G1 migration) — created through the real service (which runs inside
    // tenantTransaction), not a bare prisma.companyGstRegistration.create.
    const regA = await createGstRegistration(tenant.ctx, { gstin: '24AAAAA1111A1Z5', legalName: 'Registration A', stateCode: '24', isPrimary: true, isActive: true });
    regAId = regA.id;
    const regB = await createGstRegistration(tenant.ctx, { gstin: '24BBBBB2222B1Z5', legalName: 'Registration B', stateCode: '24', isPrimary: false, isActive: true });
    regBId = regB.id;

    await prisma.branch.update({ where: { id: tenant.branch.id }, data: { gstRegistrationId: regAId } });
    await prisma.branch.update({ where: { id: branch2Id }, data: { gstRegistrationId: regBId } });
  });

  afterAll(async () => {
    await tenantQuery(tenant.company.id, (tx) => tx.creditNote.deleteMany({ where: { companyId: tenant.company.id } }));
    await cleanupJournalEntries(invoiceIds);
    await prisma.repairCase.deleteMany({ where: { salesReturnItem: { return: { invoiceId: { in: invoiceIds } } } } }); // returned-jewellery register rows reference the return lines
    await prisma.salesReturn.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    // Branch.gstRegistrationId is RESTRICT — detach both branches before the registrations can go.
    await prisma.branch.update({ where: { id: tenant.branch.id }, data: { gstRegistrationId: null } });
    await prisma.branch.update({ where: { id: branch2Id }, data: { gstRegistrationId: null } });
    await tenantQuery(tenant.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: { in: [regAId, regBId] } } }));
    if (hsnCodes.length > 0) await prisma.hsnCode.deleteMany({ where: { code: { in: hsnCodes } } });
    await cleanupTestTenant(tenant);
  });

  it('filters sales GST to registration A only (test 1)', async () => {
    const hsnA = await makeHsn(`TSTHSN-REGA-${suffix}`);
    const hsnB = await makeHsn(`TSTHSN-REGB-${suffix}`);
    await makeInvoiceAt(tenant.branch.id, 10000, hsnA);
    await makeInvoiceAt(branch2Id, 20000, hsnB);

    const filteredA = await getGstSummary(tenant.company.id, wideFrom, wideTo, { gstRegistrationId: regAId });
    expect(filteredA.rows.some((r) => r.hsnCode === hsnA)).toBe(true);
    expect(filteredA.rows.some((r) => r.hsnCode === hsnB)).toBe(false);
  });

  it('filters sales GST to registration B only (test 2)', async () => {
    const hsnA = await makeHsn(`TSTHSN-REGA2-${suffix}`);
    const hsnB = await makeHsn(`TSTHSN-REGB2-${suffix}`);
    await makeInvoiceAt(tenant.branch.id, 11000, hsnA);
    await makeInvoiceAt(branch2Id, 21000, hsnB);

    const filteredB = await getGstSummary(tenant.company.id, wideFrom, wideTo, { gstRegistrationId: regBId });
    expect(filteredB.rows.some((r) => r.hsnCode === hsnB)).toBe(true);
    expect(filteredB.rows.some((r) => r.hsnCode === hsnA)).toBe(false);
  });

  it('a standalone Credit Note is filtered by its own persisted seller registration (test 4)', async () => {
    const hsn = await makeHsn(`TSTHSN-REGCN-${suffix}`);
    const invoice = await makeInvoiceAt(branch2Id, 8000, hsn);

    const cn = await createStandaloneCreditNote(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 824 }], reasonCode: 'POST_SALE_DISCOUNT' },
      tenant.ctx, userId,
    );
    creditNoteIds.push(cn.id);
    expect(cn.sellerRegistrationId).toBe(regBId); // sanity: it really did inherit branch2's registration

    const beforeReturnB = await getGstSummary(tenant.company.id, wideFrom, wideTo, { gstRegistrationId: regBId });
    const rowB = beforeReturnB.rows.find((r) => r.hsnCode === hsn)!;
    // The credit note nets off part of this registration's own contribution — it's still positive
    // (a partial credit, not a full return) but strictly less than the invoice's own taxable value.
    expect(rowB.taxableValue).toBeGreaterThan(0);
    expect(rowB.taxableValue).toBeLessThan(Number(invoice.subtotal));

    // Registration A never had this invoice OR this credit note.
    const filteredA = await getGstSummary(tenant.company.id, wideFrom, wideTo, { gstRegistrationId: regAId });
    expect(filteredA.rows.some((r) => r.hsnCode === hsn)).toBe(false);
  });

  it('a Path A Sales Return derives its registration from the original invoice, not the other one (test 5)', async () => {
    const hsn = await makeHsn(`TSTHSN-REGRET-${suffix}`);
    const invoice = await makeInvoiceAt(tenant.branch.id, 9000, hsn);

    const beforeA = await getGstSummary(tenant.company.id, wideFrom, wideTo, { gstRegistrationId: regAId });
    const taxableBefore = beforeA.rows.find((r) => r.hsnCode === hsn)!.taxableValue;
    expect(taxableBefore).toBeGreaterThan(0);

    const ret = await createSalesReturn(
      { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }], reason: 'Wrong size' },
      tenant.ctx, userId,
    );
    salesReturnIds.push(ret.id);

    // Fully returned under registration A — nets back to zero.
    const afterA = await getGstSummary(tenant.company.id, wideFrom, wideTo, { gstRegistrationId: regAId });
    const rowAfterA = afterA.rows.find((r) => r.hsnCode === hsn)?.taxableValue ?? 0;
    expect(rowAfterA).toBeCloseTo(0, 2);

    // Registration B (the OTHER registration) never saw this invoice or its return at all — proof
    // the return's registration was derived from the original invoice, not misattributed.
    const afterB = await getGstSummary(tenant.company.id, wideFrom, wideTo, { gstRegistrationId: regBId });
    expect(afterB.rows.some((r) => r.hsnCode === hsn)).toBe(false);
  });

  it('branch access: an unrestricted caller sees data from every branch (test 6)', async () => {
    const hsn = await makeHsn(`TSTHSN-BRALL-${suffix}`);
    await makeInvoiceAt(tenant.branch.id, 5000, hsn);
    await makeInvoiceAt(branch2Id, 5000, hsn);

    const result = await getGstSummary(tenant.company.id, wideFrom, wideTo, {
      branchAccess: { allBranches: true, branchIds: [] },
    });
    const row = result.rows.find((r) => r.hsnCode === hsn)!;
    // Both invoices contributed — a single ~5000 line's worth would be well under this.
    expect(row.taxableValue).toBeGreaterThan(9000);
  });

  it('branch access: a restricted caller sees only their own branch, implicitly and by explicit branchId (test 7)', async () => {
    const hsnHome = await makeHsn(`TSTHSN-BRHOME-${suffix}`);
    const hsnOther = await makeHsn(`TSTHSN-BROTHER-${suffix}`);
    await makeInvoiceAt(tenant.branch.id, 7000, hsnHome);
    await makeInvoiceAt(branch2Id, 7000, hsnOther);

    const restrictedAccess = { allBranches: false, branchIds: [tenant.branch.id] };

    // No explicit branchId — falls back to the caller's own granted branches.
    const implicit = await getGstSummary(tenant.company.id, wideFrom, wideTo, { branchAccess: restrictedAccess });
    expect(implicit.rows.some((r) => r.hsnCode === hsnHome)).toBe(true);
    expect(implicit.rows.some((r) => r.hsnCode === hsnOther)).toBe(false);

    // Explicit branchId for their own (granted) branch — same result (this mirrors what the
    // router passes once assertBranchAccessible has already verified the branchId).
    const explicit = await getGstSummary(tenant.company.id, wideFrom, wideTo, {
      branchAccess: restrictedAccess, branchId: tenant.branch.id,
    });
    expect(explicit.rows.some((r) => r.hsnCode === hsnHome)).toBe(true);
    expect(explicit.rows.some((r) => r.hsnCode === hsnOther)).toBe(false);
  });
});

// G2g-2: purchase-side branch access — getPurchaseGstSummary has no gstRegistrationId filter (see
// its own comment for why), but branch access applies identically to the sales side. Raw
// PO/GRN/GrnItem fixtures (bypassing the full procurement flow) since only the branch/taxableValue
// shape matters here, same precedent as the H5 block's "persisted tax snapshot" raw-row test.
describe('getPurchaseGstSummary — G2g-2 branch filtering', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const from = new Date('2020-01-01');
  const to = new Date('2030-12-31');

  let tenant: TestTenant;
  let branch2Id: string;
  let supplierId: string;
  const poIds: string[] = [];
  const grnIds: string[] = [];
  const hsnIds: string[] = [];

  async function makeGrnItem(branchId: string, hsnCode: string, label: string) {
    const hsn = await prisma.hsnCode.create({ data: { code: hsnCode, description: `G2g-2 purchase test ${hsnCode}`, gstRate: 0.03, isActive: true } });
    hsnIds.push(hsn.id);

    const po = await prisma.purchaseOrder.create({
      data: {
        companyId: tenant.company.id, supplierId, poNumber: `TSTPO-GSTPB-${suffix}-${label}`,
        poType: 'OUTRIGHT', orderDate: new Date('2026-06-01'), subtotal: 10000, totalAmount: 10300,
      },
    });
    poIds.push(po.id);
    const poItem = await prisma.poItem.create({
      data: {
        companyId: tenant.company.id, poId: po.id, materialCode: 'FG', materialName: 'Finished Good',
        materialType: 'FINISHED_GOODS', quantity: 1, weight: 10, unit: 'GM', ratePerUnit: 10000, totalAmount: 10000,
        hsnCodeId: hsn.id, taxRate: 0.03,
      },
    });
    const grn = await prisma.goodsReceiptNote.create({
      data: {
        companyId: tenant.company.id, poId: po.id, grnNumber: `TSTGRN-GSTPB-${suffix}-${label}`,
        receivedDate: new Date('2026-06-05'), branchId,
      },
    });
    grnIds.push(grn.id);
    await prisma.grnItem.create({
      data: {
        companyId: tenant.company.id, grnId: grn.id, poItemId: poItem.id,
        invoiceQty: 1, invoiceWeight: 10, scaleWeight: 10, acceptedWeight: 10, variance: 0, variancePercent: 0,
        taxableValue: 10000, inputCgst: 150, inputSgst: 150, inputIgst: 0,
      },
    });
    return hsn.code;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(`GSTPB${suffix}`, []);
    branch2Id = (await addBranch(tenant.company.id, `GSTPB2-${suffix}`)).id;
    const supplier = await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `TSTSUP-GSTPB-${suffix}`, name: 'Filter Test Supplier', type: 'OTHER' },
    });
    supplierId = supplier.id;
  });

  afterAll(async () => {
    await prisma.grnItem.deleteMany({ where: { grnId: { in: grnIds } } });
    await prisma.goodsReceiptNote.deleteMany({ where: { id: { in: grnIds } } });
    await prisma.poItem.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    if (hsnIds.length > 0) await prisma.hsnCode.deleteMany({ where: { id: { in: hsnIds } } });
    await cleanupTestTenant(tenant);
  });

  it('a restricted caller sees only their own branch\'s purchase GST; an unrestricted caller sees both', async () => {
    const hsnHome = await makeGrnItem(tenant.branch.id, `TSTHSN-PBHOME-${suffix}`, 'home');
    const hsnOther = await makeGrnItem(branch2Id, `TSTHSN-PBOTHER-${suffix}`, 'other');

    const restricted = await getPurchaseGstSummary(tenant.company.id, from, to, {
      branchAccess: { allBranches: false, branchIds: [tenant.branch.id] },
    });
    expect(restricted.rows.some((r) => r.hsnCode === hsnHome)).toBe(true);
    expect(restricted.rows.some((r) => r.hsnCode === hsnOther)).toBe(false);

    const unrestricted = await getPurchaseGstSummary(tenant.company.id, from, to, {
      branchAccess: { allBranches: true, branchIds: [] },
    });
    expect(unrestricted.rows.some((r) => r.hsnCode === hsnHome)).toBe(true);
    expect(unrestricted.rows.some((r) => r.hsnCode === hsnOther)).toBe(true);

    // An explicit branchId for a branch NOT in the restricted caller's grant is what the router's
    // assertBranchAccessible would reject before this function is ever called (see
    // http.gstReportSecurity.test.ts) — this function itself trusts branchId as pre-validated, so
    // it isn't re-asserted here; this test only proves the filtering math once trusted.
    const explicitHome = await getPurchaseGstSummary(tenant.company.id, from, to, {
      branchAccess: { allBranches: true, branchIds: [] }, branchId: tenant.branch.id,
    });
    expect(explicitHome.rows.some((r) => r.hsnCode === hsnHome)).toBe(true);
    expect(explicitHome.rows.some((r) => r.hsnCode === hsnOther)).toBe(false);
  });
});
