import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { createTestTenant, cleanupTestTenant, TestTenant, REAL_ROLE_SPLIT, rlsClient } from '../../test/fixtures';
import { listConfigs, upsertConfig } from './settings.service';

// SystemConfig used to be one global table (`key @unique`) shared by every company. These prove
// it is now genuinely per-company — at the service layer, at the unique constraint, and at the
// Postgres RLS policy (same forced-RLS-inside-a-rolled-back-transaction technique as
// rls.phase3.test.ts, since the dev role owns the tables and is otherwise exempt from RLS).

describe('SystemConfig is company-scoped', () => {
  const suffix = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let companyA: TestTenant;
  let companyB: TestTenant;
  const KEY = `TEST_MARGIN_${suffix}`;

  beforeAll(async () => {
    companyA = await createTestTenant(`CFGA${suffix}`, []);
    companyB = await createTestTenant(`CFGB${suffix}`, []);
  });

  afterAll(async () => {
    await cleanupTestTenant(companyA);
    await cleanupTestTenant(companyB);
    await prisma.$disconnect();
  });

  it('the same key holds an independent value in each company', async () => {
    await upsertConfig(companyA.company.id, KEY, '10', 'PRICING');
    await upsertConfig(companyB.company.id, KEY, '99', 'PRICING');

    const a = (await listConfigs(companyA.company.id)).find((c) => c.key === KEY);
    const b = (await listConfigs(companyB.company.id)).find((c) => c.key === KEY);
    expect(a?.value).toBe('10');
    expect(b?.value).toBe('99');
  });

  it('updating a key in Company A does not change Company B', async () => {
    await upsertConfig(companyA.company.id, KEY, '25');

    const a = (await listConfigs(companyA.company.id)).find((c) => c.key === KEY);
    const b = (await listConfigs(companyB.company.id)).find((c) => c.key === KEY);
    expect(a?.value).toBe('25');
    expect(b?.value).toBe('99');
  });

  it('a company never sees another company\'s rows in its list', async () => {
    const onlyA = await listConfigs(companyA.company.id);
    expect(onlyA.length).toBeGreaterThan(0);
    expect(onlyA.every((c) => c.companyId === companyA.company.id)).toBe(true);
  });

  it('upserting the same key twice in one company updates, not duplicates', async () => {
    await upsertConfig(companyA.company.id, KEY, '30');
    const rows = (await listConfigs(companyA.company.id)).filter((c) => c.key === KEY);
    expect(rows).toHaveLength(1);
    expect(rows[0].value).toBe('30');
  });

  it('the database itself rejects a duplicate (companyId, key)', async () => {
    await expect(
      prisma.systemConfig.create({ data: { companyId: companyA.company.id, key: KEY, value: 'dup', category: 'GENERAL' } })
    ).rejects.toThrow();
  });

  it('RLS: a session scoped to Company A cannot SELECT Company B\'s config row', async () => {
    const ROLLBACK = new Error('__deliberate_rollback__');
    let seen: string[] = [];
    try {
      await rlsClient.$transaction(async (tx) => {
        if (!REAL_ROLE_SPLIT) await tx.$executeRawUnsafe(`ALTER TABLE "system_configs" FORCE ROW LEVEL SECURITY`);
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${companyA.company.id}, true)`;
        const rows: any[] = await tx.$queryRaw`SELECT "companyId" FROM system_configs WHERE key = ${KEY}`;
        seen = rows.map((r) => r.companyId);
        throw ROLLBACK; // proof-only, never persisted
      });
    } catch (e) {
      if (e !== ROLLBACK) throw e;
    }
    expect(seen).toEqual([companyA.company.id]);
  });
});
