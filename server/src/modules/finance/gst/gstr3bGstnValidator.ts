// G2g-7g — GSTR-3B filing/export preparation. Pure, deterministic filing-readiness validator over
// the canonical export DTO (gstr3bGstnWire.ts's `Gstr3bGstnExportDto`).
//
// No Prisma, no Date.now(), no randomness, no mutation of its input — same discipline as
// gstr1GstnValidator.ts. Classifies every finding into one of three severities (brief §11):
//
//   BLOCKING      — a genuinely resolvable, per-period data-quality problem. `isFilingReady` is
//                    false while ANY blocker is present.
//   WARNING       — a standing, structural limitation of this codebase's current data model
//                    (imports/ISD/Rule 42-43/ITC reclaim/composition&UIN Table 3.2 buckets) — not
//                    fixable by correcting this one period's data, so never blocking.
//   INFORMATIONAL — always-present disclosures (the statutory-position caveat, diagnostic counts)
//                    that a reader must see regardless of isFilingReady.
//
// Deliberate design choice (read before changing `isFilingReady`'s meaning): this validator does
// NOT make the permanent statutory gaps (imports, ISD, Rule 42/43, the full Section 16(4)/17(5)/
// 180-day/GSTR-2B-finality conditions — all already G2g-7c/7d/7f's own, unchanged, NOT_DETERMINABLE
// facts) into BLOCKING issues. Doing so would make `isFilingReady` permanently false for every
// company, forever — a vacuous signal nobody could ever satisfy, since this codebase has no model
// for any of those categories (see G2g-7f's own "Not a filing calculator" limitation). Instead,
// `isFilingReady: true` means "TRIVO's OWN data is internally resolved and consistent for this
// period" (no unresolved book ITC/RCM lines, a valid GSTIN, a complete branch scope) — a real,
// achievable, testable signal — while `netPosition.statutoryReportingPosition.status` on the DTO
// itself STAYS permanently 'NOT_DETERMINABLE' regardless of `isFilingReady`, so nothing emitted by
// this validator can ever be read as "this is a GSTN-certified-complete statutory filing." Both
// facts are always surfaced together; neither is ever hidden behind the other.

import type { Gstr3bGstnExportDto, Gstr3bExportAmounts, Gstr3bExportItcBreakdownField } from './gstr3bGstnWire.types';

export type Gstr3bValidationSeverity = 'BLOCKING' | 'WARNING' | 'INFORMATIONAL';

export interface Gstr3bValidationIssue {
  severity: Gstr3bValidationSeverity;
  code: string;
  message: string;
  context?: Record<string, unknown>;
}

export interface Gstr3bGstnValidationResult {
  /** True iff `blockers` is empty. Never implies statutory filing completeness — see this file's
   *  header. `warnings`/`informational` never affect this flag. */
  isFilingReady: boolean;
  blockers: Gstr3bValidationIssue[];
  warnings: Gstr3bValidationIssue[];
  informational: Gstr3bValidationIssue[];
}

function issue(severity: Gstr3bValidationSeverity, code: string, message: string, context?: Record<string, unknown>): Gstr3bValidationIssue {
  return context ? { severity, code, message, context } : { severity, code, message };
}

function isNonZero(a: Gstr3bExportAmounts): boolean {
  return a.taxableValue !== 0 || a.igst !== 0 || a.cgst !== 0 || a.sgst !== 0 || a.cess !== 0;
}

function isNegative(a: Gstr3bExportAmounts): boolean {
  return a.taxableValue < 0 || a.igst < 0 || a.cgst < 0 || a.sgst < 0 || a.cess < 0;
}

