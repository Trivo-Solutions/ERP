// G2g-3c — GSTR-1 outward-supply classification (B2B / B2CL / B2CS). Pure, deterministic, no
// Prisma access — takes the handful of already-persisted facts one outward transaction (an
// INVOICE line's parent SalesInvoice/TaxInvoice today; a CREDIT_NOTE tomorrow, see below) carries
// and decides which GSTR-1 table it belongs in. Never groups/aggregates transactions — that is
// the next phase (G2g-3c aggregation, explicitly NOT built here).
//
// Deliberately does NOT consume GstReportingLine (gstr1Normalizer.ts, G2g-3b) directly: that shape
// is a per-LINE snapshot (one InvoiceItem/SalesReturnItem/CreditNoteItem), but B2B/B2CL/B2CS is a
// per-TRANSACTION decision — the ₹1,00,000 B2CL threshold is compared against the whole invoice's
// persisted total (SalesInvoice.totalAmount / CreditNote.totalValue), never a line's own value
// (rule 12). It's also a per-transaction decision because a single invoice's lines all share one
// buyer GSTIN, one place of supply and one seller registration — classifying line-by-line would
// just repeat the same answer once per line for no benefit. A future aggregator builds this
// module's input from those persisted transaction-level fields (optionally cross-checked against
// G2g-3b's own per-line snapshot of the same buyer/seller/place-of-supply facts) — G2g-3b itself
// is untouched by this phase.
//
// Money follows this codebase's existing convention (see gstr1Normalizer.ts's own header): plain
// `number`, Prisma Decimal already unwrapped by the caller. Threshold comparisons are still done
// in integer paise (see toPaise) to avoid floating-point boundary bugs at exactly ₹1,00,000.

import { IST_OFFSET_MS } from '../../../shared/compliance';
import { validateGstin } from '../../../shared/gstin';

export type Gstr1OutwardCategory = 'B2B' | 'B2CL' | 'B2CS';

/** Returned when the input doesn't have what a specific, correct classification needs — never
 *  guessed at (rule 9: "never silently misclassify incomplete data"). */
export const UNCLASSIFIED = 'UNCLASSIFIED' as const;

const GST_STATE_CODE_RE = /^\d{2}$/;

/** Syntactically valid GST state-code shape (exactly two digits) — a format check only, not a
 *  membership check against the live StateMaster table (this module takes no Prisma dependency;
 *  see the module header). Enough to tell "a real resolved code" (e.g. "24") apart from the raw,
 *  unresolved free text `TaxInvoice.placeOfSupply`/`sellerStateCode` can otherwise hold (see
 *  shared/stateMaster.ts: an unmatched client/company state is persisted as free text or `''`,
 *  never coerced) — exactly the ambiguous case rule 9 requires this classifier to refuse rather
 *  than silently treat as same-state or inter-state. */
function isValidGstStateCode(code: string | null | undefined): code is string {
  return typeof code === 'string' && GST_STATE_CODE_RE.test(code);
}

/** Rule 7: trim, uppercase, empty string = absent. Presence-only — shape/checksum validity is a
 *  separate question, decided by isAcceptableRecipientGstin() below. */
function normalizeGstin(gstin: string | null | undefined): string | null {
  const trimmed = gstin?.trim().toUpperCase();
  return trimmed ? trimmed : null;
}

