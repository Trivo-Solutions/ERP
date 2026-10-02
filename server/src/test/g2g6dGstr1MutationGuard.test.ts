import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createInvoice as _createInvoice, amendInvoice, voidInvoice, createSalesReturn, recordPayment } from '../modules/sales/sales.service';
import { createStandaloneCreditNote, cancelCreditNote } from '../modules/sales/creditNote.service';
import { createSalesDebitNote, cancelSalesDebitNote } from '../modules/sales/salesDebitNote.service';
import { createGstRegistration } from '../modules/company/company.service';
import { findGstr1FilingProtection, type Gstr1ProtectedDocumentType } from '../modules/finance/gst/gstr1FilingProtection';
import { fileGstr1ReturnPeriod } from '../modules/finance/gst/gstr1FilingPeriod.service';
import { tenantQuery, tenantTransaction } from '../shared/tenantContext';
import { createTestTenant, cleanupTestTenant, TestTenant } from './fixtures';

// ═══════════════════════════════════════════════════════════════════════════
// G2g-6d — Post-Filing Mutation Controls. Proves the GUARD layer this phase adds on top of the
// already-frozen G2g-6a schema (GstReturnPeriod/GstFilingSnapshot/GstFilingAttempt) — not the
// frozen classification/aggregation/adapter/validator/serializer/snapshot-builder pipeline itself
// (those have their own test suites: gstr1*Aggregation.test.ts, gstr1GstnAdapter.test.ts,
// gstr1FilingSnapshot.service.test.ts, gstr1FilingAttempt.service.test.ts).
//
// Most fixtures below hand-construct GstFilingSnapshot/GstFilingAttempt rows directly (same
// precedent as g2g6aGstFilingFoundation.test.ts's own periodData/snapshotData/attemptData
// helpers) with a canonicalDtoJson.traceability block shaped exactly as gstr1GstnAdapter.ts (frozen)
// populates it — this isolates "does the guard correctly read an ACCEPTED attempt's traceability"
// from "does the frozen pipeline correctly classify/aggregate," which is already covered elsewhere.
// One true end-to-end test (createGstr1FilingSnapshot -> createGstr1FilingAttempt ->
// recordGstr1FilingAttemptOutcome -> guard blocks) proves the real wiring, at the bottom.
// ═══════════════════════════════════════════════════════════════════════════

const GSTR1_RETURN_TYPE = 'GSTR1';

function periodData(tenant: TestTenant, gstRegistrationId: string, tag: string, extra: Record<string, unknown> = {}) {
  return {
    companyId: tenant.company.id, gstRegistrationId, returnType: GSTR1_RETURN_TYPE,
    financialYear: '2031-32', taxPeriod: `01${tag}`,
    ...extra,
  };
}

function snapshotData(
  tenant: TestTenant, returnPeriodId: string, version: number,
  traceability: Record<string, string[]>, extra: Record<string, unknown> = {},
) {
  const now = new Date();
  return {
    companyId: tenant.company.id, returnPeriodId, version,
    canonicalDtoJson: { traceability }, wireJson: { stub: true },
    canonicalDtoHash: 'hash-canonical', wireJsonHash: 'hash-wire',
    serializerVersion: 'v0', adapterVersion: 'v0',
    periodFrom: now, periodTo: now,
    branchScope: { scope: 'REGISTRATION' }, validationResult: { blockers: [], warnings: [] },
    sourceDataCutoff: now, reportParams: { gstRegistrationId: 'stub' },
    status: 'DRAFT',
    ...extra,
  };
}

function attemptData(tenant: TestTenant, returnPeriodId: string, snapshotId: string, attemptNumber: number, extra: Record<string, unknown> = {}) {
  return {
    companyId: tenant.company.id, returnPeriodId, snapshotId, attemptNumber,
    mode: 'MANUAL_EXPORT', payloadHash: 'hash-wire', status: 'ATTEMPTED',
    ...extra,
  };
}

const emptyTraceability = () => ({
  b2bInvoiceIds: [] as string[], b2clInvoiceIds: [] as string[],
  cdnrCreditNoteIds: [] as string[], cdnurCreditNoteIds: [] as string[],
  cdnrDebitNoteIds: [] as string[], cdnurDebitNoteIds: [] as string[],
});

