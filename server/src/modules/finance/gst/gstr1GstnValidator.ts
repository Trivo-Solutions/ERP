// G2g-4c-2 — GSTR-1 GSTN export validator. A PURE function over the canonical export DTO produced
// by gstr1GstnAdapter.ts (G2g-4c-1, frozen): decides whether that DTO is structurally and
// compliance-ready enough to proceed to a FUTURE serializer (G2g-4c-3, not built here).
//
//   Frozen GSTR-1 engines -> gstr1GstnAdapter.ts -> Gstr1GstnExportDto -> THIS validator
//   -> [future] serializer -> GSTN offline JSON
//
// This file takes NO Prisma dependency, performs NO database access, NO HTTP-context access, NO
// filesystem/network access, and never mutates the DTO it is handed — every output object below is
// freshly constructed. It does not recalculate GST, does not reclassify invoices, does not generate
// JSON, and does not serialize anything. Same input always produces the same output.
//
// IMPORTANT — this validator does NOT prove a payload will be accepted by GSTN. It only proves:
//   1. TRIVO's canonical DTO is internally consistent.
//   2. The export data available to THIS phase is structurally valid.
//   3. Known filing-grade blockers (as currently understood) are surfaced.
// The actual GSTN JSON schema and offline-tool validation are confirmed in the serializer phase.
//
// ─────────────────────────────────────────────────────────────────────────────
// Architectural note — several rules this validator was briefed to implement reference information
// that the canonical `Gstr1GstnExportDto` (frozen, gstr1GstnExport.types.ts) structurally does not
// carry, because the frozen `gstr1GstnAdapter.ts` never propagates it onto the DTO in the first
// place (and both files are frozen for this phase — neither was modified to add a carrier field).
// Each such gap is called out at its specific check below with a comment explaining exactly what
// is and isn't checkable today, and is also summarized in this phase's final report under
// "Deviations". None of these gaps are silently ignored — every one is either:
//   (a) implemented as a defensive/forward-compatible check against a value the TYPE permits even
//       though the current adapter never sets it that way (e.g. a B2B `invoiceType` other than
///      'R', or a B2CS `ecommerceSupplyType` of 'E') — inert today, correct the day either field is
//       ever truly populated by a future adapter revision; or
//   (b) re-derived from DTO-native structure that carries the same real-world fact in a different
//       shape (e.g. "unexplained sequence gap" is re-derived from two `documentsIssued` entries in
//       the same series identity with a numeric gap between them, not from a Table13 diagnostic
//       code the DTO never carries); or
//   (c) left as a permanent WARNING with no blocker path, explicitly documented as structurally
//       unreachable given today's DTO shape, never faked into a BLOCKER with invented evidence.

import { validateGstin } from '../../../shared/gstin';
import { normalizeGstUqc } from '../../../shared/gstUqc';
import { AATO_5CR_THRESHOLD } from '../../../shared/gstCompliance';
import type {
  Gstr1GstnExportDto,
  Gstr1GstnB2bInvoice,
  Gstr1GstnB2clInvoice,
  Gstr1GstnB2csRecord,
  Gstr1GstnCdnrNote,
  Gstr1GstnCdnurNote,
  Gstr1GstnHsnSummaryRow,
  Gstr1GstnDocumentSeries,
  Gstr1GstnDiagnostic,
  Gstr1AatoVerificationState,
} from './gstr1GstnExport.types';

// ─────────────────────────────────────────────────────────────────────────────
// Result shape
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1GstnValidationIssue {
  code: string;
  message: string;
  /** Loose structured context for a human/caller to locate the problem — never statutory data on
   *  its own, purely diagnostic (document numbers, field names, computed figures, ...). */
  context?: Record<string, unknown>;
}

export interface Gstr1GstnValidationResult {
  /** True iff `blockers` is empty. Warnings never affect this flag. */
  isValid: boolean;
  blockers: Gstr1GstnValidationIssue[];
  warnings: Gstr1GstnValidationIssue[];
}

function blocker(code: string, message: string, context?: Record<string, unknown>): Gstr1GstnValidationIssue {
  return context ? { code, message, context } : { code, message };
}
const warning = blocker; // identical shape — kept as a separate name at call sites for readability.

// ─────────────────────────────────────────────────────────────────────────────
// Small pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Mirrors gstr1Table12Aggregation.ts's own private PLAUSIBLE_HSN_RE exactly (that constant is not
 *  exported, and the file is frozen) — a conservative numeric 4-8 digit shape check, never a lookup
 *  against a live/authoritative HSN master, and never itself a statement about the AATO-driven
 *  4-digit-vs-6-digit mandate (that is `resolveMandatedHsnDigits` below, kept as a separate check). */
const PLAUSIBLE_HSN_RE = /^\d{4,8}$/;
function isPlausibleHsnCode(code: string | null): boolean {
  return !!code && PLAUSIBLE_HSN_RE.test(code.trim());
}

/** Rule 46(b): a document serial number must not exceed 16 characters and GSTN's offline tool only
 *  accepts alphanumerics plus '-' and '/' (TRIVO's own document-number convention — see
 *  gstr1Table13Aggregation.ts's parseDocumentNumber, frozen, same separators). */
