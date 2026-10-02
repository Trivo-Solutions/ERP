// G2g-7g — GSTR-3B period-lifecycle boundary. Mirrors the proven G2g-6e architecture
// (gstr1FilingPeriod.service.ts) over the SAME `GstReturnPeriod` table and the SAME two one-way
// transitions:
//
//   FILING_ATTEMPTED -> FILED    (fileGstr3bReturnPeriod, from one specific ACCEPTED attempt)
//   FILED            -> LOCKED   (lockGstr3bReturnPeriod)
//
// A separate file, not a reuse of the frozen G2g-6e functions directly: although
// `fileGstr1ReturnPeriod`/`lockGstr1ReturnPeriod`'s own transition logic contains no GSTR-1-specific
// business rule at all (it operates purely on an attemptId/periodId it resolves generically), it
// writes hardcoded `'GSTR1_PERIOD_FILED'`/`'GSTR1_PERIOD_LOCKED'` audit actions — calling it for a
// GSTR-3B period would mislabel the audit trail with the wrong return-type name. This file
// reproduces the identical transition/concurrency logic (the same row-lock pattern, the same
// eligibility checks) under its own GSTR-3B-labeled audit actions, never inventing a different state
// machine (brief §14).
//
// GSTN/GSP/ASP API integration, actual external filing, and ARN generation remain explicitly out of
// scope — identical boundary to G2g-6e.

import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error';
import { createAuditEntry } from '../../../middleware/audit';
import { tenantTransaction, tenantQuery, type TenantContext } from '../../../shared/tenantContext';

export interface Gstr3bFileReturnPeriodParams {
  attemptId: string;
}

export interface Gstr3bLockReturnPeriodParams {
  periodId: string;
}

export interface Gstr3bReturnPeriodResult {
  id: string;
  gstRegistrationId: string;
  returnType: string;
  financialYear: string;
  taxPeriod: string;
  status: string;
  filedAt: Date | null;
  filedSnapshotId: string | null;
  filedByAttemptId: string | null;
  filedById: string | null;
  arn: string | null;
  lockedAt: Date | null;
  lockedById: string | null;
}

type PeriodRow = {
  id: string; gstRegistrationId: string; returnType: string; financialYear: string; taxPeriod: string; status: string;
  filedAt: Date | null; filedSnapshotId: string | null; filedByAttemptId: string | null; filedById: string | null;
  arn: string | null; lockedAt: Date | null; lockedById: string | null;
};

function toResult(row: PeriodRow): Gstr3bReturnPeriodResult {
  return {
    id: row.id, gstRegistrationId: row.gstRegistrationId, returnType: row.returnType, financialYear: row.financialYear,
    taxPeriod: row.taxPeriod, status: row.status, filedAt: row.filedAt, filedSnapshotId: row.filedSnapshotId,
    filedByAttemptId: row.filedByAttemptId, filedById: row.filedById, arn: row.arn, lockedAt: row.lockedAt, lockedById: row.lockedById,
  };
}

const TERMINAL_PERIOD_STATUSES = new Set(['FILED', 'LOCKED']);
const INELIGIBLE_SNAPSHOT_STATUSES = new Set(['BLOCKED', 'SUPERSEDED']);

/**
 * Establishes the authoritative FILED boundary for one GstReturnPeriod, from exactly one existing
 * ACCEPTED GstFilingAttempt — never from a caller-supplied companyId/returnPeriodId/snapshotId.
 * Identical validation order and row-lock serialization to G2g-6e's `fileGstr1ReturnPeriod` (see that
 * file's own doc comment for the full rationale, unchanged here): attempt ownership + ACCEPTED status
 * checked unlocked, then re-validated fresh under a row lock on the return period (closing the TOCTOU
 * window and serializing against a concurrent file/lock call on the same period), including the
 * period not already FILED/LOCKED and the referenced snapshot not BLOCKED/SUPERSEDED.
 */
