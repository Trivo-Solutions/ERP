// G2g-4c-4 — GSTR-1 GSTN JSON export service. Orchestrates the existing, FROZEN GSTR-1 pipeline:
//
//   gstr1Reporting.service.ts (Prisma-backed reports)
//     -> gstr1GstnAdapter.ts        (G2g-4c-1, frozen) -> Gstr1GstnExportDto
//     -> gstr1GstnValidator.ts      (G2g-4c-2, frozen) -> Gstr1GstnValidationResult
//     -> gstr1GstnSerializer.ts     (G2g-4c-3, frozen) -> Gstr1GstnWireReturn (the downloadable JSON)
//
// This file does NOT reclassify, reaggregate, revalidate, or reserialize anything the pipeline above
// already owns — it only loads the five already-existing report pieces for one GST registration +
// period + (optional) branch, resolves AATO, builds the canonical DTO, and runs it through the
// frozen validator/serializer in that order. The validator's blockers gate the serializer: an invalid
// DTO is never serialized, and the GSTN JSON this service returns is always byte-identical to the
// frozen serializer's own output (no application wrapper).
//
// Authorization (GST registration ownership, branch accessibility) is this service's own job (same
// posture finance.router.ts's existing GSTR-1 routes already use for gstr1Reporting.service.ts,
// which explicitly documents that ownership checks are the CALLER's responsibility) — every report
// loader below is handed an already-verified gstRegistrationId/branchId.
//
// No schema change, no filing snapshot, no GSTN API call. See this file's own `buildGstr1GstnExport`
// doc comment for the exact scope boundary.

import { AppError } from '../../../middleware/error';
import { createAuditEntry } from '../../../middleware/audit';
import { assertBranchAccessible } from '../../../middleware/tenant';
import { tenantQuery, type TenantContext } from '../../../shared/tenantContext';
import { parseIstRangeStart, parseIstRangeEnd } from '../../../shared/istDate';
import { IST_OFFSET_MS } from '../../../shared/compliance';
import { getFinancialYearForDate } from '../../../shared/financialYear';
import { getAato } from '../../gst/aato.service';
import {
  getGstr1OutwardReportWithSalesDebitNotes,
  getGstr1CreditNoteReport,
  getGstr1SalesDebitNoteReport,
  getGstr1Table12ReportWithSalesDebitNotes,
  getGstr1Table13Report,
  type Gstr1ReportScopeOptions,
} from './gstr1Reporting.service';
import {
  adaptGstr1ToGstnExport,
  type Gstr1GstnAdapterAatoInput,
} from './gstr1GstnAdapter';
import { validateGstr1GstnExport, type Gstr1GstnValidationIssue, type Gstr1GstnValidationResult } from './gstr1GstnValidator';
import { serializeGstr1ToGstnJson, Gstr1GstnSerializationError } from './gstr1GstnSerializer';
import type { Gstr1GstnWireReturn } from './gstr1GstnWire.types';
import type { Gstr1GstnExportDto } from './gstr1GstnExport.types';

// ─────────────────────────────────────────────────────────────────────────────
// Public contract
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1ExportParams {
  gstRegistrationId: string;
  from: string;
  to: string;
  branchId?: string | null;
}

export interface Gstr1ExportBlockedResult {
  ok: false;
  /** G2g-6b: the canonical DTO the (blocked) validation ran against — added purely so a caller like
   *  the filing-snapshot builder can reuse this orchestration without re-running report generation.
   *  Never used by this file's own pre-existing behavior/tests. */
  dto: Gstr1GstnExportDto;
  blockers: Gstr1GstnValidationIssue[];
  warnings: Gstr1GstnValidationIssue[];
}

export interface Gstr1ExportSuccessResult {
  ok: true;
  /** G2g-6b: see Gstr1ExportBlockedResult.dto's own comment. */
  dto: Gstr1GstnExportDto;
  wire: Gstr1GstnWireReturn;
  filename: string;
  warnings: Gstr1GstnValidationIssue[];
}