// G2g-4a.1: a present buyerGstin was previously accepted as B2B on non-empty alone — a malformed
// value (wrong length, garbage characters, wrong shape) could reach Table 4 unnoticed. Reuses
// shared/gstin.ts's validateGstin() (this codebase's one shared GSTIN validator — never
// re-implemented here) rather than inventing a second GSTIN-shape check alongside the classifier's
// own normalizeGstin() above and gstr1CreditNoteNormalizer.ts's sibling GSTIN_FORMAT regex.
//
// Deliberately does NOT reject on a checksum-only mismatch. validateGstin() checks structure
// (length/character set/PAN-and-entity shape/literal 'Z'), a recognized state code, AND the
// checksum digit — but every already-shipped, frozen GSTR-1 fixture in this codebase (gstr1
// Outward/Table12/CreditNote aggregation, Reporting service, Table13, AATO, Phase D — all
// G2g-3b through G2g-3g) uses a structurally well-formed placeholder buyer GSTIN with no real
// checksum (e.g. "27AAAAA0000A1Z5"). Enforcing checksum here would silently flip every one of
// those frozen B2B/CDNR classifications to UNCLASSIFIED with no change of their own — exactly the
// "do not revisit frozen G2g-3b-3g work" this phase (G2g-4a) is scoped to avoid. A checksum-only
// mismatch is therefore accepted (matches this subsystem's existing precedent:
// gstr1CreditNoteNormalizer.ts's own classifyCreditNoteRecipient() is ALSO structural-only, never
// checksum). Genuinely malformed input (wrong length, invalid characters, bad PAN/entity shape, an
// unrecognized state code) is still rejected — that is the actual audit-finding risk (garbage data
// silently becoming B2B), not a single mistyped final digit on an otherwise well-formed GSTIN.
function isAcceptableRecipientGstin(gstin: string): boolean {
  const result = validateGstin(gstin);
  if (result.valid) return true;
  return result.errors.length === 1 && /checksum/i.test(result.errors[0]);
}

/** Integer-paise comparison — avoids the classic `100000.01 - 100000` float boundary bug at the
 *  exact ₹1,00,000 statutory threshold (rule 12). */
function toPaise(rupees: number): number {
  return Math.round(rupees * 100);
}

// The B2CL threshold moved from ₹2,50,000 to ₹1,00,000 for return periods from August 2024
// onward (rule 4/13). Named and dated explicitly so a historical transaction is never silently
// judged by today's rule. IST midnight of 1 Aug 2024, expressed as the UTC instant it actually
// is — same IST-anchoring convention as shared/istDate.ts (no DST in IST, fixed +5:30 offset).
const B2CL_THRESHOLD_CHANGE_IST_UTC_MS = Date.UTC(2024, 7, 1) - IST_OFFSET_MS;

const B2CL_THRESHOLD_CURRENT = 100_000; // ₹1,00,000 — return periods Aug 2024 onward
const B2CL_THRESHOLD_HISTORICAL = 250_000; // ₹2,50,000 — return periods before Aug 2024

/**
 * The statutory B2CL invoice-value threshold in force for the return period a transaction falls
 * in, keyed off the transaction's own invoice/document date (never "today" — a report run in
 * 2026 for a 2023 period must still apply the 2023 rule).
 */
export function getB2cLargeThreshold(reportingDate: Date): number {
  return reportingDate.getTime() >= B2CL_THRESHOLD_CHANGE_IST_UTC_MS
    ? B2CL_THRESHOLD_CURRENT
    : B2CL_THRESHOLD_HISTORICAL;
}

export interface ClassifyGstr1OutwardSupplyInput {
  /** Buyer GSTIN exactly as persisted (TaxInvoice.buyerGstin / CreditNote's own buyer snapshot).
   *  Normalized per rule 7; non-empty after normalization = registered recipient (rule 1/2/3). */
  buyerGstin: string | null | undefined;

  /** The 2-digit GST state code of the GST registration THIS transaction was actually invoiced
   *  under (TaxInvoice.sellerStateCode — the immutable per-invoice snapshot captured at
   *  resolveSellerRegistration() time, never the company's current primary registration; rule 5).
   *  Required for any classification decision (a GSTR-1 return is registration-specific — rule 6
   *  — so a transaction with no identifiable seller state cannot be attributed to one). */
  sellerStateCode: string | null | undefined;

  /** The GST registration id this transaction was invoiced under (TaxInvoice.sellerRegistrationId).
   *  Carried through to the output completely unchanged (rule 6, rule 19) — never itself used to
   *  derive a state. Required: a null value here means the transaction cannot be attributed to a
   *  specific registration's return, so classification refuses rather than guessing (rule 9). */
  sellerRegistrationId: string | null | undefined;

