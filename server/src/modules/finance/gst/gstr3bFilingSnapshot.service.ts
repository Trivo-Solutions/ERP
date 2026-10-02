// G2g-7g — GSTR-3B filing snapshot builder. Mirrors the proven G2g-6b architecture
// (gstr1FilingSnapshot.service.ts) over the SAME, already-generic `GstReturnPeriod`/
// `GstFilingSnapshot` tables (no schema change — `returnType` is a plain string column that was
// explicitly designed to accept 'GSTR3B' later, per that model's own schema comment) with
// `returnType = 'GSTR3B'` — but is its own, separate file rather than a modification of the frozen
// G2g-6b file, because gstr1FilingSnapshot.service.ts is hardcoded to the GSTR-1-specific pipeline
// (`buildGstr1GstnExportCore`, `Gstr1GstnExportDto`, `serializeGstr1ToGstnJson`) and is itself frozen
// (see CLAUDE.md's G2g-6 phase entries — every phase in this file's family explicitly freezes the
// previous one). "Reuse the generic architecture, do not duplicate it" (brief §13) is satisfied by
// reusing the SAME tables, the SAME four-state lifecycle, and the SAME deterministic hash
// implementation (`gstr1SnapshotHash.ts`, imported verbatim per the brief's own §15 instruction) —
// never a second lifecycle or a second hash algorithm.
//
// Snapshot creation is explicitly NOT a filing action (same scope boundary as G2g-6b): it never
// writes a GstFilingAttempt row and only ever moves GstReturnPeriod.status OPEN -> SNAPSHOT_CREATED.

import { Prisma } from '@prisma/client';
import { AppError } from '../../../middleware/error';
import { createAuditEntry } from '../../../middleware/audit';
import { tenantTransaction, type TenantContext } from '../../../shared/tenantContext';
import { getGstr3bReconciliationReport } from './gstr3bReconciliation.service';
import { serializeGstr3bToGstnExport, GSTR3B_EXPORT_SCHEMA_VERSION } from './gstr3bGstnWire';
import { validateGstr3bGstnExport, type Gstr3bValidationIssue } from './gstr3bGstnValidator';
// Reused verbatim, per brief §15 ("Reuse the existing snapshot hash implementation") — these two
// helpers are pure/generic (recursive key-sort canonicalization + SHA-256) with zero GSTR-1-specific
// logic, unlike the services around them; importing rather than duplicating keeps exactly one hash
// algorithm in this codebase (G2g-7e chose to duplicate this same file for its OWN reasons — an
// independent module-boundary preference, not a precedent this phase needs to repeat, since this
// phase's own brief explicitly asks for reuse instead).
import { canonicalizeForHash, canonicalJsonString, sha256Hex } from './gstr1SnapshotHash';

const GSTR3B_RETURN_TYPE = 'GSTR3B';

/** This phase's own serializer/adapter identity — bump only if gstr3bGstnWire.ts's own output shape
 *  changes, never for an unrelated change (same convention as GSTR-1's G2g-6b constants). */
const GSTR3B_SERIALIZER_VERSION = 'g2g-7g-1';
const GSTR3B_ADAPTER_VERSION = 'g2g-7g-1';

const TERMINAL_PERIOD_STATUSES = new Set(['FILED', 'LOCKED']);
const SUPERSEDABLE_SNAPSHOT_STATUSES = ['DRAFT', 'BLOCKED'];

// ─────────────────────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr3bFilingSnapshotParams {
  gstRegistrationId: string;
  taxPeriod: string;
  financialYear?: string;
  branchId?: string | null;
}

export interface Gstr3bFilingSnapshotResult {
  id: string;
  returnPeriodId: string;
  version: number;
  status: string;
  canonicalDtoHash: string;
  wireJsonHash: string;
  serializerVersion: string;
  adapterVersion: string;
  gstnSchemaVersion: string;
  isFilingReady: boolean;
  blockers: Gstr3bValidationIssue[];
  warnings: Gstr3bValidationIssue[];
  informational: Gstr3bValidationIssue[];
}

