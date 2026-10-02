// G8a — an injectable mock GstIntegrationProvider (brief §24: "mock provider can be injected for
// tests"). Used ONLY by tests of the auth/session cache and the orchestration service — never
// resolved by resolveProvider.ts, never reachable from a real request. Lets a test control
// authenticate()'s latency/expiry/call-count without any real network dependency, the same
// "swap in a fake implementation of the interface" role shared/gstProvider.ts's own
// UnconfiguredGstProvider plays for that unrelated feature.
import {
  GstIntegrationProvider, GstIntegrationCallContext, GstIntegrationAuthResult,
  GstIntegrationHealthResult, UnsupportedOperationResult, unsupported,
} from '../types';

export interface MockProviderOptions {
  /** ms to await before resolving authenticate() — lets a test observe an in-flight call. */
  authenticateDelayMs?: number;
  /** How long an issued token stays valid, in ms from the moment authenticate() is called. */
  tokenTtlMs?: number;
  /** When set, authenticate() returns AUTH_FAILED instead of issuing a token. */
  failAuthentication?: boolean;
  healthStatus?: GstIntegrationHealthResult['status'];
}

export function createMockProvider(opts: MockProviderOptions = {}): GstIntegrationProvider & { authenticateCallCount: number } {
  const counter = { value: 0 };
  const provider = {
    name: 'OTHER' as const,
    get authenticateCallCount() { return counter.value; },
    async authenticate(_ctx: GstIntegrationCallContext): Promise<GstIntegrationAuthResult> {
      counter.value += 1;
      if (opts.authenticateDelayMs) await new Promise((r) => setTimeout(r, opts.authenticateDelayMs));
      if (opts.failAuthentication) return { status: 'AUTH_FAILED', message: 'mock: forced failure' };
      return { status: 'AUTHENTICATED', token: `mock-token-${counter.value}`, expiresAt: Date.now() + (opts.tokenTtlMs ?? 60_000) };
    },
    async health(ctx: GstIntegrationCallContext): Promise<GstIntegrationHealthResult> {
      return { status: opts.healthStatus ?? 'AVAILABLE', checkedAt: new Date().toISOString(), correlationId: ctx.correlationId };
    },
    async getGstinDetails(): Promise<UnsupportedOperationResult> { return unsupported('OTHER', 'GET_GSTIN_DETAILS'); },
    async generateIrn(): Promise<UnsupportedOperationResult> { return unsupported('OTHER', 'GENERATE_IRN'); },
    async cancelIrn(): Promise<UnsupportedOperationResult> { return unsupported('OTHER', 'CANCEL_IRN'); },
    async getIrn(): Promise<UnsupportedOperationResult> { return unsupported('OTHER', 'GET_IRN'); },
    async getIrnByDocument(): Promise<UnsupportedOperationResult> { return unsupported('OTHER', 'GET_IRN_BY_DOCUMENT'); },
    async generateEwayBill(): Promise<UnsupportedOperationResult> { return unsupported('OTHER', 'GENERATE_EWAYBILL'); },
    async cancelEwayBill(): Promise<UnsupportedOperationResult> { return unsupported('OTHER', 'CANCEL_EWAYBILL'); },
  };
  return provider;
}
