// G2g-4c-1 — GSTR-1 GSTN export adapter. A PURE transformation layer: takes the already-computed
// output of TRIVO's existing FROZEN GSTR-1 reporting engines (never re-queried, never re-classified,
// never re-aggregated here) and maps it onto the canonical `Gstr1GstnExportDto`
// (gstr1GstnExport.types.ts) for a FUTURE validator (G2g-4c-2) and serializer (G2g-4c-3), neither
// built here.
//
// This file takes NO Prisma dependency, performs NO database access, NO HTTP-context access, NO
// tenant/branch authorization of its own, and never mutates anything it is handed — every output
// object below is freshly constructed. It consumes, unmodified and unreproduced:
//   - gstr1OutwardAggregation.ts   (frozen) — Gstr1OutwardAggregation (B2B/B2CL/B2CS)
//   - gstr1CreditNoteAggregation.ts (frozen) — Gstr1CreditNoteAggregation (CDNR/CDNUR, sign -1)
//   - gstr1SalesDebitNoteAdapter.ts (frozen) — Gstr1SalesDebitNoteAggregation (CDNR/CDNUR, sign +1);
//     this is the ONLY debit-note shape this file ever reads — it has no code path that could accept
//     the unrelated procurement-side `DebitNote` model at all (that model doesn't even structurally
//     match `Gstr1SalesDebitNoteAggregation`'s `debitNoteId`/`debitNoteNumber` fields).
//   - gstr1Table12Aggregation.ts   (frozen) — Gstr1Table12Aggregation (HSN B2B/B2C)
//   - gstr1Table13Aggregation.ts   (frozen) — Table13Aggregation (Documents Issued)
// Every one of the above may be passed either its own "base" shape or, where the frozen family
// offers one, its G2g-4b "WithSalesDebitNotes" structural superset (`Gstr1OutwardAggregationWith
// SalesDebitNotes`'s `b2cs` / `Gstr1Table12AggregationWithSalesDebitNotes`'s `rows`) — both are
// structurally assignable to the base types this file imports, so no separate code path is needed
// for "with debit notes" vs. "without"; this adapter only ever reads the common fields.
//
// No GST recalculation, no B2B/B2CL/B2CS reclassification, no credit/debit-note amount calculation,
// no status mutation, no file generation, no JSON serialization, no network access — see the
// G2g-4c-1 brief's "Important architectural rule" for the complete list this file was built against.

import type {
  Gstr1OutwardAggregation,
  Gstr1B2bInvoiceRecord,
  Gstr1B2clInvoiceRecord,
  Gstr1B2csGroup,
  Gstr1LineDetail,
} from './gstr1OutwardAggregation';
import type {
  Gstr1CreditNoteAggregation,
  Gstr1CreditNoteReportDocument,
  Gstr1CreditNoteRateBreakdown,
} from './gstr1CreditNoteAggregation';
import type {
  Gstr1SalesDebitNoteAggregation,
  Gstr1SalesDebitNoteReportDocument,
  Gstr1SalesDebitNoteRateBreakdown,
} from './gstr1SalesDebitNoteAdapter';
import type { Gstr1Table12Aggregation, Gstr1Table12Row } from './gstr1Table12Aggregation';
import type { Table13Aggregation, Table13SeriesResult, Table13DocumentCategory } from './gstr1Table13Aggregation';
import {
  GSTR1_GSTN_SCHEMA_VERSION_UNSPECIFIED,
  type Gstr1GstnExportDto,
  type Gstr1GstnExportMetadata,
  type Gstr1AatoMetadata,
  type Gstr1AatoVerificationState,
  type Gstr1TurnoverFigure,
  type Gstr1GstnCapabilityMetadata,
  type Gstr1GstnRateGroup,
  type Gstr1GstnB2bInvoice,
  type Gstr1GstnB2clInvoice,
  type Gstr1GstnB2csRecord,
  type Gstr1GstnCdnrNote,
  type Gstr1GstnCdnurNote,
  type Gstr1GstnHsnSummaryRow,
  type Gstr1GstnDocumentSeries,
  type Gstr1GstnDocumentIssuedCategory,
  type Gstr1GstnTraceability,
  type Gstr1GstnDiagnostic,
} from './gstr1GstnExport.types';

