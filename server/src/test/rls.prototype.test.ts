import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createTestTenant, cleanupTestTenant, TestTenant, withForcedRls } from './fixtures';

// ═══════════════════════════════════════════════════
// PostgreSQL Row-Level Security — direct proof of the policies added by migration
// 20260923130000_rls_prototype_policies.
//
// Why this test temporarily sets FORCE ROW LEVEL SECURITY itself, inside a transaction it
// always rolls back, instead of relying on a separate low-privilege "runtime" role:
//
//   This environment's database role (the one in DATABASE_URL, used for both migrations and
//   the live app) is not a Postgres superuser and does not have BYPASSRLS — but it DOES own
//   every table, and table owners bypass RLS by default unless FORCE ROW LEVEL SECURITY is
//   also set. Creating a genuinely separate, non-owner "erp_runtime" role (the architecturally
//   correct long-term setup — see the implementation report) requires CREATEROLE or superuser
//   privileges, which were not available in this environment. Rather than skip proving RLS
//   entirely, or unsafely flip the live app's connection to a state most of its existing read
//   paths aren't ready for (see the migration's own comment for exactly which paths would
//   break), this test proves the POLICIES THEMSELVES are correct by: opening one transaction,
//   setting FORCE ROW LEVEL SECURITY on the tables under test (DDL is transactional in
//   Postgres — this take effect only for the duration of this transaction), running the real
//   assertions against real committed data from two companies, and then always rolling back
//   (even on success) so neither the FORCE flag nor any incidental write escapes this test.
//
//   This is a genuine, live proof against the real schema and real policies — not a mock —
//   it just doesn't (yet) prove the separate-role deployment shape, which remains a
//   documented, explicit next step.
// ═══════════════════════════════════════════════════