describe('GSTR-1 post-filing mutation controls (G2g-6d)', () => {
  const suffix = `g6d-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let other: TestTenant;
  let userId: string;
  let branchId: string;
  let clientId: string;
  let regId: string;
  let regId2: string; // a SECOND registration in the SAME company (brief §16)
  let otherRegId: string;
  const invoiceIds: string[] = [];
  const tagIds: string[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];
  let tagCounter = 0;
  let periodCounter = 0;

  function createInvoice(data: Omit<Parameters<typeof _createInvoice>[0], 'branchId'> & { branchId?: string }) {
    return _createInvoice({ branchId, ...data }, tenant.ctx, userId);
  }

  async function makeTag(price: number) {
    tagCounter += 1;
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TSTTAG-${suffix}-${tagCounter}`, companyId: tenant.company.id, branchId,
        name: 'Ring', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, stoneWeight: 0,
        costPrice: price * 0.8, sellingPrice: price, createdById: userId,
      },
    });
    tagIds.push(tag.id);
    return tag;
  }

  // Single-line, FIXED-rate, tagged, same-state (client.state = Gujarat = company stateCode '24',
  // buyerGstin present -> always B2B per rule 1) invoice — a plain sale with nothing else attached.
  async function makeInvoice(price: number) {
    const tag = await makeTag(price);
    const invoice = await createInvoice({
      clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: price, tagId: tag.id }],
    });
    invoiceIds.push(invoice.id);
    return { invoice, tag };
  }

  // A stored line, sent back unchanged (with its id) plus whatever the edit overrides — same shape
  // as sales.service.test.ts's own `keep()` helper (InvoiceItemInput has no `huid`/`companyId`/etc,
  // so a raw object spread of a Prisma InvoiceItem row doesn't type-check).
  function keepLine(l: { id: string; productCode: string; description: string; quantity: number; grossWeight: unknown; netGoldWeight: unknown; rateType: string; goldRate: unknown; makingCharge: unknown; wastagePercent: unknown; stoneValue: unknown; tagId: string | null }, over: Record<string, unknown> = {}) {
    return {
      id: l.id, productCode: l.productCode, description: l.description, quantity: l.quantity,
      grossWeight: Number(l.grossWeight), netGoldWeight: Number(l.netGoldWeight), rateType: l.rateType,
      goldRate: Number(l.goldRate), makingCharge: Number(l.makingCharge), wastagePercent: Number(l.wastagePercent),
      stoneValue: Number(l.stoneValue), tagId: l.tagId ?? undefined, ...over,
    };
  }

  /** Hand-builds an ACCEPTED filing attempt referencing a DRAFT snapshot whose traceability
   *  contains exactly the given ids — stops short of the G2g-6e FILED transition itself, so a
   *  caller can race the real `fileGstr1ReturnPeriod()` against something else. */
  async function buildAcceptedAttempt(gstRegistrationId: string, traceability: Partial<ReturnType<typeof emptyTraceability>>) {
    periodCounter += 1;
    const tag = `${suffix}-${periodCounter}`;
    const period = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.create({ data: periodData(tenant, gstRegistrationId, tag) }));
    const snapshot = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.create({
      data: snapshotData(tenant, period.id, 1, { ...emptyTraceability(), ...traceability }),
    }));
    const attempt = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingAttempt.create({
      data: attemptData(tenant, period.id, snapshot.id, 1, { status: 'ACCEPTED', filedAt: new Date() }),
    }));
    return { period, snapshot, attempt };
  }

  /** `buildAcceptedAttempt()` followed directly by the G2g-6e authoritative FILED transition on
   *  the period row (same "hand-build the row state" philosophy as the rest of this file's
   *  fixtures — the dedicated end-to-end test at the bottom calls the REAL
   *  fileGstr1ReturnPeriod()/lockGstr1ReturnPeriod() service functions throughout instead). An
   *  ACCEPTED attempt alone no longer establishes protection (G2g-6d's former temporary
   *  interpretation, superseded by G2g-6e — see gstr1FilingProtection.ts's own header) — the
   *  authoritative boundary is the period's own FILED/LOCKED status plus its exact filedSnapshotId. */
  async function acceptedFiling(gstRegistrationId: string, traceability: Partial<ReturnType<typeof emptyTraceability>>) {
    const { period, snapshot, attempt } = await buildAcceptedAttempt(gstRegistrationId, traceability);
    const filedPeriod = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.update({
      where: { id: period.id },
      data: { status: 'FILED', filedAt: new Date(), filedSnapshotId: snapshot.id, filedByAttemptId: attempt.id, filedById: userId },
    }));
    return { period: filedPeriod, snapshot, attempt };
  }

  beforeAll(async () => {
    tenant = await createTestTenant(suffix, [
      'invoice:create', 'invoice:edit', 'invoice:void', 'return:create', 'payment:create',
      'creditNote:create', 'creditNote:cancel', 'salesDebitNote:create', 'salesDebitNote:cancel',
    ]);
    other = await createTestTenant(`xco-${suffix}`, ['invoice:create']);
    userId = tenant.user.id;
    branchId = tenant.branch.id;

    const reg = await createGstRegistration(tenant.ctx, {
      gstin: '24AAAAA0000A1Z5', legalName: `G6d Co ${suffix}`, stateCode: '24', isPrimary: true, isActive: true,
    });
    regId = reg.id;
    regRows.push({ id: regId, companyId: tenant.company.id });

    const reg2 = await createGstRegistration(tenant.ctx, {
      gstin: '24BBBBB1111B1Z5', legalName: `G6d Co Secondary ${suffix}`, stateCode: '24', isPrimary: false, isActive: true,
    });
    regId2 = reg2.id;
    regRows.push({ id: reg2.id, companyId: tenant.company.id });

    const otherReg = await createGstRegistration(other.ctx, {
      gstin: '27AAAAA0000A1Z2', legalName: `G6d Co B ${suffix}`, stateCode: '27', isPrimary: true, isActive: true,
    });
    otherRegId = otherReg.id;
    regRows.push({ id: otherRegId, companyId: other.company.id });

    // buyerGstin present -> B2B regardless of state/value (gstr1Classification.ts rule 1) — real
    // traceability population for the one true end-to-end test at the bottom relies on this.
    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${suffix}`, name: 'B2B Client', type: 'WHOLESALE', state: 'Gujarat', gstNumber: '27AAAAA0000A1Z5' },
    });
    clientId = client.id;
  });

  afterAll(async () => {
    // Same cleanup order as gstr1FilingAttempt.service.test.ts's own afterAll — periods/snapshots/
    // attempts are FORCE-RLS, go through tenantQuery, and must be removed before the registration
    // they point at (RESTRICT FK) and before cleanupTestTenant touches the company.
    for (const r of regRows) {
      const periods = await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.findMany({ where: { gstRegistrationId: r.id }, select: { id: true } }));
      const ids = periods.map((p) => p.id);
      if (ids.length > 0) {
        // G2g-6e: filedByAttemptId must also be cleared before the attempt it points at can be
        // deleted (RESTRICT composite FK) — null BOTH filed-pointer columns before any delete.
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.updateMany({ where: { id: { in: ids } }, data: { filedSnapshotId: null, filedByAttemptId: null } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingAttempt.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingSnapshot.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.deleteMany({ where: { id: { in: ids } } }));
      }
    }
    await tenantQuery(tenant.company.id, (tx) => tx.creditNote.deleteMany({ where: { companyId: tenant.company.id } }));
    await tenantQuery(tenant.company.id, (tx) => tx.salesDebitNote.deleteMany({ where: { companyId: tenant.company.id } }));
    await prisma.salesReturn.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } });
    await prisma.branch.updateMany({ where: { companyId: tenant.company.id }, data: { gstRegistrationId: null } });
    for (const r of regRows) {
      await tenantQuery(r.companyId, (tx) => tx.companyGstAatoHistory.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstAato.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    }
    await cleanupTestTenant(tenant);
    await cleanupTestTenant(other);
    await prisma.$disconnect();
  });

  // ─── Sales Invoice ───────────────────────────────────────────────────────

  describe('Sales Invoice', () => {
    it('an unfiled invoice remains editable and voidable', async () => {
      const { invoice } = await makeInvoice(5000);
      const amended = await amendInvoice(invoice.id, { items: [keepLine(invoice.items[0], { description: 'Ring (relabelled)' })] }, tenant.ctx, userId);
      expect(amended.items[0].description).toBe('Ring (relabelled)');

      const { invoice: invoice2 } = await makeInvoice(5000);
      const voided = await voidInvoice(invoice2.id, tenant.ctx, userId, 'test void');
      expect(voided.status).toBe('VOID');
    });

    it('amending a filed invoice is rejected (409) and the invoice is left unchanged', async () => {
      const { invoice } = await makeInvoice(6000);
      await acceptedFiling(regId, { b2bInvoiceIds: [invoice.id] });

      await expect(
        amendInvoice(invoice.id, { items: [keepLine(invoice.items[0], { description: 'Changed' })] }, tenant.ctx, userId),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR1_FILED_DOCUMENT_IMMUTABLE') });

      const fresh = await prisma.invoiceItem.findUniqueOrThrow({ where: { id: invoice.items[0].id } });
      expect(fresh.description).toBe('Ring');
    });

    it('voiding a filed invoice is rejected (409) and the invoice/tag are left unchanged', async () => {
      const { invoice, tag } = await makeInvoice(6100);
      await acceptedFiling(regId, { b2bInvoiceIds: [invoice.id] });

      await expect(
        voidInvoice(invoice.id, tenant.ctx, userId, 'test void'),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR1_FILED_DOCUMENT_IMMUTABLE') });

      const freshInvoice = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(freshInvoice.status).not.toBe('VOID');
      const freshTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(freshTag.status).toBe('SOLD');
    });

    it('a GSTR1_MUTATION_BLOCKED audit entry is recorded for the rejected attempt', async () => {
      const { invoice } = await makeInvoice(6200);
      await acceptedFiling(regId, { b2bInvoiceIds: [invoice.id] });

      await expect(voidInvoice(invoice.id, tenant.ctx, userId, 'test void')).rejects.toMatchObject({ statusCode: 409 });

      const audit = await prisma.auditLog.findFirst({ where: { recordId: invoice.id, action: 'GSTR1_MUTATION_BLOCKED' } });
      expect(audit).toBeTruthy();
      expect((audit!.newValues as any).documentType).toBe('SALES_INVOICE');
      expect((audit!.newValues as any).attemptedAction).toBe('voided');
    });

    it('a payment against a filed invoice remains allowed (brief §12 — ledger activity is not frozen)', async () => {
      const { invoice } = await makeInvoice(6300);
      await acceptedFiling(regId, { b2bInvoiceIds: [invoice.id] });

      await recordPayment({ invoiceId: invoice.id, paymentDate: new Date(), amount: 1000, mode: 'CASH' }, tenant.ctx, userId);
      const fresh = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(Number(fresh.paidAmount)).toBe(1000);
    });

    it('two concurrent void attempts against an already-filed invoice both reject (409), nothing mutated (brief §21 — within-helper consistency; the cross-transaction filing/mutation race itself is deferred to G2g-6e)', async () => {
      const { invoice } = await makeInvoice(6400);
      await acceptedFiling(regId, { b2bInvoiceIds: [invoice.id] });

      const results = await Promise.allSettled([
        voidInvoice(invoice.id, tenant.ctx, userId, 'race A'),
        voidInvoice(invoice.id, tenant.ctx, userId, 'race B'),
      ]);
      expect(results.every((r) => r.status === 'rejected')).toBe(true);
      for (const r of results) {
        if (r.status === 'rejected') expect((r.reason as any).statusCode).toBe(409);
      }
      const fresh = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(fresh.status).not.toBe('VOID');
    });

    // G2g-6e §8/§21 test #38 — THE concurrency case this whole phase exists to close: a real,
    // ACCEPTED-but-not-yet-FILED attempt raced against an amend of the exact invoice its snapshot
    // represents. Both promises are started together and only then awaited (same convention as
    // the J3.5 concurrency tests in sales.service.test.ts) so both reach the database before
    // either resolves — real FOR UPDATE row-lock contention proves the serialization, not timing.
    it('a concurrent FILED transition and an amend of the invoice it represents can never result in the amend succeeding after FILED has committed', async () => {
      const { invoice } = await makeInvoice(6500);
      const { attempt } = await buildAcceptedAttempt(regId, { b2bInvoiceIds: [invoice.id] });

      const [fileResult, amendResult] = await Promise.allSettled([
        fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId),
        amendInvoice(invoice.id, { items: [keepLine(invoice.items[0], { description: 'Race amend' })] }, tenant.ctx, userId),
      ]);

      // Filing never depends on the document's own mutation outcome — it always succeeds.
      expect(fileResult.status).toBe('fulfilled');
      const period = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: (fileResult as PromiseFulfilledResult<any>).value.id } }));
      expect(period.status).toBe('FILED');

      const freshInvoiceItem = await prisma.invoiceItem.findUniqueOrThrow({ where: { id: invoice.items[0].id } });
      if (amendResult.status === 'fulfilled') {
        // The amend's transaction acquired the period row lock BEFORE the file transition did —
        // legitimate: the document was mutated strictly before the filing boundary was established.
        expect(freshInvoiceItem.description).toBe('Race amend');
      } else {
        // The file transition won the lock first — the amend, re-reading fresh under the same
        // lock, correctly saw FILED and was rejected; the invoice is provably untouched.
        expect((amendResult.reason as any).statusCode).toBe(409);
        expect((amendResult.reason as any).message).toContain('GSTR1_FILED_DOCUMENT_IMMUTABLE');
        expect(freshInvoiceItem.description).toBe('Ring');
      }
    });
  });

  // ─── Later-period adjustments against a filed invoice (brief §9/§10) ────

  describe('Later-period adjustments against a filed invoice', () => {
    it('a new standalone credit note against a filed invoice can still be created, and the invoice itself is unchanged', async () => {
      const { invoice } = await makeInvoice(7000);
      await acceptedFiling(regId, { b2bInvoiceIds: [invoice.id] });
      const before = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });

      const cn = await createStandaloneCreditNote(
        // amount omitted -> defaults to the line's own full tax-inclusive value, which always
        // balances exactly (no floating-point risk from an arbitrary partial amount).
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }], reasonCode: 'POST_SALE_DISCOUNT' },
        tenant.ctx, userId,
      );
      expect(cn.invoiceId).toBe(invoice.id);

      const after = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.totalAmount.toString()).toBe(before.totalAmount.toString());
      expect(after.status).toBe(before.status);
    });

    it('a new sales debit note against a filed invoice can still be created', async () => {
      const { invoice } = await makeInvoice(7100);
      await acceptedFiling(regId, { b2bInvoiceIds: [invoice.id] });

      const dn = await createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 500 }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      );
      expect(dn.invoiceId).toBe(invoice.id);
    });

    it('a sales return against a filed invoice still follows the existing adjustment workflow, and the historical invoice is never modified', async () => {
      const { invoice, tag } = await makeInvoice(7200);
      await acceptedFiling(regId, { b2bInvoiceIds: [invoice.id] });
      const before = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });

      const ret = await createSalesReturn({ invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id }] }, tenant.ctx, userId);
      expect(ret.invoiceId).toBe(invoice.id);

      const freshTag = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tag.id } });
      expect(freshTag.status).toBe('IN_STOCK');
      const after = await prisma.salesInvoice.findUniqueOrThrow({ where: { id: invoice.id } });
      expect(after.totalAmount.toString()).toBe(before.totalAmount.toString());
      expect(after.status).toBe(before.status);
    });
  });

  // ─── Credit Note ─────────────────────────────────────────────────────────

  describe('Credit Note', () => {
    it('an unfiled credit note remains cancellable', async () => {
      const { invoice } = await makeInvoice(8000);
      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 500 }], reasonCode: 'POST_SALE_DISCOUNT' },
        tenant.ctx, userId,
      );
      const result = await cancelCreditNote(cn.id, tenant.ctx, userId, 'test cancel');
      expect(result.status).toBe('CANCELLED');
    });

    it('cancelling a filed credit note is rejected (409), and it is left unchanged', async () => {
      const { invoice } = await makeInvoice(8100);
      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 500 }], reasonCode: 'POST_SALE_DISCOUNT' },
        tenant.ctx, userId,
      );
      await acceptedFiling(regId, { cdnrCreditNoteIds: [cn.id] });

      await expect(
        cancelCreditNote(cn.id, tenant.ctx, userId, 'test cancel'),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR1_FILED_DOCUMENT_IMMUTABLE') });

      // CreditNote is a FORCE-RLS table in this single-role test DB — a bare prisma call would
      // silently match zero rows (see creditNote.service.test.ts's own afterAll note).
      const fresh = await tenantQuery(tenant.company.id, (tx) => tx.creditNote.findUniqueOrThrow({ where: { id: cn.id } }));
      expect(fresh.status).not.toBe('CANCELLED');
    });

    it('a CDNUR-classified filed credit note is also protected (both traceability fields are honoured)', async () => {
      const { invoice } = await makeInvoice(8200);
      const cn = await createStandaloneCreditNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 500 }], reasonCode: 'POST_SALE_DISCOUNT' },
        tenant.ctx, userId,
      );
      await acceptedFiling(regId, { cdnurCreditNoteIds: [cn.id] });

      await expect(cancelCreditNote(cn.id, tenant.ctx, userId, 'test cancel')).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  // ─── Sales Debit Note ────────────────────────────────────────────────────

  describe('Sales Debit Note', () => {
    it('an unfiled sales debit note remains cancellable', async () => {
      const { invoice } = await makeInvoice(9000);
      const dn = await createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 300 }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      );
      const result = await cancelSalesDebitNote(dn.id, tenant.ctx, userId, 'test cancel');
      expect(result.status).toBe('CANCELLED');
    });

    it('cancelling a filed sales debit note is rejected (409), and it is left unchanged', async () => {
      const { invoice } = await makeInvoice(9100);
      const dn = await createSalesDebitNote(
        { invoiceId: invoice.id, items: [{ invoiceItemId: invoice.items[0].id, amount: 300 }], reasonCode: 'PRICE_INCREASE' },
        tenant.ctx, userId,
      );
      await acceptedFiling(regId, { cdnrDebitNoteIds: [dn.id] });

      await expect(
        cancelSalesDebitNote(dn.id, tenant.ctx, userId, 'test cancel'),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR1_FILED_DOCUMENT_IMMUTABLE') });

      // SalesDebitNote is also FORCE-RLS in this single-role test DB — same reason as CreditNote above.
      const fresh = await tenantQuery(tenant.company.id, (tx) => tx.salesDebitNote.findUniqueOrThrow({ where: { id: dn.id } }));
      expect(fresh.status).not.toBe('CANCELLED');
    });
  });

  // ─── Snapshot states (brief §15) ─────────────────────────────────────────

  describe('Snapshot lifecycle states', () => {
    it('a BLOCKED snapshot (no ACCEPTED attempt) does not protect the documents in its traceability', async () => {
      const { invoice } = await makeInvoice(10000);
      periodCounter += 1;
      const tag = `${suffix}-blocked-${periodCounter}`;
      const period = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.create({ data: periodData(tenant, regId, tag) }));
      await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.create({
        data: snapshotData(tenant, period.id, 1, { ...emptyTraceability(), b2bInvoiceIds: [invoice.id] }, { status: 'BLOCKED' }),
      }));
      // No GstFilingAttempt at all — a BLOCKED snapshot can never acquire an ACCEPTED one in the
      // real system (gstr1FilingAttempt.service.ts's own INELIGIBLE_SNAPSHOT_STATUSES guard).

      const amended = await amendInvoice(invoice.id, { items: [keepLine(invoice.items[0], { description: 'Still editable' })] }, tenant.ctx, userId);
      expect(amended.items[0].description).toBe('Still editable');
    });

    it('a SUPERSEDED snapshot does not independently protect its documents — only the later FILED one does', async () => {
      const { invoice } = await makeInvoice(10100);
      periodCounter += 1;
      const tag = `${suffix}-superseded-${periodCounter}`;
      const period = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.create({ data: periodData(tenant, regId, tag) }));
      const v1 = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.create({
        data: snapshotData(tenant, period.id, 1, { ...emptyTraceability(), b2bInvoiceIds: [invoice.id] }, { status: 'SUPERSEDED' }),
      }));
      // v1 was never filed — still not protected.
      let amended = await amendInvoice(invoice.id, { items: [keepLine(invoice.items[0], { description: 'Not yet protected' })] }, tenant.ctx, userId);
      expect(amended.items[0].description).toBe('Not yet protected');

      const v2 = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.create({
        data: snapshotData(tenant, period.id, 2, { ...emptyTraceability(), b2bInvoiceIds: [invoice.id] }),
      }));
      const attempt2 = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingAttempt.create({
        data: attemptData(tenant, period.id, v2.id, 1, { status: 'ACCEPTED', filedAt: new Date() }),
      }));
      // The authoritative G2g-6e transition — v1's own SUPERSEDED status never becomes a period's
      // filedSnapshotId, only v2 (the attempt's actual snapshot) does.
      await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.update({
        where: { id: period.id },
        data: { status: 'FILED', filedAt: new Date(), filedSnapshotId: v2.id, filedByAttemptId: attempt2.id, filedById: userId },
      }));
      void v1;

      await expect(
        amendInvoice(invoice.id, { items: [keepLine(invoice.items[0], { description: 'Now protected' })] }, tenant.ctx, userId),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  // ─── Registration isolation (brief §16) ──────────────────────────────────

  describe('GST registration isolation', () => {
    it('protection is registration-specific — a filing under one registration does not protect a document attributed to another', async () => {
      const { invoice } = await makeInvoice(11000);
      await acceptedFiling(regId, { b2bInvoiceIds: [invoice.id] });

      await tenantTransaction(tenant.company.id, async (tx) => {
        const protectedUnderRight = await findGstr1FilingProtection(tx, tenant.company.id, regId, 'SALES_INVOICE' as Gstr1ProtectedDocumentType, invoice.id);
        expect(protectedUnderRight).not.toBeNull();

        const protectedUnderWrong = await findGstr1FilingProtection(tx, tenant.company.id, regId2, 'SALES_INVOICE' as Gstr1ProtectedDocumentType, invoice.id);
        expect(protectedUnderWrong).toBeNull();
      });
    });
  });

  // ─── Tenant security (brief §19) ─────────────────────────────────────────

  describe('Tenant isolation', () => {
    it('a cross-company accepted filing cannot establish protection for this company\'s own companyId + registration', async () => {
      const otherClient = await prisma.client.create({
        data: { companyId: other.company.id, clientCode: `TSTCL-X-${suffix}`, name: 'Other Co Client', type: 'RETAIL', state: 'Maharashtra' },
      });
      const otherTag = await prisma.jewelryTag.create({
        data: {
          tagNumber: `TSTTAG-X-${suffix}`, companyId: other.company.id, branchId: other.branch.id,
          name: 'Ring', metalType: 'GOLD', metalKarat: '22K', grossWeight: 10, netWeight: 10, stoneWeight: 0,
          costPrice: 4000, sellingPrice: 5000, createdById: other.user.id,
        },
      });
      const otherInvoice = await _createInvoice({
        branchId: other.branch.id, clientId: otherClient.id, invoiceDate: new Date(), invoiceType: 'RETAIL',
        items: [{ productCode: 'MISC', description: 'Ring', quantity: 1, grossWeight: 10, netGoldWeight: 10, rateType: 'FIXED', goldRate: 5000, tagId: otherTag.id }],
      }, other.ctx, other.user.id);

      periodCounter += 1;
      const tag = `${suffix}-xco-${periodCounter}`;
      const period = await tenantQuery(other.company.id, (tx) => tx.gstReturnPeriod.create({ data: periodData(other, otherRegId, tag) }));
      const snap = await tenantQuery(other.company.id, (tx) => tx.gstFilingSnapshot.create({
        data: snapshotData(other, period.id, 1, { ...emptyTraceability(), b2bInvoiceIds: [otherInvoice.id] }),
      }));
      const otherAttempt = await tenantQuery(other.company.id, (tx) => tx.gstFilingAttempt.create({
        data: attemptData(other, period.id, snap.id, 1, { status: 'ACCEPTED', filedAt: new Date() }),
      }));
      // The OTHER company's period is genuinely FILED — this proves the guard's company filter, not
      // merely "this fixture never reached FILED in the first place."
      await tenantQuery(other.company.id, (tx) => tx.gstReturnPeriod.update({
        where: { id: period.id },
        data: { status: 'FILED', filedAt: new Date(), filedSnapshotId: snap.id, filedByAttemptId: otherAttempt.id, filedById: other.user.id },
      }));

      // Querying from OUR OWN company's context, even against our own real registration id, never
      // sees the other company's filed period — the guard's SQL filters p."companyId".
      await tenantTransaction(tenant.company.id, async (tx) => {
        const result = await findGstr1FilingProtection(tx, tenant.company.id, regId, 'SALES_INVOICE' as Gstr1ProtectedDocumentType, otherInvoice.id);
        expect(result).toBeNull();
      });

      await prisma.taxInvoice.deleteMany({ where: { invoiceId: otherInvoice.id } });
      await prisma.invoiceItem.deleteMany({ where: { invoiceId: otherInvoice.id } });
      await prisma.salesInvoice.deleteMany({ where: { id: otherInvoice.id } });
      await prisma.jewelryTag.deleteMany({ where: { id: otherTag.id } });
      await prisma.client.deleteMany({ where: { id: otherClient.id } });
    });

    it('a document with no gstRegistrationId at all is never protected (it could never have been attributed to any return period)', async () => {
      await tenantTransaction(tenant.company.id, async (tx) => {
        const result = await findGstr1FilingProtection(tx, tenant.company.id, '', 'SALES_INVOICE' as Gstr1ProtectedDocumentType, 'some-doc-id');
        expect(result).toBeNull();
      });
    });
  });

  // ─── End-to-end, through the real frozen pipeline (not hand-built fixtures) ──

  describe('End-to-end through the real G2g-6a/6b/6c/6e pipeline', () => {
    it('a real snapshot built by createGstr1FilingSnapshot, attempted and accepted by the real services, then FILED and LOCKED by the real G2g-6e transitions, blocks amendInvoice', async () => {
      const { getFinancialYearForDate, getPrecedingFinancialYear } = await import('../shared/financialYear');
      const { saveAato } = await import('../modules/gst/aato.service');
      const { createGstr1FilingSnapshot } = await import('../modules/finance/gst/gstr1FilingSnapshot.service');
      const { createGstr1FilingAttempt, recordGstr1FilingAttemptOutcome } = await import('../modules/finance/gst/gstr1FilingAttempt.service');
      const { lockGstr1ReturnPeriod } = await import('../modules/finance/gst/gstr1FilingPeriod.service');

      // Unlike this suite's other, hand-built-snapshot tests (whose GSTIN never reaches the real
      // serializer's stricter checksum validation), this one runs the REAL createGstr1FilingSnapshot
      // -> serializeGstr1ToGstnJson path, which does enforce a valid checksum — a dedicated
      // registration with a known-good checksum GSTIN (same literal gstr1FilingAttempt.service.test.ts
      // already proved valid) avoids coupling this test to `regId`'s own GSTIN.
      const e2eReg = await createGstRegistration(tenant.ctx, {
        gstin: '24AAAAA0000A1Z8', legalName: `G6d E2E Co ${suffix}`, stateCode: '24', isPrimary: false, isActive: true,
      });
      regRows.push({ id: e2eReg.id, companyId: tenant.company.id });
      // Branch-level override so createInvoice resolves THIS registration, not the company's primary.
      await prisma.branch.update({ where: { id: branchId }, data: { gstRegistrationId: e2eReg.id } });

      const date = new Date(Date.UTC(2033, 2, 15)); // March 2033 — a quiet FY nothing else in this suite touches
      const fy = getFinancialYearForDate(date);
      const precedingFy = getPrecedingFinancialYear(fy);
      await saveAato(tenant.ctx, { gstRegistrationId: e2eReg.id, financialYear: fy, turnover: 1000000, verificationStatus: 'VERIFIED' });
      await saveAato(tenant.ctx, { gstRegistrationId: e2eReg.id, financialYear: precedingFy, turnover: 900000, verificationStatus: 'VERIFIED' });

      // Invoiced while the branch override above is live, so TaxInvoice.sellerRegistrationId is
      // already e2eReg.id (resolveSellerRegistration's own branch-first rule).
      const { invoice } = await makeInvoice(12000);
      // Backdate the invoice into the snapshot's own period so the frozen report loader picks it up.
      await prisma.salesInvoice.update({ where: { id: invoice.id }, data: { invoiceDate: date } });
      await prisma.branch.update({ where: { id: branchId }, data: { gstRegistrationId: null } }); // restore, so every other test keeps using the primary registration

      const from = `${fy.slice(0, 4)}-04-01`;
      const snap = await createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: e2eReg.id, from, to: date.toISOString() }, userId);
      expect(snap.isValid).toBe(true);
      expect(snap.status).toBe('DRAFT');

      const snapRow = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snap.id } }));
      const traceability = snapRow.canonicalDtoJson as any;
      expect(traceability.traceability.b2bInvoiceIds).toContain(invoice.id);

      const period = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: snap.returnPeriodId } }));
      const attempt = await createGstr1FilingAttempt(
        tenant.ctx, { gstRegistrationId: e2eReg.id, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: snap.id, mode: 'MANUAL_EXPORT' }, userId,
      );
      await recordGstr1FilingAttemptOutcome(tenant.ctx, { attemptId: attempt.id, outcome: 'ACCEPTED', arn: 'TESTARN0001' }, userId);

      // G2g-6e: an ACCEPTED attempt alone does NOT yet establish protection — only the controlled
      // FILED transition does (proven directly by gstr1FilingPeriod.service.test.ts's own "carries
      // over the accepted attempt's own ARN" case and by this file's own
      // `buildAcceptedAttempt`-based fixtures elsewhere). Not re-proven here via an extra amend
      // call: amendInvoice's own tax recalculation re-resolves the invoice's seller registration
      // from the branch's CURRENT override (already reset to null below, back to this company's
      // primary registration) on every amend — an extra pre-filing amend would silently rewrite
      // sellerRegistrationId away from e2eReg.id before the real assertion below ever runs.
      const filedPeriod = await fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId);
      expect(filedPeriod.status).toBe('FILED');
      expect(filedPeriod.filedSnapshotId).toBe(snap.id);
      expect(filedPeriod.filedByAttemptId).toBe(attempt.id);

      await expect(
        amendInvoice(invoice.id, { items: [keepLine(invoice.items[0], { description: 'Changed after real filing' })] }, tenant.ctx, userId),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR1_FILED_DOCUMENT_IMMUTABLE') });

      const lockedPeriod = await lockGstr1ReturnPeriod(tenant.ctx, { periodId: filedPeriod.id }, userId);
      expect(lockedPeriod.status).toBe('LOCKED');

      await expect(
        amendInvoice(invoice.id, { items: [keepLine(invoice.items[0], { description: 'Changed after locking' })] }, tenant.ctx, userId),
      ).rejects.toMatchObject({ statusCode: 409, message: expect.stringContaining('GSTR1_FILED_DOCUMENT_IMMUTABLE') });
    });
  });
});