const round2 = (n: number) => Math.round(n * 100) / 100;

// ─────────────────────────────────────────────────────────────────────────────
// Adapter input contract
// ─────────────────────────────────────────────────────────────────────────────

/** One already-loaded AATO figure (mirrors `aato.service.ts`'s own `AatoResponse.aato` /
 *  `.precedingAato` row shape by value — this pure module takes no dependency on that Prisma-backed
 *  service). `turnover: null` and/or the whole row being absent both mean "missing" — see
 *  `toTurnoverFigure` below for exactly how each case maps to `Gstr1AatoVerificationState`. */
export interface Gstr1GstnAatoRowInput {
  financialYear: string;
  turnover: number | null;
  verificationStatus: string | null;
  source?: string | null;
}

export interface Gstr1GstnAdapterAatoInput {
  currentFy?: Gstr1GstnAatoRowInput | null;
  precedingFy?: Gstr1GstnAatoRowInput | null;
}

export interface Gstr1GstnAdapterMetadataInput {
  gstin: string;
  legalName: string;
  tradeName?: string | null;
  period: { from: Date; to: Date };
  /** See Gstr1FilingPeriod's own doc comment — this adapter never derives it, only passes it
   *  through when the caller already has it resolved. */
  filingPeriodMmYYYY?: string | null;
  /** Defaults to GSTR1_GSTN_SCHEMA_VERSION_UNSPECIFIED when omitted — never a hard-coded real
   *  schema version (see that constant's own comment). */
  schemaVersion?: string;
  isPartialBranchExport: boolean;
  aato?: Gstr1GstnAdapterAatoInput;
}

/**
 * Every field here is an already-computed output of one of the frozen GSTR-1 reporting engines
 * (see this file's own header) — this adapter fetches nothing itself. `table13` is this module's
 * one direct dependency on `Table13Aggregation` (not `Gstr1Table13Report`, which is
 * `gstr1Reporting.service.ts`'s own Prisma-aware wrapper adding `meta` on top — this file stays
 * Prisma-free and takes the pure engine's own output instead, matching every other field here).
 */
