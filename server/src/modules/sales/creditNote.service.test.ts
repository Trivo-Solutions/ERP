import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createInvoice as _createInvoice, createSalesReturn, amendInvoice, voidInvoice } from './sales.service';
import { createStandaloneCreditNote, createCreditNoteForExistingReturn, cancelCreditNote, getCreditNoteById } from './creditNote.service';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../test/fixtures';
import { tenantQuery } from '../../shared/tenantContext';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { createGstRegistration } from '../company/company.service';
import { updateBranch } from '../tagging/tagging.service';

// G2c — Credit Note lifecycle (Path A wraps a SalesReturn, Path B is a standalone value-only
// correction). See PHASE_G2_GST_DOCUMENTS_LIFECYCLE_DESIGN.md §3 for the design this proves.
describe('Credit Note lifecycle (G2c)', () => {
  const suffix = `g2c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let clientId: string;
  const invoiceIds: string[] = [];
  const salesReturnIds: string[] = [];
  const creditNoteIds: string[] = [];
  const tagIds: string[] = [];

  function createInvoice(data: Omit<Parameters<typeof _createInvoice>[0], 'branchId'> & { branchId?: string }) {
    return _createInvoice({ branchId, ...data }, tenant.ctx, userId);
  }

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
  // sale — a clean, predictable 3% CGST+SGST split (DEFAULT_HSN_CODE) to build every scenario on.
  async function makeSoldInvoice(price: number) {
    const tag = await makeTag(price);
    const invoice = await createInvoice({
      clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: price, tagId: tag.id }],
    });
    invoiceIds.push(invoice.id);
    return { invoice, tag };
  }

  beforeAll(async () => {
    tenant = await createTestTenant(suffix, [
      'invoice:create', 'invoice:edit', 'invoice:void', 'return:create',
      'creditNote:view', 'creditNote:create', 'creditNote:cancel',
    ]);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${suffix}`, name: 'Test Client', type: 'RETAIL', state: 'Gujarat' },
    });
    clientId = client.id;
  });

  afterAll(async () => {
    // CreditNote/CreditNoteItem are FORCE-RLS tables in this single-role test DB (same class as
    // company_gst_registrations/tax_invoice_templates — see g1GstFoundation.test.ts's own note) —
    // a bare deleteMany silently matches zero rows here, so cleanup must go through tenantQuery.
    // Deleted BEFORE their JournalEntry/SalesReturn/SalesInvoice (both are plain, RESTRICT-default
    // FKs from CreditNote) — creditNoteItem cascades automatically from creditNote's own delete.
    await tenantQuery(tenant.company.id, (tx) => tx.creditNote.deleteMany({ where: { companyId: tenant.company.id } }));

    await cleanupJournalEntries([...invoiceIds, ...salesReturnIds, ...creditNoteIds]);
    await prisma.salesReturn.deleteMany({ where: { invoiceId: { in: invoiceIds } } }); // cascades sales_return_items
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } }); // cascades invoice_items
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    // G2g-3g-0.1's "Registration-scoped numbering" block attaches CompanyGstRegistration rows to
    // this tenant's branches. Same order as g1GstFoundation.test.ts's own afterAll: clear the FK
    // from branches BEFORE deleting the registrations (branches_gstRegistrationId_companyId_fkey
    // is RESTRICT), and delete registrations (a FORCE-RLS table, via tenantQuery) before
    // cleanupTestTenant removes the branches/company themselves.
    await prisma.branch.updateMany({ where: { companyId: tenant.company.id }, data: { gstRegistrationId: null } });
    await tenantQuery(tenant.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: tenant.company.id } }));
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  describe('Path A — wraps a Sales Return', () => {
    it('issueCreditNote:true creates the return AND its credit note atomically, correctly linked, no second journal', async () => {
      const { invoice, tag } = await makeSoldInvoice(10000);
      const originalTax = await prisma.taxInvoice.findUniqueOrThrow({ where: { invoiceId: invoice.id } });

      const result = await createSalesReturn(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }], reason: 'Customer changed mind' },
        tenant.ctx, userId, { issueCreditNote: true },
      );
      salesReturnIds.push(result.id);
      expect(result.creditNote).toBeTruthy();
      creditNoteIds.push(result.creditNote!.id);

      const cn = result.creditNote!;
      expect(cn.salesReturnId).toBe(result.id);
      expect(cn.invoiceId).toBe(invoice.id);
      expect(cn.reasonCode).toBe('SALES_RETURN');
      expect(Number(cn.totalAmount)).toBeCloseTo(10300, 2);
      expect(Number(cn.taxableAmount)).toBeCloseTo(10000, 2);
      expect(Number(cn.cgst)).toBeCloseTo(150, 2);
      expect(Number(cn.sgst)).toBeCloseTo(150, 2);
      expect(Number(cn.igst)).toBe(0);

      // Seller/buyer snapshot copied verbatim from the invoice's own TaxInvoice — never re-resolved.
      expect(cn.gstin).toBe(originalTax.gstin);
      expect(cn.placeOfSupply).toBe(originalTax.placeOfSupply);
      expect(cn.buyerGstin).toBe(originalTax.buyerGstin);
      expect(cn.sellerLegalName).toBe(originalTax.sellerLegalName);

      // Tax snapshot copied onto the item, not re-looked-up.
      const items = await tenantQuery(tenant.company.id, (tx) => tx.creditNoteItem.findMany({ where: { creditNoteId: cn.id } }));
      expect(items).toHaveLength(1);
      expect(Number(items[0].taxRate)).toBeCloseTo(0.03, 4);
      expect(items[0].invoiceItemId).toBe(invoice.items[0].id);

      // No second journal was posted under the credit note's own id — journalEntryId points at
      // the return's own entry instead.
      const returnEntry = await getJournalEntry(result.id);
      expect(returnEntry).toBeTruthy();
      expect(cn.journalEntryId).toBe(returnEntry!.id);
      const cnOwnEntries = await prisma.journalEntry.findMany({ where: { referenceId: cn.id } });
      expect(cnOwnEntries).toHaveLength(0);

      const freshTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(freshTag.status).toBe('IN_STOCK');
    });

    it('createCreditNoteForExistingReturn wraps an existing return that had none, reusing its journal', async () => {
      const { invoice } = await makeSoldInvoice(8000);
      const salesReturn = await createSalesReturn(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }] },
        tenant.ctx, userId, // no issueCreditNote — the common two-step flow
      );
      salesReturnIds.push(salesReturn.id);
      expect(salesReturn.creditNote).toBeNull();

      const returnEntry = await getJournalEntry(salesReturn.id);
      const cn = await createCreditNoteForExistingReturn(salesReturn.id, tenant.ctx, userId);
      creditNoteIds.push(cn.id);
      expect(cn.salesReturnId).toBe(salesReturn.id);
      expect(cn.journalEntryId).toBe(returnEntry!.id);
      const cnOwnEntries = await prisma.journalEntry.findMany({ where: { referenceId: cn.id } });
      expect(cnOwnEntries).toHaveLength(0);

      // A second attempt against the same, now-covered return is rejected.
      await expect(createCreditNoteForExistingReturn(salesReturn.id, tenant.ctx, userId))
        .rejects.toThrow(/already has a Credit Note/);
    });

    it('rolls back the WHOLE return (tag flip, return row, its journal) when the credit note would over-credit', async () => {
      const { invoice, tag } = await makeSoldInvoice(9000);
      const lineId = invoice.items[0].id;
      // Fully credit the line via a standalone Path B note first.
      const firstCn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: lineId, amount: 9270 }], reasonCode: 'POST_SALE_DISCOUNT' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(firstCn.id);
      const clientBefore = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

      // Now attempt to return + credit-note the SAME already-fully-credited line, atomically.
      await expect(createSalesReturn(
        { invoiceId: invoice.id, items: [{ invoiceItemId: lineId }] },
        tenant.ctx, userId, { issueCreditNote: true },
      )).rejects.toThrow(/Over-credit/);

      // Nothing from the failed attempt persisted — not the tag flip, not the return, not its journal.
      const freshTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(freshTag.status).toBe('SOLD');
      const returns = await prisma.salesReturn.findMany({ where: { invoiceId: invoice.id } });
      expect(returns).toHaveLength(0);
      const clientAfter = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(Number(clientAfter.currentBalance)).toBeCloseTo(Number(clientBefore.currentBalance), 2);
    });
  });

  describe('Path B — standalone (value-only, no physical return)', () => {
    it('a partial standalone credit note posts its own balanced journal, no stock/return movement', async () => {
      const { invoice, tag } = await makeSoldInvoice(10000);
      const lineId = invoice.items[0].id;
      const clientBefore = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: lineId, amount: 5150 }], reasonCode: 'POST_SALE_DISCOUNT', reasonNotes: 'goodwill' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(cn.id);
      expect(cn.salesReturnId).toBeNull();
      expect(Number(cn.totalAmount)).toBeCloseTo(5150, 2);
      expect(Number(cn.taxableAmount)).toBeCloseTo(5000, 2);
      expect(Number(cn.cgst)).toBeCloseTo(75, 2);
      expect(Number(cn.sgst)).toBeCloseTo(75, 2);

      const returns = await prisma.salesReturn.findMany({ where: { invoiceId: invoice.id } });
      expect(returns).toHaveLength(0);
      const freshTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(freshTag.status).toBe('SOLD'); // no physical movement

      const entry = await getJournalEntry(cn.id);
      expect(entry).toBeTruthy();
      expect(entry!.isPosted).toBe(true);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).credit).toBeCloseTo(5150, 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.SALES_REVENUE).debit).toBeCloseTo(5000, 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.CGST_PAYABLE).debit).toBeCloseTo(75, 2);
      const totalDebit = Number(entry!.totalDebit);
      const totalCredit = Number(entry!.totalCredit);
      expect(totalDebit).toBeCloseTo(totalCredit, 2); // balanced

      const clientAfter = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(Number(clientAfter.currentBalance)).toBeCloseTo(Number(clientBefore.currentBalance) - 5150, 2);
    });

    it('multiple partial credit notes: exact remaining amount is allowed, one paisa more is rejected', async () => {
      const { invoice } = await makeSoldInvoice(10000);
      const lineId = invoice.items[0].id;

      const first = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: lineId, amount: 5150 }], reasonCode: 'CORRECTION_IN_INVOICE' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(first.id);

      // Exact remaining amount — allowed.
      const second = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: lineId, amount: 5150 }], reasonCode: 'CORRECTION_IN_INVOICE' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(second.id);

      // Now fully credited (10300 of 10300) — one paisa more must be rejected.
      await expect(createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: lineId, amount: 0.01 }], reasonCode: 'CORRECTION_IN_INVOICE' },
        tenant.ctx, userId,
      )).rejects.toThrow(/Over-credit/);
    });

    it('a value-only line (no invoiceItemId) is not subject to the per-line over-credit guard', async () => {
      const { invoice } = await makeSoldInvoice(4000);
      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ description: 'Flat goodwill adjustment', taxableValue: 1000 }], reasonCode: 'DEFICIENCY_IN_SERVICE' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(cn.id);
      expect(Number(cn.taxableAmount)).toBeCloseTo(1000, 2);
      expect(Number(cn.totalTax)).toBeCloseTo(30, 2);
      expect(Number(cn.totalAmount)).toBeCloseTo(1030, 2);
      const items = await tenantQuery(tenant.company.id, (tx) => tx.creditNoteItem.findMany({ where: { creditNoteId: cn.id } }));
      expect(items[0].invoiceItemId).toBeNull();
    });

    it('rejects an invalid reason code, and OTHER without reasonNotes', async () => {
      const { invoice } = await makeSoldInvoice(3000);
      await expect(createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 100 }], reasonCode: 'NOT_A_REAL_CODE' },
        tenant.ctx, userId,
      )).rejects.toThrow(/Invalid reason code/);

      await expect(createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 100 }], reasonCode: 'OTHER' },
        tenant.ctx, userId,
      )).rejects.toThrow(/reasonNotes is required/);
    });
  });

  // G2g-3a: CreditNoteItem UQC/quantity persistence. Path A (physical return) knows a real
  // quantity — the whole tagged line came back; Path B (value-only, even when linked to a real
  // invoiceItemId) never fabricates one. uqc is inherited from the source line/HSN on every path.
  describe('UQC / quantity snapshot (G2g-3a)', () => {
    it('Path A (return-wrapped) inherits uqc and persists the source line\'s own quantity', async () => {
      const { invoice } = await makeSoldInvoice(7000);
      const sourceLine = invoice.items[0];
      expect(sourceLine.uqc).toBe('GMS'); // DEFAULT_HSN_CODE (7113) defaults to GMS

      const result = await createSalesReturn(
        { invoiceId: invoice.id, items: [{ invoiceItemId: sourceLine.id }] },
        tenant.ctx, userId, { issueCreditNote: true },
      );
      salesReturnIds.push(result.id);
      creditNoteIds.push(result.creditNote!.id);

      const items = await tenantQuery(tenant.company.id, (tx) => tx.creditNoteItem.findMany({ where: { creditNoteId: result.creditNote!.id } }));
      expect(items).toHaveLength(1);
      expect(items[0].uqc).toBe('GMS');
      expect(Number(items[0].quantity)).toBe(sourceLine.quantity);
    });

    it('Path B linked to a real invoiceItemId inherits uqc but leaves quantity null (value-only, not a physical return)', async () => {
      const { invoice } = await makeSoldInvoice(6500);
      const sourceLine = invoice.items[0];

      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: sourceLine.id, amount: 1030 }], reasonCode: 'POST_SALE_DISCOUNT' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(cn.id);

      const items = await tenantQuery(tenant.company.id, (tx) => tx.creditNoteItem.findMany({ where: { creditNoteId: cn.id } }));
      expect(items[0].uqc).toBe('GMS');
      expect(items[0].quantity).toBeNull();
    });

    it('Path B value-only (no invoiceItemId) snapshots uqc from its own HSN default and leaves quantity null', async () => {
      const { invoice } = await makeSoldInvoice(4200);
      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ description: 'Flat goodwill adjustment', taxableValue: 500 }], reasonCode: 'DEFICIENCY_IN_SERVICE' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(cn.id);

      const items = await tenantQuery(tenant.company.id, (tx) => tx.creditNoteItem.findMany({ where: { creditNoteId: cn.id } }));
      expect(items[0].invoiceItemId).toBeNull();
      expect(items[0].uqc).toBe('GMS'); // DEFAULT_HSN_CODE (7113) defaults to GMS
      expect(items[0].quantity).toBeNull();
    });
  });

  describe('Invoice lifecycle guards', () => {
    it('a Credit Note against a VOID invoice is rejected', async () => {
      const { invoice } = await makeSoldInvoice(2000);
      await voidInvoice(invoice.id, tenant.ctx, userId, 'test void');
      await expect(createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 100 }], reasonCode: 'OTHER', reasonNotes: 'n/a' },
        tenant.ctx, userId,
      )).rejects.toThrow(/voided/);
    });

    it('a Credit Note against an IRN\'d invoice is allowed — the intended post-IRN correction path', async () => {
      const { invoice } = await makeSoldInvoice(2000);
      await prisma.taxInvoice.update({ where: { invoiceId: invoice.id }, data: { irn: 'TEST-IRN-12345', isEInvoice: true } });
      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 500 }], reasonCode: 'CORRECTION_IN_INVOICE' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(cn.id);
      expect(cn.id).toBeTruthy();
    });

    it('amendInvoice is blocked from touching a line a Credit Note already referenced', async () => {
      const tagA = await makeTag(3000);
      const tagB = await makeTag(4000);
      const invoice = await createInvoice({
        clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
        items: [
          { productCode: 'A', description: 'Ring A', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 3000, tagId: tagA.id },
          { productCode: 'B', description: 'Ring B', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 4000, tagId: tagB.id },
        ],
      });
      invoiceIds.push(invoice.id);
      const lineA = invoice.items.find((i: any) => i.productCode === 'A')!;
      const lineB = invoice.items.find((i: any) => i.productCode === 'B')!;

      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: lineA.id, amount: 500 }], reasonCode: 'CORRECTION_IN_INVOICE' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(cn.id);

      // Submitting only line B (dropping the credited line A) must be rejected.
      await expect(amendInvoice(invoice.id, {
        items: [{ id: lineB.id, productCode: 'B', description: 'Ring B', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 4000, tagId: tagB.id }],
      }, tenant.ctx, userId)).rejects.toThrow(/returned or credited/);
    });

    it('voidInvoice is blocked once a Credit Note exists against the invoice', async () => {
      const { invoice } = await makeSoldInvoice(2500);
      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 500 }], reasonCode: 'CORRECTION_IN_INVOICE' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(cn.id);
      await expect(voidInvoice(invoice.id, tenant.ctx, userId, 'test void'))
        .rejects.toThrow(/credit note/);
    });
  });

  describe('Cancellation', () => {
    it('cancelling a standalone credit note posts the exact inverse journal and restores the customer balance', async () => {
      const { invoice } = await makeSoldInvoice(6000);
      const clientBefore = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 6180 }], reasonCode: 'POST_SALE_DISCOUNT' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(cn.id);
      const clientAfterCredit = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(Number(clientAfterCredit.currentBalance)).toBeCloseTo(Number(clientBefore.currentBalance) - 6180, 2);

      const result = await cancelCreditNote(cn.id, tenant.ctx, userId, 'issued in error');
      expect(result.status).toBe('CANCELLED');

      const cancelEntry = await prisma.journalEntry.findFirst({
        where: { referenceId: cn.id, referenceType: 'CreditNoteCancellation' },
        include: { lines: { include: { account: { select: { code: true } } } } },
      });
      expect(cancelEntry).toBeTruthy();
      expect(lineAmount(cancelEntry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).debit).toBeCloseTo(6180, 2);
      expect(lineAmount(cancelEntry!, LEDGER_ACCOUNT.SALES_REVENUE).credit).toBeCloseTo(6000, 2);

      const clientAfterCancel = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(Number(clientAfterCancel.currentBalance)).toBeCloseTo(Number(clientBefore.currentBalance), 2);

      await expect(cancelCreditNote(cn.id, tenant.ctx, userId, 'again'))
        .rejects.toThrow(/already been cancelled/);
    });

    it('a return-linked (Path A) credit note cannot be independently cancelled', async () => {
      const { invoice } = await makeSoldInvoice(1500);
      const result = await createSalesReturn(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }] },
        tenant.ctx, userId, { issueCreditNote: true },
      );
      salesReturnIds.push(result.id);
      creditNoteIds.push(result.creditNote!.id);

      await expect(cancelCreditNote(result.creditNote!.id, tenant.ctx, userId, 'trying anyway'))
        .rejects.toThrow(/independently cancelled/);
    });
  });

  // G2g-3g-0.1: CreditNote numbering is generated per sellerRegistrationId (numberSequence.ts's
  // `CN:${sellerRegistrationId ?? 'LEGACY'}` key), but the old DB constraint
  // (companyId, creditNoteNumber) was company-wide — so a second GST registration's first note
  // ("CN-2026-000001") collided with the first registration's. Fixed by widening the unique
  // constraint to (companyId, sellerRegistrationId, creditNoteNumber), plus a partial index for
  // the legacy/NULL-registration group Postgres wouldn't otherwise de-duplicate on its own.
  describe('Registration-scoped numbering (G2g-3g-0.1)', () => {
    let branchB: string;
    let regAId: string;
    let regBId: string;

    beforeAll(async () => {
      // tenant.branch (the file's default `branchId`) is left on registration A — every earlier
      // test in this file already ran against no registration at all, so this only affects
      // invoices created from here on. branchB is new and gets registration B.
      const branch2 = await addBranch(tenant.company.id, `${suffix}-cn-reg`);
      branchB = branch2.id;
      const regA = await createGstRegistration(tenant.ctx, {
        gstin: '24CNREG0001A1Z5', legalName: 'CN Registration A', stateCode: '24',
      });
      const regB = await createGstRegistration(tenant.ctx, {
        gstin: '27CNREG0002B1Z8', legalName: 'CN Registration B', stateCode: '27',
      });
      regAId = regA.id;
      regBId = regB.id;
      await updateBranch(branchId, tenant.company.id, { gstRegistrationId: regAId });
      await updateBranch(branchB, tenant.company.id, { gstRegistrationId: regBId });
    });

    async function makeSoldInvoiceOnBranch(price: number, branch: string) {
      const tag = await makeTag(price);
      const invoice = await createInvoice({
        clientId, branchId: branch, invoiceDate: new Date(), invoiceType: 'RETAIL',
        items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: price, tagId: tag.id }],
      });
      invoiceIds.push(invoice.id);
      return { invoice, tag };
    }

    async function creditFullInvoice(invoice: any) {
      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }], reasonCode: 'CORRECTION_IN_INVOICE' },
        tenant.ctx, userId,
      );
      creditNoteIds.push(cn.id);
      return cn;
    }

    it('the same registration issues sequential numbers; a different registration starts its own count at 1 (Path B)', async () => {
      const { invoice: invA1 } = await makeSoldInvoiceOnBranch(1000, branchId);
      const { invoice: invA2 } = await makeSoldInvoiceOnBranch(1100, branchId);
      const { invoice: invB1 } = await makeSoldInvoiceOnBranch(1200, branchB);

      const cnA1 = await creditFullInvoice(invA1);
      const cnA2 = await creditFullInvoice(invA2);
      const cnB1 = await creditFullInvoice(invB1);

      expect(cnA1.sellerRegistrationId).toBe(regAId);
      expect(cnA2.sellerRegistrationId).toBe(regAId);
      expect(cnB1.sellerRegistrationId).toBe(regBId);

      // Registration A: sequential (its own counter, wherever it currently stands).
      const numA1 = Number(cnA1.creditNoteNumber.split('-')[2]);
      const numA2 = Number(cnA2.creditNoteNumber.split('-')[2]);
      expect(numA2).toBe(numA1 + 1);

      // Registration B's first note under this key is exactly 1 — NOT rejected as a duplicate of
      // registration A's, which is exactly the bug this migration fixes (the pre-fix constraint
      // would have thrown P2002 on whichever of these two inserted second). It may even be the
      // textually IDENTICAL string as registration A's own first note ("CN-2026-000001") — that
      // coexistence, disambiguated only by sellerRegistrationId, is the point of the fix.
      expect(cnB1.creditNoteNumber).toMatch(/^CN-\d{4}-000001$/);
    });

    it('registration sequence isolation holds across several notes each (1,2,3 vs 1,2)', async () => {
      const regAStart = Number((await creditFullInvoice((await makeSoldInvoiceOnBranch(500, branchId)).invoice)).creditNoteNumber.split('-')[2]);
      const regBStart = Number((await creditFullInvoice((await makeSoldInvoiceOnBranch(600, branchB)).invoice)).creditNoteNumber.split('-')[2]);

      const a2 = await creditFullInvoice((await makeSoldInvoiceOnBranch(500, branchId)).invoice);
      const a3 = await creditFullInvoice((await makeSoldInvoiceOnBranch(500, branchId)).invoice);
      const b2 = await creditFullInvoice((await makeSoldInvoiceOnBranch(600, branchB)).invoice);

      expect(Number(a2.creditNoteNumber.split('-')[2])).toBe(regAStart + 1);
      expect(Number(a3.creditNoteNumber.split('-')[2])).toBe(regAStart + 2);
      expect(Number(b2.creditNoteNumber.split('-')[2])).toBe(regBStart + 1);
    });

    it('Path A (return-wrapped) also numbers per-registration, not company-wide', async () => {
      const { invoice: invA } = await makeSoldInvoiceOnBranch(2000, branchId);
      const { invoice: invB } = await makeSoldInvoiceOnBranch(2100, branchB);

      const resultA = await createSalesReturn(
        { invoiceId: invA.id, items: [{ invoiceItemId: invA.items[0].id }] }, tenant.ctx, userId, { issueCreditNote: true },
      );
      salesReturnIds.push(resultA.id);
      creditNoteIds.push(resultA.creditNote!.id);

      const resultB = await createSalesReturn(
        { invoiceId: invB.id, items: [{ invoiceItemId: invB.items[0].id }] }, tenant.ctx, userId, { issueCreditNote: true },
      );
      salesReturnIds.push(resultB.id);
      creditNoteIds.push(resultB.creditNote!.id);

      expect(resultA.creditNote!.sellerRegistrationId).toBe(regAId);
      expect(resultB.creditNote!.sellerRegistrationId).toBe(regBId);
      // Different registrations may legitimately land on the identical number; the important
      // fact is that BOTH inserts succeeded (this used to throw P2002 for whichever ran second).
      expect(resultA.creditNote!.id).not.toBe(resultB.creditNote!.id);
    });

    it('concurrent creation: two notes under the SAME registration never collide, and simultaneous FIRST notes under two DIFFERENT registrations both succeed', async () => {
      // Invoices/tags are set up sequentially (their own numbering is unrelated to this fix and
      // not what's under test here); only the CreditNote creation itself races.
      const invA1 = (await makeSoldInvoiceOnBranch(700, branchId)).invoice;
      const invA2 = (await makeSoldInvoiceOnBranch(700, branchId)).invoice;

      // Same registration, concurrent: must both succeed with two different numbers (the
      // atomic sequence, unchanged by this fix, already guarantees this — asserted here as a
      // regression check now that the DB constraint is registration-scoped instead of global).
      const sameRegResults = await Promise.allSettled([creditFullInvoice(invA1), creditFullInvoice(invA2)]);
      expect(sameRegResults.every((r) => r.status === 'fulfilled')).toBe(true);
      const sameRegNumbers = (sameRegResults as PromiseFulfilledResult<any>[]).map((r) => r.value.creditNoteNumber);
      expect(new Set(sameRegNumbers).size).toBe(2);

      // Two DIFFERENT registrations, both creating their very first concurrent-timed note: this
      // is the exact race the old company-wide constraint could lose (two inserts racing for the
      // same "first number" slot) — both must succeed, not just one.
      const invA3 = (await makeSoldInvoiceOnBranch(800, branchId)).invoice;
      const invB1 = (await makeSoldInvoiceOnBranch(800, branchB)).invoice;
      const crossRegResults = await Promise.allSettled([creditFullInvoice(invA3), creditFullInvoice(invB1)]);
      expect(crossRegResults.every((r) => r.status === 'fulfilled')).toBe(true);
    });

    it('a Credit Note remains inaccessible to another company (tenant isolation unaffected by the registration-scoped constraint)', async () => {
      const { invoice } = await makeSoldInvoiceOnBranch(900, branchId);
      const cn = await creditFullInvoice(invoice);

      const other = await createTestTenant(`${suffix}-cn-other`, []);
      try {
        await expect(getCreditNoteById(other.ctx, cn.id)).rejects.toMatchObject({ statusCode: 404 });
      } finally {
        await cleanupTestTenant(other);
      }

      // Owning company can still read it fine.
      const own = await getCreditNoteById(tenant.ctx, cn.id);
      expect(own.id).toBe(cn.id);
    });
  });
});
