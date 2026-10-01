// G2g-3d-1 — Credit Note GSTR-1 classification + normalization FOUNDATION. Pure, deterministic,
// no Prisma access: takes ONE already-loaded, already-authorized CreditNote (+ its items) and
// produces a normalized reporting representation for the NEXT phase (G2g-3d-2 CDNR/CDNUR
// aggregation, NOT built here — this module never groups/nets multiple credit notes; see rule 12
// below). Mirrors the frozen G2g-3b/G2g-3c modules' own scope boundary and money convention: plain
// `number`, Prisma Decimal already unwrapped by the caller.
//
// Consumes, unmodified:
//   - gstr1Normalizer.ts (G2g-3b, frozen) — normalizeCreditNoteItemLine() turns one persisted
//     CreditNoteItem row into a GstReportingLine (HSN/UQC/quantity/tax already resolved from the
//     note's own snapshot). This module does not re-implement or duplicate that logic.
//   - gstr1Classification.ts (G2g-3c, frozen) — classifyGstr1OutwardSupply() decides B2B/B2CL/
//     B2CS/UNCLASSIFIED for the ORIGINAL outward supply this credit note reduces. Reused verbatim
//     against the ORIGINAL invoice's own persisted value/date — never the credit note's own value
//     (see "original supply category" below).
//
// Two Credit Note paths (see creditNote.service.ts's own module header for the full design this
// mirrors):
//   - PATH_A_SALES_RETURN: CreditNote wraps a SalesReturn. The SalesReturn is the accounting
//     event; the CreditNote is the GST/document representation. Discriminated ONLY by the
//     persisted `salesReturnId` — never inferred from amounts.
//   - PATH_B_STANDALONE: a value-only correction with its own journal, no physical return.
// Per the design brief: for GSTR-1, the CreditNote itself is always the reporting document on
// both paths — the underlying SalesReturn is never separately reported as a GSTR-1 credit note
// (SalesReturnItem lines are simply never consulted by this module).

import {
  type GstReportingLine,
  type CreditNoteItemSourceRow,
  type CreditNoteGstContext,
  normalizeCreditNoteItemLine,
} from './gstr1Normalizer';
import {
  classifyGstr1OutwardSupply,
  UNCLASSIFIED,
  type Gstr1OutwardCategory,
} from './gstr1Classification';

const round2 = (n: number) => Math.round(n * 100) / 100;

// Mirrors company.service.ts's own GSTIN_FORMAT check exactly (that module is not importable
// here — it carries a Prisma dependency, which this pure module must not take on). Rule 3/7:
// "do not invent GSTIN validation beyond a conservative format/shape check already used elsewhere
// in TRIVO" — this IS that check, reused by value since it isn't exported as a shared helper.
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z][0-9A-Z]$/;

export type Gstr1CreditNoteRecipientType = 'REGISTERED' | 'UNREGISTERED' | 'UNCLASSIFIED';
export type Gstr1CreditNoteReportingTable = 'CDNR' | 'CDNUR' | 'UNCLASSIFIED';
export type Gstr1CreditNoteSourcePath = 'PATH_A_SALES_RETURN' | 'PATH_B_STANDALONE';

/** Why a normalized document is NOT currently safe to report — the single, highest-priority
 *  reason (checked in a fixed order below), never a guess. A document can still carry a fully
 *  populated `document`/`lines` shape while excluded (rule: "never silently convert cancelled
 *  records into zero-value notes") — exclusion only gates the `reportable` flag the next phase
 *  (aggregation) is expected to honor. */
export type Gstr1CreditNoteExclusionReason =
  | 'CANCELLED'
  | 'INVALID_RECIPIENT_GSTIN'
  | 'MISSING_SELLER_REGISTRATION'
  | 'ORIGINAL_SUPPLY_UNCLASSIFIED'
  | 'EXPORT_CLASSIFICATION_UNAVAILABLE';

export type Gstr1CreditNoteDiagnosticCode =
  | Gstr1CreditNoteExclusionReason
  | 'UNSUPPORTED_UQC'
  | 'QUANTITY_UNAVAILABLE';

/** One informational note about this document or one of its lines — additive, never a reason on
 *  its own to drop data (see `exclusionReason` for the one thing that actually blocks reporting). */
export interface Gstr1CreditNoteDiagnostic {
  code: Gstr1CreditNoteDiagnosticCode;
  reason: string;
}

export interface Gstr1CreditNoteDocument {
  creditNoteId: string;
  creditNoteNumber: string;
  creditNoteDate: Date;
  /** CreditNote.status exactly as persisted ('ISSUED' | 'CANCELLED', free-text convention). */
  status: string;

