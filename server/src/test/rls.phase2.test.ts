import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createTestTenant, cleanupTestTenant, TestTenant, withForcedRls } from './fixtures';

// ═══════════════════════════════════════════════════
// PostgreSQL Row-Level Security — direct proof of the policies added by migration
// 20260923150000_rls_phase2_policies, extending rls.prototype.test.ts's same proof technique
// (see that file's own comment for the full "why FORCE inside a rolled-back transaction"
// reasoning — this environment's DB role owns every table and lacks the CREATEROLE privilege
// needed to create a genuine non-owner runtime role) to the 12 tables Phase 2 made
// company-owned: old_gold_exchanges, memo_outs, stock_audits, branch_transfers, tag_templates,
// invoice_payments, sales_returns, accounts, journal_entries, cost_centers (memo_items and
// journal_lines share the same policy shape and are exercised indirectly via their parents).
// ═══════════════════════════════════════════════════

describe('PostgreSQL RLS policies (migration 20260923150000, Phase 2 tables)', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let companyA: TestTenant;
  let companyB: TestTenant;
  let exchangeA: { id: string };
  let exchangeB: { id: string };
  let clientA: { id: string };
  let clientB: { id: string };

  beforeAll(async () => {
    companyA = await createTestTenant(`RLS2A${suffix}`, []);
    companyB = await createTestTenant(`RLS2B${suffix}`, []);

    clientA = await prisma.client.create({
      data: { companyId: companyA.company.id, clientCode: `RLS2CL-A-${suffix}`, name: 'RLS2 Client A', type: 'RETAIL' },
    });
    clientB = await prisma.client.create({
      data: { companyId: companyB.company.id, clientCode: `RLS2CL-B-${suffix}`, name: 'RLS2 Client B', type: 'RETAIL' },
    });

    exchangeA = await prisma.oldGoldExchange.create({
      data: {
        companyId: companyA.company.id, clientId: clientA.id,
        exchangeNumber: `RLS2OGX-A-${suffix}`, description: 'RLS test piece A',
        karat: '22K', grossWeight: 5, netWeight: 5, ratePerGram: 5000, valuedAmount: 25000,
      },
    });
    exchangeB = await prisma.oldGoldExchange.create({
      data: {
        companyId: companyB.company.id, clientId: clientB.id,
        exchangeNumber: `RLS2OGX-B-${suffix}`, description: 'RLS test piece B',
        karat: '22K', grossWeight: 5, netWeight: 5, ratePerGram: 5000, valuedAmount: 25000,
      },
    });
  });

  afterAll(async () => {
    await prisma.oldGoldExchange.deleteMany({ where: { id: { in: [exchangeA.id, exchangeB.id] } } });
    await prisma.client.deleteMany({ where: { id: { in: [clientA.id, clientB.id] } } });
    await cleanupTestTenant(companyA);
    await cleanupTestTenant(companyB);
    await prisma.$disconnect();
  });


  it('direct SELECT: a session scoped to Company A sees only Company A\'s old_gold_exchanges row', async () => {
    await withForcedRls(['old_gold_exchanges'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id FROM old_gold_exchanges WHERE id IN (${exchangeA.id}, ${exchangeB.id})`;
      expect(rows.map((r) => r.id)).toContain(exchangeA.id);
      expect(rows.map((r) => r.id)).not.toContain(exchangeB.id);
    });
  });

  it('direct SELECT: switching the session to Company B sees only Company B\'s row (symmetric)', async () => {
    await withForcedRls(['old_gold_exchanges'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyB.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id FROM old_gold_exchanges WHERE id IN (${exchangeA.id}, ${exchangeB.id})`;
      expect(rows.map((r) => r.id)).toContain(exchangeB.id);
      expect(rows.map((r) => r.id)).not.toContain(exchangeA.id);
    });
  });

  it('fail-closed: no session variable set means zero rows, not every row', async () => {
    await withForcedRls(['old_gold_exchanges'], async (tx) => {
      const rows: any[] = await tx.$queryRaw`SELECT id FROM old_gold_exchanges WHERE id IN (${exchangeA.id}, ${exchangeB.id})`;
      expect(rows).toHaveLength(0);
    });
  });

  it('direct UPDATE respects the policy — cannot update a row outside the session\'s company', async () => {
    await withForcedRls(['old_gold_exchanges'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      const result = await tx.$executeRaw`UPDATE old_gold_exchanges SET description = 'hacked' WHERE id = ${exchangeB.id}`;
      expect(Number(result)).toBe(0);
    });
  });

  it('WITH CHECK rejects an INSERT whose companyId doesn\'t match the active session', async () => {
    await withForcedRls(['old_gold_exchanges'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      await expect(
        tx.$executeRaw`INSERT INTO old_gold_exchanges
          (id, "companyId", "clientId", "exchangeNumber", description, karat, "grossWeight", "netWeight", "ratePerGram", "valuedAmount", "createdAt")
          VALUES (gen_random_uuid()::text, ${companyB.company.id}, ${clientB.id}, ${'RLS2-FORGE-' + suffix},
                  'Forged row', '22K', 1, 1, 5000, 5000, now())`
      ).rejects.toThrow();
    });
  });

  // Sample a second table (accounts — fixtures.ts seeds a full chart per company) to prove the
  // policy generalizes across the 12 tables, not just old_gold_exchanges specifically.
  it('accounts: a session scoped to Company A never sees Company B\'s account rows', async () => {
    await withForcedRls(['accounts'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id, "companyId" FROM accounts WHERE "companyId" IN (${companyA.company.id}, ${companyB.company.id})`;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.companyId === companyA.company.id)).toBe(true);
    });
  });

  // memo_items has no direct companyId-independent identity worth asserting beyond what
  // memo_outs already proves, but it DOES carry its own companyId column (denormalized) — prove
  // its own policy independently, not just via a memo_outs join.
  it('memo_items: policy applies to the denormalized companyId column directly, not just via memo_outs', async () => {
    const branchA = companyA.branch.id;
    const tagA = await prisma.jewelryTag.create({
      data: {
        companyId: companyA.company.id, branchId: branchA, tagNumber: `RLS2TAG-${suffix}`,
        name: 'RLS2 Memo Ring', metalType: 'GOLD', grossWeight: 5, netWeight: 5, createdById: companyA.user.id,
      },
    });
    const memo = await prisma.memoOut.create({
      data: {
        companyId: companyA.company.id, branchId: branchA, clientId: clientA.id,
        memoNumber: `RLS2MEM-${suffix}`, sentDate: new Date(), returnDeadline: new Date(Date.now() + 7 * 86_400_000),
        items: { create: { productCode: tagA.tagNumber, description: 'RLS2 memo item', pieces: 1, grossWeight: 5, netGoldWeight: 5, estimatedValue: 25000, tagId: tagA.id } },
      },
      include: { items: true },
    });

    await withForcedRls(['memo_items'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyB.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id FROM memo_items WHERE id = ${memo.items[0].id}`;
      expect(rows).toHaveLength(0); // Company B's session must not see Company A's memo item
    });

    await prisma.memoOut.deleteMany({ where: { id: memo.id } }); // cascades memo_items
    await prisma.jewelryTag.deleteMany({ where: { id: tagA.id } });
  });
});
