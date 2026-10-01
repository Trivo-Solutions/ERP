// G2g-4b.2 — GSTR-1 adapter/wrapper for Sales (outward) Debit Notes. Pure, deterministic, no
// Prisma access — mirrors gstr1CreditNoteNormalizer.ts + gstr1CreditNoteAggregation.ts's own
// architecture exactly (caller/service -> already-authorized source documents -> frozen
// classifier/normalizer helpers -> this pure adapter -> report result), with every direction
// reversed: a Sales Debit Note is a POSITIVE outward adjustment (it increases a previously
// reported supply), never a reduction.
//
// This file is an ADAPTER, not a modification of any frozen module. It reuses, unmodified:
//   - gstr1Classification.ts (frozen) — classifyGstr1OutwardSupply() decides the ORIGINAL outward
//     supply's own B2B/B2CL/B2CS/UNCLASSIFIED category, from the ORIGINAL invoice's own persisted
//     value/date — never this debit note's own value/date (same rule gstr1CreditNoteNormalizer.ts
//     already follows).
//   - gstr1Normalizer.ts (frozen) — resolveReportingUqc()/normalizeGstQuantity() for per-line
//     UQC/quantity resolution. This file does NOT reuse that module's `GstReportingLine` type
//     itself: that type's `sourceType` union (`'INVOICE' | 'SALES_RETURN' | 'CREDIT_NOTE'`) has no
//     'DEBIT_NOTE' member, and widening a frozen exported union is itself a modification of that
//     frozen contract — so this file defines its own narrow `Gstr1SalesDebitNoteReportingLine`
//     shape instead, carrying the identical field set this module actually needs.
//   - gstr1OutwardAggregation.ts (frozen) — only its exported TYPES (`Gstr1OutwardAggregation`,
//     `Gstr1B2csGroup`), never its aggregation function and never a parallel B2CL/B2CS threshold
//     (section 11's explicit instruction). Table 7 netting/addition is applied by
//     `applySalesDebitNotesToOutwardAggregation()` below, AFTER the frozen aggregator has already
//     produced its own (gross - eligible Credit Notes) result — this module only adds the eligible
//     Sales Debit Note value on top of that, never re-deriving B2B/B2CL/B2CS itself.
//   - gstr1Table12Aggregation.ts (frozen) — only its exported TYPES
//     (`Gstr1Table12Aggregation`, `Gstr1Table12Row`), for the identical reason.
//   - gstr1Table13Aggregation.ts (frozen) — `Table13Document`'s shape; `toTable13SalesDebitNoteDocument()`
//     below only maps a persisted SalesDebitNote onto that existing shape with
//     `documentType: 'OUTWARD_DEBIT_NOTE'` (a category the frozen engine's own
//     `resolveDocumentCategory()` already recognizes — no engine change needed at all).
//
// Money follows this codebase's established convention: plain `number`, Prisma Decimal already
// unwrapped by the caller — no decimal.js. Every running sum goes through round2() at each step.

import {
  resolveReportingUqc,
  normalizeGstQuantity,
  type GstUqcSource,
  type GstQuantityBasis,
} from './gstr1Normalizer';
import {
  classifyGstr1OutwardSupply,
  UNCLASSIFIED,
  type Gstr1OutwardCategory,
} from './gstr1Classification';
import type { Gstr1OutwardAggregation, Gstr1B2csGroup } from './gstr1OutwardAggregation';
import type { Gstr1Table12Aggregation, Gstr1Table12Row, Gstr1Table12ReportingTab } from './gstr1Table12Aggregation';
import type { Table13Document } from './gstr1Table13Aggregation';
import type { BranchAccess } from '../../../shared/tenantContext';

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Raised only for an authorization refusal — never for a data-quality problem (always a
 *  diagnostic record instead). Mirrors Gstr1CreditNoteAggregationAccessError exactly; kept as its
 *  own class so this module stays fully self-contained, same precedent every sibling aggregator
 *  in this directory already follows. */
export class Gstr1SalesDebitNoteAdapterAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Gstr1SalesDebitNoteAdapterAccessError';
  }
}

// Mirrors company.service.ts's / gstr1CreditNoteNormalizer.ts's own GSTIN_FORMAT check exactly —
// this pure module takes no Prisma dependency, so the check is reused by value, not by import.
const GSTIN_FORMAT = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z][Z][0-9A-Z]$/;

// ─────────────────────────────────────────────────────────────────────────────
// Section 11 — normalization (mirrors gstr1CreditNoteNormalizer.ts's own normalizeGstr1CreditNote,
// direction reversed: a debit note ADDS to the original outward supply, it never reduces it).
// ─────────────────────────────────────────────────────────────────────────────

export type Gstr1SalesDebitNoteRecipientType = 'REGISTERED' | 'UNREGISTERED' | 'UNCLASSIFIED';
export type Gstr1SalesDebitNoteReportingTable = 'CDNR' | 'CDNUR' | 'UNCLASSIFIED';

export type Gstr1SalesDebitNoteExclusionReason =
  | 'CANCELLED'
  | 'INVALID_RECIPIENT_GSTIN'
  | 'MISSING_SELLER_REGISTRATION'
  | 'ORIGINAL_SUPPLY_UNCLASSIFIED'
  | 'EXPORT_CLASSIFICATION_UNAVAILABLE';

export type Gstr1SalesDebitNoteDiagnosticCode =
  | Gstr1SalesDebitNoteExclusionReason
  | 'UNSUPPORTED_UQC'
  | 'QUANTITY_UNAVAILABLE';

export interface Gstr1SalesDebitNoteDiagnostic {
  code: Gstr1SalesDebitNoteDiagnosticCode;
  reason: string;
}

/** This module's own narrow per-line shape — see the file header for why this is not
 *  `GstReportingLine` itself. */
export interface Gstr1SalesDebitNoteReportingLine {
  sourceId: string;
  hsnCode: string | null;
  description: string | null;
  uqc: string | null;
  uqcSource: GstUqcSource;
  quantity: number;
  quantityBasis: GstQuantityBasis;
  taxableValue: number;
  cgstAmount: number;
  sgstAmount: number;
  igstAmount: number;
  /** Always 0 — SalesDebitNoteItem has no independently computed cess in this phase (see the
   *  schema model's own comment: no cess-rate master exists for this jewelry-only business). */
  cessAmount: number;
  gstRate: number;
}

