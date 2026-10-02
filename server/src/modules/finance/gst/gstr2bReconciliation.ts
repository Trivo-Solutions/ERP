// G2g-7e — GSTR-2B vs. books reconciliation engine (brief §10-§20). Pure, deterministic, side-effect
// free: no Prisma, no Date.now(), no HTTP imports. Parallel in shape to gstr3bRcmAggregation.ts
// (G2g-7d, frozen) and gstr3bItcAggregation.ts (G2g-7c, frozen) — diagnostics array, explicit
// per-line status, report-level capability-gap diagnostics emitted once — but this file is NEW and
// independent of both; it never imports from or modifies either.
//
// QUALITY RULE (brief §32, restated because it is the single most important constraint on this
// file): do not optimize for a high match rate. A false EXACT_MATCH is worse than an honest
// POSSIBLE_MATCH or UNRESOLVED — every escalation to a confident status below requires genuine
// identity evidence (matching GSTIN + document number, exact or safely normalized), never amount
// proximity alone.
//
// GSTR-2B is a reconciliation source, not a final ITC determination (brief §16) — this engine never
// produces a "final eligible ITC" figure; see Gst2bDiagnostic GSTR_2B_IS_NOT_FINAL_ITC_ELIGIBILITY,
// always emitted once, and PHASE_G2G7E_IMPLEMENTATION.md for how this feeds (without replacing)
// G2g-7c's own ELIGIBLE/UNRESOLVED/INELIGIBLE classification.

import type { BranchAccess } from '../../../shared/tenantContext';
import type {
  Gstr2bBookInvoiceLine,
  Gstr2bBookReturnLine,
  Gstr2bDiagnostic,
  Gstr2bDocumentForMatch,
  Gstr2bMatchResult,
  Gstr2bMatchStatus,
  Gstr2bMoneyTotals,
  Gstr2bReconciliationResult,
  Gstr2bReconciliationSummary,
  Gstr2bTwoBItcAvailability,
} from './gstr2b.types';

export class Gstr2bReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Gstr2bReconciliationError';
  }
}

const DEFAULT_TOLERANCE_RUPEES = 1; // brief §13: a small, fixed, deterministic rounding tolerance.
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function emptyTotals(): Gstr2bMoneyTotals {
  return { taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0 };
}

function addInto(bucket: Gstr2bMoneyTotals, t: Gstr2bMoneyTotals) {
  bucket.taxableValue = round2(bucket.taxableValue + t.taxableValue);
  bucket.igst = round2(bucket.igst + t.igst);
  bucket.cgst = round2(bucket.cgst + t.cgst);
  bucket.sgst = round2(bucket.sgst + t.sgst);
  bucket.cess = round2(bucket.cess + t.cess);
}

/** Level 2 matching (brief §11): strips separators/whitespace and upper-cases. "INV/001" ==
 *  "INV-001" == "inv 001" == "INV001" under this normalization. Never strips digits or letters
 *  themselves — only punctuation/whitespace this codebase has observed as harmless formatting noise. */
function normalizeDocNumberForMatching(docNumber: string | null): string | null {
  if (!docNumber) return null;
  const n = docNumber.toUpperCase().replace(/[\s\-/\\._]/g, '');
  return n || null;
}

function sameCalendarDay(a: Date | null, b: Date | null): boolean {
  if (!a || !b) return false;
  return a.toISOString().slice(0, 10) === b.toISOString().slice(0, 10);
}

function docTotals(d: { taxableValue: number; igst: number; cgst: number; sgst: number; cess: number }): Gstr2bMoneyTotals {
  return { taxableValue: d.taxableValue, igst: d.igst, cgst: d.cgst, sgst: d.sgst, cess: d.cess };
}

function totalTax(t: Gstr2bMoneyTotals): number {
  return round2(t.igst + t.cgst + t.sgst + t.cess);
}

/** The GSTR-2B-side availability for a match, read honestly off the 2B document — UNKNOWN (never
 *  AVAILABLE) when there is no 2B document on this match at all, or the source payload didn't
 *  state one. Independent of matchStatus — see Gstr2bMatchResult.twoBItcAvailability. */
