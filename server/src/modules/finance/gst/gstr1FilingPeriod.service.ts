// G2g-6e — GSTR-1 Filing / Period Lifecycle Boundary. Builds on the frozen G2g-6a schema
// (GstReturnPeriod/GstFilingSnapshot/GstFilingAttempt) and the frozen G2g-6b/6c/6d services
// (gstr1FilingSnapshot.service.ts / gstr1FilingAttempt.service.ts / gstr1FilingProtection.ts) —
// reclassifies NOTHING, computes NO GST figures, and does not modify any of those three files'
// own logic. This file adds exactly two controlled, one-way transitions on GstReturnPeriod:
//
//   FILING_ATTEMPTED -> FILED    (fileGstr1ReturnPeriod, from one specific ACCEPTED attempt)
//   FILED            -> LOCKED   (lockGstr1ReturnPeriod)
//
// Converts G2g-6d's temporary interpretation ("an ACCEPTED GstFilingAttempt alone IS the filing
// boundary") into the authoritative one: a document is protected once its return period's own
// status is FILED/LOCKED and its filedSnapshotId's traceability names the document — see
// gstr1FilingProtection.ts's own header for the corresponding guard-side change.
//
// Explicitly OUT of scope here (brief's hard scope boundary): GSTN/GSP/ASP API integration, actual
// external filing, ARN generation (an attempt's own `arn`, if any, is carried over verbatim — never
// generated here), GSTR-3B/GSTR-1A/reconciliation/IRP/E-Way Bill/a GST control centre, a generic
// company-wide lock, a generic unlock/override endpoint, or `gst:period_lock_override` (not
// introduced — the unlock/override decision has not been approved for v1, same posture as G2g-6a's
// own permission-catalog comment).

import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error';
import { createAuditEntry } from '../../../middleware/audit';
import { tenantTransaction, tenantQuery, type TenantContext } from '../../../shared/tenantContext';

// ─────────────────────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1FileReturnPeriodParams {
  attemptId: string;
}

export interface Gstr1LockReturnPeriodParams {
  periodId: string;
}

export interface Gstr1ReturnPeriodResult {
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
};

function toResult(row: PeriodRow): Gstr1ReturnPeriodResult {
  return {
    id: row.id,
    gstRegistrationId: row.gstRegistrationId,
    returnType: row.returnType,
    financialYear: row.financialYear,
    taxPeriod: row.taxPeriod,
    status: row.status,
    filedAt: row.filedAt,
    filedSnapshotId: row.filedSnapshotId,
    filedByAttemptId: row.filedByAttemptId,
    filedById: row.filedById,
    arn: row.arn,
    lockedAt: row.lockedAt,
    lockedById: row.lockedById,
  };
}

const TERMINAL_PERIOD_STATUSES = new Set(['FILED', 'LOCKED']);
const INELIGIBLE_SNAPSHOT_STATUSES = new Set(['BLOCKED', 'SUPERSEDED']);

/**
 * Establishes the authoritative FILED boundary for one GstReturnPeriod, from exactly one existing
 * ACCEPTED GstFilingAttempt — never from a caller-supplied companyId/returnPeriodId/snapshotId
 * (brief §18/§4): every identity fact is resolved and re-validated server-side starting from the
 * attempt alone.
 *
 * Validates, in order: attemptId required; the attempt belongs to this company (404, not 403/400 —
 * same "don't confirm a cross-company id exists" convention as every sibling resolver in this
 * module); the attempt's own status is ACCEPTED (not ATTEMPTED/REJECTED/SUPERSEDED — brief §7); and,
 * under a row lock on the attempt's own return period (closing the TOCTOU window between this
 * unlocked pre-check and the transaction below, and serializing against a concurrent
 * fileGstr1ReturnPeriod/lockGstr1ReturnPeriod call on the SAME period — brief §8), that: the period
 * is not already FILED/LOCKED (brief §11); the attempt (re-read fresh) is still ACCEPTED and still
 * belongs to this exact period; and the attempt's referenced snapshot (re-read fresh) is not
 * BLOCKED/SUPERSEDED (brief §6) and carries a valid serialized payload.
 *
 * This same row lock is what closes the G2g-6d-documented concurrency gap (brief §8): the mutation
 * guard (gstr1FilingProtection.ts) now takes the identical lock, on the identical row, inside the
 * mutating transaction, before reading protection state — so a concurrent FILED transition and a
 * concurrent document mutation can never interleave into "mutated after the boundary was
 * established." See that file's own header for the guard-side half of this.
 */
