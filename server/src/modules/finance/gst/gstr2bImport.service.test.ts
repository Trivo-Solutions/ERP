import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { tenantQuery } from '../../../shared/tenantContext';
import { createGstRegistration } from '../../company/company.service';
import { importGstr2bStatement } from './gstr2bImport.service';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';

function payload(gstin: string, taxPeriod: string, taxableValue = 100000) {
  const mm = taxPeriod.slice(0, 2);
  const yyyy = taxPeriod.slice(2, 6);
  return {
    gstin, fp: taxPeriod,
    data: {
      gendt: `14-${mm}-${yyyy}`, gstin, rtnprd: taxPeriod,
      docdata: {
        b2b: [{ ctin: '27BBBBB1111B1Z1', trdnm: 'Acme', inv: [{ inum: 'INV/001', dt: `05-${mm}-${yyyy}`, val: 118000, itms: [{ txval: taxableValue, iamt: taxableValue * 0.18 }] }] }],
      },
    },
  };
}

describe('G2g-7e: importGstr2bStatement', () => {
  const suffix = `g7eimp${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let B: TestTenant;
  let registrationId: string;
  const statementIds: string[] = [];

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, ['report:financial_view']);
    B = await createTestTenant(`${suffix}B`, ['report:financial_view']);
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA0000A1Z5', legalName: 'G2g7e Import Co', stateCode: '24' });
    registrationId = reg.id;
  });

  afterAll(async () => {
    await tenantQuery(A.company.id, (tx) => tx.gst2bDocument.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.gst2bStatement.deleteMany({ where: { companyId: A.company.id } }));
    await prisma.auditLog.deleteMany({ where: { userId: { in: [A.user.id, B.user.id] } } });
    await tenantQuery(A.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: A.company.id } }));
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  it('imports a well-formed statement as version 1, ACTIVE, with normalized documents', async () => {
    const result = await importGstr2bStatement(A.ctx, { gstRegistrationId: registrationId, rawPayload: payload('24AAAAA0000A1Z5', '102026'), rawBytes: Buffer.from('x') }, A.user.id);
    statementIds.push(result.statementId);
    expect(result.version).toBe(1);
    expect(result.duplicate).toBe(false);
    expect(result.documentCounts.B2B).toBe(1);
    expect(result.financialYear).toBe('2026-27');
    expect(result.taxPeriod).toBe('102026');

    const stored = await tenantQuery(A.company.id, (tx) => tx.gst2bStatement.findUniqueOrThrow({ where: { id: result.statementId } }));
    expect(stored.status).toBe('ACTIVE');
    expect(stored.rawPayload).toBeTruthy();
  });

  it('a re-import with identical content is reported as a duplicate — no new version', async () => {
    const same = payload('24AAAAA0000A1Z5', '112026');
    const first = await importGstr2bStatement(A.ctx, { gstRegistrationId: registrationId, rawPayload: same, rawBytes: Buffer.from(JSON.stringify(same)) }, A.user.id);
    statementIds.push(first.statementId);
    const second = await importGstr2bStatement(A.ctx, { gstRegistrationId: registrationId, rawPayload: same, rawBytes: Buffer.from(JSON.stringify(same)) }, A.user.id);
    expect(second.duplicate).toBe(true);
    expect(second.statementId).toBe(first.statementId);
    expect(second.version).toBe(first.version);
  });

  it('a re-import with genuinely different content for the same period creates a new version and supersedes the old one', async () => {
    const original = payload('24AAAAA0000A1Z5', '122026', 100000);
    const changed = payload('24AAAAA0000A1Z5', '122026', 250000);
    const v1 = await importGstr2bStatement(A.ctx, { gstRegistrationId: registrationId, rawPayload: original, rawBytes: Buffer.from(JSON.stringify(original)) }, A.user.id);
    const v2 = await importGstr2bStatement(A.ctx, { gstRegistrationId: registrationId, rawPayload: changed, rawBytes: Buffer.from(JSON.stringify(changed)) }, A.user.id);
    statementIds.push(v1.statementId, v2.statementId);

    expect(v2.duplicate).toBe(false);
    expect(v2.version).toBe(v1.version + 1);

    const old = await tenantQuery(A.company.id, (tx) => tx.gst2bStatement.findUniqueOrThrow({ where: { id: v1.statementId } }));
    const fresh = await tenantQuery(A.company.id, (tx) => tx.gst2bStatement.findUniqueOrThrow({ where: { id: v2.statementId } }));
    expect(old.status).toBe('SUPERSEDED');
    expect(fresh.status).toBe('ACTIVE');
  });

  it('rejects a GST registration that does not belong to the caller\'s company', async () => {
    await expect(
      importGstr2bStatement(B.ctx, { gstRegistrationId: registrationId, rawPayload: payload('24AAAAA0000A1Z5', '012027'), rawBytes: Buffer.from('x') }, B.user.id),
    ).rejects.toThrow();
  });

  it('rejects a statement whose own GSTIN does not match the selected registration', async () => {
    await expect(
      importGstr2bStatement(A.ctx, { gstRegistrationId: registrationId, rawPayload: payload('27ZZZZZ9999Z1Z1', '022027'), rawBytes: Buffer.from('x') }, A.user.id),
    ).rejects.toThrow(/GSTIN/);
  });

  it('rejects a non-object payload', async () => {
    await expect(
      importGstr2bStatement(A.ctx, { gstRegistrationId: registrationId, rawPayload: 'not json', rawBytes: Buffer.from('x') }, A.user.id),
    ).rejects.toThrow();
  });

  it('rejects when no tax period can be resolved and none was supplied explicitly', async () => {
    await expect(
      importGstr2bStatement(A.ctx, { gstRegistrationId: registrationId, rawPayload: { data: { docdata: {} } }, rawBytes: Buffer.from('x') }, A.user.id),
    ).rejects.toThrow(/tax period/i);
  });

  it('honors an explicit taxPeriod/financialYear override even when the payload lacks its own', async () => {
    const result = await importGstr2bStatement(
      A.ctx,
      { gstRegistrationId: registrationId, rawPayload: { gstin: '24AAAAA0000A1Z5', data: { docdata: {} } }, rawBytes: Buffer.from('x'), taxPeriod: '032027', financialYear: '2026-27' },
      A.user.id,
    );
    statementIds.push(result.statementId);
    expect(result.taxPeriod).toBe('032027');
    expect(result.financialYear).toBe('2026-27');
  });
});
