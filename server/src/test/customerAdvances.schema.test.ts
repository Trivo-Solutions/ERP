import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database';
import { createTestTenant, cleanupTestTenant, TestTenant, withForcedRls } from './fixtures';
import { LEDGER_ACCOUNT } from '../shared/ledgerAccounts';
import { deleteClient } from '../modules/orders/orders.service';

// ═══════════════════════════════════════════════════════════════════════════
// Customer Advances — Phase 1 (schema only; migration 20261007100000_customer_advances). Fixtures write with the
// platform role (BYPASSRLS) on purpose: every refusal below must come from the DATABASE (composite FK / CHECK /
// RLS), not from application code, since Phase 1 has no service.
// ═══════════════════════════════════════════════════════════════════════════

describe('Customer Advances Phase 1 — schema, constraints and isolation', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant; let B: TestTenant;
  const ids: Record<string, string> = {};
  let seq = 0;
  const num = () => `ADV-T-${suffix}-${seq++}`;

  const advance = (t: TestTenant, clientId: string, over: Record<string, unknown> = {}) => prisma.customerAdvance.create({
    data: { companyId: t.company.id, branchId: t.branch.id, clientId, advanceNumber: num(), advanceDate: new Date(), amount: 1000, mode: 'CASH', createdById: t.user.id, ...over } as any,
  });

  async function payment(t: TestTenant, clientId: string, invoiceId: string) {
    return prisma.invoicePayment.create({
      data: { companyId: t.company.id, paymentNumber: `PMT-T-${suffix}-${seq++}`, invoiceId, clientId, paymentDate: new Date(), amount: 100, mode: 'ADVANCE' },
    });
  }

  beforeAll(async () => {
    A = await createTestTenant(`ADVA${suffix}`, []);
    B = await createTestTenant(`ADVB${suffix}`, []);
    const mk = (t: TestTenant, code: string) => prisma.client.create({ data: { companyId: t.company.id, clientCode: `${code}-${suffix}`, name: code, type: 'RETAIL' } });
    ids.clientA1 = (await mk(A, 'A1')).id; ids.clientA2 = (await mk(A, 'A2')).id; ids.clientB = (await mk(B, 'B1')).id;
    const inv = (t: TestTenant, clientId: string, n: string) => prisma.salesInvoice.create({
      data: { companyId: t.company.id, branchId: t.branch.id, invoiceNumber: `${n}-${suffix}`, clientId, invoiceDate: new Date(), invoiceType: 'RETAIL', subtotal: 100, totalAmount: 100, balanceDue: 100 },
    });
    ids.invA1 = (await inv(A, ids.clientA1, 'IA1')).id; ids.invA2 = (await inv(A, ids.clientA2, 'IA2')).id; ids.invB = (await inv(B, ids.clientB, 'IB')).id;
    ids.advA1 = (await advance(A, ids.clientA1)).id;
    ids.advB = (await advance(B, ids.clientB)).id;
  }, 60_000);

  afterAll(async () => {
    await cleanupTestTenant(A); await cleanupTestTenant(B);
    await prisma.user.deleteMany({ where: { email: { in: [A.user.email, B.user.email] } } });
    await prisma.$disconnect();
  });

  // ── Foreign keys ──
  it('rejects an advance whose client belongs to another company', async () => {
    await expect(advance(B, ids.clientA1)).rejects.toThrow(/foreign key/i);
  });
  it('rejects an advance whose branch belongs to another company', async () => {
    await expect(advance(B, ids.clientB, { branchId: A.branch.id })).rejects.toThrow(/foreign key/i);
  });

  it('accepts an application whose advance, invoice and payment all belong to the same customer', async () => {
    const pay = await payment(A, ids.clientA1, ids.invA1);
    const app = await prisma.customerAdvanceApplication.create({
      data: { companyId: A.company.id, advanceId: ids.advA1, clientId: ids.clientA1, invoiceId: ids.invA1, invoicePaymentId: pay.id, amount: 100, appliedById: A.user.id },
    });
    expect(app.invoicePaymentId).toBe(pay.id); // InvoicePayment (id, clientId, companyId) composite target works
    await prisma.customerAdvanceApplication.delete({ where: { id: app.id } });
  });

  it('rejects a cross-company application (advance owned by another company)', async () => {
    const pay = await payment(A, ids.clientA1, ids.invA1);
    await expect(prisma.customerAdvanceApplication.create({
      data: { companyId: A.company.id, advanceId: ids.advB, clientId: ids.clientA1, invoiceId: ids.invA1, invoicePaymentId: pay.id, amount: 10, appliedById: A.user.id },
    })).rejects.toThrow(/foreign key/i);
  });

  it('rejects a cross-company application (invoice owned by another company)', async () => {
    const pay = await payment(A, ids.clientA1, ids.invA1);
    await expect(prisma.customerAdvanceApplication.create({
      data: { companyId: A.company.id, advanceId: ids.advA1, clientId: ids.clientA1, invoiceId: ids.invB, invoicePaymentId: pay.id, amount: 10, appliedById: A.user.id },
    })).rejects.toThrow(/foreign key/i);
  });

  it('rejects a cross-customer application (advance belongs to client A1, payment to A2)', async () => {
    const payOther = await payment(A, ids.clientA2, ids.invA2);
    await expect(prisma.customerAdvanceApplication.create({
      data: { companyId: A.company.id, advanceId: ids.advA1, clientId: ids.clientA1, invoiceId: ids.invA2, invoicePaymentId: payOther.id, amount: 10, appliedById: A.user.id },
    })).rejects.toThrow(/foreign key/i);
    // …and the mirror image: payment is A1's, but the row claims A2's advance.
    const adv2 = await advance(A, ids.clientA2);
    const payA1 = await payment(A, ids.clientA1, ids.invA1);
    await expect(prisma.customerAdvanceApplication.create({
      data: { companyId: A.company.id, advanceId: adv2.id, clientId: ids.clientA2, invoiceId: ids.invA1, invoicePaymentId: payA1.id, amount: 10, appliedById: A.user.id },
    })).rejects.toThrow(/foreign key/i);
  });

  it('one payment can back at most one application (unique invoicePaymentId)', async () => {
    const pay = await payment(A, ids.clientA1, ids.invA1);
    const data = { companyId: A.company.id, advanceId: ids.advA1, clientId: ids.clientA1, invoiceId: ids.invA1, invoicePaymentId: pay.id, amount: 10, appliedById: A.user.id };
    await prisma.customerAdvanceApplication.create({ data });
    await expect(prisma.customerAdvanceApplication.create({ data })).rejects.toThrow(/unique/i);
  });

  // ── Uniqueness ──
  it('advance number is unique per company but reusable across companies; idempotency key likewise', async () => {
    const n = num();
    await advance(A, ids.clientA1, { advanceNumber: n, idempotencyKey: `K-${suffix}` });
    await expect(advance(A, ids.clientA1, { advanceNumber: n })).rejects.toThrow(/unique/i);
    await expect(advance(A, ids.clientA1, { idempotencyKey: `K-${suffix}` })).rejects.toThrow(/unique/i);
    await expect(advance(B, ids.clientB, { advanceNumber: n, idempotencyKey: `K-${suffix}` })).resolves.toBeTruthy();
  });

  // ── CHECK constraints ──
  it('CHECK: amount must be positive', async () => {
    await expect(advance(A, ids.clientA1, { amount: 0 })).rejects.toThrow(/check/i);
    await expect(advance(A, ids.clientA1, { amount: -5 })).rejects.toThrow(/check/i);
  });
  it('CHECK: appliedAmount and refundedAmount cannot be negative', async () => {
    await expect(advance(A, ids.clientA1, { appliedAmount: -1 })).rejects.toThrow(/check/i);
    await expect(advance(A, ids.clientA1, { refundedAmount: -1 })).rejects.toThrow(/check/i);
  });
  it('CHECK: applied + refunded cannot exceed amount (on insert and on update)', async () => {
    await expect(advance(A, ids.clientA1, { amount: 100, appliedAmount: 60, refundedAmount: 41 })).rejects.toThrow(/check/i);
    await expect(prisma.customerAdvance.update({ where: { id: ids.advA1 }, data: { appliedAmount: 1001 } })).rejects.toThrow(/check/i);
    await expect(advance(A, ids.clientA1, { amount: 100, appliedAmount: 60, refundedAmount: 40 })).resolves.toBeTruthy(); // exactly full is fine
  });
  it('CHECK: an application amount must be positive', async () => {
    const pay = await payment(A, ids.clientA1, ids.invA1);
    await expect(prisma.customerAdvanceApplication.create({
      data: { companyId: A.company.id, advanceId: ids.advA1, clientId: ids.clientA1, invoiceId: ids.invA1, invoicePaymentId: pay.id, amount: 0, appliedById: A.user.id },
    })).rejects.toThrow(/check/i);
  });

  // ── RLS ──
  it('RLS: customer_advances is invisible/immutable across companies and fail-closed with no tenant', async () => {
    await withForcedRls(['customer_advances'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id FROM customer_advances WHERE id IN (${ids.advA1}, ${ids.advB})`;
      expect(rows.map((r) => r.id)).toEqual([ids.advA1]);
      expect(Number(await tx.$executeRaw`UPDATE customer_advances SET notes = 'x' WHERE id = ${ids.advB}`)).toBe(0);
      expect(Number(await tx.$executeRaw`DELETE FROM customer_advances WHERE id = ${ids.advB}`)).toBe(0);
      await expect(tx.$executeRaw`INSERT INTO customer_advances (id, "companyId", "branchId", "clientId", "advanceNumber", "advanceDate", amount, mode, "createdById", "updatedAt")
        VALUES (${'x' + suffix}, ${B.company.id}, ${B.branch.id}, ${ids.clientB}, ${num()}, now(), 5, 'CASH', ${B.user.id}, now())`).rejects.toThrow(/row-level security|policy/i);
    });
    await withForcedRls(['customer_advances'], async (tx) => {
      const rows: any[] = await tx.$queryRaw`SELECT id FROM customer_advances WHERE id IN (${ids.advA1}, ${ids.advB})`;
      expect(rows).toHaveLength(0);
    });
  });

  it('RLS: customer_advance_applications is invisible across companies', async () => {
    const payB = await payment(B, ids.clientB, ids.invB);
    const appB = await prisma.customerAdvanceApplication.create({
      data: { companyId: B.company.id, advanceId: ids.advB, clientId: ids.clientB, invoiceId: ids.invB, invoicePaymentId: payB.id, amount: 10, appliedById: B.user.id },
    });
    await withForcedRls(['customer_advance_applications'], async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
      const rows: any[] = await tx.$queryRaw`SELECT id FROM customer_advance_applications WHERE id = ${appB.id}`;
      expect(rows).toHaveLength(0);
      expect(Number(await tx.$executeRaw`DELETE FROM customer_advance_applications WHERE id = ${appB.id}`)).toBe(0);
    });
    await withForcedRls(['customer_advance_applications'], async (tx) => {
      const rows: any[] = await tx.$queryRaw`SELECT id FROM customer_advance_applications WHERE id = ${appB.id}`;
      expect(rows).toHaveLength(0); // no tenant set -> fail closed
    });
  });

  it('both tables carry a tenant_isolation policy', async () => {
    const rows: any[] = await prisma.$queryRaw`SELECT tablename FROM pg_policies WHERE policyname = 'tenant_isolation' AND tablename IN ('customer_advances', 'customer_advance_applications')`;
    expect(rows.map((r) => r.tablename).sort()).toEqual(['customer_advance_applications', 'customer_advances']);
  });

  // ── Ledger account ──
  it('2400 Customer Advances exists (liability) for a company, and the constant matches', async () => {
    expect(LEDGER_ACCOUNT.CUSTOMER_ADVANCES).toBe('2400');
    const acct = await prisma.account.findUnique({ where: { companyId_code: { companyId: A.company.id, code: '2400' } } });
    expect(acct).toMatchObject({ name: 'Customer Advances', type: 'LIABILITY', isSystem: true });
  });
  it('the migration seeded 2400 for every company that has a chart of accounts', async () => {
    const rows: any[] = await prisma.$queryRaw`SELECT c.id FROM companies c WHERE NOT EXISTS (SELECT 1 FROM accounts a WHERE a."companyId" = c.id AND a.code = '2400')
      AND EXISTS (SELECT 1 FROM accounts a WHERE a."companyId" = c.id AND a.code = '1101')`;
    expect(rows).toEqual([]);
  });

  // ── Client deletion protection ──
  it('a client with a customer advance cannot be permanently deleted (409), and survives', async () => {
    const c = await prisma.client.create({ data: { companyId: A.company.id, clientCode: `DEL-${suffix}`, name: 'Del', type: 'RETAIL' } });
    await advance(A, c.id);
    await expect(deleteClient(c.id, A.ctx, A.user.id, 'test')).rejects.toMatchObject({ statusCode: 409 });
    expect(await prisma.client.findUnique({ where: { id: c.id } })).not.toBeNull();
  });
  it('the database also refuses to delete a client that holds an advance (RESTRICT, no cascade)', async () => {
    const c = await prisma.client.create({ data: { companyId: A.company.id, clientCode: `DEL2-${suffix}`, name: 'Del2', type: 'RETAIL' } });
    await advance(A, c.id);
    await expect(prisma.client.delete({ where: { id: c.id } })).rejects.toThrow(/foreign key/i);
  });
});
