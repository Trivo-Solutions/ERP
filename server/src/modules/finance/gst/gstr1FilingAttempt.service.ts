// G2g-6c — GSTR-1 Filing Attempt Persistence & History. Builds ONLY on top of the frozen G2g-6a
// schema (GstReturnPeriod/GstFilingSnapshot/GstFilingAttempt) and the frozen G2g-6b snapshot
// builder (gstr1FilingSnapshot.service.ts) — reclassifies NOTHING, reports NOTHING, computes NO
// GST figures. A filing attempt is an event/history record referencing exactly one immutable
// snapshot; it is never a mutable replacement for that snapshot, and a later attempt never
// modifies an earlier one (see this file's own update path — it only ever touches the ONE row
// `recordGstr1FilingAttemptOutcome` was called for).
//
// Explicitly OUT of scope here (see CLAUDE.md's G2g-6c entry / the approved brief's hard scope
// boundary): GSTN/GSP/ASP API integration, ARN generation, actual filing, FILED/LOCKED transition
// on GstReturnPeriod, period locking/mutation guards. `ACCEPTED` in this phase means only "the
// system recorded an accepted outcome" — it never writes GstReturnPeriod.status, never mutates the
// snapshot, and never fabricates an ARN; an `arn`/`externalReference` is only ever recorded if the
// caller supplies one, as external data, never generated.
//
// No schema change was made for this phase. The brief asked for an "outcome timestamp" / "actor"
// per outcome only "where already supported by the model" — deliberately NOT by adding a new
// column: `filedAt`/`arn` already exist and are semantically exact for ACCEPTED (nothing else in
// this model name-pairs with "filed"); REJECTED/SUPERSEDED have no analogous persisted moment
// because nothing was filed. The authoritative timestamp+actor for EVERY transition (ATTEMPTED
// creation, ACCEPTED, REJECTED, SUPERSEDED) is the immutable AuditLog entry this file writes for
// each one — which is the complete-audit-trail guarantee the brief itself asks for (section 2),
// not a gap. See the end of this file for the full field-by-field note.

import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error';
import { createAuditEntry } from '../../../middleware/audit';
import { tenantTransaction, tenantQuery, type TenantContext } from '../../../shared/tenantContext';

const GSTR1_RETURN_TYPE = 'GSTR1';

// TRIVO does not file GSTR-1 through GSTN today — GSP/ASP/API remain future architecture only
// (matches GstFilingAttempt.mode's own schema comment). Validated here so an attempt row can never
// carry an arbitrary free-text mode.
const VALID_MODES = ['MANUAL_EXPORT', 'MANUAL_UPLOAD', 'GSP', 'ASP', 'API'] as const;
type AttemptMode = (typeof VALID_MODES)[number];

const VALID_OUTCOMES = ['ACCEPTED', 'REJECTED', 'SUPERSEDED'] as const;
type AttemptOutcome = (typeof VALID_OUTCOMES)[number];

// A FILED/LOCKED period's filing history is closed — no new attempt may be recorded against it in
// this phase (no unlock/override exists yet, same posture as the snapshot builder's identical
// check). A snapshot that is BLOCKED (failed filing-grade validation) or SUPERSEDED (replaced by a
// later snapshot for the same period) is never eligible to be attempted — section 6/5 of the brief.
const TERMINAL_PERIOD_STATUSES = new Set(['FILED', 'LOCKED']);
const INELIGIBLE_SNAPSHOT_STATUSES = new Set(['BLOCKED', 'SUPERSEDED']);

const AUDIT_ACTION_FOR_OUTCOME: Record<AttemptOutcome, string> = {
  ACCEPTED: 'GSTR1_FILING_ATTEMPT_ACCEPTED',
  REJECTED: 'GSTR1_FILING_ATTEMPT_REJECTED',
  SUPERSEDED: 'GSTR1_FILING_ATTEMPT_SUPERSEDED',
};

// ─────────────────────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1FilingAttemptCreateParams {
  gstRegistrationId: string;
  financialYear: string;
  taxPeriod: string;
  snapshotId: string;
  mode: string;
}

export interface Gstr1FilingAttemptOutcomeParams {
  attemptId: string;
  outcome: string;
  arn?: string | null;
  externalReference?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  responseMetadata?: Record<string, unknown> | null;
}

export interface Gstr1FilingAttemptListParams {
  gstRegistrationId: string;
  financialYear: string;
  taxPeriod: string;
}

export interface Gstr1FilingAttemptResult {
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
};

function toResult(row: AttemptRow): Gstr1FilingAttemptResult {
  return {
    id: row.id,
    returnPeriodId: row.returnPeriodId,
    snapshotId: row.snapshotId,
    attemptNumber: row.attemptNumber,
    mode: row.mode,
    status: row.status,
    attemptedAt: row.attemptedAt,
    filedAt: row.filedAt,
    arn: row.arn,
    externalReference: row.externalReference,
    payloadHash: row.payloadHash,
    errorCode: row.errorCode,
    errorMessage: row.errorMessage,
  };
}

