// G2g-6b — GSTR-1 Filing Snapshot Builder. An EVIDENCE/PERSISTENCE layer only — it reclassifies
// NOTHING the frozen GSTR-1 pipeline already owns (no B2B/B2CL/B2CS classification, no Table 12/13
// aggregation, no GST calculation — see gstr1GstnAdapter.ts's own header for the complete list).
// It orchestrates the already-frozen pieces exactly once each:
//
//   report inputs -> buildGstr1GstnExportCore() [frozen report loading + adapter + validator,
//                     reused unchanged from gstr1Export.service.ts, run ONCE]
//     -> canonical DTO -> canonicalizeForHash() -> SHA-256 (canonicalDtoHash)
//     -> serializeGstr1ToGstnJson() [frozen serializer, G2g-4c-3] -> wire JSON -> SHA-256 (wireJsonHash)
//     -> GstFilingSnapshot (version allocated under a row lock on its GstReturnPeriod — never
//        count()+1; the schema's own UNIQUE(returnPeriodId, version) remains the final safety net)
//
// Snapshot creation is explicitly NOT a filing action (G2g-6a/6b scope boundary — see CLAUDE.md):
// it never writes a GstFilingAttempt row, never records an ARN, and only ever moves
// GstReturnPeriod.status OPEN -> SNAPSHOT_CREATED. FILED/LOCKED are read (to refuse a replacement
// snapshot) but never written here — that remains G2g-6c's job.

import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error';
import { createAuditEntry } from '../../../middleware/audit';
import { tenantTransaction, type TenantContext } from '../../../shared/tenantContext';
import { getFinancialYearForDate } from '../../../shared/financialYear';
import { buildGstr1GstnExportCore, type Gstr1ExportParams } from './gstr1Export.service';
import { serializeGstr1ToGstnJson, Gstr1GstnSerializationError } from './gstr1GstnSerializer';
import type { Gstr1GstnValidationResult } from './gstr1GstnValidator';
import { canonicalizeForHash, canonicalJsonString, sha256Hex } from './gstr1SnapshotHash';

const GSTR1_RETURN_TYPE = 'GSTR1';

/** This phase's own adapter/serializer identity — NOT a reimplementation of either, and not an
 *  invented version scheme. Matches the phase tags gstr1GstnAdapter.ts (G2g-4c-1) and
 *  gstr1GstnSerializer.ts (G2g-4c-3) were themselves built and frozen under, per the brief's
 *  section 17 ("create minimal explicit constants rather than 'unknown'"). Bump only if either
 *  frozen file's own OUTPUT SHAPE changes in a future phase — never for an unrelated change. */
const GSTR1_GSTN_ADAPTER_VERSION = 'g2g-4c-1';
const GSTR1_GSTN_SERIALIZER_VERSION = 'g2g-4c-3';

const TERMINAL_PERIOD_STATUSES = new Set(['FILED', 'LOCKED']);
const SUPERSEDABLE_SNAPSHOT_STATUSES = ['DRAFT', 'BLOCKED'];

// ─────────────────────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1FilingSnapshotParams {
  gstRegistrationId: string;
  from: string;
  to: string;
  branchId?: string | null;
}

export interface Gstr1FilingSnapshotResult {
  id: string;
  returnPeriodId: string;
  version: number;
  status: string;
  canonicalDtoHash: string;
  wireJsonHash: string;
  serializerVersion: string;
  adapterVersion: string;
  gstnSchemaVersion: string;
  isValid: boolean;
  blockers: Gstr1GstnValidationResult['blockers'];
  warnings: Gstr1GstnValidationResult['warnings'];
}

type Gstr1FilingBranchScope =
  | { scope: 'REGISTRATION' }
  | { scope: 'BRANCH'; branchId: string | null; restrictedBranchIds?: string[] };

/** Mirrors buildGstr1GstnExportCore's own `isPartialBranchExport` fact (an explicit branchId, or a
 *  branch-restricted caller) into the shape CLAUDE.md section 19 asks to persist. Never invents a
 *  branch scope the caller didn't actually have. */
function resolveBranchScope(ctx: TenantContext, branchId: string | null | undefined): Gstr1FilingBranchScope {
  if (branchId) return { scope: 'BRANCH', branchId };
  if (ctx.branchAccess.allBranches) return { scope: 'REGISTRATION' };
  return { scope: 'BRANCH', branchId: null, restrictedBranchIds: ctx.branchAccess.branchIds };
}

