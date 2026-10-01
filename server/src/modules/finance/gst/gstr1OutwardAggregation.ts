// G2g-3c aggregation — GSTR-1 outward-supply aggregation (B2B / B2CL / B2CS). Pure, deterministic,
// no Prisma access: takes already-loaded invoice + line snapshots (the caller's job to fetch, scoped
// to one company, via tenantQuery/tenantBatch — see shared/tenantContext.ts) and produces the typed
// B2B/B2CL/B2CS report model. This is the FIRST phase that groups transactions into report tables;
// gstr1Classification.ts (frozen) only ever decides one transaction's category, never aggregates.
//
// Consumes, unmodified:
//   - gstr1Normalizer.ts (G2g-3b) — normalizeInvoiceItemLine() turns one persisted InvoiceItem row
//     into a GstReportingLine (HSN/UQC/quantity/tax already resolved from the sale-time snapshot).
//   - gstr1Classification.ts (G2g-3c classifier, frozen) — classifyGstr1OutwardSupply() decides one
//     invoice's B2B/B2CL/B2CS/UNCLASSIFIED outcome from its own persisted header facts.
// This module reproduces neither's rules (per its own scope boundary) — it only groups their output.
//
// Source documents: TaxInvoice/SalesInvoice + InvoiceItem drive B2B/B2CL/B2CS classification
// exactly as before. SalesReturn is still never consulted here (a SalesReturn is not itself a
// GSTR-1 reporting document — only its formal Credit Note is, per gstr1CreditNoteNormalizer.ts's
// own header). CreditNote, however, IS now optionally consulted — see "Phase A" below — but only
// for the one narrow purpose Table 7 statutorily requires: netting an eligible B2CS Credit Note's
// own value against the matching B2CS bucket. A CDNR or CDNUR-B2CL Credit Note is never touched
// here at all (it stays a G2g-3d-reported document, against the SAME invoice, so nothing here may
// double-count OR double-reduce it by reaching into that data for any category but B2CS).
//
// Phase A (GSTR-1 readiness): GSTN has no "CDNUR B2CS" category — a Credit Note whose ORIGINAL
// outward supply was itself B2CS must instead reduce Table 7's own B2CS figure
// ("Net B2CS = Gross B2CS - eligible B2CS Credit Notes"). `aggregateGstr1OutwardSupplies` therefore
// takes an OPTIONAL third argument, `creditNoteSources` — already-loaded, already-authorized
// CreditNote source documents in the exact shape gstr1CreditNoteAggregation.ts already defines and
// consumes (reused unchanged, never a parallel shape). Omitting it (or passing `[]`) reproduces the
// exact pre-Phase-A behavior: gross B2CS, unnetted — every existing caller that doesn't yet pass
// credit notes keeps working unchanged. This module independently normalizes/classifies each
// credit note itself (via the same FROZEN `normalizeGstr1CreditNote`/`classifyGstr1OutwardSupply`
// gstr1CreditNoteAggregation.ts and gstr1Table12Aggregation.ts already call) rather than depending
// on gstr1CreditNoteAggregation.ts's own aggregated OUTPUT — same "each pure aggregator loads and
// processes its own view of the same raw rows" precedent gstr1Table12Aggregation.ts already
// established for combining outward + credit-note data in one file.
//
// Money follows this codebase's established convention (see gstr1Normalizer.ts's own header): plain
// `number`, Prisma Decimal already unwrapped by the caller — no decimal.js anywhere in this codebase.
// Every running sum in this module goes through round2() at each step (same pattern
// finance.service.ts's getGstSummary/getPurchaseGstSummary already use) to keep paise-level drift
// from compounding across many lines, rather than accumulating raw floating-point sums and rounding
// only once at the end.

import {
  type GstReportingLine,
  type GstUqcSource,
  type GstQuantityBasis,
  type InvoiceItemSourceRow,
  type InvoiceGstContext,
  normalizeInvoiceItemLine,
} from './gstr1Normalizer';
import {
  classifyGstr1OutwardSupply,
  UNCLASSIFIED,
} from './gstr1Classification';
import { normalizeGstr1CreditNote } from './gstr1CreditNoteNormalizer';
import type { Gstr1CreditNoteAggregationSourceDocument } from './gstr1CreditNoteAggregation';
import type { BranchAccess } from '../../../shared/tenantContext';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Raised only for an authorization refusal (an explicitly requested branch this caller cannot
 *  access) — never for a data-quality problem, which is always a diagnostic row instead (rule 9's
 *  "never silently guess" is about DATA, not about widening an access grant). Kept as its own class,
 *  distinct from the app's generic AppError, so this module stays Prisma/HTTP-framework free like
 *  its two frozen siblings — the caller (a future router/service) is expected to catch this and
 *  translate it into whatever HTTP status its own convention uses. */
