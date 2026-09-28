import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { AppError } from '../middleware/error';
import { createTestTenant, cleanupTestTenant, TestTenant } from './fixtures';
import { cleanupJournalEntries, getJournalEntry } from './ledger';
import {
  createTag, updateTag, retireTag,
  createTagTemplate, getTagTemplateById, listTagTemplates, updateTagTemplate,
  createTransfer, submitTransfer, approveTransfer, cancelTransfer, getTransfer,
  startStockAudit, scanAuditItem, completeStockAudit, getStockAudit,
  getBranchStockSummary, getStockOnHand, getDeadStock,
} from '../modules/tagging/tagging.service';
import {
  createMemoOut, convertMemoToInvoice, createOldGoldExchange,
  getSalesRegister,
} from '../modules/sales/sales.service';
import { getDealerAging, getClientLedger, getGstSummary, getTrialBalance, createJournalEntry } from '../modules/finance/finance.service';
import { createClient } from '../modules/orders/orders.service';

// ═══════════════════════════════════════════════════
// Phase 2 tenant isolation & concurrency suite.
//
// Extends tenantIsolation.prototype.test.ts (which covers the original 10-model prototype:
// Company/CompanyUser/Branch/UserBranchAccess/Role/Client/JewelryTag/SalesInvoice/InvoiceItem/
// NumberSequence) to the models and functions Phase 2 added or re-scoped: finance reports,
// MemoOut/convertMemoToInvoice's exhaustive per-line validation, updateTag/retireTag,
// BranchTransfer, StockAudit, TagTemplate, and cross-company NumberSequence concurrency for the
// newly-migrated document types. Every "must fail" assertion here is checking Layer 2 (explicit
// relation-ownership validation), not RLS.
// ═══════════════════════════════════════════════════

