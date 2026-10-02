// G2g-7g — GSTR-3B filing-attempt persistence & history. Mirrors the proven G2g-6c architecture
// (gstr1FilingAttempt.service.ts) over the SAME, already-generic `GstFilingAttempt` table — own file
// rather than a modification of the frozen G2g-6c file (same reasoning as
// gstr3bFilingSnapshot.service.ts's own header: the GSTR-1 file is frozen and the only GSTR-1-specific
// thing inside it is the hardcoded `GSTR1_RETURN_TYPE` constant used to resolve a period by its
// natural key, plus its own audit-action names — everything else is already generic). `ACCEPTED`
// means only "the system recorded an accepted outcome" — never writes GstReturnPeriod.status, never
// mutates the snapshot, never fabricates an ARN (identical scope boundary to G2g-6c).

import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error';
import { createAuditEntry } from '../../../middleware/audit';
import { tenantTransaction, tenantQuery, type TenantContext } from '../../../shared/tenantContext';

const GSTR3B_RETURN_TYPE = 'GSTR3B';

const VALID_MODES = ['MANUAL_EXPORT', 'MANUAL_UPLOAD', 'GSP', 'ASP', 'API'] as const;
type AttemptMode = (typeof VALID_MODES)[number];

const VALID_OUTCOMES = ['ACCEPTED', 'REJECTED', 'SUPERSEDED'] as const;
type AttemptOutcome = (typeof VALID_OUTCOMES)[number];

const TERMINAL_PERIOD_STATUSES = new Set(['FILED', 'LOCKED']);
const INELIGIBLE_SNAPSHOT_STATUSES = new Set(['BLOCKED', 'SUPERSEDED']);

const AUDIT_ACTION_FOR_OUTCOME: Record<AttemptOutcome, string> = {
  ACCEPTED: 'GSTR3B_FILING_ATTEMPT_ACCEPTED',
  REJECTED: 'GSTR3B_FILING_ATTEMPT_REJECTED',
  SUPERSEDED: 'GSTR3B_FILING_ATTEMPT_SUPERSEDED',
};

// ─────────────────────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bFilingAttemptCreateParams {
  gstRegistrationId: string;
  financialYear: string;
  taxPeriod: string;
  snapshotId: string;
  mode: string;
}

export interface Gstr3bFilingAttemptOutcomeParams {
  attemptId: string;
  outcome: string;
  arn?: string | null;
  externalReference?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  responseMetadata?: Record<string, unknown> | null;
}

export interface Gstr3bFilingAttemptListParams {
  gstRegistrationId: string;
  financialYear: string;
  taxPeriod: string;
}

export interface Gstr3bFilingAttemptResult {
  id: string;
  returnPeriodId: string;
  snapshotId: string;
  attemptNumber: number;
  mode: string;
  status: string;
  attemptedAt: Date;
  filedAt: Date | null;
  arn: string | null;
  externalReference: string | null;
  payloadHash: string;
  errorCode: string | null;
  errorMessage: string | null;
}

type AttemptRow = {
  id: string; returnPeriodId: string; snapshotId: string; attemptNumber: number; mode: string; status: string;
  attemptedAt: Date; filedAt: Date | null; arn: string | null; externalReference: string | null;
  payloadHash: string; errorCode: string | null; errorMessage: string | null;
};

function toResult(row: AttemptRow): Gstr3bFilingAttemptResult {
  return {
    id: row.id, returnPeriodId: row.returnPeriodId, snapshotId: row.snapshotId, attemptNumber: row.attemptNumber,
    mode: row.mode, status: row.status, attemptedAt: row.attemptedAt, filedAt: row.filedAt, arn: row.arn,
    externalReference: row.externalReference, payloadHash: row.payloadHash, errorCode: row.errorCode, errorMessage: row.errorMessage,
  };
}

/** Resolves (and ownership-validates) the GstReturnPeriod a filing attempt targets, strictly from its
 *  natural statutory key — never from a client-supplied returnPeriodId (same closed attack class as
 *  G2g-6c's identical resolver). */
