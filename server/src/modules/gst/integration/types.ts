// G8a — GST Integration Foundation: shared types and the provider-neutral contract.
//
// Framework-agnostic on purpose (no Prisma import) — same "pure constants + types" shape as
// shared/taxCategory.ts. Nothing here performs I/O; see httpClient.ts / encryption.ts / providers/
// for the pieces that do.

// ─── Provider & environment ────────────────────────────────────────────────

// Only providers genuinely anticipated by this architecture (G8a brief §5) — never a placeholder
// for one that isn't actually planned. 'OTHER' exists so a config can be created before the exact
// provider is finalized, without inventing a fake specific name.
export const GST_PROVIDERS = ['IRIS_IRP', 'NIC_IRP', 'CYGNET_IRP', 'CLEAR_IRP', 'OTHER'] as const;
export type GstProviderName = (typeof GST_PROVIDERS)[number];

export function isValidGstProvider(value: string): value is GstProviderName {
  return (GST_PROVIDERS as readonly string[]).includes(value);
}

// Structurally separate on purpose — never inferred from a URL (brief §9/§10). Every provider call
// carries its environment explicitly in its execution context.
export const GST_INTEGRATION_ENVIRONMENTS = ['SANDBOX', 'PRODUCTION'] as const;
export type GstIntegrationEnvironment = (typeof GST_INTEGRATION_ENVIRONMENTS)[number];

export function isValidGstIntegrationEnvironment(value: string): value is GstIntegrationEnvironment {
  return (GST_INTEGRATION_ENVIRONMENTS as readonly string[]).includes(value);
}

// ─── Operations (brief §10/§14) ────────────────────────────────────────────
//
// The full future capability surface, named now so request-log rows and the provider interface
// never need a shape change when G8b+ actually implements one. Only AUTHENTICATE and HEALTH_CHECK
// are ever produced by THIS phase.
export const GST_INTEGRATION_OPERATIONS = [
  'AUTHENTICATE', 'HEALTH_CHECK', 'GET_GSTIN_DETAILS',
  'GENERATE_IRN', 'CANCEL_IRN', 'GET_IRN', 'GET_IRN_BY_DOCUMENT',
  'GENERATE_EWAYBILL', 'CANCEL_EWAYBILL', 'OTHER',
] as const;
export type GstIntegrationOperation = (typeof GST_INTEGRATION_OPERATIONS)[number];

// Operations safe to retry automatically on a transient failure (idempotent reads / pure status
// checks). Anything mutation-shaped (generateIrn, cancelIrn, generateEwayBill, cancelEwayBill) is
// deliberately absent — brief §12's "never blindly retry a future IRN generation request".
export const IDEMPOTENT_SAFE_OPERATIONS: ReadonlySet<GstIntegrationOperation> = new Set([
  'HEALTH_CHECK', 'GET_GSTIN_DETAILS', 'GET_IRN', 'GET_IRN_BY_DOCUMENT',
]);

// ─── Error categories (brief §15) ──────────────────────────────────────────

export const GST_INTEGRATION_ERROR_CATEGORIES = [
  'AUTHENTICATION', 'AUTHORIZATION', 'VALIDATION', 'RATE_LIMIT', 'TIMEOUT',
  'NETWORK', 'PROVIDER', 'DUPLICATE', 'UNSUPPORTED', 'UNKNOWN',
] as const;
export type GstIntegrationErrorCategory = (typeof GST_INTEGRATION_ERROR_CATEGORIES)[number];

// ─── Health (brief §17) ─────────────────────────────────────────────────────

export const GST_INTEGRATION_HEALTH_STATUSES = ['AVAILABLE', 'UNAVAILABLE', 'NOT_CONFIGURED', 'AUTH_FAILED', 'UNKNOWN'] as const;
export type GstIntegrationHealthStatus = (typeof GST_INTEGRATION_HEALTH_STATUSES)[number];

export interface GstIntegrationHealthResult {
  status: GstIntegrationHealthStatus;
  message?: string;
  checkedAt: string; // ISO timestamp
  correlationId: string;
}

// ─── Execution context (brief §10/§11) ─────────────────────────────────────
//
// Everything a provider adapter call needs, handed in explicitly — never resolved implicitly by
// the adapter (e.g. no reading process.env for environment). `credentials` holds already-DECRYPTED
// values for exactly this one call; it must never be logged, cached beyond the call, or echoed
// into a response/error.
export interface GstIntegrationCallContext {
  companyId: string;
  gstRegistrationId: string;
  configId: string;
  environment: GstIntegrationEnvironment;
  correlationId: string;
  credentials: Readonly<Record<string, string>>;
}

// A capability this phase does not implement returns this deterministic shape instead of throwing
// or fabricating data (brief §10: "deterministic NOT_IMPLEMENTED / UNSUPPORTED_PROVIDER_OPERATION").
export interface UnsupportedOperationResult {
  status: 'UNSUPPORTED_PROVIDER_OPERATION';
  provider: GstProviderName;
  operation: GstIntegrationOperation;
  message: string;
}

export function unsupported(provider: GstProviderName, operation: GstIntegrationOperation): UnsupportedOperationResult {
  return {
    status: 'UNSUPPORTED_PROVIDER_OPERATION',
    provider,
    operation,
    message: `${operation} is not implemented for provider ${provider} in this phase (G8a is infrastructure-only).`,
  };
}

// ─── Authentication abstraction (brief §11) ────────────────────────────────

export interface GstIntegrationAuthResult {
  status: 'AUTHENTICATED' | 'NOT_CONFIGURED' | 'AUTH_FAILED';
  /** Opaque to TRIVO — never assumed to be a bearer token specifically; carried back to the
   *  adapter on the next call, never returned over HTTP. */
  token?: string;
  /** Epoch ms. Absent/undefined is treated as "already expired" by the session cache — never
   *  cached indefinitely by accident. */
  expiresAt?: number;
  message?: string;
}

// ─── Provider contract (brief §10) ─────────────────────────────────────────
//
// Every method is async and NEVER throws for an ordinary "this isn't built yet" case — it returns
// a typed Unsupported/NotConfigured result. It MAY throw a GstIntegrationError (errors.ts) for a
// genuine transport/programming failure, which the caller (gstIntegration.service.ts) catches and
// normalizes into a request-log row.
export interface GstIntegrationProvider {
  readonly name: GstProviderName;

  authenticate(ctx: GstIntegrationCallContext): Promise<GstIntegrationAuthResult>;
  health(ctx: GstIntegrationCallContext): Promise<GstIntegrationHealthResult>;

  // Future e-invoice/EWB capabilities — G8a ships none of these; every one resolves to
  // UnsupportedOperationResult via unsupported(name, '<OPERATION>') until a real adapter exists.
  getGstinDetails(ctx: GstIntegrationCallContext, gstin: string): Promise<UnsupportedOperationResult>;
  generateIrn(ctx: GstIntegrationCallContext, payload: unknown): Promise<UnsupportedOperationResult>;
  cancelIrn(ctx: GstIntegrationCallContext, payload: unknown): Promise<UnsupportedOperationResult>;
  getIrn(ctx: GstIntegrationCallContext, irn: string): Promise<UnsupportedOperationResult>;
  getIrnByDocument(ctx: GstIntegrationCallContext, payload: unknown): Promise<UnsupportedOperationResult>;
  generateEwayBill(ctx: GstIntegrationCallContext, payload: unknown): Promise<UnsupportedOperationResult>;
  cancelEwayBill(ctx: GstIntegrationCallContext, payload: unknown): Promise<UnsupportedOperationResult>;
}
