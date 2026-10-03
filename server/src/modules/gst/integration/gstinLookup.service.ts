// G8b — GSTIN lookup through the G8a provider boundary.
//
// Pipeline: (route: authenticate → tenant context → gst:integration_view) → registration ownership
// → GSTIN validation (before any provider call) → pick this registration's integration config →
// decrypt credentials → provider authenticate (cached) → provider lookup → canonical response.
// Reads only; mutates nothing but a request-log row (metadata, never a GSTIN, credential, header or
// raw provider body). Provider specifics live entirely in providers/.
import { AppError } from '../../../middleware/error';
import { assertOwnedByCompany } from '../../../middleware/tenant';
import { tenantQuery, TenantContext } from '../../../shared/tenantContext';
import { validateGstin } from '../../../shared/gstin';
import { decryptCredentialValue } from './encryption';
import { generateCorrelationId } from './correlationId';
import { resolveProvider } from './providers/resolveProvider';
import { getOrAuthenticate, invalidateSession } from './auth/tokenSession';
import { startRequest, completeRequest } from './requestTracking.service';
import { GstIntegrationError } from './errors';
import {
  GstIntegrationCallContext, GstIntegrationEnvironment, GstIntegrationErrorCategory, GstProviderName,
  GstinDetails, isValidGstIntegrationEnvironment,
} from './types';

export interface GstinLookupResult {
  details: GstinDetails;
  correlationId: string;
}

// Provider/transport failures are the upstream's problem, not the caller's credentials — never 401
// (the client treats 401 as "session expired" and tries to refresh its own login).
const HTTP_STATUS_FOR_CATEGORY: Record<GstIntegrationErrorCategory, number> = {
  AUTHENTICATION: 502, AUTHORIZATION: 502, VALIDATION: 422, RATE_LIMIT: 429, TIMEOUT: 504,
  NETWORK: 502, PROVIDER: 502, DUPLICATE: 409, UNSUPPORTED: 501, UNKNOWN: 502,
};

/** Safe, actionable AppError: normalized message + correlation id only — never a stack or provider body. */
function toAppError(err: GstIntegrationError): AppError {
  return new AppError(`${err.message} (correlationId: ${err.correlationId})`, HTTP_STATUS_FOR_CATEGORY[err.category] ?? 502);
}

async function selectConfig(ctx: TenantContext, gstRegistrationId: string, environment?: string) {
  if (environment !== undefined && !isValidGstIntegrationEnvironment(environment)) {
    throw new AppError(`Unknown GST integration environment '${environment}'`, 400);
  }
  const configs = await tenantQuery(ctx.companyId, (tx) =>
    tx.gstIntegrationConfig.findMany({
      where: { companyId: ctx.companyId, gstRegistrationId, isActive: true, ...(environment ? { environment } : {}) },
      include: { credentials: true },
      orderBy: { createdAt: 'asc' },
    })
  );
  if (configs.length === 0) throw new AppError('No active GST integration is configured for this registration', 422);
  if (configs.length > 1) {
    // Never guess between sandbox/production or between providers.
    throw new AppError('Multiple active GST integrations match this registration — specify ?environment= or deactivate the extra config', 409);
  }
  return configs[0];
}

export async function lookupGstin(
  ctx: TenantContext, gstRegistrationId: string, rawGstin: string, environment?: string,
): Promise<GstinLookupResult> {
  await assertOwnedByCompany('companyGstRegistration', gstRegistrationId, ctx.companyId, 'GST registration');

  const validation = validateGstin(rawGstin);
  if (!validation.valid) throw new AppError(`Invalid GSTIN: ${validation.errors.join('; ')}`, 400);
  const gstin = validation.gstin;

  const config = await selectConfig(ctx, gstRegistrationId, environment);

  const credentials: Record<string, string> = {};
  for (const c of config.credentials) {
    try { credentials[c.credentialKey] = decryptCredentialValue(c.encryptedValue); } catch { /* surfaces as a missing credential below */ }
  }

  const correlationId = generateCorrelationId();
  const providerName = config.provider as GstProviderName;
  const provider = resolveProvider(config.provider);
  const callCtx: GstIntegrationCallContext = {
    companyId: ctx.companyId, gstRegistrationId, configId: config.id,
    environment: config.environment as GstIntegrationEnvironment, correlationId, credentials,
  };

  const { row } = await startRequest({
    companyId: ctx.companyId, configId: config.id, provider: providerName,
    environment: callCtx.environment, operation: 'GET_GSTIN_DETAILS', correlationId,
  });

  let failure: GstIntegrationError | undefined;
  try {
    const auth = await getOrAuthenticate(config.id, provider, callCtx);
    if (auth.status === 'NOT_CONFIGURED') {
      throw new GstIntegrationError({ message: `GSTIN lookup is not supported for provider ${providerName}`, category: 'UNSUPPORTED', provider: providerName, operation: 'GET_GSTIN_DETAILS', correlationId });
    }
    if (auth.status !== 'AUTHENTICATED' || !auth.token) {
      throw new GstIntegrationError({ message: 'Provider authentication failed — check the integration credentials', category: 'AUTHENTICATION', provider: providerName, operation: 'GET_GSTIN_DETAILS', correlationId });
    }

    const result = await provider.getGstinDetails({ ...callCtx, authToken: auth.token }, gstin);
    if ('status' in result && result.status === 'UNSUPPORTED_PROVIDER_OPERATION') {
      throw new GstIntegrationError({ message: `GSTIN lookup is not supported for provider ${providerName}`, category: 'UNSUPPORTED', provider: providerName, operation: 'GET_GSTIN_DETAILS', correlationId });
    }
    await completeRequest({ companyId: ctx.companyId, logId: row.id, status: 'SUCCESS' });
    return { details: result as GstinDetails, correlationId };
  } catch (err) {
    failure = err instanceof GstIntegrationError ? err : new GstIntegrationError({
      message: 'Unexpected error during GSTIN lookup', category: 'UNKNOWN', provider: providerName, operation: 'GET_GSTIN_DETAILS', correlationId,
    });
    // A rejected token must not be reused by the next call.
    if (failure.category === 'AUTHENTICATION') invalidateSession(config.id);
    await completeRequest({
      companyId: ctx.companyId, logId: row.id, status: 'FAILED',
      errorCategory: failure.category, errorCode: failure.providerCode, errorMessage: failure.message,
    });
    throw toAppError(failure);
  }
}
