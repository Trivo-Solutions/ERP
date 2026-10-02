// G8a — GST Integration Foundation: the provider-neutral orchestration layer (brief §4's
// "gstIntegrationService or an equivalent"). Future sell-side code (G8b+ e-invoice, G8c+ E-Way
// Bill, ...) is meant to call functions here — never a concrete provider class, never
// resolveProvider() directly, never the encryption/HTTP modules directly. Nothing in this file
// mutates sales/invoice data, generates an IRN, or touches a frozen GST reporting/filing path.
//
// Security pipeline for every function below, per CLAUDE.md §11 / the G8a brief §18:
//   authenticate (route middleware) → company context (req.tenant) → permission (route middleware)
//   → GST registration / config ownership (assertOwnedByCompany, here) → operation.
import { AppError } from '../../../middleware/error';
import { assertOwnedByCompany } from '../../../middleware/tenant';
import { createAuditEntry } from '../../../middleware/audit';
import { tenantQuery, tenantTransaction, TenantContext } from '../../../shared/tenantContext';
import { encryptCredentialValue, decryptCredentialValue, isEncryptionConfigured } from './encryption';
import { generateCorrelationId } from './correlationId';
import { resolveProvider } from './providers/resolveProvider';
import { startRequest, completeRequest } from './requestTracking.service';
import { GstIntegrationError } from './errors';
import {
  GstIntegrationCallContext, GstIntegrationEnvironment, GstProviderName,
  isValidGstIntegrationEnvironment, isValidGstProvider,
} from './types';

// ─── Shapes returned to a route — NEVER include encryptedValue or a decrypted value. ──────────

export interface GstIntegrationConfigSummary {
  id: string;
  gstRegistrationId: string;
  provider: string;
  environment: string;
  label: string | null;
  isActive: boolean;
  lastTestedAt: Date | null;
  lastTestStatus: string | null;
  createdAt: Date;
  updatedAt: Date;
  /** Which credential keys are set — never their values. */
  credentialKeys: string[];
}

function toSummary(config: {
  id: string; gstRegistrationId: string; provider: string; environment: string; label: string | null;
  isActive: boolean; lastTestedAt: Date | null; lastTestStatus: string | null; createdAt: Date; updatedAt: Date;
  credentials: Array<{ credentialKey: string }>;
}): GstIntegrationConfigSummary {
  return {
    id: config.id, gstRegistrationId: config.gstRegistrationId, provider: config.provider, environment: config.environment,
    label: config.label, isActive: config.isActive, lastTestedAt: config.lastTestedAt, lastTestStatus: config.lastTestStatus,
    createdAt: config.createdAt, updatedAt: config.updatedAt,
    credentialKeys: config.credentials.map((c) => c.credentialKey).sort(),
  };
}

export async function listIntegrationConfigs(ctx: TenantContext, gstRegistrationId: string): Promise<GstIntegrationConfigSummary[]> {
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, ctx.companyId, 'GST registration');
  const rows = await tenantQuery(ctx.companyId, (tx) =>
    tx.gstIntegrationConfig.findMany({
      where: { companyId: ctx.companyId, gstRegistrationId },
      include: { credentials: { select: { credentialKey: true } } },
      orderBy: { createdAt: 'asc' },
    })
  );
  return rows.map(toSummary);
}

export interface CreateIntegrationConfigInput {
  provider: string;
  environment: string;
  label?: string | null;
  credentials?: Record<string, string>;
}

export async function createIntegrationConfig(
  ctx: TenantContext, gstRegistrationId: string, data: CreateIntegrationConfigInput,
): Promise<GstIntegrationConfigSummary> {
  if (!isValidGstProvider(data.provider)) throw new AppError(`Unknown GST integration provider '${data.provider}'`, 400);
  if (!isValidGstIntegrationEnvironment(data.environment)) throw new AppError(`Unknown GST integration environment '${data.environment}'`, 400);
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, ctx.companyId, 'GST registration');

  const credentialEntries = Object.entries(data.credentials ?? {});
  if (credentialEntries.length > 0 && !isEncryptionConfigured()) {
    throw new AppError('GST integration encryption is not configured on this server — cannot store credentials', 503);
  }
  // Encrypt before entering the transaction — pure CPU work, never I/O, so this still respects the
  // "no non-database work inside tenantTransaction" rule (shared/tenantContext.ts's own hard rule).
  const encryptedCredentials = credentialEntries.map(([credentialKey, value]) => ({ credentialKey, encryptedValue: encryptCredentialValue(value) }));

  const created = await tenantTransaction(ctx.companyId, async (tx) => {
    try {
      return await tx.gstIntegrationConfig.create({
        data: {
          companyId: ctx.companyId, gstRegistrationId, provider: data.provider, environment: data.environment,
          label: data.label ?? null, createdById: ctx.userId, updatedById: ctx.userId,
          // companyId is NOT passed here — Prisma fills it from the parent on a nested create under
          // a composite relation (CLAUDE.md §11 item 6's documented gotcha); passing it explicitly
          // is rejected as an unknown argument.
          credentials: { create: encryptedCredentials.map((c) => ({ credentialKey: c.credentialKey, encryptedValue: c.encryptedValue })) },
        },
        include: { credentials: { select: { credentialKey: true } } },
      });
    } catch (err: any) {
      if (err?.code === 'P2002') throw new AppError('A config already exists for this GST registration, provider, and environment', 409);
      throw err;
    }
  });

  await createAuditEntry(
    'gst_integration_configs', created.id, ctx.userId, 'CREATE', undefined,
    { gstRegistrationId, provider: data.provider, environment: data.environment, label: data.label ?? null, credentialKeysSet: encryptedCredentials.map((c) => c.credentialKey) },
    ctx.companyId,
  );
  return toSummary(created);
}