type Gstr3bFilingBranchScope =
  | { scope: 'REGISTRATION' }
  | { scope: 'BRANCH'; branchId: string | null; restrictedBranchIds?: string[] };

function resolveBranchScope(ctx: TenantContext, branchId: string | null | undefined): Gstr3bFilingBranchScope {
  if (branchId) return { scope: 'BRANCH', branchId };
  if (ctx.branchAccess.allBranches) return { scope: 'REGISTRATION' };
  return { scope: 'BRANCH', branchId: null, restrictedBranchIds: ctx.branchAccess.branchIds };
}

/**
 * Builds and persists ONE immutable GSTR-3B filing snapshot for exactly one GST registration +
 * period (+ optional branch scope). Runs the frozen G2g-7f composed report
 * (`getGstr3bReconciliationReport`, which performs its own registration-ownership and
 * branch-access checks) exactly once, then the pure serializer and validator exactly once each.
 *
 * Persists `status: 'BLOCKED'` (never `'DRAFT'`) whenever the validator found any blocker, so a
 * blocked snapshot can never be mistaken for a filing-ready one by its status alone — the complete
 * `validationResult` (blockers/warnings/informational) is always stored either way, nothing is ever
 * silently discarded. Given this phase's validator (see gstr3bGstnValidator.ts's own header) only
 * blocks on genuinely resolvable per-period data problems — never on the permanent statutory gaps
 * this codebase cannot close yet — a `DRAFT` snapshot IS achievable for a period with fully-resolved
 * book ITC/RCM data; it still always carries `netPosition.statutoryReportingPosition.status ===
 * 'NOT_DETERMINABLE'` on its stored payload regardless.
 *
 * Throws a 409 `AppError` without persisting anything if the resolved `GstReturnPeriod` is already
 * `FILED`/`LOCKED` (no override/unlock mechanism in this phase, same posture as G2g-6b).
 */