function allFinite(a: Gstr3bExportAmounts): boolean {
  return Number.isFinite(a.taxableValue) && Number.isFinite(a.igst) && Number.isFinite(a.cgst) && Number.isFinite(a.sgst) && Number.isFinite(a.cess);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Metadata
// ─────────────────────────────────────────────────────────────────────────────

const GSTIN_STRUCTURAL_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const TAX_PERIOD_RE = /^(0[1-9]|1[0-2])\d{4}$/;

function checkMetadata(dto: Gstr3bGstnExportDto, blockers: Gstr3bValidationIssue[], warnings: Gstr3bValidationIssue[]): void {
  const gstin = dto.metadata.gstin;
  if (!gstin || gstin.trim() === '') {
    blockers.push(issue('BLOCKING', 'MISSING_GSTIN', 'The export carries no seller GSTIN.', { section: 'METADATA' }));
  } else if (!GSTIN_STRUCTURAL_RE.test(gstin.trim().toUpperCase())) {
    blockers.push(issue('BLOCKING', 'INVALID_GSTIN', `GSTIN "${gstin}" is not structurally well-formed.`, { section: 'METADATA', gstin }));
  }

  if (!dto.metadata.taxPeriod || !TAX_PERIOD_RE.test(dto.metadata.taxPeriod)) {
    blockers.push(issue('BLOCKING', 'MALFORMED_TAX_PERIOD', `Tax period "${dto.metadata.taxPeriod}" is not a well-formed MMYYYY value.`, { section: 'METADATA', taxPeriod: dto.metadata.taxPeriod }));
  }

  if (!dto.metadata.financialYear || dto.metadata.financialYear.trim() === '') {
    warnings.push(issue('WARNING', 'MISSING_FINANCIAL_YEAR', 'No financial year was resolved for this export.', { section: 'METADATA' }));
  }
}

function checkBranchScope(dto: Gstr3bGstnExportDto, blockers: Gstr3bValidationIssue[]): void {
  if (!dto.metadata.isCompleteGstinScope) {
    blockers.push(issue(
      'BLOCKING',
      'PARTIAL_BRANCH_SCOPE',
      `This export does not represent the complete GST-registration-wide scope (${dto.metadata.partialScopeReason ?? 'branch-restricted caller or explicit branch filter'}) — it cannot be treated as filing-ready.`,
      { section: 'SCOPE' },
    ));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Table 3.1 / 3.2 numeric sanity — negative values are a WARNING (a returns-heavy period can
// legitimately net negative), non-finite values are a defensive BLOCKING safety net.
// ─────────────────────────────────────────────────────────────────────────────

function checkFieldNumeric(label: string, amounts: Gstr3bExportAmounts | null, blockers: Gstr3bValidationIssue[], warnings: Gstr3bValidationIssue[]): void {
  if (!amounts) return;
  if (!allFinite(amounts)) {
    blockers.push(issue('BLOCKING', 'NON_FINITE_VALUE', `${label} contains a non-finite amount.`, { section: label, amounts }));
    return;
  }
  if (isNegative(amounts)) {
    warnings.push(issue('WARNING', 'NEGATIVE_AMOUNT', `${label} has a negative component — plausible in a returns-heavy period, but worth reviewing before filing.`, { section: label, amounts }));
  }
}

function checkTable31Numeric(dto: Gstr3bGstnExportDto, blockers: Gstr3bValidationIssue[], warnings: Gstr3bValidationIssue[]): void {
  checkFieldNumeric('Table 3.1(a)', dto.table31.outwardTaxableOther.amounts, blockers, warnings);
  checkFieldNumeric('Table 3.1(d)', dto.table31.inwardReverseCharge.amounts, blockers, warnings);
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Unresolved ITC / RCM — genuinely resolvable per-period data-quality gaps (brief §11: "unresolved
// ITC... unresolved RCM"). BLOCKING because, unlike the permanent structural gaps below, these are
// specific lines a user can go fix (assign a buyer registration, record a supplier GSTIN, classify a
// tax category, record an RCM payment) — treating them as merely informational would let a period
// with real unclassified money silently pass as filing-ready.
// ─────────────────────────────────────────────────────────────────────────────

function checkUnresolvedItcAndRcm(dto: Gstr3bGstnExportDto, blockers: Gstr3bValidationIssue[]): void {
  const rcmBreakdown: Gstr3bExportItcBreakdownField = dto.table4.table4A.inwardReverseCharge;
  if (isNonZero(rcmBreakdown.unresolved)) {
    blockers.push(issue('BLOCKING', 'UNRESOLVED_RCM_ITC', 'Table 4(A)(3) has unresolved RCM ITC lines (missing buyer registration, tax category, or unpaid RCM tax) — resolve before this period can be treated as filing-ready.', { section: 'TABLE_4A3', amounts: rcmBreakdown.unresolved }));
  }
  const allOtherBreakdown: Gstr3bExportItcBreakdownField = dto.table4.table4A.allOtherItc;
  if (isNonZero(allOtherBreakdown.unresolved)) {
    blockers.push(issue('BLOCKING', 'UNRESOLVED_BOOK_ITC', 'Table 4(A)(5) has unresolved book ITC lines (missing buyer registration, supplier GSTIN, or tax category) — resolve before this period can be treated as filing-ready.', { section: 'TABLE_4A5', amounts: allOtherBreakdown.unresolved }));
  }

  if (dto.table31.inwardReverseCharge.status === 'PARTIALLY_SUPPORTED') {
    blockers.push(issue('BLOCKING', 'UNRESOLVED_RCM_LIABILITY', 'Table 3.1(d) has RCM lines flagged RCM_UNRESOLVED — not yet a confirmed liability — excluded from the reported figure. Resolve before this period can be treated as filing-ready.', { section: 'TABLE_3_1D' }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Permanent structural gaps — never BLOCKING (see this file's header). Always present, since
// they are always true in this codebase today; never silently omitted.
// ─────────────────────────────────────────────────────────────────────────────

function checkStructuralGaps(dto: Gstr3bGstnExportDto, warnings: Gstr3bValidationIssue[]): void {
  if (dto.table4.table4A.importOfGoods.status !== 'SUPPORTED') {
    warnings.push(issue('WARNING', 'UNSUPPORTED_IMPORTS', 'Table 4(A)(1)/4(A)(2) (import of goods/services) cannot be populated — no import model exists in this codebase. Enter manually if applicable.', { section: 'TABLE_4A' }));
  }
  if (dto.table4.table4A.isd.status !== 'SUPPORTED') {
    warnings.push(issue('WARNING', 'UNSUPPORTED_ISD', 'Table 4(A)(4) (ISD) cannot be populated — no Input Service Distributor model exists in this codebase. Enter manually if applicable.', { section: 'TABLE_4A' }));
  }
  if (dto.table4.table4B.rule42And43.status !== 'SUPPORTED' || dto.table4.table4B.others.status !== 'SUPPORTED') {
    warnings.push(issue('WARNING', 'INCOMPLETE_TABLE_4B', 'Table 4(B)(1)/4(B)(2) (Rule 42/43 and other ITC reversals) cannot be computed from current data. Enter manually if applicable.', { section: 'TABLE_4B' }));
  }
  if (dto.table4.table4D.itcReclaimed.status !== 'SUPPORTED') {
    warnings.push(issue('WARNING', 'INCOMPLETE_TABLE_4D1', 'Table 4(D)(1) (ITC reclaimed) cannot be determined — no reversal/reclaim lifecycle is tracked in this codebase. Enter manually if applicable.', { section: 'TABLE_4D' }));
  }
  warnings.push(issue(
    'WARNING',
    'PARTIAL_TABLE_4C',
    `Table 4(C) (net ITC available) sums only ${dto.table4.table4C.componentsIncluded.join(', ')} — it excludes ${dto.table4.table4C.componentsExcluded.join(', ')}, none of which are assumed zero.`,
    { section: 'TABLE_4C' },
  ));
  if (dto.table32.compositionPersons.status !== 'SUPPORTED' || dto.table32.uinHolders.status !== 'SUPPORTED') {
    warnings.push(issue('WARNING', 'INCOMPLETE_TABLE_32', 'Table 3.2 composition-scheme and UIN-holder supply buckets cannot be populated from current data — only the unregistered-person bucket is supported. Enter manually if applicable.', { section: 'TABLE_32' }));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Informational — always emitted, never affects isFilingReady.
// ─────────────────────────────────────────────────────────────────────────────

function pushInformational(dto: Gstr3bGstnExportDto, informational: Gstr3bValidationIssue[]): void {
  informational.push(issue(
    'INFORMATIONAL',
    'STATUTORY_POSITION_NOT_DETERMINABLE',
    dto.netPosition.statutoryReportingPosition.reason,
    { section: 'NET_POSITION' },
  ));
  informational.push(issue(
    'INFORMATIONAL',
    'SOURCE_DIAGNOSTIC_COUNT',
    `The underlying G2g-7f reconciliation report carried ${dto.diagnostics.length} diagnostic(s) — review them alongside this export before filing.`,
    { section: 'DIAGNOSTICS', count: dto.diagnostics.length },
  ));
}

// ─────────────────────────────────────────────────────────────────────────────
// The validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a GSTR-3B export DTO for filing readiness (TRIVO's own data consistency sense — see this
 * file's header for the deliberate distinction from statutory filing completeness). Pure and
 * side-effect free: no Prisma, no Date.now(), no randomness, same input always produces the same
 * output.
 */
export function validateGstr3bGstnExport(dto: Gstr3bGstnExportDto): Gstr3bGstnValidationResult {
  const blockers: Gstr3bValidationIssue[] = [];
  const warnings: Gstr3bValidationIssue[] = [];
  const informational: Gstr3bValidationIssue[] = [];

  checkMetadata(dto, blockers, warnings);
  checkBranchScope(dto, blockers);
  checkTable31Numeric(dto, blockers, warnings);
  checkUnresolvedItcAndRcm(dto, blockers);
  checkStructuralGaps(dto, warnings);
  pushInformational(dto, informational);

  return { isFilingReady: blockers.length === 0, blockers, warnings, informational };
}