export interface UpdateIntegrationConfigInput {
  label?: string | null;
  isActive?: boolean;
  /** Keys supplied here are encrypted and upserted; keys not mentioned are left untouched (never cleared implicitly). */
  credentials?: Record<string, string>;
}

export async function updateIntegrationConfig(
  ctx: TenantContext, configId: string, data: UpdateIntegrationConfigInput,
): Promise<GstIntegrationConfigSummary> {
  await assertOwnedByCompany('gstIntegrationConfig', configId, ctx.companyId, 'GST integration config');

  const credentialEntries = Object.entries(data.credentials ?? {});
  if (credentialEntries.length > 0 && !isEncryptionConfigured()) {
    throw new AppError('GST integration encryption is not configured on this server — cannot store credentials', 503);
  }
  const encryptedCredentials = credentialEntries.map(([credentialKey, value]) => ({ credentialKey, encryptedValue: encryptCredentialValue(value) }));

  const before = await tenantQuery(ctx.companyId, (tx) =>
    tx.gstIntegrationConfig.findUniqueOrThrow({ where: { id: configId }, select: { label: true, isActive: true } })
  );

  const updated = await tenantTransaction(ctx.companyId, async (tx) => {
    for (const c of encryptedCredentials) {
      await tx.gstIntegrationCredential.upsert({
        where: { configId_credentialKey: { configId, credentialKey: c.credentialKey } },
        create: { companyId: ctx.companyId, configId, credentialKey: c.credentialKey, encryptedValue: c.encryptedValue },
        update: { encryptedValue: c.encryptedValue },
      });
    }
    return tx.gstIntegrationConfig.update({
      where: { id: configId },
      data: {
        label: data.label === undefined ? undefined : data.label,
        isActive: data.isActive === undefined ? undefined : data.isActive,
        updatedById: ctx.userId,
      },
      include: { credentials: { select: { credentialKey: true } } },
    });
  });

  await createAuditEntry(
    'gst_integration_configs', configId, ctx.userId, 'EDIT', before,
    { label: data.label ?? before.label, isActive: data.isActive ?? before.isActive, credentialKeysSet: encryptedCredentials.map((c) => c.credentialKey) },
    ctx.companyId,
  );
  return toSummary(updated);
}

// ─── Connection test (brief §20: "test must not perform IRN generation or any statutory mutation") ──

export interface TestConnectionResult {
  status: string; // GstIntegrationHealthStatus
  message?: string;
  correlationId: string;
}

export async function testIntegrationConnection(ctx: TenantContext, configId: string): Promise<TestConnectionResult> {
  await assertOwnedByCompany('gstIntegrationConfig', configId, ctx.companyId, 'GST integration config');

  // Load config + decrypt credentials — a DB read only, so this is fine inside tenantQuery; the
  // actual network call happens OUTSIDE any transaction (shared/tenantContext.ts's hard rule).
  const config = await tenantQuery(ctx.companyId, (tx) =>
    tx.gstIntegrationConfig.findFirstOrThrow({
      where: { id: configId, companyId: ctx.companyId },
      include: { credentials: true },
    })
  );

  const credentials: Record<string, string> = {};
  for (const c of config.credentials) {
    try {
      credentials[c.credentialKey] = decryptCredentialValue(c.encryptedValue);
    } catch {
      // A corrupted/undecryptable credential must not crash the test — it surfaces as AUTH_FAILED
      // below instead (the provider will simply be missing that credential).
    }
  }

  const correlationId = generateCorrelationId();
  const provider = resolveProvider(config.provider);
  const callCtx: GstIntegrationCallContext = {
    companyId: ctx.companyId, gstRegistrationId: config.gstRegistrationId, configId: config.id,
    environment: config.environment as GstIntegrationEnvironment, correlationId, credentials,
  };

  const { row } = await startRequest({
    companyId: ctx.companyId, configId: config.id, provider: config.provider as GstProviderName,
    environment: config.environment as GstIntegrationEnvironment, operation: 'HEALTH_CHECK', correlationId,
  });

  let result: TestConnectionResult;
  try {
    const health = await provider.health(callCtx);
    await completeRequest({ companyId: ctx.companyId, logId: row.id, status: 'SUCCESS' });
    result = { status: health.status, message: health.message, correlationId };
  } catch (err) {
    const normalized = err instanceof GstIntegrationError ? err : new GstIntegrationError({
      message: 'Unexpected error during connection test', category: 'UNKNOWN',
      provider: config.provider as GstProviderName, operation: 'HEALTH_CHECK', correlationId,
    });
    await completeRequest({
      companyId: ctx.companyId, logId: row.id, status: 'FAILED',
      errorCategory: normalized.category, errorCode: normalized.providerCode, errorMessage: normalized.message,
    });
    result = { status: 'UNAVAILABLE', message: normalized.message, correlationId };
  }

  await tenantQuery(ctx.companyId, (tx) =>
    tx.gstIntegrationConfig.update({ where: { id: configId }, data: { lastTestedAt: new Date(), lastTestStatus: result.status } })
  );

  return result;
}
