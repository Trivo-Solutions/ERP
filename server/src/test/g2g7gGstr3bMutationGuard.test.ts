import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { FINISHED_GOODS_MATERIAL_TYPE, FINISHED_LOT_MATERIAL_TYPE } from '../shared/constants';
import { createInvoice as _createInvoice, amendInvoice, voidInvoice, createSalesReturn } from '../modules/sales/sales.service';
import { createStandaloneCreditNote, cancelCreditNote } from '../modules/sales/creditNote.service';
import { createSalesDebitNote, cancelSalesDebitNote } from '../modules/sales/salesDebitNote.service';
import { createPO, createGRN, createPurchaseReturn } from '../modules/procurement/procurement.service';
import { createStandaloneDebitNote, cancelDebitNote } from '../modules/procurement/debitNote.service';
import { createTagFromGrnItem } from '../modules/tagging/tagging.service';
import { markRcmLiabilityPaid } from '../modules/finance/gst/gstr3bRcmBooking.service';
import { createGstRegistration } from '../modules/company/company.service';
import { assertGstr3bPeriodMutable, findGstr3bFilingProtection } from '../modules/finance/gst/gstr3bFilingProtection';
import { resolveFilingPeriodMmYYYY } from '../modules/finance/gst/gstr3bReporting.service';
import { getFinancialYearForDate } from '../shared/financialYear';
import { tenantQuery, tenantTransaction } from '../shared/tenantContext';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from './fixtures';
import { cleanupJournalEntries } from './ledger';

// ═══════════════════════════════════════════════════════════════════════════
// G2g-7g close-out — GSTR-3B Filing Mutation Protection. Proves the guard
// (gstr3bFilingProtection.ts: assertGstr3bPeriodMutable / findGstr3bFilingProtection) this phase
// adds, AND that it is actually wired into every real mutation path named in the brief — not just
// the helper in isolation (brief §11's own hard requirement).
//
// Unlike the GSTR-1 guard (g2g6dGstr1MutationGuard.test.ts), which protects by DOCUMENT IDENTITY
// via a snapshot's traceability array, this guard is purely DATE-based (see
// gstr3bFilingProtection.ts's own header for why) — a document's own effective date, checked
// against the ONE GstReturnPeriod (returnType='GSTR3B') for its exact company+registration+period.
// Fixtures therefore never need to hand-construct a snapshot/attempt's traceability JSON — only a
// GstReturnPeriod row at the desired status, for "the current month" (every mutation under test is
// dated "now" by default, so no backdating is needed either).
//
// Each "blocked" family below uses its OWN fresh GST registration + branch (`freshReg()`), created
// per test rather than shared — this sidesteps any ordering dependency between "create prerequisite
// data while the period is still OPEN" and "then file it" for families that mutate something that
// must already exist (amend/void/return/cancel/settle), which a single shared pre-filed
// registration could never support (the prerequisite itself would already be blocked).
// ═══════════════════════════════════════════════════════════════════════════

const GSTR3B_RETURN_TYPE = 'GSTR3B';

