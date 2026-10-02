import { describe, it, expect, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { createInvoice as _createInvoice } from '../../sales/sales.service';
import { createGstRegistration } from '../../company/company.service';
import { saveAato } from '../../gst/aato.service';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';
import { tenantQuery } from '../../../shared/tenantContext';
import { getFinancialYearForDate, getPrecedingFinancialYear } from '../../../shared/financialYear';
import { createGstr1FilingSnapshot } from './gstr1FilingSnapshot.service';
import { createGstr1FilingAttempt, recordGstr1FilingAttemptOutcome, listGstr1FilingAttempts } from './gstr1FilingAttempt.service';

// G2g-6c — proves the FILING-ATTEMPT PERSISTENCE/HISTORY layer (create ATTEMPTED -> record
// outcome -> list history) over real database rows, on top of the already-frozen G2g-6a schema
// and G2g-6b snapshot builder. Deliberately does not re-test anything the G2g-6b suite
// (gstr1FilingSnapshot.service.test.ts) already covers about snapshot building/hashing/
// versioning/supersede itself — only the NEW attempt layer this phase adds.
describe('GSTR-1 filing attempt persistence & history (G2g-6c)', () => {
  const suffix = `g6c-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let other: TestTenant;
  let userId: string;
  let branchA: string;
  let clientId: string;
  let regId: string;
  let otherRegId: string;
  const invoiceIds: string[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];

  let blockedSnapshotId: string; // period P1 — stays BLOCKED forever (standalone, no v2)
  let period2Id: string;
  let period2Fy: string;
  let period2TaxPeriod: string;
  let supersededSnapshotId: string; // period P2 v1 — BLOCKED, then superseded by v2
  let validSnapshotId: string; // period P2 v2 — DRAFT, the eligible snapshot for attempts
  let firstAttemptId: string;
  let secondAttemptId: string;
  let thirdAttemptId: string;

  function createInvoice(data: Omit<Parameters<typeof _createInvoice>[0], 'branchId'> & { branchId?: string }) {
    return _createInvoice({ branchId: branchA, ...data }, tenant.ctx, userId);
  }

  afterAll(async () => {
    // Defensive: delete every gst_filing_attempt/snapshot/return_period reachable from a tracked
    // registration so a mid-test failure never leaves an orphaned period blocking registration
    // cleanup via the RESTRICT FK (same convention as gstr1FilingSnapshot.service.test.ts).
    for (const r of regRows) {
      const periods = await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.findMany({ where: { gstRegistrationId: r.id }, select: { id: true } }));
      const ids = periods.map((p) => p.id);
      if (ids.length > 0) {
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.updateMany({ where: { id: { in: ids } }, data: { filedSnapshotId: null, filedByAttemptId: null } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingAttempt.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstFilingSnapshot.deleteMany({ where: { returnPeriodId: { in: ids } } }));
        await tenantQuery(r.companyId, (tx) => tx.gstReturnPeriod.deleteMany({ where: { id: { in: ids } } }));
      }
    }
    await prisma.taxInvoice.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
    await prisma.salesInvoice.deleteMany({ where: { id: { in: invoiceIds } } });
    await prisma.client.deleteMany({ where: { id: clientId } }).catch(() => {});
    for (const r of regRows) {
      await tenantQuery(r.companyId, (tx) => tx.companyGstAatoHistory.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstAato.deleteMany({ where: { gstRegistrationId: r.id } }));
      await tenantQuery(r.companyId, (tx) => tx.companyGstRegistration.deleteMany({ where: { id: r.id } }));
    }
    await cleanupTestTenant(tenant);
    await cleanupTestTenant(other);
    await prisma.$disconnect();
  });

  it('setup: two tenants, each with a GST registration + a B2C invoice (for tenant)', async () => {
    tenant = await createTestTenant(suffix, [
      'report:financial_view', 'gst:snapshot_create', 'gst:filing_record', 'gst:period_view', 'invoice:create', 'client:create',
    ]);
    other = await createTestTenant(`xco-${suffix}`, ['gst:snapshot_create', 'gst:filing_record', 'gst:period_view']);
    userId = tenant.user.id;
    branchA = tenant.branch.id;

    const reg = await createGstRegistration(tenant.ctx, {
      gstin: '24AAAAA0000A1Z8', legalName: `Attempt Test Co ${suffix}`, stateCode: '24', isPrimary: true, isActive: true,
    });
    regId = reg.id;
    regRows.push({ id: regId, companyId: tenant.company.id });

    const otherReg = await createGstRegistration(other.ctx, {
      gstin: '27AAAAA0000A1Z2', legalName: `Attempt Test Co B ${suffix}`, stateCode: '27', isPrimary: true, isActive: true,
    });
    otherRegId = otherReg.id;
    regRows.push({ id: otherRegId, companyId: other.company.id });

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${suffix}`, name: `Walkin ${suffix}`, phone: '9000000002', type: 'RETAIL', state: 'Gujarat' },
    });
    clientId = client.id;

    const invoice = await createInvoice({
      clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Gold ring', quantity: 1, grossWeight: 5, netGoldWeight: 5, rateType: 'PER_GRAM', goldRate: 6000, makingCharge: 500, stoneValue: 0 }],
    });
    invoiceIds.push(invoice.id);
  });

  // ─── BLOCKED snapshot is never eligible (section 6) ───

  it('period P1 (standalone, AATO never saved for its FY): a BLOCKED snapshot refuses a filing attempt (409), nothing persisted', async () => {
    const p1Date = new Date(Date.UTC(2032, 2, 15)); // March 2032
    const fy = getFinancialYearForDate(p1Date);
    const from = `${fy.slice(0, 4)}-04-01`;

    const snap = await createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from, to: p1Date.toISOString() }, userId);
    expect(snap.status).toBe('BLOCKED');
    blockedSnapshotId = snap.id;

    const row = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snap.id } }));
    const period = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: row.returnPeriodId } }));

    await expect(
      createGstr1FilingAttempt(tenant.ctx, { gstRegistrationId: regId, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: snap.id, mode: 'MANUAL_EXPORT' }, userId),
    ).rejects.toMatchObject({ statusCode: 409 });

    const count = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingAttempt.count({ where: { returnPeriodId: row.returnPeriodId } }));
    expect(count).toBe(0);
  });

  // ─── SUPERSEDED snapshot is never eligible, and the chain to get a valid DRAFT ───

  it('period P2: v1 BLOCKED then v2 DRAFT supersedes v1 — the now-SUPERSEDED v1 also refuses a filing attempt (409)', async () => {
    const p2Date = new Date(Date.UTC(2032, 5, 15)); // June 2032 — a different FY from P1
    const fy = getFinancialYearForDate(p2Date);
    const precedingFy = getPrecedingFinancialYear(fy);
    const from = `${fy.slice(0, 4)}-04-01`;

    const v1 = await createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from, to: p2Date.toISOString() }, userId);
    expect(v1.status).toBe('BLOCKED');

    await saveAato(tenant.ctx, { gstRegistrationId: regId, financialYear: fy, turnover: 1000000, verificationStatus: 'VERIFIED' });
    await saveAato(tenant.ctx, { gstRegistrationId: regId, financialYear: precedingFy, turnover: 900000, verificationStatus: 'VERIFIED' });

    const v2 = await createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from, to: p2Date.toISOString() }, userId);
    expect(v2.status).toBe('DRAFT');

    const row2 = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: v2.id } }));
    period2Id = row2.returnPeriodId;
    const period = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: period2Id } }));
    period2Fy = period.financialYear;
    period2TaxPeriod = period.taxPeriod;

    const row1 = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: v1.id } }));
    expect(row1.status).toBe('SUPERSEDED');
    supersededSnapshotId = v1.id;
    validSnapshotId = v2.id;

    await expect(
      createGstr1FilingAttempt(tenant.ctx, { gstRegistrationId: regId, financialYear: period2Fy, taxPeriod: period2TaxPeriod, snapshotId: supersededSnapshotId, mode: 'MANUAL_EXPORT' }, userId),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  // ─── Validation ───

  it('an invalid mode is rejected (400)', async () => {
    await expect(
      createGstr1FilingAttempt(tenant.ctx, { gstRegistrationId: regId, financialYear: period2Fy, taxPeriod: period2TaxPeriod, snapshotId: validSnapshotId, mode: 'CARRIER_PIGEON' }, userId),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a return period that never had a snapshot created is rejected (404)', async () => {
    await expect(
      createGstr1FilingAttempt(tenant.ctx, { gstRegistrationId: regId, financialYear: '2099-00', taxPeriod: '012099', snapshotId: validSnapshotId, mode: 'MANUAL_EXPORT' }, userId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // ─── Tenant isolation ───

  it('a cross-company gstRegistrationId is rejected (404) before any row is written', async () => {
    await expect(
      createGstr1FilingAttempt(other.ctx, { gstRegistrationId: regId, financialYear: period2Fy, taxPeriod: period2TaxPeriod, snapshotId: validSnapshotId, mode: 'MANUAL_EXPORT' }, other.user.id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('a cross-company snapshotId is rejected (404), even against the caller\'s own real registration/period', async () => {
    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const from = `${fy.slice(0, 4)}-04-01`;
    const otherSnap = await createGstr1FilingSnapshot(other.ctx, { gstRegistrationId: otherRegId, from, to: now.toISOString() }, other.user.id);

    await expect(
      createGstr1FilingAttempt(tenant.ctx, { gstRegistrationId: regId, financialYear: period2Fy, taxPeriod: period2TaxPeriod, snapshotId: otherSnap.id, mode: 'MANUAL_EXPORT' }, userId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('cross-period mismatch: a real, same-company snapshot from a DIFFERENT period is rejected (404)', async () => {
    // blockedSnapshotId belongs to period P1, not P2 — same company, wrong period.
    await expect(
      createGstr1FilingAttempt(tenant.ctx, { gstRegistrationId: regId, financialYear: period2Fy, taxPeriod: period2TaxPeriod, snapshotId: blockedSnapshotId, mode: 'MANUAL_EXPORT' }, userId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // ─── Happy path: numbering, exact snapshot reference ───

  it('creates the first attempt (ATTEMPTED, attemptNumber 1), referencing the exact snapshot and its payload hash', async () => {
    const attempt = await createGstr1FilingAttempt(
      tenant.ctx, { gstRegistrationId: regId, financialYear: period2Fy, taxPeriod: period2TaxPeriod, snapshotId: validSnapshotId, mode: 'MANUAL_EXPORT' }, userId,
    );
    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.status).toBe('ATTEMPTED');
    expect(attempt.snapshotId).toBe(validSnapshotId);
    expect(attempt.returnPeriodId).toBe(period2Id);
    expect(attempt.filedAt).toBeNull();
    expect(attempt.arn).toBeNull();

    const snapRow = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: validSnapshotId } }));
    expect(attempt.payloadHash).toBe(snapRow.wireJsonHash);

    firstAttemptId = attempt.id;
  });

  it('a second attempt for the SAME period gets attemptNumber 2', async () => {
    const attempt = await createGstr1FilingAttempt(
      tenant.ctx, { gstRegistrationId: regId, financialYear: period2Fy, taxPeriod: period2TaxPeriod, snapshotId: validSnapshotId, mode: 'MANUAL_UPLOAD' }, userId,
    );
    expect(attempt.attemptNumber).toBe(2);
    secondAttemptId = attempt.id;
  });

  // ─── Outcome recording + lifecycle guards ───

  it('records ATTEMPTED -> ACCEPTED on attempt #1 with an externally-supplied ARN — never touching GstReturnPeriod or the snapshot', async () => {
    const periodBefore = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: period2Id } }));
    const snapshotBefore = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: validSnapshotId } }));

    const result = await recordGstr1FilingAttemptOutcome(
      tenant.ctx, { attemptId: firstAttemptId, outcome: 'ACCEPTED', arn: 'AA240924000001A', externalReference: 'EXT-REF-1' }, userId,
    );
    expect(result.status).toBe('ACCEPTED');
    expect(result.arn).toBe('AA240924000001A');
    expect(result.externalReference).toBe('EXT-REF-1');
    expect(result.filedAt).not.toBeNull();

    const periodAfter = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: period2Id } }));
    expect(periodAfter.status).toBe(periodBefore.status); // never auto-FILED/LOCKED (section 9)
    expect(periodAfter.filedAt).toBeNull();
    expect(periodAfter.arn).toBeNull();

    const snapshotAfter = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: validSnapshotId } }));
    expect(snapshotAfter).toEqual(snapshotBefore); // byte-for-byte unchanged (section 8)
  });

  it('records ATTEMPTED -> REJECTED on attempt #2 with caller-supplied error info', async () => {
    const result = await recordGstr1FilingAttemptOutcome(
      tenant.ctx, { attemptId: secondAttemptId, outcome: 'REJECTED', errorCode: 'GSTN_E001', errorMessage: 'Invalid HSN summary' }, userId,
    );
    expect(result.status).toBe('REJECTED');
    expect(result.errorCode).toBe('GSTN_E001');
    expect(result.errorMessage).toBe('Invalid HSN summary');
    expect(result.filedAt).toBeNull();
  });

  it('an already-ACCEPTED attempt refuses ACCEPTED -> REJECTED (409)', async () => {
    await expect(
      recordGstr1FilingAttemptOutcome(tenant.ctx, { attemptId: firstAttemptId, outcome: 'REJECTED' }, userId),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('an already-REJECTED attempt refuses REJECTED -> ACCEPTED (409)', async () => {
    await expect(
      recordGstr1FilingAttemptOutcome(tenant.ctx, { attemptId: secondAttemptId, outcome: 'ACCEPTED' }, userId),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('an already-resolved attempt refuses ACCEPTED -> ATTEMPTED (not a real outcome value; 400)', async () => {
    await expect(
      recordGstr1FilingAttemptOutcome(tenant.ctx, { attemptId: firstAttemptId, outcome: 'ATTEMPTED' }, userId),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('a nonexistent attemptId is rejected (404)', async () => {
    await expect(
      recordGstr1FilingAttemptOutcome(tenant.ctx, { attemptId: 'does-not-exist', outcome: 'ACCEPTED' }, userId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('company B cannot record an outcome against company A\'s attempt (404)', async () => {
    await expect(
      recordGstr1FilingAttemptOutcome(other.ctx, { attemptId: firstAttemptId, outcome: 'ACCEPTED' }, other.user.id),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // ─── SUPERSEDED outcome (explicit, caller-driven — never automatic) ───

  it('attempt #3: ATTEMPTED -> SUPERSEDED, and earlier attempts #1/#2 remain untouched — history ordering is deterministic', async () => {
    const attempt3 = await createGstr1FilingAttempt(
      tenant.ctx, { gstRegistrationId: regId, financialYear: period2Fy, taxPeriod: period2TaxPeriod, snapshotId: validSnapshotId, mode: 'ASP' }, userId,
    );
    expect(attempt3.attemptNumber).toBe(3);
    thirdAttemptId = attempt3.id;

    const result = await recordGstr1FilingAttemptOutcome(tenant.ctx, { attemptId: attempt3.id, outcome: 'SUPERSEDED' }, userId);
    expect(result.status).toBe('SUPERSEDED');

    const history = await listGstr1FilingAttempts(tenant.ctx, { gstRegistrationId: regId, financialYear: period2Fy, taxPeriod: period2TaxPeriod });
    expect(history.map((a) => a.attemptNumber)).toEqual([1, 2, 3]);
    expect(history.map((a) => a.status)).toEqual(['ACCEPTED', 'REJECTED', 'SUPERSEDED']);
    expect(history[0].id).toBe(firstAttemptId);
    expect(history[1].id).toBe(secondAttemptId);
    expect(history[2].id).toBe(thirdAttemptId);
  });

  // ─── FILED/LOCKED period protection ───

  it('a FILED return period refuses a new filing attempt (409)', async () => {
    await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.update({ where: { id: period2Id }, data: { status: 'FILED', filedAt: new Date() } }));

    await expect(
      createGstr1FilingAttempt(tenant.ctx, { gstRegistrationId: regId, financialYear: period2Fy, taxPeriod: period2TaxPeriod, snapshotId: validSnapshotId, mode: 'MANUAL_EXPORT' }, userId),
    ).rejects.toMatchObject({ statusCode: 409 });

    await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.update({ where: { id: period2Id }, data: { status: 'SNAPSHOT_CREATED', filedAt: null } }));
  });

  // ─── Concurrency: two simultaneous attempt creations for the SAME (new) period never collide ───

  it('two concurrent attempt creations for the same NEW return period allocate attemptNumber 1 and 2 — never a duplicate', async () => {
    const p3Date = new Date(Date.UTC(2033, 8, 15)); // Sept 2033 — a fresh FY this suite hasn't used
    const fy = getFinancialYearForDate(p3Date);
    const precedingFy = getPrecedingFinancialYear(fy);
    const from = `${fy.slice(0, 4)}-04-01`;

    await saveAato(tenant.ctx, { gstRegistrationId: regId, financialYear: fy, turnover: 1000000, verificationStatus: 'VERIFIED' });
    await saveAato(tenant.ctx, { gstRegistrationId: regId, financialYear: precedingFy, turnover: 900000, verificationStatus: 'VERIFIED' });

    const snap = await createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from, to: p3Date.toISOString() }, userId);
    const row = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snap.id } }));
    const period = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: row.returnPeriodId } }));

    const params = { gstRegistrationId: regId, financialYear: period.financialYear, taxPeriod: period.taxPeriod, snapshotId: snap.id, mode: 'MANUAL_EXPORT' };
    const [a, b] = await Promise.all([
      createGstr1FilingAttempt(tenant.ctx, params, userId),
      createGstr1FilingAttempt(tenant.ctx, params, userId),
    ]);
    const numbers = [a.attemptNumber, b.attemptNumber].sort();
    expect(numbers).toEqual([1, 2]);

    const count = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingAttempt.count({ where: { returnPeriodId: row.returnPeriodId } }));
    expect(count).toBe(2);
  });

  // ─── listGstr1FilingAttempts isolation / empty-history behavior ───

  it('listGstr1FilingAttempts: a cross-company registration is rejected (404)', async () => {
    await expect(
      listGstr1FilingAttempts(other.ctx, { gstRegistrationId: regId, financialYear: period2Fy, taxPeriod: period2TaxPeriod }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('listGstr1FilingAttempts: a period that never had a snapshot returns an empty list, not an error', async () => {
    const list = await listGstr1FilingAttempts(tenant.ctx, { gstRegistrationId: regId, financialYear: '2099-00', taxPeriod: '012099' });
    expect(list).toEqual([]);
  });

  // ─── Audit trail ───

  it('audit: GSTR1_FILING_ATTEMPT_CREATED/ACCEPTED/REJECTED/SUPERSEDED entries all exist, correctly attributed, with no full GST JSON duplicated', async () => {
    const createdEntries = await tenantQuery(tenant.company.id, (tx) => tx.auditLog.findMany({
      where: { companyId: tenant.company.id, tableName: 'gst_filing_attempts', recordId: firstAttemptId, action: 'GSTR1_FILING_ATTEMPT_CREATED' },
    }));
    expect(createdEntries.length).toBeGreaterThanOrEqual(1);
    expect(createdEntries[0].userId).toBe(userId);
    expect(createdEntries[0].companyId).toBe(tenant.company.id);
    expect(JSON.stringify(createdEntries[0].newValues)).not.toContain('canonicalDtoJson');
    expect(JSON.stringify(createdEntries[0].newValues)).not.toContain('wireJson');

    const acceptedEntries = await tenantQuery(tenant.company.id, (tx) => tx.auditLog.findMany({
      where: { companyId: tenant.company.id, tableName: 'gst_filing_attempts', recordId: firstAttemptId, action: 'GSTR1_FILING_ATTEMPT_ACCEPTED' },
    }));
    expect(acceptedEntries.length).toBeGreaterThanOrEqual(1);

    const rejectedEntries = await tenantQuery(tenant.company.id, (tx) => tx.auditLog.findMany({
      where: { companyId: tenant.company.id, tableName: 'gst_filing_attempts', recordId: secondAttemptId, action: 'GSTR1_FILING_ATTEMPT_REJECTED' },
    }));
    expect(rejectedEntries.length).toBeGreaterThanOrEqual(1);

    const supersededEntries = await tenantQuery(tenant.company.id, (tx) => tx.auditLog.findMany({
      where: { companyId: tenant.company.id, tableName: 'gst_filing_attempts', recordId: thirdAttemptId, action: 'GSTR1_FILING_ATTEMPT_SUPERSEDED' },
    }));
    expect(supersededEntries.length).toBeGreaterThanOrEqual(1);
  });
});