export async function createGstr3bFilingSnapshot(
  ctx: TenantContext,
  params: Gstr3bFilingSnapshotParams,
  userId: string,
): Promise<Gstr3bFilingSnapshotResult> {
  const sourceDataCutoff = new Date();

  if (typeof params.gstRegistrationId !== 'string' || !params.gstRegistrationId) throw new AppError('gstRegistrationId is required', 400);
  if (typeof params.taxPeriod !== 'string' || !params.taxPeriod) throw new AppError('taxPeriod is required', 400);

  const report = await getGstr3bReconciliationReport(
    ctx.companyId,
    { gstRegistrationId: params.gstRegistrationId, taxPeriod: params.taxPeriod, financialYear: params.financialYear },
    { branchAccess: ctx.branchAccess, branchId: params.branchId ?? null },
  );

  const dto = serializeGstr3bToGstnExport(report);
  const validation = validateGstr3bGstnExport(dto);

  const canonicalDto = canonicalizeForHash(dto);
  const canonicalDtoHash = sha256Hex(canonicalJsonString(dto));
  // Unlike GSTR-1 (a distinct canonical DTO vs. a distinct GSTN offline-tool wire JSON), this phase
  // has exactly one export representation (see gstr3bGstnWire.types.ts's own header on why no
  // verified GSTN wire schema exists for GSTR-3B) — `wireJson`/`wireJsonHash` therefore store the
  // IDENTICAL dto a second time, hashed a second time, purely because the shared `GstFilingSnapshot`
  // schema (frozen, generic, shared with GSTR-1) requires both columns NOT NULL. This is never two
  // independently-computed values that could silently disagree with each other.
  const wireJsonHash = sha256Hex(JSON.stringify(dto));

  const financialYear = report.meta.financialYear;
  const taxPeriod = report.meta.taxPeriod;

  const branchScope = resolveBranchScope(ctx, params.branchId);
  const reportParams = {
    gstRegistrationId: params.gstRegistrationId, taxPeriod, financialYear,
    branchId: params.branchId ?? null, returnType: GSTR3B_RETURN_TYPE,
  };

  const status = validation.isFilingReady ? 'DRAFT' : 'BLOCKED';

  const periodKey = {
    companyId_gstRegistrationId_returnType_financialYear_taxPeriod: {
      companyId: ctx.companyId, gstRegistrationId: params.gstRegistrationId,
      returnType: GSTR3B_RETURN_TYPE, financialYear, taxPeriod,
    },
  };

  const snapshot = await tenantTransaction(ctx.companyId, async (tx) => {
    // Atomic resolve-or-create via native upsert — same documented reasoning as G2g-6b's own
    // identical upsert (an empty `update: {}` would silently degrade to ON CONFLICT DO NOTHING and
    // return zero rows on a real conflict; touching `updatedAt` keeps the UPDATE SET list non-empty).
    const period = await tx.gstReturnPeriod.upsert({
      where: periodKey,
      create: {
        companyId: ctx.companyId, gstRegistrationId: params.gstRegistrationId,
        returnType: GSTR3B_RETURN_TYPE, financialYear, taxPeriod, status: 'OPEN',
      },
      update: { updatedAt: new Date() },
    });

    // Row lock — serializes concurrent snapshot creation for the SAME period, identical pattern to
    // every other G2g-6/7g concurrency point in this codebase.
    await tx.$queryRaw`SELECT "id" FROM "gst_return_periods" WHERE "id" = ${period.id} FOR UPDATE`;
    const lockedPeriod = await tx.gstReturnPeriod.findUniqueOrThrow({ where: { id: period.id } });

    if (TERMINAL_PERIOD_STATUSES.has(lockedPeriod.status)) {
      throw new AppError(
        `Cannot create a new GSTR-3B filing snapshot: return period ${financialYear}/${taxPeriod} is already ${lockedPeriod.status}.`,
        409,
      );
    }

    const agg = await tx.gstFilingSnapshot.aggregate({ _max: { version: true }, where: { returnPeriodId: period.id } });
    const version = (agg._max.version ?? 0) + 1;

    let created;
    try {
      created = await tx.gstFilingSnapshot.create({
        data: {
          companyId: ctx.companyId,
          returnPeriodId: period.id,
          version,
          canonicalDtoJson: canonicalDto as Prisma.InputJsonValue,
          wireJson: dto as unknown as Prisma.InputJsonValue,
          canonicalDtoHash,
          wireJsonHash,
          serializerVersion: GSTR3B_SERIALIZER_VERSION,
          adapterVersion: GSTR3B_ADAPTER_VERSION,
          gstnSchemaVersion: GSTR3B_EXPORT_SCHEMA_VERSION,
          periodFrom: report.meta.period.from,
          periodTo: report.meta.period.to,
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
        throw new AppError('A concurrent snapshot was created for this return period — please retry.', 409);
      }
      throw err;
    }

    // Supersede this period's own prior still-open (DRAFT/BLOCKED) snapshots — never a FILED one.
    await tx.gstFilingSnapshot.updateMany({
      where: { returnPeriodId: period.id, id: { not: created.id }, status: { in: SUPERSEDABLE_SNAPSHOT_STATUSES } },
      data: { status: 'SUPERSEDED' },
    });

    if (lockedPeriod.status === 'OPEN') {
      await tx.gstReturnPeriod.update({ where: { id: period.id }, data: { status: 'SNAPSHOT_CREATED' } });
    }

    return created;
  });

  await createAuditEntry(
    'gst_filing_snapshots', snapshot.id, userId, 'GSTR3B_FILING_SNAPSHOT_CREATED',
    undefined,
    {
      gstRegistrationId: params.gstRegistrationId, gstin: report.meta.gstin,
      returnPeriodId: snapshot.returnPeriodId, version: snapshot.version, status: snapshot.status,
      financialYear, taxPeriod,
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
    isFilingReady: validation.isFilingReady,
    blockers: validation.blockers,
    warnings: validation.warnings,
    informational: validation.informational,
  };
}