export interface Gstr1SalesDebitNoteItemSourceRow {
  id: string;
  description: string;
  hsnCode: { code: string; description: string | null; defaultUqc: string | null } | null;
  hsnCodeId: string | null;
  uqc: string | null;
  /** Decimal | null. Null on every value-only line, same convention as CreditNoteItem.quantity. */
  quantity: unknown;
  taxRate: unknown;
  taxableValue: unknown;
  cgstAmount: unknown;
  sgstAmount: unknown;
  igstAmount: unknown;
  totalValue: unknown;
  netWeight: unknown;
}

export interface Gstr1SalesDebitNoteDocument {
  debitNoteId: string;
  debitNoteNumber: string;
  debitNoteDate: Date;
  /** SalesDebitNote.status exactly as persisted ('ISSUED' | 'CANCELLED', free-text convention). */
  status: string;

  originalInvoiceId: string;
  originalInvoiceNumber: string;
  originalInvoiceDate: Date;

  sellerRegistrationId: string | null;
  buyerGstin: string | null;
  placeOfSupply: string | null;

  recipientType: Gstr1SalesDebitNoteRecipientType;
  /** The ORIGINAL outward supply's own B2B/B2CL/B2CS/UNCLASSIFIED category, from the frozen
   *  classifier, reused unchanged against the ORIGINAL invoice's own value/date — never this debit
   *  note's own value/date (section 11's explicit instruction). */
  originalSupplyCategory: Gstr1OutwardCategory | typeof UNCLASSIFIED;
  reportingTable: Gstr1SalesDebitNoteReportingTable;

  reasonCode: string;
  reasonNotes: string | null;

  /** Tax-inclusive Sales Debit Note total (SalesDebitNote.totalAmount). */
  noteValue: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface Gstr1SalesDebitNoteNormalized {
  reportable: boolean;
  exclusionReason?: Gstr1SalesDebitNoteExclusionReason;
  document: Gstr1SalesDebitNoteDocument;
  lines: Gstr1SalesDebitNoteReportingLine[];
  diagnostics: Gstr1SalesDebitNoteDiagnostic[];
}

/**
 * One already-loaded, already-authorized SalesDebitNote + its items, exactly as persisted. The
 * caller (the reporting service layer) fetches this via tenantQuery scoped to one company — this
 * module takes no Prisma dependency and performs no lookup of its own.
 */
export interface Gstr1SalesDebitNoteSourceDocument {
  id: string;
  debitNoteNumber: string;
  debitNoteDate: Date;
  status: string;

  invoiceId: string;
  originalInvoiceNumber: string;
  originalInvoiceDate: Date;
  /** The ORIGINAL SalesInvoice's own persisted, tax-inclusive `totalAmount` — NOT this debit
   *  note's own value. Required to reuse classifyGstr1OutwardSupply's `invoiceValue` input against
   *  the original outward supply it's classifying (section 11/14) — the B2CL threshold and
   *  B2B/B2CL/B2CS decision are properties of the ORIGINAL sale, never of the debit note
   *  increasing it. */
  originalInvoiceValue: number | null | undefined;

  /** SalesDebitNote's own immutable seller/buyer snapshot (mirrors TaxInvoice/CreditNote's Part E
   *  fields exactly) — never re-fetched from TaxInvoice/the current CompanyGstRegistration. */
  sellerRegistrationId: string | null;
  sellerStateCode: string | null;
  buyerGstin: string | null;
  /** SalesDebitNote.buyerCountry — defaults to 'India' at creation time when the client carries no
   *  explicit country (same convention CreditNote/TaxInvoice already follow), so a non-India value
   *  here is a real, persisted fact, not a guess. */
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

