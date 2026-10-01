import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { AppError } from '../../middleware/error';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../../shared/constants';
import { createPO, createGRN, createPurchaseReturn } from './procurement.service';
import { createTagFromGrnItem } from '../tagging/tagging.service';
import {
  createStandaloneDebitNote, createDebitNoteForExistingReturn, cancelDebitNote,
  listDebitNotes, getDebitNoteById,
} from './debitNote.service';
import { getPurchaseGstSummary, getSupplierLedger, getDayBook } from '../finance/finance.service';
import { LEDGER_ACCOUNT } from '../../shared/ledgerAccounts';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from '../../test/ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../test/fixtures';
import { tenantQuery } from '../../shared/tenantContext';

// G2e — Debit Note lifecycle (Path A wraps a PurchaseReturn, Path B is a standalone value-only
// adjustment against a GRN). See the G2e task brief and PHASE_G2_GST_DOCUMENTS_LIFECYCLE_DESIGN.md
// §4/§7/§11-§13 for the design this proves.
describe('Debit Note lifecycle (G2e)', () => {
  const suffix = `g2e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let userId: string;
  let branchId: string;
  let stockTypeId: string;
  let categoryId: string;
  let sameStateSupplierId: string;   // GSTIN prefix 24 == company state 24
  let otherStateSupplierId: string;  // GSTIN prefix 27
  let unregisteredSupplierId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];
  const returnIds: string[] = [];
  const debitNoteIds: string[] = [];

  const line = (price: number, extra: Record<string, unknown> = {}) => ({
    materialCode: 'RING-DN', materialName: 'DN ring', materialType: FINISHED_GOODS_MATERIAL_TYPE,
    quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price, ...extra,
  });

  // PO -> GRN (finished goods, one piece) for `supplierId`, with no tag — just what a standalone
  // Debit Note needs: a GRN whose PoItem carries an authoritative pre-tax value + tax rate.
  async function intakeGrnOnly(supplierId: string, price: number) {
    const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(price)] }, tenant.ctx, userId);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(), branchId, invoiceNumber: `SUP-INV-DN-${poIds.length}`, invoiceDate: new Date(),
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
    }, tenant.ctx, userId);
    return { po, grn, grnId: grn.id };
  }

  // Same, but also tags the piece — what Path A (a Purchase Return) needs.
  async function intakeAndTag(supplierId: string, price: number) {
    const { po, grn, grnId } = await intakeGrnOnly(supplierId, price);
    const tag = await createTagFromGrnItem({
      grnItemId: grn.grnItems[0].id, stockTypeId, categoryId, name: 'DN ring', metalType: 'GOLD',
    }, tenant.ctx, userId);
    tagIds.push(tag.id);
    return { po, grn, grnId, tag };
  }

  const supplierDue = async (id: string) => Number((await prisma.supplier.findUniqueOrThrow({ where: { id } })).currentDue);

  beforeAll(async () => {
    tenant = await createTestTenant(`DN${suffix}`, ['po:create', 'grn:create', 'tag:create', 'po:approve']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;
    stockTypeId = (await prisma.stockType.create({
      data: { companyId: tenant.company.id, code: `D${suffix}`.slice(0, 8).toUpperCase(), name: 'DN Stock Type' },
    })).id;
    categoryId = (await prisma.productCategory.create({
      data: { companyId: tenant.company.id, code: `DNCAT-${suffix}`, name: 'DN Category' },
    })).id;
    const mk = async (code: string, extra: Record<string, unknown>) => (await prisma.supplier.create({
      data: { companyId: tenant.company.id, supplierCode: `${code}-${suffix}`, name: `Supplier ${code}`, type: 'OTHER', ...extra },
    })).id;
    sameStateSupplierId = await mk('DNSAME', { gstNumber: '24AAAAA0000A1Z5' });
    otherStateSupplierId = await mk('DNOTHER', { gstNumber: '27AAAAA0000A1Z5' });
    unregisteredSupplierId = await mk('DNURD', {});
  });

  afterAll(async () => {
    await cleanupJournalEntries([...tagIds, ...returnIds, ...debitNoteIds]);
    // debit_notes/debit_note_items are FORCE-RLS tables (same class as credit_notes — see
    // creditNote.service.test.ts's own note) — go through tenantQuery, not a bare deleteMany.
    await tenantQuery(tenant.company.id, (tx) => tx.debitNote.deleteMany({ where: { companyId: tenant.company.id } }));
    await prisma.purchaseReturn.deleteMany({ where: { id: { in: returnIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.auditLog.deleteMany({ where: { userId } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { id: { in: [sameStateSupplierId, otherStateSupplierId, unregisteredSupplierId] } } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  describe('Path A — wraps a Purchase Return', () => {
    it('issueDebitNote:true creates the return AND its debit note atomically, correctly linked, no second journal, balance moves once', async () => {
      const { tag, grnId } = await intakeAndTag(unregisteredSupplierId, 12000);
      const before = await supplierDue(unregisteredSupplierId);

      const result = await createPurchaseReturn(
        { items: [{ tagId: tag.id }], reason: 'Damaged on arrival' }, tenant.ctx, userId, { issueDebitNote: true },
      );
      returnIds.push(result.id);
      expect(result.debitNote).toBeTruthy();
      debitNoteIds.push(result.debitNote!.id);

      const dn = result.debitNote!;
      expect(dn.grnId).toBe(grnId);
      expect(dn.purchaseReturnId).toBe(result.id);
      expect(dn.reasonCode).toBe('PURCHASE_RETURN');
      expect(Number(dn.totalAmount)).toBeCloseTo(12000, 2);
      expect(dn.debitNoteNumber).toMatch(/^DN-/);

      // No second journal was posted under the debit note's own id — journalEntryId points at the
      // return's own entry instead.
      const returnEntry = await getJournalEntry(result.id);
      expect(returnEntry).toBeTruthy();
      expect(dn.journalEntryId).toBe(returnEntry!.id);
      const dnOwnEntries = await prisma.journalEntry.findMany({ where: { referenceId: dn.id } });
      expect(dnOwnEntries).toHaveLength(0);

      // Supplier balance moved exactly once — by the return, not a second time by the debit note.
      expect((await supplierDue(unregisteredSupplierId)) - before).toBeCloseTo(-12000, 2);

      const freshTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(freshTag.status).toBe('RETIRED');
    });

    it('createDebitNoteForExistingReturn wraps an existing return that had none, reusing its journal', async () => {
      const { tag } = await intakeAndTag(unregisteredSupplierId, 8000);
      const ret = await createPurchaseReturn({ items: [{ tagId: tag.id }], reason: 'Wrong item' }, tenant.ctx, userId);
      returnIds.push(ret.id);
      expect((ret as any).debitNote).toBeNull();

      const dn = await createDebitNoteForExistingReturn(ret.id, tenant.ctx, userId, { reasonNotes: 'Issued after the fact' });
      debitNoteIds.push(dn.id);
      expect(dn.purchaseReturnId).toBe(ret.id);
      expect(Number(dn.totalAmount)).toBeCloseTo(8000, 2);
      expect(dn.reasonNotes).toBe('Issued after the fact');

      const returnEntry = await getJournalEntry(ret.id);
      expect(dn.journalEntryId).toBe(returnEntry!.id);
    });

    it('rejects a second debit note against the same purchase return', async () => {
      const { tag } = await intakeAndTag(unregisteredSupplierId, 5000);
      const ret = await createPurchaseReturn({ items: [{ tagId: tag.id }] }, tenant.ctx, userId, { issueDebitNote: true });
      returnIds.push(ret.id);
      debitNoteIds.push(ret.debitNote!.id);

      await expect(createDebitNoteForExistingReturn(ret.id, tenant.ctx, userId)).rejects.toThrow(/already has a Debit Note/);
    });

    it('Path A cancellation is rejected — the underlying return is append-only', async () => {
      const { tag } = await intakeAndTag(unregisteredSupplierId, 6000);
      const ret = await createPurchaseReturn({ items: [{ tagId: tag.id }] }, tenant.ctx, userId, { issueDebitNote: true });
      returnIds.push(ret.id);
      debitNoteIds.push(ret.debitNote!.id);

      await expect(cancelDebitNote(ret.debitNote!.id, tenant.ctx, userId, 'trying anyway')).rejects.toThrow(/append-only/);
    });
  });

  describe('Path B — standalone (against a GRN, no physical return)', () => {
    it('same-state supplier: Dr Accounts Payable / Cr Inventory + Input CGST/SGST, supplier due decreases', async () => {
      const { grnId } = await intakeGrnOnly(sameStateSupplierId, 50000);
      const before = await supplierDue(sameStateSupplierId);

      const dn = await createStandaloneDebitNote(
        { grnId, items: [{ description: 'Price renegotiated', taxableValue: 10000 }], reasonCode: 'PRICE_VARIANCE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn.id);

      expect(dn.debitNoteNumber).toMatch(/^DN-/);
      expect(Number(dn.taxableAmount)).toBe(10000);
      expect(Number(dn.cgst)).toBeCloseTo(150, 2); // 3% of 10000, split same-state
      expect(Number(dn.sgst)).toBeCloseTo(150, 2);
      expect(Number(dn.igst)).toBe(0);
      expect(Number(dn.totalAmount)).toBeCloseTo(10300, 2);

      const entry = await getJournalEntry(dn.id);
      expect(entry!.referenceType).toBe('DebitNote');
      expect(lineAmount(entry!, LEDGER_ACCOUNT.ACCOUNTS_PAYABLE).debit).toBeCloseTo(10300, 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).credit).toBeCloseTo(10000, 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_CGST).credit).toBeCloseTo(150, 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_SGST).credit).toBeCloseTo(150, 2);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_IGST).credit).toBe(0);

      expect(before - (await supplierDue(sameStateSupplierId))).toBeCloseTo(10300, 2);
    });

    it('other-state supplier: books IGST instead', async () => {
      const { grnId } = await intakeGrnOnly(otherStateSupplierId, 50000);
      const dn = await createStandaloneDebitNote(
        { grnId, items: [{ description: 'Quality issue', taxableValue: 8000 }], reasonCode: 'QUALITY_DEDUCTION' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn.id);
      const entry = await getJournalEntry(dn.id);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_IGST).credit).toBeCloseTo(240, 2); // 3% of 8000
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_CGST).credit).toBe(0);
      expect(lineAmount(entry!, LEDGER_ACCOUNT.INPUT_SGST).credit).toBe(0);
    });

    it('rejects OTHER (no defined accounting treatment) and PURCHASE_RETURN (Path A only)', async () => {
      const { grnId } = await intakeGrnOnly(unregisteredSupplierId, 20000);
      await expect(
        createStandaloneDebitNote({ grnId, items: [{ description: 'x', taxableValue: 1000 }], reasonCode: 'OTHER' }, tenant.ctx, userId)
      ).rejects.toThrow(/no defined accounting treatment/);
      await expect(
        createStandaloneDebitNote({ grnId, items: [{ description: 'x', taxableValue: 1000 }], reasonCode: 'PURCHASE_RETURN' }, tenant.ctx, userId)
      ).rejects.toThrow(/only valid for a Debit Note issued against an existing Purchase Return/);
      await expect(
        createStandaloneDebitNote({ grnId, items: [{ description: 'x', taxableValue: 1000 }], reasonCode: 'NOT_A_REAL_CODE' }, tenant.ctx, userId)
      ).rejects.toThrow(/Invalid reason code/);
    });

    it('rejects an unknown HSN code, a zero taxableValue, and a missing description', async () => {
      const { grnId } = await intakeGrnOnly(unregisteredSupplierId, 20000);
      await expect(
        createStandaloneDebitNote({ grnId, items: [{ description: 'x', taxableValue: 1000, hsnCode: '0000' }], reasonCode: 'PRICE_VARIANCE' }, tenant.ctx, userId)
      ).rejects.toThrow(/Unknown or inactive HSN/);
      await expect(
        createStandaloneDebitNote({ grnId, items: [{ description: 'x', taxableValue: 0 }], reasonCode: 'PRICE_VARIANCE' }, tenant.ctx, userId)
      ).rejects.toThrow(/more than zero/);
      await expect(
        createStandaloneDebitNote({ grnId, items: [{ description: '  ', taxableValue: 500 }], reasonCode: 'PRICE_VARIANCE' }, tenant.ctx, userId)
      ).rejects.toThrow(/description is required/);
    });

    it('numbers sequentially as DN-<FY>-NNNNNN, company-scoped', async () => {
      const { grnId: g1 } = await intakeGrnOnly(unregisteredSupplierId, 20000);
      const { grnId: g2 } = await intakeGrnOnly(unregisteredSupplierId, 20000);
      const dn1 = await createStandaloneDebitNote({ grnId: g1, items: [{ description: 'a', taxableValue: 1000 }], reasonCode: 'PRICE_VARIANCE' }, tenant.ctx, userId);
      const dn2 = await createStandaloneDebitNote({ grnId: g2, items: [{ description: 'b', taxableValue: 1000 }], reasonCode: 'PRICE_VARIANCE' }, tenant.ctx, userId);
      debitNoteIds.push(dn1.id, dn2.id);
      const n1 = Number(dn1.debitNoteNumber.split('-').pop());
      const n2 = Number(dn2.debitNoteNumber.split('-').pop());
      expect(n2).toBe(n1 + 1);
    });
  });

  describe('Cancellation (Path B only)', () => {
    it('reverses the journal and restores the supplier balance; cannot be cancelled twice; requires a reason', async () => {
      const { grnId } = await intakeGrnOnly(unregisteredSupplierId, 30000);
      const before = await supplierDue(unregisteredSupplierId);
      const dn = await createStandaloneDebitNote(
        { grnId, items: [{ description: 'Correction', taxableValue: 5000 }], reasonCode: 'CORRECTION_IN_GRN' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn.id);
      expect(before - (await supplierDue(unregisteredSupplierId))).toBeCloseTo(5000, 2);

      await expect(cancelDebitNote(dn.id, tenant.ctx, userId, '')).rejects.toThrow(/reason is required/);

      const result = await cancelDebitNote(dn.id, tenant.ctx, userId, 'Renegotiated back');
      expect(result.status).toBe('CANCELLED');

      // Reversal journal is the exact inverse — nets to zero against the original.
      const entries = await prisma.journalEntry.findMany({ where: { referenceId: dn.id } });
      expect(entries).toHaveLength(2);
      expect(await supplierDue(unregisteredSupplierId)).toBeCloseTo(before, 2);

      // debit_notes is a FORCE-RLS table in this single-role test DB (same class as credit_notes —
      // see creditNote.service.test.ts's own note) — a bare read on the platform client sees zero
      // rows with no tenant context set, so this must go through tenantQuery.
      const fresh = await tenantQuery(tenant.company.id, (tx) => tx.debitNote.findUniqueOrThrow({ where: { id: dn.id } }));
      expect(fresh.status).toBe('CANCELLED');
      expect(fresh.cancelReason).toBe('Renegotiated back');

      await expect(cancelDebitNote(dn.id, tenant.ctx, userId, 'again')).rejects.toThrow(/already been cancelled/);
    });
  });

  describe('Over-debit protection (§11)', () => {
    it('caps combined Purchase Return + standalone Debit Notes at the GRN gross value, and a cancellation frees the value back up', async () => {
      // GRN gross ₹100,000 (unregistered supplier => no tax, so gross == taxable).
      const { tag, grnId } = await intakeAndTag(unregisteredSupplierId, 100000);

      const ret = await createPurchaseReturn({ items: [{ tagId: tag.id, amount: 30000 }], reason: 'Partial value adjustment' }, tenant.ctx, userId);
      returnIds.push(ret.id);

      const dn1 = await createStandaloneDebitNote(
        { grnId, items: [{ description: 'First adjustment', taxableValue: 20000 }], reasonCode: 'PRICE_VARIANCE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn1.id);
      // Available now: 100000 - 30000 - 20000 = 50000.

      await expect(
        createStandaloneDebitNote({ grnId, items: [{ description: 'Too much', taxableValue: 60000 }], reasonCode: 'PRICE_VARIANCE' }, tenant.ctx, userId)
      ).rejects.toThrow(/exceed the GRN's available value/);

      const dn2 = await createStandaloneDebitNote(
        { grnId, items: [{ description: 'Exactly the remainder', taxableValue: 50000 }], reasonCode: 'PRICE_VARIANCE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn2.id);

      // Fully consumed now — even ₹1 more is rejected.
      await expect(
        createStandaloneDebitNote({ grnId, items: [{ description: 'One rupee too many', taxableValue: 1 }], reasonCode: 'PRICE_VARIANCE' }, tenant.ctx, userId)
      ).rejects.toThrow(/exceed the GRN's available value/);

      // Cancelling dn2 frees its ₹50,000 back up.
      await cancelDebitNote(dn2.id, tenant.ctx, userId, 'redo');
      const dn3 = await createStandaloneDebitNote(
        { grnId, items: [{ description: 'Redone', taxableValue: 50000 }], reasonCode: 'PRICE_VARIANCE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn3.id);
      expect(Number(dn3.totalAmount)).toBeCloseTo(50000, 2);
    });

    it('two concurrent standalone Debit Notes against the same GRN cannot jointly exceed its value', async () => {
      const { grnId } = await intakeGrnOnly(unregisteredSupplierId, 100000);
      const attempt = (amount: number) => createStandaloneDebitNote(
        { grnId, items: [{ description: 'Race', taxableValue: amount }], reasonCode: 'PRICE_VARIANCE' },
        tenant.ctx, userId,
      );

      const results = await Promise.allSettled([attempt(60000), attempt(60000)]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(AppError);
      expect((rejected[0] as PromiseRejectedResult).reason.message).toMatch(/exceed the GRN's available value/);
      debitNoteIds.push((fulfilled[0] as PromiseFulfilledResult<any>).value.id);
    });
  });

  describe('Security / company isolation', () => {
    it('rejects a cross-company GRN on a standalone create, a cross-company return on Path A, and a cross-company id everywhere else', async () => {
      const other = await createTestTenant(`DNX${suffix}`, ['po:create', 'grn:create']);
      try {
        const foreignSupplier = await prisma.supplier.create({
          data: { companyId: other.company.id, supplierCode: `FOREIGN-DN-${suffix}`, name: 'Foreign', type: 'OTHER' },
        });
        const foreignPo = await createPO({ supplierId: foreignSupplier.id, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(10000)] }, other.ctx, other.user.id);
        const foreignGrn = await createGRN({
          poId: foreignPo.id, receivedDate: new Date(), branchId: other.branch.id,
          items: [{ poItemId: foreignPo.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
        }, other.ctx, other.user.id);

        await expect(
          createStandaloneDebitNote({ grnId: foreignGrn.id, items: [{ description: 'x', taxableValue: 100 }], reasonCode: 'PRICE_VARIANCE' }, tenant.ctx, userId)
        ).rejects.toThrow(/not found/i);

        const foreignTag = await prisma.jewelryTag.create({
          data: {
            tagNumber: `FOREIGN-DN-TAG-${suffix}`, companyId: other.company.id, branchId: other.branch.id,
            name: 'Foreign', metalType: 'GOLD', grossWeight: 5, netWeight: 5, stoneWeight: 0,
            costPrice: 10000, sellingPrice: 12000, grnItemId: foreignGrn.grnItems[0].id, status: 'IN_STOCK',
            createdById: other.user.id,
          },
        });
        const foreignReturn = await createPurchaseReturn({ items: [{ tagId: foreignTag.id }] }, other.ctx, other.user.id);
        await expect(createDebitNoteForExistingReturn(foreignReturn.id, tenant.ctx, userId)).rejects.toThrow(/not found/i);

        await prisma.purchaseReturn.deleteMany({ where: { id: foreignReturn.id } });
        await prisma.jewelryTag.deleteMany({ where: { id: foreignTag.id } });
        await prisma.goodsReceiptNote.deleteMany({ where: { id: foreignGrn.id } });
        await prisma.purchaseOrder.deleteMany({ where: { id: foreignPo.id } });
        await prisma.supplier.deleteMany({ where: { id: foreignSupplier.id } });
      } finally {
        await cleanupTestTenant(other);
      }

      // A well-formed but nonexistent/cross-company debit note id, on both remaining entry points.
      await expect(getDebitNoteById(tenant.ctx, 'not-a-real-id')).rejects.toThrow(/not found/i);
      await expect(cancelDebitNote('not-a-real-id', tenant.ctx, userId, 'x')).rejects.toThrow(/not found/i);
    });
  });

  describe('List / detail', () => {
    it('lists and filters company-scoped debit notes, and getDebitNoteById returns full detail', async () => {
      const { grnId } = await intakeGrnOnly(unregisteredSupplierId, 40000);
      const dn = await createStandaloneDebitNote(
        { grnId, items: [{ description: 'For listing', taxableValue: 4000 }], reasonCode: 'SHORT_SUPPLY' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(dn.id);

      const all = await listDebitNotes(tenant.ctx, {});
      expect(all.some((d) => d.id === dn.id)).toBe(true);

      const filtered = await listDebitNotes(tenant.ctx, { grnId, status: 'ISSUED' });
      expect(filtered.map((d) => d.id)).toContain(dn.id);

      const detail = await getDebitNoteById(tenant.ctx, dn.id);
      expect(detail.items).toHaveLength(1);
      expect(detail.items[0].description).toBe('For listing');
      expect(detail.grn.id).toBe(grnId);
      expect(detail.supplier.name).toBe('Supplier DNURD');
    });
  });

  describe('Reporting integration', () => {
    it('getPurchaseGstSummary nets an active standalone Debit Note, excludes a cancelled one and a Path A one', async () => {
      const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const to = new Date(Date.now() + 24 * 60 * 60 * 1000);

      const { grnId } = await intakeGrnOnly(sameStateSupplierId, 20000);
      const active = await createStandaloneDebitNote(
        { grnId, items: [{ description: 'Netted', taxableValue: 2000 }], reasonCode: 'PRICE_VARIANCE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(active.id);

      const before = await getPurchaseGstSummary(tenant.company.id, from, to);
      const rowBefore = before.rows.find((r) => r.hsnCode === '7113' && Math.abs(r.taxRate - 0.03) < 0.0001);
      const netTaxableBefore = rowBefore ? rowBefore.taxableValue : 0;

      // Cancel it and re-check: the netting must disappear once cancelled.
      await cancelDebitNote(active.id, tenant.ctx, userId, 'undo for the assertion below');
      const afterCancel = await getPurchaseGstSummary(tenant.company.id, from, to);
      const rowAfterCancel = afterCancel.rows.find((r) => r.hsnCode === '7113' && Math.abs(r.taxRate - 0.03) < 0.0001);
      const netTaxableAfterCancel = rowAfterCancel ? rowAfterCancel.taxableValue : 0;

      // Cancelling removes exactly the -2000 this debit note contributed.
      expect(netTaxableAfterCancel - netTaxableBefore).toBeCloseTo(2000, 2);
    });

    it('getSupplierLedger shows an active standalone Debit Note as DEBIT_NOTE, and a Path A one does not double-count against its own Purchase Return row', async () => {
      const { tag } = await intakeAndTag(sameStateSupplierId, 15000);
      const ret = await createPurchaseReturn({ items: [{ tagId: tag.id }] }, tenant.ctx, userId, { issueDebitNote: true });
      returnIds.push(ret.id);
      debitNoteIds.push(ret.debitNote!.id);

      // A separate GRN for the standalone leg — the Path A return above already consumes the full
      // value of its own GRN, so the standalone note must not compete with it for the same budget.
      const { grnId: standaloneGrnId } = await intakeGrnOnly(sameStateSupplierId, 5000);
      const standalone = await createStandaloneDebitNote(
        { grnId: standaloneGrnId, items: [{ description: 'Standalone ledger check', taxableValue: 1000 }], reasonCode: 'PRICE_VARIANCE' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(standalone.id);

      const ledger = await getSupplierLedger(tenant.ctx, sameStateSupplierId);
      const debitNoteRefNumbers = ledger.rows.filter((r) => r.type === 'DEBIT_NOTE').map((r) => r.refNumber);
      // The standalone note IS a ledger movement in its own right...
      expect(debitNoteRefNumbers).toContain(standalone.debitNoteNumber);
      // ...but the Path A one is not a second ledger movement (its value is already the PURCHASE/
      // RETURN rows above) — this supplier may carry other suppliers' own unrelated standalone
      // notes from earlier tests too, so this checks absence, not an exact overall count.
      expect(debitNoteRefNumbers).not.toContain(ret.debitNote!.debitNoteNumber);
    });

    it('getDayBook includes an active standalone Debit Note, excludes a cancelled one and a Path A one', async () => {
      const today = new Date();
      const { tag } = await intakeAndTag(unregisteredSupplierId, 9000);
      const ret = await createPurchaseReturn({ items: [{ tagId: tag.id }] }, tenant.ctx, userId, { issueDebitNote: true });
      returnIds.push(ret.id);
      debitNoteIds.push(ret.debitNote!.id);

      // A separate GRN for the standalone leg — see the identical note in the supplier-ledger test above.
      const { grnId: standaloneGrnId } = await intakeGrnOnly(unregisteredSupplierId, 5000);
      const standalone = await createStandaloneDebitNote(
        { grnId: standaloneGrnId, items: [{ description: 'Day book check', taxableValue: 700 }], reasonCode: 'CORRECTION_IN_GRN' },
        tenant.ctx, userId,
      );
      debitNoteIds.push(standalone.id);

      const dayBook = await getDayBook(tenant.company.id, today);
      expect(dayBook.debitNotes.rows.map((r) => r.debitNoteNumber)).toContain(standalone.debitNoteNumber);
      expect(dayBook.debitNotes.rows.map((r) => r.debitNoteNumber)).not.toContain(ret.debitNote!.debitNoteNumber);

      await cancelDebitNote(standalone.id, tenant.ctx, userId, 'remove from day book');
      const dayBookAfter = await getDayBook(tenant.company.id, today);
      expect(dayBookAfter.debitNotes.rows.map((r) => r.debitNoteNumber)).not.toContain(standalone.debitNoteNumber);
    });
  });
});
