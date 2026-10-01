import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { createInvoice as _createInvoice, voidInvoice, createSalesReturn } from '../../sales/sales.service';
import { createStandaloneCreditNote, cancelCreditNote } from '../../sales/creditNote.service';
import { createGstRegistration } from '../../company/company.service';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../../test/fixtures';
import { cleanupJournalEntries } from '../../../test/ledger';
import { tenantQuery, TenantContext } from '../../../shared/tenantContext';
import { getGstr1Table13Report } from './gstr1Reporting.service';
import { parseIstRangeStart, parseIstRangeEnd } from '../../../shared/istDate';

// G2g-3g-2 — GSTR-1 Table 13 Prisma reporting adapter service-level integration tests.
// Tests all 23 required behaviors across tenant scoping, registration isolation, branch filtering,
// IST date boundaries, status handling, document lifecycle rules, gap preservation, and join safety.
describe('GSTR-1 Table 13 reporting adapter integration (G2g-3g-2)', () => {
  const suffix = `g13-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let tenantB: TestTenant;
  let userId: string;
  let branchA: string;
  let branchB: string;
  let intraClientId: string;
  let interClientId: string;
  let primaryRegId: string;
  let secondaryRegId: string;
  let tenantBRegId: string;

  const invoiceIds: string[] = [];
  const salesReturnIds: string[] = [];
  const creditNoteIds: string[] = [];
  const tagIds: string[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];
  const debitNoteIds: string[] = [];
  const grnIds: string[] = [];
  const poIds: string[] = [];
  const supplierIds: string[] = [];
  const memoOutIds: string[] = [];
  const branchTransferIds: string[] = [];

  function createInvoice(data: Omit<Parameters<typeof _createInvoice>[0], 'branchId'> & { branchId?: string }) {
    return _createInvoice({ branchId: branchA, ...data }, tenant.ctx, userId);
  }

  async function makeTag(price: number, branchId = branchA) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-G13-${suffix}-${tagIds.length}`,
        companyId: tenant.company.id,
        branchId,
        name: 'Ring',
        metalType: 'GOLD',
        metalKarat: '22K',
        grossWeight: 10,
        netWeight: 10,
        stoneWeight: 0,
        costPrice: price * 0.8,
        sellingPrice: price,
        createdById: userId,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }

  async function makeInvoice(
    clientId: string,
    price: number,
    overrides: Partial<Parameters<typeof _createInvoice>[0]> = {},
    status = 'ISSUED',
  ) {
    const tag = await makeTag(price, overrides.branchId ?? branchA);
    const invoice = await createInvoice({
      clientId,
      invoiceDate: new Date(),
      invoiceType: 'RETAIL',
      items: [
        {
          productCode: 'MISC',
          description: 'Ring',
          quantity: 1,
          grossWeight: 10,
          netGoldWeight: 10,
          rateType: 'FIXED',
          goldRate: price,
          tagId: tag.id,
        },
      ],
      ...overrides,
    });
    invoiceIds.push(invoice.id);

    if (status !== 'DRAFT') {
      await prisma.salesInvoice.update({
        where: { id: invoice.id },
        data: { status },
      });
      invoice.status = status;
    }
    return invoice;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(suffix, [
      'invoice:create',
      'invoice:void',
      'return:create',
      'creditNote:create',
      'creditNote:cancel',
      'report:financial_view',
    ]);
    userId = tenant.user.id;
    branchA = tenant.branch.id;

    const b = await addBranch(tenant.company.id, suffix);
    branchB = b.id;

    const reg1 = await createGstRegistration(tenant.ctx, {
      gstin: '24AAAAA0000A1Z5',
      legalName: 'Primary Reg',
      stateCode: '24',
      isPrimary: true,
      isActive: true,
    });
    primaryRegId = reg1.id;
    regRows.push({ id: reg1.id, companyId: tenant.company.id });

    const reg2 = await createGstRegistration(tenant.ctx, {
      gstin: '24BBBBB1111B1Z5',
      legalName: 'Secondary Reg',
      stateCode: '24',
      isPrimary: false,
      isActive: true,
    });
    secondaryRegId = reg2.id;
    regRows.push({ id: reg2.id, companyId: tenant.company.id });

    // Tenant B for cross-company isolation tests
    tenantB = await createTestTenant(`b-${suffix}`, ['invoice:create', 'report:financial_view']);
    const regB = await createGstRegistration(tenantB.ctx, {
      gstin: '24CCCCC2222C1Z5',
      legalName: 'Company B Reg',
      stateCode: '24',
      isPrimary: true,
      isActive: true,
    });
    tenantBRegId = regB.id;
    regRows.push({ id: regB.id, companyId: tenantB.company.id });

    const [intra, inter] = await Promise.all([
      prisma.client.create({
        data: {
          companyId: tenant.company.id,
          clientCode: `TSTCL-G13A-${suffix}`,
          name: 'Intra Client',
          type: 'RETAIL',
          state: 'Gujarat',
        },
      }),
      prisma.client.create({
        data: {
          companyId: tenant.company.id,
          clientCode: `TSTCL-G13B-${suffix}`,
          name: 'Inter Client',
          type: 'RETAIL',
          state: 'Maharashtra',
        },
      }),
    ]);
    intraClientId = intra.id;
    interClientId = inter.id;
  });

  afterAll(async () => {
    for (const r of regRows) {
      await tenantQuery(r.companyId, (tx) =>
        tx.companyGstRegistration.deleteMany({ where: { id: r.id } })
      );
    }
    await tenantQuery(tenant.company.id, (tx) =>
      tx.creditNote.deleteMany({ where: { companyId: tenant.company.id } })
    );
    await cleanupJournalEntries([...invoiceIds, ...salesReturnIds, ...creditNoteIds]);

    if (debitNoteIds.length > 0) {
      await tenantQuery(tenant.company.id, (tx) => tx.debitNoteItem.deleteMany({ where: { debitNoteId: { in: debitNoteIds } } }));
      await tenantQuery(tenant.company.id, (tx) => tx.debitNote.deleteMany({ where: { id: { in: debitNoteIds } } }));
    }
    if (grnIds.length > 0) {
      await prisma.grnItem.deleteMany({ where: { grnId: { in: grnIds } } });
      await prisma.goodsReceiptNote.deleteMany({ where: { id: { in: grnIds } } });
    }
    if (poIds.length > 0) {
      await prisma.poItem.deleteMany({ where: { poId: { in: poIds } } });
      await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    }
    if (supplierIds.length > 0) {
      await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
    }
    if (memoOutIds.length > 0) {
      await prisma.memoItem.deleteMany({ where: { memoId: { in: memoOutIds } } });
      await prisma.memoOut.deleteMany({ where: { id: { in: memoOutIds } } });
    }
    if (branchTransferIds.length > 0) {
      await prisma.branchTransferItem.deleteMany({ where: { transferId: { in: branchTransferIds } } });
      await prisma.branchTransfer.deleteMany({ where: { id: { in: branchTransferIds } } });
    }

    await prisma.salesReturn.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: { in: [intraClientId, interClientId] } } });
    await cleanupTestTenant(tenant);
    await cleanupTestTenant(tenantB);
    await prisma.$disconnect();
  });

  // 1. Single GST registration returns only that registration's invoices.
  it('1. Single GST registration returns only that registration\'s invoices', async () => {
    const inv1 = await makeInvoice(intraClientId, 1000);
    const inv2 = await makeInvoice(intraClientId, 2000);

    // Reassign inv2 to secondary registration
    await prisma.taxInvoice.update({
      where: { invoiceId: inv2.id },
      data: { sellerRegistrationId: secondaryRegId },
    });

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    expect(report.meta.gstRegistrationId).toBe(primaryRegId);
    const outwardSeries = report.series.filter((s) => s.category === 'OUTWARD_INVOICE');
    expect(outwardSeries.length).toBeGreaterThan(0);
    // Secondary registration invoice must NOT be in primary registration's report
    for (const s of outwardSeries) {
      expect(s.sellerRegistrationId).toBe(primaryRegId);
    }
    expect(report.meta.salesInvoicesConsidered).toBeGreaterThanOrEqual(1);
  });

  // 2. Cross-company registration returns no data / existing ownership error.
  it('2. Cross-company registration returns existing ownership error (404)', async () => {
    await expect(
      getGstr1Table13Report(tenant.ctx, {
        gstRegistrationId: tenantBRegId, // Belongs to Tenant B
        from: '2020-01-01',
        to: '2035-12-31',
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // 3. Date filtering uses IST correctly.
  it('3. Date filtering uses IST correctly', async () => {
    // 2026-09-15T17:00:00Z = 22:30 IST on 15 Sep (same IST day, included)
    // 2026-09-15T20:00:00Z = 01:30 IST on 16 Sep (next IST day, excluded)
    const includedDate = new Date('2026-09-15T17:00:00.000Z');
    const excludedDate = new Date('2026-09-15T20:00:00.000Z');

    const invInc = await makeInvoice(intraClientId, 1500, { invoiceDate: includedDate });
    const invExc = await makeInvoice(intraClientId, 1600, { invoiceDate: excludedDate });

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2026-09-15',
      to: '2026-09-15',
    });

    const outwardSeries = report.series.filter((s) => s.category === 'OUTWARD_INVOICE');
    const docNumbers = outwardSeries.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(docNumbers).toContain(invInc.invoiceNumber);
    expect(docNumbers).not.toContain(invExc.invoiceNumber);
  });

  // 4. Branch filtering works.
  it('4. Branch filtering works', async () => {
    const invA = await makeInvoice(intraClientId, 1700, { branchId: branchA });
    const invB = await makeInvoice(intraClientId, 1800, { branchId: branchB });

    const reportA = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
      branchId: branchA,
    });

    expect(reportA.meta.branchId).toBe(branchA);
    expect(reportA.meta.isPartialBranchSeries).toBe(true);
    const outwardSeriesA = reportA.series.filter((s) => s.category === 'OUTWARD_INVOICE');
    const docsA = outwardSeriesA.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(docsA).toContain(invA.invoiceNumber);
    expect(docsA).not.toContain(invB.invoiceNumber);
  });

  // 5. Restricted user sees only accessible branches.
  it('5. Restricted user sees only accessible branches and marks isPartialBranchSeries true', async () => {
    const invA = await makeInvoice(intraClientId, 1900, { branchId: branchA });
    const invB = await makeInvoice(intraClientId, 1950, { branchId: branchB });

    const restrictedCtx: TenantContext = {
      ...tenant.ctx,
      branchAccess: { allBranches: false, branchIds: [branchA] },
    };

    const report = await getGstr1Table13Report(restrictedCtx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    expect(report.meta.isPartialBranchSeries).toBe(true);
    const outwardSeries = report.series.filter((s) => s.category === 'OUTWARD_INVOICE');
    const docs = outwardSeries.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(docs).toContain(invA.invoiceNumber);
    expect(docs).not.toContain(invB.invoiceNumber);
  });

  // 6. Explicit inaccessible branch is rejected.
  it('6. Explicit inaccessible branch is rejected with 404', async () => {
    const restrictedCtx: TenantContext = {
      ...tenant.ctx,
      branchAccess: { allBranches: false, branchIds: [branchA] },
    };

    await expect(
      getGstr1Table13Report(restrictedCtx, {
        gstRegistrationId: primaryRegId,
        from: '2020-01-01',
        to: '2035-12-31',
        branchId: branchB, // Restricted user does NOT have branchB
      })
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // 7. VOID invoice is included as cancelled.
  it('7. VOID invoice is included as cancelled document in Table 13', async () => {
    const inv = await makeInvoice(intraClientId, 3100);
    await voidInvoice(inv.id, tenant.ctx, userId, 'Table 13 void test');

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    expect(report.summary.cancelledDocumentCount).toBeGreaterThanOrEqual(1);
    const matchedSeries = report.series.find(
      (s) => s.fromDocumentNumber === inv.invoiceNumber || s.toDocumentNumber === inv.invoiceNumber
    );
    expect(matchedSeries).toBeDefined();
    expect(matchedSeries!.cancelledDocuments).toBeGreaterThanOrEqual(1);
  });

  // 8. Draft invoice excluded.
  it('8. Draft invoice excluded from Table 13', async () => {
    // makeInvoice with status = 'DRAFT'
    const draftInv = await makeInvoice(intraClientId, 3200, {}, 'DRAFT');

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    const docNumbers = report.series.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(docNumbers).not.toContain(draftInv.invoiceNumber);
  });

  // 9. Credit Note included.
  it('9. Credit Note included in CREDIT_NOTE category series', async () => {
    const inv = await makeInvoice(intraClientId, 3300);
    const cn = await createStandaloneCreditNote(
      {
        invoiceId: inv.id,
        items: [{ description: 'Price concession', taxableValue: 200 }],
        reasonCode: 'POST_SALE_DISCOUNT',
        reasonNotes: 'G13 CN test',
      },
      tenant.ctx,
      userId
    );
    creditNoteIds.push(cn.id);

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    expect(report.meta.creditNotesConsidered).toBeGreaterThanOrEqual(1);
    const cnSeries = report.series.filter((s) => s.category === 'CREDIT_NOTE');
    expect(cnSeries.length).toBeGreaterThan(0);
    const cnDocs = cnSeries.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(cnDocs).toContain(cn.creditNoteNumber);
  });

  // 10. Cancelled Credit Note included as cancelled.
  it('10. Cancelled Credit Note included as cancelled', async () => {
    const inv = await makeInvoice(intraClientId, 3400);
    const cn = await createStandaloneCreditNote(
      {
        invoiceId: inv.id,
        items: [{ description: 'Rebate', taxableValue: 300 }],
        reasonCode: 'OTHER',
        reasonNotes: 'G13 CN cancel test',
      },
      tenant.ctx,
      userId
    );
    creditNoteIds.push(cn.id);
    await cancelCreditNote(cn.id, tenant.ctx, userId, 'G13 cancellation test');

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    const cnSeries = report.series.filter((s) => s.category === 'CREDIT_NOTE');
    const targetSeries = cnSeries.find(
      (s) => s.fromDocumentNumber === cn.creditNoteNumber || s.toDocumentNumber === cn.creditNoteNumber
    );
    expect(targetSeries).toBeDefined();
    expect(targetSeries!.cancelledDocuments).toBeGreaterThanOrEqual(1);
  });

  // 11. Path A Credit Note included once.
  it('11. Path A Credit Note included once', async () => {
    const inv = await makeInvoice(intraClientId, 3500);
    const ret = await createSalesReturn(
      {
        invoiceId: inv.id,
        items: [{ invoiceItemId: inv.items[0].id }],
        reason: 'Path A G13 test',
      },
      tenant.ctx,
      userId,
      { issueCreditNote: true }
    );
    salesReturnIds.push(ret.id);
    creditNoteIds.push(ret.creditNote!.id);

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    const cnSeries = report.series.filter((s) => s.category === 'CREDIT_NOTE');
    const matchedInSeries = cnSeries.filter(
      (s) => s.fromDocumentNumber === ret.creditNote!.creditNoteNumber || s.toDocumentNumber === ret.creditNote!.creditNoteNumber
    );
    expect(matchedInSeries.length).toBe(1);
  });

  // 12. Path B Credit Note included once.
  it('12. Path B Credit Note included once', async () => {
    const inv = await makeInvoice(intraClientId, 3600);
    const cn = await createStandaloneCreditNote(
      {
        invoiceId: inv.id,
        items: [{ description: 'Billing correction', taxableValue: 150 }],
        reasonCode: 'CORRECTION_IN_INVOICE',
        reasonNotes: 'Path B test',
      },
      tenant.ctx,
      userId
    );
    creditNoteIds.push(cn.id);

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    const cnSeries = report.series.filter((s) => s.category === 'CREDIT_NOTE');
    const matched = cnSeries.filter(
      (s) => s.fromDocumentNumber === cn.creditNoteNumber || s.toDocumentNumber === cn.creditNoteNumber
    );
    expect(matched.length).toBe(1);
  });

  // 13. Bare SalesReturn excluded.
  it('13. Bare SalesReturn excluded (never creates a Table 13 document)', async () => {
    const inv = await makeInvoice(intraClientId, 3700);
    const ret = await createSalesReturn(
      {
        invoiceId: inv.id,
        items: [{ invoiceItemId: inv.items[0].id }],
        reason: 'Bare return G13 test',
      },
      tenant.ctx,
      userId,
      { issueCreditNote: false }
    );
    salesReturnIds.push(ret.id);

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    // The return number (e.g. RET-...) must not appear anywhere in Table 13 series
    const allDocNums = report.series.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(allDocNums.some((num) => num.startsWith('RET-') || num === ret.returnNumber)).toBe(false);
  });

  // 14. Procurement DebitNote excluded.
  it('14. Procurement DebitNote excluded', async () => {
    // Create a supplier, purchase order, GRN, and procurement debit note
    const supplier = await prisma.supplier.create({
      data: {
        companyId: tenant.company.id,
        supplierCode: `SUP-G13-${suffix}`,
        name: 'Supplier G13',
        type: 'MANUFACTURER',
        state: 'Gujarat',
      },
    });
    supplierIds.push(supplier.id);

    const po = await prisma.purchaseOrder.create({
      data: {
        companyId: tenant.company.id,
        poNumber: `PO-G13-${suffix}`,
        supplierId: supplier.id,
        poType: 'STANDARD',
        orderDate: new Date(),
        status: 'RECEIVED',
        currency: 'INR',
        subtotal: 10000,
        taxAmount: 300,
        totalAmount: 10300,
      },
    });
    poIds.push(po.id);

    const grn = await prisma.goodsReceiptNote.create({
      data: {
        companyId: tenant.company.id,
        branchId: branchA,
        grnNumber: `GRN-G13-${suffix}`,
        poId: po.id,
        receivedDate: new Date(),
        status: 'RECEIVED',
      },
    });
    grnIds.push(grn.id);

    const dn = await tenantQuery(tenant.company.id, (tx) =>
      tx.debitNote.create({
        data: {
          companyId: tenant.company.id,
          debitNoteNumber: `DN-2026-000001`,
          financialYear: 2026,
          debitNoteDate: new Date(),
          grnId: grn.id,
          supplierId: supplier.id,
          reasonCode: 'DEFICIENT_SERVICE',
          reasonNotes: 'G13 exclusion test',
          status: 'ISSUED',
          taxableAmount: 1000,
          cgst: 15,
          sgst: 15,
          igst: 0,
          totalTax: 30,
          totalAmount: 1030,
        },
      })
    );
    debitNoteIds.push(dn.id);

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    // Procurement debit note must NEVER be included in Table 13
    const categories = report.series.map((s) => s.category);
    expect(categories).not.toContain('OUTWARD_DEBIT_NOTE');
    const allDocNums = report.series.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(allDocNums).not.toContain(dn.debitNoteNumber);
  });

  // 15. MemoOut excluded.
  it('15. MemoOut excluded', async () => {
    const memo = await prisma.memoOut.create({
      data: {
        companyId: tenant.company.id,
        branchId: branchA,
        memoNumber: `MEMO-G13-${suffix}`,
        clientId: intraClientId,
        sentDate: new Date(),
        returnDeadline: new Date(Date.now() + 86400000),
        status: 'ISSUED',
        totalValue: 5000,
      },
    });
    memoOutIds.push(memo.id);

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    const allDocNums = report.series.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(allDocNums).not.toContain(memo.memoNumber);
  });

  // 16. BranchTransfer excluded.
  it('16. BranchTransfer excluded', async () => {
    const transfer = await prisma.branchTransfer.create({
      data: {
        company: { connect: { id: tenant.company.id } },
        transferNumber: `TR-G13-${suffix}`,
        fromBranch: { connect: { id_companyId: { id: branchA, companyId: tenant.company.id } } },
        toBranch: { connect: { id_companyId: { id: branchB, companyId: tenant.company.id } } },
        requestedBy: { connect: { id: userId } },
        status: 'DISPATCHED',
      },
    });
    branchTransferIds.push(transfer.id);

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    const allDocNums = report.series.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(allDocNums).not.toContain(transfer.transferNumber);
  });

  // 17. CreditNote branch is derived from original SalesInvoice.
  it('17. CreditNote branch is derived from original SalesInvoice', async () => {
    const invB = await makeInvoice(intraClientId, 3800, { branchId: branchB });
    const cn = await createStandaloneCreditNote(
      {
        invoiceId: invB.id,
        items: [{ description: 'Branch B credit', taxableValue: 120 }],
        reasonCode: 'OTHER',
        reasonNotes: 'Branch B credit note',
      },
      tenant.ctx,
      userId
    );
    creditNoteIds.push(cn.id);

    // Scoped to Branch A -> Credit Note on Branch B invoice must be excluded
    const reportBranchA = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
      branchId: branchA,
    });
    const cnDocsA = reportBranchA.series
      .filter((s) => s.category === 'CREDIT_NOTE')
      .flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(cnDocsA).not.toContain(cn.creditNoteNumber);

    // Scoped to Branch B -> Credit Note on Branch B invoice must be included
    const reportBranchB = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
      branchId: branchB,
    });
    const cnDocsB = reportBranchB.series
      .filter((s) => s.category === 'CREDIT_NOTE')
      .flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(cnDocsB).toContain(cn.creditNoteNumber);
  });

  // 18. Multi-GSTIN interleaving remains separate.
  it('18. Multi-GSTIN interleaving remains separate', async () => {
    const inv1 = await makeInvoice(intraClientId, 3900);
    const inv2 = await makeInvoice(intraClientId, 3950);
    // Assign inv2 to secondary registration
    await prisma.taxInvoice.update({
      where: { invoiceId: inv2.id },
      data: { sellerRegistrationId: secondaryRegId },
    });

    const reportReg1 = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });
    const reportReg2 = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: secondaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    const docs1 = reportReg1.series.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    const docs2 = reportReg2.series.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);

    expect(docs1).toContain(inv1.invoiceNumber);
    expect(docs1).not.toContain(inv2.invoiceNumber);

    expect(docs2).toContain(inv2.invoiceNumber);
    expect(docs2).not.toContain(inv1.invoiceNumber);
  });

  // 19. Legacy null-registration invoice is not assigned to selected GST registration.
  it('19. Legacy null-registration invoice is not assigned to selected GST registration', async () => {
    const legacyInv = await makeInvoice(intraClientId, 4000);
    await prisma.taxInvoice.update({
      where: { invoiceId: legacyInv.id },
      data: { sellerRegistrationId: null },
    });

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    const allDocs = report.series.flatMap((s) => [s.fromDocumentNumber, s.toDocumentNumber]);
    expect(allDocs).not.toContain(legacyInv.invoiceNumber);
  });

  // 20. Historical invoice number remains unchanged.
  it('20. Historical invoice number remains unchanged', async () => {
    const inv = await makeInvoice(intraClientId, 4100);
    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    const matchedSeries = report.series.find(
      (s) => s.fromDocumentNumber === inv.invoiceNumber || s.toDocumentNumber === inv.invoiceNumber
    );
    expect(matchedSeries).toBeDefined();
    // Prefix, separators, zero-padding preserved exactly
    expect(inv.invoiceNumber).toMatch(/^INV-\d{4}-\d{6}$/);
    if (matchedSeries!.fromDocumentNumber === inv.invoiceNumber) {
      expect(matchedSeries!.fromDocumentNumber).toBe(inv.invoiceNumber);
    }
    if (matchedSeries!.toDocumentNumber === inv.invoiceNumber) {
      expect(matchedSeries!.toDocumentNumber).toBe(inv.invoiceNumber);
    }
  });

  // 21. Historical CreditNote number remains unchanged.
  it('21. Historical CreditNote number remains unchanged', async () => {
    const inv = await makeInvoice(intraClientId, 4200);
    const cn = await createStandaloneCreditNote(
      {
        invoiceId: inv.id,
        items: [{ description: 'Test', taxableValue: 100 }],
        reasonCode: 'OTHER',
        reasonNotes: 'Historical CN unchanged test',
      },
      tenant.ctx,
      userId
    );
    creditNoteIds.push(cn.id);

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2020-01-01',
      to: '2035-12-31',
    });

    const cnSeries = report.series.filter((s) => s.category === 'CREDIT_NOTE');
    const matched = cnSeries.find(
      (s) => s.fromDocumentNumber === cn.creditNoteNumber || s.toDocumentNumber === cn.creditNoteNumber
    );
    expect(matched).toBeDefined();
    expect(cn.creditNoteNumber).toMatch(/^CN-\d{4}-\d{6}$/);
  });

  // 22. Existing G2g-3g-1 gap diagnostics survive adapter loading.
  it('22. Existing G2g-3g-1 gap diagnostics survive adapter loading', async () => {
    // Create 2 invoices in secondaryReg with a deliberate serial number gap (1 and 3)
    const inv1 = await makeInvoice(intraClientId, 500, {
      invoiceDate: new Date('2026-05-01'),
    });
    await prisma.salesInvoice.update({
      where: { id: inv1.id },
      data: { invoiceNumber: 'GAP-2026-000001' },
    });
    await prisma.taxInvoice.update({
      where: { invoiceId: inv1.id },
      data: { sellerRegistrationId: secondaryRegId },
    });

    const inv3 = await makeInvoice(intraClientId, 500, {
      invoiceDate: new Date('2026-05-03'),
    });
    await prisma.salesInvoice.update({
      where: { id: inv3.id },
      data: { invoiceNumber: 'GAP-2026-000003' },
    });
    await prisma.taxInvoice.update({
      where: { invoiceId: inv3.id },
      data: { sellerRegistrationId: secondaryRegId },
    });

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: secondaryRegId,
      from: '2026-05-01',
      to: '2026-05-31',
    });

    const gapDiag = report.diagnostics.find(
      (d) => d.code === 'UNEXPLAINED_SEQUENCE_GAP' && d.missingFrom === 2
    );
    expect(gapDiag).toBeDefined();
    expect(gapDiag!.previousSerial).toBe(1);
    expect(gapDiag!.nextSerial).toBe(3);
    expect(gapDiag!.missingCount).toBe(1);
  });

  // 23. No duplicate records introduced by joins.
  it('23. No duplicate records introduced by joins (multi-line invoice produces exactly one document)', async () => {
    const tagA = await makeTag(1000);
    const tagB = await makeTag(1000);

    const multiLineInv = await createInvoice({
      clientId: intraClientId,
      invoiceDate: new Date('2026-06-01'),
      invoiceType: 'RETAIL',
      items: [
        { productCode: 'A', description: 'Item A', quantity: 1, grossWeight: 5, netGoldWeight: 5, rateType: 'FIXED', goldRate: 1000, tagId: tagA.id },
        { productCode: 'B', description: 'Item B', quantity: 1, grossWeight: 5, netGoldWeight: 5, rateType: 'FIXED', goldRate: 1000, tagId: tagB.id },
      ],
    });
    invoiceIds.push(multiLineInv.id);

    await prisma.salesInvoice.update({
      where: { id: multiLineInv.id },
      data: { status: 'ISSUED' },
    });

    const report = await getGstr1Table13Report(tenant.ctx, {
      gstRegistrationId: primaryRegId,
      from: '2026-06-01',
      to: '2026-06-01',
    });

    // Despite having 2 lines, considered count must be 1, and documentCount must be 1
    expect(report.meta.salesInvoicesConsidered).toBe(1);
    const outwardSeries = report.series.filter((s) => s.category === 'OUTWARD_INVOICE');
    expect(outwardSeries.length).toBe(1);
    expect(outwardSeries[0].totalDocuments).toBe(1);
    expect(outwardSeries[0].fromDocumentNumber).toBe(multiLineInv.invoiceNumber);
    expect(outwardSeries[0].toDocumentNumber).toBe(multiLineInv.invoiceNumber);
  });
});