  items: Gstr1SalesDebitNoteItemSourceRow[];
}

interface RecipientClassification {
  recipientType: Gstr1SalesDebitNoteRecipientType;
  normalizedGstin: string | null;
  diagnostic?: Gstr1SalesDebitNoteDiagnostic;
}

function classifySalesDebitNoteRecipient(buyerGstin: string | null | undefined): RecipientClassification {
  const trimmed = buyerGstin?.trim().toUpperCase();
  if (!trimmed) return { recipientType: 'UNREGISTERED', normalizedGstin: null };

  if (!GSTIN_FORMAT.test(trimmed)) {
    return {
      recipientType: 'UNCLASSIFIED',
      normalizedGstin: trimmed,
      diagnostic: {
        code: 'INVALID_RECIPIENT_GSTIN',
        reason: `Buyer GSTIN "${trimmed}" is present but does not match the standard 15-character GSTIN format — recipient registration status cannot be safely determined and is never guessed as unregistered.`,
      },
    };
  }

  return { recipientType: 'REGISTERED', normalizedGstin: trimmed };
}

function isLikelyExportRecipient(buyerCountry: string | null | undefined): boolean {
  const normalized = buyerCountry?.trim().toUpperCase();
  return !!normalized && normalized !== 'INDIA';
}

function normalizeSalesDebitNoteItemLine(item: Gstr1SalesDebitNoteItemSourceRow): Gstr1SalesDebitNoteReportingLine {
  const { uqc, source: uqcSource } = resolveReportingUqc(item.uqc, item.hsnCode?.defaultUqc);
  const persistedQuantity = item.quantity != null ? Number(item.quantity) : null;
  const persistedNetWeight = item.netWeight != null ? Number(item.netWeight) : null;
  const { quantity, basis: quantityBasis } = normalizeGstQuantity({
    uqc,
    hasPhysicalQuantity: persistedQuantity != null,
    billingQuantity: persistedQuantity,
    netWeight: persistedNetWeight,
  });

  return {
    sourceId: item.id,
    hsnCode: item.hsnCode?.code ?? null,
    description: item.description,
    uqc, uqcSource,
    quantity, quantityBasis,
    taxableValue: Number(item.taxableValue),
    cgstAmount: Number(item.cgstAmount),
    sgstAmount: Number(item.sgstAmount),
    igstAmount: Number(item.igstAmount),
    cessAmount: 0,
    gstRate: Number(item.taxRate),
  };
}

/**
 * Normalizes ONE Sales Debit Note into a GSTR-1 CDNR/CDNUR-ready representation (positive
 * direction). Pure and side-effect free. Exclusion priority mirrors
 * gstr1CreditNoteNormalizer.ts's own fixed order exactly:
 *   1. CANCELLED, 2. INVALID_RECIPIENT_GSTIN, 3. MISSING_SELLER_REGISTRATION,
 *   4. EXPORT_CLASSIFICATION_UNAVAILABLE, 5. ORIGINAL_SUPPLY_UNCLASSIFIED.
 */
export function normalizeGstr1SalesDebitNote(input: Gstr1SalesDebitNoteSourceDocument): Gstr1SalesDebitNoteNormalized {
  const diagnostics: Gstr1SalesDebitNoteDiagnostic[] = [];

  const recipient = classifySalesDebitNoteRecipient(input.buyerGstin);
  if (recipient.diagnostic) diagnostics.push(recipient.diagnostic);

  const sellerRegistrationId = input.sellerRegistrationId?.trim() || null;

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

  const reportingTable: Gstr1SalesDebitNoteReportingTable =
    recipient.recipientType === 'REGISTERED' ? 'CDNR'
      : recipient.recipientType === 'UNREGISTERED' ? 'CDNUR'
        : 'UNCLASSIFIED';

  const exportUnavailable = reportingTable === 'CDNUR' && isLikelyExportRecipient(input.buyerCountry);
  if (exportUnavailable) {
    diagnostics.push({
      code: 'EXPORT_CLASSIFICATION_UNAVAILABLE',
      reason: `Buyer country "${input.buyerCountry}" suggests a cross-border recipient, but TRIVO has no persisted export indicator for Sales Debit Notes — reporting this note under domestic B2CL/B2CS would misclassify it; excluded pending a dedicated export flow, never guessed.`,
    });
  }

  let exclusionReason: Gstr1SalesDebitNoteExclusionReason | undefined;
  if (input.status === 'CANCELLED') {
    exclusionReason = 'CANCELLED';
    diagnostics.push({ code: 'CANCELLED', reason: 'This sales debit note has been cancelled — it must not become a reportable CDNR/CDNUR record.' });
  } else if (recipient.recipientType === 'UNCLASSIFIED') {
    exclusionReason = 'INVALID_RECIPIENT_GSTIN';
  } else if (!sellerRegistrationId) {
    exclusionReason = 'MISSING_SELLER_REGISTRATION';
    diagnostics.push({ code: 'MISSING_SELLER_REGISTRATION', reason: 'No seller GST registration is attached to this sales debit note — a GSTR-1 return is registration-specific.' });
  } else if (exportUnavailable) {
    exclusionReason = 'EXPORT_CLASSIFICATION_UNAVAILABLE';
  } else if (classification.category === UNCLASSIFIED) {
    exclusionReason = 'ORIGINAL_SUPPLY_UNCLASSIFIED';
  }

  const reportable = exclusionReason === undefined;

  const lines = input.items.map((item) => normalizeSalesDebitNoteItemLine(item));
  for (const line of lines) {
    if (line.quantityBasis === 'UNSUPPORTED_UQC' || line.quantityBasis === 'UNAVAILABLE') {
      diagnostics.push({
        code: line.quantityBasis === 'UNSUPPORTED_UQC' ? 'UNSUPPORTED_UQC' : 'QUANTITY_UNAVAILABLE',
        reason: `Line "${line.description ?? line.sourceId}" could not report a statutory Table 12 quantity (${line.quantityBasis}).`,
      });
    }
  }

  const document: Gstr1SalesDebitNoteDocument = {
    debitNoteId: input.id,
    debitNoteNumber: input.debitNoteNumber,
    debitNoteDate: input.debitNoteDate,
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

// ─────────────────────────────────────────────────────────────────────────────
// Section 13 — Table 9B CDNR/CDNUR aggregation (positive direction). Mirrors
// gstr1CreditNoteAggregation.ts's own architecture exactly.
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1SalesDebitNoteAggregationSourceDocument extends Gstr1SalesDebitNoteSourceDocument {
  branchId: string | null | undefined;
}

export interface Gstr1SalesDebitNoteAggregationOptions {
  gstRegistrationId: string;
  period: { from: Date; to: Date };
  branchAccess?: BranchAccess;
  branchId?: string;
}

export interface Gstr1SalesDebitNoteRateBreakdown {
  rate: number;
  hsnCode: string | null;
  uqc: string | null;
  quantity: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
}

export interface Gstr1SalesDebitNoteReportDocument {
  /** A Sales Debit Note is always an INCREASE — `documentType`/`sign` make the reporting direction
   *  explicit (mirrors CreditNote's own `documentType: 'CREDIT_NOTE', sign: -1` convention), while
   *  every money field keeps the note's own actual persisted positive value. */
  documentType: 'DEBIT_NOTE';
  sign: 1;

  debitNoteId: string;
  debitNoteNumber: string;
  debitNoteDate: Date;

  originalInvoiceId: string;
  originalInvoiceNumber: string;
  originalInvoiceDate: Date;

  buyerGstin: string | null;
  sellerRegistrationId: string;
  placeOfSupply: string | null;

  originalSupplyCategory: Gstr1SalesDebitNoteDocument['originalSupplyCategory'];

  reasonCode: string;
  reasonNotes: string | null;

  noteValue: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;

  rateBreakdown: Gstr1SalesDebitNoteRateBreakdown[];
  diagnostics: Gstr1SalesDebitNoteDiagnostic[];
}

export interface Gstr1SalesDebitNoteBucketSummary {
  documentCount: number;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  cess: number;
  noteValue: number;
}

export interface Gstr1SalesDebitNoteBucket {
  documents: Gstr1SalesDebitNoteReportDocument[];
  summary: Gstr1SalesDebitNoteBucketSummary;
}

export interface Gstr1SalesDebitNoteExclusionRecord {
  debitNoteId: string;
  debitNoteNumber: string;
  debitNoteDate: Date;
  exclusionReason: Gstr1SalesDebitNoteExclusionReason;
  diagnostics: Gstr1SalesDebitNoteDiagnostic[];
  document: Gstr1SalesDebitNoteDocument;
}

export type Gstr1SalesDebitNoteAggregationDiagnosticReason =
  | 'OUT_OF_SCOPE_REGISTRATION'
  | 'OUT_OF_SCOPE_BRANCH'
  | 'OUT_OF_SCOPE_PERIOD'
  | 'DUPLICATE_SOURCE_ID'
  | 'UNREACHABLE_CLASSIFICATION'
  | Gstr1SalesDebitNoteDiagnosticCode;

export interface Gstr1SalesDebitNoteAggregationDiagnostic {
  debitNoteId: string;
  debitNoteNumber: string | null;
  reason: Gstr1SalesDebitNoteAggregationDiagnosticReason;
  detail: string;
}

export interface Gstr1SalesDebitNoteAggregation {
  cdnr: Gstr1SalesDebitNoteBucket;
  cdnur: {
    b2cl: Gstr1SalesDebitNoteBucket;
    /** Always empty — export support is out of scope here, same posture as the credit-note
     *  aggregator's own permanently-empty `export` placeholder. */
    export: Gstr1SalesDebitNoteBucket;
  };
  /** Every reportable Sales Debit Note whose ORIGINAL outward supply was itself B2CS — NOT part of
   *  Table 9B's CDNR/CDNUR at all (GSTN has no "CDNUR B2CS" category). Consumed by
   *  `applySalesDebitNotesToOutwardAggregation()` below to ADD to Table 7's matching B2CS bucket
   *  ("Net B2CS = Gross B2CS + eligible Sales Debit Notes - eligible Credit Notes"). This aggregator
   *  itself performs no addition — see this file's own header. */
  b2csAddOn: Gstr1SalesDebitNoteBucket;
  diagnostics: Gstr1SalesDebitNoteAggregationDiagnostic[];
  excluded: Gstr1SalesDebitNoteExclusionRecord[];
  meta: {
    gstRegistrationId: string;
    period: { from: Date; to: Date };
    notesConsidered: number;
    notesExcludedByScope: number;
  };
}

function resolveAllowedBranchIds(branchAccess: BranchAccess | undefined, branchId: string | undefined): string[] | undefined {
  if (branchId) {
    if (branchAccess && !branchAccess.allBranches && !branchAccess.branchIds.includes(branchId)) {
      throw new Gstr1SalesDebitNoteAdapterAccessError(
        `Branch ${branchId} is not accessible to the caller — rejected outright rather than silently aggregating without it.`,
      );
    }
    return [branchId];
  }
  return branchAccess && !branchAccess.allBranches ? branchAccess.branchIds : undefined;
}

function rateBreakdownKey(line: Gstr1SalesDebitNoteReportingLine): string {
  return `${line.hsnCode ?? ''}\u0000${line.gstRate}\u0000${line.uqc ?? ''}`;
}

function buildRateBreakdown(lines: Gstr1SalesDebitNoteReportingLine[]): Gstr1SalesDebitNoteRateBreakdown[] {
  const byKey = new Map<string, Gstr1SalesDebitNoteRateBreakdown>();
  for (const line of lines) {
    const key = rateBreakdownKey(line);
    const existing = byKey.get(key);
    if (existing) {
      existing.quantity = round2(existing.quantity + line.quantity);
      existing.taxableValue = round2(existing.taxableValue + line.taxableValue);
      existing.igst = round2(existing.igst + line.igstAmount);
      existing.cgst = round2(existing.cgst + line.cgstAmount);
      existing.sgst = round2(existing.sgst + line.sgstAmount);
      existing.cess = round2(existing.cess + line.cessAmount);
    } else {
      byKey.set(key, {
        rate: line.gstRate, hsnCode: line.hsnCode, uqc: line.uqc,
        quantity: line.quantity, taxableValue: line.taxableValue,
        igst: line.igstAmount, cgst: line.cgstAmount, sgst: line.sgstAmount, cess: line.cessAmount,
      });
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.rate - b.rate || (a.hsnCode ?? '').localeCompare(b.hsnCode ?? '') || (a.uqc ?? '').localeCompare(b.uqc ?? ''),
  );
}

function toReportDocument(normalized: Gstr1SalesDebitNoteNormalized): Gstr1SalesDebitNoteReportDocument {
  const doc = normalized.document;
  return {
    documentType: 'DEBIT_NOTE',
    sign: 1,
    debitNoteId: doc.debitNoteId,
    debitNoteNumber: doc.debitNoteNumber,
    debitNoteDate: doc.debitNoteDate,
    originalInvoiceId: doc.originalInvoiceId,
    originalInvoiceNumber: doc.originalInvoiceNumber,
    originalInvoiceDate: doc.originalInvoiceDate,
    buyerGstin: doc.buyerGstin,
    sellerRegistrationId: doc.sellerRegistrationId!,
    placeOfSupply: doc.placeOfSupply,
    originalSupplyCategory: doc.originalSupplyCategory,
    reasonCode: doc.reasonCode,
    reasonNotes: doc.reasonNotes,
    noteValue: doc.noteValue,
    taxableValue: doc.taxableValue,
    igst: doc.igst,
    cgst: doc.cgst,
    sgst: doc.sgst,
    cess: doc.cess,
    rateBreakdown: buildRateBreakdown(normalized.lines),
    diagnostics: normalized.diagnostics,
  };
}

function sumDocuments(documents: Gstr1SalesDebitNoteReportDocument[]): Gstr1SalesDebitNoteBucketSummary {
  return documents.reduce(
    (acc, d) => ({
      documentCount: acc.documentCount + 1,
      taxableValue: round2(acc.taxableValue + d.taxableValue),
      igst: round2(acc.igst + d.igst),
      cgst: round2(acc.cgst + d.cgst),
      sgst: round2(acc.sgst + d.sgst),
      cess: round2(acc.cess + d.cess),
      noteValue: round2(acc.noteValue + d.noteValue),
    }),
    { documentCount: 0, taxableValue: 0, igst: 0, cgst: 0, sgst: 0, cess: 0, noteValue: 0 },
  );
}

function bucketFor(documents: Gstr1SalesDebitNoteReportDocument[]): Gstr1SalesDebitNoteBucket {
  const sorted = [...documents].sort((a, b) => a.debitNoteNumber.localeCompare(b.debitNoteNumber));
  return { documents: sorted, summary: sumDocuments(sorted) };
}

/**
 * Aggregates already-loaded, already-authorized SalesDebitNote source documents into GSTR-1 Table
 * 9B's CDNR / CDNUR (B2CL; export left an empty placeholder), positive direction. Pure and
 * side-effect free. Filtering order identical to `aggregateGstr1CreditNotes`'s own documented
 * order (duplicate id -> registration scope -> branch scope -> period scope -> normalize).
 */
export function aggregateGstr1SalesDebitNotes(
  sources: Gstr1SalesDebitNoteAggregationSourceDocument[],
  options: Gstr1SalesDebitNoteAggregationOptions,
): Gstr1SalesDebitNoteAggregation {
  const gstRegistrationId = options.gstRegistrationId?.trim();
  if (!gstRegistrationId) {
    throw new Gstr1SalesDebitNoteAdapterAccessError(
      'A single seller GST registration must be selected before aggregating GSTR-1 Sales Debit Notes — none was supplied.',
    );
  }
  const allowedBranchIds = resolveAllowedBranchIds(options.branchAccess, options.branchId);
  const { from, to } = options.period;

  const cdnrDocuments: Gstr1SalesDebitNoteReportDocument[] = [];
  const b2clDocuments: Gstr1SalesDebitNoteReportDocument[] = [];
  const b2csAddOnDocuments: Gstr1SalesDebitNoteReportDocument[] = [];
  const excluded: Gstr1SalesDebitNoteExclusionRecord[] = [];
  const diagnostics: Gstr1SalesDebitNoteAggregationDiagnostic[] = [];
  const seenIds = new Set<string>();

  let notesConsidered = 0;
  let notesExcludedByScope = 0;

  for (const source of sources) {
    if (seenIds.has(source.id)) {
      diagnostics.push({
        debitNoteId: source.id,
        debitNoteNumber: source.debitNoteNumber ?? null,
        reason: 'DUPLICATE_SOURCE_ID',
        detail: `SalesDebitNote ${source.id} was supplied more than once to this aggregation call — only the first occurrence is counted; it is never double-counted.`,
      });
      continue;
    }
    seenIds.add(source.id);

    const sourceRegistrationId = source.sellerRegistrationId?.trim();
    if (sourceRegistrationId && sourceRegistrationId !== gstRegistrationId) {
      notesExcludedByScope++;
      continue;
    }

    if (allowedBranchIds && (!source.branchId || !allowedBranchIds.includes(source.branchId))) {
      notesExcludedByScope++;
      continue;
    }

    const debitNoteDate = source.debitNoteDate instanceof Date && !Number.isNaN(source.debitNoteDate.getTime())
      ? source.debitNoteDate
      : null;
    if (debitNoteDate && (debitNoteDate < from || debitNoteDate > to)) {
      notesExcludedByScope++;
      continue;
    }

    notesConsidered++;

    const normalized = normalizeGstr1SalesDebitNote(source);

    if (!normalized.reportable) {
      excluded.push({
        debitNoteId: normalized.document.debitNoteId,
        debitNoteNumber: normalized.document.debitNoteNumber,
        debitNoteDate: normalized.document.debitNoteDate,
        exclusionReason: normalized.exclusionReason!,
        diagnostics: normalized.diagnostics,
        document: normalized.document,
      });
      continue;
    }

    const document = toReportDocument(normalized);

    if (normalized.document.reportingTable === 'CDNR') {
      cdnrDocuments.push(document);
    } else if (normalized.document.reportingTable === 'CDNUR') {
      if (normalized.document.originalSupplyCategory === 'B2CL') {
        b2clDocuments.push(document);
      } else if (normalized.document.originalSupplyCategory === 'B2CS') {
        b2csAddOnDocuments.push(document);
      } else {
        diagnostics.push({
          debitNoteId: document.debitNoteId,
          debitNoteNumber: document.debitNoteNumber,
          reason: 'UNREACHABLE_CLASSIFICATION',
          detail: 'Reportable CDNUR document carried an unclassified original supply category — should be unreachable; not placed in any CDNUR sub-bucket.',
        });
      }
    } else {
      diagnostics.push({
        debitNoteId: document.debitNoteId,
        debitNoteNumber: document.debitNoteNumber,
        reason: 'UNREACHABLE_CLASSIFICATION',
        detail: 'Reportable document carried an unclassified reporting table — should be unreachable; not placed in CDNR or CDNUR.',
      });
    }
  }

  return {
    cdnr: bucketFor(cdnrDocuments),
    cdnur: { b2cl: bucketFor(b2clDocuments), export: bucketFor([]) },
    b2csAddOn: bucketFor(b2csAddOnDocuments),
    diagnostics,
    excluded,
    meta: { gstRegistrationId, period: { from, to }, notesConsidered, notesExcludedByScope },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 12 — Table 7 B2CS: "Gross B2CS + Sales Debit Notes - Credit Notes." Applied AFTER the
// frozen `aggregateGstr1OutwardSupplies()` has already produced its own (gross - eligible Credit
// Notes) result — this function only ADDS eligible B2CS-origin Sales Debit Note value on top.
// B2B/B2CL Sales Debit Notes are never passed into this path (checked via `originalSupplyCategory`
// below, mirroring `aggregateGstr1CreditNotes`'s own B2CS-only netting filter).
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1B2csGroupWithSalesDebitNotes extends Gstr1B2csGroup {
  debitNoteTaxableAddition: number;
  debitNoteCgstAddition: number;
  debitNoteSgstAddition: number;
  debitNoteIgstAddition: number;
  debitNoteCessAddition: number;
  debitNoteQuantityAddition: number;
  debitNoteRecordCount: number;
}

export type Gstr1B2csSalesDebitNoteDiagnosticReason =
  | 'SALES_DEBIT_NOTE_EXCLUDED'
  | 'DUPLICATE_SALES_DEBIT_NOTE_ID';

export interface Gstr1B2csSalesDebitNoteDiagnostic {
  reason: Gstr1B2csSalesDebitNoteDiagnosticReason;
  detail: string;
  debitNoteId?: string;
  debitNoteNumber?: string | null;
  placeOfSupply?: string | null;
  gstRate?: number;
  hsnCode?: string | null;
  uqc?: string | null;
}

export interface Gstr1OutwardAggregationWithSalesDebitNotes {
  b2b: Gstr1OutwardAggregation['b2b'];
  b2cl: Gstr1OutwardAggregation['b2cl'];
  /** Gross + eligible Sales Debit Notes - eligible Credit Notes (whichever of the latter two the
   *  base aggregation/this function were given — omitting Sales Debit Note sources reproduces the
   *  base aggregation's own B2CS figures exactly, unchanged). */
  b2cs: Gstr1B2csGroupWithSalesDebitNotes[];
  diagnostics: Gstr1OutwardAggregation['diagnostics'];
  b2csCreditNoteDiagnostics: Gstr1OutwardAggregation['b2csCreditNoteDiagnostics'];
  b2csSalesDebitNoteDiagnostics: Gstr1B2csSalesDebitNoteDiagnostic[];
  totals: Gstr1OutwardAggregation['totals'];
  meta: Gstr1OutwardAggregation['meta'] & {
    salesDebitNotesConsideredForAddOn: number;
    salesDebitNotesExcludedByScope: number;
  };
}

function b2csKey(isInterState: boolean, placeOfSupply: string, gstRate: number, hsnCode: string | null, uqc: string | null): string {
  return `${isInterState}\u0000${placeOfSupply}\u0000${gstRate}\u0000${hsnCode ?? ''}\u0000${uqc ?? ''}`;
}

/**
 * Takes the frozen `aggregateGstr1OutwardSupplies()`'s own output (already net of eligible B2CS
 * Credit Notes, per gstr1OutwardAggregation.ts's own Phase A) and adds eligible B2CS-origin Sales
 * Debit Note value on top — producing "Gross B2CS + Sales Debit Notes - Credit Notes." Never
 * touches `base.b2b`/`base.b2cl` (section 12: "Do NOT pass B2B or B2CL Sales Debit Notes into the
 * B2CS netting path" — those categories are returned unchanged). Pure and side-effect free.
 */
export function applySalesDebitNotesToOutwardAggregation(
  base: Gstr1OutwardAggregation,
  debitNoteSources: Gstr1SalesDebitNoteAggregationSourceDocument[],
  options: Gstr1SalesDebitNoteAggregationOptions,
): Gstr1OutwardAggregationWithSalesDebitNotes {
  const gstRegistrationId = options.gstRegistrationId?.trim();
  if (!gstRegistrationId) {
    throw new Gstr1SalesDebitNoteAdapterAccessError(
      'A single seller GST registration must be selected before applying Sales Debit Notes to Table 7 — none was supplied.',
    );
  }
  const allowedBranchIds = resolveAllowedBranchIds(options.branchAccess, options.branchId);
  const { from, to } = options.period;

  const groups = new Map<string, Gstr1B2csGroupWithSalesDebitNotes>();
  for (const g of base.b2cs) {
    groups.set(b2csKey(g.isInterState, g.placeOfSupply, g.gstRate, g.hsnCode, g.uqc), {
      ...g,
      debitNoteTaxableAddition: 0, debitNoteCgstAddition: 0, debitNoteSgstAddition: 0,
      debitNoteIgstAddition: 0, debitNoteCessAddition: 0, debitNoteQuantityAddition: 0,
      debitNoteRecordCount: 0,
    });
  }

  const b2csSalesDebitNoteDiagnostics: Gstr1B2csSalesDebitNoteDiagnostic[] = [];
  const seenIds = new Set<string>();
  let salesDebitNotesConsideredForAddOn = 0;
  let salesDebitNotesExcludedByScope = 0;

  for (const dn of debitNoteSources) {
    if (seenIds.has(dn.id)) {
      b2csSalesDebitNoteDiagnostics.push({
        reason: 'DUPLICATE_SALES_DEBIT_NOTE_ID',
        detail: `Sales debit note ${dn.id} was supplied more than once to this call — only the first occurrence is added; it is never double-counted.`,
        debitNoteId: dn.id, debitNoteNumber: dn.debitNoteNumber ?? null,
      });
      continue;
    }
    seenIds.add(dn.id);

    const dnRegistrationId = dn.sellerRegistrationId?.trim();
    if (dnRegistrationId && dnRegistrationId !== gstRegistrationId) {
      salesDebitNotesExcludedByScope++;
      continue;
    }
    if (allowedBranchIds && (!dn.branchId || !allowedBranchIds.includes(dn.branchId))) {
      salesDebitNotesExcludedByScope++;
      continue;
    }
    const debitNoteDate = dn.debitNoteDate instanceof Date && !Number.isNaN(dn.debitNoteDate.getTime()) ? dn.debitNoteDate : null;
    if (debitNoteDate && (debitNoteDate < from || debitNoteDate > to)) {
      salesDebitNotesExcludedByScope++;
      continue;
    }

    salesDebitNotesConsideredForAddOn++;

    const normalized = normalizeGstr1SalesDebitNote(dn);
    if (!normalized.reportable) {
      b2csSalesDebitNoteDiagnostics.push({
        reason: 'SALES_DEBIT_NOTE_EXCLUDED',
        detail: `Sales debit note excluded from Table 7 B2CS add-on (${normalized.exclusionReason}) — never silently dropped.`,
        debitNoteId: normalized.document.debitNoteId, debitNoteNumber: normalized.document.debitNoteNumber,
      });
      continue;
    }

    // Only a B2CS-ORIGIN debit note nets here (section 12) — CDNR/CDNUR-B2CL are reported on
    // Table 9B instead (aggregateGstr1SalesDebitNotes above), never added here.
    if (normalized.document.reportingTable !== 'CDNUR' || normalized.document.originalSupplyCategory !== 'B2CS') {
      continue;
    }

    const originalSupplyClassification = classifyGstr1OutwardSupply({
      buyerGstin: dn.buyerGstin,
      sellerStateCode: dn.sellerStateCode,
      sellerRegistrationId: dn.sellerRegistrationId,
      placeOfSupply: dn.placeOfSupply,
      invoiceValue: dn.originalInvoiceValue,
      invoiceDate: dn.originalInvoiceDate,
    });
    if (originalSupplyClassification.category !== 'B2CS' || originalSupplyClassification.isInterState === null) {
      b2csSalesDebitNoteDiagnostics.push({
        reason: 'SALES_DEBIT_NOTE_EXCLUDED',
        detail: 'Sales debit note carried a B2CS original supply category but could not be re-classified for Table 7 add-on — should be unreachable; excluded.',
        debitNoteId: normalized.document.debitNoteId, debitNoteNumber: normalized.document.debitNoteNumber,
      });
      continue;
    }

    const placeOfSupply = dn.placeOfSupply ?? '';
    for (const line of normalized.lines) {
      const key = b2csKey(originalSupplyClassification.isInterState, placeOfSupply, line.gstRate, line.hsnCode, line.uqc);
      let group = groups.get(key);
      if (!group) {
        group = {
          placeOfSupply, isInterState: originalSupplyClassification.isInterState, gstRate: line.gstRate,
          hsnCode: line.hsnCode, uqc: line.uqc,
          taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0, quantity: 0, recordCount: 0,
          grossTaxableValue: 0, grossCgst: 0, grossSgst: 0, grossIgst: 0, grossCess: 0, grossQuantity: 0,
          creditNoteTaxableReduction: 0, creditNoteCgstReduction: 0, creditNoteSgstReduction: 0,
          creditNoteIgstReduction: 0, creditNoteCessReduction: 0, creditNoteQuantityReduction: 0,
          creditNoteRecordCount: 0, filingEligible: true,
          debitNoteTaxableAddition: 0, debitNoteCgstAddition: 0, debitNoteSgstAddition: 0,
          debitNoteIgstAddition: 0, debitNoteCessAddition: 0, debitNoteQuantityAddition: 0,
          debitNoteRecordCount: 0,
        };
        groups.set(key, group);
      }
      group.debitNoteTaxableAddition = round2(group.debitNoteTaxableAddition + line.taxableValue);
      group.debitNoteCgstAddition = round2(group.debitNoteCgstAddition + line.cgstAmount);
      group.debitNoteSgstAddition = round2(group.debitNoteSgstAddition + line.sgstAmount);
      group.debitNoteIgstAddition = round2(group.debitNoteIgstAddition + line.igstAmount);
      group.debitNoteCessAddition = round2(group.debitNoteCessAddition + line.cessAmount);
      group.debitNoteQuantityAddition = round2(group.debitNoteQuantityAddition + line.quantity);
      group.debitNoteRecordCount += 1;
    }
  }

  // Finalize: net = (gross - credit note reduction) + debit note addition — the base aggregation's
  // own `taxableValue`/etc already ARE (gross - creditNoteReduction); add the debit note figure on
  // top of that, never re-deriving the credit-note side.
  for (const group of groups.values()) {
    group.taxableValue = round2(group.taxableValue + group.debitNoteTaxableAddition);
    group.cgst = round2(group.cgst + group.debitNoteCgstAddition);
    group.sgst = round2(group.sgst + group.debitNoteSgstAddition);
    group.igst = round2(group.igst + group.debitNoteIgstAddition);
    group.cess = round2(group.cess + group.debitNoteCessAddition);
    group.quantity = round2(group.quantity + group.debitNoteQuantityAddition);

    const hasNegativeNet = group.taxableValue < 0 || group.cgst < 0 || group.sgst < 0 || group.igst < 0 || group.cess < 0;
    group.filingEligible = !hasNegativeNet;
  }

  const b2cs = Array.from(groups.values()).sort(
    (a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.gstRate - b.gstRate || (a.hsnCode ?? '').localeCompare(b.hsnCode ?? ''),
  );

  return {
    b2b: base.b2b,
    b2cl: base.b2cl,
    b2cs,
    diagnostics: base.diagnostics,
    b2csCreditNoteDiagnostics: base.b2csCreditNoteDiagnostics,
    b2csSalesDebitNoteDiagnostics,
    totals: base.totals,
    meta: { ...base.meta, salesDebitNotesConsideredForAddOn, salesDebitNotesExcludedByScope },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 14 — Table 12: a Sales Debit Note is NOT treated as an ordinary invoice. It is instead
// represented as a POSITIVE addition on top of the frozen `aggregateGstr1Table12()`'s own
// (gross - Credit Note reduction) rows, keyed by the IDENTICAL bucket key
// (reportingTab + HSN + UQC + GST rate) that frozen engine already uses — never a new, parallel
// bucket shape. B2B/B2C classification is preserved exactly by reusing the ORIGINAL outward
// supply's own classification (same rule section 12/the Table 9B aggregator above already apply).
// ─────────────────────────────────────────────────────────────────────────────

export interface Gstr1Table12RowWithSalesDebitNotes extends Gstr1Table12Row {
  debitNoteQuantityAddition: number;
  debitNoteTaxableAddition: number;
  debitNoteCgstAddition: number;
  debitNoteSgstAddition: number;
  debitNoteIgstAddition: number;
  debitNoteCessAddition: number;
  debitNoteRecordCount: number;
}

export interface Gstr1Table12AggregationWithSalesDebitNotes {
  rows: Gstr1Table12RowWithSalesDebitNotes[];
  diagnostics: Gstr1Table12Aggregation['diagnostics'];
  salesDebitNoteDiagnostics: Gstr1B2csSalesDebitNoteDiagnostic[];
  summary: Gstr1Table12Aggregation['summary'];
  meta: Gstr1Table12Aggregation['meta'] & {
    salesDebitNotesConsidered: number;
    salesDebitNotesExcludedByScope: number;
  };
}

function table12BucketKey(reportingTab: Gstr1Table12ReportingTab, hsnCode: string | null, uqc: string | null, gstRate: number): string {
  return `${reportingTab}\u0000${hsnCode ?? ''}\u0000${gstRate}\u0000${uqc ?? ''}`;
}

/**
 * Takes the frozen `aggregateGstr1Table12()`'s own output (already net of formal Credit Notes) and
 * adds eligible Sales Debit Note value on top of the matching bucket — identified by the ORIGINAL
 * outward supply's own B2B/B2CL/B2CS category (B2B -> B2B_SUPPLIES, B2CL/B2CS -> B2C_SUPPLIES),
 * never the debit note's own amount/date (section 14's explicit instruction). This never corrupts
 * the base rows' own `recordCount` (an invoice-line count) — debit note contributions are tracked
 * in their own `debitNoteRecordCount` field instead, exactly like the base engine's own
 * `creditNoteRecordCount` convention.
 */
export function applySalesDebitNotesToTable12(
  base: Gstr1Table12Aggregation,
  debitNoteSources: Gstr1SalesDebitNoteAggregationSourceDocument[],
  options: Gstr1SalesDebitNoteAggregationOptions,
): Gstr1Table12AggregationWithSalesDebitNotes {
  const gstRegistrationId = options.gstRegistrationId?.trim();
  if (!gstRegistrationId) {
    throw new Gstr1SalesDebitNoteAdapterAccessError(
      'A single seller GST registration must be selected before applying Sales Debit Notes to Table 12 — none was supplied.',
    );
  }
  const allowedBranchIds = resolveAllowedBranchIds(options.branchAccess, options.branchId);
  const { from, to } = options.period;

  const buckets = new Map<string, Gstr1Table12RowWithSalesDebitNotes>();
  for (const row of base.rows) {
    buckets.set(table12BucketKey(row.reportingTab, row.hsnCode, row.uqc, row.gstRate), {
      ...row,
      debitNoteQuantityAddition: 0, debitNoteTaxableAddition: 0, debitNoteCgstAddition: 0,
      debitNoteSgstAddition: 0, debitNoteIgstAddition: 0, debitNoteCessAddition: 0, debitNoteRecordCount: 0,
    });
  }

  const salesDebitNoteDiagnostics: Gstr1B2csSalesDebitNoteDiagnostic[] = [];
  const seenIds = new Set<string>();
  let salesDebitNotesConsidered = 0;
  let salesDebitNotesExcludedByScope = 0;

  for (const dn of debitNoteSources) {
    if (seenIds.has(dn.id)) {
      salesDebitNoteDiagnostics.push({
        reason: 'DUPLICATE_SALES_DEBIT_NOTE_ID',
        detail: `Sales debit note ${dn.id} was supplied more than once — only the first occurrence is added.`,
        debitNoteId: dn.id, debitNoteNumber: dn.debitNoteNumber ?? null,
      });
      continue;
    }
    seenIds.add(dn.id);

    const dnRegistrationId = dn.sellerRegistrationId?.trim();
    if (dnRegistrationId && dnRegistrationId !== gstRegistrationId) { salesDebitNotesExcludedByScope++; continue; }
    if (allowedBranchIds && (!dn.branchId || !allowedBranchIds.includes(dn.branchId))) { salesDebitNotesExcludedByScope++; continue; }
    const debitNoteDate = dn.debitNoteDate instanceof Date && !Number.isNaN(dn.debitNoteDate.getTime()) ? dn.debitNoteDate : null;
    if (debitNoteDate && (debitNoteDate < from || debitNoteDate > to)) { salesDebitNotesExcludedByScope++; continue; }

    salesDebitNotesConsidered++;

    const normalized = normalizeGstr1SalesDebitNote(dn);
    if (!normalized.reportable) {
      salesDebitNoteDiagnostics.push({
        reason: 'SALES_DEBIT_NOTE_EXCLUDED',
        detail: `Sales debit note excluded from Table 12 (${normalized.exclusionReason}).`,
        debitNoteId: normalized.document.debitNoteId, debitNoteNumber: normalized.document.debitNoteNumber,
      });
      continue;
    }

    const originalCategory = normalized.document.originalSupplyCategory;
    const reportingTab: Gstr1Table12ReportingTab | null =
      originalCategory === 'B2B' ? 'B2B_SUPPLIES'
        : (originalCategory === 'B2CL' || originalCategory === 'B2CS') ? 'B2C_SUPPLIES'
          : null;
    if (!reportingTab) {
      salesDebitNoteDiagnostics.push({
        reason: 'SALES_DEBIT_NOTE_EXCLUDED',
        detail: 'Reportable sales debit note carried an unclassified original supply category — should be unreachable; excluded from Table 12.',
        debitNoteId: normalized.document.debitNoteId, debitNoteNumber: normalized.document.debitNoteNumber,
      });
      continue;
    }

    for (const line of normalized.lines) {
      const key = table12BucketKey(reportingTab, line.hsnCode, line.uqc, line.gstRate);
      let row = buckets.get(key);
      if (!row) {
        row = {
          reportingTab, hsnCode: line.hsnCode, description: null, uqc: line.uqc, gstRate: line.gstRate,
          quantity: 0, taxableValue: 0, cgst: 0, sgst: 0, igst: 0, cess: 0,
          grossQuantity: 0, creditNoteQuantityReduction: 0,
          grossTaxableValue: 0, creditNoteTaxableReduction: 0,
          grossCgst: 0, creditNoteCgstReduction: 0,
          grossSgst: 0, creditNoteSgstReduction: 0,
          grossIgst: 0, creditNoteIgstReduction: 0,
          grossCess: 0, creditNoteCessReduction: 0,
          filingEligible: true, recordCount: 0, creditNoteRecordCount: 0,
          debitNoteQuantityAddition: 0, debitNoteTaxableAddition: 0, debitNoteCgstAddition: 0,
          debitNoteSgstAddition: 0, debitNoteIgstAddition: 0, debitNoteCessAddition: 0, debitNoteRecordCount: 0,
        };
        buckets.set(key, row);
      }
      row.debitNoteQuantityAddition = round2(row.debitNoteQuantityAddition + line.quantity);
      row.debitNoteTaxableAddition = round2(row.debitNoteTaxableAddition + line.taxableValue);
      row.debitNoteCgstAddition = round2(row.debitNoteCgstAddition + line.cgstAmount);
      row.debitNoteSgstAddition = round2(row.debitNoteSgstAddition + line.sgstAmount);
      row.debitNoteIgstAddition = round2(row.debitNoteIgstAddition + line.igstAmount);
      row.debitNoteCessAddition = round2(row.debitNoteCessAddition + line.cessAmount);
      row.debitNoteRecordCount += 1;
    }
  }

  for (const row of buckets.values()) {
    row.quantity = round2(row.quantity + row.debitNoteQuantityAddition);
    row.taxableValue = round2(row.taxableValue + row.debitNoteTaxableAddition);
    row.cgst = round2(row.cgst + row.debitNoteCgstAddition);
    row.sgst = round2(row.sgst + row.debitNoteSgstAddition);
    row.igst = round2(row.igst + row.debitNoteIgstAddition);
    row.cess = round2(row.cess + row.debitNoteCessAddition);

    const hasNegativeNet = row.quantity < 0 || row.taxableValue < 0 || row.cgst < 0 || row.sgst < 0 || row.igst < 0 || row.cess < 0;
    row.filingEligible = !hasNegativeNet && row.filingEligible;
  }

  const rows = Array.from(buckets.values()).sort(
    (a, b) => a.reportingTab.localeCompare(b.reportingTab)
      || (a.hsnCode ?? '').localeCompare(b.hsnCode ?? '')
      || a.gstRate - b.gstRate
      || (a.uqc ?? '').localeCompare(b.uqc ?? ''),
  );

  return {
    rows,
    diagnostics: base.diagnostics,
    salesDebitNoteDiagnostics,
    summary: base.summary,
    meta: { ...base.meta, salesDebitNotesConsidered, salesDebitNotesExcludedByScope },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Section 15 — Table 13 (Documents Issued) reporting loader mapping. The frozen
// `aggregateGstr1Table13()` engine ALREADY supports `documentType: 'OUTWARD_DEBIT_NOTE'` (its own
// `resolveDocumentCategory()` maps it to category `'OUTWARD_DEBIT_NOTE'`) — no engine change is
// needed. This is purely the shape adapter from a persisted SalesDebitNote row to the engine's
// existing `Table13Document` input.
// ─────────────────────────────────────────────────────────────────────────────

export interface SalesDebitNoteTable13SourceRow {
  id: string;
  debitNoteNumber: string;
  debitNoteDate: Date;
  status: string;
  sellerRegistrationId: string | null;
  branchId: string | null;
}

/**
 * Maps one persisted SalesDebitNote row onto the frozen Table 13 engine's own `Table13Document`
 * input shape. ISSUED is represented as active; CANCELLED is represented as cancelled (the engine's
 * own `isDocumentVoidOrCancelled()` already recognizes the literal string 'CANCELLED').
 */
export function toTable13SalesDebitNoteDocument(note: SalesDebitNoteTable13SourceRow): Table13Document {
  return {
    id: note.id,
    documentNumber: note.debitNoteNumber,
    documentDate: note.debitNoteDate,
    status: note.status,
    documentType: 'OUTWARD_DEBIT_NOTE',
    sellerRegistrationId: note.sellerRegistrationId ?? null,
    branchId: note.branchId ?? null,
  };
}
