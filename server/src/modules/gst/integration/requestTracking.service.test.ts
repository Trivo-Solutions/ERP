import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { tenantQuery } from '../../../shared/tenantContext';
import { createGstRegistration } from '../../company/company.service';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';
import { startRequest, completeRequest, listRequestLogs, buildIdempotencyKey } from './requestTracking.service';

describe('G8a requestTracking.service: metadata-only tracking + idempotency de-duplication', () => {
  const suffix = `g8atrk${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let registrationId: string;
  let configId: string;

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, []);
    const reg = await createGstRegistration(A.ctx, { gstin: '24AAAAA1000A1Z5', legalName: 'G8a Tracking Co', stateCode: '24' });
    registrationId = reg.id;
    // Company-owned + RLS-FORCEd — every direct read/write in this file goes through tenantQuery,
    // same rule as production code (CLAUDE.md §11: "never a bare prisma.<model> call").
    const config = await tenantQuery(A.company.id, (tx) =>
      tx.gstIntegrationConfig.create({ data: { companyId: A.company.id, gstRegistrationId: registrationId, provider: 'OTHER', environment: 'SANDBOX' } })
    );
    configId = config.id;
  });

  afterAll(async () => {
    // Same FK-ordering requirement as gstIntegration.service.test.ts's afterAll.
    await tenantQuery(A.company.id, (tx) => tx.gstIntegrationConfig.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: A.company.id } }));
    await cleanupTestTenant(A);
    await prisma.$disconnect();
  });

  it('creates a PENDING row and completeRequest moves it to SUCCESS with no payload stored', async () => {
    const { row, isNew } = await startRequest({
      companyId: A.company.id, configId, provider: 'OTHER', environment: 'SANDBOX', operation: 'HEALTH_CHECK', correlationId: 'corr-a',
    });
    expect(isNew).toBe(true);
    expect(row.status).toBe('PENDING');

    await completeRequest({ companyId: A.company.id, logId: row.id, status: 'SUCCESS', httpStatus: 200 });
    const persisted = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationRequestLog.findUniqueOrThrow({ where: { id: row.id } }));
    expect(persisted.status).toBe('SUCCESS');
    expect(persisted.httpStatus).toBe(200);
  });

  it('a repeated idempotency key for the same company resolves to the SAME row, never a second one', async () => {
    const key = buildIdempotencyKey({
      companyId: A.company.id, gstRegistrationId: registrationId, provider: 'OTHER', environment: 'SANDBOX',
      operation: 'HEALTH_CHECK', naturalKey: 'same-operation-1',
    });
    const first = await startRequest({ companyId: A.company.id, configId, provider: 'OTHER', environment: 'SANDBOX', operation: 'HEALTH_CHECK', correlationId: 'corr-b1', idempotencyKey: key });
    const second = await startRequest({ companyId: A.company.id, configId, provider: 'OTHER', environment: 'SANDBOX', operation: 'HEALTH_CHECK', correlationId: 'corr-b2', idempotencyKey: key });
    expect(first.isNew).toBe(true);
    expect(second.isNew).toBe(false);
    expect(second.row.id).toBe(first.row.id);

    const count = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationRequestLog.count({ where: { companyId: A.company.id, idempotencyKey: key } }));
    expect(count).toBe(1);
  });

  it('buildIdempotencyKey is deterministic for identical inputs and differs when any input differs', () => {
    const base = { companyId: 'c1', gstRegistrationId: 'r1', provider: 'OTHER' as const, environment: 'SANDBOX' as const, operation: 'HEALTH_CHECK' as const, naturalKey: 'n1' };
    expect(buildIdempotencyKey(base)).toBe(buildIdempotencyKey({ ...base }));
    expect(buildIdempotencyKey(base)).not.toBe(buildIdempotencyKey({ ...base, naturalKey: 'n2' }));
    expect(buildIdempotencyKey(base)).not.toBe(buildIdempotencyKey({ ...base, environment: 'PRODUCTION' }));
  });

  it('requests with NO idempotency key never collide with each other (NULLs are distinct)', async () => {
    const a = await startRequest({ companyId: A.company.id, configId, provider: 'OTHER', environment: 'SANDBOX', operation: 'HEALTH_CHECK', correlationId: 'corr-c1' });
    const b = await startRequest({ companyId: A.company.id, configId, provider: 'OTHER', environment: 'SANDBOX', operation: 'HEALTH_CHECK', correlationId: 'corr-c2' });
    expect(a.row.id).not.toBe(b.row.id);
    expect(a.isNew).toBe(true);
    expect(b.isNew).toBe(true);
  });

  it('listRequestLogs returns only this config’s rows, most recent first', async () => {
    const logs = await listRequestLogs(A.company.id, configId, 100);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.every((l) => l.configId === configId)).toBe(true);
    for (let i = 1; i < logs.length; i++) {
      expect(logs[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(logs[i].createdAt.getTime());
    }
  });

  it('never stores a credential or raw payload in a log row — only metadata fields', async () => {
    const { row } = await startRequest({ companyId: A.company.id, configId, provider: 'OTHER', environment: 'SANDBOX', operation: 'AUTHENTICATE', correlationId: 'corr-d' });
    const persisted: any = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationRequestLog.findUniqueOrThrow({ where: { id: row.id } }));
    const keys = Object.keys(persisted);
    expect(keys).not.toContain('payload');
    expect(keys).not.toContain('requestBody');
    expect(keys).not.toContain('responseBody');
  });
});