  /** Place of supply exactly as persisted (TaxInvoice.placeOfSupply / a CreditNote's own
   *  snapshot) — a 2-digit GST state code when the transaction's own state resolution succeeded,
   *  or raw unresolved text / `''` otherwise (see shared/stateMaster.ts). Only required for an
   *  UNREGISTERED recipient, where it decides inter-state vs intra-state (rule 2/3); a B2B
   *  transaction is classified from `buyerGstin` alone regardless of place-of-supply validity
   *  (rule 1's "primary indicator"). */
  placeOfSupply: string | null | undefined;

  /** The transaction's persisted, authoritative total value INCLUSIVE of GST (SalesInvoice.
   *  totalAmount / CreditNote.totalValue) — never a line's taxableValue, never tax amount, never
   *  reconstructed by summing lines (rule 12). Required for any classification decision. */
  invoiceValue: number | null | undefined;

  /** The date that selects which statutory B2CL threshold applies (rule 4/13) — the transaction's
   *  own invoice/document date, never "today." Only required for an UNREGISTERED + inter-state
   *  transaction (the only path that consults a threshold at all — rule 3's intra-state case is
   *  value-independent, and B2B doesn't use a threshold). */
  invoiceDate: Date | null | undefined;
}

export interface Gstr1OutwardClassification {
  category: Gstr1OutwardCategory | typeof UNCLASSIFIED;
  isRegisteredRecipient: boolean;
  /** null when the recipient is registered and place-of-supply/seller-state weren't both
   *  resolvable (immaterial to a B2B decision — not required, not computed as a guess), or when
   *  classification was refused outright. */
  isInterState: boolean | null;
  /** The B2CL threshold actually applied, in rupees. Populated only on the one path that uses a
   *  threshold at all: an unregistered, inter-state transaction (rule 3's intra-state case is
   *  explicitly value-independent, so a threshold would be decorative, not decisive — left null). */
  threshold: number | null;
  /** Passed through unchanged from the input (rule 6, rule 19) — never derived, never altered. */
  sellerRegistrationId: string | null;
  /** Human-readable explanation of the decision — which rule fired, or why classification was
   *  refused. Not statutory text, just an audit/debug trail for the caller. */
  reason: string;
}

function unclassified(
  reason: string,
  extra: Partial<Pick<Gstr1OutwardClassification, 'isRegisteredRecipient' | 'sellerRegistrationId'>> = {},
): Gstr1OutwardClassification {
  return {
    category: UNCLASSIFIED,
    isRegisteredRecipient: extra.isRegisteredRecipient ?? false,
    isInterState: null,
    threshold: null,
    sellerRegistrationId: extra.sellerRegistrationId ?? null,
    reason,
  };
}

/**
 * Classifies one outward supply transaction into GSTR-1's B2B / B2CL / B2CS, per rules 1–3, or
 * refuses with UNCLASSIFIED when the inputs it needs for that specific path aren't there (rule 9).
 * Pure and side-effect free — no Prisma, no Date.now(), no randomness; same input always produces
 * the same output.
 */
