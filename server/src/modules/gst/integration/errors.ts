// G8a — provider-neutral error shape (brief §15). Every failure from httpClient.ts, a provider
// adapter, or the auth/session cache is normalized into this before it reaches a route or gets
// written into a GstIntegrationRequestLog row. Never carries a secret, a raw Authorization header,
// or a raw provider response body — only a safe, already-redacted message.
import { GstIntegrationErrorCategory, GstProviderName, GstIntegrationOperation } from './types';

export class GstIntegrationError extends Error {
  readonly provider: GstProviderName | 'UNKNOWN';
  readonly operation: GstIntegrationOperation | 'OTHER';
  readonly category: GstIntegrationErrorCategory;
  readonly providerCode?: string;
  readonly retryable: boolean;
  readonly correlationId: string;

  constructor(opts: {
    message: string;
    category: GstIntegrationErrorCategory;
    provider: GstProviderName | 'UNKNOWN';
    operation: GstIntegrationOperation | 'OTHER';
    correlationId: string;
    providerCode?: string;
    retryable?: boolean;
  }) {
    super(opts.message);
    this.name = 'GstIntegrationError';
    this.category = opts.category;
    this.provider = opts.provider;
    this.operation = opts.operation;
    this.correlationId = opts.correlationId;
    this.providerCode = opts.providerCode;
    // Only a narrow, explicit allow-list of categories is ever retryable by default — see
    // httpClient.ts, which also requires the caller to opt the OPERATION itself into retries
    // (IDEMPOTENT_SAFE_OPERATIONS in types.ts). A category being "retryable" here is necessary,
    // never sufficient, for an automatic retry. PROVIDER (5xx) is included — a transient server-side
    // failure is exactly the canonical "safe to retry" case; AUTHENTICATION/AUTHORIZATION/
    // VALIDATION/DUPLICATE/UNSUPPORTED/UNKNOWN are not, since retrying those just repeats a failure
    // that will not change.
    this.retryable = opts.retryable ?? (opts.category === 'TIMEOUT' || opts.category === 'NETWORK' || opts.category === 'RATE_LIMIT' || opts.category === 'PROVIDER');
  }

  /** Safe to return over HTTP or write to a log — no stack, no internal detail beyond the normalized fields. */
  toSafeJSON() {
    return {
      category: this.category,
      provider: this.provider,
      operation: this.operation,
      message: this.message,
      providerCode: this.providerCode,
      retryable: this.retryable,
      correlationId: this.correlationId,
    };
  }
}

/** Maps an HTTP status from a provider response to a category — used by httpClient.ts. */
export function categoryForHttpStatus(status: number): GstIntegrationErrorCategory {
  if (status === 401) return 'AUTHENTICATION';
  if (status === 403) return 'AUTHORIZATION';
  if (status === 409) return 'DUPLICATE';
  if (status === 422 || status === 400) return 'VALIDATION';
  if (status === 429) return 'RATE_LIMIT';
  if (status >= 500) return 'PROVIDER';
  return 'UNKNOWN';
}