/**
 * Builds and persists ONE immutable GSTR-1 filing snapshot for exactly one GST registration +
 * period (+ optional branch scope). Runs the frozen report/adapter/validator pipeline exactly once
 * (`buildGstr1GstnExportCore`), then ALWAYS attempts the frozen serializer regardless of validator
 * blockers — the serializer's own checks are a narrower, structural-only gate, distinct from the
 * validator's broader filing-readiness rules (see gstr1GstnSerializer.ts's own header) — so a
 * snapshot can exist as historical/diagnostic evidence even for a not-yet-filing-ready period.
 *
 * Persists `status: 'BLOCKED'` (never `'DRAFT'`) whenever the validator reported blockers, so a
 * blocked snapshot can never be mistaken for a filing-ready one by its status alone; the complete
 * `validationResult` (blockers AND warnings) is always stored either way — nothing is ever silently
 * discarded. If the frozen serializer itself throws (a genuine structural failure the narrower
 * serializer-safety checks catch, e.g. a missing GSTIN or an item-sequence collision) there is
 * nothing valid to put in the NOT NULL `wireJson` column, so no snapshot is persisted in that case —
 * the caller gets a 400 with the serializer's own error, the same posture
 * `buildGstr1GstnExport`'s existing FAILED-audit path already uses for an identical failure.
 *
 * Throws a 409 `AppError` without persisting anything if the resolved `GstReturnPeriod` is already
 * `FILED`/`LOCKED` — a filed/locked period's snapshot is historical evidence and is never replaced
 * (CLAUDE.md section 24: no override, no unlock mechanism in this phase).
 */