async function resolveOwnedReturnPeriod(ctx: TenantContext, gstRegistrationId: string, financialYear: string, taxPeriod: string) {
  if (typeof gstRegistrationId !== 'string' || !gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (typeof financialYear !== 'string' || !financialYear) throw new AppError('financialYear is required', 400);
  if (typeof taxPeriod !== 'string' || !taxPeriod) throw new AppError('taxPeriod is required', 400);

  const registration = await tenantQuery(ctx.companyId, (tx) =>
    tx.companyGstRegistration.findUnique({ where: { id: gstRegistrationId }, select: { id: true, companyId: true, gstin: true } }),
  );
  if (!registration || registration.companyId !== ctx.companyId) {
    throw new AppError('GST registration not found', 404);
  }

  const period = await tenantQuery(ctx.companyId, (tx) =>
    tx.gstReturnPeriod.findUnique({
      where: {
        companyId_gstRegistrationId_returnType_financialYear_taxPeriod: {
          companyId: ctx.companyId, gstRegistrationId, returnType: GSTR3B_RETURN_TYPE, financialYear, taxPeriod,
        },
      },
    }),
  );

  return { registration, period };
}

/**
 * Creates one ATTEMPTED filing-attempt record referencing exactly one GstFilingSnapshot. Validates in
 * the identical order G2g-6c's own `createGstr1FilingAttempt` does; attempt numbers are 1-based,
 * allocated under the same row lock, with the schema's own `@@unique([returnPeriodId, attemptNumber])`
 * as the final safety net.
 */
export async function createGstr3bFilingAttempt(
  ctx: TenantContext,
  params: Gstr3bFilingAttemptCreateParams,
  userId: string,
): Promise<Gstr3bFilingAttemptResult> {
  const { gstRegistrationId, financialYear, taxPeriod, snapshotId, mode } = params;

  if (typeof snapshotId !== 'string' || !snapshotId) throw new AppError('snapshotId is required', 400);
  if (typeof mode !== 'string' || !VALID_MODES.includes(mode as AttemptMode)) {
    throw new AppError(`mode must be one of: ${VALID_MODES.join(', ')}`, 400);
  }

  const { registration, period } = await resolveOwnedReturnPeriod(ctx, gstRegistrationId, financialYear, taxPeriod);
  if (!period) {
    throw new AppError('Return period not found — create a GSTR-3B filing snapshot for this period first', 404);
  }

  const snapshot = await tenantQuery(ctx.companyId, (tx) => tx.gstFilingSnapshot.findUnique({ where: { id: snapshotId } }));
  if (!snapshot || snapshot.companyId !== ctx.companyId || snapshot.returnPeriodId !== period.id) {
    throw new AppError('Filing snapshot not found for this return period', 404);
  }
  if (INELIGIBLE_SNAPSHOT_STATUSES.has(snapshot.status)) {
    throw new AppError(`Cannot create a filing attempt: snapshot is ${snapshot.status}`, 409);
  }
  if (TERMINAL_PERIOD_STATUSES.has(period.status)) {
    throw new AppError(`Cannot create a filing attempt: return period ${financialYear}/${taxPeriod} is already ${period.status}.`, 409);
  }

  const attempt = await tenantTransaction(ctx.companyId, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "gst_return_periods" WHERE "id" = ${period.id} FOR UPDATE`;
    const lockedPeriod = await tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: period.id } });
    if (TERMINAL_PERIOD_STATUSES.has(lockedPeriod.status)) {
      throw new AppError(`Cannot create a filing attempt: return period ${financialYear}/${taxPeriod} is already ${lockedPeriod.status}.`, 409);
    }

    const lockedSnapshot = await tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
    if (INELIGIBLE_SNAPSHOT_STATUSES.has(lockedSnapshot.status)) {
      throw new AppError(`Cannot create a filing attempt: snapshot is ${lockedSnapshot.status}`, 409);
    }

    const agg = await tx.gstFilingAttempt.aggregate({ _max: { attemptNumber: true }, where: { returnPeriodId: period.id } });
    const attemptNumber = (agg._max.attemptNumber ?? 0) + 1;

    try {
      return await tx.gstFilingAttempt.create({
        data: {
          companyId: ctx.companyId, returnPeriodId: period.id, snapshotId: lockedSnapshot.id, attemptNumber,
          mode, status: 'ATTEMPTED', payloadHash: lockedSnapshot.wireJsonHash, createdById: userId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new AppError('A concurrent filing attempt was created for this return period — please retry.', 409);
      }
      throw err;
    }
  });

  await createAuditEntry(
    'gst_filing_attempts', attempt.id, userId, 'GSTR3B_FILING_ATTEMPT_CREATED',
    undefined,
    { gstRegistrationId, gstin: registration.gstin, returnPeriodId: attempt.returnPeriodId, snapshotId: attempt.snapshotId, attemptNumber: attempt.attemptNumber, mode: attempt.mode, financialYear, taxPeriod },
    ctx.companyId,
  );

  return toResult(attempt);
}

/**
 * Records a terminal outcome (ACCEPTED/REJECTED/SUPERSEDED) for one existing filing attempt. Valid
 * transitions are ATTEMPTED -> {ACCEPTED, REJECTED, SUPERSEDED} ONLY — identical immutability rule to
 * G2g-6c. `arn`/`externalReference` are persisted only if the caller supplies them, as external data
 * recorded verbatim, never generated.
 */
export async function recordGstr3bFilingAttemptOutcome(
  ctx: TenantContext,
  params: Gstr3bFilingAttemptOutcomeParams,
  userId: string,
): Promise<Gstr3bFilingAttemptResult> {
  const { attemptId, outcome } = params;
  if (typeof attemptId !== 'string' || !attemptId) throw new AppError('attemptId is required', 400);
  if (typeof outcome !== 'string' || !VALID_OUTCOMES.includes(outcome as AttemptOutcome)) {
    throw new AppError(`outcome must be one of: ${VALID_OUTCOMES.join(', ')}`, 400);
  }

  const updated = await tenantTransaction(ctx.companyId, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "gst_filing_attempts" WHERE "id" = ${attemptId} FOR UPDATE`;
    const attempt = await tx.gstFilingAttempt.findUnique({ where: { id: attemptId } });
    if (!attempt || attempt.companyId !== ctx.companyId) {
      throw new AppError('Filing attempt not found', 404);
    }
    if (attempt.status !== 'ATTEMPTED') {
      throw new AppError(`Cannot record outcome: filing attempt #${attempt.attemptNumber} is already ${attempt.status} (resolved attempts are immutable).`, 409);
    }

    const data: Prisma.GstFilingAttemptUpdateInput = { status: outcome };
    if (outcome === 'ACCEPTED') {
      data.filedAt = new Date();
      if (params.arn) data.arn = params.arn;
      if (params.externalReference) data.externalReference = params.externalReference;
      if (params.responseMetadata) data.responseMetadata = params.responseMetadata as Prisma.InputJsonValue;
    } else if (outcome === 'REJECTED') {
      if (params.errorCode) data.errorCode = params.errorCode;
      if (params.errorMessage) data.errorMessage = params.errorMessage;
      if (params.responseMetadata) data.responseMetadata = params.responseMetadata as Prisma.InputJsonValue;
    }

    return tx.gstFilingAttempt.update({ where: { id: attemptId }, data });
  });

  await createAuditEntry(
    'gst_filing_attempts', updated.id, userId, AUDIT_ACTION_FOR_OUTCOME[outcome as AttemptOutcome],
    { status: 'ATTEMPTED' },
    { status: updated.status, returnPeriodId: updated.returnPeriodId, snapshotId: updated.snapshotId, attemptNumber: updated.attemptNumber, arn: updated.arn, externalReference: updated.externalReference, errorCode: updated.errorCode, errorMessage: updated.errorMessage },
    ctx.companyId,
  );

  return toResult(updated);
}

/** Lists one return period's filing-attempt history, deterministic attempt-number order. A
 *  registration with no return period yet returns an empty list, not a 404. */
export async function listGstr3bFilingAttempts(
  ctx: TenantContext,
  params: Gstr3bFilingAttemptListParams,
): Promise<Gstr3bFilingAttemptResult[]> {
  const { period } = await resolveOwnedReturnPeriod(ctx, params.gstRegistrationId, params.financialYear, params.taxPeriod);
  if (!period) return [];

  const attempts = await tenantQuery(ctx.companyId, (tx) =>
    tx.gstFilingAttempt.findMany({ where: { companyId: ctx.companyId, returnPeriodId: period.id }, orderBy: { attemptNumber: 'asc' } }),
  );
  return attempts.map(toResult);
}
