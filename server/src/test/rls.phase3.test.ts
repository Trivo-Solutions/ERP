import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createTestTenant, cleanupTestTenant, TestTenant, withForcedRls } from './fixtures';

// ═══════════════════════════════════════════════════
// PostgreSQL Row-Level Security — direct proof of the policies added by migration
// 20260923180000_rls_phase3_policies, extending rls.prototype.test.ts / rls.phase2.test.ts's same
// proof technique (see rls.prototype.test.ts's own comment for the full "why FORCE inside a
// rolled-back transaction" reasoning — this environment's DB role owns every table and lacks the
// CREATEROLE privilege needed to create a genuine non-owner runtime role; Phase 4 Part H
// confirmed this is still true: `CREATE ROLE` fails against the dev database, and the `postgres`
// superuser role that exists in pg_roles has no credentials available to this session — see the
// Phase 4 report's Part H section for the production role-separation SQL this environment cannot
// exercise directly) to a representative sample of the 36 tables Phase 3 made company-owned,
// spanning header tables, denormalized child/detail tables, and different modules (manufacturing,
// procurement, inventory, finance): designs, job_cards, suppliers, metal_stocks, tax_invoices.
// ═══════════════════════════════════════════════════

describe('PostgreSQL RLS policies (migration 20260923180000, Phase 3 tables)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let companyA: TestTenant;
  let companyB: TestTenant;
  let categoryAId: string;
  let categoryBId: string;
  let designA: { id: string };
  let designB: { id: string };
  let supplierA: { id: string };
  let supplierB: { id: string };

  beforeAll(async () => {
    companyA = await createTestTenant(`RLS3A${suffix}`, []);
    companyB = await createTestTenant(`RLS3B${suffix}`, []);

    categoryAId = (await prisma.designCategory.create({ data: { companyId: companyA.company.id, code: `RLS3CAT-${suffix}`, name: 'RLS3 Category' } })).id;
    categoryBId = (await prisma.designCategory.create({ data: { companyId: companyB.company.id, code: `RLS3CAT-${suffix}`, name: 'RLS3 Category' } })).id;

    designA = await prisma.design.create({
      data: { companyId: companyA.company.id, designCode: `RLS3DES-A-${suffix}`, name: 'RLS3 Design A', categoryId: categoryAId, metalKarat: '22K', grossWeightMin: 4, grossWeightMax: 6, netWeightMin: 3, netWeightMax: 5 },
    });
    designB = await prisma.design.create({
      data: { companyId: companyB.company.id, designCode: `RLS3DES-B-${suffix}`, name: 'RLS3 Design B', categoryId: categoryBId, metalKarat: '22K', grossWeightMin: 4, grossWeightMax: 6, netWeightMin: 3, netWeightMax: 5 },
    });

    supplierA = await prisma.supplier.create({ data: { companyId: companyA.company.id, supplierCode: `RLS3SUP-A-${suffix}`, name: 'RLS3 Supplier A', type: 'OTHER' } });
    supplierB = await prisma.supplier.create({ data: { companyId: companyB.company.id, supplierCode: `RLS3SUP-B-${suffix}`, name: 'RLS3 Supplier B', type: 'OTHER' } });
  });

  afterAll(async () => {
    await prisma.design.deleteMany({ where: { id: { in: [designA.id, designB.id] } } });
    await prisma.designCategory.deleteMany({ where: { id: { in: [categoryAId, categoryBId] } } });
    await prisma.supplier.deleteMany({ where: { id: { in: [supplierA.id, supplierB.id] } } });
    await cleanupTestTenant(companyA);
    await cleanupTestTenant(companyB);
    await prisma.$disconnect();
  });


  it('designs: SELECT scoped to Company A never sees Company B\'s design', async () => {
    await withForcedRls(['designs'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id FROM designs WHERE id IN (${designA.id}, ${designB.id})`;
      expect(rows.map((r) => r.id)).toEqual([designA.id]);
    });
  });

  it('designs: fail-closed — no session variable set means zero rows, not every row', async () => {
    await withForcedRls(['designs'], async (tx) => {
      const rows: any[] = await tx.$queryRaw`SELECT id FROM designs WHERE id IN (${designA.id}, ${designB.id})`;
      expect(rows).toHaveLength(0);
    });
  });

  it('designs: UPDATE cannot touch a row outside the session\'s company', async () => {
    await withForcedRls(['designs'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      const result = await tx.$executeRaw`UPDATE designs SET name = 'hacked' WHERE id = ${designB.id}`;
      expect(Number(result)).toBe(0);
    });
  });

  it('designs: DELETE cannot remove a row outside the session\'s company', async () => {
    await withForcedRls(['designs'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      const result = await tx.$executeRaw`DELETE FROM designs WHERE id = ${designB.id}`;
      expect(Number(result)).toBe(0);
    });
    // Prove it's still there (the DELETE really was blocked, not a no-op for some other reason).
    const stillThere = await prisma.design.findUnique({ where: { id: designB.id } });
    expect(stillThere).not.toBeNull();
  });

  it('designs: WITH CHECK rejects an INSERT whose companyId doesn\'t match the active session', async () => {
    await withForcedRls(['designs'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      await expect(
        tx.$executeRaw`INSERT INTO designs
          (id, "companyId", "designCode", name, "categoryId", "metalKarat", "grossWeightMin", "grossWeightMax", "netWeightMin", "netWeightMax", "createdAt", "updatedAt")
          VALUES (gen_random_uuid()::text, ${companyB.company.id}, ${'RLS3-FORGE-' + suffix}, 'Forged design', ${categoryBId}, '22K', 4, 6, 3, 5, now(), now())`
      ).rejects.toThrow();
    });
  });

  // job_cards — sample the manufacturing module (JobCard has no branchId; proves the policy still
  // works on a table whose only tenant identifier is the denormalized companyId column).
  it('job_cards: SELECT/UPDATE respect the policy on a manufacturing-module table', async () => {
    const jobCardA = await prisma.jobCard.create({
      data: { companyId: companyA.company.id, jobNumber: `RLS3JC-A-${suffix}`, designId: designA.id, issuedWeight: 5, barcodeData: `RLS3-BC-${suffix}` },
    });
    const jobCardB = await prisma.jobCard.create({
      data: { companyId: companyB.company.id, jobNumber: `RLS3JC-B-${suffix}`, designId: designB.id, issuedWeight: 5, barcodeData: `RLS3-BC2-${suffix}` },
    });

    await withForcedRls(['job_cards'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id FROM job_cards WHERE id IN (${jobCardA.id}, ${jobCardB.id})`;
      expect(rows.map((r) => r.id)).toEqual([jobCardA.id]);

      const result = await tx.$executeRaw`UPDATE job_cards SET notes = 'hacked' WHERE id = ${jobCardB.id}`;
      expect(Number(result)).toBe(0);
    });

    await prisma.jobCard.deleteMany({ where: { id: { in: [jobCardA.id, jobCardB.id] } } });
  });

  // suppliers — sample the procurement module (reversed from an earlier "keep global" call, see
  // Phase 3's report; proves the reversal is actually backstopped by RLS, not just app code).
  it('suppliers: a session scoped to Company A never sees Company B\'s supplier', async () => {
    await withForcedRls(['suppliers'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id, "companyId" FROM suppliers WHERE id IN (${supplierA.id}, ${supplierB.id})`;
      expect(rows.map((r) => r.id)).toEqual([supplierA.id]);
    });
  });

  // metal_stocks — sample the inventory module.
  it('metal_stocks: a session scoped to Company A never sees Company B\'s metal stock', async () => {
    const stockA = await prisma.metalStock.create({
      data: { companyId: companyA.company.id, stockCode: `RLS3MS-A-${suffix}`, materialName: 'Gold', karat: '22K', purity: 0.916, grossWeight: 10, netWeight: 10, availableWt: 10, sourceType: 'PURCHASE', avgCostPerGram: 5500 },
    });
    const stockB = await prisma.metalStock.create({
      data: { companyId: companyB.company.id, stockCode: `RLS3MS-B-${suffix}`, materialName: 'Gold', karat: '22K', purity: 0.916, grossWeight: 10, netWeight: 10, availableWt: 10, sourceType: 'PURCHASE', avgCostPerGram: 5500 },
    });

    await withForcedRls(['metal_stocks'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyB.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id FROM metal_stocks WHERE id IN (${stockA.id}, ${stockB.id})`;
      expect(rows.map((r) => r.id)).toEqual([stockB.id]);
    });

    await prisma.metalStock.deleteMany({ where: { id: { in: [stockA.id, stockB.id] } } });
  });

  // tax_invoices — a denormalized child/detail table (companyId copied directly rather than only
  // reachable via a join to sales_invoices), proving the policy applies to the child row itself.
  it('tax_invoices: policy applies to the denormalized companyId column directly, not just via sales_invoices', async () => {
    const clientA = await prisma.client.create({ data: { companyId: companyA.company.id, clientCode: `RLS3CL-${suffix}`, name: 'RLS3 Client', type: 'RETAIL' } });
    const invoiceA = await prisma.salesInvoice.create({
      data: {
        companyId: companyA.company.id, branchId: companyA.branch.id, clientId: clientA.id,
        invoiceNumber: `RLS3INV-${suffix}`, invoiceDate: new Date(), invoiceType: 'RETAIL',
        subtotal: 1000, taxAmount: 30, totalAmount: 1030, balanceDue: 1030, currency: 'INR',
        taxDetails: { create: { gstin: '24TESTGSTIN0001Z', placeOfSupply: '24', taxableAmount: 1000, cgst: 15, sgst: 15, igst: 0, cess: 0, totalTax: 30 } },
      },
      include: { taxDetails: true },
    });

    await withForcedRls(['tax_invoices'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyB.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id FROM tax_invoices WHERE id = ${invoiceA.taxDetails!.id}`;
      expect(rows).toHaveLength(0); // Company B's session must not see Company A's tax invoice
    });

    await prisma.taxInvoice.deleteMany({ where: { id: invoiceA.taxDetails!.id } }); // RESTRICT FK — must go before the invoice
    await prisma.salesInvoice.deleteMany({ where: { id: invoiceA.id } });
    await prisma.client.deleteMany({ where: { id: clientA.id } });
  });
});