/**
 * Resolves (and ownership-validates) the GstReturnPeriod a filing attempt targets, strictly from
 * its natural statutory key — companyId + gstRegistrationId + returnType + financialYear +
 * taxPeriod — never from a client-supplied returnPeriodId (no such field exists on either public
 * param type: the "Company A registration + Company B period" attack class is closed by
 * construction, same documented design choice as gstr1FilingSnapshot.service.ts's own resolver).
 */
async function resolveOwnedReturnPeriod(ctx: TenantContext, gstRegistrationId: string, financialYear: string, taxPeriod: string) {
  if (typeof gstRegistrationId !== 'string' || !gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (typeof financialYear !== 'string' || !financialYear) throw new AppError('financialYear is required', 400);
  if (typeof taxPeriod !== 'string' || !taxPeriod) throw new AppError('taxPeriod is required', 400);

  // GST registration ownership — same 404-not-403 convention as assertOwnedByCompany and the rest
  // of this module's siblings (gstr1Export.service.ts, gstr1FilingSnapshot.service.ts).
  const registration = await tenantQuery(ctx.companyId, (tx) =>
    tx.companyGstRegistration.findUnique({
      where: { id: gstRegistrationId },
      select: { id: true, companyId: true, gstin: true },
    }),
  );
  if (!registration || registration.companyId !== ctx.companyId) {
    throw new AppError('GST registration not found', 404);
  }

  const period = await tenantQuery(ctx.companyId, (tx) =>
    tx.gstReturnPeriod.findUnique({
      where: {
        companyId_gstRegistrationId_returnType_financialYear_taxPeriod: {
          companyId: ctx.companyId, gstRegistrationId, returnType: GSTR1_RETURN_TYPE, financialYear, taxPeriod,
        },
      },
    }),
  );

  return { registration, period };
}

/**
 * Creates one ATTEMPTED filing-attempt record referencing exactly one GstFilingSnapshot.
 *
 * Validates, in order: required params; registration ownership; that a GstReturnPeriod already
 * exists for this exact (registration, FY, taxPeriod) — a period is only ever created by
 * `createGstr1FilingSnapshot`, so an attempt can never exist for a period that never had a
 * snapshot; that the referenced snapshot belongs to THIS company AND THIS exact period (closes the
 * "valid snapshot, wrong period/company" attack the brief calls out in section 5 — a snapshot id
 * alone is never trusted); that the snapshot is not BLOCKED/SUPERSEDED (section 6 — the caller must
 * explicitly name an eligible snapshot, nothing is auto-selected); and, under a row lock on the
 * return period (serializing against both concurrent attempt creation AND concurrent snapshot
 * creation/supersession for the same period — same lock this period row already gets in
 * gstr1FilingSnapshot.service.ts), that the period has not become FILED/LOCKED and the snapshot has
 * not been superseded in the race window between the unlocked check above and this transaction.
 *
 * Attempt numbers are 1-based, unique per return period, and allocated the identical way
 * gstr1FilingSnapshot.service.ts allocates `version` — aggregate MAX under the row lock, never
 * `count() + 1` — with the schema's own `@@unique([returnPeriodId, attemptNumber])` as the final
 * safety net (translated to a 409, never a raw P2002, on the vanishingly unlikely chance the lock
 * is somehow bypassed).
 */
export async function createGstr1FilingAttempt(
  ctx: TenantContext,
  params: Gstr1FilingAttemptCreateParams,
  userId: string,
): Promise<Gstr1FilingAttemptResult> {
  const { gstRegistrationId, financialYear, taxPeriod, snapshotId, mode } = params;

  if (typeof snapshotId !== 'string' || !snapshotId) throw new AppError('snapshotId is required', 400);
  if (typeof mode !== 'string' || !VALID_MODES.includes(mode as AttemptMode)) {
    throw new AppError(`mode must be one of: ${VALID_MODES.join(', ')}`, 400);
  }

  const { registration, period } = await resolveOwnedReturnPeriod(ctx, gstRegistrationId, financialYear, taxPeriod);
  if (!period) {
    throw new AppError('Return period not found — create a GSTR-1 filing snapshot for this period first', 404);
  }

  // Snapshot ownership + period match — 404, not 400/403, for the same "don't confirm the row
  // exists somewhere else" reason every other ownership check in this codebase uses.
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
    // Row lock on the return period — see this function's own doc comment above. This is the exact
    // "SELECT ... FOR UPDATE then re-read fresh" pattern gstr1FilingSnapshot.service.ts already
    // uses for the identical reason (version/attemptNumber allocation must never race).
    await tx.$queryRaw`SELECT "id" FROM "gst_return_periods" WHERE "id" = ${period.id} FOR UPDATE`;
    const lockedPeriod = await tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: period.id } });
    if (TERMINAL_PERIOD_STATUSES.has(lockedPeriod.status)) {
      throw new AppError(`Cannot create a filing attempt: return period ${financialYear}/${taxPeriod} is already ${lockedPeriod.status}.`, 409);
    }

    // Re-read the snapshot under the same lock: a concurrent snapshot creation on this period could
    // have superseded it in the race window between the unlocked check above and here.
    const lockedSnapshot = await tx.gstFilingSnapshot.findUniqueOrThrow({ where: { id: snapshotId } });
    if (INELIGIBLE_SNAPSHOT_STATUSES.has(lockedSnapshot.status)) {
      throw new AppError(`Cannot create a filing attempt: snapshot is ${lockedSnapshot.status}`, 409);
    }

    const agg = await tx.gstFilingAttempt.aggregate({ _max: { attemptNumber: true }, where: { returnPeriodId: period.id } });
    const attemptNumber = (agg._max.attemptNumber ?? 0) + 1;

    try {
      return await tx.gstFilingAttempt.create({
        data: {
          companyId: ctx.companyId,
          returnPeriodId: period.id,
          snapshotId: lockedSnapshot.id,
          attemptNumber,
          mode,
          status: 'ATTEMPTED',
          // Evidence of exactly which payload this attempt corresponds to — the snapshot's own
          // wireJsonHash, never recomputed or re-derived here (section 8: snapshot immutability).
          payloadHash: lockedSnapshot.wireJsonHash,
          createdById: userId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // The row lock above should make this unreachable in practice — documented final safety
        // net, same posture as gstr1FilingSnapshot.service.ts's identical catch block.
        throw new AppError('A concurrent filing attempt was created for this return period — please retry.', 409);
      }
      throw err;
    }
  });

  await createAuditEntry(
    'gst_filing_attempts', attempt.id, userId, 'GSTR1_FILING_ATTEMPT_CREATED',
    undefined,
    {
      gstRegistrationId, gstin: registration.gstin, returnPeriodId: attempt.returnPeriodId,
      snapshotId: attempt.snapshotId, attemptNumber: attempt.attemptNumber, mode: attempt.mode,
      financialYear, taxPeriod,
    },
    ctx.companyId,
  );

  return toResult(attempt);
}