export type Gstr1ExportResult = Gstr1ExportBlockedResult | Gstr1ExportSuccessResult;

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers (IST-anchored, same fixed +5:30 convention as shared/istDate.ts /
// shared/financialYear.ts — never the server's own local timezone).
// ─────────────────────────────────────────────────────────────────────────────

/** GSTN statutory filing period MMYYYY, anchored on the period's TERMINAL month — matches
 *  gstr1GstnValidator.ts's own `checkFilingPeriod` ("anchored on the TERMINAL month only"), so a
 *  period built this way is always internally consistent with that check by construction, for both
 *  a single-month filer and a quarterly (QRMP) span. */
function resolveFilingPeriodMmYYYY(to: Date): string {
  const istShifted = new Date(to.getTime() + IST_OFFSET_MS);
  const mm = String(istShifted.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = istShifted.getUTCFullYear();
  return `${mm}${yyyy}`;
}

function formatDDMMYYYY(d: Date): string {
  const istShifted = new Date(d.getTime() + IST_OFFSET_MS);
  const dd = String(istShifted.getUTCDate()).padStart(2, '0');
  const mm = String(istShifted.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = istShifted.getUTCFullYear();
  return `${dd}-${mm}-${yyyy}`;
}

/** Deterministic, path-separator-free filename — the GSTIN has already passed the validator's
 *  structural GSTIN check by the time this runs (success path only), so stripping anything that
 *  isn't alphanumeric is defense in depth, never a silent acceptance of a malformed GSTIN. */
function buildExportFilename(gstin: string, from: Date, to: Date): string {
  const safeGstin = gstin.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return `GSTR1_${safeGstin}_${formatDDMMYYYY(from)}_${formatDDMMYYYY(to)}.json`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The export service
// ─────────────────────────────────────────────────────────────────────────────

/** The non-auditing core of `buildGstr1GstnExport` below: everything through report loading,
 *  adapter, and validation — but NOT serialization and NOT audit logging. Extracted (G2g-6b) so the
 *  filing-snapshot builder (`gstr1FilingSnapshot.service.ts`) can reuse this exact orchestration
 *  (registration ownership, branch access, AATO resolution, the five report loaders, the frozen
 *  adapter/validator) without running report generation twice and without emitting this file's own
 *  "an export happened" audit trail for what is actually a snapshot-creation event. `buildGstr1Gstn
 *  Export` itself is unchanged behaviorally — it is now a thin wrapper that calls this core function
 *  and keeps its own pre-existing serialize + audit steps exactly as before. */
export interface Gstr1GstnExportCoreResult {
  registration: { id: string; companyId: string; gstin: string; legalName: string; tradeName: string | null };
  dto: Gstr1GstnExportDto;
  validation: Gstr1GstnValidationResult;
  isPartialBranchExport: boolean;
  from: Date;
  to: Date;
}

export async function buildGstr1GstnExportCore(
  ctx: TenantContext,
  params: Gstr1ExportParams,
): Promise<Gstr1GstnExportCoreResult> {
  if (typeof params.gstRegistrationId !== 'string' || !params.gstRegistrationId) {
    throw new AppError('gstRegistrationId is required', 400);
  }
  if (!params.from || !params.to) {
    throw new AppError('from and to are required', 400);
  }

  const from = parseIstRangeStart(params.from);
  const to = parseIstRangeEnd(params.to);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    throw new AppError('Invalid date range provided', 400);
  }
  if (from.getTime() > to.getTime()) {
    throw new AppError('"from" date must not be after "to" date', 400);
  }

  // GST registration ownership — same 404-not-403 convention as assertOwnedByCompany, and loads the
  // metadata (gstin/legalName/tradeName) this function needs in the same query rather than a second
  // round trip.
  const registration = await tenantQuery(ctx.companyId, (tx) =>
    tx.companyGstRegistration.findUnique({
      where: { id: params.gstRegistrationId },
      select: { id: true, companyId: true, gstin: true, legalName: true, tradeName: true },
    }),
  );
  if (!registration || registration.companyId !== ctx.companyId) {
    throw new AppError('GST registration not found', 404);
  }

  if (params.branchId) {
    await assertBranchAccessible(params.branchId, ctx, 'Branch');
  }

  // Does NOT represent the complete GST-registration-wide scope when either an explicit branch was
  // requested, or the caller's own membership is itself branch-restricted (same rule
  // gstr1Reporting.service.ts's own getGstr1Table13Report uses for `isPartialBranchSeries`).
  const isPartialBranchExport = Boolean(params.branchId) || !ctx.branchAccess.allBranches;

  const scopeOpts: Gstr1ReportScopeOptions = { branchAccess: ctx.branchAccess, branchId: params.branchId ?? undefined };

  const financialYear = getFinancialYearForDate(to);
  const aatoResp = await getAato(ctx, { gstRegistrationId: params.gstRegistrationId, financialYear });
  const aatoInput: Gstr1GstnAdapterAatoInput = {
    currentFy: {
      financialYear: aatoResp.financialYear,
      turnover: aatoResp.aato?.turnover ?? null,
      verificationStatus: aatoResp.aato?.verificationStatus ?? null,
      source: aatoResp.aato?.source ?? null,
    },
    precedingFy: {
      financialYear: aatoResp.precedingAato?.financialYear ?? aatoResp.precedingFinancialYear,
      turnover: aatoResp.precedingAato?.turnover ?? null,
      verificationStatus: aatoResp.precedingAato?.verificationStatus ?? null,
      source: aatoResp.precedingAato?.source ?? null,
    },
  };

  const [outward, creditNotes, salesDebitNotes, table12, table13] = await Promise.all([
    getGstr1OutwardReportWithSalesDebitNotes(ctx.companyId, params.gstRegistrationId, from, to, scopeOpts),
    getGstr1CreditNoteReport(ctx.companyId, params.gstRegistrationId, from, to, scopeOpts),
    getGstr1SalesDebitNoteReport(ctx.companyId, params.gstRegistrationId, from, to, scopeOpts),
    getGstr1Table12ReportWithSalesDebitNotes(ctx.companyId, params.gstRegistrationId, from, to, scopeOpts),
    getGstr1Table13Report(ctx, { gstRegistrationId: params.gstRegistrationId, from, to, branchId: params.branchId ?? undefined }),
  ]);

  const dto = adaptGstr1ToGstnExport({
    metadata: {
      gstin: registration.gstin,
      legalName: registration.legalName,
      tradeName: registration.tradeName,
      period: { from, to },
      filingPeriodMmYYYY: resolveFilingPeriodMmYYYY(to),
      isPartialBranchExport,
      aato: aatoInput,
    },
    outward,
    creditNotes,
    salesDebitNotes,
    table12,
    table13,
  });

  const validation = validateGstr1GstnExport(dto);

  return { registration, dto, validation, isPartialBranchExport, from, to };
}

/**
 * Builds a GSTN-offline-tool-compatible JSON export for exactly one GST registration + period
 * (+ optional branch). Required sequence (brief section 5): company context (via `ctx`, the
 * caller's already-authenticated/permission-checked tenant context) -> GST registration ownership
 * -> branch access -> date validation -> report generation -> canonical DTO -> validation ->
 * serialization.
 *
 * Returns `{ ok: false, blockers, warnings }` when the frozen validator finds the export is not
 * filing-grade (no JSON is ever generated in that case) or `{ ok: true, wire, filename, warnings }`
 * with the frozen serializer's own byte-identical output otherwise. Throws `AppError` for request-
 * shape problems (missing/invalid ids, dates, ownership/branch failures) — the same convention every
 * other GSTR-1 reporting route in this codebase already uses.
 */
export async function buildGstr1GstnExport(
  ctx: TenantContext,
  params: Gstr1ExportParams,
  userId: string,
): Promise<Gstr1ExportResult> {
  const { registration, dto, validation, from, to } = await buildGstr1GstnExportCore(ctx, params);

  const auditMeta = {
    gstRegistrationId: params.gstRegistrationId,
    gstin: registration.gstin,
    period: { from, to },
    branchId: params.branchId ?? null,
    filingPeriodMmYYYY: dto.metadata.period.filingPeriodMmYYYY,
  };

  if (!validation.isValid) {
    await createAuditEntry(
      'company_gst_registrations', params.gstRegistrationId, userId, 'GSTR1_GSTN_EXPORT_BLOCKED',
      undefined, { ...auditMeta, blockerCount: validation.blockers.length, warningCount: validation.warnings.length },
      ctx.companyId,
    );
    return { ok: false, dto, blockers: validation.blockers, warnings: validation.warnings };
  }

  let wire: Gstr1GstnWireReturn;
  try {
    wire = serializeGstr1ToGstnJson(dto);
  } catch (err) {
    if (err instanceof Gstr1GstnSerializationError) {
      // The validator passed but the (narrower, serialize-safety-only) serializer still rejected the
      // DTO — a genuine edge the validator doesn't cover. Never silently downgraded to a 500: this is
      // a data-shape problem the caller can see, same posture as every other 400 this function raises.
      await createAuditEntry(
        'company_gst_registrations', params.gstRegistrationId, userId, 'GSTR1_GSTN_EXPORT_FAILED',
        undefined, { ...auditMeta, serializationErrorCode: err.code, serializationErrorMessage: err.message },
        ctx.companyId,
      );
      throw new AppError(`GSTR-1 export could not be serialized: ${err.message}`, 400);
    }
    throw err;
  }

  const filename = buildExportFilename(registration.gstin, from, to);

  await createAuditEntry(
    'company_gst_registrations', params.gstRegistrationId, userId, 'GSTR1_GSTN_EXPORT',
    undefined, { ...auditMeta, warningCount: validation.warnings.length, filename },
    ctx.companyId,
  );

  return { ok: true, dto, wire, filename, warnings: validation.warnings };
}