  originalInvoiceId: string;
  originalInvoiceNumber: string;
  originalInvoiceDate: Date;

  /** Normalized (trim + uppercase) if present, else null — matches classifyGstr1OutwardSupply's
   *  own GSTIN normalization convention. */
  sellerRegistrationId: string | null;
  buyerGstin: string | null;
  placeOfSupply: string | null;

  recipientType: Gstr1CreditNoteRecipientType;
  /** The ORIGINAL outward supply's own B2B/B2CL/B2CS/UNCLASSIFIED category, from the frozen
   *  classifier, reused unchanged against the original invoice's own value/date. Independent of
   *  `reportingTable` — see that field's own comment for why the two are computed separately. */
  originalSupplyCategory: Gstr1OutwardCategory | typeof UNCLASSIFIED;
  /** CDNR when the recipient is registered, CDNUR when unregistered, UNCLASSIFIED only when the
   *  recipient's own GSTIN is present but malformed (rule 3) — determined from THIS module's own
   *  GSTIN shape check, not from originalSupplyCategory's B2B/B2CL/B2CS branch (which uses the
   *  frozen classifier's more permissive non-empty-string registration test). The two can
   *  legitimately diverge in edge cases; each is exactly what its own section of the spec asked
   *  for and neither is derived from the other. */
  reportingTable: Gstr1CreditNoteReportingTable;
  sourcePath: Gstr1CreditNoteSourcePath;

  reasonCode: string;
  reasonNotes: string | null;

  /** Tax-inclusive credit note total (CreditNote.totalAmount). */
  noteValue: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  /** Always 0 — CreditNote/CreditNoteItem has no cess column in this schema (only
   *  TaxInvoice.cess at the header, on the ORIGINAL invoice). Never fabricated or attributed down
   *  from that unrelated header figure (rule 6/7 — same posture gstr1Normalizer.ts's own
   *  cessAmount field already documents for InvoiceItem/CreditNoteItem lines). */
  cess: number;
}

export interface Gstr1CreditNoteNormalized {
  reportable: boolean;
  exclusionReason?: Gstr1CreditNoteExclusionReason;
  document: Gstr1CreditNoteDocument;
  lines: GstReportingLine[];
  diagnostics: Gstr1CreditNoteDiagnostic[];
}

/**
 * One already-loaded, already-authorized CreditNote + its items, exactly as persisted. The caller
 * (a future service/router) fetches this via tenantQuery scoped to one company — this module takes
 * no Prisma dependency and performs no lookup of its own (rule 14).
 */
export interface Gstr1CreditNoteSourceDocument {
  id: string;
  creditNoteNumber: string;
  creditNoteDate: Date;
  status: string;

  invoiceId: string;
  originalInvoiceNumber: string;
  originalInvoiceDate: Date;
  /** The ORIGINAL SalesInvoice's own persisted, tax-inclusive `totalAmount` — NOT this credit
   *  note's own value. Required to reuse classifyGstr1OutwardSupply's `invoiceValue` input
   *  against the original outward supply it's classifying (rule 4/12): the B2CL threshold and
   *  B2B/B2CL/B2CS decision are properties of the ORIGINAL sale, not of the credit note reducing
   *  it. Missing/invalid is not guessed — it flows straight into the classifier's own
   *  UNCLASSIFIED path exactly as any other invoice would. */
  originalInvoiceValue: number | null | undefined;

  /** Present only on a Path A note (creditNote.service.ts always sets it there, never on Path
   *  B) — the sole, authoritative discriminator between the two paths (never inferred from
   *  amounts, per the module header). */
  salesReturnId: string | null;

  /** CreditNote's own immutable seller/buyer snapshot (mirrors TaxInvoice's Part E fields
   *  exactly — see the CreditNote schema comment) — never re-fetched from TaxInvoice/the current
   *  CompanyGstRegistration. */
  sellerRegistrationId: string | null;
  sellerStateCode: string | null;
  buyerGstin: string | null;
  /** CreditNote.buyerCountry — defaults to 'India' at creation time (see sales.service.ts) when
   *  the client carries no explicit country, so a non-India value here is a real, persisted fact,
   *  not a guess. The one signal this module uses to recognize a possible cross-border recipient
   *  it cannot correctly export-classify (rule 13/"EXPORT_CLASSIFICATION_UNAVAILABLE"). */
  buyerCountry: string | null;
  placeOfSupply: string | null;

  reasonCode: string;
  reasonNotes: string | null;

  taxableAmount: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalTax: number;
  totalAmount: number;

