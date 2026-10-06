import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { createInvoice as _createInvoice, voidInvoice, createSalesReturn } from '../../sales/sales.service';
import { createStandaloneCreditNote, cancelCreditNote } from '../../sales/creditNote.service';
import { createSalesDebitNote, cancelSalesDebitNote } from '../../sales/salesDebitNote.service';
import { createGstRegistration } from '../../company/company.service';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../../test/fixtures';
import { cleanupJournalEntries } from '../../../test/ledger';
import { tenantQuery } from '../../../shared/tenantContext';
import {
  getGstr3bOutwardReport,
  resolveGstr3bPeriod,
  resolveFilingPeriodMmYYYY,
} from './gstr3bReporting.service';
import { AppError } from '../../../middleware/error';

describe('G2g-7b: GSTR-3B Reporting Service Integration', () => {
  const suffix = `g3b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let userId: string;
  let branchA: string;
  let branchB: string;
  let intraClientId: string; // Gujarat, unregistered
  let interClientId: string; // Maharashtra, unregistered
  let b2bClientId: string;   // Registered buyer
  let primaryRegId: string;
  let secondaryRegId: string;

  const invoiceIds: string[] = [];
  const creditNoteIds: string[] = [];
  const salesDebitNoteIds: string[] = [];
  const tagIds: string[] = [];
  const regRows: string[] = [];

  function createInvoice(data: Omit<Parameters<typeof _createInvoice>[0], 'branchId'> & { branchId?: string }) {
    return _createInvoice({ branchId: branchA, ...data }, tenant.ctx, userId);
  }

  async function makeTag(price: number) {
    const tag = await prisma.jewelryTag.create({
      data: {
        tagNumber: `TAG-G3B-${suffix}-${tagIds.length}`,
        companyId: tenant.company.id,
        branchId: branchA,
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

  async function makeInvoice(clientId: string, price: number, overrides: Partial<Parameters<typeof _createInvoice>[0]> = {}) {
    const tag = await makeTag(price);
    const invoice = await createInvoice({
      clientId,
      invoiceDate: new Date('2026-09-15T12:00:00.000Z'),
      invoiceType: 'RETAIL',
      items: [
        {
          productCode: 'MISC',
          description: 'Gold Ring',
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
    return invoice;
  }

  beforeAll(async () => {
    tenant = await createTestTenant(suffix, [
      'invoice:create',
      'invoice:void',
      'return:create',
      'creditNote:create',
      'creditNote:cancel',
      'salesDebitNote:create',
      'salesDebitNote:cancel',
      'report:financial_view',
    ]);
    userId = tenant.user.id;
    branchA = tenant.branch.id;
    const b = await addBranch(tenant.company.id, suffix);
    branchB = b.id;

    // Primary Gujarat registration
    const reg1 = await createGstRegistration(tenant.ctx, {
      gstin: '24AAAAA0000A1Z5',
      legalName: 'Primary Gujarat Reg',
      stateCode: '24',
      isPrimary: true,
      isActive: true,
    });
    primaryRegId = reg1.id;
    regRows.push(reg1.id);

    // Secondary Gujarat registration
    const reg2 = await createGstRegistration(tenant.ctx, {
      gstin: '24BBBBB1111B1Z5',
      legalName: 'Secondary Reg',
      stateCode: '24',
      isPrimary: false,
      isActive: true,
    });
    secondaryRegId = reg2.id;
    regRows.push(reg2.id);

    const [intra, inter, b2b] = await Promise.all([
      prisma.client.create({
        data: {
          companyId: tenant.company.id,
          clientCode: `CL-INTRA-${suffix}`,
          name: 'Intra State Client',
          type: 'RETAIL',
          state: 'Gujarat',
        },
      }),
      prisma.client.create({
        data: {
          companyId: tenant.company.id,
          clientCode: `CL-INTER-${suffix}`,
          name: 'Inter State Client',
          type: 'RETAIL',
          state: 'Maharashtra',
        },
      }),
      prisma.client.create({
        data: {
          companyId: tenant.company.id,
          clientCode: `CL-B2B-${suffix}`,
          name: 'B2B Client',
          type: 'WHOLESALE',
          state: 'Maharashtra',
          gstNumber: '27AAAAA0000A1Z5',
        },
      }),
    ]);
    intraClientId = intra.id;
    interClientId = inter.id;
    b2bClientId = b2b.id;
  });

  afterAll(async () => {
    await tenantQuery(tenant.company.id, (tx) =>
      tx.companyGstRegistration.deleteMany({ where: { id: { in: regRows } } })
    );
    await tenantQuery(tenant.company.id, (tx) =>
      tx.creditNote.deleteMany({ where: { companyId: tenant.company.id } })
    );
    await tenantQuery(tenant.company.id, (tx) =>
      tx.salesDebitNote.deleteMany({ where: { companyId: tenant.company.id } })
    );
    await tenantQuery(tenant.company.id, (tx) =>
      tx.repairCase.deleteMany({ where: { companyId: tenant.company.id } })
    );
    await tenantQuery(tenant.company.id, (tx) =>
      tx.salesReturn.deleteMany({ where: { companyId: tenant.company.id } })
    );
    await cleanupJournalEntries([...invoiceIds, ...creditNoteIds, ...salesDebitNoteIds]);
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.jewelryTag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma.client.deleteMany({ where: { id: { in: [intraClientId, interClientId, b2bClientId] } } });
    await cleanupTestTenant(tenant);
    await prisma.$disconnect();
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Period resolution tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Period Resolution (IST boundary semantics)', () => {
    it('resolves MMYYYY format "092026" to exact September 2026 IST bounds', () => {
      const period = resolveGstr3bPeriod({ taxPeriod: '092026' });

      expect(period.financialYear).toBe('2026-27');
      expect(period.taxPeriod).toBe('092026');

      // 2026-09-01 00:00:00 IST is 2026-08-31 18:30:00 UTC
      expect(period.from.toISOString()).toBe('2026-08-31T18:30:00.000Z');
      // 2026-09-30 23:59:59.999 IST is 2026-09-30 18:29:59.999 UTC
      expect(period.to.toISOString()).toBe('2026-09-30T18:29:59.999Z');
    });

    it('resolves MM format "09" with financialYear "2026-27"', () => {
      const period = resolveGstr3bPeriod({ taxPeriod: '09', financialYear: '2026-27' });

      expect(period.financialYear).toBe('2026-27');
      expect(period.taxPeriod).toBe('092026');
      expect(period.from.toISOString()).toBe('2026-08-31T18:30:00.000Z');
      expect(period.to.toISOString()).toBe('2026-09-30T18:29:59.999Z');
    });

    it('resolves FY boundary month "04" (April 2026)', () => {
      const period = resolveGstr3bPeriod({ taxPeriod: '04', financialYear: '2026-27' });

      expect(period.financialYear).toBe('2026-27');
      expect(period.taxPeriod).toBe('042026');
      // 2026-04-01 00:00:00 IST -> 2026-03-31 18:30:00 UTC
      expect(period.from.toISOString()).toBe('2026-03-31T18:30:00.000Z');
      // 2026-04-30 23:59:59.999 IST -> 2026-04-30 18:29:59.999 UTC
      expect(period.to.toISOString()).toBe('2026-04-30T18:29:59.999Z');
    });

    it('resolves FY boundary month "03" (March 2027)', () => {
      const period = resolveGstr3bPeriod({ taxPeriod: '03', financialYear: '2026-27' });

      expect(period.financialYear).toBe('2026-27');
      expect(period.taxPeriod).toBe('032027');
      // 2027-03-01 00:00:00 IST -> 2027-02-28 18:30:00 UTC
      expect(period.from.toISOString()).toBe('2027-02-28T18:30:00.000Z');
      // 2027-03-31 23:59:59.999 IST -> 2027-03-31 18:29:59.999 UTC
      expect(period.to.toISOString()).toBe('2027-03-31T18:29:59.999Z');
    });

    it('throws AppError on invalid month in taxPeriod', () => {
      expect(() => resolveGstr3bPeriod({ taxPeriod: '132026' })).toThrow(AppError);
      expect(() => resolveGstr3bPeriod({ taxPeriod: '002026' })).toThrow(AppError);
    });

    it('throws AppError when from is after to', () => {
      expect(() =>
        resolveGstr3bPeriod({ from: '2026-09-30', to: '2026-09-01' })
      ).toThrow(AppError);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────────
  // Database service query tests
  // ─────────────────────────────────────────────────────────────────────────────
  describe('Database Service Integration', () => {
    it('throws 404 if gstRegistrationId does not belong to this company', async () => {
      await expect(
        getGstr3bOutwardReport(tenant.company.id, 'non-existent-reg-id', { taxPeriod: '092026' })
      ).rejects.toThrow(AppError);
    });

    it('loads and aggregates real SalesInvoice and TaxInvoice into Table 3.1(a) and Table 3.2', async () => {
      // 1. Intra-state invoice (Gujarat -> Gujarat, 3% GST)
      const intraInv = await makeInvoice(intraClientId, 100000, {
        invoiceDate: new Date('2026-09-10T10:00:00.000Z'),
      });

      // 2. Inter-state invoice to unregistered (Gujarat -> Maharashtra, 3% IGST)
      const interInv = await makeInvoice(interClientId, 50000, {
        invoiceDate: new Date('2026-09-12T10:00:00.000Z'),
      });

      // 3. Inter-state invoice to registered B2B (Gujarat -> Maharashtra, 3% IGST)
      const b2bInv = await makeInvoice(b2bClientId, 60000, {
        invoiceDate: new Date('2026-09-14T10:00:00.000Z'),
      });

      const report = await getGstr3bOutwardReport(
        tenant.company.id,
        primaryRegId,
        { taxPeriod: '092026' }
      );

      expect(report.meta.gstRegistrationId).toBe(primaryRegId);
      expect(report.meta.isCompleteGstinScope).toBe(true);

      // Table 3.1(a) should contain total of all 3 invoices:
      // Taxable: 100000 + 50000 + 60000 = 210000
      expect(report.table31.table31a.taxableValue).toBe(210000);
      expect(report.table31.table31a.cgst).toBe(1500); // 1.5% of 100000
      expect(report.table31.table31a.sgst).toBe(1500); // 1.5% of 100000
      expect(report.table31.table31a.igst).toBe(3300); // 3% of (50000 + 60000) = 1500 + 1800 = 3300
      expect(report.table31.table31a.documentCounts.activeInvoices).toBe(3);

      // Table 3.2: ONLY the inter-state unregistered invoice (50000 taxable, 1500 IGST)
      expect(report.table32.unregisteredPersons.supplies).toHaveLength(1);
      const pos27 = report.table32.unregisteredPersons.supplies[0];
      expect(pos27.placeOfSupply).toBe('27');
      expect(pos27.taxableValue).toBe(50000);
      expect(pos27.igst).toBe(1500);
      expect(report.table32.unregisteredPersons.totalTaxableValue).toBe(50000);
      expect(report.table32.unregisteredPersons.totalIgst).toBe(1500);
    });

    it('loads and applies SalesDebitNote as positive outward adjustment', async () => {
      const baseInv = await makeInvoice(intraClientId, 40000, {
        invoiceDate: new Date('2026-09-05T10:00:00.000Z'),
      });

      const sdn = await createSalesDebitNote(
        {
          invoiceId: baseInv.id,
          debitNoteDate: new Date('2026-09-08T10:00:00.000Z'),
          reasonCode: 'PRICE_INCREASE',
          items: [
            {
              invoiceItemId: baseInv.items[0].id,
              description: 'Undercharge correction',
              amount: 10300,
            },
          ],
        },
        tenant.ctx,
        userId
      );
      salesDebitNoteIds.push(sdn.id);

      const report = await getGstr3bOutwardReport(
        tenant.company.id,
        primaryRegId,
        { taxPeriod: '092026' }
      );

      expect(report.table31.table31a.salesDebitNoteAdditions.taxableValue).toBeGreaterThan(0);
      expect(report.table31.table31a.documentCounts.salesDebitNotes).toBe(1);
    });

    it('loads and applies standalone CreditNote (Path B) as liability reduction', async () => {
      const baseInv = await makeInvoice(intraClientId, 50000, {
        invoiceDate: new Date('2026-09-06T10:00:00.000Z'),
      });

      const cn = await createStandaloneCreditNote(
        {
          invoiceId: baseInv.id,
          creditNoteDate: new Date('2026-09-09T10:00:00.000Z'),
          reasonCode: 'POST_SALE_DISCOUNT',
          items: [
            {
              invoiceItemId: baseInv.items[0].id,
              description: 'Post-sale discount',
              amount: 5150, // tax inclusive
            },
          ],
        },
        tenant.ctx,
        userId
      );
      creditNoteIds.push(cn.id);

      const report = await getGstr3bOutwardReport(
        tenant.company.id,
        primaryRegId,
        { taxPeriod: '092026' }
      );

      expect(report.table31.table31a.creditNoteReductions.taxableValue).toBeGreaterThan(0);
      expect(report.table31.table31a.documentCounts.pathBStandaloneCreditNotes).toBe(1);
    });

    it('excludes VOID invoice from liability and records diagnostic', async () => {
      const voidCandidate = await makeInvoice(intraClientId, 30000, {
        invoiceDate: new Date('2026-09-11T10:00:00.000Z'),
      });

      await voidInvoice(voidCandidate.id, tenant.ctx, userId, 'Customer cancelled order before delivery');

      const report = await getGstr3bOutwardReport(
        tenant.company.id,
        primaryRegId,
        { taxPeriod: '092026' }
      );

      const voidDiag = report.diagnostics.find(
        (d) => d.code === 'EXCLUDED_VOID' && d.documentId === voidCandidate.id
      );
      expect(voidDiag).toBeDefined();
    });

    it('flags PARTIAL_BRANCH_SCOPE when branchId filter is applied', async () => {
      const report = await getGstr3bOutwardReport(
        tenant.company.id,
        primaryRegId,
        { taxPeriod: '092026' },
        { branchId: branchA }
      );

      expect(report.meta.isCompleteGstinScope).toBe(false);
      expect(report.meta.partialScopeReason).toBe('PARTIAL_BRANCH_SCOPE');

      const branchDiag = report.diagnostics.find((d) => d.code === 'PARTIAL_BRANCH_SCOPE');
      expect(branchDiag).toBeDefined();
    });
  });
});