function twoBAvailabilityOf(d: Gstr2bDocumentForMatch | null | undefined): {
  twoBItcAvailability: Gstr2bTwoBItcAvailability;
  twoBIneligibilityReason: string | null;
} {
  if (!d || !d.itcAvailability) return { twoBItcAvailability: 'UNKNOWN', twoBIneligibilityReason: null };
  return {
    twoBItcAvailability: d.itcAvailability,
    twoBIneligibilityReason: d.itcAvailability === 'NOT_AVAILABLE' ? d.ineligibilityReason : null,
  };
}

const UNKNOWN_AVAILABILITY = { twoBItcAvailability: 'UNKNOWN' as const, twoBIneligibilityReason: null };

function resolveAllowedBranchIds(branchAccess: BranchAccess | undefined, branchId: string | null | undefined): string[] | undefined {
  if (branchId?.trim()) return [branchId.trim()];
  if (branchAccess && !branchAccess.allBranches) return branchAccess.branchIds;
  return undefined;
}

export interface Gstr2bReconciliationInputOptions {
  companyId: string;
  gstRegistrationId: string;
  financialYear: string;
  taxPeriod: string;
  statementId: string | null;
  statementVersion: number | null;
  statementImportedAt: Date | null;
  amountToleranceRupees?: number;
  branchAccess?: BranchAccess;
  branchId?: string | null;
}