describe('PostgreSQL RLS policies (migration 20260923130000)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let companyA: TestTenant;
  let companyB: TestTenant;
  let tagA: { id: string };
  let tagB: { id: string };

  beforeAll(async () => {
    companyA = await createTestTenant(`RLSA${suffix}`, []);
    companyB = await createTestTenant(`RLSB${suffix}`, []);

    tagA = await prisma.jewelryTag.create({
      data: {
        companyId: companyA.company.id, branchId: companyA.branch.id,
        tagNumber: `RLSTAG-A-${suffix}`, name: 'RLS Test Ring A', metalType: 'GOLD',
        grossWeight: 5, netWeight: 5, createdById: companyA.user.id,
      },
    });
    tagB = await prisma.jewelryTag.create({
      data: {
        companyId: companyB.company.id, branchId: companyB.branch.id,
        tagNumber: `RLSTAG-B-${suffix}`, name: 'RLS Test Ring B', metalType: 'GOLD',
        grossWeight: 5, netWeight: 5, createdById: companyB.user.id,
      },
    });
  });

  afterAll(async () => {
    await prisma.jewelryTag.deleteMany({ where: { id: { in: [tagA.id, tagB.id] } } });
    await cleanupTestTenant(companyA);
    await cleanupTestTenant(companyB);
    await prisma.$disconnect();
  });


  it('direct SELECT: a session scoped to Company A sees only Company A\'s tag', async () => {
    await withForcedRls(['jewelry_tags'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id, "companyId" FROM jewelry_tags WHERE id IN (${tagA.id}, ${tagB.id})`;
      expect(rows.map((r) => r.id)).toContain(tagA.id);
      expect(rows.map((r) => r.id)).not.toContain(tagB.id);
    });
  });

  it('direct SELECT: switching the session to Company B sees only Company B\'s tag (symmetric)', async () => {
    await withForcedRls(['jewelry_tags'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyB.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id, "companyId" FROM jewelry_tags WHERE id IN (${tagA.id}, ${tagB.id})`;
      expect(rows.map((r) => r.id)).toContain(tagB.id);
      expect(rows.map((r) => r.id)).not.toContain(tagA.id);
    });
  });

  it('fail-closed: no session variable set means zero rows, not every row', async () => {
    await withForcedRls(['jewelry_tags'], async (tx) => {
      // Deliberately do NOT call set_config — simulates a query that reached the database
      // outside any tenant-scoped transaction (e.g. a bug, a future raw script).
      const rows: any[] = await tx.$queryRaw`SELECT id FROM jewelry_tags WHERE id IN (${tagA.id}, ${tagB.id})`;
      expect(rows).toHaveLength(0);
    });
  });

  it('direct UPDATE respects the same policy — cannot update a row outside the session\'s company', async () => {
    await withForcedRls(['jewelry_tags'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      const result = await tx.$executeRaw`UPDATE jewelry_tags SET notes = 'hacked' WHERE id = ${tagB.id}`;
      expect(Number(result)).toBe(0); // zero rows matched — tagB is invisible under Company A's session
    });
  });

  it('direct DELETE respects the same policy', async () => {
    await withForcedRls(['jewelry_tags'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      const result = await tx.$executeRaw`DELETE FROM jewelry_tags WHERE id = ${tagB.id}`;
      expect(Number(result)).toBe(0);
    });
  });

  it('WITH CHECK rejects an INSERT whose companyId doesn\'t match the active session', async () => {
    await withForcedRls(['jewelry_tags'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      await expect(
        tx.$executeRaw`INSERT INTO jewelry_tags
          (id, "companyId", "branchId", "tagNumber", name, "metalType", "grossWeight", "netWeight", "createdById", "createdAt", "updatedAt")
          VALUES (gen_random_uuid()::text, ${companyB.company.id}, ${companyB.branch.id}, ${'RLS-FORGE-' + suffix},
                  'Forged row', 'GOLD', 1, 1, ${companyA.user.id}, now(), now())`
      ).rejects.toThrow(); // WITH CHECK violates row-level security policy
    });
  });

  // ─── Foreign keys are NOT protected by RLS — and what covers that ─────────────────────────────────────────
  // PostgreSQL foreign-key / referential-integrity checks do NOT consult RLS policies on the referenced table, so a
  // PLAIN foreign key accepts an id belonging to another company. This is demonstrated directly (a Company-B session
  // — for which Company A's rows are invisible — links a design to Company A's design category), and the boundary is
  // covered two ways: (1) the application verifies ownership of every client-supplied id (assertOwnedByCompany),
  // and (2) the high-risk relations are COMPOSITE foreign keys ("id","companyId"), which the database itself enforces
  // (Phase 5) — the same forgery on those is rejected below.

  it('a PLAIN foreign key still accepts another company\'s id (RLS does not protect FK references) — the boundary the explicit ownership checks cover', async () => {
    // designs.categoryId -> design_categories is deliberately NOT a composite key (dormant manufacturing internals).
    const catA = await prisma.designCategory.findFirstOrThrow({ where: { companyId: companyA.company.id } });
    await withForcedRls(['design_categories', 'designs'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyB.company.id}, true)`;
      const invisible: any[] = await tx.$queryRaw`SELECT id FROM design_categories WHERE id = ${catA.id}`;
      expect(invisible).toHaveLength(0); // A's category is invisible to this B session…
      await expect(tx.design.create({
        data: {
          companyId: companyB.company.id, designCode: `RLS-FK-${suffix}`, name: 'Forged FK design', categoryId: catA.id,
          metalKarat: '22K', grossWeightMin: 1, grossWeightMax: 2, netWeightMin: 1, netWeightMax: 2,
        },
      })).resolves.toBeDefined(); // …yet the FK to it is accepted.
    });
  });

  it('a COMPOSITE foreign key rejects the same forgery at the database: invoice_items.tagId -> Company A\'s tag', async () => {
    await withForcedRls(['jewelry_tags', 'invoice_items', 'sales_invoices'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyB.company.id}, true)`;
      const invoice = await tx.salesInvoice.create({
        data: {
          companyId: companyB.company.id, branchId: companyB.branch.id,
          invoiceNumber: `RLS-FK-TEST-${suffix}`, clientId: (await tx.client.create({
            data: { companyId: companyB.company.id, clientCode: `RLSFKCL-${suffix}`, name: 'RLS FK test client', type: 'RETAIL' },
          })).id,
          invoiceDate: new Date(), invoiceType: 'RETAIL',
          subtotal: 100, totalAmount: 100, balanceDue: 100,
        },
      });
      await expect(
        tx.invoiceItem.create({
          data: {
            companyId: companyB.company.id, invoiceId: invoice.id,
            productCode: 'FK-TEST', description: 'Forged FK reference to Company A\'s tag',
            quantity: 1, grossWeight: 1, netGoldWeight: 1, rateType: 'FIXED',
            goldRate: 100, makingCharge: 0, unitPrice: 100, totalPrice: 100, taxRate: 0.03,
            tagId: tagA.id, // <- another company's tag
          },
        })
      ).rejects.toThrow(/foreign key/i);
    });
  });
});
