// G8a — controlled outbound HTTP client (brief §12). No HTTP client/retry/timeout wrapper existed
// anywhere in this codebase before this phase (verified: the one precedent, shared/gstProvider.ts's
// HttpGstProvider, calls the global `fetch` directly with none of timeout/retry/correlation/size-
// bounding — this file is deliberately NOT layered on top of that, since GSTIN-registry lookup and
// GST-integration-provider traffic are different concerns with different safety requirements, per
// this phase's own scope boundary). Nothing in this module calls a real endpoint on its own — it is
// only ever invoked by a provider adapter, and G8a ships no adapter that does (see
// providers/unconfiguredProvider.ts).
//
// Safety rules enforced here, not left to each call site:
//   - explicit timeout (AbortController)
//   - HTTPS required when environment === 'PRODUCTION'
//   - bounded response size (reject rather than buffer unboundedly)
//   - every request/response is traced by correlationId; NEVER logs Authorization or body content
//   - retry is OFF by default and only ever applies when the CALLER explicitly marks the operation
//     idempotent-safe (brief §12 — "never blindly retry a future IRN generation request")
import { logger } from '../../../config/logger';
import { GstIntegrationError, categoryForHttpStatus } from './errors';
import { GstIntegrationEnvironment, GstIntegrationOperation, GstProviderName, IDEMPOTENT_SAFE_OPERATIONS } from './types';

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2MB — a statutory API response is small JSON, never a bulk payload
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 300;

export interface GstIntegrationHttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
  maxRetries?: number;
  /** Override for testing — production code never needs this, the default is MAX_RESPONSE_BYTES. */
  maxResponseBytes?: number;
  provider: GstProviderName;
  operation: GstIntegrationOperation;
  environment: GstIntegrationEnvironment;
  correlationId: string;
}

export interface GstIntegrationHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reads a fetch Response body up to `limit` bytes; throws (never silently truncates) if exceeded. */
async function readBoundedBody(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return response.text();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        throw new Error('RESPONSE_TOO_LARGE');
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Performs one outbound integration HTTP call with the safety rules above. Never logs headers or
 * body content — only method, url host+path, status, correlationId, and duration.
 */
export async function gstIntegrationFetch(req: GstIntegrationHttpRequest): Promise<GstIntegrationHttpResponse> {
  let parsed: URL;
  try {
    parsed = new URL(req.url);
  } catch {
    throw new GstIntegrationError({
      message: 'Integration request URL is malformed', category: 'VALIDATION',
      provider: req.provider, operation: req.operation, correlationId: req.correlationId,
    });
  }
  if (req.environment === 'PRODUCTION' && parsed.protocol !== 'https:') {
    throw new GstIntegrationError({
      message: 'Production GST integration calls must use HTTPS', category: 'VALIDATION',
      provider: req.provider, operation: req.operation, correlationId: req.correlationId,
    });
  }

  const isIdempotentSafe = IDEMPOTENT_SAFE_OPERATIONS.has(req.operation);
  const maxAttempts = isIdempotentSafe ? Math.max(1, (req.maxRetries ?? DEFAULT_MAX_RETRIES) + 1) : 1;
  const timeoutMs = req.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  let lastError: GstIntegrationError | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const startedAt = Date.now();
    try {
      const response = await fetch(parsed.toString(), {
        method: req.method,
        headers: { 'X-Correlation-Id': req.correlationId, ...req.headers },
        body: req.body,
        signal: controller.signal,
      });
      const bodyText = await readBoundedBody(response, req.maxResponseBytes ?? MAX_RESPONSE_BYTES);
      logger.info(`[gst-integration] ${req.provider}/${req.environment} ${req.method} ${parsed.host}${parsed.pathname} -> ${response.status} (${Date.now() - startedAt}ms) correlationId=${req.correlationId}`);

      if (!response.ok) {
        const category = categoryForHttpStatus(response.status);
        const err = new GstIntegrationError({
          message: `Provider responded with HTTP ${response.status}`, category,
          provider: req.provider, operation: req.operation, correlationId: req.correlationId,
          providerCode: String(response.status),
        });
        if (isIdempotentSafe && err.retryable && attempt < maxAttempts) {
          lastError = err;
          await sleep(RETRY_BASE_DELAY_MS * attempt);
          continue;
        }
        throw err;
      }

      const headers: Record<string, string> = {};
      response.headers.forEach((v, k) => { headers[k] = v; });
      return { status: response.status, headers, body: bodyText };
    } catch (err) {
      if (err instanceof GstIntegrationError) throw err;
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const isTooLarge = err instanceof Error && err.message === 'RESPONSE_TOO_LARGE';
      const category = isAbort ? 'TIMEOUT' : isTooLarge ? 'VALIDATION' : 'NETWORK';
      const message = isAbort ? `Request timed out after ${timeoutMs}ms` : isTooLarge ? 'Provider response exceeded the allowed size' : 'Network error contacting provider';
      const normalized = new GstIntegrationError({
        message, category, provider: req.provider, operation: req.operation, correlationId: req.correlationId,
      });
      if (isIdempotentSafe && normalized.retryable && attempt < maxAttempts) {
        lastError = normalized;
        await sleep(RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      throw normalized;
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable in practice (the loop always returns or throws), but satisfies the type checker and
  // guards against a future edit to the loop shape silently falling through.
  throw lastError ?? new GstIntegrationError({
    message: 'Integration request failed for an unknown reason', category: 'UNKNOWN',
    provider: req.provider, operation: req.operation, correlationId: req.correlationId,
  });
}
