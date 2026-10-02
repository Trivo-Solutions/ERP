import { describe, it, expect, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { createInvoice as _createInvoice } from '../../sales/sales.service';
import { createGstRegistration } from '../../company/company.service';
import { saveAato } from '../../gst/aato.service';
import { createTestTenant, cleanupTestTenant, addBranch, TestTenant } from '../../../test/fixtures';
import { tenantQuery } from '../../../shared/tenantContext';
import { getFinancialYearForDate, getPrecedingFinancialYear } from '../../../shared/financialYear';
import { buildGstr1GstnExportCore } from './gstr1Export.service';
import { serializeGstr1ToGstnJson } from './gstr1GstnSerializer';
import { canonicalJsonString, sha256Hex } from './gstr1SnapshotHash';
import { createGstr1FilingSnapshot } from './gstr1FilingSnapshot.service';

// G2g-6b — proves the SNAPSHOT BUILDER (report -> adapter -> canonicalize -> hash -> validate ->
// serialize -> hash -> persist) over real database rows. Deliberately does not re-test any
// classification/aggregation/validation/serialization RULE those frozen modules already cover in
// their own suites (gstr1*.test.ts) or gstr1Export.service.test.ts's own orchestration coverage —
// only the NEW persistence/versioning/hashing layer this phase adds.
describe('GSTR-1 filing snapshot builder (G2g-6b)', () => {
  const suffix = `g6b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let tenant: TestTenant;
  let other: TestTenant;
  let userId: string;
  let branchA: string;
  let clientId: string;
  let regId: string;
  const invoiceIds: string[] = [];
  const regRows: Array<{ id: string; companyId: string }> = [];
  const periodIds: Array<{ id: string; companyId: string }> = [];

  function createInvoice(data: Omit<Parameters<typeof _createInvoice>[0], 'branchId'> & { branchId?: string }) {
    return _createInvoice({ branchId: branchA, ...data }, tenant.ctx, userId);
  }

  afterAll(async () => {
    // Defensive: delete every gst_filing_attempt/snapshot/return_period reachable from a tracked
    // registration (not just the ones individually pushed to periodIds) so a mid-test failure never
    // leaves an orphaned period blocking registration cleanup via the RESTRICT FK.
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

  it('setup: tenant + GST registration + a B2C invoice', async () => {
    tenant = await createTestTenant(suffix, ['report:financial_view', 'gst:snapshot_create', 'invoice:create', 'client:create']);
    other = await createTestTenant(`xco-${suffix}`, []);
    userId = tenant.user.id;
    branchA = tenant.branch.id;

    const reg = await createGstRegistration(tenant.ctx, {
      gstin: '24AAAAA0000A1Z8', legalName: `Snapshot Test Co ${suffix}`, stateCode: '24', isPrimary: true, isActive: true,
    });
    regId = reg.id;
    regRows.push({ id: regId, companyId: tenant.company.id });

    const client = await prisma.client.create({
      data: { companyId: tenant.company.id, clientCode: `TSTCL-${suffix}`, name: `Walkin ${suffix}`, phone: '9000000001', type: 'RETAIL', state: 'Gujarat' },
    });
    clientId = client.id;

    const invoice = await createInvoice({
      clientId, invoiceDate: new Date(), invoiceType: 'RETAIL',
      items: [{ productCode: 'MISC', description: 'Gold chain', quantity: 1, grossWeight: 8, netGoldWeight: 8, rateType: 'PER_GRAM', goldRate: 6000, makingCharge: 800, stoneValue: 0 }],
    });
    invoiceIds.push(invoice.id);
  });

  // ─── Versioning, period lifecycle, blocked-vs-valid status, supersede ───

  it('first snapshot (AATO not yet verified): persisted as v1/BLOCKED with the full validationResult, period auto-created OPEN->SNAPSHOT_CREATED', async () => {
    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const from = `${fy.slice(0, 4)}-04-01`;

    const snap1 = await createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from, to: now.toISOString() }, userId);

    expect(snap1.version).toBe(1);
    expect(snap1.status).toBe('BLOCKED');
    expect(snap1.isValid).toBe(false);
    expect(snap1.blockers.some((b) => b.code === 'AATO_PRECEDING_FY_NOT_VERIFIED')).toBe(true);
    expect(snap1.canonicalDtoHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snap1.wireJsonHash).toMatch(/^[0-9a-f]{64}$/);

    const row = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snap1.id } }));
    periodIds.push({ id: row.returnPeriodId, companyId: tenant.company.id });
    expect(row.companyId).toBe(tenant.company.id);

    const period = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: row.returnPeriodId } }));
    expect(period.gstRegistrationId).toBe(regId);
    expect(period.returnType).toBe('GSTR1');
    expect(period.status).toBe('SNAPSHOT_CREATED'); // never silently left OPEN once a snapshot exists
    expect(period.filedAt).toBeNull(); // never a filing action
    expect(period.arn).toBeNull();
  });

  it('second snapshot for the SAME period, once AATO is verified: v2/DRAFT, and v1 is SUPERSEDED (never deleted)', async () => {
    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const precedingFy = getPrecedingFinancialYear(fy);
    const from = `${fy.slice(0, 4)}-04-01`;

    await saveAato(tenant.ctx, { gstRegistrationId: regId, financialYear: fy, turnover: 1000000, verificationStatus: 'VERIFIED' });
    await saveAato(tenant.ctx, { gstRegistrationId: regId, financialYear: precedingFy, turnover: 900000, verificationStatus: 'VERIFIED' });

    const snap2 = await createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from, to: now.toISOString() }, userId);

    expect(snap2.version).toBe(2);
    expect(snap2.status).toBe('DRAFT');
    expect(snap2.isValid).toBe(true);
    expect(snap2.blockers).toHaveLength(0);
    // warnings do not block snapshot creation — the adapter's own permanent UNSUPPORTED_SECTION/
    // AMENDMENT_DATA_UNAVAILABLE diagnostics are always present as warnings on a real export.
    expect(snap2.warnings.length).toBeGreaterThan(0);

    const row2 = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snap2.id } }));
    const row1 = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findFirstOrThrow({
      where: { returnPeriodId: row2.returnPeriodId, version: 1 },
    }));
    expect(row1.status).toBe('SUPERSEDED'); // not deleted — snapshots are append-only history
    expect(row1.id).not.toBe(row2.id);

    const period = await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: row2.returnPeriodId } }));
    expect(period.status).toBe('SNAPSHOT_CREATED'); // unchanged — still not FILED/LOCKED
  });

  it('audit: a GST_FILING_SNAPSHOT_CREATED entry exists for the second snapshot, correctly attributed', async () => {
    const snaps = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findMany({
      where: { companyId: tenant.company.id, version: 2 },
    }));
    const snap2 = snaps[0];
    const entries = await tenantQuery(tenant.company.id, (tx) => tx.auditLog.findMany({
      where: { companyId: tenant.company.id, tableName: 'gst_filing_snapshots', recordId: snap2.id, action: 'GST_FILING_SNAPSHOT_CREATED' },
    }));
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].userId).toBe(userId);
    expect(entries[0].companyId).toBe(tenant.company.id);
  });

  // ─── Full pipeline integrity (the most important G2g-6b test) ───

  it('full pipeline integrity: snapshot.wireJson/canonicalDtoHash/wireJsonHash exactly match an independently-recomputed run of the same frozen pipeline', async () => {
    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const from = `${fy.slice(0, 4)}-04-01`;
    const params = { gstRegistrationId: regId, from, to: now.toISOString() };

    // Independent recomputation, calling the frozen pieces directly (not through the snapshot
    // builder) — proves the builder neither reclassifies nor silently diverges from the frozen path.
    const core = await buildGstr1GstnExportCore(tenant.ctx, params);
    const expectedWire = serializeGstr1ToGstnJson(core.dto);
    const expectedCanonicalHash = sha256Hex(canonicalJsonString(core.dto));
    const expectedWireHash = sha256Hex(JSON.stringify(expectedWire));

    const snapshot = await createGstr1FilingSnapshot(tenant.ctx, params, userId);
    periodIds.push({ id: snapshot.returnPeriodId, companyId: tenant.company.id });

    expect(snapshot.canonicalDtoHash).toBe(expectedCanonicalHash);
    expect(snapshot.wireJsonHash).toBe(expectedWireHash);

    const row = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snapshot.id } }));
    // Deep-equal, not byte-equal: Postgres jsonb does not guarantee object key ORDER is preserved
    // across storage (see gstr1SnapshotHash.ts's own header on why hashes are computed from the
    // pre-storage in-memory value, never re-derived from a post-storage re-read) — content fidelity
    // is what matters, and toEqual proves that independent of any jsonb key-reordering artifact.
    expect(row.wireJson).toEqual(expectedWire);
    expect(row.canonicalDtoHash).toBe(expectedCanonicalHash);
    expect(row.wireJsonHash).toBe(expectedWireHash);
    expect(row.serializerVersion).toBeTruthy();
    expect(row.adapterVersion).toBeTruthy();
    expect(row.gstnSchemaVersion).toBe(core.dto.metadata.schemaVersion);
    expect(row.periodFrom.getTime()).toBe(core.from.getTime());
    expect(row.periodTo.getTime()).toBe(core.to.getTime());
    expect((row.reportParams as any).gstRegistrationId).toBe(regId);
    expect((row.branchScope as any).scope).toBe('REGISTRATION'); // allBranches tenant, no explicit branchId
  });

  // ─── Serializer-hard-failure: nothing persisted ───

  it('a GSTIN too malformed for the serializer to accept throws 400 and persists nothing', async () => {
    const badReg = await createGstRegistration(tenant.ctx, {
      gstin: '24AABCU9603R1ZT', legalName: 'Bad GSTIN Co', stateCode: '24', isPrimary: false, isActive: true,
    });
    regRows.push({ id: badReg.id, companyId: tenant.company.id });
    // Corrupt the persisted GSTIN directly so the frozen serializer's own structural check fails —
    // createGstRegistration itself validates on the way in, so this is the only way to reach that path.
    await tenantQuery(tenant.company.id, (tx) => tx.companyGstRegistration.update({ where: { id: badReg.id }, data: { gstin: 'NOT-A-GSTIN' } }));

    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const from = `${fy.slice(0, 4)}-04-01`;

    const before = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.count({ where: { companyId: tenant.company.id } }));
    await expect(
      createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: badReg.id, from, to: now.toISOString() }, userId),
    ).rejects.toMatchObject({ statusCode: 400 });
    const after = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.count({ where: { companyId: tenant.company.id } }));
    expect(after).toBe(before); // nothing persisted — wireJson is NOT NULL and there was nothing valid to put in it
  });

  // ─── FILED/LOCKED period protection ───

  it('a FILED return period refuses a replacement snapshot (409), without touching the existing snapshot/version count', async () => {
    const now = new Date();
    const fy = getFinancialYearForDate(now);
    const from = `${fy.slice(0, 4)}-04-01`;

    const snap = await createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from, to: now.toISOString() }, userId);
    const row = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snap.id } }));
    periodIds.push({ id: row.returnPeriodId, companyId: tenant.company.id });

    // Directly flip the period to FILED — no filing workflow exists yet in this phase (G2g-6c), so
    // this simulates the state a future filing step would eventually produce.
    await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.update({ where: { id: row.returnPeriodId }, data: { status: 'FILED', filedAt: new Date() } }));

    const countBefore = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.count({ where: { returnPeriodId: row.returnPeriodId } }));
    await expect(
      createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from, to: now.toISOString() }, userId),
    ).rejects.toMatchObject({ statusCode: 409 });
    const countAfter = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.count({ where: { returnPeriodId: row.returnPeriodId } }));
    expect(countAfter).toBe(countBefore); // no replacement snapshot was created

    // Restore to OPEN-ish so this period doesn't interfere with any later test reusing the same from/to.
    await tenantQuery(tenant.company.id, (tx) => tx.gstReturnPeriod.update({ where: { id: row.returnPeriodId }, data: { status: 'SNAPSHOT_CREATED', filedAt: null } }));
  });

  // ─── Concurrency: two simultaneous creations for the SAME (new) period never collide on version ───

  it('two concurrent snapshot creations for the same return period allocate versions 1 and 2 — never a duplicate', async () => {
    // A FRESH period (a different filing month) so this test's version numbers start clean.
    const future = new Date(Date.UTC(2031, 6, 15)); // July 2031 — a month this suite has not used yet
    const fy = getFinancialYearForDate(future);
    const from = `${fy.slice(0, 4)}-04-01`;
    const params = { gstRegistrationId: regId, from, to: future.toISOString() };

    const [a, b] = await Promise.all([
      createGstr1FilingSnapshot(tenant.ctx, params, userId),
      createGstr1FilingSnapshot(tenant.ctx, params, userId),
    ]);
    periodIds.push({ id: a.returnPeriodId, companyId: tenant.company.id });

    expect(a.returnPeriodId).toBe(b.returnPeriodId);
    const versions = [a.version, b.version].sort();
    expect(versions).toEqual([1, 2]);

    const count = await tenantQuery(tenant.company.id, (tx) => tx.gstFilingSnapshot.count({ where: { returnPeriodId: a.returnPeriodId } }));
    expect(count).toBe(2); // never 1 (collision/overwrite) or 3+ (duplicate retry)
  });

  // ─── Tenant isolation ───

  it('a cross-company gstRegistrationId is rejected (404) before any report is generated or any row written', async () => {
    const now = new Date();
    const before = await tenantQuery(other.company.id, (tx) => tx.gstFilingSnapshot.count({ where: { companyId: other.company.id } }));
    await expect(
      createGstr1FilingSnapshot(other.ctx, { gstRegistrationId: regId, from: '2026-04-01', to: now.toISOString() }, other.user.id),
    ).rejects.toMatchObject({ statusCode: 404 });
    const after = await tenantQuery(other.company.id, (tx) => tx.gstFilingSnapshot.count({ where: { companyId: other.company.id } }));
    expect(after).toBe(before);
  });

  it('a cross-company branchId is rejected (404) before any report is generated', async () => {
    const now = new Date();
    await expect(
      createGstr1FilingSnapshot(tenant.ctx, { gstRegistrationId: regId, from: '2026-04-01', to: now.toISOString(), branchId: other.branch.id }, userId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('design note: a forged returnPeriodId cannot even be expressed — the period is always resolved server-side from (companyId, gstRegistrationId, returnType, financialYear, taxPeriod), never accepted as a request input', () => {
    // No input field on Gstr1FilingSnapshotParams names a GstReturnPeriod id at all — see the type
    // declaration in gstr1FilingSnapshot.service.ts. This test exists purely to document that the
    // "company A registration + company B return period" attack class (CLAUDE.md section 26) is
    // closed by construction for this endpoint, not merely defended against at runtime.
    expect(true).toBe(true);
  });
});
