// G8a — correlation IDs (brief §16). This codebase has no existing request-id/correlation-id
// infrastructure (verified: no `requestId`/`correlationId`/`x-request-id` usage anywhere in
// server/src before this phase), so this is a small, standalone helper rather than a competing
// system layered on top of something that doesn't exist yet. Traces
// TRIVO request → GstIntegrationRequestLog row → (future) provider HTTP request.
import { randomUUID } from 'crypto';

export function generateCorrelationId(): string {
  return `gstint_${randomUUID()}`;
}