/**
 * Records a terminal outcome (ACCEPTED/REJECTED/SUPERSEDED) for one existing filing attempt.
 * Valid transitions are ATTEMPTED -> {ACCEPTED, REJECTED, SUPERSEDED} ONLY — anything else
 * (including re-recording an already-resolved attempt, even with the same outcome) is rejected
 * with 409 so attempt history stays append-only/immutable once resolved (section 16). There is
 * deliberately no generic PATCH/PUT for a GstFilingAttempt anywhere in this codebase; this
 * function is the only controlled transition path.
 *
 * ACCEPTED means only "the system recorded an accepted outcome" (section 9) — it never writes
 * GstReturnPeriod.status, never mutates the snapshot, and never fabricates an ARN; `arn`/
 * `externalReference` are persisted only if the caller supplies them, as external data recorded
 * verbatim, never generated or validated against any external service.
 */
export async function recordGstr1FilingAttemptOutcome(
  ctx: TenantContext,
  params: Gstr1FilingAttemptOutcomeParams,
  userId: string,
): Promise<Gstr1FilingAttemptResult> {
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
      throw new AppError(
        `Cannot record outcome: filing attempt #${attempt.attemptNumber} is already ${attempt.status} (resolved attempts are immutable).`,
        409,
      );
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
    // SUPERSEDED carries no arn/error/response payload of its own — it is purely a lifecycle note
    // that this unresolved attempt is being explicitly abandoned, recorded via this same controlled
    // transition (never an automatic side effect of a later attempt being created — section 2: "a
    // later attempt does not modify an earlier attempt").

    return tx.gstFilingAttempt.update({ where: { id: attemptId }, data });
  });

  await createAuditEntry(
    'gst_filing_attempts', updated.id, userId, AUDIT_ACTION_FOR_OUTCOME[outcome as AttemptOutcome],
    { status: 'ATTEMPTED' },
    {
      status: updated.status, returnPeriodId: updated.returnPeriodId, snapshotId: updated.snapshotId,
      attemptNumber: updated.attemptNumber, arn: updated.arn, externalReference: updated.externalReference,
      errorCode: updated.errorCode, errorMessage: updated.errorMessage,
    },
    ctx.companyId,
  );

  return toResult(updated);
}

/**
 * Lists one return period's filing-attempt history in deterministic attempt-number order. A
 * registration that exists but has no return period yet for this (FY, taxPeriod) — i.e. no
 * snapshot was ever created for it — returns an empty list, not a 404: there is nothing wrong with
 * the request, there is simply no history yet.
 */
export async function listGstr1FilingAttempts(
  ctx: TenantContext,
  params: Gstr1FilingAttemptListParams,
): Promise<Gstr1FilingAttemptResult[]> {
  const { period } = await resolveOwnedReturnPeriod(ctx, params.gstRegistrationId, params.financialYear, params.taxPeriod);
  if (!period) return [];

  const attempts = await tenantQuery(ctx.companyId, (tx) =>
    tx.gstFilingAttempt.findMany({
      where: { companyId: ctx.companyId, returnPeriodId: period.id },
      orderBy: { attemptNumber: 'asc' },
    }),
  );
  return attempts.map(toResult);
}