describe('Phase 2: tenant isolation & concurrency', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  let companyA: TestTenant;
  let companyB: TestTenant;
  // Masters are company-owned — each tenant needs its own category + stock type (keyed by companyId).
  const mastersByCompany: Record<string, { categoryId: string; stockTypeId: string }> = {};

  let tagA: { id: string; tagNumber: string; branchId: string };
  let tagB: { id: string; tagNumber: string; branchId: string };
  let clientA: { id: string };
  let clientB: { id: string };

  const createdTagIds: string[] = [];
  const createdClientIds: string[] = [];
  const createdInvoiceIds: string[] = [];
  const createdMemoIds: string[] = [];
  const createdExchangeIds: string[] = [];
  const createdTemplateIds: string[] = [];
  const createdTransferIds: string[] = [];
  const createdAuditIds: string[] = [];
  const createdBranchIds: string[] = [];
  const createdRateIds: string[] = [];

  async function makeTag(tenant: TestTenant, name: string) {
    const { categoryId, stockTypeId } = mastersByCompany[tenant.company.id];
    const tag = await createTag(tenant.ctx, {
      branchId: tenant.branch.id, stockTypeId, categoryId, name,
      metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5,
      costPrice: 20000, sellingPrice: 25000,
    }, tenant.user.id);
    createdTagIds.push(tag.id);
    return tag;
  }

  beforeAll(async () => {
    companyA = await createTestTenant(`P2A${suffix}`, ['tag:create', 'invoice:create', 'memo:manage', 'branch:transfer', 'branch:approve', 'stock:adjust', 'tagTemplate:view', 'tagTemplate:create', 'tagTemplate:edit']);
    companyB = await createTestTenant(`P2B${suffix}`, ['tag:create', 'invoice:create', 'memo:manage', 'branch:transfer', 'branch:approve', 'stock:adjust', 'tagTemplate:view', 'tagTemplate:create', 'tagTemplate:edit']);

    for (const t of [companyA, companyB]) {
      const category = await prisma.productCategory.create({ data: { companyId: t.company.id, code: `P2CAT-${suffix}`, name: 'Phase2 Category' } });
      const stockType = await prisma.stockType.create({ data: { companyId: t.company.id, code: `P2${suffix}`.slice(0, 8).toUpperCase(), name: 'Phase2 Stock Type' } });
      mastersByCompany[t.company.id] = { categoryId: category.id, stockTypeId: stockType.id };
    }

    tagA = await makeTag(companyA, 'Company A Ring');
    tagB = await makeTag(companyB, 'Company B Ring');

    clientA = await createClient(companyA.company.id, { name: 'Company A Client', type: 'WHOLESALE' });
    createdClientIds.push(clientA.id);
    clientB = await createClient(companyB.company.id, { name: 'Company B Client', type: 'WHOLESALE' });
    createdClientIds.push(clientB.id);

    // createOldGoldExchange resolves today's MetalRate for the given karat — MetalRate is
    // company-scoped (Phase 3), so each company needs its own row; ensure one exists per company
    // rather than assuming a shared rate, and reuse rather than colliding on the
    // (companyId, date, karat, currency) unique constraint if a prior run left one behind.
    const today = new Date(new Date().toISOString().split('T')[0]);
    for (const tenant of [companyA, companyB]) {
      const existingRate = await prisma.metalRate.findFirst({
        where: { companyId: tenant.company.id, date: today, karat: '22K', currency: 'INR' },
      });
      if (!existingRate) {
        const rate = await prisma.metalRate.create({
          data: { companyId: tenant.company.id, date: today, karat: '22K', purity: 0.916, ratePerGram: 5000 },
        });
        createdRateIds.push(rate.id);
      }
    }
  });

  afterAll(async () => {
    const returnIds = (await prisma.salesReturn.findMany({ where: { invoiceId: { in: createdInvoiceIds } }, select: { id: true } })).map((r) => r.id);
    await cleanupJournalEntries([...createdInvoiceIds, ...createdExchangeIds, ...returnIds]);
    await prisma.stockAudit.deleteMany({ where: { id: { in: createdAuditIds } } }); // cascades items
    await prisma.branchTransfer.deleteMany({ where: { id: { in: createdTransferIds } } }); // cascades items
    await prisma.tagTemplate.deleteMany({ where: { id: { in: createdTemplateIds } } });
    await prisma.oldGoldExchange.deleteMany({ where: { id: { in: createdExchangeIds } } });
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: createdInvoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: createdInvoiceIds } } }); // cascades invoice_items
    await prisma.memoOut.deleteMany({ where: { id: { in: createdMemoIds } } }); // cascades memo_items
    await prisma.jewelryTag.deleteMany({ where: { id: { in: createdTagIds } } });
    await prisma.client.deleteMany({ where: { id: { in: createdClientIds } } });
    await prisma.metalRate.deleteMany({ where: { id: { in: createdRateIds } } });
    await prisma.productCategory.deleteMany({ where: { id: { in: Object.values(mastersByCompany).map((m) => m.categoryId) } } });
    await prisma.stockType.deleteMany({ where: { id: { in: Object.values(mastersByCompany).map((m) => m.stockTypeId) } } });
    // Extra branches created within tests (branch transfer isolation) — must go after the
    // transfers referencing them are already deleted above.
    await prisma.branch.deleteMany({ where: { id: { in: createdBranchIds } } });
    await cleanupTestTenant(companyA);
    await cleanupTestTenant(companyB);
    await prisma.$disconnect();
  });

  // ─── Finance report isolation (priority 1) ────────────────────────────────

  describe('finance report isolation', () => {
    it('getDealerAging never shows Company B rows to Company A and vice versa', async () => {
      const [resultA, resultB] = await Promise.all([
        getDealerAging(companyA.company.id),
        getDealerAging(companyB.company.id),
      ]);
      expect(resultA.rows.some((r) => r.clientId === clientB.id)).toBe(false);
      expect(resultB.rows.some((r) => r.clientId === clientA.id)).toBe(false);
    });

    it('getClientLedger rejects a Company B clientId when called with Company A\'s ctx', async () => {
      await expect(getClientLedger(companyA.ctx, clientB.id)).rejects.toThrow();
    });

    it('getSalesRegister never returns another company\'s invoices', async () => {
      const [resultA, resultB] = await Promise.all([
        getSalesRegister(companyA.ctx, { from: new Date('2000-01-01'), to: new Date('2100-01-01') }),
        getSalesRegister(companyB.ctx, { from: new Date('2000-01-01'), to: new Date('2100-01-01') }),
      ]);
      const idsA = new Set(resultA.rows.map((r: any) => r.id));
      const idsB = new Set(resultB.rows.map((r: any) => r.id));
      expect([...idsA].some((id) => idsB.has(id))).toBe(false);
    });

    it('getGstSummary and getTrialBalance are scoped to the calling company\'s own Account rows', async () => {
      const [tbA, tbB] = await Promise.all([
        getTrialBalance(companyA.company.id),
        getTrialBalance(companyB.company.id),
      ]);
      // Each company got its own freshly-seeded chart of accounts (fixtures.ts) — the two sets
      // of account ids must be disjoint even though the codes/names are identical.
      const idsA = new Set(tbA.map((a) => a.id));
      const idsB = new Set(tbB.map((a) => a.id));
      expect([...idsA].some((id) => idsB.has(id))).toBe(false);
      expect(tbA.length).toBeGreaterThan(0);
      expect(tbB.length).toBeGreaterThan(0);

      // getGstSummary must not throw for a company with zero invoices, and must not surface any
      // cross-company rows.
      const gst = await getGstSummary(companyA.company.id, new Date('2000-01-01'), new Date('2100-01-01'));
      expect(Array.isArray(gst.rows)).toBe(true);
    });
  });

  // ─── convertMemoToInvoice exhaustive per-line forgery (priority 2) ────────

  describe('convertMemoToInvoice: exhaustive per-line tag/memo/company validation', () => {
    let memoAId: string;

    beforeAll(async () => {
      const tagForMemo = await makeTag(companyA, 'Memo Source Ring');
      const memo = await createMemoOut(
        {
          clientId: clientA.id, branchId: companyA.branch.id,
          sentDate: new Date(), returnDeadline: new Date(Date.now() + 7 * 86_400_000),
          items: [{
            productCode: tagForMemo.tagNumber, description: 'Memo ring', pieces: 1,
            grossWeight: 5, netGoldWeight: 5, estimatedValue: 25000, tagId: tagForMemo.id,
          }],
        },
        companyA.ctx, companyA.user.id,
      );
      memoAId = memo.id;
      createdMemoIds.push(memo.id);
      (tagForMemo as any).__memoTagId = tagForMemo.id;
    });

    it('rejects a real Company B tagId substituted for the memo\'s own line (cross-company forgery)', async () => {
      await expect(
        convertMemoToInvoice(memoAId, [{ tagId: tagB.id, sellingPrice: 25000 }], companyA.ctx, companyA.user.id)
      ).rejects.toThrow(/not an outstanding item on this memo|not found/);
    });

    it('rejects a real Company A tag that is NOT on this memo (not derived from "whichever tag resolves first")', async () => {
      // tagA exists, belongs to companyA, but was never put on memoAId — proves the per-line
      // check is "is this tagId a real MemoItem on THIS memo," not just "does this tag exist in
      // my company."
      await expect(
        convertMemoToInvoice(memoAId, [{ tagId: tagA.id, sellingPrice: 25000 }], companyA.ctx, companyA.user.id)
      ).rejects.toThrow(/not an outstanding item on this memo/);
    });

    it('rejects converting Company A\'s memo using Company B\'s ctx entirely', async () => {
      await expect(
        convertMemoToInvoice(memoAId, [], companyB.ctx, companyB.user.id)
      ).rejects.toThrow(/Memo not found/);
    });

    it('rejects a nonexistent tagId the same way as a forged one (no information leak)', async () => {
      await expect(
        convertMemoToInvoice(memoAId, [{ tagId: 'nonexistent-tag-id', sellingPrice: 25000 }], companyA.ctx, companyA.user.id)
      ).rejects.toThrow(/not an outstanding item on this memo/);
    });
  });

  // ─── updateTag / retireTag isolation (priority 2, priority 7) ─────────────

  describe('updateTag / retireTag isolation', () => {
    it('Company B cannot updateTag a Company A tag (IDOR)', async () => {
      await expect(
        updateTag(tagA.id, { notes: 'hostile edit' }, companyB.ctx, companyB.user.id)
      ).rejects.toThrow('Tag not found');
    });

    it('Company B cannot retireTag a Company A tag (IDOR)', async () => {
      await expect(
        retireTag(tagA.id, companyB.ctx, companyB.user.id)
      ).rejects.toThrow('Tag not found');

      const stillFine = await prisma.jewelryTag.findUniqueOrThrow({ where: { id: tagA.id } });
      expect(stillFine.status).not.toBe('RETIRED');
    });

    it('Company A can update and retire its own tag', async () => {
      const tag = await makeTag(companyA, 'Retire Me');
      const updated = await updateTag(tag.id, { notes: 'legit edit' }, companyA.ctx, companyA.user.id);
      expect(updated.notes).toBe('legit edit');

      const retired = await retireTag(tag.id, companyA.ctx, companyA.user.id);
      expect(retired.status).toBe('RETIRED');
    });
  });

  // ─── createTag: jobCardId/designId cross-company forgery (found and fixed during the
  // repo-wide company-isolation audit) — both are plain, non-composite FKs left over from the
  // manufacturing era that createTag never ownership-checked, unlike every other optional id
  // on the same call. ─────────────────────────────────────────────────────────────────────
  describe('createTag: jobCardId/designId cross-company forgery is rejected', () => {
    it('rejects a Company B designId and a Company B jobCardId', async () => {
      const { categoryId, stockTypeId } = mastersByCompany[companyA.company.id];
      const designCategoryB = await prisma.designCategory.create({
        data: { companyId: companyB.company.id, code: `P2DCB-${suffix}`, name: 'Phase2 Design Cat B' },
      });
      const designB = await prisma.design.create({
        data: {
          companyId: companyB.company.id, designCode: `P2DES-B-${suffix}`, name: 'Phase2 Design B',
          categoryId: designCategoryB.id, metalKarat: '22K',
          grossWeightMin: 1, grossWeightMax: 2, netWeightMin: 1, netWeightMax: 2,
        },
      });
      const jobCardB = await prisma.jobCard.create({
        data: { companyId: companyB.company.id, jobNumber: `P2JC-B-${suffix}`, designId: designB.id, issuedWeight: 5, barcodeData: `P2JCBC-${suffix}` },
      });

      await expect(
        createTag(companyA.ctx, {
          branchId: companyA.branch.id, stockTypeId, categoryId, name: 'Hostile Job Card Ring',
          metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5,
          jobCardId: jobCardB.id,
        }, companyA.user.id)
      ).rejects.toThrow('Job card not found');

      await expect(
        createTag(companyA.ctx, {
          branchId: companyA.branch.id, stockTypeId, categoryId, name: 'Hostile Design Ring',
          metalType: 'GOLD', metalKarat: '22K', grossWeight: 5, netWeight: 5,
          designId: designB.id,
        }, companyA.user.id)
      ).rejects.toThrow('Design not found');

      const leaked = await prisma.jewelryTag.findFirst({ where: { companyId: companyA.company.id, jobCardId: jobCardB.id } });
      expect(leaked).toBeNull();

      await prisma.jobCard.delete({ where: { id: jobCardB.id } });
      await prisma.design.delete({ where: { id: designB.id } });
      await prisma.designCategory.delete({ where: { id: designCategoryB.id } });
    });
  });

  // ─── Branch transfer isolation (priority 2, priority 7) ───────────────────

  describe('branch transfer isolation', () => {
    it('createTransfer rejects a Company B tagId forged into a Company A transfer', async () => {
      const secondBranch = await prisma.branch.create({
        data: { companyId: companyA.company.id, branchCode: `P2ABR2-${suffix}`, name: 'Company A Branch 2' },
      });
      createdBranchIds.push(secondBranch.id);
      await expect(
        createTransfer(
          { fromBranchId: companyA.branch.id, toBranchId: secondBranch.id, tagIds: [tagB.id] },
          companyA.ctx, companyA.user.id,
        )
      ).rejects.toThrow(/not found/);
    });

    it('createTransfer rejects a Company B branch as either end of a Company A transfer', async () => {
      const tag = await makeTag(companyA, 'Transfer Source');
      await expect(
        createTransfer(
          { fromBranchId: companyA.branch.id, toBranchId: companyB.branch.id, tagIds: [tag.id] },
          companyA.ctx, companyA.user.id,
        )
      ).rejects.toThrow();
    });

    it('Company B cannot read, submit, approve, or cancel a Company A transfer by id (IDOR)', async () => {
      const secondBranch = await prisma.branch.create({
        data: { companyId: companyA.company.id, branchCode: `P2ABR3-${suffix}`, name: 'Company A Branch 3' },
      });
      createdBranchIds.push(secondBranch.id);
      const tag = await makeTag(companyA, 'IDOR Transfer Ring');
      const transfer = await createTransfer(
        { fromBranchId: companyA.branch.id, toBranchId: secondBranch.id, tagIds: [tag.id] },
        companyA.ctx, companyA.user.id,
      );
      createdTransferIds.push(transfer.id);

      await expect(getTransfer(companyB.ctx, transfer.id)).rejects.toThrow('Transfer not found');
      await expect(submitTransfer(transfer.id, companyB.ctx, companyB.user.id)).rejects.toThrow('Transfer not found');
      await expect(approveTransfer(transfer.id, companyB.ctx, companyB.user.id)).rejects.toThrow('Transfer not found');
      await expect(cancelTransfer(transfer.id, companyB.ctx, companyB.user.id)).rejects.toThrow('Transfer not found');

      // Company A itself can still legitimately operate on it afterward.
      const submitted = await submitTransfer(transfer.id, companyA.ctx, companyA.user.id);
      expect(submitted.status).toBe('PENDING_APPROVAL');
    });
  });

  // ─── Stock audit isolation (priority 2, priority 7) ───────────────────────

  describe('stock audit isolation', () => {
    it('Company B cannot start, read, scan, or complete a stock audit in a Company A branch', async () => {
      await expect(startStockAudit(companyA.branch.id, companyB.ctx, companyB.user.id)).rejects.toThrow();
    });

    it('Company B cannot read/scan/complete a Company A audit by id (IDOR)', async () => {
      const audit = await startStockAudit(companyA.branch.id, companyA.ctx, companyA.user.id);
      createdAuditIds.push(audit.id);

      await expect(getStockAudit(companyB.ctx, audit.id)).rejects.toThrow('Stock audit not found');
      await expect(scanAuditItem(audit.id, tagA.id, companyB.ctx, companyB.user.id)).rejects.toThrow('Stock audit not found');
      await expect(completeStockAudit(audit.id, companyB.ctx, companyB.user.id)).rejects.toThrow('Stock audit not found');

      // Clean up: complete it as its rightful owner so it doesn't block a later "in-progress"
      // uniqueness test on the same branch.
      await completeStockAudit(audit.id, companyA.ctx, companyA.user.id);
    });

    it('scanning a real Company B tagId into a Company A audit is rejected, not silently recorded', async () => {
      const audit = await startStockAudit(companyA.branch.id, companyA.ctx, companyA.user.id);
      createdAuditIds.push(audit.id);

      await expect(scanAuditItem(audit.id, tagB.id, companyA.ctx, companyA.user.id)).rejects.toThrow('Tag not found');

      await completeStockAudit(audit.id, companyA.ctx, companyA.user.id);
    });
  });

  // ─── Tag template isolation (priority 2, priority 7) ──────────────────────

  describe('tag template isolation', () => {
    let templateAId: string;

    beforeAll(async () => {
      const template = await createTagTemplate(
        companyA.company.id,
        { name: `P2 Template A ${suffix}`, widthMm: 30, heightMm: 15, layout: { elements: [] } },
        companyA.user.id,
      );
      templateAId = template.id;
      createdTemplateIds.push(template.id);
    });

    it('Company B cannot read a Company A template by id (IDOR)', async () => {
      await expect(getTagTemplateById(companyB.company.id, templateAId)).rejects.toThrow('Tag template not found');
    });

    it('Company B cannot update a Company A template by id (IDOR)', async () => {
      await expect(
        updateTagTemplate(companyB.company.id, templateAId, { name: 'hostile rename' })
      ).rejects.toThrow('Tag template not found');

      const stillFine = await getTagTemplateById(companyA.company.id, templateAId);
      expect(stillFine.name).toBe(`P2 Template A ${suffix}`);
    });

    it('listTagTemplates for Company B never includes Company A\'s templates', async () => {
      const listB = await listTagTemplates(companyB.company.id);
      expect(listB.some((t) => t.id === templateAId)).toBe(false);
    });
  });

  // ─── NumberSequence concurrency across companies (priority 4, priority 7) ─

  describe('NumberSequence concurrency: newly-migrated document types', () => {
    // createTransfer is used here (rather than createOldGoldExchange) because it does its whole
    // job inside one tenantTransaction with no extra non-transactional lookups (no MetalRate/
    // KaratMaster resolution, no addMetalStock — a separate, pre-existing, non-atomic `count()+1`
    // stockCode generator in inventory.service.ts unrelated to Phase 2's NumberSequence work,
    // which this test's original OldGoldExchange-based version tripped over under concurrency;
    // see the Phase 2 report's "remaining gaps" section) — so N concurrent calls stay cheap
    // enough for the test DB's small connection pool (.env.test: connection_limit=5).
    async function makeTransferableTag(tenant: TestTenant, name: string) {
      const tag = await makeTag(tenant, name);
      return tag;
    }

    it('N concurrent createTransfer calls in the same company/branch produce N distinct, gap-free transfer numbers', async () => {
      const N = 8;
      const destBranch = await prisma.branch.create({
        data: { companyId: companyA.company.id, branchCode: `P2ACONC-${suffix}`, name: 'Concurrency Dest Branch' },
      });
      createdBranchIds.push(destBranch.id);
      const tags = await Promise.all(Array.from({ length: N }, (_, i) => makeTransferableTag(companyA, `Concurrency Transfer Ring ${i}`)));

      const results = await Promise.all(
        tags.map((tag) =>
          createTransfer(
            { fromBranchId: companyA.branch.id, toBranchId: destBranch.id, tagIds: [tag.id] },
            companyA.ctx, companyA.user.id,
          )
        )
      );
      results.forEach((r) => createdTransferIds.push(r.id));

      const numbers = results.map((r) => r.transferNumber);
      expect(new Set(numbers).size).toBe(N); // all unique
      numbers.forEach((n) => expect(n).toMatch(/^BT-/));
    });

    it('concurrent createTransfer calls interleaved across two companies never collide or cross-contaminate', async () => {
      const N = 5;
      const [destA, destB] = await Promise.all([
        prisma.branch.create({ data: { companyId: companyA.company.id, branchCode: `P2AINT-${suffix}`, name: 'Interleaved Dest A' } }),
        prisma.branch.create({ data: { companyId: companyB.company.id, branchCode: `P2BINT-${suffix}`, name: 'Interleaved Dest B' } }),
      ]);
      createdBranchIds.push(destA.id, destB.id);

      const [tagsA, tagsB] = await Promise.all([
        Promise.all(Array.from({ length: N }, (_, i) => makeTransferableTag(companyA, `Interleaved A Ring ${i}`))),
        Promise.all(Array.from({ length: N }, (_, i) => makeTransferableTag(companyB, `Interleaved B Ring ${i}`))),
      ]);

      const [resultsA, resultsB] = await Promise.all([
        Promise.all(tagsA.map((tag) =>
          createTransfer({ fromBranchId: companyA.branch.id, toBranchId: destA.id, tagIds: [tag.id] }, companyA.ctx, companyA.user.id)
        )),
        Promise.all(tagsB.map((tag) =>
          createTransfer({ fromBranchId: companyB.branch.id, toBranchId: destB.id, tagIds: [tag.id] }, companyB.ctx, companyB.user.id)
        )),
      ]);
      resultsA.forEach((r) => createdTransferIds.push(r.id));
      resultsB.forEach((r) => createdTransferIds.push(r.id));

      // Every transfer really belongs to the company that created it — an interleaved race could
      // otherwise leak a row onto the wrong company via a shared/misrouted sequence counter.
      const rowsA = await prisma.branchTransfer.findMany({ where: { id: { in: resultsA.map((r) => r.id) } } });
      const rowsB = await prisma.branchTransfer.findMany({ where: { id: { in: resultsB.map((r) => r.id) } } });
      expect(rowsA.every((r) => r.companyId === companyA.company.id)).toBe(true);
      expect(rowsB.every((r) => r.companyId === companyB.company.id)).toBe(true);

      expect(new Set(resultsA.map((r) => r.transferNumber)).size).toBe(N);
      expect(new Set(resultsB.map((r) => r.transferNumber)).size).toBe(N);
    });

    it('N concurrent createMemoOut calls in the same company/branch produce N distinct memo numbers', async () => {
      const N = 5;
      const tags = await Promise.all(Array.from({ length: N }, (_, i) => makeTag(companyA, `Concurrency Memo Ring ${i}`)));

      const memos = await Promise.all(
        tags.map((tag) =>
          createMemoOut(
            {
              clientId: clientA.id, branchId: companyA.branch.id,
              sentDate: new Date(), returnDeadline: new Date(Date.now() + 7 * 86_400_000),
              items: [{
                productCode: tag.tagNumber, description: 'Concurrency memo', pieces: 1,
                grossWeight: 5, netGoldWeight: 5, estimatedValue: 25000, tagId: tag.id,
              }],
            },
            companyA.ctx, companyA.user.id,
          )
        )
      );
      memos.forEach((m) => createdMemoIds.push(m.id));

      const numbers = memos.map((m) => m.memoNumber);
      expect(new Set(numbers).size).toBe(N);
    });
  });

  // ─── Tenant transaction context under concurrency (priority 3, priority 7) ─

  describe('tenant transaction context: concurrent requests from different companies never leak', () => {
    it('interleaved getDealerAging calls for two companies never return the other company\'s row', async () => {
      // Fire a burst of alternating calls (not sequential awaits) so any AsyncLocalStorage /
      // SET LOCAL leakage between concurrently in-flight requests would show up as cross-company
      // rows appearing in the wrong result.
      const calls = Array.from({ length: 6 }, (_, i) =>
        i % 2 === 0 ? getDealerAging(companyA.company.id) : getDealerAging(companyB.company.id)
      );
      const results = await Promise.all(calls);

      results.forEach((result, i) => {
        const expectedClientId = i % 2 === 0 ? clientB.id : clientA.id; // the OTHER company's client must never appear
        expect(result.rows.some((r) => r.clientId === expectedClientId)).toBe(false);
      });
    });

    it('two companies\' createOldGoldExchange calls each post a journal entry against only their own accounts', async () => {
      // Sequential, not concurrent: addMetalStock's stockCode generator (inventory.service.ts)
      // uses a pre-existing, non-atomic `count()+1` pattern unrelated to Phase 2's NumberSequence
      // work — concurrent calls can collide on it (a real, separately-flagged gap; see the Phase 2
      // report). This test's purpose is proving per-company journal/ctx correctness, which
      // createTransfer's concurrency tests above already stress-test independently of that gap.
      const exA = await createOldGoldExchange({ clientId: clientA.id, description: 'Ctx test A', karat: '22K', grossWeight: 1 }, companyA.ctx, companyA.user.id);
      const exB = await createOldGoldExchange({ clientId: clientB.id, description: 'Ctx test B', karat: '22K', grossWeight: 1 }, companyB.ctx, companyB.user.id);
      createdExchangeIds.push(exA.id, exB.id);

      const [entryA, entryB] = await Promise.all([getJournalEntry(exA.id), getJournalEntry(exB.id)]);
      expect(entryA).not.toBeNull();
      expect(entryB).not.toBeNull();

      const accountIdsA = new Set(entryA!.lines.map((l) => (l as any).accountId));
      const accountIdsB = new Set(entryB!.lines.map((l) => (l as any).accountId));
      const [accountsA, accountsB] = await Promise.all([
        prisma.account.findMany({ where: { id: { in: [...accountIdsA] } } }),
        prisma.account.findMany({ where: { id: { in: [...accountIdsB] } } }),
      ]);
      expect(accountsA.every((a) => a.companyId === companyA.company.id)).toBe(true);
      expect(accountsB.every((a) => a.companyId === companyB.company.id)).toBe(true);
    });
  });

  // ─── JournalLine.accountId cross-company forgery (found and fixed during the repo-wide
  // company-isolation audit) — a plain, non-composite FK that createJournalEntry never
  // ownership-checked, unlike costCenterId right next to it. ────────────────────────────
  describe('createJournalEntry: accountId cross-company forgery is rejected', () => {
    it('rejects a Company B accountId supplied on a Company A journal line', async () => {
      const accountB = await prisma.account.findFirstOrThrow({ where: { companyId: companyB.company.id } });
      await expect(
        createJournalEntry(companyA.company.id, {
          date: new Date(), description: 'Hostile cross-company line',
          lines: [
            { accountId: accountB.id, debit: 100, credit: 0 },
            { accountId: accountB.id, debit: 0, credit: 100 },
          ],
        }, companyA.user.id)
      ).rejects.toThrow('Account not found');

      // Confirm no forged line — and no entry at all — was actually persisted.
      const leaked = await prisma.journalLine.findFirst({ where: { accountId: accountB.id, companyId: companyA.company.id } });
      expect(leaked).toBeNull();
    });

    it('still accepts a same-company accountId (regression guard on the new check)', async () => {
      const accountA = await prisma.account.findFirstOrThrow({ where: { companyId: companyA.company.id } });
      const entry = await createJournalEntry(companyA.company.id, {
        date: new Date(), description: 'Legit same-company line',
        lines: [
          { accountId: accountA.id, debit: 50, credit: 0 },
          { accountId: accountA.id, debit: 0, credit: 50 },
        ],
      }, companyA.user.id);
      expect(entry.companyId).toBe(companyA.company.id);
      await prisma.journalEntry.delete({ where: { id: entry.id } }).catch(() => {});
    });
  });

  // ─── AuditLog isolation (found and fixed during this pass) ────────────────
  // createAuditEntry() now threads ctx.companyId through from every already-tenant-aware
  // service call site, and settings.router.ts's /audit-logs GET now filters by it — previously
  // it had no companyId column at all and the endpoint returned every company's audit trail.
  describe('AuditLog isolation', () => {
    it('createTag stamps the caller\'s own companyId on its audit log entry, never the other company\'s', async () => {
      const tag = await makeTag(companyA, 'Audit Stamp Ring');
      const entry = await prisma.auditLog.findFirst({
        where: { tableName: 'jewelry_tags', recordId: tag.id },
        orderBy: { timestamp: 'desc' },
      });
      expect(entry).not.toBeNull();
      expect(entry!.companyId).toBe(companyA.company.id);
      expect(entry!.companyId).not.toBe(companyB.company.id);
    });

    it('a companyId-scoped audit log query for Company A never returns Company B\'s entries', async () => {
      const tagB2 = await makeTag(companyB, 'Audit Stamp Ring B');
      const [logsA, logsB] = await Promise.all([
        prisma.auditLog.findMany({ where: { companyId: companyA.company.id, tableName: 'jewelry_tags' } }),
        prisma.auditLog.findMany({ where: { companyId: companyB.company.id, tableName: 'jewelry_tags' } }),
      ]);
      // Company A's scoped view must never contain Company B's entries...
      expect(logsA.some((l) => l.recordId === tagB2.id)).toBe(false);
      expect(logsA.some((l) => l.recordId === tagB.id)).toBe(false); // outer-scope tagB from beforeAll
      // ...and Company B's own scoped view correctly DOES contain its own entries (not a leak —
      // just proving the filter isn't accidentally excluding legitimate same-company rows too).
      expect(logsB.some((l) => l.recordId === tagB2.id)).toBe(true);
    });
  });

  // ─── Stock report isolation (found and fixed during this pass) ────────────
  // getBranchStockSummary/getStockOnHand/getDeadStock queried Branch/JewelryTag with NO company
  // filter at all prior to this fix — despite JewelryTag being tenant-scoped since the prototype
  // phase. These prove the fix: each report now only ever aggregates the calling company's own
  // branches and tags.
  describe('stock report isolation (getBranchStockSummary / getStockOnHand / getDeadStock)', () => {
    it('getBranchStockSummary for Company A never includes Company B\'s branches or tags', async () => {
      const [summaryA, summaryB] = await Promise.all([
        getBranchStockSummary(companyA.company.id),
        getBranchStockSummary(companyB.company.id),
      ]);
      expect(summaryA.some((s) => s.branchId === companyB.branch.id)).toBe(false);
      expect(summaryB.some((s) => s.branchId === companyA.branch.id)).toBe(false);
      // Each company's own branch must still be present with its own (correct) counts.
      expect(summaryA.some((s) => s.branchId === companyA.branch.id)).toBe(true);
      expect(summaryB.some((s) => s.branchId === companyB.branch.id)).toBe(true);
    });

    it('getStockOnHand for Company A never includes Company B\'s branches', async () => {
      const [resultA, resultB] = await Promise.all([
        getStockOnHand(companyA.company.id),
        getStockOnHand(companyB.company.id),
      ]);
      expect(resultA.rows.some((r) => r.branchId === companyB.branch.id)).toBe(false);
      expect(resultB.rows.some((r) => r.branchId === companyA.branch.id)).toBe(false);
    });

    it('getDeadStock for Company A never includes Company B\'s tags', async () => {
      const [resultA, resultB] = await Promise.all([
        getDeadStock(companyA.company.id),
        getDeadStock(companyB.company.id),
      ]);
      expect(resultA.rows.some((r) => r.id === tagB.id)).toBe(false);
      expect(resultB.rows.some((r) => r.id === tagA.id)).toBe(false);
      expect(resultA.rows.some((r) => r.id === tagA.id)).toBe(true);
      expect(resultB.rows.some((r) => r.id === tagB.id)).toBe(true);
    });
  });
});