export class Gstr1OutwardAggregationAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Gstr1OutwardAggregationAccessError';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Input contract — one already-loaded invoice + its already-loaded lines.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One outward-supply transaction's header facts, exactly as persisted — the caller loads this from
 * SalesInvoice + its TaxInvoice (join is the caller's job; this module takes no Prisma dependency).
 * Every field here is either what classifyGstr1OutwardSupply needs, or what identifies/scopes the
 * transaction (branchId, status, items) — nothing here is recomputed from any other source.
 */
export interface Gstr1OutwardSourceInvoice {
  invoiceId: string;
  invoiceNumber: string;
  /** SalesInvoice.invoiceDate. Selects the period (rule 6) and, for the one classification path
   *  that needs it, the B2CL threshold in force (rule 4/13) — the transaction's own date, never
   *  "today." A missing/invalid value is never treated as "out of the requested period" (that would
   *  be a guess) — see aggregateGstr1OutwardSupplies's own date-filter comment for exactly when it
   *  is, and is not, excluded on that basis. */
  invoiceDate: Date | null | undefined;
  /** SalesInvoice.status, e.g. 'VOID' — checked here, not pre-filtered by the caller (rule 8). */
  status: string;
  /** SalesInvoice.branchId. Required on the live schema, but typed nullable here so a defensively
   *  malformed row never throws before the caller's own validation has a chance to run. */
  branchId: string | null | undefined;
  /** SalesInvoice.totalAmount — the persisted, tax-inclusive document total (rule 12). Never a sum
   *  of `items`; the classifier's own invoiceValue input, unchanged. */
  totalAmount: number | null | undefined;
  /** TaxInvoice.buyerGstin (null when the invoice has no TaxInvoice at all — a non-taxable/non-INR
   *  sale, which will fail classification's invoiceValue/registration checks anyway). */
  buyerGstin: string | null | undefined;
  /** TaxInvoice.placeOfSupply. */
  placeOfSupply: string | null | undefined;
  /** TaxInvoice.sellerStateCode — the state of the registration this invoice was ACTUALLY invoiced
   *  under (never the company's current primary registration; rule 5). */
  sellerStateCode: string | null | undefined;
  /** TaxInvoice.sellerRegistrationId. Also the field this module's own registration SCOPE filter
   *  (rule 5) matches against the caller-selected registration — see the loop below. */
  sellerRegistrationId: string | null | undefined;
  /** TaxInvoice.reverseCharge — passed straight through to the B2B record (section 3's field list);
   *  immaterial to B2CL/B2CS (unregistered recipients are never reverse-charge transactions). */
  reverseCharge?: boolean | null;
  /** The invoice's own InvoiceItem rows, in the exact shape gstr1Normalizer.ts already defines and
   *  consumes — reused unchanged, never a parallel shape. */
  items: InvoiceItemSourceRow[];
}

export interface Gstr1OutwardAggregationOptions {
  /** Rule 5: aggregation MUST be for one selected seller GST registration — required, never
   *  defaulted to "the company's current primary registration." Only an inv whose OWN
   *  `sellerRegistrationId` (present) matches this id is eligible; a present-but-different id is
   *  silently out of scope (exactly like a WHERE clause the caller's own query would have applied),
   *  while a MISSING id is a data-quality problem this module surfaces as a diagnostic instead (see
   *  the loop below — the two cases are deliberately not conflated). */
  gstRegistrationId: string;
  /** Complete Asia/Kolkata calendar-day boundaries, already resolved by the caller via
   *  shared/istDate.ts's parseIstRangeStart()/parseIstRangeEnd() (rule 6) — this module trusts the
   *  two Date instants as given and never re-derives IST semantics itself. */
  period: { from: Date; to: Date };
  /** Same branch-access contract every other G2g-2 report already uses (getGstSummary,
   *  getPurchaseGstSummary) — reused unchanged, not a new mechanism (rule 7). */
  branchAccess?: BranchAccess;
  /** A single explicitly requested branch. Verified against `branchAccess` and REJECTED (thrown,
   *  not silently dropped) when unauthorized — mirrors what the finance router's own
   *  `assertBranchAccessible` call does ahead of every other G2g-2 report; reproduced here because
   *  this module has no router of its own to do it first (rule 7's "reject it"). */
  branchId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Output contract
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1MoneyTotals {
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  /** Always 0 in this phase — see gstr1Normalizer.ts's own cessAmount field comment: this schema
   *  has no line-level cess column, only TaxInvoice.cess at the header, and attributing a header
   *  figure down to a line/group would be a fabricated allocation this module also refuses to do. */
  cess: number;
}

/** One HSN+rate+UQC slice of ONE invoice's lines (B2B/B2CL only — rule 16: an invoice retains its
 *  own identity, but its lines are grouped underneath it so multiple lines sharing an HSN+rate don't
 *  produce redundant entries). */
export interface Gstr1LineDetail extends Gstr1MoneyTotals {
  hsnCode: string | null;
  gstRate: number;
  uqc: string | null;
  uqcSource: GstUqcSource;
  quantity: number;
  quantityBasis: GstQuantityBasis;
}

export interface Gstr1B2bInvoiceRecord {
  category: 'B2B';
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date | null;
  buyerGstin: string;
  placeOfSupply: string | null;
  isInterState: boolean | null;
  reverseCharge: boolean | null;
  sellerRegistrationId: string;
  /** Persisted, tax-inclusive document total (rule 12) — never a sum of `lines`. */
  invoiceValue: number;
  totals: Gstr1MoneyTotals;
  lines: Gstr1LineDetail[];
}

export interface Gstr1B2clInvoiceRecord {
  category: 'B2CL';
  invoiceId: string;
  invoiceNumber: string;
  invoiceDate: Date | null;
  placeOfSupply: string;
  sellerRegistrationId: string;
  invoiceValue: number;
  /** The B2CL threshold actually applied for this invoice's own date (rule 4) — from the frozen
   *  classifier, never recomputed here. */
  threshold: number;
  totals: Gstr1MoneyTotals;
  lines: Gstr1LineDetail[];
}

/** B2CS is aggregated by reporting dimension, never by invoice identity (rule 16) — this is the one
 *  category with no per-invoice record at all, matching GSTR-1 Table 7's own shape (place of supply
 *  × rate × intra/inter-state), extended with HSN/UQC while the current data permits it (rule 3's
 *  "keep the design extensible for the later GSTR-1 Table 7 implementation" — a future export can
 *  always collapse hsnCode/uqc back out to reproduce the exact statutory 3-column grouping; this
 *  module never throws that finer detail away up front). */
export interface Gstr1B2csGroup extends Gstr1MoneyTotals {
  placeOfSupply: string;
  isInterState: boolean;
  gstRate: number;
  hsnCode: string | null;
  uqc: string | null;
  /** NET figure (Phase A: gross outward supplies at this dimension minus any eligible B2CS Credit
   *  Notes netted against it) — the same `Gstr1MoneyTotals` fields (`taxableValue`/`cgst`/`sgst`/
   *  `igst`/`cess`) above are likewise NET, not gross, whenever `creditNoteSources` was supplied to
   *  the aggregator. Equal to the gross figures below when no credit notes were netted (unchanged
   *  pre-Phase-A behavior — the default when the aggregator's third argument is omitted). */
  quantity: number;
  /** How many source lines (across however many invoices) fed this one group's GROSS side — a
   *  diagnostic count, not a statutory field. Unaffected by Credit Note netting. */
  recordCount: number;

  // Phase A — B2CS Credit Note net-off ("Net B2CS = Gross B2CS - eligible B2CS Credit Notes").
  // Gross/reduction are retained alongside the net figures above for diagnostics/reconciliation,
  // never thrown away — same posture as gstr1Table12Aggregation.ts's own Gstr1Table12Row gross/
  // creditNoteReduction fields.
  grossTaxableValue: number;
  grossCgst: number;
  grossSgst: number;
  grossIgst: number;
  grossCess: number;
  grossQuantity: number;
  creditNoteTaxableReduction: number;
  creditNoteCgstReduction: number;
  creditNoteSgstReduction: number;
  creditNoteIgstReduction: number;
  creditNoteCessReduction: number;
  creditNoteQuantityReduction: number;
  /** How many Credit Note lines fed this group's reduction figures. */
  creditNoteRecordCount: number;
  /** false when netting produced a negative bucket (more eligible B2CS Credit Note value than
   *  gross outward supplies at this exact place-of-supply/rate/HSN/UQC dimension in this period) —
   *  the negative value is retained exactly as computed, never clamped to zero or hidden; flagged
   *  instead via the aggregation's own `b2csCreditNoteDiagnostics` (NEGATIVE_NET_B2CS_BUCKET). */
  filingEligible: boolean;
}

export type Gstr1OutwardReportability = 'EXCLUDED_VOID' | 'UNCLASSIFIED';

/** One invoice this module could not (or, for VOID, deliberately would not) place into B2B/B2CL/B2CS
 *  — kept separate from the report buckets themselves (rule 13: a data problem must never be folded
 *  into a bucket's totals, and a bucket must never silently lose a record with no trace). */
export interface Gstr1OutwardDiagnostic {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceDate: Date | null;
  reportability: Gstr1OutwardReportability;
  /** For UNCLASSIFIED, this is the frozen classifier's own `reason` string, unchanged — this module
   *  never rewrites or re-derives why a transaction couldn't be classified (rule 12). */
  reason: string;
}

/** Phase A — B2CS Credit Note net-off diagnostics. Kept as its own array (never folded into
 *  `Gstr1OutwardDiagnostic`, which is invoice-keyed) because these describe either a Credit Note
 *  that could not be netted, or a bucket-level outcome of netting — neither is "an invoice this
 *  module could not classify." Nothing here is ever a reason to silently drop or clamp data (same
 *  "preserve the diagnostic" posture as gstr1CreditNoteAggregation.ts's own diagnostics). */
export type Gstr1B2csCreditNoteDiagnosticReason =
  /** The Credit Note's own reportability check (the same FROZEN `normalizeGstr1CreditNote` gate
   *  gstr1CreditNoteAggregation.ts uses) failed — CANCELLED, INVALID_RECIPIENT_GSTIN,
   *  MISSING_SELLER_REGISTRATION, EXPORT_CLASSIFICATION_UNAVAILABLE, or
   *  ORIGINAL_SUPPLY_UNCLASSIFIED. See `detail` for which. */
  | 'CREDIT_NOTE_EXCLUDED'
  /** Netting an eligible B2CS Credit Note against its matching bucket left that bucket's net value
   *  negative — never clamped to zero or hidden (rule: "do not allow a credit note to create an
   *  invalid negative Table 7 bucket ... without a diagnostic"). */
  | 'NEGATIVE_NET_B2CS_BUCKET'
  /** A repeat of a Credit Note id already netted in this same aggregation call — skipped so it
   *  cannot double-reduce the same bucket twice (same "first occurrence wins" rule
   *  gstr1CreditNoteAggregation.ts's own duplicate-id guard already applies to its buckets). */
  | 'DUPLICATE_CREDIT_NOTE_ID';

export interface Gstr1B2csCreditNoteDiagnostic {
  reason: Gstr1B2csCreditNoteDiagnosticReason;
  detail: string;
  creditNoteId?: string;
  creditNoteNumber?: string | null;
  placeOfSupply?: string | null;
  gstRate?: number;
  hsnCode?: string | null;
  uqc?: string | null;
}

export interface Gstr1OutwardAggregation {
  b2b: Gstr1B2bInvoiceRecord[];
  b2cl: Gstr1B2clInvoiceRecord[];
  /** Phase A: NET of eligible B2CS Credit Notes when `creditNoteSources` was supplied to the
   *  aggregator (gross-only, unchanged, when it wasn't — see `Gstr1B2csGroup`'s own doc comment). */
  b2cs: Gstr1B2csGroup[];
  diagnostics: Gstr1OutwardDiagnostic[];
  /** Phase A: diagnostics specific to B2CS Credit Note net-off — empty whenever `creditNoteSources`
   *  is omitted/empty (nothing to net, nothing to diagnose). */
  b2csCreditNoteDiagnostics: Gstr1B2csCreditNoteDiagnostic[];
  totals: {
    b2b: Gstr1MoneyTotals & { invoiceValue: number; invoiceCount: number };
    b2cl: Gstr1MoneyTotals & { invoiceValue: number; invoiceCount: number };
    /** NET (Phase A) — see `Gstr1B2csGroup`'s own doc comment. */
    b2cs: Gstr1MoneyTotals & { invoiceValue: number; recordCount: number };
    grandTotal: Gstr1MoneyTotals & { invoiceValue: number };
  };
  meta: {
    gstRegistrationId: string;
    period: { from: Date; to: Date };
    /** Invoices that matched the selected registration/branch/period scope and were actually
     *  classified (whether or not they ended up VOID-excluded or UNCLASSIFIED). */
    invoicesConsidered: number;
    /** Invoices in the input array that never reached classification at all because they belonged
     *  to a different registration, a different (inaccessible) branch, or a different period —
     *  exactly what a scoped Prisma query would simply never have fetched. Distinct from
     *  `diagnostics`, which is only for invoices that WERE in scope. */
    invoicesExcludedByScope: number;
    /** Phase A: Credit Notes that matched the selected registration/branch/period scope and were
     *  actually considered for B2CS net-off (whether or not they ended up excluded, or belonged to
     *  a non-B2CS original supply and were skipped). Always 0 when `creditNoteSources` is omitted. */
    creditNotesConsideredForNetOff: number;
    /** Phase A: Credit Notes in `creditNoteSources` that never reached net-off consideration at all
     *  because they belonged to a different registration, a different (inaccessible) branch, or a
     *  different period — the same "scoped query would never have fetched it" semantics as
     *  `invoicesExcludedByScope` above. */
    creditNotesExcludedByScope: number;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Branch-access resolution — same shape as finance.service.ts's getGstSummary/getPurchaseGstSummary,
// plus the explicit-rejection half (rule 7) those two delegate to their router's
// assertBranchAccessible call, which this Prisma-free module has no router to borrow.
// ─────────────────────────────────────────────────────────────────────────────

function resolveAllowedBranchIds(branchAccess: BranchAccess | undefined, branchId: string | undefined): string[] | undefined {
  if (branchId) {
    if (branchAccess && !branchAccess.allBranches && !branchAccess.branchIds.includes(branchId)) {
      throw new Gstr1OutwardAggregationAccessError(
        `Branch ${branchId} is not accessible to the caller — rejected outright, per rule 7, rather than silently aggregating without it.`,
      );
    }
    return [branchId];
  }
  return branchAccess && !branchAccess.allBranches ? branchAccess.branchIds : undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// Line-detail grouping (rule 16: line-level tax aggregation UNDER an invoice's own identity)
// ─────────────────────────────────────────────────────────────────────────────

function lineDetailKey(line: GstReportingLine): string {
  return `${line.hsnCode ?? ''}\u0000${line.gstRate}\u0000${line.uqc ?? ''}`;
}

function buildLineDetails(lines: GstReportingLine[]): Gstr1LineDetail[] {
  const byKey = new Map<string, Gstr1LineDetail>();
  for (const line of lines) {
    const key = lineDetailKey(line);
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity = round2(existing.quantity + line.quantity);
      existing.taxableValue = round2(existing.taxableValue + line.taxableValue);
      existing.cgst = round2(existing.cgst + line.cgstAmount);
      existing.sgst = round2(existing.sgst + line.sgstAmount);
      existing.igst = round2(existing.igst + line.igstAmount);
      existing.cess = round2(existing.cess + line.cessAmount);
    } else {
      byKey.set(key, {
        hsnCode: line.hsnCode, gstRate: line.gstRate, uqc: line.uqc, uqcSource: line.uqcSource,
        quantity: line.quantity, quantityBasis: line.quantityBasis,
        taxableValue: line.taxableValue, cgst: line.cgstAmount, sgst: line.sgstAmount,
        igst: line.igstAmount, cess: line.cessAmount,
      });
    }
  }
  return Array.from(byKey.values());
}

function sumLineDetails(details: Gstr1LineDetail[]): Gstr1MoneyTotals {
  return details.reduce(
    (acc, d) => ({
      taxableValue: round2(acc.taxableValue + d.taxableValue),
      cgst: round2(acc.cgst + d.cgst),
      sgst: round2(acc.sgst + d.sgst),
      igst: round2(acc.igst + d.igst),
      cess: round2(acc.cess + d.cess),
    }),
    { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B2CS grouping — across ALL invoices, by reporting dimension (rule 16).
// ─────────────────────────────────────────────────────────────────────────────

function b2csKey(isInterState: boolean, placeOfSupply: string, line: GstReportingLine): string {
  return `${isInterState}\u0000${placeOfSupply}\u0000${line.gstRate}\u0000${line.hsnCode ?? ''}\u0000${line.uqc ?? ''}`;
}

function newB2csGroup(isInterState: boolean, placeOfSupply: string, gstRate: number, hsnCode: string | null, uqc: string | null): Gstr1B2csGroup {
  return {
    placeOfSupply, isInterState, gstRate, hsnCode, uqc,
    taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, quantity: 0, recordCount: 0,
    grossTaxableValue: 0, grossCgst: 0, grossSgst: 0, grossIgst: 0, grossCess: 0, grossQuantity: 0,
    creditNoteTaxableReduction: 0, creditNoteCgstReduction: 0, creditNoteSgstReduction: 0,
    creditNoteIgstReduction: 0, creditNoteCessReduction: 0, creditNoteQuantityReduction: 0,
    creditNoteRecordCount: 0, filingEligible: true,
  };
}

function addToB2cs(groups: Map<string, Gstr1B2csGroup>, isInterState: boolean, placeOfSupply: string, line: GstReportingLine): void {
  const key = b2csKey(isInterState, placeOfSupply, line);
  let group = groups.get(key);
  if (!group) {
    group = newB2csGroup(isInterState, placeOfSupply, line.gstRate, line.hsnCode, line.uqc);
    groups.set(key, group);
  }
  group.grossTaxableValue = round2(group.grossTaxableValue + line.taxableValue);
  group.grossCgst = round2(group.grossCgst + line.cgstAmount);
  group.grossSgst = round2(group.grossSgst + line.sgstAmount);
  group.grossIgst = round2(group.grossIgst + line.igstAmount);
  group.grossCess = round2(group.grossCess + line.cessAmount);
  group.grossQuantity = round2(group.grossQuantity + line.quantity);
  group.recordCount += 1;
}

/**
 * Phase A — nets one eligible B2CS Credit Note line against its matching B2CS bucket (same
 * dimension key as `addToB2cs`: interstate-ness + place of supply + rate + HSN + UQC). Creates the
 * bucket at zero gross if no matching gross B2CS supply exists yet in this period (e.g. the
 * original sale fell in an earlier return period) — the reduction is still recorded and will
 * finalize as a genuine negative net bucket (flagged via NEGATIVE_NET_B2CS_BUCKET, never clamped
 * or silently dropped — see the finalize step in the aggregator below).
 */
function subtractFromB2cs(groups: Map<string, Gstr1B2csGroup>, isInterState: boolean, placeOfSupply: string, line: GstReportingLine): void {
  const key = b2csKey(isInterState, placeOfSupply, line);
  let group = groups.get(key);
  if (!group) {
    group = newB2csGroup(isInterState, placeOfSupply, line.gstRate, line.hsnCode, line.uqc);
    groups.set(key, group);
  }
  group.creditNoteTaxableReduction = round2(group.creditNoteTaxableReduction + line.taxableValue);
  group.creditNoteCgstReduction = round2(group.creditNoteCgstReduction + line.cgstAmount);
  group.creditNoteSgstReduction = round2(group.creditNoteSgstReduction + line.sgstAmount);
  group.creditNoteIgstReduction = round2(group.creditNoteIgstReduction + line.igstAmount);
  group.creditNoteCessReduction = round2(group.creditNoteCessReduction + line.cessAmount);
  group.creditNoteQuantityReduction = round2(group.creditNoteQuantityReduction + line.quantity);
  group.creditNoteRecordCount += 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// Totals rollups
// ─────────────────────────────────────────────────────────────────────────────

function sumInvoiceRecords(records: { totals: Gstr1MoneyTotals; invoiceValue: number }[]): Gstr1MoneyTotals & { invoiceValue: number } {
  return records.reduce(
    (acc, r) => ({
      taxableValue: round2(acc.taxableValue + r.totals.taxableValue),
      cgst: round2(acc.cgst + r.totals.cgst),
      sgst: round2(acc.sgst + r.totals.sgst),
      igst: round2(acc.igst + r.totals.igst),
      cess: round2(acc.cess + r.totals.cess),
      invoiceValue: round2(acc.invoiceValue + r.invoiceValue),
    }),
    { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, invoiceValue: 0 },
  );
}

function sumB2cs(groups: Gstr1B2csGroup[]): Gstr1MoneyTotals & { invoiceValue: number } {
  const totals = groups.reduce(
    (acc, g) => ({
      taxableValue: round2(acc.taxableValue + g.taxableValue),
      cgst: round2(acc.cgst + g.cgst),
      sgst: round2(acc.sgst + g.sgst),
      igst: round2(acc.igst + g.igst),
      cess: round2(acc.cess + g.cess),
    }),
    { taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0 },
  );
  // B2CS has no per-invoice identity to sum an "invoice value" from (rule 16) — taxable value +
  // tax is the closest equivalent and is what a B2CS reader actually wants (Table 7 has no separate
  // invoice-value column at all, unlike B2B/B2CL).
  return { ...totals, invoiceValue: round2(totals.taxableValue + totals.cgst + totals.sgst + totals.igst + totals.cess) };
}

function addMoney(a: Gstr1MoneyTotals & { invoiceValue: number }, b: Gstr1MoneyTotals & { invoiceValue: number }): Gstr1MoneyTotals & { invoiceValue: number } {
  return {
    taxableValue: round2(a.taxableValue + b.taxableValue),
    cgst: round2(a.cgst + b.cgst),
    sgst: round2(a.sgst + b.sgst),
    igst: round2(a.igst + b.igst),
    cess: round2(a.cess + b.cess),
    invoiceValue: round2(a.invoiceValue + b.invoiceValue),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The aggregator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregates already-loaded outward-supply invoices into GSTR-1's B2B/B2CL/B2CS, per the classifier
 * output (unchanged, unreproduced) grouped per sections 3/16. Pure and side-effect free: no Prisma,
 * no Date.now(), no randomness — same input always produces the same output.
 *
 * Filtering order per invoice (mirrors what a registration/branch/period-scoped query would already
 * have applied, vs. what is a genuine data-quality problem the caller still needs to see):
 *   1. Registration scope (rule 5) — a PRESENT but different sellerRegistrationId is silently out of
 *      scope (exactly like a WHERE clause); a MISSING one is not assumed out of scope — it proceeds
 *      to classification, which will itself report it as an UNCLASSIFIED diagnostic (rule 13).
 *   2. Branch scope (rule 7) — same "present but disallowed = silently out of scope" logic, using
 *      the caller's own branchAccess/branchId (never re-verified against a live Branch row here —
 *      that ownership check already happened one layer up, wherever these invoices were fetched).
 *   3. Period scope (rule 6) — a resolvable invoiceDate outside [from, to] is silently out of scope.
 *      An unresolvable one is NOT assumed out of scope (that would be a guess); it proceeds to
 *      classification, which needs a valid date only on the one path that actually consults a
 *      threshold (rule 4) — every other path is date-independent and will still classify normally.
 *   4. VOID (rule 8) — excluded from every bucket, recorded as a diagnostic (not silently dropped).
 *   5. classifyGstr1OutwardSupply() (frozen, unchanged) — UNCLASSIFIED becomes a diagnostic
 *      carrying the classifier's own `reason` verbatim; B2B/B2CL/B2CS proceed to normalization.
 *
 * Phase A — B2CS Credit Note net-off: after every invoice above is classified, `creditNoteSources`
 * (optional; `[]` reproduces exact pre-Phase-A gross-only behavior) is walked with the identical
 * registration/branch/period scope filters, then `normalizeGstr1CreditNote()` (frozen, unchanged)
 * decides reportability and original-supply category exactly as gstr1CreditNoteAggregation.ts does.
 * Only a reportable, CDNUR, originally-B2CS Credit Note is netted — CDNR and CDNUR-B2CL Credit
 * Notes are left untouched here (they are G2g-3d's own reported documents, never doubly reduced).
 */
export function aggregateGstr1OutwardSupplies(
  invoices: Gstr1OutwardSourceInvoice[],
  options: Gstr1OutwardAggregationOptions,
  creditNoteSources: Gstr1CreditNoteAggregationSourceDocument[] = [],
): Gstr1OutwardAggregation {
  const gstRegistrationId = options.gstRegistrationId?.trim();
  if (!gstRegistrationId) {
    throw new Gstr1OutwardAggregationAccessError(
      'A single seller GST registration must be selected before aggregating GSTR-1 outward supplies (rule 5) — none was supplied.',
    );
  }
  const allowedBranchIds = resolveAllowedBranchIds(options.branchAccess, options.branchId);
  const { from, to } = options.period;

  const b2b: Gstr1B2bInvoiceRecord[] = [];
  const b2cl: Gstr1B2clInvoiceRecord[] = [];
  const b2csGroups = new Map<string, Gstr1B2csGroup>();
  const diagnostics: Gstr1OutwardDiagnostic[] = [];

  let invoicesConsidered = 0;
  let invoicesExcludedByScope = 0;

  for (const inv of invoices) {
    const invSellerRegistrationId = inv.sellerRegistrationId?.trim();
    if (invSellerRegistrationId && invSellerRegistrationId !== gstRegistrationId) {
      invoicesExcludedByScope++;
      continue;
    }

    if (allowedBranchIds && (!inv.branchId || !allowedBranchIds.includes(inv.branchId))) {
      invoicesExcludedByScope++;
      continue;
    }

    const invoiceDate = inv.invoiceDate instanceof Date && !Number.isNaN(inv.invoiceDate.getTime()) ? inv.invoiceDate : null;
    if (invoiceDate && (invoiceDate < from || invoiceDate > to)) {
      invoicesExcludedByScope++;
      continue;
    }

    invoicesConsidered++;

    if (inv.status === 'VOID') {
      diagnostics.push({
        invoiceId: inv.invoiceId,
        invoiceNumber: inv.invoiceNumber ?? null,
        invoiceDate,
        reportability: 'EXCLUDED_VOID',
        reason: 'VOID invoice excluded from B2B/B2CL/B2CS statutory outward aggregation — Table 13 (document-level cancellation) is a separate, later phase.',
      });
      continue;
    }

    const classification = classifyGstr1OutwardSupply({
      buyerGstin: inv.buyerGstin,
      sellerStateCode: inv.sellerStateCode,
      sellerRegistrationId: inv.sellerRegistrationId,
      placeOfSupply: inv.placeOfSupply,
      invoiceValue: inv.totalAmount,
      invoiceDate,
    });

    if (classification.category === UNCLASSIFIED) {
      diagnostics.push({
        invoiceId: inv.invoiceId,
        invoiceNumber: inv.invoiceNumber ?? null,
        invoiceDate,
        reportability: 'UNCLASSIFIED',
        reason: classification.reason,
      });
      continue;
    }

    const ctx: InvoiceGstContext = {
      invoiceNumber: inv.invoiceNumber,
      invoiceDate,
      invoiceStatus: inv.status,
      buyerGstin: inv.buyerGstin ?? null,
      placeOfSupply: inv.placeOfSupply ?? null,
      sellerRegistrationId: inv.sellerRegistrationId ?? null,
      reverseCharge: inv.reverseCharge ?? null,
    };
    const lines = inv.items.map((item) => normalizeInvoiceItemLine(item, ctx));
    const invoiceValue = round2(Number(inv.totalAmount));

    if (classification.category === 'B2B') {
      const details = buildLineDetails(lines);
      b2b.push({
        category: 'B2B',
        invoiceId: inv.invoiceId,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate,
        buyerGstin: inv.buyerGstin!.trim().toUpperCase(),
        placeOfSupply: inv.placeOfSupply ?? null,
        isInterState: classification.isInterState,
        reverseCharge: inv.reverseCharge ?? null,
        sellerRegistrationId: classification.sellerRegistrationId!,
        invoiceValue,
        totals: sumLineDetails(details),
        lines: details,
      });
    } else if (classification.category === 'B2CL') {
      const details = buildLineDetails(lines);
      b2cl.push({
        category: 'B2CL',
        invoiceId: inv.invoiceId,
        invoiceNumber: inv.invoiceNumber,
        invoiceDate,
        placeOfSupply: inv.placeOfSupply!,
        sellerRegistrationId: classification.sellerRegistrationId!,
        invoiceValue,
        threshold: classification.threshold!,
        totals: sumLineDetails(details),
        lines: details,
      });
    } else {
      // B2CS — grouped by reporting dimension across the whole run, never by invoice identity.
      const isInterState = classification.isInterState ?? false;
      const placeOfSupply = inv.placeOfSupply ?? '';
      for (const line of lines) {
        addToB2cs(b2csGroups, isInterState, placeOfSupply, line);
      }
    }
  }

  // ── Phase A: B2CS Credit Note net-off ───────────────────────────────────
  const b2csCreditNoteDiagnostics: Gstr1B2csCreditNoteDiagnostic[] = [];
  const seenCreditNoteIds = new Set<string>();
  let creditNotesConsideredForNetOff = 0;
  let creditNotesExcludedByScope = 0;

  for (const cn of creditNoteSources) {
    if (seenCreditNoteIds.has(cn.id)) {
      b2csCreditNoteDiagnostics.push({
        reason: 'DUPLICATE_CREDIT_NOTE_ID',
        detail: `Credit note ${cn.id} was supplied more than once to this aggregation call — only the first occurrence is netted; it is never double-counted.`,
        creditNoteId: cn.id, creditNoteNumber: cn.creditNoteNumber ?? null,
      });
      continue;
    }
    seenCreditNoteIds.add(cn.id);

    const cnRegistrationId = cn.sellerRegistrationId?.trim();
    if (cnRegistrationId && cnRegistrationId !== gstRegistrationId) {
      creditNotesExcludedByScope++;
      continue;
    }
    if (allowedBranchIds && (!cn.branchId || !allowedBranchIds.includes(cn.branchId))) {
      creditNotesExcludedByScope++;
      continue;
    }
    const creditNoteDate = cn.creditNoteDate instanceof Date && !Number.isNaN(cn.creditNoteDate.getTime()) ? cn.creditNoteDate : null;
    if (creditNoteDate && (creditNoteDate < from || creditNoteDate > to)) {
      creditNotesExcludedByScope++;
      continue;
    }

    creditNotesConsideredForNetOff++;

    const normalized = normalizeGstr1CreditNote(cn);
    if (!normalized.reportable) {
      b2csCreditNoteDiagnostics.push({
        reason: 'CREDIT_NOTE_EXCLUDED',
        detail: `Credit note excluded from Table 7 B2CS net-off (${normalized.exclusionReason}) — see the GSTR-1 Credit Note report for its own diagnostics; never silently dropped.`,
        creditNoteId: normalized.document.creditNoteId,
        creditNoteNumber: normalized.document.creditNoteNumber,
      });
      continue;
    }

    if (normalized.document.reportingTable !== 'CDNUR' || normalized.document.originalSupplyCategory !== 'B2CS') {
      // CDNR, or CDNUR/B2CL, or CDNUR/export — reported on Table 9B instead (see
      // gstr1CreditNoteAggregation.ts), never netted here (rule: "registered-recipient credit
      // notes remain CDNR ... eligible B2CL/export credit notes remain CDNUR").
      continue;
    }

    // Re-derive the ORIGINAL outward supply's own isInterState the same way the frozen normalizer
    // already did internally — needed because gstr1CreditNoteNormalizer.ts's own document shape
    // does not carry isInterState (it is frozen and reused unmodified here, never re-implemented;
    // identical inputs -> identical, deterministic result).
    const originalSupplyClassification = classifyGstr1OutwardSupply({
      buyerGstin: cn.buyerGstin,
      sellerStateCode: cn.sellerStateCode,
      sellerRegistrationId: cn.sellerRegistrationId,
      placeOfSupply: cn.placeOfSupply,
      invoiceValue: cn.originalInvoiceValue,
      invoiceDate: cn.originalInvoiceDate,
    });
    if (originalSupplyClassification.category !== 'B2CS' || originalSupplyClassification.isInterState === null) {
      // Defensive only — unreachable in practice: normalizeGstr1CreditNote already confirmed
      // originalSupplyCategory === 'B2CS' above using the identical inputs/classifier.
      b2csCreditNoteDiagnostics.push({
        reason: 'CREDIT_NOTE_EXCLUDED',
        detail: 'Credit note carried a B2CS original supply category from the frozen normalizer but could not be re-classified for net-off — should be unreachable; excluded from Table 7 net-off.',
        creditNoteId: normalized.document.creditNoteId,
        creditNoteNumber: normalized.document.creditNoteNumber,
      });
      continue;
    }

    const placeOfSupply = cn.placeOfSupply ?? '';
    for (const line of normalized.lines) {
      subtractFromB2cs(b2csGroups, originalSupplyClassification.isInterState, placeOfSupply, line);
    }
  }

  // ── Finalize B2CS: net = gross - eligible Credit Note reduction, never clamped ────────────
  for (const group of b2csGroups.values()) {
    group.taxableValue = round2(group.grossTaxableValue - group.creditNoteTaxableReduction);
    group.cgst = round2(group.grossCgst - group.creditNoteCgstReduction);
    group.sgst = round2(group.grossSgst - group.creditNoteSgstReduction);
    group.igst = round2(group.grossIgst - group.creditNoteIgstReduction);
    group.cess = round2(group.grossCess - group.creditNoteCessReduction);
    group.quantity = round2(group.grossQuantity - group.creditNoteQuantityReduction);

    const hasNegativeNet = group.taxableValue < 0 || group.cgst < 0 || group.sgst < 0 || group.igst < 0 || group.cess < 0;
    if (hasNegativeNet) {
      b2csCreditNoteDiagnostics.push({
        reason: 'NEGATIVE_NET_B2CS_BUCKET',
        detail: `B2CS bucket (place of supply ${group.placeOfSupply}, rate ${group.gstRate}, HSN ${group.hsnCode ?? '(missing)'}, UQC ${group.uqc ?? '(none)'}) went negative after netting eligible B2CS Credit Notes against it — retained exactly as computed, never clamped or hidden.`,
        placeOfSupply: group.placeOfSupply, gstRate: group.gstRate, hsnCode: group.hsnCode, uqc: group.uqc,
      });
      group.filingEligible = false;
    }
  }

  b2b.sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));
  b2cl.sort((a, b) => a.invoiceNumber.localeCompare(b.invoiceNumber));
  const b2cs = Array.from(b2csGroups.values()).sort(
    (a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.gstRate - b.gstRate || (a.hsnCode ?? '').localeCompare(b.hsnCode ?? ''),
  );

  const b2bTotals = sumInvoiceRecords(b2b);
  const b2clTotals = sumInvoiceRecords(b2cl);
  const b2csTotals = sumB2cs(b2cs);

  return {
    b2b, b2cl, b2cs, diagnostics, b2csCreditNoteDiagnostics,
    totals: {
      b2b: { ...b2bTotals, invoiceCount: b2b.length },
      b2cl: { ...b2clTotals, invoiceCount: b2cl.length },
      b2cs: { ...b2csTotals, recordCount: b2cs.reduce((s, g) => s + g.recordCount, 0) },
      grandTotal: addMoney(addMoney(b2bTotals, b2clTotals), b2csTotals),
    },
    meta: {
      gstRegistrationId, period: { from, to }, invoicesConsidered, invoicesExcludedByScope,
      creditNotesConsideredForNetOff, creditNotesExcludedByScope,
    },
  };
}