describe('G2g-7g: GSTR-3B filing mutation protection', () => {
  const suffix = `g7g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let tenant: TestTenant;
  let other: TestTenant; // a wholly different company, for tenant-isolation tests
  let userId: string;
  let supplierId: string;
  let clientId: string;
  let stockTypeId: string;
  let categoryId: string;

  const invoiceIds: string[] = [];
  const tagIds: string[] = [];
  const poIds: string[] = [];
  const returnIds: string[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];
  const branchIds: string[] = [];
  let regCounter = 0;

  function currentPeriod() {
    const now = new Date();
    return { financialYear: getFinancialYearForDate(now), taxPeriod: resolveFilingPeriodMmYYYY(now) };
  }

  /** A fresh, non-primary GST registration + a dedicated branch pointing at it — so a document
   *  created through that branch is unambiguously attributed to this exact registration, isolated
   *  from every other test in this file. */
  async function freshReg(label: string, gstin?: string) {
    regCounter += 1;
    const reg = await createGstRegistration(tenant.ctx, {
      gstin: gstin ?? `24AAAAA${String(regCounter).padStart(4, '0')}A1Z5`, legalName: `G7g ${label} ${suffix}`,
      stateCode: '24', isPrimary: false, isActive: true,
    });
    regRows.push({ id: reg.id, companyId: tenant.company.id });
    const branch = await addBranch(tenant.company.id, `${label}${regCounter}${suffix}`.slice(0, 20));
    branchIds.push(branch.id);
    await prisma.branch.update({ where: { id: branch.id }, data: { gstRegistrationId: reg.id } });
    return { reg, branch };
  }

  /** Sets (creates or updates) THIS MONTH's GSTR-3B return period for `gstRegistrationId` to
   *  `status` — the one fact the guard reads. No snapshot/attempt row needed (brief §4: the guard
   *  never infers from those; it reads GstReturnPeriod.status directly). */
  async function setPeriodStatus(companyId: string, gstRegistrationId: string, status: string) {
    const { financialYear, taxPeriod } = currentPeriod();
    return tenantQuery(companyId, (tx) => tx.gstReturnPeriod.upsert({
      where: {
        companyId_gstRegistrationId_returnType_financialYear_taxPeriod: {
          companyId, gstRegistrationId, returnType: GSTR3B_RETURN_TYPE, financialYear, taxPeriod,
        },
      },
      create: { companyId, gstRegistrationId, returnType: GSTR3B_RETURN_TYPE, financialYear, taxPeriod, status },
      update: { status },
    }));
  }

  function createInvoice(data: Omit<Parameters<typeof _createInvoice>[0], 'branchId'> & { branchId: string }) {
    return _createInvoice(data, tenant.ctx, userId);
  }

  async function makeTag(branchId: string, price: number) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `G7GTAG-${suffix}-${tagIds.length}`, companyId: tenant.company.id, branchId,
        name: 'Ring', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, stoneWeight: 0,
        costPrice: price * 0.8, sellingPrice: price, createdById: userId,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }

  // A plain, FIXED-rate, free-text (no tag) invoice — no inventory needed at all, simplest possible
  // SalesInvoice-creating fixture, reused by every outward-side test that just needs "an invoice".
  async function makeInvoice(branchId: string, price: number) {
    const invoice = await createInvoice({
      clientId, branchId, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: price }],
    });
    invoiceIds.push(invoice.id);
    return invoice;
  }

  const poLine = (price: number, extra: Record<string, unknown> = {}) => ({
    materialCode: 'G7G-RING', materialName: 'G7g ring', materialType: FINISHED_GOODS_MATERIAL_TYPE,
    quantity: 1, weight: 8, unit: 'PC', karat: '22K', ratePerUnit: price, ...extra,
  });

  /** PO -> GRN (finished goods, one piece) received at `branchId`, no tag yet — what a standalone
   *  purchase Debit Note needs. */
  async function intakeGrnOnly(branchId: string, price: number, lineExtra: Record<string, unknown> = {}) {
    const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [poLine(price, lineExtra)] }, tenant.ctx, userId);
    poIds.push(po.id);
    const grn = await createGRN({
      poId: po.id, receivedDate: new Date(), branchId, invoiceNumber: `G7G-INV-${poIds.length}`, invoiceDate: new Date(),
      items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 8, scaleWeight: 8 }],
    }, tenant.ctx, userId);
    return { po, grn, grnItemId: grn.grnItems[0].id, grnId: grn.id };
  }

  beforeAll(async () => {
    tenant = await createTestTenant(suffix, [
      'invoice:create', 'invoice:edit', 'invoice:void', 'return:create', 'payment:create',
      'creditNote:create', 'creditNote:cancel', 'salesDebitNote:create', 'salesDebitNote:cancel',
      'po:create', 'grn:create', 'tag:create', 'journal:create',
    ]);
    other = await createTestTenant(`xco-${suffix}`, ['invoice:create']);
    userId = tenant.user.id;

    stockTypeId = (await prisma.stockType.create({
      data: { companyId: tenant.company.id, code: `G7G${suffix}`.slice(0, 8).toUpperCase(), name: 'G7g Stock Type' },
    })).id;
    categoryId = (await prisma.productCategory.create({
      data: { companyId: tenant.company.id, code: `G7GCAT-${suffix}`, name: 'G7g Category' },
    })).id;
    supplierId = (await prisma.supplier.create({
      // A real, checksum-valid GSTIN (same literal gstr3bRcmBooking.test.ts's own "registered
      // supplier" fixture uses) — determineSelfInvoiceRequirement() runs the real GSTIN checksum
      // (shared/gstin.ts), so a made-up-but-format-valid GSTIN would fail it and force
      // SELF_INVOICE_REQUIRED on every RCM-category line below, which this suite's repeated
      // fresh-registration pattern would then collide on (nextDocumentNumber's SELFINV sequence
      // formats the same "001" for each registration's own first self-invoice) — an unrelated,
      // pre-existing characteristic of that numbering scheme, not something this phase touches.
      data: { companyId: tenant.company.id, supplierCode: `G7G-SUP-${suffix}`, name: 'G7g Supplier', type: 'OTHER', gstNumber: '24AAAAA0000A1Z8' },
    })).id;
    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `G7GCL-${suffix}`, name: 'G7g Client', type: 'RETAIL', state: 'Gujarat' },
    });
    clientId = client.id;
  });

  afterAll(async () => {
    for (const r of regRows) {
      // Same order as g2g6dGstr1MutationGuard.test.ts's own afterAll — the E2E test built real
      // snapshot/attempt rows that RESTRICT-FK back to their period, so both must be cleared
      // (filed-pointer columns nulled first, since a snapshot/attempt can itself be a period's own
      // filedSnapshotId/filedByAttemptId) before the period row can be deleted.
      const periods = await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.findMany({ where: { gstRegistrationId: r.id, returnType: GSTR3B_RETURN_TYPE }, select: { id: true } }));
      const ids = periods.map((p) => p.id);
      if (ids.length > 0) {
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.updateMany({ where: { id: { in: ids } }, data: { filedSnapshotId: null, filedByAttemptId: null } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingAttempt.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingSnapshot.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.deleteMany({ where: { id: { in: ids } } }));
      }
    }
    await tenantQuery(tenant.company.id, (tx) => tx.rcmLiability.deleteMany({ where: { companyId: tenant.company.id } }));
    await tenantQuery(tenant.company.id, (tx) => tx.selfInvoice.deleteMany({ where: { companyId: tenant.company.id } }));
    await tenantQuery(tenant.company.id, (tx) => tx.debitNote.deleteMany({ where: { companyId: tenant.company.id } }));
    await tenantQuery(tenant.company.id, (tx) => tx.creditNote.deleteMany({ where: { companyId: tenant.company.id } }));
    await tenantQuery(tenant.company.id, (tx) => tx.salesDebitNote.deleteMany({ where: { companyId: tenant.company.id } }));
    await prisma.purchaseReturn.deleteMany({ where: { id: { in: returnIds } } });
    await prisma.jewelryTag.updateMany({ where: { companyId: tenant.company.id, purchaseLotId: { not: null } }, data: { purchaseLotId: null } });
    await prisma.purchaseLot.deleteMany({ where: { grnItem: { grn: { poId: { in: poIds } } } } });
    await cleanupJournalEntries([...invoiceIds, ...tagIds, ...returnIds]);
    await prisma.salesReturn.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.goodsReceiptNote.deleteMany({ where: { poId: { in: poIds } } });
    await prisma.purchaseOrder.deleteMany({ where: { id: { in: poIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.supplier.deleteMany({ where: { id: supplierId } });
    await prisma.stockType.deleteMany({ where: { id: stockTypeId } });
    await prisma.productCategory.deleteMany({ where: { id: categoryId } });
    await prisma.auditLog.deleteMany({ where: { userId: { in: [userId, other.user.id] } } });
    await prisma.branch.updateMany({ where: { id: { in: branchIds } }, data: { gstRegistrationId: null } });
    for (const r of regRows) {
      await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    }
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
    await cleanupTestTenant(tenant);
    await cleanupTestTenant(other);
    await prisma.$disconnect();
  });

  // ─── Pure guard — status matrix + isolation (brief §11 "Positive"/"Tenant/security") ──────────

  describe('findGstr3bFilingProtection — status matrix and isolation', () => {
    it('no period at all for this registration -> not protected', async () => {
      const { reg } = await freshReg('nope');
      await tenantTransaction(tenant.company.id, async (tx) => {
        const result = await findGstr3bFilingProtection(tx, tenant.company.id, reg.id, new Date());
        expect(result).toBeNull();
      });
    });

    it.each(['OPEN', 'SNAPSHOT_CREATED', 'FILING_ATTEMPTED'])('period status %s -> not protected', async (status) => {
      const { reg } = await freshReg(`st${status.slice(0, 3)}`);
      await setPeriodStatus(tenant.company.id, reg.id, status);
      await tenantTransaction(tenant.company.id, async (tx) => {
        const result = await findGstr3bFilingProtection(tx, tenant.company.id, reg.id, new Date());
        expect(result).toBeNull();
      });
    });

    it.each(['FILED', 'LOCKED'])('period status %s -> protected', async (status) => {
      const { reg } = await freshReg(`pr${status.slice(0, 3)}`);
      await setPeriodStatus(tenant.company.id, reg.id, status);
      await tenantTransaction(tenant.company.id, async (tx) => {
        const result = await findGstr3bFilingProtection(tx, tenant.company.id, reg.id, new Date());
        expect(result).not.toBeNull();
        expect(result!.status).toBe(status);
      });
    });

    it('a different tax period for the SAME filed registration is not protected', async () => {
      const { reg } = await freshReg('diffper');
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');
      const farFuture = new Date(Date.UTC(2099, 0, 15));
      await tenantTransaction(tenant.company.id, async (tx) => {
        const result = await findGstr3bFilingProtection(tx, tenant.company.id, reg.id, farFuture);
        expect(result).toBeNull();
      });
    });

    it('a different GST registration (same company) is not protected by the first one\'s filing', async () => {
      const { reg: filedReg } = await freshReg('isoA');
      const { reg: otherReg } = await freshReg('isoB');
      await setPeriodStatus(tenant.company.id, filedReg.id, 'FILED');
      await tenantTransaction(tenant.company.id, async (tx) => {
        const protectedRight = await findGstr3bFilingProtection(tx, tenant.company.id, filedReg.id, new Date());
        expect(protectedRight).not.toBeNull();
        const protectedWrong = await findGstr3bFilingProtection(tx, tenant.company.id, otherReg.id, new Date());
        expect(protectedWrong).toBeNull();
      });
    });

    it('a cross-company filed period never protects this company\'s own companyId + registration id', async () => {
      const otherReg = await createGstRegistration(other.ctx, {
        gstin: '27AAAAA0000A1Z2', legalName: `G7g Other Co ${suffix}`, stateCode: '27', isPrimary: true, isActive: true,
      });
      await setPeriodStatus(other.company.id, otherReg.id, 'FILED');

      // Querying from OUR OWN company's context, even reusing the SAME registration id string
      // (impossible in practice since ids are globally unique, but proves the companyId filter is
      // load-bearing, not merely "never reached the same id").
      await tenantTransaction(tenant.company.id, async (tx) => {
        const result = await findGstr3bFilingProtection(tx, tenant.company.id, otherReg.id, new Date());
        expect(result).toBeNull();
      });

      await tenantQuery(other.company.id, (tx) => tx.gstReturnPeriod.deleteMany({ where: { gstRegistrationId: otherReg.id } }));
      await tenantQuery(other.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: otherReg.id } }));
    });

    it('assertGstr3bPeriodMutable no-ops (never protected) when gstRegistrationId is null/undefined', async () => {
      await tenantTransaction(tenant.company.id, async (tx) => {
        await expect(assertGstr3bPeriodMutable(tx, tenant.company.id, {
          documentType: 'SALES_INVOICE', documentId: 'none', gstRegistrationId: null, documentDate: new Date(), action: 'created',
        })).resolves.toBeUndefined();
      });
    });
  });

  // ─── Outward: Sales Invoice (create / amend / void) ───────────────────────────────────────────

  describe('Sales Invoice', () => {
    it('an OPEN period does not block creating, amending, or voiding an invoice', async () => {
      const { branch } = await freshReg('invopen');
      const invoice = await makeInvoice(branch.id, 5000);
      const l = invoice.items[0];
      const amended = await amendInvoice(invoice.id, {
        items: [{
          id: l.id, productCode: l.productCode, description: 'Amended', quantity: l.quantity,
          grossWeight: Number(l.grossWeight), netGoldWeight: Number(l.netGoldWeight), rateType: l.rateType,
          goldRate: Number(l.goldRate), makingCharge: Number(l.makingCharge), wastagePercent: Number(l.wastagePercent), stoneValue: Number(l.stoneValue),
        }],
      }, tenant.ctx, userId);
      expect(amended.items[0].description).toBe('Amended');

      const invoice2 = await makeInvoice(branch.id, 5100);
      const voided = await voidInvoice(invoice2.id, tenant.ctx, userId, 'test void');
      expect(voided.status).toBe('VOID');
    });

    it('a FILED period blocks creating a brand-new invoice dated into it', async () => {
      const { reg, branch } = await freshReg('invcreate');
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');
      await expect(makeInvoice(branch.id, 6000)).rejects.toMatchObject({
        statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE'),
      });
    });

    it('a FILED period blocks amending an existing invoice, which is left unchanged', async () => {
      const { reg, branch } = await freshReg('invamend');
      const invoice = await makeInvoice(branch.id, 6100);
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(amendInvoice(invoice.id, {
        items: [{ id: invoice.items[0].id, productCode: invoice.items[0].productCode, description: 'Changed', quantity: 1,
          grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 6100, makingCharge: 0, wastagePercent: 0, stoneValue: 0 }],
      }, tenant.ctx, userId)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE') });

      const fresh = await prisma.invoiceItem.findUniqueOrThrow({ where: { id: invoice.items[0].id } });
      expect(fresh.description).toBe('Ring');
    });

    it('a LOCKED period blocks voiding an existing invoice, which is left unchanged', async () => {
      const { reg, branch } = await freshReg('invvoid');
      const invoice = await makeInvoice(branch.id, 6200);
      await setPeriodStatus(tenant.company.id, reg.id, 'LOCKED');

      await expect(voidInvoice(invoice.id, tenant.ctx, userId, 'test void')).rejects.toMatchObject({
        statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE'),
      });

      const fresh = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(fresh.status).not.toBe('VOID');
    });

    it('a GSTR3B_MUTATION_BLOCKED audit entry is recorded for the rejected void attempt', async () => {
      const { reg, branch } = await freshReg('invaudit');
      const invoice = await makeInvoice(branch.id, 6300);
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(voidInvoice(invoice.id, tenant.ctx, userId, 'test void')).rejects.toMatchObject({ statusCode: 409 });

      const audit = await prisma.auditLog.findFirst({ where: { recordId: invoice.id, action: 'GSTR3B_MUTATION_BLOCKED' } });
      expect(audit).toBeTruthy();
      expect((audit!.newValues as any).documentType).toBe('SALES_INVOICE');
      expect((audit!.newValues as any).attemptedAction).toBe('voided');
    });
  });

  // ─── Outward: Sales Return ─────────────────────────────────────────────────────────────────────

  describe('Sales Return', () => {
    it('a FILED period (for the return\'s own, current-month date) blocks a new Sales Return, and the sold tag is left untouched', async () => {
      const { reg, branch } = await freshReg('retblk');
      const tag = await makeTag(branch.id, 7000);
      const invoice = await createInvoice({
        clientId, branchId: branch.id, invoiceDate: new Date(), invoiceType: 'RETAIL',
        items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 7000, tagId: tag.id }],
      });
      invoiceIds.push(invoice.id);
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(createSalesReturn(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }] }, tenant.ctx, userId,
      )).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE') });

      const freshTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(freshTag.status).toBe('SOLD');
    });

    it('an OPEN period allows the same Sales Return', async () => {
      const { branch } = await freshReg('retopen');
      const tag = await makeTag(branch.id, 7100);
      const invoice = await createInvoice({
        clientId, branchId: branch.id, invoiceDate: new Date(), invoiceType: 'RETAIL',
        items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 7100, tagId: tag.id }],
      });
      invoiceIds.push(invoice.id);

      const ret = await createSalesReturn({ invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }] }, tenant.ctx, userId);
      expect(ret.invoiceId).toBe(invoice.id);
    });
  });

  // ─── Outward: Credit Note / Sales Debit Note (create + cancel) ────────────────────────────────

  describe('Credit Note', () => {
    it('a FILED period blocks creating a new standalone Credit Note', async () => {
      const { reg, branch } = await freshReg('cncreate');
      const invoice = await makeInvoice(branch.id, 8000);
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }], reasonCode: 'POST_SALE_DISCOUNT' }, tenant.ctx, userId,
      )).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE') });
    });

    it('a LOCKED period blocks cancelling an existing (unfiled-when-created) Credit Note, which is left unchanged', async () => {
      const { reg, branch } = await freshReg('cncancel');
      const invoice = await makeInvoice(branch.id, 8100);
      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 500 }], reasonCode: 'POST_SALE_DISCOUNT' }, tenant.ctx, userId,
      );
      await setPeriodStatus(tenant.company.id, reg.id, 'LOCKED');

      await expect(cancelCreditNote(cn.id, tenant.ctx, userId, 'test cancel')).rejects.toMatchObject({
        statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE'),
      });
      const fresh = await tenantQuery(tenant.company.id, (tx) => tx.creditNote.findUniqueOrThrow({ where: { id: cn.id } }));
      expect(fresh.status).not.toBe('CANCELLED');
    });

    it('an OPEN period allows creating and cancelling a Credit Note', async () => {
      const { branch } = await freshReg('cnopen');
      const invoice = await makeInvoice(branch.id, 8200);
      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 500 }], reasonCode: 'POST_SALE_DISCOUNT' }, tenant.ctx, userId,
      );
      const result = await cancelCreditNote(cn.id, tenant.ctx, userId, 'test cancel');
      expect(result.status).toBe('CANCELLED');
    });
  });

  describe('Sales Debit Note', () => {
    it('a FILED period blocks creating a new Sales Debit Note', async () => {
      const { reg, branch } = await freshReg('sdncreate');
      const invoice = await makeInvoice(branch.id, 9000);
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 300 }], reasonCode: 'PRICE_INCREASE' }, tenant.ctx, userId,
      )).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE') });
    });

    it('a FILED period blocks cancelling an existing (unfiled-when-created) Sales Debit Note, which is left unchanged', async () => {
      const { reg, branch } = await freshReg('sdncancel');
      const invoice = await makeInvoice(branch.id, 9100);
      const dn = await createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 300 }], reasonCode: 'PRICE_INCREASE' }, tenant.ctx, userId,
      );
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(cancelSalesDebitNote(dn.id, tenant.ctx, userId, 'test cancel')).rejects.toMatchObject({
        statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE'),
      });
      const fresh = await tenantQuery(tenant.company.id, (tx) => tx.salesDebitNote.findUniqueOrThrow({ where: { id: dn.id } }));
      expect(fresh.status).not.toBe('CANCELLED');
    });
  });

  // ─── Inward / ITC: GRN intake (createTagFromGrnItem / openPurchaseLot) ────────────────────────

  describe('GRN intake (inward ITC source)', () => {
    it('a FILED period (for the GRN\'s receivedDate) blocks tagging a finished-goods GRN line', async () => {
      const { reg, branch } = await freshReg('grntag');
      const { grnItemId } = await intakeGrnOnly(branch.id, 10000);
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(createTagFromGrnItem(
        { grnItemId, stockTypeId, categoryId, name: 'Ring', metalType: 'GOLD' }, tenant.ctx, userId,
      )).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE') });

      // Nothing was booked — no tag created for this line.
      const tag = await prisma.jewelryTag.findUnique({ where: { grnItemId } });
      expect(tag).toBeNull();
    });

    it('an OPEN period allows tagging the same finished-goods GRN line', async () => {
      const { branch } = await freshReg('grnopen');
      const { grnItemId } = await intakeGrnOnly(branch.id, 10100);
      const tag = await createTagFromGrnItem({ grnItemId, stockTypeId, categoryId, name: 'Ring', metalType: 'GOLD' }, tenant.ctx, userId);
      tagIds.push(tag.id);
      expect(tag.grnItemId).toBe(grnItemId);
    });

    it('a LOCKED period blocks opening a FINISHED_LOT purchase lot too', async () => {
      const { reg, branch } = await freshReg('lotblk');
      await setPeriodStatus(tenant.company.id, reg.id, 'LOCKED');

      const bagLine = {
        materialCode: 'G7G-BAG', materialName: 'G7g bag', materialType: FINISHED_LOT_MATERIAL_TYPE,
        quantity: 1, weight: 40, unit: 'BAG', ratePerUnit: 0, lotAmount: 50000,
        categories: [{ categoryId, karat: '22K', grossWeight: 40, netWeight: 36, pieces: 4 }],
      };
      const po = await createPO({ supplierId, poType: 'OUTRIGHT', orderDate: new Date(), items: [bagLine] }, tenant.ctx, userId);
      poIds.push(po.id);

      await expect(createGRN({
        poId: po.id, receivedDate: new Date(), branchId: branch.id, invoiceNumber: `G7G-LOT-INV-${poIds.length}`, invoiceDate: new Date(),
        items: [{ poItemId: po.poItems[0].id, invoiceQty: 1, invoiceWeight: 40, scaleWeight: 40 }],
      }, tenant.ctx, userId)).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE') });

      const lot = await prisma.purchaseLot.findFirst({ where: { grnItem: { poItemId: po.poItems[0].id } } });
      expect(lot).toBeNull();
    });
  });

  // ─── Inward / ITC: Purchase Return, standalone purchase Debit Note ────────────────────────────

  describe('Purchase Return', () => {
    it('a FILED period (for the return\'s own, current-month date) blocks a new Purchase Return, and the tag is left untouched', async () => {
      const { reg, branch } = await freshReg('pretblk');
      const { grnItemId } = await intakeGrnOnly(branch.id, 11000);
      const tag = await createTagFromGrnItem({ grnItemId, stockTypeId, categoryId, name: 'Ring', metalType: 'GOLD' }, tenant.ctx, userId);
      tagIds.push(tag.id);
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(createPurchaseReturn({ items: [{ tagId: tag.id }], reason: 'Wrong item' }, tenant.ctx, userId))
        .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE') });

      const freshTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(freshTag.status).toBe('IN_STOCK');
    });

    it('an OPEN period allows the same Purchase Return', async () => {
      const { branch } = await freshReg('pretopen');
      const { grnItemId } = await intakeGrnOnly(branch.id, 11100);
      const tag = await createTagFromGrnItem({ grnItemId, stockTypeId, categoryId, name: 'Ring', metalType: 'GOLD' }, tenant.ctx, userId);
      tagIds.push(tag.id);

      const ret = await createPurchaseReturn({ items: [{ tagId: tag.id }], reason: 'Wrong item' }, tenant.ctx, userId);
      returnIds.push(ret.id);
      expect(ret.items[0].tagId).toBe(tag.id);
    });
  });

  describe('Standalone purchase Debit Note', () => {
    it('a FILED period blocks creating a new standalone Debit Note against a GRN', async () => {
      const { reg, branch } = await freshReg('dncreate');
      const { grnId } = await intakeGrnOnly(branch.id, 12000);
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(createStandaloneDebitNote(
        { grnId, items: [{ description: 'Price correction', taxableValue: 1000 }], reasonCode: 'PRICE_VARIANCE' }, tenant.ctx, userId,
      )).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE') });
    });

    it('a LOCKED period blocks cancelling an existing (unfiled-when-created) standalone Debit Note, which is left unchanged', async () => {
      const { reg, branch } = await freshReg('dncancel');
      const { grnId } = await intakeGrnOnly(branch.id, 12100);
      const dn = await createStandaloneDebitNote(
        { grnId, items: [{ description: 'Price correction', taxableValue: 1000 }], reasonCode: 'PRICE_VARIANCE' }, tenant.ctx, userId,
      );
      await setPeriodStatus(tenant.company.id, reg.id, 'LOCKED');

      await expect(cancelDebitNote(dn.id, tenant.ctx, userId, 'test cancel')).rejects.toMatchObject({
        statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE'),
      });
      const fresh = await tenantQuery(tenant.company.id, (tx) => tx.debitNote.findUniqueOrThrow({ where: { id: dn.id } }));
      expect(fresh.status).not.toBe('CANCELLED');
    });

    it('a GSTR3B_MUTATION_BLOCKED audit entry is recorded for the rejected purchase-debit-note cancel attempt', async () => {
      const { reg, branch } = await freshReg('dnaudit');
      const { grnId } = await intakeGrnOnly(branch.id, 12200);
      const dn = await createStandaloneDebitNote(
        { grnId, items: [{ description: 'Price correction', taxableValue: 1000 }], reasonCode: 'PRICE_VARIANCE' }, tenant.ctx, userId,
      );
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(cancelDebitNote(dn.id, tenant.ctx, userId, 'test cancel')).rejects.toMatchObject({ statusCode: 409 });
      const audit = await prisma.auditLog.findFirst({ where: { recordId: dn.id, action: 'GSTR3B_MUTATION_BLOCKED' } });
      expect(audit).toBeTruthy();
      expect((audit!.newValues as any).documentType).toBe('DEBIT_NOTE');
    });
  });

  // ─── RCM settlement (markRcmLiabilityPaid) ─────────────────────────────────────────────────────

  describe('RCM liability settlement', () => {
    // RCM liability creation is wired into createTagFromGrnItem (bookRcmLiabilityIfApplicable),
    // not into the bare GRN — the piece must actually be tagged for a liability row to exist.
    async function makeLiability(branchId: string, price: number) {
      const { grnItemId } = await intakeGrnOnly(branchId, price, { rcmCategory: 'GTA_FREIGHT', taxRate: 0 });
      const tag = await createTagFromGrnItem({ grnItemId, stockTypeId, categoryId, name: 'Ring', metalType: 'GOLD' }, tenant.ctx, userId);
      tagIds.push(tag.id);
      const liability = await tenantQuery(tenant.company.id, (tx) => tx.rcmLiability.findFirstOrThrow({ where: { companyId: tenant.company.id, grnItemId } }));
      return liability;
    }

    it('a FILED period (for the liability\'s own GRN receivedDate) blocks marking it paid, and it is left unchanged', async () => {
      const { reg, branch } = await freshReg('rcmpay');
      const liability = await makeLiability(branch.id, 13000);
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(markRcmLiabilityPaid(tenant.ctx, liability.id, { paymentDate: new Date(), mode: 'BANK' }, userId))
        .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE') });

      const fresh = await tenantQuery(tenant.company.id, (tx) => tx.rcmLiability.findUniqueOrThrow({ where: { id: liability.id } }));
      expect(fresh.status).toBe('LIABILITY_RECOGNIZED');
    });

    it('a LOCKED period also blocks marking it paid', async () => {
      const { reg, branch } = await freshReg('rcmlock');
      const liability = await makeLiability(branch.id, 13100);
      await setPeriodStatus(tenant.company.id, reg.id, 'LOCKED');

      await expect(markRcmLiabilityPaid(tenant.ctx, liability.id, { paymentDate: new Date(), mode: 'BANK' }, userId))
        .rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE') });
    });

    it('an OPEN period allows marking it paid', async () => {
      const { branch } = await freshReg('rcmopen');
      const liability = await makeLiability(branch.id, 13200);
      const paid = await markRcmLiabilityPaid(tenant.ctx, liability.id, { paymentDate: new Date(), mode: 'BANK' }, userId);
      expect(paid.status).toBe('TAX_PAID');
    });

    it('a GSTR3B_MUTATION_BLOCKED audit entry is recorded for the rejected settlement attempt', async () => {
      const { reg, branch } = await freshReg('rcmaudit');
      const liability = await makeLiability(branch.id, 13300);
      await setPeriodStatus(tenant.company.id, reg.id, 'FILED');

      await expect(markRcmLiabilityPaid(tenant.ctx, liability.id, { paymentDate: new Date(), mode: 'BANK' }, userId)).rejects.toMatchObject({ statusCode: 409 });
      const audit = await prisma.auditLog.findFirst({ where: { recordId: liability.id, action: 'GSTR3B_MUTATION_BLOCKED' } });
      expect(audit).toBeTruthy();
      expect((audit!.newValues as any).documentType).toBe('RCM_LIABILITY');
    });
  });

  // ─── End-to-end through the real G2g-7g filing lifecycle (not a hand-built period row) ────────

  describe('End-to-end through the real filing lifecycle', () => {
    it('a real snapshot built by createGstr3bFilingSnapshot, attempted/accepted, then FILED and LOCKED by the real transitions, blocks voidInvoice', async () => {
      const { createGstr3bFilingSnapshot } = await import('../modules/finance/gst/gstr3bFilingSnapshot.service');
      const { createGstr3bFilingAttempt, recordGstr3bFilingAttemptOutcome } = await import('../modules/finance/gst/gstr3bFilingAttempt.service');
      const { fileGstr3bReturnPeriod, lockGstr3bReturnPeriod } = await import('../modules/finance/gst/gstr3bFilingPeriod.service');

      // Unlike this suite's other, hand-built-period tests, this one runs the REAL
      // createGstr3bFilingSnapshot -> serializeGstr3bToGstnExport -> validateGstr3bGstnExport path,
      // which DOES enforce a valid GSTIN checksum (BLOCKING per gstr3bGstnValidator.ts) — a
      // known-good checksum GSTIN (the same literal g2g6dGstr1MutationGuard.test.ts's own e2e test
      // already proved valid) avoids coupling this test to any other fixture's GSTIN.
      //
      // Also, unlike every other test in this file, this one is backdated into a quiet period
      // (March 2033) that nothing else in this suite touches — "today" is shared by every other
      // test's own fixtures, and the frozen G2g-7d RCM engine classifies ANY liability in a
      // requested period by comparing its OWN buyerRegistrationId against the report's requested
      // registration (gstr3bRcmAggregation.ts), not merely by excluding other registrations — so an
      // unrelated registration's still-unpaid (LIABILITY_RECOGNIZED) liability dated "today" would
      // otherwise surface here as an UNRESOLVED_RCM_LIABILITY blocker purely from being in the same
      // calendar month, not from any real relationship to e2eReg.
      const { reg, branch } = await freshReg('e2e', '24AAAAA0000A1Z8');
      const date = new Date(Date.UTC(2033, 2, 15));
      const invoice = await createInvoice({
        clientId, branchId: branch.id, invoiceDate: date, invoiceType: 'RETAIL',
        items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 14000 }],
      });
      invoiceIds.push(invoice.id);

      const financialYear = getFinancialYearForDate(date);
      const taxPeriod = resolveFilingPeriodMmYYYY(date);
      const snap = await createGstr3bFilingSnapshot(tenant.ctx, { gstRegistrationId: reg.id, taxPeriod, financialYear }, userId);
      expect(snap.isFilingReady).toBe(true);
      expect(snap.returnPeriodId).toBeTruthy();

      const attempt = await createGstr3bFilingAttempt(
        tenant.ctx, { gstRegistrationId: reg.id, financialYear, taxPeriod, snapshotId: snap.id, mode: 'MANUAL_EXPORT' }, userId,
      );
      await recordGstr3bFilingAttemptOutcome(tenant.ctx, { attemptId: attempt.id, outcome: 'ACCEPTED', arn: 'TESTARN7G01' }, userId);

      const filedPeriod = await fileGstr3bReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId);
      expect(filedPeriod.status).toBe('FILED');

      await expect(voidInvoice(invoice.id, tenant.ctx, userId, 'after real filing')).rejects.toMatchObject({
        statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE'),
      });

      const lockedPeriod = await lockGstr3bReturnPeriod(tenant.ctx, { periodId: filedPeriod.id }, userId);
      expect(lockedPeriod.status).toBe('LOCKED');

      await expect(voidInvoice(invoice.id, tenant.ctx, userId, 'after real locking')).rejects.toMatchObject({
        statusCode: 409, message: expect.stringContaining('GSTR3B_FILED_PERIOD_IMMUTABLE'),
      });

      const fresh = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(fresh.status).not.toBe('VOID');
    });
  });
});