export interface Gstr1GstnAdapterInput {
  metadata: Gstr1GstnAdapterMetadataInput;
  outward: Gstr1OutwardAggregation;
  creditNotes: Gstr1CreditNoteAggregation;
  /** Optional — a company with zero Sales Debit Notes in the period simply omits this (or passes an
   *  empty `cdnr`/`cdnur.b2cl` bucket); the adapter produces zero 'D' notes either way. */
  salesDebitNotes?: Gstr1SalesDebitNoteAggregation | null;
  table12: Gstr1Table12Aggregation;
  table13: Table13Aggregation;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metadata mapping
// ─────────────────────────────────────────────────────────────────────────────

function toTurnoverFigure(row: Gstr1GstnAatoRowInput | null | undefined): Gstr1TurnoverFigure {
  if (!row || row.turnover == null) {
    return {
      financialYear: row?.financialYear ?? null,
      amount: null,
      verificationState: 'MISSING',
      source: row?.source ?? null,
    };
  }
  const verificationState: Gstr1AatoVerificationState = row.verificationStatus === 'VERIFIED' ? 'VERIFIED' : 'UNVERIFIED';
  return {
    financialYear: row.financialYear,
    amount: row.turnover,
    verificationState,
    source: row.source ?? null,
  };
}

const CAPABILITIES: Gstr1GstnCapabilityMetadata = {
  b2b: 'SUPPORTED',
  b2cl: 'SUPPORTED',
  b2cs: 'SUPPORTED',
  cdnr: 'SUPPORTED',
  cdnur: 'SUPPORTED',
  hsnB2b: 'SUPPORTED',
  hsnB2c: 'SUPPORTED',
  documentsIssued: 'SUPPORTED',
  exports: 'UNSUPPORTED',
  advances: 'UNSUPPORTED',
  nilExemptNonGst: 'UNSUPPORTED',
  amendments: 'UNSUPPORTED',
  ecommerce: 'UNSUPPORTED',
};

function buildMetadata(input: Gstr1GstnAdapterMetadataInput): Gstr1GstnExportMetadata {
  const aato: Gstr1AatoMetadata = {
    precedingFy: toTurnoverFigure(input.aato?.precedingFy),
    currentFy: toTurnoverFigure(input.aato?.currentFy),
  };
  return {
    gstin: input.gstin,
    legalName: input.legalName,
    tradeName: input.tradeName ?? null,
    period: {
      internalFrom: input.period.from,
      internalTo: input.period.to,
      filingPeriodMmYYYY: input.filingPeriodMmYYYY ?? null,
    },
    schemaVersion: input.schemaVersion ?? GSTR1_GSTN_SCHEMA_VERSION_UNSPECIFIED,
    aato,
    isPartialBranchExport: input.isPartialBranchExport,
    capabilities: CAPABILITIES,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate-group collapsing (B2B/B2CL/CDNR/CDNUR) — GSTN's own item/rate-group arrays are keyed by rate
// ALONE, never by HSN/UQC (unlike TRIVO's internal per-document line detail, which is keyed by
// HSN+rate+UQC — see gstr1OutwardAggregation.ts's own `Gstr1LineDetail`). Collapsing here is a pure
// re-grouping of already-computed money figures — no recalculation of any underlying amount.
// ─────────────────────────────────────────────────────────────────────────────

interface RateBearingLine {
  gstRate: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  igst: number;
  cess: number;
}

function collapseRateGroups(lines: RateBearingLine[]): Gstr1GstnRateGroup[] {
  const byRate = new Map<number, Gstr1GstnRateGroup>();
  for (const line of lines) {
    const existing = byRate.get(line.gstRate);
    if (existing) {
      existing.taxableValue = round2(existing.taxableValue + line.taxableValue);
      existing.igst = round2(existing.igst + line.igst);
      existing.cgst = round2(existing.cgst + line.cgst);
      existing.sgst = round2(existing.sgst + line.sgst);
      existing.cess = round2(existing.cess + line.cess);
    } else {
      byRate.set(line.gstRate, {
        rate: line.gstRate,
        taxableValue: line.taxableValue,
        igst: line.igst,
        cgst: line.cgst,
        sgst: line.sgst,
        cess: line.cess,
      });
    }
  }
  return Array.from(byRate.values()).sort((a, b) => a.rate - b.rate);
}

// Three tiny, type-safe mappers rather than one generic over a union — `Gstr1LineDetail` names its
// rate field `gstRate`; `Gstr1CreditNoteRateBreakdown`/`Gstr1SalesDebitNoteRateBreakdown` both name
// theirs `rate`. No shared structural supertype exists for the rate field itself, so each gets its
// own one-line adapter rather than a cast.
function lineDetailToRateBearing(d: Gstr1LineDetail): RateBearingLine {
  return { gstRate: d.gstRate, taxableValue: d.taxableValue, cgst: d.cgst, sgst: d.sgst, igst: d.igst, cess: d.cess };
}
function creditNoteBreakdownToRateBearing(d: Gstr1CreditNoteRateBreakdown): RateBearingLine {
  return { gstRate: d.rate, taxableValue: d.taxableValue, cgst: d.cgst, sgst: d.sgst, igst: d.igst, cess: d.cess };
}
function salesDebitNoteBreakdownToRateBearing(d: Gstr1SalesDebitNoteRateBreakdown): RateBearingLine {
  return { gstRate: d.rate, taxableValue: d.taxableValue, cgst: d.cgst, sgst: d.sgst, igst: d.igst, cess: d.cess };
}

// ─────────────────────────────────────────────────────────────────────────────
// B2B — Table 4
// ─────────────────────────────────────────────────────────────────────────────

function toB2bInvoice(record: Gstr1B2bInvoiceRecord): Gstr1GstnB2bInvoice {
  return {
    recipientGstin: record.buyerGstin,
    invoiceNumber: record.invoiceNumber,
    invoiceDate: record.invoiceDate,
    invoiceValue: record.invoiceValue,
    placeOfSupply: record.placeOfSupply,
    reverseCharge: record.reverseCharge ?? null,
    invoiceType: null,
    rateGroups: collapseRateGroups(record.lines.map(lineDetailToRateBearing)),
    taxableValue: record.totals.taxableValue,
    cgst: record.totals.cgst,
    sgst: record.totals.sgst,
    igst: record.totals.igst,
    cess: record.totals.cess,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// B2CL — Table 5
// ─────────────────────────────────────────────────────────────────────────────

function toB2clInvoice(record: Gstr1B2clInvoiceRecord): Gstr1GstnB2clInvoice {
  return {
    placeOfSupply: record.placeOfSupply,
    invoiceNumber: record.invoiceNumber,
    invoiceDate: record.invoiceDate,
    invoiceValue: record.invoiceValue,
    rateGroups: collapseRateGroups(record.lines.map(lineDetailToRateBearing)),
    taxableValue: record.totals.taxableValue,
    igst: record.totals.igst,
    cess: record.totals.cess,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// B2CS — Table 7. Collapses TRIVO's internal HSN/UQC-split groups down to GSTN's own aggregation
// dimensions (supply type, place of supply, inter/intra-state, rate) — never a 1:1 passthrough.
// ─────────────────────────────────────────────────────────────────────────────

function b2csGstnKey(isInterState: boolean, placeOfSupply: string, rate: number): string {
  return `${isInterState}\u0000${placeOfSupply}\u0000${rate}`;
}

function toB2csRecords(groups: Gstr1B2csGroup[]): Gstr1GstnB2csRecord[] {
  const byKey = new Map<string, Gstr1GstnB2csRecord>();
  for (const g of groups) {
    const key = b2csGstnKey(g.isInterState, g.placeOfSupply, g.gstRate);
    const existing = byKey.get(key);
    if (existing) {
      existing.taxableValue = round2(existing.taxableValue + g.taxableValue);
      existing.igst = round2(existing.igst + g.igst);
      existing.cgst = round2(existing.cgst + g.cgst);
      existing.sgst = round2(existing.sgst + g.sgst);
      existing.cess = round2(existing.cess + g.cess);
    } else {
      byKey.set(key, {
        ecommerceSupplyType: 'OE',
        supplyType: g.isInterState ? 'INTER_STATE' : 'INTRA_STATE',
        placeOfSupply: g.placeOfSupply,
        rate: g.gstRate,
        taxableValue: g.taxableValue,
        igst: g.igst,
        cgst: g.cgst,
        sgst: g.sgst,
        cess: g.cess,
      });
    }
  }
  return Array.from(byKey.values()).sort(
    (a, b) => a.placeOfSupply.localeCompare(b.placeOfSupply) || a.rate - b.rate || a.supplyType.localeCompare(b.supplyType),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CDNR / CDNUR — Table 9B. Credit Notes (`noteType: 'C'`) and Sales Debit Notes (`noteType: 'D'`)
// share the identical GSTN-facing shape; this adapter maps each FROZEN report document type onto it
// independently (never reclassifying either).
// ─────────────────────────────────────────────────────────────────────────────

function creditNoteToCdnr(doc: Gstr1CreditNoteReportDocument): Gstr1GstnCdnrNote {
  return {
    noteType: 'C',
    // Non-null: this document is in the CDNR bucket, which the frozen aggregator only ever
    // populates for a REGISTERED recipient (a present, format-valid GSTIN) — see
    // gstr1CreditNoteNormalizer.ts's own classifyCreditNoteRecipient().
    recipientGstin: doc.buyerGstin!,
    noteNumber: doc.creditNoteNumber,
    noteDate: doc.creditNoteDate,
    noteValue: doc.noteValue,
    placeOfSupply: doc.placeOfSupply,
    rateGroups: collapseRateGroups(doc.rateBreakdown.map(creditNoteBreakdownToRateBearing)),
    taxableValue: doc.taxableValue,
    igst: doc.igst,
    cgst: doc.cgst,
    sgst: doc.sgst,
    cess: doc.cess,
  };
}

function creditNoteToCdnur(doc: Gstr1CreditNoteReportDocument): Gstr1GstnCdnurNote {
  return {
    noteType: 'C',
    noteNumber: doc.creditNoteNumber,
    noteDate: doc.creditNoteDate,
    noteValue: doc.noteValue,
    placeOfSupply: doc.placeOfSupply,
    rateGroups: collapseRateGroups(doc.rateBreakdown.map(creditNoteBreakdownToRateBearing)),
    taxableValue: doc.taxableValue,
    igst: doc.igst,
    cess: doc.cess,
  };
}

function salesDebitNoteToCdnr(doc: Gstr1SalesDebitNoteReportDocument): Gstr1GstnCdnrNote {
  return {
    noteType: 'D',
    // Non-null: same CDNR/REGISTERED-recipient guarantee as creditNoteToCdnr above, mirrored by
    // gstr1SalesDebitNoteAdapter.ts's own classifySalesDebitNoteRecipient().
    recipientGstin: doc.buyerGstin!,
    noteNumber: doc.debitNoteNumber,
    noteDate: doc.debitNoteDate,
    noteValue: doc.noteValue,
    placeOfSupply: doc.placeOfSupply,
    rateGroups: collapseRateGroups(doc.rateBreakdown.map(salesDebitNoteBreakdownToRateBearing)),
    taxableValue: doc.taxableValue,
    igst: doc.igst,
    cgst: doc.cgst,
    sgst: doc.sgst,
    cess: doc.cess,
  };
}

function salesDebitNoteToCdnur(doc: Gstr1SalesDebitNoteReportDocument): Gstr1GstnCdnurNote {
  return {
    noteType: 'D',
    noteNumber: doc.debitNoteNumber,
    noteDate: doc.debitNoteDate,
    noteValue: doc.noteValue,
    placeOfSupply: doc.placeOfSupply,
    rateGroups: collapseRateGroups(doc.rateBreakdown.map(salesDebitNoteBreakdownToRateBearing)),
    taxableValue: doc.taxableValue,
    igst: doc.igst,
    cess: doc.cess,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// HSN summary — Table 12. A direct field-for-field mapping of the frozen engine's own already-net
// (gross minus formal Credit Note reduction, plus Sales Debit Note addition when the caller passed
// the "WithSalesDebitNotes" variant) rows — no recomputation.
// ─────────────────────────────────────────────────────────────────────────────

function toHsnSummaryRow(row: Gstr1Table12Row): Gstr1GstnHsnSummaryRow {
  return {
    hsnCode: row.hsnCode,
    description: row.description,
    uqc: row.uqc,
    quantity: row.quantity,
    rate: row.gstRate,
    taxableValue: row.taxableValue,
    igst: row.igst,
    cgst: row.cgst,
    sgst: row.sgst,
    cess: row.cess,
    // Always null — see Gstr1GstnHsnSummaryRow.totalValue's own doc comment; paired with one
    // export-wide MISSING_EXPORT_FIELD diagnostic rather than one per row.
    totalValue: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Documents Issued — Table 13. Only the three categories this phase has an established GSTN mapping
// for; everything else is excluded with an INVALID_MAPPING diagnostic (see this file's own header
// and the types file's `Gstr1GstnDocumentIssuedCategory` comment).
// ─────────────────────────────────────────────────────────────────────────────

function mapTable13Category(category: Table13DocumentCategory): Gstr1GstnDocumentIssuedCategory | null {
  switch (category) {
    case 'OUTWARD_INVOICE':
      return 'INVOICES_FOR_OUTWARD_SUPPLY';
    case 'CREDIT_NOTE':
      return 'CREDIT_NOTE';
    case 'OUTWARD_DEBIT_NOTE':
      return 'DEBIT_NOTE';
    default:
      return null;
  }
}

function toDocumentSeries(series: Table13SeriesResult, category: Gstr1GstnDocumentIssuedCategory): Gstr1GstnDocumentSeries {
  return {
    documentCategory: category,
    sellerRegistrationId: series.sellerRegistrationId,
    seriesPrefix: series.prefix,
    financialYear: series.financialYear,
    fromDocumentNumber: series.fromDocumentNumber,
    toDocumentNumber: series.toDocumentNumber,
    fromSerial: series.fromSerial,
    toSerial: series.toSerial,
    totalIssued: series.totalDocuments,
    cancelled: series.cancelledDocuments,
    netIssued: series.netIssued,
    filingEligible: series.filingEligible,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transforms the already-computed output of TRIVO's frozen GSTR-1 reporting engines into the
 * canonical GSTN export DTO. Pure and side-effect free: no Prisma, no Date.now(), no randomness, no
 * mutation of any input object — same input always produces the same output.
 */
export function adaptGstr1ToGstnExport(input: Gstr1GstnAdapterInput): Gstr1GstnExportDto {
  const metadata = buildMetadata(input.metadata);
  const diagnostics: Gstr1GstnDiagnostic[] = [];

  // ── B2B / B2CL / B2CS ───────────────────────────────────────────────────
  const b2b = input.outward.b2b.map(toB2bInvoice);
  const b2cl = input.outward.b2cl.map(toB2clInvoice);
  const b2cs = toB2csRecords(input.outward.b2cs);

  diagnostics.push({
    code: 'MISSING_EXPORT_FIELD',
    message: 'TRIVO has no persisted SEZ/deemed-export B2B invoice-type indicator — invoiceType is always null on every B2B record in this export.',
    section: 'B2B',
    field: 'invoiceType',
  });
  for (const record of input.outward.b2b) {
    if (!record.invoiceDate) {
      diagnostics.push({
        code: 'MISSING_EXPORT_FIELD',
        message: `B2B invoice ${record.invoiceNumber} has no resolvable invoice date.`,
        section: 'B2B',
        field: 'invoiceDate',
        documentNumber: record.invoiceNumber,
      });
    }
  }

  // ── CDNR / CDNUR (Credit Notes + Sales Debit Notes) ────────────────────
  const cdnr: Gstr1GstnCdnrNote[] = [
    ...input.creditNotes.cdnr.documents.map(creditNoteToCdnr),
    ...(input.salesDebitNotes?.cdnr.documents.map(salesDebitNoteToCdnr) ?? []),
  ];
  const cdnur: Gstr1GstnCdnurNote[] = [
    ...input.creditNotes.cdnur.b2cl.documents.map(creditNoteToCdnur),
    ...(input.salesDebitNotes?.cdnur.b2cl.documents.map(salesDebitNoteToCdnur) ?? []),
  ];

  // ── HSN summary (Table 12) ──────────────────────────────────────────────
  const hsnB2b = input.table12.rows.filter((r) => r.reportingTab === 'B2B_SUPPLIES').map(toHsnSummaryRow);
  const hsnB2c = input.table12.rows.filter((r) => r.reportingTab === 'B2C_SUPPLIES').map(toHsnSummaryRow);
  if (input.table12.rows.length > 0) {
    diagnostics.push({
      code: 'MISSING_EXPORT_FIELD',
      message: 'The frozen Table 12 engine carries no authoritative total-value ("val" = taxable value + tax) figure at the HSN-bucket level — totalValue is always null on every HSN summary row, never derived as taxableValue + tax here.',
      section: 'TABLE_12',
      field: 'totalValue',
    });
  }

  // ── Documents Issued (Table 13) ─────────────────────────────────────────
  const documentsIssued: Gstr1GstnDocumentSeries[] = [];
  for (const series of input.table13.series) {
    const category = mapTable13Category(series.category);
    if (!category) {
      diagnostics.push({
        code: 'INVALID_MAPPING',
        message: `Table 13 document category "${series.category}" (series "${series.seriesKey}") has no established GSTN mapping in this phase — excluded rather than guessed.`,
        section: 'TABLE_13',
      });
      continue;
    }
    documentsIssued.push(toDocumentSeries(series, category));
  }

  // ── Scope / AATO / amendments / unsupported-capability diagnostics ─────
  if (metadata.isPartialBranchExport) {
    diagnostics.push({
      code: 'PARTIAL_BRANCH_SCOPE',
      message: 'This export does not represent the complete GST-registration-wide scope (a single branch, or a branch-restricted caller) — it must not be treated as a complete filing-ready export.',
      section: 'SCOPE',
    });
  }
  if (metadata.aato.currentFy.verificationState !== 'VERIFIED') {
    diagnostics.push({
      code: 'AATO_NOT_VERIFIED',
      message: metadata.aato.currentFy.verificationState === 'MISSING'
        ? 'No AATO (Annual Aggregate Turnover) record is on file for the current financial year.'
        : 'The current financial year\'s AATO (Annual Aggregate Turnover) has not been verified against the GST portal.',
      section: 'AATO',
    });
  }
  diagnostics.push({
    code: 'AMENDMENT_DATA_UNAVAILABLE',
    message: 'TRIVO has no amendment dataset for any GSTR-1 section — this export never fabricates amendment records; capabilities.amendments is UNSUPPORTED.',
    section: 'AMENDMENTS',
  });
  for (const section of ['exports', 'advances', 'nilExemptNonGst', 'ecommerce'] as const) {
    diagnostics.push({
      code: 'UNSUPPORTED_SECTION',
      message: `GSTR-1 section "${section}" is not implemented in this phase.`,
      section,
    });
  }

  // ── Traceability (structurally separate from every GSTN-facing object above) ──────────────
  const traceability: Gstr1GstnTraceability = {
    // TRIVO's own internal CompanyGstRegistration id (the `gstRegistrationId` every frozen engine's
    // own `meta` already carries) — deliberately NOT `metadata.gstin` (the statutory GSTIN string,
    // which belongs on the GSTN-facing `metadata` object, not in an internal-id traceability block).
    sourceRegistrationId: input.outward.meta.gstRegistrationId,
    b2bInvoiceIds: input.outward.b2b.map((r) => r.invoiceId),
    b2clInvoiceIds: input.outward.b2cl.map((r) => r.invoiceId),
    cdnrCreditNoteIds: input.creditNotes.cdnr.documents.map((d) => d.creditNoteId),
    cdnurCreditNoteIds: input.creditNotes.cdnur.b2cl.documents.map((d) => d.creditNoteId),
    cdnrDebitNoteIds: input.salesDebitNotes?.cdnr.documents.map((d) => d.debitNoteId) ?? [],
    cdnurDebitNoteIds: input.salesDebitNotes?.cdnur.b2cl.documents.map((d) => d.debitNoteId) ?? [],
  };

  return { metadata, b2b, b2cl, b2cs, cdnr, cdnur, hsnB2b, hsnB2c, documentsIssued, traceability, diagnostics };
}
