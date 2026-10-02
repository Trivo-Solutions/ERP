import { describe, it, expect, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { createGstRegistration } from '../../company/company.service';
import { saveAato } from '../../gst/aato.service';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';
import { tenantQuery } from '../../../shared/tenantContext';
import { getFinancialYearForDate, getPrecedingFinancialYear } from '../../../shared/financialYear';
import { createGstr1FilingSnapshot } from './gstr1FilingSnapshot.service';
import { createGstr1FilingAttempt, recordGstr1FilingAttemptOutcome } from './gstr1FilingAttempt.service';
import { fileGstr1ReturnPeriod, lockGstr1ReturnPeriod } from './gstr1FilingPeriod.service';

// G2g-6e — proves the AUTHORITATIVE FILED/LOCKED period-lifecycle boundary
// (gstr1FilingPeriod.service.ts), built on top of the already-frozen G2g-6a schema and the already-
// frozen G2g-6b/6c services (snapshot builder / filing-attempt history). Deliberately does not
// re-test anything those suites already cover about snapshot building/hashing/versioning/supersede
// or attempt numbering/outcome recording — only the two NEW transitions this phase adds, plus the
// mutation-guard concurrency fix proven end-to-end in g2g6dGstr1MutationGuard.test.ts's own
// dedicated race test.
//
// All fixture periods live in a quiet run of calendar months starting April 2040 that nothing else
// in the suite touches, one calendar month per test case, so every period gets its own distinct
// natural key (companyId, gstRegistrationId, 'GSTR1', financialYear, taxPeriod). `makeEligibleSnapshot`
// calls saveAato fresh every time regardless (upsert-safe — same precedent as every other G2g-6
// suite's own setup), so this transparently rolls from FY2040-41 into FY2041-42 etc. as monthOffset
// grows past 11 months — never a collision, never a missing-AATO BLOCKED snapshot.
describe('GSTR-1 filing/period lifecycle boundary (G2g-6e)', () => {
  const suffix = `g6e-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let other: TestTenant;
  let userId: string;
  let regId: string;
  let otherRegId: string;
  const regRows: Array<{ id: string; companyId: string }> = [];
  let monthOffset = 0; // 0 = April 2040 ... 11 = March 2041, all one FY (2040-41)

  afterAll(async () => {
    for (const r of regRows) {
      const periods = await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.findMany({ where: { gstRegistrationId: r.id }, select: { id: true } }));
      const ids = periods.map((p) => p.id);
      if (ids.length > 0) {
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.updateMany({ where: { id: { in: ids } }, data: { filedSnapshotId: null, filedByAttemptId: null } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingAttempt.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingSnapshot.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.deleteMany({ where: { id: { in: ids } } }));
      }
      await tenantQuery(r.companyId, (tx) => tx.companyGstAatoHistory.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstAato.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    }
    await cleanupTestTenant(tenant);
    await cleanupTestTenant(other);
    await prisma.$disconnect();
  });

  /** Builds a real, filing-eligible (DRAFT) snapshot for `t`/`reg`, one fresh calendar month at a
   *  time within the shared quiet FY described above. */
  async function makeEligibleSnapshot(t: TestTenant, reg: string) {
    monthOffset += 1;
    const year = 2040 + Math.floor((3 + monthOffset) / 12);
    const month = (3 + monthOffset) % 12; // start at April (index 3)
    const date = new Date(Date.UTC(year, month, 15));
    const fy = getFinancialYearForDate(date);
    const precedingFy = getPrecedingFinancialYear(fy);
    await saveAato(t.ctx, { gstRegistrationId: reg, financialYear: fy, turnover: 1000000, verificationStatus: 'VERIFIED' });
    await saveAato(t.ctx, { gstRegistrationId: reg, financialYear: precedingFy, turnover: 900000, verificationStatus: 'VERIFIED' });
    const from = `${fy.slice(0, 4)}-04-01`;
    const to = date.toISOString();
    const snap = await createGstr1FilingSnapshot(t.ctx, { gstRegistrationId: reg, from, to }, t.user.id);
    const row = await tenantQuery(t.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snap.id } }));
    const period = await tenantQuery(t.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: row.returnPeriodId } }));
    return { snap, period, from, to };
  }

  /** The full real happy path up to (not including) the FILED transition: eligible snapshot ->
   *  ATTEMPTED -> ACCEPTED, all through the real G2g-6b/6c services. */
  async function acceptedAttempt(t: TestTenant, reg: string) {
    const { snap, period, from, to } = await makeEligibleSnapshot(t, reg);
    const attempt = await createGstr1FilingAttempt(
      t.ctx, { gstRegistrationId: reg, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: snap.id, mode: 'MANUAL_EXPORT' }, t.user.id,
    );
    const accepted = await recordGstr1FilingAttemptOutcome(t.ctx, { attemptId: attempt.id, outcome: 'ACCEPTED', arn: `ARN-${attempt.id.slice(0, 8)}` }, t.user.id);
    return { snap, period, attempt: accepted, from, to };
  }

  it('setup: two tenants, each with a GST registration', async () => {
    tenant = await createTestTenant(suffix, [
      'report:financial_view', 'gst:snapshot_create', 'gst:filing_record', 'gst:period_view',
    ]);
    other = await createTestTenant(`xco-${suffix}`, ['gst:snapshot_create', 'gst:filing_record', 'gst:period_view']);
    userId = tenant.user.id;

    const reg = await createGstRegistration(tenant.ctx, {
      gstin: '24AAAAA0000A1Z8', legalName: `G6e Co ${suffix}`, stateCode: '24', isPrimary: true, isActive: true,
    });
    regId = reg.id;
    regRows.push({ id: regId, companyId: tenant.company.id });

    const otherReg = await createGstRegistration(other.ctx, {
      gstin: '27AAAAA0000A1Z2', legalName: `G6e Co B ${suffix}`, stateCode: '27', isPrimary: true, isActive: true,
    });
    otherRegId = otherReg.id;
    regRows.push({ id: otherRegId, companyId: other.company.id });
  });

  // ─── FILED transition — happy path (brief §21 tests #3-6) ───

  describe('fileGstr1ReturnPeriod — happy path', () => {
    it('establishes FILED from a valid ACCEPTED attempt, storing the exact filedSnapshotId + filedByAttemptId + filedById + filedAt, with an audit entry', async () => {
      const { snap, period, attempt } = await acceptedAttempt(tenant, regId);

      const filed = await fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId);
      expect(filed.status).toBe('FILED');
      expect(filed.filedSnapshotId).toBe(snap.id);
      expect(filed.filedByAttemptId).toBe(attempt.id);
      expect(filed.filedById).toBe(userId);
      expect(filed.filedAt).not.toBeNull();
      expect(filed.id).toBe(period.id);

      const audit = await prisma.auditLog.findFirst({ where: { recordId: period.id, action: 'GSTR1_PERIOD_FILED' } });
      expect(audit).toBeTruthy();
      expect((audit!.newValues as any).snapshotId).toBe(snap.id);
      expect((audit!.newValues as any).attemptId).toBe(attempt.id);
      expect((audit!.newValues as any).financialYear).toBe(period.financialYear);
    });

    it('carries over the accepted attempt\'s own ARN onto the period when the period has none yet', async () => {
      const { attempt } = await acceptedAttempt(tenant, regId);
      const filed = await fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId);
      expect(filed.arn).toBe(attempt.arn);
    });
  });

  // ─── FILED transition — eligibility rejections (brief §21 tests #7-10) ───

  describe('fileGstr1ReturnPeriod — eligibility rejections', () => {
    it('rejects an attempt that is still ATTEMPTED (never resolved) (409), period stays unfiled', async () => {
      const { snap, period } = await makeEligibleSnapshot(tenant, regId);
      const attempt = await createGstr1FilingAttempt(
        tenant.ctx, { gstRegistrationId: regId, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: snap.id, mode: 'MANUAL_EXPORT' }, userId,
      );
      await expect(fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId)).rejects.toMatchObject({ statusCode: 409 });
      const row = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: period.id } }));
      expect(row.status).not.toBe('FILED');
    });

    it('rejects a REJECTED attempt (409)', async () => {
      const { snap, period } = await makeEligibleSnapshot(tenant, regId);
      const attempt = await createGstr1FilingAttempt(
        tenant.ctx, { gstRegistrationId: regId, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: snap.id, mode: 'MANUAL_EXPORT' }, userId,
      );
      await recordGstr1FilingAttemptOutcome(tenant.ctx, { attemptId: attempt.id, outcome: 'REJECTED', errorMessage: 'portal rejected' }, userId);
      await expect(fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejects a SUPERSEDED attempt (409)', async () => {
      const { snap, period } = await makeEligibleSnapshot(tenant, regId);
      const attempt = await createGstr1FilingAttempt(
        tenant.ctx, { gstRegistrationId: regId, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: snap.id, mode: 'MANUAL_EXPORT' }, userId,
      );
      await recordGstr1FilingAttemptOutcome(tenant.ctx, { attemptId: attempt.id, outcome: 'SUPERSEDED' }, userId);
      await expect(fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejects when the attempt\'s own snapshot has since been SUPERSEDED by a later snapshot for the same period (409), even though the attempt is ACCEPTED', async () => {
      const { snap: v1, period, from, to } = await makeEligibleSnapshot(tenant, regId);
      const attempt = await createGstr1FilingAttempt(
        tenant.ctx, { gstRegistrationId: regId, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: v1.id, mode: 'MANUAL_EXPORT' }, userId,
      );
      const accepted = await recordGstr1FilingAttemptOutcome(tenant.ctx, { attemptId: attempt.id, outcome: 'ACCEPTED' }, userId);

      // A second snapshot build for the SAME registration/period supersedes v1 (DRAFT -> SUPERSEDED).
      await createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from, to }, userId);
      const v1Row = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: v1.id } }));
      expect(v1Row.status).toBe('SUPERSEDED');

      await expect(fileGstr1ReturnPeriod(tenant.ctx, { attemptId: accepted.id }, userId)).rejects.toMatchObject({ statusCode: 409 });
      const periodRow = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: period.id } }));
      expect(periodRow.status).not.toBe('FILED');
    });

    it('rejects when the attempt\'s snapshot is BLOCKED — a hand-built fixture proving fileGstr1ReturnPeriod\'s own defensive check, since the normal create flow can never reach this state', async () => {
      const { snap, period, attempt } = await acceptedAttempt(tenant, regId);
      // Not reachable via any real flow (createGstr1FilingAttempt refuses a BLOCKED snapshot at
      // creation, and nothing ever flips an already-ACCEPTED-attempt's snapshot to BLOCKED) —
      // hand-set directly to prove this function's own §6 check, not just rely on it being
      // unreachable elsewhere.
      await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.update({ where: { id: snap.id }, data: { status: 'BLOCKED' } }));
      await expect(fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId)).rejects.toMatchObject({ statusCode: 409 });
      const periodRow = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: period.id } }));
      expect(periodRow.status).not.toBe('FILED');
    });

    it('missing attemptId is rejected (400)', async () => {
      await expect(fileGstr1ReturnPeriod(tenant.ctx, { attemptId: '' }, userId)).rejects.toMatchObject({ statusCode: 400 });
    });

    it('a nonexistent attemptId is rejected (404)', async () => {
      await expect(fileGstr1ReturnPeriod(tenant.ctx, { attemptId: 'does-not-exist' }, userId)).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  // ─── FILED transition — already-terminal rejections (brief §21 tests #11,#14) ───

  describe('fileGstr1ReturnPeriod — already-terminal period', () => {
    it('rejects a duplicate FILED transition on an already-FILED period (409)', async () => {
      const { attempt } = await acceptedAttempt(tenant, regId);
      await fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId);
      await expect(fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejects filing against an already-LOCKED period, via a second attempt for that same period (409)', async () => {
      const { period, attempt } = await acceptedAttempt(tenant, regId);
      const filed = await fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId);
      await lockGstr1ReturnPeriod(tenant.ctx, { periodId: filed.id }, userId);

      // A second attempt against the same period is itself refused by G2g-6c's own TERMINAL_PERIOD_STATUSES
      // guard (createGstr1FilingAttempt) — confirms the period never becomes attemptable again once LOCKED.
      await expect(
        createGstr1FilingAttempt(tenant.ctx, { gstRegistrationId: regId, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: attempt.snapshotId, mode: 'MANUAL_EXPORT' }, userId),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  // ─── FILED transition — tenant isolation (brief §21 tests #32,#34,#35) ───

  describe('fileGstr1ReturnPeriod — tenant isolation', () => {
    it('a cross-company attemptId is rejected (404)', async () => {
      const { attempt } = await acceptedAttempt(other, otherRegId);
      await expect(fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('an attempt that belongs to a DIFFERENT period (but the SAME company/registration) cannot establish FILED for the wrong period — attempt.returnPeriodId always wins, there is no ambiguity to exploit', async () => {
      const { attempt: attemptA } = await acceptedAttempt(tenant, regId);
      const { period: periodB } = await makeEligibleSnapshot(tenant, regId);
      const filed = await fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attemptA.id }, userId);
      // periodB (a different, unrelated period) must remain untouched.
      const periodBRow = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: periodB.id } }));
      expect(periodBRow.status).not.toBe('FILED');
      expect(filed.id).not.toBe(periodB.id);
    });
  });

  // ─── LOCKED transition (brief §21 tests #12-15) ───

  describe('lockGstr1ReturnPeriod', () => {
    it('locks a FILED period, storing lockedAt/lockedById, with an audit entry — attempt history and the snapshot are untouched', async () => {
      const { snap, attempt } = await acceptedAttempt(tenant, regId);
      const filed = await fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId);

      const locked = await lockGstr1ReturnPeriod(tenant.ctx, { periodId: filed.id }, userId);
      expect(locked.status).toBe('LOCKED');
      expect(locked.lockedAt).not.toBeNull();
      expect(locked.lockedById).toBe(userId);
      // FILED facts remain exactly as they were — LOCKED never re-derives or clears them.
      expect(locked.filedSnapshotId).toBe(filed.filedSnapshotId);
      expect(locked.filedByAttemptId).toBe(filed.filedByAttemptId);

      const audit = await prisma.auditLog.findFirst({ where: { recordId: filed.id, action: 'GSTR1_PERIOD_LOCKED' } });
      expect(audit).toBeTruthy();
      expect((audit!.newValues as any).filedSnapshotId).toBe(snap.id);

      const attemptRow = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingAttempt.findUniqueOrThrow({ where: { id: attempt.id } }));
      expect(attemptRow.status).toBe('ACCEPTED'); // test #23 — unchanged by the LOCKED transition
      const snapRow = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snap.id } }));
      expect(snapRow.canonicalDtoHash).toBe(snap.canonicalDtoHash); // test #16/#17 — immutable
      expect(snapRow.wireJsonHash).toBe(snap.wireJsonHash); // test #18
    });

    it('rejects locking a period that is not yet FILED (OPEN, SNAPSHOT_CREATED, or FILING_ATTEMPTED) (409)', async () => {
      const { period: openPeriod } = await makeEligibleSnapshot(tenant, regId); // SNAPSHOT_CREATED, never attempted
      const openRow = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: openPeriod.id } }));
      expect(openRow.status).toBe('SNAPSHOT_CREATED');
      await expect(lockGstr1ReturnPeriod(tenant.ctx, { periodId: openPeriod.id }, userId)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('rejects locking an already-LOCKED period (409) — test #14, LOCKED -> FILED/LOCKED is refused either way', async () => {
      const { attempt } = await acceptedAttempt(tenant, regId);
      const filed = await fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId);
      await lockGstr1ReturnPeriod(tenant.ctx, { periodId: filed.id }, userId);
      await expect(lockGstr1ReturnPeriod(tenant.ctx, { periodId: filed.id }, userId)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('a cross-company periodId is rejected (404) — test #33/#36 analogue at the service level', async () => {
      const { attempt } = await acceptedAttempt(other, otherRegId);
      const filed = await fileGstr1ReturnPeriod(other.ctx, { attemptId: attempt.id }, other.user.id);
      await expect(lockGstr1ReturnPeriod(tenant.ctx, { periodId: filed.id }, userId)).rejects.toMatchObject({ statusCode: 404 });
    });

    it('missing periodId is rejected (400)', async () => {
      await expect(lockGstr1ReturnPeriod(tenant.ctx, { periodId: '' }, userId)).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  // ─── Post-FILED/LOCKED immutability of the surrounding G2g-6b/6c surface (brief §21 tests #19-22) ───

  describe('immutability of snapshots/attempts once FILED/LOCKED', () => {
    it('a replacement snapshot is rejected after FILED (409) and after LOCKED (409)', async () => {
      const { attempt, from, to } = await acceptedAttempt(tenant, regId);

      const filed = await fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId);
      await expect(createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from, to }, userId)).rejects.toMatchObject({ statusCode: 409 });

      await lockGstr1ReturnPeriod(tenant.ctx, { periodId: filed.id }, userId);
      await expect(createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from, to }, userId)).rejects.toMatchObject({ statusCode: 409 });
    });

    it('a new filing attempt is rejected after FILED (409) and after LOCKED (409)', async () => {
      const { period, attempt } = await acceptedAttempt(tenant, regId);
      const filed = await fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId);
      await expect(
        createGstr1FilingAttempt(tenant.ctx, { gstRegistrationId: regId, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: attempt.snapshotId, mode: 'MANUAL_EXPORT' }, userId),
      ).rejects.toMatchObject({ statusCode: 409 });

      await lockGstr1ReturnPeriod(tenant.ctx, { periodId: filed.id }, userId);
      await expect(
        createGstr1FilingAttempt(tenant.ctx, { gstRegistrationId: regId, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: attempt.snapshotId, mode: 'MANUAL_EXPORT' }, userId),
      ).rejects.toMatchObject({ statusCode: 409 });
    });
  });

  // ─── Concurrency (brief §21 tests #37,#39,#40) — file-vs-file and lock-vs-lock. The third
  // concurrency case this phase requires (#38, file-vs-mutate-the-represented-document) is proven
  // end-to-end in g2g6dGstr1MutationGuard.test.ts, where the realistic invoice/traceability
  // fixtures it needs already exist. ───

  describe('concurrency', () => {
    it('two concurrent FILE transitions for the SAME attempt: exactly one succeeds (201-equivalent), the other gets a clean 409 — never a raw Prisma error', async () => {
      const { attempt } = await acceptedAttempt(tenant, regId);

      const results = await Promise.allSettled([
        fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId),
        fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(Error);
      expect((rejected[0].reason as any).statusCode).toBe(409);
      expect((rejected[0].reason as any).name).not.toBe('PrismaClientKnownRequestError');

      const periodRow = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: attempt.returnPeriodId } }));
      expect(periodRow.status).toBe('FILED');
    });

    it('two concurrent LOCK transitions for the SAME period: exactly one succeeds, the other gets a clean 409', async () => {
      const { attempt } = await acceptedAttempt(tenant, regId);
      const filed = await fileGstr1ReturnPeriod(tenant.ctx, { attemptId: attempt.id }, userId);

      const results = await Promise.allSettled([
        lockGstr1ReturnPeriod(tenant.ctx, { periodId: filed.id }, userId),
        lockGstr1ReturnPeriod(tenant.ctx, { periodId: filed.id }, userId),
      ]);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect((rejected[0].reason as any).statusCode).toBe(409);

      const periodRow = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: filed.id } }));
      expect(periodRow.status).toBe('LOCKED');
    });
  });
});