const DOCUMENT_NUMBER_RE = /^[A-Za-z0-9\-/]+$/;
function isValidDocumentNumber(num: string): boolean {
  return num.length > 0 && num.length <= 16 && DOCUMENT_NUMBER_RE.test(num);
}

function pushIfNotFinite(
  blockers: Gstr1GstnValidationIssue[],
  label: string,
  value: number,
  context: Record<string, unknown>,
): void {
  if (!Number.isFinite(value)) {
    blockers.push(blocker('NON_FINITE_VALUE', `${label} is not a finite number (got ${value}).`, { ...context, field: label, value }));
  }
}

/** The AATO-driven minimum HSN digit length (Notification No. 78/2020), reproduced here as the
 *  minimal two-number comparison it actually is — NOT a reimplementation of
 *  shared/gstCompliance.ts's `validateHsnCompliance`/`validateGstCompliance` (which are async and
 *  Prisma-bound, and therefore cannot be imported into this pure, synchronous validator without
 *  giving it a database dependency it must not have). The one shared fact THIS code depends on —
 *  the ₹5 Cr threshold itself — is imported from that module, never restated as a literal, so the
 *  threshold has exactly one source of truth in the codebase. Returns null when the mandate cannot
 *  be authoritatively determined (AATO not verified, or amount unknown) — callers must not invent a
 *  fallback digit count in that case; that case is instead its own export-wide blocker (see
 *  `checkAatoPrecedingFy` below). */