export function classifyGstr1OutwardSupply(input: ClassifyGstr1OutwardSupplyInput): Gstr1OutwardClassification {
  const buyerGstin = normalizeGstin(input.buyerGstin);
  const isRegisteredRecipient = buyerGstin !== null;

  const sellerRegistrationId = input.sellerRegistrationId?.trim() || null;
  if (!sellerRegistrationId) {
    return unclassified(
      'Missing seller registration — a GSTR-1 return is registration-specific (rule 6); this transaction cannot be attributed to one without it.',
      { isRegisteredRecipient },
    );
  }

  const invoiceValue = input.invoiceValue;
  if (invoiceValue == null || !Number.isFinite(invoiceValue) || invoiceValue < 0) {
    return unclassified(
      'Missing or invalid invoice value — the B2CL/B2CS threshold and every downstream total depend on the persisted, tax-inclusive document total (rule 12).',
      { isRegisteredRecipient, sellerRegistrationId },
    );
  }

  // Rule 1: B2B is decided from buyer GSTIN presence alone. Interstate/place-of-supply is
  // immaterial to the B2B decision itself, so an unresolvable place of supply never blocks it —
  // isInterState is reported best-effort (for the caller's own record-keeping) and stays null
  // when it can't be determined, rather than forcing a POS requirement B2B doesn't statutorily need.
  if (isRegisteredRecipient) {
    // G2g-4a.1: a malformed buyer GSTIN must never be silently reclassified as an unregistered
    // B2C customer (which would route it to B2CS/B2CL instead) — refuse outright with a distinct
    // diagnostic instead.
    if (!isAcceptableRecipientGstin(buyerGstin as string)) {
      return unclassified(
        `Buyer GSTIN "${buyerGstin}" is present but structurally malformed — refusing to classify as B2B or silently fall back to an unregistered B2C category (diagnostic: INVALID_RECIPIENT_GSTIN).`,
        { isRegisteredRecipient, sellerRegistrationId },
      );
    }

    const sellerStateCode = input.sellerStateCode ?? null;
    const placeOfSupply = input.placeOfSupply ?? null;
    const bothResolvable = isValidGstStateCode(sellerStateCode) && isValidGstStateCode(placeOfSupply);
    return {
      category: 'B2B',
      isRegisteredRecipient: true,
      isInterState: bothResolvable ? sellerStateCode !== placeOfSupply : null,
      threshold: null,
      sellerRegistrationId,
      reason: 'Registered recipient — buyer GSTIN present, so classified B2B regardless of place of supply or invoice value (rule 1).',
    };
  }

  // Unregistered recipient: B2CL vs B2CS depends on inter-state vs intra-state (rule 2/3), which
  // needs BOTH the seller's registration state and a validly resolved place of supply. Neither is
  // inferred or defaulted (rule 5/9) — an unresolved place of supply here is exactly the "raw,
  // unmatched client state text" case shared/stateMaster.ts documents, and this classifier refuses
  // it rather than falling back to the operational "unresolved = inter-state" convention
  // createInvoice() uses for tax calculation (that fallback is a business default for billing;
  // GSTR-1 classification needs a definite fact, not a default — rule 9).
  const sellerStateCode = input.sellerStateCode ?? null;
  if (!isValidGstStateCode(sellerStateCode)) {
    return unclassified(
      'Missing or malformed seller state code — cannot determine inter-state vs intra-state for an unregistered recipient (rule 5).',
      { isRegisteredRecipient, sellerRegistrationId },
    );
  }

  const placeOfSupply = input.placeOfSupply ?? null;
  if (!isValidGstStateCode(placeOfSupply)) {
    return unclassified(
      'Missing or unresolved place of supply — cannot determine inter-state vs intra-state for an unregistered recipient (rule 9); never assumed from customer address alone.',
      { isRegisteredRecipient, sellerRegistrationId },
    );
  }

  const isInterState = sellerStateCode !== placeOfSupply;

  // Rule 3: intra-state B2CS is independent of invoice value — no threshold involved at all.
  if (!isInterState) {
    return {
      category: 'B2CS',
      isRegisteredRecipient: false,
      isInterState: false,
      threshold: null,
      sellerRegistrationId,
      reason: 'Unregistered recipient, intra-state — B2CS regardless of invoice value (rule 3).',
    };
  }

  // Inter-state, unregistered: the only path that actually consults the B2CL threshold, so this
  // is also the only path that requires invoiceDate (rule 4/13).
  const invoiceDate = input.invoiceDate;
  if (!invoiceDate || Number.isNaN(invoiceDate.getTime())) {
    return unclassified(
      'Missing invoice date — the B2CL threshold is return-period-specific (rule 4/13) and cannot be selected without it.',
      { isRegisteredRecipient, sellerRegistrationId },
    );
  }

  const threshold = getB2cLargeThreshold(invoiceDate);
  const category: Gstr1OutwardCategory = toPaise(invoiceValue) > toPaise(threshold) ? 'B2CL' : 'B2CS';

  return {
    category,
    isRegisteredRecipient: false,
    isInterState: true,
    threshold,
    sellerRegistrationId,
    reason: category === 'B2CL'
      ? `Unregistered recipient, inter-state, invoice value exceeds the ₹${threshold.toLocaleString('en-IN')} B2CL threshold in force for this invoice's date (rule 2/4).`
      : `Unregistered recipient, inter-state, invoice value at or below the ₹${threshold.toLocaleString('en-IN')} B2CL threshold in force for this invoice's date (rule 3/4).`,
  };
}
