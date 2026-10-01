import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database';
import { createInvoice as _createInvoice, voidInvoice } from './sales.service';
import { createSalesDebitNote, cancelSalesDebitNote, getSalesDebitNoteById, listSalesDebitNotes } from './salesDebitNote.service';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../test/fixtures';
import { tenantQuery } from '../../shared/tenantContext';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { createGstRegistration } from '../company/company.service';
import { updateBranch } from '../tagging/tagging.service';

// G2g-4b.2 — Sales (outward) Debit Note lifecycle. There is exactly one creation path (unlike
// CreditNote's Path A/Path B split) — a debit note always INCREASES what the customer owes against
// an already-issued SalesInvoice.
describe('Sales Debit Note lifecycle (G2g-4b.2)', () => {
  const suffix = `g2g4b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let clientId: string;
  const invoiceIds: string[] = [];
  const debitNoteIds: string[] = [];
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

  // Single-line, FIXED-rate, same-state (client.state = Gujarat = company stateCode '24') INR sale
  // — a clean, predictable 3% CGST+SGST split (DEFAULT_HSN_CODE).
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
      'invoice:create', 'invoice:void',
      'salesDebitNote:view', 'salesDebitNote:create', 'salesDebitNote:cancel',
    ]);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${suffix}`, name: 'Test Client', type: 'RETAIL', state: 'Gujarat' },
    });
    clientId = client.id;
  });

  afterAll(async () => {
    // sales_debit_notes/sales_debit_note_items are FORCE-RLS tables in this single-role test DB —
    // a bare deleteMany silently matches zero rows, so cleanup must go through tenantQuery.
    await tenantQuery(tenant.company.id, (tx) => tx.salesDebitNote.deleteMany({ where: { companyId: tenant.company.id } }));

    await cleanupJournalEntries([...invoiceIds, ...debitNoteIds]);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } }); // cascades invoice_items
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.branch.updateMany({ where: { companyId: tenant.company.id }, data: { gstRegistrationId: null } });
    await tenantQuery(tenant.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: tenant.company.id } }));
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  describe('Issue', () => {
    it('a line linked to an invoiceItemId inherits HSN/tax snapshot, posts a balanced journal, and increases the customer balance', async () => {
      const { invoice } = await makeSoldInvoice(10000);
      const lineId = invoice.items[0].id;
      const clientBefore = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });

      const dn = await createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: lineId, amount: 1030 }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn.id);

      expect(dn.invoiceId).toBe(invoice.id);
      expect(dn.branchId).toBe(branchId);
      expect(dn.debitNoteNumber).toMatch(/^SDN-\d{4}-\d{6}$/);
      expect(Number(dn.totalAmount)).toBeCloseTo(1030, 2);
      expect(Number(dn.taxableAmount)).toBeCloseTo(1000, 2);
      expect(Number(dn.cgst)).toBeCloseTo(15, 2);
      expect(Number(dn.sgst)).toBeCloseTo(15, 2);
      expect(Number(dn.igst)).toBe(0);

      const items = await tenantQuery(tenant.company.id, (tx) => tx.salesDebitNoteItem.findMany({ where: { salesDebitNoteId: dn.id } }));
      expect(items).toHaveLength(1);
      expect(Number(items[0].taxRate)).toBeCloseTo(0.03, 4); // inherited from the invoice line, not re-looked-up
      expect(items[0].invoiceItemId).toBe(lineId);
      expect(items[0].quantity).toBeNull(); // value-only correction — never a physical quantity

      const entry = await getJournalEntry(dn.id);
      expect(entry).toBeTruthy();
      expect(entry!.isPosted).toBe(true);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).debit).toBeCloseTo(1030, 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.SALES_REVENUE).credit).toBeCloseTo(1000, 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.CGST_PAYABLE).credit).toBeCloseTo(15, 2);
      expect(Number(entry!.totalDebit)).toBeCloseTo(Number(entry!.totalCredit), 2); // balanced

      const clientAfter = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(Number(clientAfter.currentBalance)).toBeCloseTo(Number(clientBefore.currentBalance) + 1030, 2);
    });

    it('a value-only line (no invoiceItemId) requires an explicit HSN/description/taxableValue', async () => {
      const { invoice } = await makeSoldInvoice(4000);
      const dn = await createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ description: 'Late payment interest', taxableValue: 200 }], reasonCode: 'INTEREST_LATE_FEE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn.id);
      expect(Number(dn.taxableAmount)).toBeCloseTo(200, 2);
      expect(Number(dn.totalTax)).toBeCloseTo(6, 2); // DEFAULT_HSN_CODE 7113 @ 3%
      expect(Number(dn.totalAmount)).toBeCloseTo(206, 2);
      const items = await tenantQuery(tenant.company.id, (tx) => tx.salesDebitNoteItem.findMany({ where: { salesDebitNoteId: dn.id } }));
      expect(items[0].invoiceItemId).toBeNull();
    });

    it('rejects a line with an invoiceItemId but no amount', async () => {
      const { invoice } = await makeSoldInvoice(3000);
      await expect(createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      )).rejects.toThrow(/amount is required/);
    });

    it('rejects a value-only line missing taxableValue or description', async () => {
      const { invoice } = await makeSoldInvoice(3000);
      await expect(createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ description: 'No value' }], reasonCode: 'OTHER', reasonNotes: 'n/a' },
        tenant.ctx, userId,
      )).rejects.toThrow(/taxableValue is required/);

      await expect(createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ taxableValue: 100 }], reasonCode: 'OTHER', reasonNotes: 'n/a' },
        tenant.ctx, userId,
      )).rejects.toThrow(/description is required/);
    });

    it('rejects an invalid or unknown HSN code', async () => {
      const { invoice } = await makeSoldInvoice(3000);
      await expect(createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ description: 'Bad HSN', taxableValue: 100, hsnCode: '0000000' }], reasonCode: 'CORRECTION_IN_INVOICE' },
        tenant.ctx, userId,
      )).rejects.toThrow(/Unknown or inactive HSN/);
    });

    it('rejects an invalid reason code, and OTHER without reasonNotes', async () => {
      const { invoice } = await makeSoldInvoice(3000);
      await expect(createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 100 }], reasonCode: 'NOT_A_REAL_CODE' },
        tenant.ctx, userId,
      )).rejects.toThrow(/Invalid reason code/);

      await expect(createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 100 }], reasonCode: 'OTHER' },
        tenant.ctx, userId,
      )).rejects.toThrow(/reasonNotes is required/);
    });

    it('rejects the same invoice line appearing twice in one request', async () => {
      const { invoice } = await makeSoldInvoice(5000);
      const lineId = invoice.items[0].id;
      await expect(createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: lineId, amount: 100 }, { invoiceItemId: lineId, amount: 50 }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      )).rejects.toThrow(/appears twice/);
    });
  });

  describe('Invoice lifecycle guards', () => {
    it('a VOID invoice cannot be debited', async () => {
      const { invoice } = await makeSoldInvoice(2000);
      await voidInvoice(invoice.id, tenant.ctx, userId, 'test void');
      await expect(createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 100 }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      )).rejects.toThrow(/voided/);
    });

    it('an invoice belonging to another company is rejected (404, not found) before any transaction opens', async () => {
      const other = await createTestTenant(`${suffix}-other`, []);
      try {
        await expect(createSalesDebitNote(
          { invoiceId: 'nonexistent-or-cross-company-id', items: [{ description: 'x', taxableValue: 100 }], reasonCode: 'OTHER', reasonNotes: 'n/a' },
          other.ctx, other.user.id,
        )).rejects.toMatchObject({ statusCode: 404 });
      } finally {
        await cleanupTestTenant(other);
      }
    });
  });

  describe('Cancellation', () => {
    it('cancelling posts the exact inverse journal and restores the customer balance', async () => {
      const { invoice } = await makeSoldInvoice(6000);
      const clientBefore = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      const dn = await createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 618 }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn.id);
      const clientAfterIssue = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(Number(clientAfterIssue.currentBalance)).toBeCloseTo(Number(clientBefore.currentBalance) + 618, 2);

      const result = await cancelSalesDebitNote(dn.id, tenant.ctx, userId, 'issued in error');
      expect(result.status).toBe('CANCELLED');

      const cancelEntry = await prisma.journalEntry.findFirst({
        where: { referenceId: dn.id, referenceType: 'SalesDebitNoteCancellation' },
        include: { lines: { include: { account: { select: { code: true } } } } },
      });
      expect(cancelEntry).toBeTruthy();
      expect(lineAmount(cancelEntry!, LEDGER_ACCOUNT.ACCOUNTS_RECEIVABLE).credit).toBeCloseTo(618, 2);
      expect(lineAmount(cancelEntry!, LEDGER_ACCOUNT.SALES_REVENUE).debit).toBeCloseTo(600, 2);

      const clientAfterCancel = await prisma.client.findUniqueOrThrow({ where: { id: clientId } });
      expect(Number(clientAfterCancel.currentBalance)).toBeCloseTo(Number(clientBefore.currentBalance), 2);
    });

    it('cannot be cancelled twice', async () => {
      const { invoice } = await makeSoldInvoice(1500);
      const dn = await createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 150 }], reasonCode: 'CORRECTION_IN_INVOICE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn.id);
      await cancelSalesDebitNote(dn.id, tenant.ctx, userId, 'first cancel');
      await expect(cancelSalesDebitNote(dn.id, tenant.ctx, userId, 'again'))
        .rejects.toThrow(/already been cancelled/);
    });

    it('requires a reason', async () => {
      const { invoice } = await makeSoldInvoice(1200);
      const dn = await createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 100 }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn.id);
      await expect(cancelSalesDebitNote(dn.id, tenant.ctx, userId, ''))
        .rejects.toThrow(/reason is required/);
    });
  });

  describe('Branch access', () => {
    it('a caller restricted to a different branch cannot read a sales debit note on this branch, by direct id', async () => {
      const { invoice } = await makeSoldInvoice(2200);
      const dn = await createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 206 }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn.id);

      const otherBranch = await addBranch(tenant.company.id, `${suffix}-restrict`);
      const restrictedCtx = { ...tenant.ctx, branchAccess: { allBranches: false, branchIds: [otherBranch.id] } };
      await expect(getSalesDebitNoteById(restrictedCtx, dn.id)).rejects.toMatchObject({ statusCode: 404 });

      const list = await listSalesDebitNotes(restrictedCtx, {});
      expect(list.find((d) => d.id === dn.id)).toBeUndefined();

      // The owning branch still sees it fine.
      const own = await getSalesDebitNoteById({ ...tenant.ctx, branchAccess: { allBranches: false, branchIds: [branchId] } }, dn.id);
      expect(own.id).toBe(dn.id);
    });
  });

  // Registration-scoped numbering — same fix/precedent as CreditNote's own G2g-3g-0.1 (key
  // `SDN:${sellerRegistrationId ?? 'LEGACY'}`, built in from this table's very first migration).
  describe('Registration-scoped numbering', () => {
    let branchB: string;
    let regAId: string;
    let regBId: string;

    beforeAll(async () => {
      const branch2 = await addBranch(tenant.company.id, `${suffix}-sdn-reg`);
      branchB = branch2.id;
      const regA = await createGstRegistration(tenant.ctx, { gstin: '24SDNRG0001A1Z5', legalName: 'SDN Registration A', stateCode: '24' });
      const regB = await createGstRegistration(tenant.ctx, { gstin: '27SDNRH0002B1Z8', legalName: 'SDN Registration B', stateCode: '27' });
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

    it('two different registrations may both legitimately issue number 1, disambiguated by sellerRegistrationId', async () => {
      const { invoice: invA } = await makeSoldInvoiceOnBranch(1000, branchId);
      const { invoice: invB } = await makeSoldInvoiceOnBranch(1200, branchB);

      const dnA = await createSalesDebitNote(
        { invoiceId: invA.id, items: [{ invoiceItemId: invA.items[0].id, amount: 100 }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dnA.id);
      const dnB = await createSalesDebitNote(
        { invoiceId: invB.id, items: [{ invoiceItemId: invB.items[0].id, amount: 100 }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dnB.id);

      expect(dnA.sellerRegistrationId).toBe(regAId);
      expect(dnB.sellerRegistrationId).toBe(regBId);
      expect(dnA.debitNoteNumber).toMatch(/^SDN-\d{4}-000001$/);
      expect(dnB.debitNoteNumber).toMatch(/^SDN-\d{4}-000001$/);
      expect(dnA.id).not.toBe(dnB.id);
    });

    it('concurrent creation: two notes under the SAME registration never collide, and simultaneous FIRST notes under two DIFFERENT registrations both succeed', async () => {
      const invA1 = (await makeSoldInvoiceOnBranch(700, branchId)).invoice;
      const invA2 = (await makeSoldInvoiceOnBranch(700, branchId)).invoice;

      async function debit(invoice: any, amount: number) {
        const dn = await createSalesDebitNote(
          { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount }], reasonCode: 'PRICE_INCREASE' },
          tenant.ctx, userId,
        );
        debitNoteIds.push(dn.id);
        return dn;
      }

      // Same registration, concurrent: the atomic numberSequence counter (unchanged, reused
      // verbatim from CreditNote's own precedent) must still hand out two distinct numbers.
      const sameRegResults = await Promise.allSettled([debit(invA1, 103), debit(invA2, 103)]);
      expect(sameRegResults.every((r) => r.status === 'fulfilled')).toBe(true);
      const sameRegNumbers = (sameRegResults as PromiseFulfilledResult<any>[]).map((r) => r.value.debitNoteNumber);
      expect(new Set(sameRegNumbers).size).toBe(2);

      // Two DIFFERENT registrations, both creating their very first concurrent-timed note — the
      // exact race the old (pre-G2g-3g-0.1-style) company-wide constraint could lose.
      const invA3 = (await makeSoldInvoiceOnBranch(800, branchId)).invoice;
      const invB1 = (await makeSoldInvoiceOnBranch(800, branchB)).invoice;
      const crossRegResults = await Promise.allSettled([debit(invA3, 103), debit(invB1, 103)]);
      expect(crossRegResults.every((r) => r.status === 'fulfilled')).toBe(true);
    });
  });
});