export function reconcileGstr2b(
  twoBDocuments: Gstr2bDocumentForMatch[],
  bookInvoiceLines: Gstr2bBookInvoiceLine[],
  bookReturnLines: Gstr2bBookReturnLine[],
  options: Gstr2bReconciliationInputOptions,
): Gstr2bReconciliationResult {
  const tolerance = options.amountToleranceRupees ?? DEFAULT_TOLERANCE_RUPEES;
  const diagnostics: Gstr2bDiagnostic[] = [];
  const matches: Gstr2bMatchResult[] = [];

  const allowedBranchIds = resolveAllowedBranchIds(options.branchAccess, options.branchId);
  const isBranchRestricted = !!allowedBranchIds;
  if (isBranchRestricted) {
    diagnostics.push({
      code: 'PARTIAL_BRANCH_SCOPE',
      reason: 'This reconciliation is restricted to one or more branches. GSTR-2B itself has no branch concept (it belongs to the GST registration as a whole) — a book document outside the visible branch(es) is correctly excluded from the book side here, so it will appear as TWO_B_MISSING rather than matched, even though it may genuinely exist outside this view.',
    });
  }

  const scopedBookInvoiceLines = allowedBranchIds
    ? bookInvoiceLines.filter((l) => l.branchId && allowedBranchIds.includes(l.branchId))
    : bookInvoiceLines;

  // Only documents that currently represent the "live" figure participate in matching/totals — a
  // document flipped to SUPERSEDED by a resolved amendment link is excluded (brief §15: avoid
  // double counting); CURRENT/AMENDED/ORIGINAL (the latter only when an amendment link could not be
  // confidently resolved — see gstr2bImport.service.ts) all still participate, each reported
  // separately when unresolved, flagged via AMENDMENT_LINK_NOT_RESOLVED rather than guessed-merged.
  const participatingTwoB = twoBDocuments.filter((d) => d.provenanceStatus !== 'SUPERSEDED');

  const notSupported = participatingTwoB.filter((d) => d.supportStatus !== 'SUPPORTED');
  const supportedInvoices = participatingTwoB.filter((d) => d.supportStatus === 'SUPPORTED' && d.documentType === 'INVOICE');
  const supportedNotes = participatingTwoB.filter((d) => d.supportStatus === 'SUPPORTED' && d.documentType === 'CREDIT_NOTE');

  for (const d of notSupported) {
    matches.push({
      status: 'NOT_SUPPORTED',
      section: d.section,
      documentType: d.documentType,
      twoBDocumentId: d.id,
      bookReferenceId: null,
      supplierGstin: d.supplierGstin,
      documentNumber: d.documentNumber,
      twoB: docTotals(d),
      book: null,
      reason: d.supportStatus === 'ISD_NOT_SUPPORTED'
        ? 'ISD credit distribution is not modeled in this codebase — preserved faithfully, not reconciled (brief §8).'
        : 'No Bill-of-Entry/import purchase model exists in this codebase — preserved faithfully, not reconciled against books (brief §7).',
      ...twoBAvailabilityOf(d),
    });
  }
  const importCount = notSupported.filter((d) => d.section === 'IMPG' || d.section === 'IMPGSEZ').length;
  const isdCount = notSupported.filter((d) => d.section === 'ISD' || d.section === 'ISDA').length;
  if (importCount > 0) diagnostics.push({ code: 'IMPORTS_NOT_RECONCILABLE', reason: `${importCount} import document(s) (IMPG/IMPGSEZ) were preserved but not reconciled — no Bill-of-Entry/import model exists in this codebase.` });
  if (isdCount > 0) diagnostics.push({ code: 'ISD_NOT_SUPPORTED', reason: `${isdCount} ISD document(s) were preserved but not reconciled — no ISD module exists in this codebase.` });

  // ── Invoice (B2B/B2BA) matching ──────────────────────────────────────────
  const claimedInvoiceGrnIds = new Set<string>();
  const exactIndex = new Map<string, Gstr2bBookInvoiceLine[]>();
  const normalizedIndex = new Map<string, Gstr2bBookInvoiceLine[]>();
  const gstinIndex = new Map<string, Gstr2bBookInvoiceLine[]>();
  for (const line of scopedBookInvoiceLines) {
    const gstin = line.supplierGstin ?? '';
    if (line.invoiceNumber) {
      const exactKey = `${gstin}|||${line.invoiceNumber}`;
      (exactIndex.get(exactKey) ?? exactIndex.set(exactKey, []).get(exactKey)!).push(line);
      const normKey = `${gstin}|||${normalizeDocNumberForMatching(line.invoiceNumber)}`;
      (normalizedIndex.get(normKey) ?? normalizedIndex.set(normKey, []).get(normKey)!).push(line);
    }
    (gstinIndex.get(gstin) ?? gstinIndex.set(gstin, []).get(gstin)!).push(line);
  }

  for (const d of supportedInvoices) {
    const gstin = d.supplierGstin ?? '';
    const exactKey = `${gstin}|||${d.documentNumber ?? ''}`;
    const normKey = `${gstin}|||${normalizeDocNumberForMatching(d.documentNumber)}`;

    let candidate: Gstr2bBookInvoiceLine | undefined;
    let tier: 'EXACT' | 'NORMALIZED' | 'POSSIBLE' | 'NONE' = 'NONE';

    const exactCandidates = (exactIndex.get(exactKey) ?? []).filter((l) => !claimedInvoiceGrnIds.has(l.grnId) && sameCalendarDay(d.documentDate, l.invoiceDate));
    if (exactCandidates.length > 0) {
      candidate = exactCandidates[0];
      tier = 'EXACT';
    } else {
      const normCandidates = (normalizedIndex.get(normKey) ?? []).filter((l) => !claimedInvoiceGrnIds.has(l.grnId) && sameCalendarDay(d.documentDate, l.invoiceDate));
      if (normCandidates.length > 0) {
        candidate = normCandidates[0];
        tier = 'NORMALIZED';
      } else {
        // Level 3 — controlled fuzzy candidate: same supplier GSTIN, same calendar day, never
        // escalated past POSSIBLE_MATCH regardless of amount agreement (brief §11/§32).
        const fuzzyCandidates = (gstinIndex.get(gstin) ?? []).filter((l) => !claimedInvoiceGrnIds.has(l.grnId) && sameCalendarDay(d.documentDate, l.invoiceDate));
        if (fuzzyCandidates.length > 0) {
          candidate = fuzzyCandidates[0];
          tier = 'POSSIBLE';
        }
      }
    }

    if (!candidate) {
      matches.push({
        status: 'TWO_B_MISSING',
        section: d.section,
        documentType: d.documentType,
        twoBDocumentId: d.id,
        bookReferenceId: null,
        supplierGstin: d.supplierGstin,
        documentNumber: d.documentNumber,
        twoB: docTotals(d),
        book: null,
        reason: 'This GSTR-2B document could not be matched to any book GRN for this supplier/date within scope.',
        ...twoBAvailabilityOf(d),
      });
      continue;
    }

    claimedInvoiceGrnIds.add(candidate.grnId);
    const twoBTotals = docTotals(d);
    const bookTotals: Gstr2bMoneyTotals = { taxableValue: candidate.taxableValue, igst: candidate.igst, cgst: candidate.cgst, sgst: candidate.sgst, cess: 0 };
    const taxableDiff = Math.abs(twoBTotals.taxableValue - bookTotals.taxableValue);
    const taxDiff = Math.abs(totalTax(twoBTotals) - totalTax(bookTotals));
    const rcmDisagrees = d.reverseCharge !== candidate.hasRcmLiability;

    let status: Gstr2bMatchStatus;
    let reason: string;
    if (tier === 'POSSIBLE') {
      status = 'POSSIBLE_MATCH';
      reason = `Matched by supplier GSTIN and document date only (document-number identity did not line up exactly or under normalization) — treat as a candidate for manual review, not a confirmed match.${rcmDisagrees ? ' Reverse-charge flags also disagree between 2B and books.' : ''}`;
    } else if (taxableDiff > tolerance) {
      status = 'AMOUNT_MISMATCH';
      reason = `Taxable value differs by ₹${taxableDiff.toFixed(2)} (beyond the ₹${tolerance.toFixed(2)} tolerance) between 2B (₹${twoBTotals.taxableValue.toFixed(2)}) and books (₹${bookTotals.taxableValue.toFixed(2)}).`;
    } else if (taxDiff > tolerance) {
      status = 'TAX_MISMATCH';
      reason = `Taxable value matches, but total tax differs by ₹${taxDiff.toFixed(2)} (beyond the ₹${tolerance.toFixed(2)} tolerance) between 2B and books.`;
    } else if (rcmDisagrees) {
      status = 'RCM_MISMATCH';
      reason = `Amounts agree, but the reverse-charge flag disagrees: GSTR-2B marks this document reverseCharge=${d.reverseCharge}, while the book side ${candidate.hasRcmLiability ? 'has' : 'has no'} a self-assessed RCM liability for it.`;
    } else {
      status = tier === 'EXACT' ? 'EXACT_MATCH' : 'MATCHED_WITH_NORMALIZATION';
      reason = tier === 'EXACT' ? 'Supplier GSTIN, document number, and date match exactly; amounts agree within tolerance.' : 'Supplier GSTIN and date match exactly; document number matched only after stripping formatting differences (e.g. separators/case). Amounts agree within tolerance.';
    }

    matches.push({
      status,
      section: d.section,
      documentType: d.documentType,
      twoBDocumentId: d.id,
      bookReferenceId: candidate.grnId,
      supplierGstin: d.supplierGstin,
      documentNumber: d.documentNumber,
      twoB: twoBTotals,
      book: bookTotals,
      reason,
      ...twoBAvailabilityOf(d),
    });
  }

  for (const line of scopedBookInvoiceLines) {
    if (claimedInvoiceGrnIds.has(line.grnId)) continue;
    matches.push({
      status: 'BOOK_MISSING',
      section: null,
      documentType: 'INVOICE',
      twoBDocumentId: null,
      bookReferenceId: line.grnId,
      supplierGstin: line.supplierGstin,
      documentNumber: line.invoiceNumber,
      twoB: null,
      book: { taxableValue: line.taxableValue, igst: line.igst, cgst: line.cgst, sgst: line.sgst, cess: 0 },
      reason: 'This book GRN/invoice has no corresponding document in the current GSTR-2B statement for this period — the supplier may not have filed yet, or filed under a different period.',
      ...UNKNOWN_AVAILABILITY,
    });
  }

  // ── Credit-note (CDNR/CDNRA) matching — POSSIBLE_MATCH ceiling only (PHASE_G2G7E_AUDIT.md §1/§3) ──
  const claimedReturnIds = new Set<string>();
  if (supportedNotes.length > 0 || bookReturnLines.length > 0) {
    diagnostics.push({
      code: 'CDNR_MATCHING_LIMITED_TO_POSSIBLE',
      reason: 'This codebase has no field capturing a supplier-issued credit/debit note number (PurchaseReturn/DebitNote record TRIVO\'s own return, not the supplier\'s statutory Section-34 note) — CDNR/CDNRA matching is therefore capped at POSSIBLE_MATCH confidence (supplier GSTIN + amount proximity only), never EXACT_MATCH/MATCHED_WITH_NORMALIZATION.',
    });
  }
  for (const d of supportedNotes) {
    const gstin = d.supplierGstin ?? '';
    const twoBTotals = docTotals(d);
    const candidate = bookReturnLines.find((r) => !claimedReturnIds.has(r.returnId) && (r.supplierGstin ?? '') === gstin && Math.abs(r.amount - twoBTotals.taxableValue) <= tolerance * 5);
    if (!candidate) {
      matches.push({
        status: 'TWO_B_MISSING', section: d.section, documentType: d.documentType, twoBDocumentId: d.id, bookReferenceId: null,
        supplierGstin: d.supplierGstin, documentNumber: d.documentNumber, twoB: twoBTotals, book: null,
        reason: 'No book purchase return for this supplier at a comparable value was found for this period.',
        ...twoBAvailabilityOf(d),
      });
      continue;
    }
    claimedReturnIds.add(candidate.returnId);
    matches.push({
      status: 'POSSIBLE_MATCH', section: d.section, documentType: d.documentType, twoBDocumentId: d.id, bookReferenceId: candidate.returnId,
      supplierGstin: d.supplierGstin, documentNumber: d.documentNumber, twoB: twoBTotals,
      book: { taxableValue: candidate.amount, igst: candidate.igst, cgst: candidate.cgst, sgst: candidate.sgst, cess: 0 },
      reason: 'Matched to a book purchase return by supplier GSTIN and approximate value only — no shared document-number identity exists in this data model (see CDNR_MATCHING_LIMITED_TO_POSSIBLE).',
      ...twoBAvailabilityOf(d),
    });
  }
  for (const r of bookReturnLines) {
    if (claimedReturnIds.has(r.returnId)) continue;
    matches.push({
      status: 'BOOK_MISSING', section: null, documentType: 'CREDIT_NOTE', twoBDocumentId: null, bookReferenceId: r.returnId,
      supplierGstin: r.supplierGstin, documentNumber: null,
      twoB: null, book: { taxableValue: r.amount, igst: r.igst, cgst: r.cgst, sgst: r.sgst, cess: 0 },
      reason: 'This book purchase return has no corresponding credit note in the current GSTR-2B statement for this period.',
      ...UNKNOWN_AVAILABILITY,
    });
  }

  // ── Amendment-link diagnostics — gstr2bImport.service.ts sets provenanceStatus to 'AMENDED' on a
  // B2BA/CDNRA document only once it has confidently resolved which prior document it amends; one
  // left at the default 'CURRENT' means that link could not be resolved (brief §15: report rather
  // than guess-link) — emitted once per such document, never silently dropped.
  for (const d of twoBDocuments) {
    if ((d.section === 'B2BA' || d.section === 'CDNRA') && d.provenanceStatus === 'CURRENT') {
      diagnostics.push({
        code: 'AMENDMENT_LINK_NOT_RESOLVED',
        documentId: d.id,
        documentNumber: d.documentNumber,
        reason: `This ${d.section} document could not be confidently linked to the original document it amends — both are reported/totaled independently rather than netted, which may double-count this amendment's value against its original.`,
      });
    }
  }

  // ── Report-level diagnostics always emitted once (brief §16, §32) ──
  diagnostics.push({
    code: 'SOURCE_FIELD_MAPPING_UNVERIFIED',
    reason: 'GSTR-2B field-name mapping in this phase is a best-effort reconstruction, not a byte-verified official schema (PHASE_G2G7E_AUDIT.md §2) — verify against a real portal-downloaded file before relying on this reconciliation for a filing decision.',
  });
  diagnostics.push({
    code: 'GSTR_2B_IS_NOT_FINAL_ITC_ELIGIBILITY',
    reason: 'A MATCHED status here means the book figure and GSTR-2B agree — it does NOT mean the underlying ITC is finally eligible. Statutory restrictions (Section 16(4) time limit, Section 17(5) blocked credits, the 180-day payment condition, place of supply) are tracked separately by G2g-7c\'s own eligibility classifier and are not re-derived or overridden by this reconciliation.',
  });

  const summary: Gstr2bReconciliationSummary = {
    totalTwoBDocuments: twoBDocuments.length,
    totalBookDocuments: bookInvoiceLines.length + bookReturnLines.length,
    exactMatch: matches.filter((m) => m.status === 'EXACT_MATCH').length,
    matchedWithNormalization: matches.filter((m) => m.status === 'MATCHED_WITH_NORMALIZATION').length,
    possibleMatch: matches.filter((m) => m.status === 'POSSIBLE_MATCH').length,
    bookMissing: matches.filter((m) => m.status === 'BOOK_MISSING').length,
    twoBMissing: matches.filter((m) => m.status === 'TWO_B_MISSING').length,
    amountMismatch: matches.filter((m) => m.status === 'AMOUNT_MISMATCH').length,
    taxMismatch: matches.filter((m) => m.status === 'TAX_MISMATCH').length,
    rcmMismatch: matches.filter((m) => m.status === 'RCM_MISMATCH').length,
    notSupported: matches.filter((m) => m.status === 'NOT_SUPPORTED').length,
    unresolved: matches.filter((m) => m.status === 'UNRESOLVED').length,
  };

  const rcmRelevant = matches.filter((m) => {
    const twoBDoc = m.twoBDocumentId ? twoBDocuments.find((d) => d.id === m.twoBDocumentId) : null;
    return twoBDoc?.reverseCharge || (m.bookReferenceId && bookInvoiceLines.find((l) => l.grnId === m.bookReferenceId)?.hasRcmLiability);
  });
  const rcmSummary = {
    matched: rcmRelevant.filter((m) => m.status === 'EXACT_MATCH' || m.status === 'MATCHED_WITH_NORMALIZATION').length,
    bookMissing: rcmRelevant.filter((m) => m.status === 'BOOK_MISSING').length,
    twoBMissing: rcmRelevant.filter((m) => m.status === 'TWO_B_MISSING').length,
    mismatched: rcmRelevant.filter((m) => m.status === 'RCM_MISMATCH').length,
  };

  const twoBTotals = emptyTotals();
  for (const d of participatingTwoB) if (d.supportStatus === 'SUPPORTED') addInto(twoBTotals, docTotals(d));
  const bookTotals = emptyTotals();
  for (const l of scopedBookInvoiceLines) addInto(bookTotals, { taxableValue: l.taxableValue, igst: l.igst, cgst: l.cgst, sgst: l.sgst, cess: 0 });

  return {
    meta: {
      companyId: options.companyId,
      gstRegistrationId: options.gstRegistrationId,
      financialYear: options.financialYear,
      taxPeriod: options.taxPeriod,
      statementId: options.statementId,
      statementVersion: options.statementVersion,
      statementImportedAt: options.statementImportedAt,
      amountToleranceRupees: tolerance,
    },
    summary,
    rcmSummary,
    matches,
    twoBTotals,
    bookTotals,
    diagnostics,
  };
}
