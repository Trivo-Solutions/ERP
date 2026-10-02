import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { AppError } from '../middleware/error';
import { tenantQuery } from '../shared/tenantContext';
import { FINISHED_GOODS_MATERIAL_TYPE } from '../shared/constants';
import { createGstRegistration } from '../modules/company/company.service';
import { createPO, createGRN } from '../modules/procurement/procurement.service';
import { createTagFromGrnItem } from '../modules/tagging/tagging.service';
import { markRcmLiabilityPaid, listRcmLiabilities } from '../modules/finance/gst/gstr3bRcmBooking.service';
import { LEDGER_ACCOUNT } from '../shared/ledgerAccounts';
import { cleanupJournalEntries, getJournalEntry, lineAmount } from './ledger';
import { createTestTenant, cleanupTestTenant, TestTenant } from './fixtures';

// ═══════════════════════════════════════════════════════════════════════════
// G2g-7d — Inward RCM foundation: integration tests for bookRcmLiabilityIfApplicable (wired into
// createTagFromGrnItem) and markRcmLiabilityPaid. PHASE_G2G7D_AUDIT.md's own "foundation only"
// decision means almost every PoItem line in real data has rcmCategory NONE — the headline
// regression this suite exists to prove is that such a line is COMPLETELY unaffected (same tag,
// same ordinary journal, zero RcmLiability rows), while an explicitly-flagged line produces the
// expected liability/self-invoice/journal shape.
//
// rcm_liabilities/self_invoices are FORCE ROW LEVEL SECURITY even for the platform/owner test role
// (same precedent as company_gst_registrations, CLAUDE.md §11) — every read of either table in
// this file goes through tenantQuery, never a bare platformPrisma call, or it would silently see
// zero rows (the policy filters on app.tenant_company_id, which a bare call never sets).
//
// Known limitation this suite deliberately documents rather than silently works around:
// createPO does not force taxRate=0 when a line's rcmCategory is a notified category — under
// genuine RCM the supplier's bill should carry no GST (the recipient self-assesses it separately
// via RcmLiability), so a line combining a notified rcmCategory with a positive taxRate would
// double-book: once as ordinary input GST, once as self-assessed RCM tax. This phase relies on
// correct operator entry (an RCM line's taxRate explicitly 0) rather than an automatic guard — see
// PHASE_G2G7D_IMPLEMENTATION.md's known-limitations section.
// ═══════════════════════════════════════════════════════════════════════════

