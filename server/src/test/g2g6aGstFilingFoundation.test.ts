import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../config/database'; // tests act as the platform/admin role for fixtures and verification; the code under test uses the runtime client
import { tenantQuery } from '../shared/tenantContext';
import { createGstRegistration } from '../modules/company/company.service';
import { createTestTenant, cleanupTestTenant, TestTenant, withForcedRls } from './fixtures';

// ═══════════════════════════════════════════════════════════════════════════
// G2g-6a — Filing Period / Snapshot / Filing Attempt: PERSISTENCE FOUNDATION ONLY. No snapshot
// builder, filing service, or endpoint exists yet (see CLAUDE.md's G2g-6a entry) — these tests
// exercise the database contract directly, same approach/shape as g2aCreditDebitNotes.test.ts:
// uniqueness identity, the composite foreign keys (CLAUDE.md §11 item 6), and the tenant_isolation
// RLS policy the new migration (20261001120000_g2g6a_gst_filing_foundation) adds for all three new
// tables.
//
// All three of `gst_return_periods`/`gst_filing_snapshots`/`gst_filing_attempts` are FORCE ROW
// LEVEL SECURITY from the moment their migration runs (same as the G1/G2a tables) — writes to them
// go through tenantQuery (sets app.tenant_company_id for that one statement); writes to older
// fixture tables (clients, company_gst_registrations via the real service) use the platform/ctx
// helpers exactly like every other existing test file in this suite.
// ═══════════════════════════════════════════════════════════════════════════

interface Fixture {
  registration: { id: string };
}

async function bringUpFixture(tenant: TestTenant, tag: string): Promise<Fixture> {
  // GSTIN uniqueness is scoped per company (@@unique([companyId, gstin])), so the same literal
  // value is fine across tenants A and B.
  const registration = await createGstRegistration(tenant.ctx, {
    gstin: '24AAAAA0000A1Z5',
    legalName: `G2g6a Co ${tag}`,
    stateCode: '24',
  });
  return { registration };
}

/** A minimal, valid GstReturnPeriod row for `tenant`, referencing only its OWN fixture's parents. */
function periodData(tenant: TestTenant, f: Fixture, tag: string, extra: Record<string, unknown> = {}) {
  return {
    companyId: tenant.company.id, gstRegistrationId: f.registration.id, returnType: 'GSTR1',
    financialYear: '2026-27', taxPeriod: `09${tag}`,
    ...extra,
  };
}

/** A minimal, valid GstFilingSnapshot row, referencing only its own fixture's return period. */
function snapshotData(tenant: TestTenant, returnPeriodId: string, version: number, extra: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    companyId: tenant.company.id, returnPeriodId, version,
    canonicalDtoJson: { stub: true }, wireJson: { stub: true },
    canonicalDtoHash: 'hash-canonical', wireJsonHash: 'hash-wire',
    serializerVersion: 'v0', adapterVersion: 'v0',
    periodFrom: now, periodTo: now,
    branchScope: { scope: 'FULL' }, validationResult: { blockers: [], warnings: [] },
    sourceDataCutoff: now, reportParams: { gstRegistrationId: 'stub' },
    ...extra,
  };
}

/** A minimal, valid GstFilingAttempt row, referencing only its own fixture's period + snapshot. */
function attemptData(tenant: TestTenant, returnPeriodId: string, snapshotId: string, attemptNumber: number, extra: Record<string, unknown> = {}) {
  return {
    companyId: tenant.company.id, returnPeriodId, snapshotId, attemptNumber,
    mode: 'MANUAL_EXPORT', payloadHash: 'hash-wire',
    ...extra,
  };
}