export async function fileGstr1ReturnPeriod(
  ctx: TenantContext,
  params: Gstr1FileReturnPeriodParams,
  userId: string,
): Promise<Gstr1ReturnPeriodResult> {
  const { attemptId } = params;
  if (typeof attemptId !== 'string' || !attemptId) throw new AppError('attemptId is required', 400);

  // Unlocked pre-check — cheap 404/409 short-circuit before opening a transaction; everything it
  // reads is re-validated fresh under the lock below (section 4: "still perform that transition
  // through one controlled service/transaction rather than relying on status inspection alone").
  const attempt = await tenantQuery(ctx.companyId, (tx) => tx.gstFilingAttempt.findUnique({ where: { id: attemptId } }));
  if (!attempt || attempt.companyId !== ctx.companyId) {
    throw new AppError('Filing attempt not found', 404);
  }
  if (attempt.status !== 'ACCEPTED') {
    throw new AppError(
      `Cannot establish the FILED boundary: filing attempt #${attempt.attemptNumber} is ${attempt.status}, not ACCEPTED.`,
      409,
    );
  }

  const { updated, snapshotId, registration } = await tenantTransaction(ctx.companyId, async (tx) => {
    // Row lock on the return period — the exact "SELECT ... FOR UPDATE then re-read fresh" pattern
    // gstr1FilingSnapshot.service.ts / gstr1FilingAttempt.service.ts already use for version/
    // attemptNumber allocation, reused here as the filing-boundary serialization point (brief §8).
    await tx.$queryRaw`SELECT "id" FROM "gst_return_periods" WHERE "id" = ${attempt.returnPeriodId} FOR UPDATE`;
    const period = await tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: attempt.returnPeriodId } });
    if (period.companyId !== ctx.companyId) {
      // Structurally unreachable given the composite FK (attempt.returnPeriodId, companyId) ->
      // gst_return_periods(id, companyId) — defensive, never trusted on the strength of the FK alone.
      throw new AppError('Filing attempt not found', 404);
    }
    if (TERMINAL_PERIOD_STATUSES.has(period.status)) {
      throw new AppError(
        `Cannot establish FILED: return period ${period.financialYear}/${period.taxPeriod} is already ${period.status}.`,
        409,
      );
    }

    // Re-read the attempt fresh under the lock — a concurrent recordGstr1FilingAttemptOutcome could
    // have changed its status in the race window between the unlocked check above and here.
    const freshAttempt = await tx.gstFilingAttempt.findUniqueOrThrow({ where: { id: attemptId } });
    if (freshAttempt.status !== 'ACCEPTED') {
      throw new AppError(
        `Cannot establish the FILED boundary: filing attempt #${freshAttempt.attemptNumber} is ${freshAttempt.status}, not ACCEPTED.`,
        409,
      );
    }
    if (freshAttempt.returnPeriodId !== period.id) {
      // Structurally unreachable (an attempt's returnPeriodId is immutable post-creation) — defensive.
      throw new AppError('Filing attempt does not belong to this return period', 409);
    }

    // Re-read the snapshot fresh under the same lock — a concurrent snapshot creation on this period
    // could have superseded it since the attempt was created (brief §6: BLOCKED/SUPERSEDED can never
    // establish FILED, even via an already-ACCEPTED attempt that pointed at it before it changed).
    const snapshot = await tx.gstFilingSnapshot.findUnique({ where: { id: freshAttempt.snapshotId } });
    if (!snapshot || snapshot.companyId !== ctx.companyId || snapshot.returnPeriodId !== period.id) {
      // Structurally unreachable given createGstr1FilingAttempt's own ownership checks at attempt
      // creation time and the composite FKs pinning both rows to this company — defensive.
      throw new AppError('Filing snapshot not found for this return period', 404);
    }
    if (INELIGIBLE_SNAPSHOT_STATUSES.has(snapshot.status)) {
      throw new AppError(`Cannot establish FILED: the accepted attempt's snapshot is now ${snapshot.status}.`, 409);
    }
    if (!snapshot.wireJsonHash || !snapshot.canonicalDtoHash) {
      // Structurally unreachable (both are NOT NULL columns, always populated by the snapshot
      // builder before persistence) — defensive, matches brief §6's "valid wireJsonHash"/
      // "valid canonicalDtoHash" eligibility checks literally rather than assuming the schema alone
      // guarantees the business invariant forever.
      throw new AppError('Cannot establish FILED: the snapshot has no valid serialized payload.', 400);
    }

    const registration = await tx.companyGstRegistration.findUnique({
      where: { id: period.gstRegistrationId },
      select: { gstin: true },
    });

    let updatedPeriod;
    try {
      updatedPeriod = await tx.gstReturnPeriod.update({
        where: { id: period.id },
        data: {
          status: 'FILED',
          filedAt: new Date(),
          // The filed snapshot is persisted EXACTLY as-is (brief §5) — never copied, recalculated,
          // or re-hashed here. filedSnapshotId may already equal this id from an earlier aborted
          // attempt at the same transition; re-asserting it is idempotent, not a mutation of
          // "which" snapshot was filed.
          filedSnapshotId: snapshot.id,
          filedByAttemptId: freshAttempt.id,
          filedById: userId,
          // An attempt's own externally-supplied ARN (G2g-6c, recorded verbatim, never generated) is
          // carried onto the period if the period doesn't already have one — never overwritten once set.
          arn: period.arn ?? freshAttempt.arn ?? null,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        // The row lock above makes this unreachable in practice for this specific update (a plain
        // status/pointer UPDATE on an already-locked row, no unique constraint in play) — kept as
        // the documented final safety net (brief §40: never leak a raw Prisma error), same posture
        // as every sibling G2g-6b/6c catch block.
        throw new AppError('Could not establish the FILED boundary due to a concurrent update — please retry.', 409);
      }
      throw err;
    }

    return { updated: updatedPeriod, snapshotId: snapshot.id, registration };
  });

  // Compact lifecycle audit event (brief §16) — never the full DTO/wire JSON/payload, just the
  // identifying facts.
  await createAuditEntry(
    'gst_return_periods', updated.id, userId, 'GSTR1_PERIOD_FILED',
    undefined,
    {
      gstRegistrationId: updated.gstRegistrationId, gstin: registration?.gstin ?? null,
      financialYear: updated.financialYear, taxPeriod: updated.taxPeriod,
      snapshotId, attemptId,
    },
    ctx.companyId,
  );

  return toResult(updated);
}

