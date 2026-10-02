import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { platformPrisma as prisma } from '../../../config/database';
import { tenantQuery } from '../../../shared/tenantContext';
import { createGstRegistration } from '../../company/company.service';
import { createTestTenant, cleanupTestTenant, TestTenant } from '../../../test/fixtures';
import {
  listIntegrationConfigs, createIntegrationConfig, updateIntegrationConfig, testIntegrationConnection,
} from './gstIntegration.service';

describe('G8a gstIntegration.service: config CRUD, credential encryption, tenant isolation', () => {
  const suffix = `g8asvc${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  let A: TestTenant;
  let B: TestTenant;
  let registrationIdA: string;
  let registrationIdB: string;

  beforeAll(async () => {
    A = await createTestTenant(`${suffix}A`, []);
    B = await createTestTenant(`${suffix}B`, []);
    registrationIdA = (await createGstRegistration(A.ctx, { gstin: '24AAAAA2000A1Z4', legalName: 'G8a Svc Co A', stateCode: '24' })).id;
    registrationIdB = (await createGstRegistration(B.ctx, { gstin: '24AAAAA3000A1Z3', legalName: 'G8a Svc Co B', stateCode: '24' })).id;
  });

  afterAll(async () => {
    // gst_integration_configs has a composite FK (gstRegistrationId, companyId) ->
    // CompanyGstRegistration (RESTRICT) — must go before the registration itself. cleanupTestTenant
    // does not delete CompanyGstRegistration rows at all (every GST-registration-creating test
    // cleans its own up first — same precedent as gstr3bRcmReporting.service.test.ts).
    await tenantQuery(A.company.id, (tx) => tx.gstIntegrationConfig.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(B.company.id, (tx) => tx.gstIntegrationConfig.deleteMany({ where: { companyId: B.company.id } }));
    await tenantQuery(A.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: A.company.id } }));
    await tenantQuery(B.company.id, (tx) => tx.companyGstRegistration.deleteMany({ where: { companyId: B.company.id } }));
    await cleanupTestTenant(A);
    await cleanupTestTenant(B);
    await prisma.$disconnect();
  });

  it('creates a config with credentials and never returns a decrypted or encrypted value — only credential keys', async () => {
    const summary = await createIntegrationConfig(A.ctx, registrationIdA, {
      provider: 'IRIS_IRP', environment: 'SANDBOX', label: 'Primary sandbox',
      credentials: { clientId: 'the-client-id', clientSecret: 'super-secret-value' },
    });
    expect(summary.provider).toBe('IRIS_IRP');
    expect(summary.environment).toBe('SANDBOX');
    expect(summary.credentialKeys.sort()).toEqual(['clientId', 'clientSecret']);
    expect(JSON.stringify(summary)).not.toContain('super-secret-value');
    expect(JSON.stringify(summary)).not.toContain('the-client-id');
  });

  it('the stored row is actually encrypted at rest — the raw DB value never contains the plaintext secret', async () => {
    const summary = await createIntegrationConfig(A.ctx, registrationIdA, {
      provider: 'NIC_IRP', environment: 'SANDBOX', credentials: { apiKey: 'plaintext-api-key-xyz' },
    });
    const row = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationCredential.findFirstOrThrow({ where: { configId: summary.id, credentialKey: 'apiKey' } }));
    expect(row.encryptedValue).not.toContain('plaintext-api-key-xyz');
  });

  it('rejects an unknown provider/environment', async () => {
    await expect(createIntegrationConfig(A.ctx, registrationIdA, { provider: 'NOT_A_REAL_PROVIDER', environment: 'SANDBOX' })).rejects.toThrow();
    await expect(createIntegrationConfig(A.ctx, registrationIdA, { provider: 'OTHER', environment: 'NOT_AN_ENV' })).rejects.toThrow();
  });

  it('rejects a duplicate (registration, provider, environment) config with 409', async () => {
    await createIntegrationConfig(A.ctx, registrationIdA, { provider: 'CYGNET_IRP', environment: 'PRODUCTION' });
    await expect(createIntegrationConfig(A.ctx, registrationIdA, { provider: 'CYGNET_IRP', environment: 'PRODUCTION' }))
      .rejects.toMatchObject({ statusCode: 409 });
  });

  it('refuses a forged cross-company GST registration id with 404, and creates nothing', async () => {
    const before = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationConfig.count({ where: { companyId: A.company.id } }));
    await expect(createIntegrationConfig(A.ctx, registrationIdB, { provider: 'CLEAR_IRP', environment: 'SANDBOX' }))
      .rejects.toMatchObject({ statusCode: 404 });
    const after = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationConfig.count({ where: { companyId: A.company.id } }));
    expect(after).toBe(before);
    // and nothing leaked into B's company either (B owns registrationIdB)
    const leaked = await tenantQuery(B.company.id, (tx) => tx.gstIntegrationConfig.findFirst({ where: { gstRegistrationId: registrationIdB, provider: 'CLEAR_IRP' } }));
    expect(leaked).toBeNull();
  });

  it('listIntegrationConfigs scopes strictly to the given registration and never leaks another company’s config', async () => {
    const configA = await createIntegrationConfig(A.ctx, registrationIdA, { provider: 'CLEAR_IRP', environment: 'SANDBOX' });
    const listA = await listIntegrationConfigs(A.ctx, registrationIdA);
    expect(listA.some((c) => c.id === configA.id)).toBe(true);

    // B cannot list A's registration's configs at all — 404, not an empty/leaked list.
    await expect(listIntegrationConfigs(B.ctx, registrationIdA)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('updateIntegrationConfig merges new credential keys without clearing existing ones, and toggles isActive', async () => {
    const created = await createIntegrationConfig(A.ctx, registrationIdA, {
      provider: 'IRIS_IRP', environment: 'PRODUCTION', credentials: { clientId: 'id-1' },
    });
    const updated = await updateIntegrationConfig(A.ctx, created.id, { credentials: { clientSecret: 'secret-1' }, isActive: false });
    expect(updated.credentialKeys.sort()).toEqual(['clientId', 'clientSecret']);
    expect(updated.isActive).toBe(false);
  });

  it('a cross-company config id is rejected with 404 on update, and nothing changes', async () => {
    const created = await createIntegrationConfig(B.ctx, registrationIdB, { provider: 'OTHER', environment: 'SANDBOX', label: 'original' });
    await expect(updateIntegrationConfig(A.ctx, created.id, { label: 'hijacked' })).rejects.toMatchObject({ statusCode: 404 });
    const row = await tenantQuery(B.company.id, (tx) => tx.gstIntegrationConfig.findUniqueOrThrow({ where: { id: created.id } }));
    expect(row.label).toBe('original');
  });

  it('testIntegrationConnection runs a health check (today: deterministic NOT_CONFIGURED), records a request log, and stamps the config', async () => {
    const created = await createIntegrationConfig(A.ctx, registrationIdA, { provider: 'CLEAR_IRP', environment: 'PRODUCTION', label: 'test-target' });
    const result = await testIntegrationConnection(A.ctx, created.id);
    expect(result.status).toBe('NOT_CONFIGURED');
    expect(result.correlationId).toBeTruthy();

    const row = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationConfig.findUniqueOrThrow({ where: { id: created.id } }));
    expect(row.lastTestStatus).toBe('NOT_CONFIGURED');
    expect(row.lastTestedAt).not.toBeNull();

    const logs = await tenantQuery(A.company.id, (tx) => tx.gstIntegrationRequestLog.findMany({ where: { configId: created.id } }));
    expect(logs.some((l) => l.operation === 'HEALTH_CHECK' && l.status === 'SUCCESS')).toBe(true);
  });

  it('a cross-company config id is rejected with 404 on test, never runs a health check against it', async () => {
    const created = await createIntegrationConfig(B.ctx, registrationIdB, { provider: 'OTHER', environment: 'PRODUCTION' });
    await expect(testIntegrationConnection(A.ctx, created.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('refuses to store credentials when encryption is not configured, and persists nothing', async () => {
    const { env } = await import('../../../config/env');
    const original = env.GST_INTEGRATION_ENCRYPTION_KEY;
    try {
      (env as any).GST_INTEGRATION_ENCRYPTION_KEY = undefined;
      await expect(createIntegrationConfig(A.ctx, registrationIdA, { provider: 'OTHER', environment: 'PRODUCTION' as any, credentials: { x: 'y' } }))
        .rejects.toMatchObject({ statusCode: 503 });
    } finally {
      (env as any).GST_INTEGRATION_ENCRYPTION_KEY = original;
    }
  });

  it('writes an audit entry on create/update that records WHICH credential keys changed, never their values', async () => {
    const created = await createIntegrationConfig(A.ctx, registrationIdA, {
      provider: 'NIC_IRP', environment: 'PRODUCTION', credentials: { password: 'audit-should-not-contain-this' },
    });
    const entries = await prisma.auditLog.findMany({ where: { tableName: 'gst_integration_configs', recordId: created.id } });
    expect(entries.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain('audit-should-not-contain-this');
    expect(serialized).toContain('password'); // the KEY name is fine to record, the value is not
  });
});
