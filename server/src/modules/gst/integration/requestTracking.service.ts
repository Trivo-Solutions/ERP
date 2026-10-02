// G8a — request/response tracking + idempotency foundation (brief §13/§14).
//
// Idempotency mechanism: the (companyId, idempotencyKey) unique index on
// gst_integration_request_logs (nullable idempotencyKey — Postgres treats NULLs as distinct, so
// operations with no key, e.g. ordinary health checks, never collide with each other) IS the
// de-duplication guarantee. startRequest() below tries to INSERT a new PENDING row; on a unique
// violation it fetches and returns the ALREADY-EXISTING row instead of creating a second one — "same
// TRIVO operation + same company + same GST registration + same provider + same environment"
// resolves to the same operation record, exactly as the brief specifies, with no separate
// idempotency table (the brief explicitly says to keep this "generic" — reusing the one table it
// already needs for tracking is the minimal design, not a second model bolted on).
import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { tenantQuery } from '../../../shared/tenantContext';
import {
  GstIntegrationEnvironment, GstIntegrationErrorCategory, GstIntegrationOperation, GstProviderName,
} from './types';

export interface BuildIdempotencyKeyInput {
  companyId: string;
  gstRegistrationId: string;
  provider: GstProviderName;
  environment: GstIntegrationEnvironment;
  operation: GstIntegrationOperation;
  /** Whatever makes THIS operation unique beyond the tuple above — e.g. a future invoice id for generateIrn. */
  naturalKey: string;
}

/** Deterministic key for "the same TRIVO operation" (brief §13) — same inputs always hash to the same key. */
export function buildIdempotencyKey(input: BuildIdempotencyKeyInput): string {
  const material = [input.companyId, input.gstRegistrationId, input.provider, input.environment, input.operation, input.naturalKey].join('|');
  return createHash('sha256').update(material).digest('hex');
}

export interface StartRequestInput {
  companyId: string;
  configId: string;
  provider: GstProviderName;
  environment: GstIntegrationEnvironment;
  operation: GstIntegrationOperation;
  correlationId: string;
  idempotencyKey?: string;
}

export interface RequestLogRow {
  id: string;
  status: string;
  correlationId: string;
  idempotencyKey: string | null;
}

/**
 * Creates a PENDING request-log row, or — if `idempotencyKey` is set and a row for it already
 * exists on this company — returns that existing row untouched (`isNew: false`) instead of
 * creating a duplicate "operation record" (brief §13's duplicate-prevention requirement).
 */
export async function startRequest(input: StartRequestInput): Promise<{ row: RequestLogRow; isNew: boolean }> {
  try {
    const row = await tenantQuery(input.companyId, (tx) =>
      tx.gstIntegrationRequestLog.create({
        data: {
          companyId: input.companyId,
          configId: input.configId,
          provider: input.provider,
          environment: input.environment,
          operation: input.operation,
          correlationId: input.correlationId,
          idempotencyKey: input.idempotencyKey,
          requestStartedAt: new Date(),
          status: 'PENDING',
        },
        select: { id: true, status: true, correlationId: true, idempotencyKey: true },
      })
    );
    return { row, isNew: true };
  } catch (err) {
    if (input.idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      const existing = await tenantQuery(input.companyId, (tx) =>
        tx.gstIntegrationRequestLog.findFirstOrThrow({
          where: { companyId: input.companyId, idempotencyKey: input.idempotencyKey },
          select: { id: true, status: true, correlationId: true, idempotencyKey: true },
        })
      );
      return { row: existing, isNew: false };
    }
    throw err;
  }
}

export interface CompleteRequestInput {
  companyId: string;
  logId: string;
  status: 'SUCCESS' | 'FAILED';
  httpStatus?: number;
  providerReferenceId?: string;
  errorCategory?: GstIntegrationErrorCategory;
  errorCode?: string;
  /** Already-safe/normalized message only — never a raw stack trace or raw provider body (brief §14/§15). */
  errorMessage?: string;
}

export async function completeRequest(input: CompleteRequestInput): Promise<void> {
  await tenantQuery(input.companyId, (tx) =>
    tx.gstIntegrationRequestLog.update({
      where: { id: input.logId },
      data: {
        status: input.status,
        completedAt: new Date(),
        httpStatus: input.httpStatus,
        providerReferenceId: input.providerReferenceId,
        errorCategory: input.errorCategory,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
      },
    })
  );
}

export async function listRequestLogs(companyId: string, configId: string, limit = 50) {
  return tenantQuery(companyId, (tx) =>
    tx.gstIntegrationRequestLog.findMany({
      where: { companyId, configId },
      orderBy: { createdAt: 'desc' },
      take: Math.min(limit, 200),
    })
  );
}