/**
 * Transitions a FILED return period to LOCKED — permanent for this architecture (brief §13: no
 * replacement snapshot, no new filing attempt, no modification of the filed snapshot, no
 * re-selection of the filed snapshot, no generic period edits, no unlock API; `gst:period_lock_override`
 * is deliberately not introduced).
 *
 * `periodId` is taken directly (not resolved from a natural statutory key) because, unlike the
 * filing-attempt endpoints, there is no risk here of a caller supplying an id belonging to a
 * *different* identity chain to forge eligibility — ownership is checked directly, and the only
 * eligibility rule (period.status === 'FILED') is read off the SAME row being locked, under the SAME
 * lock a concurrent fileGstr1ReturnPeriod/lockGstr1ReturnPeriod call on this exact row would also
 * take (brief §8, same serialization point as fileGstr1ReturnPeriod above).
 */
export async function lockGstr1ReturnPeriod(
  ctx: TenantContext,
  params: Gstr1LockReturnPeriodParams,
  userId: string,
): Promise<Gstr1ReturnPeriodResult> {
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
      // Structurally unreachable — the FILED transition above always sets filedSnapshotId in the
      // same update — defensive.
      throw new AppError('Cannot lock: return period has no filed snapshot.', 409);
    }

    try {
      return await tx.gstReturnPeriod.update({
        where: { id: period.id },
        data: { status: 'LOCKED', lockedAt: new Date(), lockedById: userId },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        throw new AppError('Could not lock the return period due to a concurrent update — please retry.', 409);
      }
      throw err;
    }
  });

  await createAuditEntry(
    'gst_return_periods', updated.id, userId, 'GSTR1_PERIOD_LOCKED',
    undefined,
    {
      gstRegistrationId: updated.gstRegistrationId, financialYear: updated.financialYear,
      taxPeriod: updated.taxPeriod, filedSnapshotId: updated.filedSnapshotId, filedByAttemptId: updated.filedByAttemptId,
    },
    ctx.companyId,
  );

  return toResult(updated);
}