function resolveMandatedHsnDigits(
  reportingTab: 'B2B' | 'B2C',
  verificationState: Gstr1AatoVerificationState,
  amount: number | null,
): number | null {
  if (verificationState !== 'VERIFIED' || amount == null) return null;
  if (amount > AATO_5CR_THRESHOLD) return 6; // mandatory for ALL supplies, B2B and B2C alike
  return reportingTab === 'B2B' ? 4 : null; // B2C stays optional at/under the ₹5 Cr threshold
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Metadata — GSTIN, filing period, branch scope, AATO
// ─────────────────────────────────────────────────────────────────────────────

function checkGstin(dto: Gstr1GstnExportDto, blockers: Gstr1GstnValidationIssue[]): void {
  const gstin = dto.metadata.gstin;
  if (!gstin || gstin.trim() === '') {
    blockers.push(blocker('MISSING_GSTIN', 'The export carries no seller GSTIN — a filing-grade GSTN export requires one.', { section: 'METADATA' }));
    return;
  }
  const result = validateGstin(gstin);
  if (!result.valid) {
    blockers.push(blocker('INVALID_GSTIN', `Seller GSTIN "${gstin}" failed structural/checksum validation: ${result.errors.join('; ')}`, { section: 'METADATA', gstin }));
  }
}

function parseFilingPeriod(fp: string): { mm: number; yyyy: number } | null {
  if (!/^\d{6}$/.test(fp)) return null;
  const mm = parseInt(fp.slice(0, 2), 10);
  const yyyy = parseInt(fp.slice(2), 10);
  if (mm < 1 || mm > 12) return null;
  if (yyyy < 2017 || yyyy > 2099) return null; // GST's own existence window
  return { mm, yyyy };
}

function checkFilingPeriod(dto: Gstr1GstnExportDto, blockers: Gstr1GstnValidationIssue[]): void {
  const period = dto.metadata.period;
  const fp = period.filingPeriodMmYYYY;

  if (!fp || fp.trim() === '') {
    blockers.push(blocker('MISSING_FILING_PERIOD', 'No GSTN statutory filing period (MMYYYY) was resolved for this export.', { section: 'PERIOD' }));
    return;
  }

  const parsed = parseFilingPeriod(fp);
  if (!parsed) {
    blockers.push(blocker('MALFORMED_FILING_PERIOD', `Filing period "${fp}" is not a well-formed MMYYYY value.`, { section: 'PERIOD', filingPeriodMmYYYY: fp }));
    return;
  }

  const from = period.internalFrom;
  const to = period.internalTo;
  const fromValid = from instanceof Date && !Number.isNaN(from.getTime());
  const toValid = to instanceof Date && !Number.isNaN(to.getTime());
  if (!fromValid || !toValid) {
    blockers.push(blocker('INVALID_FILING_PERIOD_DATES', 'The export\'s internal from/to period boundaries are not valid dates.', { section: 'PERIOD' }));
    return;
  }
  if (from.getTime() > to.getTime()) {
    blockers.push(blocker('INVALID_FILING_PERIOD_RANGE', 'The export\'s internal "from" date is after its "to" date.', { section: 'PERIOD' }));
    return;
  }

  // Anchored on the TERMINAL month only — this correctly accepts both a single-month filer (from
  // and to both inside MMYYYY) and a quarterly QRMP filer (from = first day of the quarter's first
  // month, to = last day of the quarter's last month; GSTN's own quarterly period codes are keyed
  // by that last month). It never guesses which filing frequency applies — it only checks that the
  // "to" boundary is consistent with the declared period; never that a span is exactly 1 or 3 months.
  const toInPeriod = to.getUTCFullYear() === parsed.yyyy && to.getUTCMonth() + 1 === parsed.mm;
  if (!toInPeriod) {
    blockers.push(blocker(
      'FILING_PERIOD_MISMATCH',
      `Filing period "${fp}" does not consistently represent the export's internal date range (internalTo falls in ${to.getUTCFullYear()}-${to.getUTCMonth() + 1}, not ${parsed.yyyy}-${parsed.mm}).`,
      { section: 'PERIOD', filingPeriodMmYYYY: fp },
    ));
  }
}

function checkBranchScope(dto: Gstr1GstnExportDto, blockers: Gstr1GstnValidationIssue[]): void {
  if (dto.metadata.isPartialBranchExport) {
    blockers.push(blocker(
      'PARTIAL_BRANCH_SCOPE',
      'This export does not represent the complete GST-registration-wide scope (a single branch, or a branch-restricted caller) — it cannot be treated as a complete filing.',
      { section: 'SCOPE' },
    ));
  }
}

/** Per Phase D (shared/gstCompliance.ts), the statutory HSN-digit mandate is driven by the
 *  PRECEDING financial year's AATO — never the current FY's. This is a different fact from the
 *  adapter's own `AATO_NOT_VERIFIED` diagnostic (which the adapter computes off `currentFy` — see
 *  gstr1GstnAdapter.ts's `buildMetadata`/the export loop) and is checked independently here under
 *  its own code; both can fire together, or only one, depending on which FY is actually
 *  unverified/missing. Neither is suppressed in favor of the other. */
function checkAatoPrecedingFy(dto: Gstr1GstnExportDto, blockers: Gstr1GstnValidationIssue[]): void {
  const preceding = dto.metadata.aato.precedingFy;
  if (preceding.verificationState === 'VERIFIED') return;
  const message = preceding.verificationState === 'MISSING'
    ? 'No preceding financial year AATO record is on file — it cannot be treated as zero, and a filing-grade export cannot proceed without it.'
    : 'The preceding financial year AATO has not been verified against the GST portal — a filing-grade export cannot rely on an unverified figure.';
  blockers.push(blocker('AATO_PRECEDING_FY_NOT_VERIFIED', message, { section: 'AATO', verificationState: preceding.verificationState }));
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Adapter diagnostics — severity classification
// ─────────────────────────────────────────────────────────────────────────────

/** Evidence that an "unsupported" capability is actually RELEVANT to this export, derived strictly
 *  from DTO-native fields the TYPE permits — never from the capability flag alone (the brief's own
 *  requirement). Of the four UNSUPPORTED_SECTION diagnostics the adapter always emits, only
 *  'exports' has a real DTO-native evidence channel: `Gstr1GstnB2bInvoiceType` is a genuine union
 *  ('R' | 'SEWP' | 'SEWOP' | 'DE' | 'CBW') even though today's adapter always writes null, so a
 *  non-'R' value is real, type-permitted evidence of an export-adjacent supply. The other three
 *  ('advances', 'nilExemptNonGst', 'ecommerce') have NO such channel anywhere in the canonical DTO:
 *  there is no advance-receipt array; a 0% GST rate is not a reliable signal of a nil-rated/exempt/
 *  non-GST supply (GSTN's own Table 8 classification cannot be safely inferred from a tax rate
 *  alone); and `Gstr1GstnB2csEcommerceType` is NOT actually a union in the frozen types file — it is
 *  the single literal type `'OE'`, so a B2CS record can never structurally carry any other value at
 *  all (confirmed when a `'E'` value failed to type-check against it while building this file's
 *  tests). All three therefore always resolve to "no evidence" under the current DTO shape — a
 *  structural limitation, not a policy choice to under-check; see this phase's final report. */
function hasExportEvidence(dto: Gstr1GstnExportDto): boolean {
  return dto.b2b.some((inv) => inv.invoiceType != null && inv.invoiceType !== 'R');
}

function checkUnsupportedSection(dto: Gstr1GstnExportDto, diag: Gstr1GstnDiagnostic, blockers: Gstr1GstnValidationIssue[], warnings: Gstr1GstnValidationIssue[]): void {
  const section = diag.section;
  const relevant = section === 'exports' && hasExportEvidence(dto);
  // 'advances' / 'nilExemptNonGst' / 'ecommerce': no DTO-native evidence channel exists — always irrelevant today.

  if (relevant) {
    blockers.push(blocker(
      'UNSUPPORTED_SECTION',
      `${diag.message} This export carries evidence of actual "${section}" activity, so the gap is relevant, not merely theoretical.`,
      { section },
    ));
  } else {
    warnings.push(warning('UNSUPPORTED_SECTION', diag.message, { section }));
  }
}

/** AMENDMENT_DATA_UNAVAILABLE: per the brief, this blocks only when the selected period's data
 *  actually requires amendment reporting. The canonical DTO carries no amendment-evidence field at
 *  all (no amendment array, no per-document "this was amended" flag anywhere in
 *  gstr1GstnExport.types.ts) — there is structurally no way for this phase to ever find such
 *  evidence, so this is always a WARNING under the current DTO shape. Never escalated to a blocker
 *  with invented evidence; see this phase's final report under Deviations. */
function checkAmendments(diag: Gstr1GstnDiagnostic, warnings: Gstr1GstnValidationIssue[]): void {
  warnings.push(warning('AMENDMENT_DATA_UNAVAILABLE', diag.message, { section: diag.section }));
}

function checkAdapterDiagnostics(dto: Gstr1GstnExportDto, blockers: Gstr1GstnValidationIssue[], warnings: Gstr1GstnValidationIssue[]): void {
  for (const diag of dto.diagnostics) {
    switch (diag.code) {
      case 'INVALID_MAPPING':
        blockers.push(blocker('INVALID_MAPPING', diag.message, { section: diag.section, documentId: diag.documentId, documentNumber: diag.documentNumber }));
        break;
      case 'MISSING_EXPORT_FIELD':
        // A per-document gap (carries a documentNumber, e.g. "this B2B invoice has no invoice
        // date") is a real, specific data-quality defect — BLOCKER. A phase-wide, permanent gap
        // with no documentNumber (e.g. "invoiceType is always null in this phase", "Table 12
        // totalValue is always null in this phase") is a known, unconditional limitation of this
        // export phase, not a defect in any one document — WARNING. Treating the latter as a
        // blocker would make every B2B/Table-12-bearing export permanently unvalidatable, which
        // defeats the validator's purpose; see this phase's final report under Deviations for the
        // statutory uncertainty this leaves open (whether GSTN's live schema truly requires
        // `inv_typ`/`val` in every case is a serializer-phase/CA question, not decided here).
        if (diag.documentNumber) {
          blockers.push(blocker('MISSING_EXPORT_FIELD', diag.message, { section: diag.section, field: diag.field, documentNumber: diag.documentNumber }));
        } else {
          warnings.push(warning('MISSING_EXPORT_FIELD', diag.message, { section: diag.section, field: diag.field }));
        }
        break;
      case 'PARTIAL_BRANCH_SCOPE':
        // Already surfaced authoritatively by checkBranchScope() off `metadata.isPartialBranchExport`
        // directly — this diagnostic is the adapter's own passthrough of the identical fact, so it is
        // deliberately NOT double-counted as a second blocker here.
        break;
      case 'AATO_NOT_VERIFIED':
        // The adapter's own diagnostic is computed off CURRENT FY (see gstr1GstnAdapter.ts's
        // buildMetadata/export loop) — a distinct fact from checkAatoPrecedingFy()'s PRECEDING FY
        // check above (Phase D's actual statutory driver). Surfaced as its own blocker under the
        // adapter's own code name so neither fact is silently dropped.
        blockers.push(blocker('AATO_NOT_VERIFIED', diag.message, { section: diag.section }));
        break;
      case 'UNSUPPORTED_SECTION':
        checkUnsupportedSection(dto, diag, blockers, warnings);
        break;
      case 'AMENDMENT_DATA_UNAVAILABLE':
        checkAmendments(diag, warnings);
        break;
      default: {
        // Defensive, forward-compatible fallback for a diagnostic code this validator doesn't
        // recognize (e.g. a future adapter revision). Never silently dropped — surfaced as a
        // warning rather than crashing or being ignored, since an unrecognized code's severity
        // cannot be authoritatively decided here.
        const code: string = diag.code;
        warnings.push(warning('UNRECOGNIZED_ADAPTER_DIAGNOSTIC', `Unrecognized adapter diagnostic code "${code}": ${diag.message}`, { section: diag.section }));
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2b. Defensive, forward-compatible scans for facts the DTO's `diagnostics` array cannot currently
// carry at all (see this file's header). Both are no-ops against every real adapter output today —
// `Gstr1GstnDiagnosticCode` (frozen) has no 'UNCLASSIFIED_OUTWARD_SUPPLY'/'DOCUMENT_FY_MISMATCH'
// member — but are kept so a malformed/future diagnostic object under these exact code strings is
// still caught rather than silently passed through.
// ─────────────────────────────────────────────────────────────────────────────

function checkForwardCompatibleDiagnostics(dto: Gstr1GstnExportDto, blockers: Gstr1GstnValidationIssue[], warnings: Gstr1GstnValidationIssue[]): void {
  for (const diag of dto.diagnostics) {
    const code: string = diag.code;
    if (code === 'UNCLASSIFIED_OUTWARD_SUPPLY' || code === 'UNCLASSIFIED_OUTWARD_RECORD') {
      blockers.push(blocker('UNCLASSIFIED_OUTWARD_RECORD', diag.message, { section: diag.section, documentNumber: diag.documentNumber }));
    } else if (code === 'DOCUMENT_FY_MISMATCH') {
      warnings.push(warning('DOCUMENT_FY_MISMATCH', diag.message, { section: diag.section, documentNumber: diag.documentNumber }));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. B2B / B2CL numeric validation
// ─────────────────────────────────────────────────────────────────────────────

function checkB2bNumeric(invoices: Gstr1GstnB2bInvoice[], blockers: Gstr1GstnValidationIssue[]): void {
  for (const inv of invoices) {
    const ctx = { section: 'B2B', documentNumber: inv.invoiceNumber };
    pushIfNotFinite(blockers, 'invoiceValue', inv.invoiceValue, ctx);
    pushIfNotFinite(blockers, 'taxableValue', inv.taxableValue, ctx);
    pushIfNotFinite(blockers, 'cgst', inv.cgst, ctx);
    pushIfNotFinite(blockers, 'sgst', inv.sgst, ctx);
    pushIfNotFinite(blockers, 'igst', inv.igst, ctx);
    pushIfNotFinite(blockers, 'cess', inv.cess, ctx);
    for (const rg of inv.rateGroups) {
      pushIfNotFinite(blockers, 'rateGroups.rate', rg.rate, ctx);
      pushIfNotFinite(blockers, 'rateGroups.taxableValue', rg.taxableValue, ctx);
      pushIfNotFinite(blockers, 'rateGroups.igst', rg.igst, ctx);
      pushIfNotFinite(blockers, 'rateGroups.cgst', rg.cgst, ctx);
      pushIfNotFinite(blockers, 'rateGroups.sgst', rg.sgst, ctx);
      pushIfNotFinite(blockers, 'rateGroups.cess', rg.cess, ctx);
    }
  }
}

function checkB2clNumeric(invoices: Gstr1GstnB2clInvoice[], blockers: Gstr1GstnValidationIssue[]): void {
  for (const inv of invoices) {
    const ctx = { section: 'B2CL', documentNumber: inv.invoiceNumber };
    pushIfNotFinite(blockers, 'invoiceValue', inv.invoiceValue, ctx);
    pushIfNotFinite(blockers, 'taxableValue', inv.taxableValue, ctx);
    pushIfNotFinite(blockers, 'igst', inv.igst, ctx);
    pushIfNotFinite(blockers, 'cess', inv.cess, ctx);
    for (const rg of inv.rateGroups) {
      pushIfNotFinite(blockers, 'rateGroups.rate', rg.rate, ctx);
      pushIfNotFinite(blockers, 'rateGroups.taxableValue', rg.taxableValue, ctx);
      pushIfNotFinite(blockers, 'rateGroups.igst', rg.igst, ctx);
      pushIfNotFinite(blockers, 'rateGroups.cess', rg.cess, ctx);
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. B2CS — Table 7
// ─────────────────────────────────────────────────────────────────────────────

function checkB2cs(records: Gstr1GstnB2csRecord[], blockers: Gstr1GstnValidationIssue[]): void {
  records.forEach((r, idx) => {
    const ctx = { section: 'B2CS', placeOfSupply: r.placeOfSupply, rate: r.rate, index: idx };
    pushIfNotFinite(blockers, 'taxableValue', r.taxableValue, ctx);
    pushIfNotFinite(blockers, 'igst', r.igst, ctx);
    pushIfNotFinite(blockers, 'cgst', r.cgst, ctx);
    pushIfNotFinite(blockers, 'sgst', r.sgst, ctx);
    pushIfNotFinite(blockers, 'cess', r.cess, ctx);
    if (Number.isFinite(r.taxableValue) && r.taxableValue < 0) {
      blockers.push(blocker('NEGATIVE_B2CS_BUCKET', `B2CS bucket (place of supply ${r.placeOfSupply}, rate ${r.rate}%) has a negative taxable value (${r.taxableValue}).`, ctx));
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. CDNR / CDNUR — Table 9B
// ─────────────────────────────────────────────────────────────────────────────

function checkNoteNumeric(note: { noteValue: number; taxableValue: number; igst: number; cess: number; cgst?: number; sgst?: number; rateGroups: { rate: number; taxableValue: number; igst: number; cgst: number; sgst: number; cess: number }[] }, ctx: Record<string, unknown>, blockers: Gstr1GstnValidationIssue[]): void {
  pushIfNotFinite(blockers, 'noteValue', note.noteValue, ctx);
  pushIfNotFinite(blockers, 'taxableValue', note.taxableValue, ctx);
  pushIfNotFinite(blockers, 'igst', note.igst, ctx);
  pushIfNotFinite(blockers, 'cess', note.cess, ctx);
  if (note.cgst !== undefined) pushIfNotFinite(blockers, 'cgst', note.cgst, ctx);
  if (note.sgst !== undefined) pushIfNotFinite(blockers, 'sgst', note.sgst, ctx);
  for (const rg of note.rateGroups) {
    pushIfNotFinite(blockers, 'rateGroups.rate', rg.rate, ctx);
    pushIfNotFinite(blockers, 'rateGroups.taxableValue', rg.taxableValue, ctx);
    pushIfNotFinite(blockers, 'rateGroups.igst', rg.igst, ctx);
    pushIfNotFinite(blockers, 'rateGroups.cgst', rg.cgst, ctx);
    pushIfNotFinite(blockers, 'rateGroups.sgst', rg.sgst, ctx);
    pushIfNotFinite(blockers, 'rateGroups.cess', rg.cess, ctx);
  }
}

function checkCdnr(notes: Gstr1GstnCdnrNote[], blockers: Gstr1GstnValidationIssue[]): void {
  for (const note of notes) {
    const ctx = { section: 'CDNR', documentNumber: note.noteNumber };
    if (note.noteType !== 'C' && note.noteType !== 'D') {
      blockers.push(blocker('INVALID_NOTE_TYPE', `CDNR note ${note.noteNumber} has an unrecognized note type "${note.noteType}" — GSTN only accepts 'C' (Credit Note) or 'D' (Debit Note).`, ctx));
    }
    // "registered recipients appear in CDNR": CDNR is, by definition, the registered-recipient
    // table — a blank/unresolvable recipientGstin here is a real, blocking data-quality gap (the
    // document cannot be placed in CDNR without one). A malformed-but-present GSTIN is validated
    // with the shared structural checker, never a duplicated checksum algorithm.
    if (!note.recipientGstin || note.recipientGstin.trim() === '') {
      blockers.push(blocker('MISSING_CDNR_RECIPIENT_GSTIN', `CDNR note ${note.noteNumber} has no recipient GSTIN.`, ctx));
    } else {
      const gstinResult = validateGstin(note.recipientGstin);
      if (!gstinResult.valid) {
        blockers.push(blocker('INVALID_CDNR_RECIPIENT_GSTIN', `CDNR note ${note.noteNumber}'s recipient GSTIN "${note.recipientGstin}" failed validation: ${gstinResult.errors.join('; ')}`, ctx));
      }
    }
    checkNoteNumeric(note, ctx, blockers);
  }
  // "procurement DebitNotes never appear in outward export": not independently checkable from the
  // DTO — `Gstr1GstnCdnrNote` carries no field that could identify a procurement origin at all (by
  // construction: gstr1GstnAdapter.ts's only debit-note input type is the frozen sales-side
  // Gstr1SalesDebitNoteAggregation, which is structurally incompatible with the procurement
  // DebitNote model — see that adapter's own header comment). This is an inherited guarantee from
  // the frozen pipeline, not something this validator can re-verify from the DTO alone.
}

function checkCdnur(notes: Gstr1GstnCdnurNote[], blockers: Gstr1GstnValidationIssue[]): void {
  for (const note of notes) {
    const ctx = { section: 'CDNUR', documentNumber: note.noteNumber };
    if (note.noteType !== 'C' && note.noteType !== 'D') {
      blockers.push(blocker('INVALID_NOTE_TYPE', `CDNUR note ${note.noteNumber} has an unrecognized note type "${note.noteType}" — GSTN only accepts 'C' (Credit Note) or 'D' (Debit Note).`, ctx));
    }
    checkNoteNumeric(note, ctx, blockers);
  }
  // "eligible B2CL-origin unregistered notes appear in CDNUR" / "B2CS-origin notes represented
  // through the B2CS adjustment path": neither is checkable from the DTO — `Gstr1GstnCdnurNote`
  // carries no "original supply category" field, and any B2CS-origin netting already happened
  // upstream inside the frozen outward aggregation before this DTO was ever built (see
  // gstr1CreditNoteAggregation.ts's own module header on `b2csNetOff`). Both are inherited
  // guarantees from the frozen pipeline, not independently re-verifiable here.
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. HSN summary — Table 12
// ─────────────────────────────────────────────────────────────────────────────

function checkHsnRows(
  rows: Gstr1GstnHsnSummaryRow[],
  reportingTab: 'B2B' | 'B2C',
  precedingFy: { verificationState: Gstr1AatoVerificationState; amount: number | null },
  blockers: Gstr1GstnValidationIssue[],
): void {
  const seen = new Map<string, number>();
  rows.forEach((row, idx) => {
    const ctx = { section: `TABLE_12_${reportingTab}`, hsnCode: row.hsnCode, uqc: row.uqc, rate: row.rate, index: idx };

    // Structural HSN shape — independent of the AATO digit mandate.
    if (!row.hsnCode) {
      blockers.push(blocker('MISSING_HSN', `Table 12 (${reportingTab}) row at rate ${row.rate}% has no HSN code.`, ctx));
    } else if (!isPlausibleHsnCode(row.hsnCode)) {
      blockers.push(blocker('INVALID_HSN', `Table 12 (${reportingTab}) HSN code "${row.hsnCode}" is not a plausible numeric 4-8 digit HSN code.`, ctx));
    } else {
      const mandated = resolveMandatedHsnDigits(reportingTab, precedingFy.verificationState, precedingFy.amount);
      if (mandated != null && row.hsnCode.trim().length < mandated) {
        blockers.push(blocker(
          'HSN_DIGIT_LENGTH_BELOW_MANDATE',
          `HSN code "${row.hsnCode}" has ${row.hsnCode.trim().length} digits, below the ${mandated}-digit minimum mandated for this registration's preceding-FY AATO (Notification No. 78/2020).`,
          ctx,
        ));
      }
    }

    // UQC — missing/'NONE'/unrecognized are all "unsupported" under rule 8.
    if (!row.uqc || normalizeGstUqc(row.uqc) == null) {
      blockers.push(blocker('UNSUPPORTED_UQC', `Table 12 (${reportingTab}) row (HSN ${row.hsnCode ?? '(missing)'}) has an unsupported UQC "${row.uqc ?? '(none)'}".`, ctx));
    }

    pushIfNotFinite(blockers, 'quantity', row.quantity, ctx);
    pushIfNotFinite(blockers, 'taxableValue', row.taxableValue, ctx);
    pushIfNotFinite(blockers, 'igst', row.igst, ctx);
    pushIfNotFinite(blockers, 'cgst', row.cgst, ctx);
    pushIfNotFinite(blockers, 'sgst', row.sgst, ctx);
    pushIfNotFinite(blockers, 'cess', row.cess, ctx);
    if (row.totalValue != null) pushIfNotFinite(blockers, 'totalValue', row.totalValue, ctx);

    const hasNegative = (Number.isFinite(row.quantity) && row.quantity < 0) || (Number.isFinite(row.taxableValue) && row.taxableValue < 0);
    if (hasNegative) {
      blockers.push(blocker('NEGATIVE_TABLE12_BUCKET', `Table 12 (${reportingTab}) bucket (HSN ${row.hsnCode ?? '(missing)'}, rate ${row.rate}%, UQC ${row.uqc ?? '(none)'}) has a negative quantity or taxable value.`, ctx));
    }

    // Uniqueness the canonical DTO's own construction promises (one bucket per HSN+UQC+rate within
    // a reporting tab — see gstr1Table12Aggregation.ts's own bucketKey()). A duplicate here means
    // the promise was broken somewhere upstream of this validator.
    const dupKey = `${row.hsnCode ?? ''}\u0000${row.uqc ?? ''}\u0000${row.rate}`;
    const firstIdx = seen.get(dupKey);
    if (firstIdx !== undefined) {
      blockers.push(blocker('DUPLICATE_HSN_BUCKET', `Table 12 (${reportingTab}) has more than one row for HSN ${row.hsnCode ?? '(missing)'}/UQC ${row.uqc ?? '(none)'}/rate ${row.rate}% (rows ${firstIdx} and ${idx}) — the canonical export promises uniqueness on this key.`, ctx));
    } else {
      seen.set(dupKey, idx);
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. Documents Issued — Table 13
// ─────────────────────────────────────────────────────────────────────────────

function documentSeriesIdentityKey(s: Gstr1GstnDocumentSeries): string {
  return `${s.documentCategory}\u0000${s.sellerRegistrationId ?? ''}\u0000${s.seriesPrefix}\u0000${s.financialYear ?? ''}`;
}

const KNOWN_DOCUMENT_CATEGORIES = new Set(['INVOICES_FOR_OUTWARD_SUPPLY', 'CREDIT_NOTE', 'DEBIT_NOTE']);

function checkDocumentsIssued(series: Gstr1GstnDocumentSeries[], blockers: Gstr1GstnValidationIssue[], warnings: Gstr1GstnValidationIssue[]): void {
  for (const s of series) {
    const ctx = { section: 'TABLE_13', documentCategory: s.documentCategory, sellerRegistrationId: s.sellerRegistrationId, fromDocumentNumber: s.fromDocumentNumber, toDocumentNumber: s.toDocumentNumber };

    if (!KNOWN_DOCUMENT_CATEGORIES.has(s.documentCategory)) {
      blockers.push(blocker('INVALID_DOCUMENT_CATEGORY', `Document series has an unrecognized category "${s.documentCategory}".`, ctx));
    }

    for (const num of [s.fromDocumentNumber, s.toDocumentNumber]) {
      if (!isValidDocumentNumber(num)) {
        blockers.push(blocker('INVALID_DOCUMENT_NUMBER', `Document number "${num}" violates Rule 46(b) (must be 1-16 characters, alphanumeric plus '-'/'/' only).`, ctx));
      }
    }

    pushIfNotFinite(blockers, 'fromSerial', s.fromSerial, ctx);
    pushIfNotFinite(blockers, 'toSerial', s.toSerial, ctx);
    pushIfNotFinite(blockers, 'totalIssued', s.totalIssued, ctx);
    pushIfNotFinite(blockers, 'cancelled', s.cancelled, ctx);
    pushIfNotFinite(blockers, 'netIssued', s.netIssued, ctx);

    if (Number.isFinite(s.fromSerial) && Number.isFinite(s.toSerial) && s.fromSerial > s.toSerial) {
      blockers.push(blocker('INVALID_DOCUMENT_RANGE', `Document series "from" serial (${s.fromSerial}) is after its "to" serial (${s.toSerial}).`, ctx));
    }
    if ((Number.isFinite(s.totalIssued) && s.totalIssued < 0) || (Number.isFinite(s.cancelled) && s.cancelled < 0) || (Number.isFinite(s.netIssued) && s.netIssued < 0)) {
      blockers.push(blocker('NEGATIVE_DOCUMENT_COUNT', `Document series has a negative totalIssued/cancelled/netIssued count.`, ctx));
    }
    if (Number.isFinite(s.totalIssued) && Number.isFinite(s.cancelled) && Number.isFinite(s.netIssued) && s.netIssued !== s.totalIssued - s.cancelled) {
      blockers.push(blocker('INCONSISTENT_DOCUMENT_COUNTS', `Document series netIssued (${s.netIssued}) does not equal totalIssued (${s.totalIssued}) minus cancelled (${s.cancelled}) — never a manufactured cancellation count.`, ctx));
    }

    // Trusts the frozen Table 13 engine's own `filingEligible` computation directly (duplicate doc
    // id, duplicate serial, FY mismatch, or a legacy/no-registration series all already resolve to
    // false there) rather than re-deriving each individual reason from scratch, which would risk
    // diverging from that frozen engine's own logic.
    if (!s.filingEligible) {
      blockers.push(blocker('DOCUMENT_SERIES_NOT_FILING_ELIGIBLE', `Document series (${s.documentCategory}, ${s.fromDocumentNumber}-${s.toDocumentNumber}) was marked not filing-eligible by the source aggregation (duplicate serial/document id, FY mismatch, or missing seller registration).`, ctx));
    }
  }

  // Cross-entry checks within one statutory series identity: overlapping serial ranges (including
  // an exact duplicate) are a blocker; a genuine numeric gap between two ranges is a warning only
  // (brief: "never convert a gap into a cancellation"). Re-derived here from the DTO's own serial
  // ranges rather than from a Table13Diagnostic code the DTO cannot carry (see this file's header).
  const byIdentity = new Map<string, Gstr1GstnDocumentSeries[]>();
  for (const s of series) {
    const key = documentSeriesIdentityKey(s);
    const list = byIdentity.get(key) ?? [];
    list.push(s);
    byIdentity.set(key, list);
  }
  for (const list of byIdentity.values()) {
    if (list.length < 2) continue;
    const sorted = [...list].sort((a, b) => a.fromSerial - b.fromSerial);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const curr = sorted[i];
      const ctx = { section: 'TABLE_13', documentCategory: curr.documentCategory, sellerRegistrationId: curr.sellerRegistrationId, seriesPrefix: curr.seriesPrefix, financialYear: curr.financialYear };
      if (curr.fromSerial <= prev.toSerial) {
        blockers.push(blocker('DUPLICATE_DOCUMENT_SERIAL', `Document series identity (${curr.documentCategory}/${curr.seriesPrefix}/FY ${curr.financialYear ?? 'n/a'}) has overlapping or duplicate serial ranges: ${prev.fromSerial}-${prev.toSerial} and ${curr.fromSerial}-${curr.toSerial}.`, ctx));
      } else if (curr.fromSerial > prev.toSerial + 1) {
        warnings.push(warning('UNEXPLAINED_SEQUENCE_GAP', `Document series identity (${curr.documentCategory}/${curr.seriesPrefix}/FY ${curr.financialYear ?? 'n/a'}) has an unexplained gap between serials ${prev.toSerial} and ${curr.fromSerial} — never treated as a cancellation.`, ctx));
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. Traceability — partial-traceability warning
// ─────────────────────────────────────────────────────────────────────────────

function checkTraceability(dto: Gstr1GstnExportDto, warnings: Gstr1GstnValidationIssue[]): void {
  const t = dto.traceability;
  const cdnrCredits = dto.cdnr.filter((n) => n.noteType === 'C').length;
  const cdnrDebits = dto.cdnr.filter((n) => n.noteType === 'D').length;
  const cdnurCredits = dto.cdnur.filter((n) => n.noteType === 'C').length;
  const cdnurDebits = dto.cdnur.filter((n) => n.noteType === 'D').length;

  const mismatches: string[] = [];
  if (t.b2bInvoiceIds.length !== dto.b2b.length) mismatches.push('b2b');
  if (t.b2clInvoiceIds.length !== dto.b2cl.length) mismatches.push('b2cl');
  if (t.cdnrCreditNoteIds.length !== cdnrCredits) mismatches.push('cdnrCreditNoteIds');
  if (t.cdnrDebitNoteIds.length !== cdnrDebits) mismatches.push('cdnrDebitNoteIds');
  if (t.cdnurCreditNoteIds.length !== cdnurCredits) mismatches.push('cdnurCreditNoteIds');
  if (t.cdnurDebitNoteIds.length !== cdnurDebits) mismatches.push('cdnurDebitNoteIds');

  if (mismatches.length > 0) {
    warnings.push(warning(
      'PARTIAL_TRACEABILITY',
      `Internal traceability is incomplete relative to the GSTN-facing arrays (mismatched counts: ${mismatches.join(', ')}) — the GSTN payload itself is unaffected; traceability is never fabricated to make the counts agree.`,
      { section: 'TRACEABILITY', mismatches },
    ));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The validator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Validates a canonical GSTR-1 GSTN export DTO for filing-grade structural and compliance
 * readiness. Pure and side-effect free: no Prisma, no Date.now(), no randomness, no mutation of the
 * input DTO — same input always produces the same output. Does NOT prove GSTN will accept the
 * eventual JSON (see this file's header).
 */
export function validateGstr1GstnExport(dto: Gstr1GstnExportDto): Gstr1GstnValidationResult {
  const blockers: Gstr1GstnValidationIssue[] = [];
  const warnings: Gstr1GstnValidationIssue[] = [];

  checkGstin(dto, blockers);
  checkFilingPeriod(dto, blockers);
  checkBranchScope(dto, blockers);
  checkAatoPrecedingFy(dto, blockers);

  checkAdapterDiagnostics(dto, blockers, warnings);
  checkForwardCompatibleDiagnostics(dto, blockers, warnings);

  checkB2bNumeric(dto.b2b, blockers);
  checkB2clNumeric(dto.b2cl, blockers);
  checkB2cs(dto.b2cs, blockers);
  checkCdnr(dto.cdnr, blockers);
  checkCdnur(dto.cdnur, blockers);

  checkHsnRows(dto.hsnB2b, 'B2B', dto.metadata.aato.precedingFy, blockers);
  checkHsnRows(dto.hsnB2c, 'B2C', dto.metadata.aato.precedingFy, blockers);

  checkDocumentsIssued(dto.documentsIssued, blockers, warnings);
  checkTraceability(dto, warnings);

  return { isValid: blockers.length === 0, blockers, warnings };
}