export async function createGstr1FilingSnapshot(
  ctx: TenantContext,
  params: Gstr1FilingSnapshotParams,
  userId: string,
): Promise<Gstr1FilingSnapshotResult> {
  // One consistent timestamp for the whole snapshot (section 20) — captured before any report query runs.
  const sourceDataCutoff = new Date();

  const exportParams: Gstr1ExportParams = {
    gstRegistrationId: params.gstRegistrationId, from: params.from, to: params.to, branchId: params.branchId,
  };

  // Frozen pipeline (registration ownership, branch access, AATO, the five report loaders, the
  // frozen adapter, the frozen validator) — run EXACTLY ONCE. No business logic is reimplemented
  // here; see this file's own header.
  const core = await buildGstr1GstnExportCore(ctx, exportParams);
  const { registration, dto, validation, isPartialBranchExport, from, to } = core;

  const canonicalDto = canonicalizeForHash(dto);
  const canonicalDtoHash = sha256Hex(canonicalJsonString(dto));

  let wire: ReturnType<typeof serializeGstr1ToGstnJson>;
  try {
    wire = serializeGstr1ToGstnJson(dto);
  } catch (err) {
    if (err instanceof Gstr1GstnSerializationError) {
      await createAuditEntry(
        'company_gst_registrations', params.gstRegistrationId, userId, 'GST_FILING_SNAPSHOT_FAILED',
        undefined,
        {
          gstRegistrationId: params.gstRegistrationId, gstin: registration.gstin,
          serializationErrorCode: err.code, serializationErrorMessage: err.message,
        },
        ctx.companyId,
      );
      throw new AppError(`GSTR-1 filing snapshot could not be serialized: ${err.message}`, 400);
    }
    throw err;
  }
  // Hashed from the exact in-memory bytes the GSTN export route itself would send
  // (`res.send(JSON.stringify(result.wire))` in finance.router.ts) — never re-derived from a
  // post-storage re-read of the persisted `wireJson` jsonb column, whose own key order Postgres does
  // not guarantee to preserve (see this file's companion test suite for the full rationale).
  const wireJsonHash = sha256Hex(JSON.stringify(wire));

  const financialYear = getFinancialYearForDate(to);
  const taxPeriod = dto.metadata.period.filingPeriodMmYYYY;
  if (!taxPeriod) {
    // Structurally unreachable given buildGstr1GstnExportCore's own construction (it always resolves
    // this before calling the adapter) — defensive, never silently falls back to a guessed period.
    throw new AppError('GSTR-1 filing snapshot could not be created: no filing period could be resolved.', 400);
  }

  const branchScope = resolveBranchScope(ctx, params.branchId);
  const reportParams = {
    gstRegistrationId: params.gstRegistrationId,
    from: params.from,
    to: params.to,
    branchId: params.branchId ?? null,
    returnType: GSTR1_RETURN_TYPE,
    financialYear,
    taxPeriod,
  };

  const status = validation.isValid ? 'DRAFT' : 'BLOCKED';

  const periodKey = {
    companyId_gstRegistrationId_returnType_financialYear_taxPeriod: {
      companyId: ctx.companyId, gstRegistrationId: params.gstRegistrationId,
      returnType: GSTR1_RETURN_TYPE, financialYear, taxPeriod,
    },
  };

  const snapshot = await tenantTransaction(ctx.companyId, async (tx) => {
    // Resolve-or-create the OPEN return period by its natural statutory key, via a genuinely atomic
    // `INSERT ... ON CONFLICT DO UPDATE ... RETURNING *` (Postgres's own native upsert). The `update`
    // clause is NOT left empty on purpose: an empty `update: {}` gives Prisma nothing to put in a SQL
    // SET list, so it silently falls back to `ON CONFLICT DO NOTHING` — which returns ZERO rows on a
    // real conflict, and Prisma then surfaces that as a raw P2002 instead of the existing row
    // (reproduced directly while building this function: two concurrent callers both hit the INSERT
    // branch and one got a hard unique-constraint error rather than being handed the winner's row,
    // and — because Postgres aborts the whole transaction on any statement error — a catch-and-
    // re-read inside the SAME transaction doesn't work either, every later statement in that
    // transaction also fails with "current transaction is aborted"). Touching `updatedAt` is a
    // real, idempotent field to put in the UPDATE SET list, which makes Prisma emit the true atomic
    // ON CONFLICT DO UPDATE form and guarantees exactly one row is always returned.
    const period = await tx.gstReturnPeriod.upsert({
      where: periodKey,
      create: {
        companyId: ctx.companyId, gstRegistrationId: params.gstRegistrationId,
        returnType: GSTR1_RETURN_TYPE, financialYear, taxPeriod, status: 'OPEN',
      },
      update: { updatedAt: new Date() },
    });

    // Row lock on the return period — serializes concurrent snapshot creation for the SAME period so
    // version allocation below never races (never count()+1 — see this file's own header). Same
    // "SELECT ... FOR UPDATE then re-read fresh" pattern this codebase already uses for invoice/
    // credit-note/debit-note concurrency (sales.service.ts, creditNote.service.ts, ...).
    await tx.$queryRaw`SELECT "id" FROM "gst_return_periods" WHERE "id" = ${period.id} FOR UPDATE`;
    const lockedPeriod = await tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: period.id } });

    if (TERMINAL_PERIOD_STATUSES.has(lockedPeriod.status)) {
      throw new AppError(
        `Cannot create a new GSTR-1 filing snapshot: return period ${financialYear}/${taxPeriod} is already ${lockedPeriod.status}.`,
        409,
      );
    }

    const agg = await tx.gstFilingSnapshot.aggregate({
      _max: { version: true },
      where: { returnPeriodId: period.id },
    });
    const version = (agg._max.version ?? 0) + 1;

    let created;
    try {
      created = await tx.gstFilingSnapshot.create({
        data: {
          companyId: ctx.companyId,
          returnPeriodId: period.id,
          version,
          canonicalDtoJson: canonicalDto as Prisma.InputJsonValue,
          wireJson: wire as unknown as Prisma.InputJsonValue,
          canonicalDtoHash,
          wireJsonHash,
          serializerVersion: GSTR1_GSTN_SERIALIZER_VERSION,
          adapterVersion: GSTR1_GSTN_ADAPTER_VERSION,
          gstnSchemaVersion: dto.metadata.schemaVersion,
          periodFrom: from,
          periodTo: to,
          branchScope: branchScope as unknown as Prisma.InputJsonValue,
          validationResult: validation as unknown as Prisma.InputJsonValue,
          status,
          sourceDataCutoff,
          reportParams: reportParams as unknown as Prisma.InputJsonValue,
          createdById: userId,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        // The row lock above should make this unreachable in practice — kept as the documented,
        // final safety net (brief section 9) rather than ever surfacing a raw Prisma error.
        throw new AppError('A concurrent snapshot was created for this return period — please retry.', 409);
      }
      throw err;
    }

    // Supersede this period's own prior still-open (DRAFT/BLOCKED) snapshots — never a FILED one
    // (section 23/24: "do not mark a FILED snapshot as superseded").
    await tx.gstFilingSnapshot.updateMany({
      where: { returnPeriodId: period.id, id: { not: created.id }, status: { in: SUPERSEDABLE_SNAPSHOT_STATUSES } },
      data: { status: 'SUPERSEDED' },
    });

    if (lockedPeriod.status === 'OPEN') {
      await tx.gstReturnPeriod.update({ where: { id: period.id }, data: { status: 'SNAPSHOT_CREATED' } });
    }

    return created;
  });

  // Snapshot creation is its own, distinct fact from the underlying export-pipeline run (which,
  // since this calls buildGstr1GstnExportCore rather than buildGstr1GstnExport, emits NO
  // GSTR1_GSTN_EXPORT* audit entry of its own) — never confused with a filing attempt (section 29).
  await createAuditEntry(
    'gst_filing_snapshots', snapshot.id, userId, 'GST_FILING_SNAPSHOT_CREATED',
    undefined,
    {
      gstRegistrationId: params.gstRegistrationId, gstin: registration.gstin,
      returnPeriodId: snapshot.returnPeriodId, version: snapshot.version, status: snapshot.status,
      financialYear, taxPeriod, isPartialBranchExport,
      blockerCount: validation.blockers.length, warningCount: validation.warnings.length,
    },
    ctx.companyId,
  );

  return {
    id: snapshot.id,
    returnPeriodId: snapshot.returnPeriodId,
    version: snapshot.version,
    status: snapshot.status,
    canonicalDtoHash: snapshot.canonicalDtoHash,
    wireJsonHash: snapshot.wireJsonHash,
    serializerVersion: snapshot.serializerVersion,
    adapterVersion: snapshot.adapterVersion,
    gstnSchemaVersion: snapshot.gstnSchemaVersion,
    isValid: validation.isValid,
    blockers: validation.blockers,
    warnings: validation.warnings,
  };
}
