// GST Credit Note reason-code whitelist (G2 design §3.3). Free-text alone isn't enough for GSTR-1's
// CDNR schedule, which expects a reason code — this is the same "free-text convention, validated
// server-side against a fixed whitelist constant" pattern already used for MakingCharge.karat /
// JewelryTag.metalKarat, not a Prisma enum (so a future addition needs no migration).
//
// COMPLIANCE CONFIRMATION REQUIRED (see PHASE_G2_GST_DOCUMENTS_LIFECYCLE_DESIGN.md §17 item 1):
// this list has not been verified against current GSTR-1 CDNR filing documentation — it is a
// reasonable software-level default, not sourced from a filing spec.
export const CREDIT_NOTE_REASONS = [
  'SALES_RETURN', // goods returned — auto-set when a CreditNote wraps a SalesReturn (Path A)
  'POST_SALE_DISCOUNT', // price reduced after issuance
  'DEFICIENCY_IN_SERVICE', // e.g. a repair/service charge waived after billing
  'CORRECTION_IN_INVOICE', // a genuine invoicing error (wrong rate/qty/party) corrected after issuance
  'CHANGE_IN_POS', // place-of-supply was wrong on the original invoice
  'OTHER', // reasonNotes should be provided when this is chosen
] as const;

export type CreditNoteReason = typeof CREDIT_NOTE_REASONS[number];

export function isValidCreditNoteReason(code: unknown): code is CreditNoteReason {
  return typeof code === 'string' && (CREDIT_NOTE_REASONS as readonly string[]).includes(code);
}

// G2e — Debit Note reason-code whitelist (purchase-side mirror of CREDIT_NOTE_REASONS above, per
// PHASE_G2_GST_DOCUMENTS_LIFECYCLE_DESIGN.md §4.2). Same "free-text convention, validated
// server-side against a fixed whitelist constant" pattern, not a Prisma enum.
//
// COMPLIANCE CONFIRMATION REQUIRED (same caveat as CREDIT_NOTE_REASONS above): not sourced from a
// filing spec.
//
// PURCHASE_RETURN is reserved for Path A (a Debit Note that wraps an existing PurchaseReturn) —
// createDebitNoteForPurchaseReturnTx sets it automatically and it must never be accepted from a
// standalone (Path B) request. OTHER has no defined accounting treatment for a standalone Debit
// Note (see debitNote.service.ts: createStandaloneDebitNote) and is likewise rejected there — it
// stays in this list only because it is a legitimate, generically-valid GST document reason code
// in the abstract (matching CREDIT_NOTE_REASONS's own shape), not because this codebase currently
// accepts it anywhere.
export const DEBIT_NOTE_REASONS = [
  'PURCHASE_RETURN', // goods returned to the supplier — auto-set when a DebitNote wraps a PurchaseReturn (Path A)
  'PRICE_VARIANCE', // a post-receipt rate/price correction agreed with the supplier
  'SHORT_SUPPLY', // less quantity/weight received than billed
  'QUALITY_DEDUCTION', // a quality-related deduction agreed with the supplier, no physical return
  'CORRECTION_IN_GRN', // a genuine GRN entry error corrected after the fact
  'OTHER', // no defined accounting treatment for a standalone Debit Note — see createStandaloneDebitNote
] as const;

export type DebitNoteReason = typeof DEBIT_NOTE_REASONS[number];

export function isValidDebitNoteReason(code: unknown): code is DebitNoteReason {
  return typeof code === 'string' && (DEBIT_NOTE_REASONS as readonly string[]).includes(code);
}

// G2g-4b — Sales (outward) Debit Note reason-code whitelist. A separate list from
// DEBIT_NOTE_REASONS above (that one is the purchase-side mirror of CREDIT_NOTE_REASONS, keyed to
// a PurchaseReturn/GRN) — this is the sell-side mirror instead, keyed to a SalesInvoice being
// corrected UPWARD (undercharged) rather than downward. Same "free-text convention, validated
// server-side against a fixed whitelist constant" pattern, not a Prisma enum.
//
// COMPLIANCE CONFIRMATION REQUIRED (same caveat as the two lists above): not sourced from a
// filing spec — a reasonable software-level default pending CA sign-off.
export const SALES_DEBIT_NOTE_REASONS = [
  'PRICE_INCREASE', // the agreed price was higher than originally billed — corrected upward
  'ADDITIONAL_QUANTITY_WEIGHT', // more quantity/weight actually supplied than originally billed
  'INTEREST_LATE_FEE', // interest/late-payment fee charged on an outstanding balance
  'CORRECTION_IN_INVOICE', // a genuine invoicing error (wrong rate/qty) corrected upward after issuance
  'OTHER', // reasonNotes should be provided when this is chosen
] as const;

export type SalesDebitNoteReason = typeof SALES_DEBIT_NOTE_REASONS[number];

export function isValidSalesDebitNoteReason(code: unknown): code is SalesDebitNoteReason {
  return typeof code === 'string' && (SALES_DEBIT_NOTE_REASONS as readonly string[]).includes(code);
}