describe('G2g-7d: inward RCM booking (bookRcmLiabilityIfApplicable / markRcmLiabilityPaid)', () => {
  const suffix = `g2g7d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let A: TestTenant;
  let B: TestTenant;
  let stockTypeId: string;
  let categoryId: string;
  let registeredSupplierId: string;
  let unregisteredSupplierId: string;
  const poIds: string[] = [];
  const tagIds: string[] = [];

  function findRcmLiability(companyId: string, where: Record<string, unknown>) {
    return tenantQuery(companyId, (tx) => tx.rcmLiability.findFirst({ where: { companyId, ...where } }));
  }
  function findSelfInvoice(companyId: string, where: Record<string, unknown>) {
    return tenantQuery(companyId, (tx) => tx.selfInvoice.findFirst({ where: { companyId, ...where } }));
  }

  const line = (price: number, extra: Record<string, unknown> = {}) => ({
    materialCode: 'G7D-RING', materialName: 'G2g7d ring', materialType: FINISHED_GOODS_MATERIAL_TYPE,
    quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price, ...extra,
  });

  async function intake(supplierId: string, price: number, lineExtra: Record<string, unknown> = {}) {
    const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [line(price, lineExtra)] }, A.ctx, A.user.id);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(), branchId: A.branch.id, invoiceNumber: `G7D-INV-${poIds.length}`, invoiceDate: new Date(),
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
    }, A.ctx, A.user.id);
    const tag = await createTagFromGrnItem({
      grnItemId: grn.grnItems[0].id, stockTypeId, categoryId, name: 'G2g7d ring', metalType: 'GOLD',
    }, A.ctx, A.user.id);
    tagIds.push(tag.id);
    return { po, grn, tag, grnItemId: grn.grnItems[0].id };
  }

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['po:create', 'grn:create', 'tag:create', 'journal:create', 'report:financial_view']);
    B = await createTestTenant(`${suffix}B`, ['journal:create']);
    stockTypeId = (await prisma.stockType.create({
      data: { companyId: A.company.id, code: `G7D${suffix}`.slice(0, 8).toUpperCase(), name: 'G2g7d Stock Type' },
    })).id;
    categoryId = (await prisma.productCategory.create({
      data: { companyId: A.company.id, code: `G7DCAT-${suffix}`, name: 'G2g7d Category' },
    })).id;
    registeredSupplierId = (await prisma.supplier.create({
      data: { companyId: A.company.id, supplierCode: `G7D-SUP-R-${suffix}`, name: 'G2g7d Registered Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z8' },
    })).id;
    unregisteredSupplierId = (await prisma.supplier.create({
      data: { companyId: A.company.id, supplierCode: `G7D-SUP-U-${suffix}`, name: 'G2g7d Unregistered Supplier', type: 'OTHER' },
    })).id;
    // A primary, active GST registration so buyerRegistrationId resolves to something — without
    // one, every RCM-flagged line would classify RCM_UNRESOLVED (RCM_REGISTRATION_UNASSIGNED),
    // which is covered separately below.
    await createGstRegistration(A.ctx, { gstin: '24AAAAA1000A1Z5', legalName: 'G2g7d Primary Co', stateCode: '24' });
  });

  afterAll(async () => {
    await tenantQuery(A.company.id, (tx) => tx.selfInvoice.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.rcmLiability.deleteMany({ where: { companyId: A.company.id } }));
    await cleanupJournalEntries(tagIds);
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: [A.user.id, B.user.id] } } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.supplier.deleteMany({ where: { companyId: A.company.id } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await tenantQuery(A.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: A.company.id } }));
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  it('creates NO RcmLiability for an ordinary line (rcmCategory NONE/unset) — the overwhelming common case', async () => {
    const { grnItemId, tag } = await intake(registeredSupplierId, 45000);
    const liability = await findRcmLiability(A.company.id, { grnItemId });
    expect(liability).toBeNull();

    // The ordinary journal (Dr Inventory / Cr Accounts Payable + ordinary Input GST) is still
    // posted exactly as before — this line's booking path is completely unaffected.
    const entry = await getJournalEntry(tag.id);
    expect(entry).not.toBeNull();
    expect(lineAmount(entry!, LEDGER_ACCOUNT.INVENTORY).debit).toBeCloseTo(45000);
  });

  it('creates a confirmed RcmLiability + journal for a notified-category line from a REGISTERED supplier — self-invoice NOT required', async () => {
    const { grnItemId } = await intake(registeredSupplierId, 20000, { rcmCategory: 'GTA_FREIGHT', taxRate: 0 });
    const liability = await findRcmLiability(A.company.id, { grnItemId });
    expect(liability).not.toBeNull();

    expect(liability!.rcmCategory).toBe('GTA_FREIGHT');
    expect(Number(liability!.taxableValue)).toBe(20000);
    expect(liability!.selfInvoiceRequirement).toBe('SELF_INVOICE_NOT_REQUIRED');
    expect(liability!.paymentVoucherRequirement).toBe('PAYMENT_VOUCHER_REQUIRED');
    expect(liability!.status).toBe('LIABILITY_RECOGNIZED');
    expect(liability!.journalEntryId).not.toBeNull();

    const selfInvoice = await findSelfInvoice(A.company.id, { rcmLiabilityId: liability!.id });
    expect(selfInvoice).toBeNull();

    // Dr RCM Input Tax Credit / Cr RCM Tax Payable — never mixed into the ordinary Input GST /
    // Accounts Payable accounts.
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: liability!.journalEntryId! }, include: { lines: { include: { account: true } } } });
    const rcmItc = entry.lines.find((l) => l.account.code === LEDGER_ACCOUNT.RCM_INPUT_TAX_CREDIT);
    const rcmPayable = entry.lines.find((l) => l.account.code === LEDGER_ACCOUNT.RCM_TAX_PAYABLE);
    expect(Number(rcmItc?.debit)).toBeGreaterThan(0);
    expect(Number(rcmPayable?.credit)).toBe(Number(rcmItc?.debit));
  });

  it('requires a self-invoice for a notified-category line from an UNREGISTERED supplier, FY-numbered per registration', async () => {
    const { grnItemId } = await intake(unregisteredSupplierId, 15000, { rcmCategory: 'LEGAL_SERVICES', taxRate: 0 });
    const liability = await findRcmLiability(A.company.id, { grnItemId });
    expect(liability!.selfInvoiceRequirement).toBe('SELF_INVOICE_REQUIRED');

    const selfInvoice = await findSelfInvoice(A.company.id, { rcmLiabilityId: liability!.id });
    expect(selfInvoice).not.toBeNull();
    expect(selfInvoice!.supplierId).toBe(unregisteredSupplierId);
    expect(selfInvoice!.selfInvoiceNumber).toMatch(/^SELFINV-\d{4}-\d{6}$/);
    expect(Number(selfInvoice!.taxableValue)).toBe(15000);
    expect(selfInvoice!.status).toBe('ISSUED');
  });

  it('flags RCM_UNRESOLVED (RCM_REGISTRATION_UNASSIGNED) and posts no journal when no GST registration resolves, but still records the liability as a fact', async () => {
    // B has no CompanyGstRegistration at all.
    const bStockType = await prisma.stockType.create({ data: { companyId: B.company.id, code: `G7DB${suffix}`.slice(0, 8).toUpperCase(), name: 'B Stock Type' } });
    const bCategory = await prisma.productCategory.create({ data: { companyId: B.company.id, code: `G7DBCAT-${suffix}`, name: 'B Category' } });
    const bSupplier = await prisma.supplier.create({ data: { companyId: B.company.id, supplierCode: `G7DB-SUP-${suffix}`, name: 'B Supplier', type: 'OTHER', gstNumber: '24AAAAA2000A1Z5' } });

    const po = await createPO({ supplierId: bSupplier.id, poType: 'OUTRIGHT', orderDate: new Date(), items: [{ ...line(5000, { rcmCategory: 'SECURITY_SERVICES', taxRate: 0 }) }] }, B.ctx, B.user.id);
    const grn = await createGRN({ poId: po.id, receivedDate: new Date(), branchId: B.branch.id, items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }] }, B.ctx, B.user.id);
    const tag = await createTagFromGrnItem({ grnItemId: grn.grnItems[0].id, stockTypeId: bStockType.id, categoryId: bCategory.id, name: 'B ring', metalType: 'GOLD' }, B.ctx, B.user.id);

    const liability = await findRcmLiability(B.company.id, { grnItemId: grn.grnItems[0].id });
    expect(liability).not.toBeNull();
    expect(liability!.gstRegistrationId).toBeNull();
    expect(liability!.journalEntryId).toBeNull(); // unresolved — never posted as a confirmed fact
    expect(liability!.status).toBe('LIABILITY_RECOGNIZED');

    // cleanup this test's own fixtures (outside the shared afterAll's A-only cleanup)
    await tenantQuery(B.company.id, (tx) => tx.rcmLiability.deleteMany({ where: { id: liability!.id } }));
    await cleanupJournalEntries([tag.id]);
    await prisma.jewelryTag.deleteMany({ where: { id: tag.id } });
    await prisma.goodsReceiptNote.deleteMany({ where: { id: grn.id } });
    await prisma.purchaseOrder.deleteMany({ where: { id: po.id } });
    await prisma.supplier.deleteMany({ where: { id: bSupplier.id } });
    await prisma.stockType.deleteMany({ where: { id: bStockType.id } });
    await prisma.productCategory.deleteMany({ where: { id: bCategory.id } });
  });

  describe('markRcmLiabilityPaid', () => {
    it('flips status to TAX_PAID and posts Dr RCM Tax Payable / Cr Cash-or-Bank', async () => {
      const { grnItemId } = await intake(registeredSupplierId, 9000, { rcmCategory: 'DIRECTOR_SERVICES', taxRate: 0 });
      const liability = await findRcmLiability(A.company.id, { grnItemId });

      const paid = await markRcmLiabilityPaid(A.ctx, liability!.id, { paymentDate: new Date(), mode: 'BANK' }, A.user.id);
      expect(paid.status).toBe('TAX_PAID');
      expect(paid.paymentJournalEntryId).not.toBeNull();

      const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: paid.paymentJournalEntryId! }, include: { lines: { include: { account: true } } } });
      const payable = entry.lines.find((l) => l.account.code === LEDGER_ACCOUNT.RCM_TAX_PAYABLE);
      const bank = entry.lines.find((l) => l.account.code === LEDGER_ACCOUNT.BANK_ACCOUNT);
      expect(Number(payable?.debit)).toBeGreaterThan(0);
      expect(Number(bank?.credit)).toBe(Number(payable?.debit));

      const auditEntry = await prisma.auditLog.findFirst({ where: { tableName: 'rcm_liabilities', recordId: liability!.id, action: 'EDIT' } });
      expect(auditEntry).not.toBeNull();
    });

    it('rejects marking an already-paid liability as paid again', async () => {
      const { grnItemId } = await intake(registeredSupplierId, 8000, { rcmCategory: 'SPONSORSHIP', taxRate: 0 });
      const liability = await findRcmLiability(A.company.id, { grnItemId });
      await markRcmLiabilityPaid(A.ctx, liability!.id, { paymentDate: new Date(), mode: 'CASH' }, A.user.id);
      await expect(markRcmLiabilityPaid(A.ctx, liability!.id, { paymentDate: new Date(), mode: 'CASH' }, A.user.id)).rejects.toThrow(AppError);
    });

    it('404s on a nonexistent liability id', async () => {
      await expect(markRcmLiabilityPaid(A.ctx, 'does-not-exist', { paymentDate: new Date(), mode: 'CASH' }, A.user.id)).rejects.toThrow(AppError);
    });

    it('cannot mark another company\'s liability as paid (cross-company)', async () => {
      const { grnItemId } = await intake(registeredSupplierId, 7000, { rcmCategory: 'RENT_A_CAB', taxRate: 0 });
      const liability = await findRcmLiability(A.company.id, { grnItemId });
      await expect(markRcmLiabilityPaid(B.ctx, liability!.id, { paymentDate: new Date(), mode: 'CASH' }, B.user.id)).rejects.toThrow(AppError);
      // Confirm it was NOT silently paid under the attacker's company.
      const unchanged = await findRcmLiability(A.company.id, { id: liability!.id });
      expect(unchanged!.status).toBe('LIABILITY_RECOGNIZED');
    });
  });

  it('listRcmLiabilities returns only this company\'s own liabilities', async () => {
    const result = await listRcmLiabilities(A.ctx, {});
    expect(result.rows.every((r) => r.companyId === A.company.id)).toBe(true);
    expect(result.total).toBeGreaterThan(0);
  });
});