  /** CreditNoteItem rows, in the exact shape gstr1Normalizer.ts already defines and consumes —
   *  reused unchanged, never a parallel shape (same convention as gstr1OutwardAggregation.ts). */
  items: CreditNoteItemSourceRow[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Recipient classification (rule 3) — deliberately its OWN function, distinct from
// classifyGstr1OutwardSupply's own registration test (which only checks non-empty, never shape —
// see that module's own `normalizeGstin` comment). A malformed-but-present GSTIN must not be
// silently treated as either registered or unregistered (rule 3's explicit instruction).
// ─────────────────────────────────────────────────────────────────────────────

interface RecipientClassification {
  recipientType: Gstr1CreditNoteRecipientType;
  /** Trim + uppercase normalized GSTIN, or null when absent/unclassified. */
  normalizedGstin: string | null;
  diagnostic?: Gstr1CreditNoteDiagnostic;
}

function classifyCreditNoteRecipient(buyerGstin: string | null | undefined): RecipientClassification {
  const trimmed = buyerGstin?.trim().toUpperCase();
  if (!trimmed) return { recipientType: 'UNREGISTERED', normalizedGstin: null };

  if (!GSTIN_FORMAT.test(trimmed)) {
    return {
      recipientType: 'UNCLASSIFIED',
      normalizedGstin: trimmed,
      diagnostic: {
        code: 'INVALID_RECIPIENT_GSTIN',
        reason: `Buyer GSTIN "${trimmed}" is present but does not match the standard 15-character GSTIN format — recipient registration status cannot be safely determined and is never guessed as unregistered (rule 3).`,
      },
    };
  }

  return { recipientType: 'REGISTERED', normalizedGstin: trimmed };
}

/** Rule 13: the one persisted signal ("buyerCountry is present and not India") this module uses to
 *  recognize a possible export recipient it has no export-with-payment/export-without-payment
 *  indicator to classify further — never inferred from GSTIN absence alone (a domestic
 *  unregistered B2C buyer has no GSTIN either, and is NOT an export). */
function isLikelyExportRecipient(buyerCountry: string | null | undefined): boolean {
  const normalized = buyerCountry?.trim().toUpperCase();
  return !!normalized && normalized !== 'INDIA';
}

// ─────────────────────────────────────────────────────────────────────────────
// The normalizer
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalizes ONE Credit Note into a GSTR-1 CDNR/CDNUR-ready representation. Pure and side-effect
 * free — no Prisma, no Date.now(), no randomness; same input always produces the same output.
 * Never aggregates/nets multiple notes (rule 12) — the caller invokes this once per CreditNote.
 *
 * Exclusion priority (rule: only ONE `exclusionReason` is ever reported, in this fixed order —
 * matching how a cancelled note must never even reach classification-quality questions):
 *   1. CANCELLED — status check alone, independent of everything else.
 *   2. INVALID_RECIPIENT_GSTIN — a malformed buyer GSTIN blocks CDNR/CDNUR placement outright.
 *   3. MISSING_SELLER_REGISTRATION — no GSTR-1 return can claim this document without one.
 *   4. EXPORT_CLASSIFICATION_UNAVAILABLE — a likely cross-border CDNUR recipient this module
 *      cannot correctly split into export-with-payment / export-without-payment (rule 13).
 *   5. ORIGINAL_SUPPLY_UNCLASSIFIED — the frozen classifier itself could not place the original
 *      supply (missing seller state / place of supply / invoice date, per its own rules).
 */
export function normalizeGstr1CreditNote(input: Gstr1CreditNoteSourceDocument): Gstr1CreditNoteNormalized {
  const diagnostics: Gstr1CreditNoteDiagnostic[] = [];

  const sourcePath: Gstr1CreditNoteSourcePath = input.salesReturnId ? 'PATH_A_SALES_RETURN' : 'PATH_B_STANDALONE';

  const recipient = classifyCreditNoteRecipient(input.buyerGstin);
  if (recipient.diagnostic) diagnostics.push(recipient.diagnostic);

  const sellerRegistrationId = input.sellerRegistrationId?.trim() || null;

  // Original supply category — reused verbatim against the ORIGINAL invoice's own persisted
  // value/date (rule 4/12), never this credit note's own noteValue/creditNoteDate.
  const classification = classifyGstr1OutwardSupply({
    buyerGstin: input.buyerGstin,
    sellerStateCode: input.sellerStateCode,
    sellerRegistrationId: input.sellerRegistrationId,
    placeOfSupply: input.placeOfSupply,
    invoiceValue: input.originalInvoiceValue,
    invoiceDate: input.originalInvoiceDate,
  });
  if (classification.category === UNCLASSIFIED) {
    diagnostics.push({ code: 'ORIGINAL_SUPPLY_UNCLASSIFIED', reason: classification.reason });
  }

  const reportingTable: Gstr1CreditNoteReportingTable =
    recipient.recipientType === 'REGISTERED' ? 'CDNR'
      : recipient.recipientType === 'UNREGISTERED' ? 'CDNUR'
        : 'UNCLASSIFIED';

  const exportUnavailable = reportingTable === 'CDNUR' && isLikelyExportRecipient(input.buyerCountry);
  if (exportUnavailable) {
    diagnostics.push({
      code: 'EXPORT_CLASSIFICATION_UNAVAILABLE',
      reason: `Buyer country "${input.buyerCountry}" suggests a cross-border recipient, but TRIVO has no persisted export-with-payment/export-without-payment indicator for Credit Notes — reporting this note under domestic B2CL/B2CS would misclassify it on GSTR-1 (rule 13); excluded pending a dedicated export flow, never guessed.`,
    });
  }

  let exclusionReason: Gstr1CreditNoteExclusionReason | undefined;
  if (input.status === 'CANCELLED') {
    exclusionReason = 'CANCELLED';
    diagnostics.push({
      code: 'CANCELLED',
      reason: 'This credit note has been cancelled — it must not become a reportable CDNR/CDNUR record; never silently converted into a zero-value note.',
    });
  } else if (recipient.recipientType === 'UNCLASSIFIED') {
    exclusionReason = 'INVALID_RECIPIENT_GSTIN';
  } else if (!sellerRegistrationId) {
    exclusionReason = 'MISSING_SELLER_REGISTRATION';
    diagnostics.push({
      code: 'MISSING_SELLER_REGISTRATION',
      reason: 'No seller GST registration is attached to this credit note — a GSTR-1 return is registration-specific; this document cannot be attributed to one.',
    });
  } else if (exportUnavailable) {
    exclusionReason = 'EXPORT_CLASSIFICATION_UNAVAILABLE';
  } else if (classification.category === UNCLASSIFIED) {
    exclusionReason = 'ORIGINAL_SUPPLY_UNCLASSIFIED';
  }

  const reportable = exclusionReason === undefined;

  const lineCtx: CreditNoteGstContext = {
    invoiceId: input.invoiceId,
    invoiceNumber: input.originalInvoiceNumber,
    salesReturnId: input.salesReturnId,
    creditNoteNumber: input.creditNoteNumber,
    creditNoteDate: input.creditNoteDate,
    status: input.status,
    buyerGstin: input.buyerGstin,
    placeOfSupply: input.placeOfSupply,
    sellerRegistrationId: input.sellerRegistrationId,
  };
  const lines = input.items.map((item) => normalizeCreditNoteItemLine(item, lineCtx));
  for (const line of lines) {
    if (line.quantityBasis === 'UNSUPPORTED_UQC' || line.quantityBasis === 'UNAVAILABLE') {
      diagnostics.push({
        code: line.quantityBasis === 'UNSUPPORTED_UQC' ? 'UNSUPPORTED_UQC' : 'QUANTITY_UNAVAILABLE',
        reason: `Line "${line.description ?? line.sourceId}" could not report a statutory Table 12 quantity (${line.quantityBasis}) — preserved with zero quantity rather than guessed (see gstr1Normalizer.ts's own quantity rules).`,
      });
    }
  }

  const document: Gstr1CreditNoteDocument = {
    creditNoteId: input.id,
    creditNoteNumber: input.creditNoteNumber,
    creditNoteDate: input.creditNoteDate,
    status: input.status,
    originalInvoiceId: input.invoiceId,
    originalInvoiceNumber: input.originalInvoiceNumber,
    originalInvoiceDate: input.originalInvoiceDate,
    sellerRegistrationId,
    buyerGstin: recipient.normalizedGstin,
    placeOfSupply: input.placeOfSupply ?? null,
    recipientType: recipient.recipientType,
    originalSupplyCategory: classification.category,
    reportingTable,
    sourcePath,
    reasonCode: input.reasonCode,
    reasonNotes: input.reasonNotes ?? null,
    noteValue: round2(Number(input.totalAmount)),
    taxableValue: round2(Number(input.taxableAmount)),
    igst: round2(Number(input.igst)),
    cgst: round2(Number(input.cgst)),
    sgst: round2(Number(input.sgst)),
    cess: 0,
  };

  return { reportable, exclusionReason, document, lines, diagnostics };
}