export async function fileGstr3bReturnPeriod(
  ctx: TenantContext,
  params: Gstr3bFileReturnPeriodParams,
  userId: string,
): Promise<Gstr3bReturnPeriodResult> {
  const { attemptId } = params;
  if (typeof attemptId !== 'string' || !attemptId) throw new AppError('attemptId is required', 400);

  const attempt = await tenantQuery(ctx.companyId, (tx) => tx.gstFilingAttempt.findUnique({ where: { id: attemptId } }));
  if (!attempt || attempt.companyId !== ctx.companyId) {
    throw new AppError('Filing attempt not found', 404);
  }
  if (attempt.status !== 'ACCEPTED') {
    throw new AppError(`Cannot establish the FILED boundary: filing attempt #${attempt.attemptNumber} is ${attempt.status}, not ACCEPTED.`, 409);
  }

  const { updated, snapshotId, registration } = await tenantTransaction(ctx.companyId, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "gst_return_periods" WHERE "id" = ${attempt.returnPeriodId} FOR UPDATE`;
    const period = await tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: attempt.returnPeriodId } });
    if (period.companyId !== ctx.companyId) {
      throw new AppError('Filing attempt not found', 404);
    }
    if (TERMINAL_PERIOD_STATUSES.has(period.status)) {
      throw new AppError(`Cannot establish FILED: return period ${period.financialYear}/${period.taxPeriod} is already ${period.status}.`, 409);
    }

    const freshAttempt = await tx.gstFilingAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    if (freshAttempt.status !== 'ACCEPTED') {
      throw new AppError(`Cannot establish the FILED boundary: filing attempt #${freshAttempt.attemptNumber} is ${freshAttempt.status}, not ACCEPTED.`, 409);
    }
    if (freshAttempt.returnPeriodId !== period.id) {
      throw new AppError('Filing attempt does not belong to this return period', 409);
    }

    const snapshot = await tx.gstFilingSnapshot.findUnique({ where: { id: freshAttempt.snapshotId } });
    if (!snapshot || snapshot.companyId !== ctx.companyId || snapshot.returnPeriodId !== period.id) {
      throw new AppError('Filing snapshot not found for this return period', 404);
    }
    if (INELIGIBLE_SNAPSHOT_STATUSES.has(snapshot.status)) {
      throw new AppError(`Cannot establish FILED: the accepted attempt's snapshot is now ${snapshot.status}.`, 409);
    }
    if (!snapshot.wireJsonHash || !snapshot.canonicalDtoHash) {
      throw new AppError('Cannot establish FILED: the snapshot has no valid serialized payload.', 400);
    }

    const registration = await tx.companyGstRegistration.findUnique({ where: { id: period.gstRegistrationId }, select: { gstin: true } });

    let updatedPeriod;
    try {
      updatedPeriod = await tx.gstReturnPeriod.update({
        where: { id: period.id },
        data: {
          status: 'FILED',
          filedAt: new Date(),
          filedSnapshotId: snapshot.id,
          filedByAttemptId: freshAttempt.id,
          filedById: userId,
          arn: period.arn ?? freshAttempt.arn ?? null,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        throw new AppError('Could not establish the FILED boundary due to a concurrent update — please retry.', 409);
      }
      throw err;
    }

    return { updated: updatedPeriod, snapshotId: snapshot.id, registration };
  });

  await createAuditEntry(
    'gst_return_periods', updated.id, userId, 'GSTR3B_PERIOD_FILED',
    undefined,
    { gstRegistrationId: updated.gstRegistrationId, gstin: registration?.gstin ?? null, financialYear: updated.financialYear, taxPeriod: updated.taxPeriod, snapshotId, attemptId },
    ctx.companyId,
  );

  return toResult(updated);
}

/**
 * Transitions a FILED return period to LOCKED — permanent for this architecture. No replacement
 * snapshot, no new filing attempt, no modification of the filed snapshot, no re-selection of the
 * filed snapshot, no generic period edits, no unlock API (identical boundary to G2g-6e).
 */
export async function lockGstr3bReturnPeriod(
  ctx: TenantContext,
  params: Gstr3bLockReturnPeriodParams,
  userId: string,
): Promise<Gstr3bReturnPeriodResult> {
  const { periodId } = params;
  if (typeof periodId !== 'string' || !periodId) throw new AppError('periodId is required', 400);

  const updated = await tenantTransaction(ctx.companyId, async (tx) => {
    await tx.$queryRaw`SELECT "id" FROM "gst_return_periods" WHERE "id" = ${periodId} FOR UPDATE`;
    const period = await tx.gstReturnPeriod.findUnique({ where: { id: periodId } });
    if (!period || period.companyId !== ctx.companyId) {
      throw new AppError('Return period not found', 404);
    }
    if (period.status === 'LOCKED') {
      throw new AppError(`Return period ${period.financialYear}/${period.taxPeriod} is already LOCKED.`, 409);
    }
    if (period.status !== 'FILED') {
      throw new AppError(`Cannot lock: return period ${period.financialYear}/${period.taxPeriod} is ${period.status}, not FILED.`, 409);
    }
    if (!period.filedSnapshotId) {
      throw new AppError('Cannot lock: return period has no filed snapshot.', 409);
    }

    try {
      return await tx.gstReturnPeriod.update({ where: { id: period.id }, data: { status: 'LOCKED', lockedAt: new Date(), lockedById: userId } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        throw new AppError('Could not lock the return period due to a concurrent update — please retry.', 409);
      }
      throw err;
    }
  });

  await createAuditEntry(
    'gst_return_periods', updated.id, userId, 'GSTR3B_PERIOD_LOCKED',
    undefined,
    { gstRegistrationId: updated.gstRegistrationId, financialYear: updated.financialYear, taxPeriod: updated.taxPeriod, filedSnapshotId: updated.filedSnapshotId, filedByAttemptId: updated.filedByAttemptId },
    ctx.companyId,
  );

  return toResult(updated);
}