describe('G2g-6a: GstReturnPeriod/GstFilingSnapshot/GstFilingAttempt foundation', () => {
  const suffix = `g2g6a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let B: TestTenant;
  let fA: Fixture;
  let fB: Fixture;
  let periodA: { id: string };
  let periodB: { id: string };
  let snapshotA: { id: string };
  let snapshotB: { id: string };

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, []);
    B = await createTestTenant(`${suffix}B`, []);
    fA = await bringUpFixture(A, `${suffix}A`);
    fB = await bringUpFixture(B, `${suffix}B`);

    periodA = await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.create({ data: periodData(A, fA, `${suffix}A`) }));
    periodB = await tenantQuery(B.company.id, (tx) => tx.gstReturnPeriod.create({ data: periodData(B, fB, `${suffix}B`) }));
    snapshotA = await tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.create({ data: snapshotData(A, periodA.id, 1) }));
    snapshotB = await tenantQuery(B.company.id, (tx) => tx.gstFilingSnapshot.create({ data: snapshotData(B, periodB.id, 1) }));
  }, 60_000);

  afterAll(async () => {
    for (const t of [A, B]) {
      await tenantQuery(t.company.id, (tx) => tx.gstFilingAttempt.deleteMany({ where: { companyId: t.company.id } }));
      // the "filed snapshot" pointer (RESTRICT FK) must be cleared before its snapshot can be deleted
      await tenantQuery(t.company.id, (tx) => tx.gstReturnPeriod.updateMany({ where: { companyId: t.company.id }, data: { filedSnapshotId: null } }));
      await tenantQuery(t.company.id, (tx) => tx.gstFilingSnapshot.deleteMany({ where: { companyId: t.company.id } }));
      await tenantQuery(t.company.id, (tx) => tx.gstReturnPeriod.deleteMany({ where: { companyId: t.company.id } }));
      // company_gst_registrations is also FORCE RLS (G1) — a bare prisma call sees zero rows in the
      // single-role test DB, same reason gst_return_periods/snapshots/attempts need tenantQuery.
      await tenantQuery(t.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: t.company.id } }));
    }
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  // ─── Return period: identity, required registration, uniqueness ───

  describe('GstReturnPeriod', () => {
    it('belongs to a company and requires a GST registration', async () => {
      // read back through tenantQuery, not a bare platform-client call — these tables are FORCE RLS
      // (set by this migration), so even the owning role sees zero rows without app.tenant_company_id set.
      const row = await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: periodA.id } }));
      expect(row.companyId).toBe(A.company.id);
      expect(row.gstRegistrationId).toBe(fA.registration.id);
      expect(row.returnType).toBe('GSTR1');
      expect(row.status).toBe('OPEN'); // default lifecycle state
      expect(row.filedAt).toBeNull();
      expect(row.filedSnapshotId).toBeNull();
      expect(row.arn).toBeNull();
    });

    it('rejects a duplicate (registration, returnType, financialYear, taxPeriod) within the same company', async () => {
      await expect(tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.create({
        data: periodData(A, fA, `${suffix}A`), // identical identity tuple to periodA
      }))).rejects.toThrow(/unique|duplicate/i);
    });

    it('a DIFFERENT GST registration (even in the same company) may use the same tax period', async () => {
      const otherReg = await createGstRegistration(A.ctx, {
        gstin: `24BBBBB0001B1Z5`, legalName: 'Second Registration Co', stateCode: '24',
      });
      const row = await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.create({
        data: periodData(A, { registration: otherReg }, `${suffix}A`, { taxPeriod: `09${suffix}A` }),
      }));
      expect(row.id).toBeTruthy();
      await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.delete({ where: { id: row.id } }));
      await tenantQuery(A.company.id, (tx) => tx.companyGstRegistration.delete({ where: { id: otherReg.id } }));
    });

    it('cross-company registration cannot be attached (composite FK rejects it)', async () => {
      await expect(tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.create({
        data: periodData(A, fA, `${suffix}XFK1`, { taxPeriod: `10${suffix}`, gstRegistrationId: fB.registration.id }),
      }))).rejects.toThrow(/foreign key|violates/i);
    });
  });

  // ─── Snapshot: parentage, version uniqueness, cross-company rejection ───

  describe('GstFilingSnapshot', () => {
    it('belongs to a return period and carries its content fields', async () => {
      const row = await tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snapshotA.id } }));
      expect(row.companyId).toBe(A.company.id);
      expect(row.returnPeriodId).toBe(periodA.id);
      expect(row.version).toBe(1);
      expect(row.status).toBe('DRAFT'); // default lifecycle state; does not lock the return period
      expect(row.gstnSchemaVersion).toBe('UNSPECIFIED'); // never invented
    });

    it('version uniqueness works: a second row with the same (returnPeriodId, version) is rejected', async () => {
      await expect(tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.create({
        data: snapshotData(A, periodA.id, 1), // same version as snapshotA
      }))).rejects.toThrow(/unique|duplicate/i);
    });

    it('a second, later version for the same period is allowed', async () => {
      const row = await tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.create({ data: snapshotData(A, periodA.id, 2) }));
      expect(row.id).toBeTruthy();
      await tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.delete({ where: { id: row.id } }));
    });

    it('cross-company parent return period is rejected (composite FK)', async () => {
      await expect(tenantQuery(A.company.id, (tx) => tx.gstFilingSnapshot.create({
        data: snapshotData(A, periodB.id, 99),
      }))).rejects.toThrow(/foreign key|violates/i);
    });

    it('GstReturnPeriod.filedSnapshotId cannot point at another company\'s snapshot (composite FK)', async () => {
      await expect(tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.update({
        where: { id: periodA.id }, data: { filedSnapshotId: snapshotB.id },
      }))).rejects.toThrow(/foreign key|violates/i);
    });

    it('control: filedSnapshotId pointing at the SAME company\'s own snapshot succeeds', async () => {
      const updated = await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.update({
        where: { id: periodA.id }, data: { filedSnapshotId: snapshotA.id },
      }));
      expect(updated.filedSnapshotId).toBe(snapshotA.id);
      // restore to null so afterAll's cleanup ordering (clear pointer before deleting the snapshot) stays simple
      await tenantQuery(A.company.id, (tx) => tx.gstReturnPeriod.update({ where: { id: periodA.id }, data: { filedSnapshotId: null } }));
    });
  });

  // ─── Filing attempt: parentage, attempt-number uniqueness, cross-company rejection ───

  describe('GstFilingAttempt', () => {
    it('belongs to a return period and references its exact snapshot', async () => {
      const row = await tenantQuery(A.company.id, (tx) => tx.gstFilingAttempt.create({ data: attemptData(A, periodA.id, snapshotA.id, 1) }));
      expect(row.returnPeriodId).toBe(periodA.id);
      expect(row.snapshotId).toBe(snapshotA.id);
      expect(row.status).toBe('ATTEMPTED'); // default; no automatic transition of GstReturnPeriod.status
      expect(row.arn).toBeNull(); // never fabricated
    });

    it('attempt-number uniqueness works: a second row with the same (returnPeriodId, attemptNumber) is rejected', async () => {
      await expect(tenantQuery(A.company.id, (tx) => tx.gstFilingAttempt.create({
        data: attemptData(A, periodA.id, snapshotA.id, 1), // same attemptNumber as above
      }))).rejects.toThrow(/unique|duplicate/i);
    });

    it('a second attempt number for the same period is allowed', async () => {
      const row = await tenantQuery(A.company.id, (tx) => tx.gstFilingAttempt.create({ data: attemptData(A, periodA.id, snapshotA.id, 2) }));
      expect(row.id).toBeTruthy();
    });

    it('cross-company parent return period is rejected (composite FK)', async () => {
      await expect(tenantQuery(A.company.id, (tx) => tx.gstFilingAttempt.create({
        data: attemptData(A, periodB.id, snapshotA.id, 1),
      }))).rejects.toThrow(/foreign key|violates/i);
    });

    it('cross-company snapshot reference is rejected (composite FK), even against the caller\'s own return period', async () => {
      await expect(tenantQuery(A.company.id, (tx) => tx.gstFilingAttempt.create({
        data: attemptData(A, periodA.id, snapshotB.id, 3),
      }))).rejects.toThrow(/foreign key|violates/i);
    });

    it('nothing persists after a rejected forgery: attempt count for return period A is unchanged', async () => {
      const count = await tenantQuery(A.company.id, (tx) => tx.gstFilingAttempt.count({ where: { returnPeriodId: periodA.id } }));
      expect(count).toBe(2); // attemptNumber 1 and 2 only
    });
  });

  // ─── RLS: the tenant_isolation policy on all three new tables ───

  describe('RLS: gst_return_periods', () => {
    it('a session scoped to Company A never sees Company B\'s return period', async () => {
      await withForcedRls(['gst_return_periods'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const rows = await tx.gstReturnPeriod.findMany({ where: { id: { in: [periodA.id, periodB.id] } } });
        expect(rows.map((r: any) => r.id)).toEqual([periodA.id]);
      });
    });

    it('fail-closed: no session variable set means zero rows, not every row', async () => {
      await withForcedRls(['gst_return_periods'], async (tx) => {
        const rows = await tx.gstReturnPeriod.findMany({ where: { id: { in: [periodA.id, periodB.id] } } });
        expect(rows).toHaveLength(0);
      });
    });

    it('UPDATE cannot touch a row outside the session\'s company', async () => {
      await withForcedRls(['gst_return_periods'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const result = await tx.gstReturnPeriod.updateMany({ where: { id: periodB.id }, data: { status: 'HACKED' } });
        expect(result.count).toBe(0);
      });
    });

    it('WITH CHECK rejects an INSERT whose companyId doesn\'t match the active session', async () => {
      await withForcedRls(['gst_return_periods'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        await expect(tx.gstReturnPeriod.create({
          data: periodData(B, fB, `${suffix}RLSFORGE`, { taxPeriod: `11${suffix}` }),
        })).rejects.toThrow();
      });
    });
  });

  describe('RLS: gst_filing_snapshots / gst_filing_attempts (SELECT-scope sample)', () => {
    it('gst_filing_snapshots: a session scoped to Company A never sees Company B\'s snapshot', async () => {
      await withForcedRls(['gst_filing_snapshots'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const rows = await tx.gstFilingSnapshot.findMany({ where: { id: { in: [snapshotA.id, snapshotB.id] } } });
        expect(rows.map((r: any) => r.id)).toEqual([snapshotA.id]);
      });
    });

    it('gst_filing_snapshots: WITH CHECK rejects an INSERT whose companyId doesn\'t match the active session', async () => {
      await withForcedRls(['gst_filing_snapshots'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        await expect(tx.gstFilingSnapshot.create({
          data: snapshotData(B, periodB.id, 50),
        })).rejects.toThrow();
      });
    });

    it('gst_filing_attempts: a session scoped to Company A never sees Company B\'s attempt', async () => {
      const attemptB = await tenantQuery(B.company.id, (tx) => tx.gstFilingAttempt.create({ data: attemptData(B, periodB.id, snapshotB.id, 1) }));
      await withForcedRls(['gst_filing_attempts'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        const rows = await tx.gstFilingAttempt.findMany({ where: { id: attemptB.id } });
        expect(rows).toHaveLength(0);
      });
    });

    it('gst_filing_attempts: WITH CHECK rejects an INSERT whose companyId doesn\'t match the active session', async () => {
      await withForcedRls(['gst_filing_attempts'], async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.tenant_company_id', ${A.company.id}, true)`;
        await expect(tx.gstFilingAttempt.create({
          data: attemptData(B, periodB.id, snapshotB.id, 99),
        })).rejects.toThrow();
      });
    });
  });
});
